/**
 * Host-level samplers that run beside a render without touching upstream code:
 *  - GPU utilization / VRAM via a persistent `nvidia-smi -lms` process;
 *  - whole process-tree working set, CPU time and I/O transfer counters
 *    (Windows, via one persistent PowerShell CIM loop so no per-sample spawn);
 *  - an idle gate that refuses or flags runs when CPU/GPU are busy beforehand.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpus } from "node:os";

export interface GpuSample {
  t: number;
  utilGpu: number;
  utilMem: number;
  utilEnc: number;
  utilDec: number;
  memUsedMiB: number;
}

export function hasNvidiaSmi(): boolean {
  const r = spawnSync("nvidia-smi", ["-L"], { encoding: "utf8", windowsHide: true });
  return r.status === 0;
}

const GPU_FIELDS =
  "utilization.gpu,utilization.memory,utilization.encoder,utilization.decoder,memory.used";

function parseGpuLine(line: string, t: number): GpuSample | null {
  const parts = line.split(",").map((s) => Number(s.trim()));
  if (parts.length < 5 || parts.some((n) => !Number.isFinite(n))) return null;
  const [utilGpu, utilMem, utilEnc, utilDec, memUsedMiB] = parts as [
    number,
    number,
    number,
    number,
    number,
  ];
  return { t, utilGpu, utilMem, utilEnc, utilDec, memUsedMiB };
}

export class GpuSampler {
  private proc: ChildProcess | null = null;
  private buf = "";
  readonly samples: GpuSample[] = [];

  start(intervalMs = 200): void {
    this.proc = spawn(
      "nvidia-smi",
      [`--query-gpu=${GPU_FIELDS}`, "--format=csv,noheader,nounits", `-lms`, String(intervalMs)],
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );
    this.proc.stdout!.setEncoding("utf8");
    this.proc.stdout!.on("data", (chunk: string) => {
      this.buf += chunk;
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        const s = parseGpuLine(line, Date.now());
        if (s) this.samples.push(s);
      }
    });
  }

  stop(): GpuSample[] {
    this.proc?.kill();
    this.proc = null;
    return this.samples;
  }
}

/** One-shot GPU snapshot averaged over `ms`. */
export async function sampleGpu(ms: number): Promise<GpuSample[]> {
  if (!hasNvidiaSmi()) return [];
  const s = new GpuSampler();
  s.start(250);
  await new Promise((r) => setTimeout(r, ms));
  return s.stop();
}

/** System-wide CPU busy fraction (0..1) over `ms`, from os.cpus() tick deltas. */
export async function sampleCpuBusy(ms: number): Promise<number> {
  const snap = () =>
    cpus().reduce(
      (acc, c) => {
        const total = Object.values(c.times).reduce((a, b) => a + b, 0);
        return { idle: acc.idle + c.times.idle, total: acc.total + total };
      },
      { idle: 0, total: 0 },
    );
  const a = snap();
  await new Promise((r) => setTimeout(r, ms));
  const b = snap();
  const total = b.total - a.total;
  return total > 0 ? 1 - (b.idle - a.idle) / total : 0;
}

export interface IdleCheck {
  ok: boolean;
  cpuBusyPct: number;
  gpuUtilPct: number | null;
  gpuEncPct: number | null;
  attempts: number;
  thresholds: { cpuPct: number; gpuPct: number };
}

/**
 * Wait until the host is idle (CPU and GPU below thresholds over a 5 s window),
 * retrying for up to `maxWaitMs`. Returns ok=false if it never settled; the
 * caller decides whether to refuse (strict) or flag the run.
 */
export async function waitForIdle(opts: {
  cpuPct: number;
  gpuPct: number;
  maxWaitMs: number;
  windowMs?: number;
}): Promise<IdleCheck> {
  const windowMs = opts.windowMs ?? 5000;
  const deadline = Date.now() + opts.maxWaitMs;
  let attempts = 0;
  for (;;) {
    attempts++;
    const [cpu, gpu] = await Promise.all([sampleCpuBusy(windowMs), sampleGpu(windowMs)]);
    const cpuBusyPct = cpu * 100;
    const avg = (k: keyof GpuSample) =>
      gpu.length ? gpu.reduce((a, s) => a + (s[k] as number), 0) / gpu.length : null;
    const gpuUtilPct = avg("utilGpu");
    const gpuEncPct = avg("utilEnc");
    const ok = cpuBusyPct <= opts.cpuPct && (gpuUtilPct === null || gpuUtilPct <= opts.gpuPct);
    if (ok || Date.now() >= deadline) {
      return {
        ok,
        cpuBusyPct,
        gpuUtilPct,
        gpuEncPct,
        attempts,
        thresholds: { cpuPct: opts.cpuPct, gpuPct: opts.gpuPct },
      };
    }
  }
}

