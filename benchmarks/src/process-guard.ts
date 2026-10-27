/**
 * Host-safety guard for the benchmark runner.
 *
 * - Tracks every process descended from the worker processes the runner
 *   started, keyed by (pid, creation time) so PID reuse never makes it kill a
 *   process it did not start. A process stays tracked after its parent dies,
 *   which is exactly the orphan case `taskkill /T` cannot reach.
 * - Kills whole trees (`taskkill /T /F`) and sweeps tracked survivors.
 * - Watches host resources and calls `onAbort` once when a limit is crossed,
 *   so the runner can stop fail-closed instead of exhausting the machine.
 *
 * One persistent, hidden PowerShell loop samples the process table and memory
 * counters; no per-sample process spawn.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

export interface GuardLimits {
  /** Abort when the host runs more chrome-headless-shell.exe processes than this. */
  maxChrome: number;
  /** Abort when free physical memory drops below this fraction of total... */
  minFreeRamFraction: number;
  /** ...or below this many bytes, whichever is larger. */
  minFreeRamBytes: number;
  /** Abort when committed memory exceeds this fraction of the commit limit. */
  maxCommitFraction: number;
  /** Abort after this many consecutive failed runs (launch error, worker death, calibration failure). */
  maxConsecutiveFailures: number;
}

export const DEFAULT_LIMITS: GuardLimits = {
  maxChrome: 80,
  minFreeRamFraction: 0.15,
  minFreeRamBytes: 4 * 2 ** 30,
  maxCommitFraction: 0.9,
  maxConsecutiveFailures: 3,
};

export interface GuardSample {
  t: number;
  chrome: number;
  ffmpeg: number;
  tracked: number;
  freeRamBytes: number;
  totalRamBytes: number;
  committedBytes: number;
  commitLimitBytes: number;
}

export interface AbortInfo {
  reason: string;
  at: string;
  sample: GuardSample | null;
}

const PS_LOOP = String.raw`
param([int]$interval)
while ($true) {
  $p = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate | ForEach-Object { ,@($_.ProcessId, $_.ParentProcessId, $_.Name, $(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 })) }
  $os = Get-CimInstance Win32_OperatingSystem -Property FreePhysicalMemory,TotalVisibleMemorySize
  $m = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory -Property CommittedBytes,CommitLimit
  [Console]::Out.WriteLine((ConvertTo-Json -Compress -Depth 3 -InputObject @{ t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); p = $p; free = [int64]$os.FreePhysicalMemory * 1024; total = [int64]$os.TotalVisibleMemorySize * 1024; commit = [int64]$m.CommittedBytes; limit = [int64]$m.CommitLimit }))
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds $interval
}
`;

type RawProc = [number, number, string, number];