export interface ProcessTreeSample {
  t: number;
  processCount: number;
  workingSetBytes: number;
  /** Cumulative CPU seconds (user+kernel) of processes alive at sample time. */
  cpuSeconds: number;
  readTransferBytes: number;
  writeTransferBytes: number;
  names: Record<string, number>;
}

export interface ProcessTreeSummary {
  supported: boolean;
  sampleIntervalMs: number;
  samples: number;
  peakWorkingSetBytes: number;
  peakProcessCount: number;
  /** Peak working set per executable name at the tree-peak sample. */
  peakByName: Record<string, number>;
  /**
   * CPU seconds and I/O transfer bytes summed over the last value seen for each
   * PID during the window (processes that exited between samples lose their
   * final increment, so these are lower bounds).
   */
  cpuSeconds: number;
  readTransferBytes: number;
  writeTransferBytes: number;
}

const PS_LOOP = `
$ErrorActionPreference = 'SilentlyContinue'
$root = [int]$args[0]; $interval = [int]$args[1]; $owner = [int]$args[2]
while ($true) {
  # Exit with the owning Node process: Node does not kill children when it exits.
  if (-not (Get-Process -Id $owner -ErrorAction SilentlyContinue)) { exit 0 }
  $all = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,WorkingSetSize,UserModeTime,KernelModeTime,ReadTransferCount,WriteTransferCount
  $kids = @{}
  foreach ($p in $all) { $k = [int]$p.ParentProcessId; if (-not $kids.ContainsKey($k)) { $kids[$k] = New-Object System.Collections.ArrayList }; [void]$kids[$k].Add($p) }
  $byId = @{}; foreach ($p in $all) { $byId[[int]$p.ProcessId] = $p }
  $queue = New-Object System.Collections.Queue; $queue.Enqueue($root); $seen = @{}
  $out = New-Object System.Collections.ArrayList
  while ($queue.Count -gt 0) {
    $id = [int]$queue.Dequeue(); if ($seen.ContainsKey($id)) { continue }; $seen[$id] = 1
    $p = $byId[$id]; if ($p) { [void]$out.Add(@($p.ProcessId, $p.Name, $p.WorkingSetSize, ($p.UserModeTime + $p.KernelModeTime), $p.ReadTransferCount, $p.WriteTransferCount)) }
    if ($kids.ContainsKey($id)) { foreach ($c in $kids[$id]) { $queue.Enqueue([int]$c.ProcessId) } }
  }
  # CIM reads stay tolerant: processes exit mid-query.
  try { [Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject @{ t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); p = $out })); [Console]::Out.Flush() } catch { exit 0 }
  Start-Sleep -Milliseconds $interval
}
`;

type RawProc = [number, string, number, number, number, number];

export class ProcessTreeSampler {
  private proc: ChildProcess | null = null;
  private buf = "";
  private lastByPid = new Map<number, RawProc>();
  readonly samples: ProcessTreeSample[] = [];
  constructor(
    private readonly rootPid: number,
    private readonly intervalMs = 1000,
  ) {}

  get supported(): boolean {
    return process.platform === "win32";
  }

  start(): void {
    if (!this.supported) return;
    const script = `& { ${PS_LOOP} } ${this.rootPid} ${this.intervalMs} ${process.pid}`;
    this.proc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    this.proc.stdout!.setEncoding("utf8");
    this.proc.stdout!.on("data", (chunk: string) => {
      this.buf += chunk;
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (line) this.ingest(line);
      }
    });
  }

  private ingest(line: string): void {
    let parsed: { t: number; p: RawProc[] | RawProc };
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    // PowerShell collapses a one-element array; normalize.
    const list: RawProc[] = Array.isArray(parsed.p?.[0]) ? (parsed.p as RawProc[]) : parsed.p ? [parsed.p as RawProc] : [];
    const names: Record<string, number> = {};
    let ws = 0;
    let cpu = 0;
    let rd = 0;
    let wr = 0;
    for (const p of list) {
      // Ignore the sampler's own PowerShell process.
      if (p[0] === this.proc?.pid) continue;
      this.lastByPid.set(p[0], p);
      ws += p[2];
      cpu += p[3] / 1e7;
      rd += p[4];
      wr += p[5];
      names[p[1]] = (names[p[1]] ?? 0) + p[2];
    }
    this.samples.push({
      t: parsed.t,
      processCount: list.length,
      workingSetBytes: ws,
      cpuSeconds: cpu,
      readTransferBytes: rd,
      writeTransferBytes: wr,
      names,
    });
  }

  /** Values of tree-wide counters attributable to the window since `mark`. */
  stop(): ProcessTreeSummary {
    this.proc?.kill();
    this.proc = null;
    const peak = this.samples.reduce<ProcessTreeSample | null>(
      (a, s) => (!a || s.workingSetBytes > a.workingSetBytes ? s : a),
      null,
    );
    let cpuSeconds = 0;
    let rd = 0;
    let wr = 0;
    for (const p of this.lastByPid.values()) {
      cpuSeconds += p[3] / 1e7;
      rd += p[4];
      wr += p[5];
    }
    return {
      supported: this.supported,
      sampleIntervalMs: this.intervalMs,
      samples: this.samples.length,
      peakWorkingSetBytes: peak?.workingSetBytes ?? 0,
      peakProcessCount: Math.max(0, ...this.samples.map((s) => s.processCount)),
      peakByName: peak?.names ?? {},
      cpuSeconds,
      readTransferBytes: rd,
      writeTransferBytes: wr,
    };
  }
}

export function summarizeGpu(samples: GpuSample[], baselineMemMiB: number | null) {
  if (samples.length === 0) return null;
  const avg = (k: keyof GpuSample) => samples.reduce((a, s) => a + (s[k] as number), 0) / samples.length;
  const peakMem = Math.max(...samples.map((s) => s.memUsedMiB));
  return {
    samples: samples.length,
    avgUtilGpuPct: avg("utilGpu"),
    peakUtilGpuPct: Math.max(...samples.map((s) => s.utilGpu)),
    avgUtilEncPct: avg("utilEnc"),
    avgUtilDecPct: avg("utilDec"),
    peakVramUsedMiB: peakMem,
    baselineVramUsedMiB: baselineMemMiB,
    /** Device-level VRAM growth over the pre-run baseline (WDDM gives no reliable per-process figure). */
    peakVramDeltaMiB: baselineMemMiB === null ? null : peakMem - baselineMemMiB,
  };
}

/** Executables a render spawns; the settle wait watches these. */
const RENDER_CHILD_IMAGES = ["chrome-headless-shell.exe", "ffmpeg.exe", "ffprobe.exe"];

export interface SettleResult {
  /** Render-child processes alive when the wait started. */
  aliveAtStart: number;
  /** Render-child processes still alive when the wait ended. */
  aliveAtEnd: number;
  waitedMs: number;
  cooldownMs: number;
}

function countRenderChildren(): number {
  const r = spawnSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
  if (r.status !== 0) return 0;
  return r.stdout
    .split("\n")
    .map((l) => l.split(",")[0]?.replace(/"/g, "").trim().toLowerCase())
    .filter((name) => name && RENDER_CHILD_IMAGES.includes(name)).length;
}

/**
 * Wait until no Chrome/FFmpeg process of a previous render is still alive
 * (up to `maxWaitMs`), then sleep a fixed `cooldownMs`. Host-wide by image
 * name, so the benchmark host must not run other headless-shell/FFmpeg work.
 * A desktop Chrome (`chrome.exe`) is deliberately not watched.
 */
export async function settleHost(cooldownMs: number, maxWaitMs = 60_000): Promise<SettleResult> {
  const t0 = Date.now();
  const aliveAtStart = countRenderChildren();
  let alive = aliveAtStart;
  while (alive > 0 && Date.now() - t0 < maxWaitMs) {
    await new Promise((r) => setTimeout(r, 250));
    alive = countRenderChildren();
  }
  const waitedMs = Date.now() - t0;
  await new Promise((r) => setTimeout(r, cooldownMs));
  return { aliveAtStart, aliveAtEnd: alive, waitedMs, cooldownMs };
}