/** Kill a process and all its live descendants. Never throws. */
export function killTree(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

export class ProcessGuard {
  private proc: ChildProcess | null = null;
  private buf = "";
  private readonly roots = new Set<number>();
  /** pid -> creation FILETIME of every process seen descending from a root. */
  private readonly tracked = new Map<number, { created: number; name: string }>();
  private consecutiveFailures = 0;
  private aborted: AbortInfo | null = null;
  private ready!: Promise<void>;
  readonly samples: GuardSample[] = [];
  last: GuardSample | null = null;

  constructor(
    private readonly limits: GuardLimits,
    private readonly onAbort: (info: AbortInfo) => void,
    private readonly intervalMs = 2000,
  ) {}

  get abortInfo(): AbortInfo | null {
    return this.aborted;
  }

  /** Start sampling; resolves after the first sample so limits are checked before any render. */
  start(): Promise<void> {
    if (process.platform !== "win32") return Promise.resolve();
    this.proc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `& { ${PS_LOOP} } ${this.intervalMs}`], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    let first: () => void;
    this.ready = new Promise((r) => (first = r));
    this.proc.stdout!.setEncoding("utf8");
    this.proc.stdout!.on("data", (chunk: string) => {
      this.buf += chunk;
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (line && this.ingest(line)) first();
      }
    });
    return this.ready;
  }

  addRoot(pid: number | undefined): void {
    if (pid !== undefined) this.roots.add(pid);
  }

  /** Record a run outcome; `failed` covers launch errors, worker deaths and calibration failures. */
  recordRun(failed: boolean, detail: string): void {
    this.consecutiveFailures = failed ? this.consecutiveFailures + 1 : 0;
    if (this.consecutiveFailures >= this.limits.maxConsecutiveFailures) {
      this.abort(`${this.consecutiveFailures} consecutive failed runs (last: ${detail})`);
    }
  }

  private abort(reason: string): void {
    if (this.aborted) return;
    this.aborted = { reason, at: new Date().toISOString(), sample: this.last };
    this.onAbort(this.aborted);
  }

  private ingest(line: string): boolean {
    let s: { t: number; p: RawProc[]; free: number; total: number; commit: number; limit: number };
    try {
      s = JSON.parse(line);
    } catch {
      return false;
    }
    const procs = (s.p ?? []).filter((p) => Array.isArray(p) && typeof p[2] === "string");
    const kids = new Map<number, RawProc[]>();
    for (const p of procs) kids.set(p[1], [...(kids.get(p[1]) ?? []), p]);
    for (const p of procs) if (this.roots.has(p[0]) && !this.tracked.has(p[0])) this.tracked.set(p[0], { created: p[3], name: p[2] });
    const queue = [...this.roots];
    while (queue.length) {
      const id = queue.pop()!;
      for (const c of kids.get(id) ?? []) {
        // A child created before its "parent" is PID reuse, not a descendant.
        const parent = procs.find((p) => p[0] === id);
        if (parent && c[3] < parent[3]) continue;
        if (!this.tracked.has(c[0]) && c[0] !== this.proc?.pid) this.tracked.set(c[0], { created: c[3], name: c[2] });
        queue.push(c[0]);
      }
    }
    const count = (n: string) => procs.filter((p) => p[2].toLowerCase() === n).length;
    const sample: GuardSample = {
      t: s.t,
      chrome: count("chrome-headless-shell.exe"),
      ffmpeg: count("ffmpeg.exe"),
      tracked: procs.filter((p) => this.tracked.get(p[0])?.created === p[3]).length,
      freeRamBytes: s.free,
      totalRamBytes: s.total,
      committedBytes: s.commit,
      commitLimitBytes: s.limit,
    };
    this.last = sample;
    this.samples.push(sample);
    const minFree = Math.max(this.limits.minFreeRamBytes, this.limits.minFreeRamFraction * s.total);
    const gib = (b: number) => `${(b / 2 ** 30).toFixed(1)} GiB`;
    if (sample.chrome > this.limits.maxChrome) this.abort(`${sample.chrome} chrome-headless-shell processes > cap ${this.limits.maxChrome}`);
    else if (s.free < minFree) this.abort(`free RAM ${gib(s.free)} < ${gib(minFree)}`);
    else if (s.limit > 0 && s.commit > this.limits.maxCommitFraction * s.limit)
      this.abort(`commit charge ${gib(s.commit)} > ${this.limits.maxCommitFraction * 100}% of limit ${gib(s.limit)}`);
    return true;
  }

  /**
   * Kill every tracked process that is still the same process (pid and
   * creation time match). Returns the survivors found before killing.
   */
  sweep(): Array<{ pid: number; name: string }> {
    if (process.platform !== "win32" || this.tracked.size === 0) return [];
    const r = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process -Property ProcessId,CreationDate | Where-Object CreationDate | ForEach-Object { \"$($_.ProcessId) $($_.CreationDate.ToFileTimeUtc())\" }"],
      { encoding: "utf8", windowsHide: true },
    );
    const alive: Array<{ pid: number; name: string }> = [];
    for (const l of r.stdout.split("\n")) {
      const [pid, created] = l.trim().split(" ").map(Number);
      const t = pid !== undefined ? this.tracked.get(pid) : undefined;
      if (t && t.created === created && pid !== process.pid) alive.push({ pid: pid!, name: t.name });
    }
    for (const a of alive) killTree(a.pid);
    return alive;
  }

  stop(): void {
    this.proc?.kill();
    this.proc = null;
  }
}
