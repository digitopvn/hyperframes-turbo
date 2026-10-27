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

/**
 * PowerShell owner check shared by every sampler loop. A sampler must exit
 * with the Node process that owns it (Node does not kill children when it
 * exits). The owner is identified by PID *and* start time, captured once while
 * the owner is certainly alive (it is the process starting the sampler), so a
 * PID reused by an unrelated process does not keep the sampler alive.
 * `$ownerStart` may be preset to a FILETIME (non-zero) by the caller.
 */
export const PS_OWNER_INIT = String.raw`
if (-not $ownerStart) { $ownerStart = (Get-Process -Id $owner -ErrorAction Stop).StartTime.ToFileTimeUtc() }
`;
export const PS_OWNER_CHECK = String.raw`
  $o = Get-Process -Id $owner -ErrorAction SilentlyContinue
  if (-not $o) { exit 0 }
  try { $os0 = $o.StartTime.ToFileTimeUtc() } catch { exit 0 }
  if ($os0 -ne $ownerStart) { exit 0 }
`;

const PS_LOOP = String.raw`
param([int]$interval, [int]$owner, [int64]$ownerStart)
$ErrorActionPreference = 'Stop'
${PS_OWNER_INIT}
while ($true) {
  ${PS_OWNER_CHECK}
  # A failed CIM query (WMI is transiently unavailable on a busy host) is
  # reported and retried; it is not a sample, so persistent failure still
  # trips the watchdog's silence limit.
  try {
    $q0 = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $p = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate | ForEach-Object { ,@($_.ProcessId, $_.ParentProcessId, $_.Name, $(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 })) }
    $os = Get-CimInstance Win32_OperatingSystem -Property FreePhysicalMemory,TotalVisibleMemorySize
    $m = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory -Property CommittedBytes,CommitLimit
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $line = ConvertTo-Json -Compress -Depth 3 -InputObject @{ t = $now; q = $now - $q0; p = $p; free = [int64]$os.FreePhysicalMemory * 1024; total = [int64]$os.TotalVisibleMemorySize * 1024; commit = [int64]$m.CommittedBytes; limit = [int64]$m.CommitLimit }
  } catch {
    $line = ConvertTo-Json -Compress -InputObject @{ t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); err = [string]$_.Exception.Message }
  }
  [Console]::Out.WriteLine($line)
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds $interval
}
`;

type RawProc = [number, number, string, number];

/** PowerShell + CIM start-up takes a few seconds; past this the sampler is presumed broken. */
const START_TIMEOUT_MS = 30_000;

/**
 * One sample cycle is the sleep interval plus the CIM queries, which took
 * ~0.8 s on an idle 500-process host and several seconds more while renders
 * saturate the CPU. The sampler reports each query's duration; silence beyond
 * 3 cycles (interval + slowest recent query) plus this allowance means the
 * sampler is hung. An exited sampler aborts immediately via its exit event.
 */
const QUERY_ALLOWANCE_MS = 10_000;
/** Upper bound of the scaled silence limit: 60 s of listening time without a sample is a hung sampler, however slow recent queries were. */
export const MAX_SILENCE_LIMIT_MS = 60_000;

/**
 * A harness event loop blocked this long means nothing enforced the limits
 * meanwhile (the sampler only reports; this process acts). Abort fail-closed.
 */
const MAX_LOOP_LAG_MS = 60_000;

/**
 * `pid` and every descendant in a `ps -A -o pid=,ppid=` listing, parents
 * before children. Pure, so the tree walk is testable on any platform.
 */
export function descendantsOf(pid: number, psOutput: string): number[] {
  const kids = new Map<number, number[]>();
  for (const line of psOutput.split("\n")) {
    const [c, p] = line.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(c) || !Number.isInteger(p) || c === p) continue;
    kids.set(p!, [...(kids.get(p!) ?? []), c!]);
  }
  const out: number[] = [];
  const seen = new Set<number>();
  for (const queue = [pid]; queue.length; ) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    queue.push(...(kids.get(id) ?? []));
  }
  return out;
}

/** Kill a process and all its live descendants. Never throws. */
export function killTree(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
    return;
  }
  // Snapshot the tree first, then stop the root so it cannot spawn more while
  // the rest is killed. Descendants that a dead parent leaves behind are
  // re-parented, so they are only reachable through this snapshot.
  const ps = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
  const tree = ps.status === 0 && typeof ps.stdout === "string" ? descendantsOf(pid, ps.stdout) : [pid];
  for (const id of tree) {
    try {
      process.kill(id, "SIGKILL");
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
  private lastSampleAt = 0;
  private watchdog: NodeJS.Timeout | null = null;
  private startTimer: NodeJS.Timeout | null = null;
  /** Test only: FILETIME the sampler is told its owner started at (0 = read it). */
  private ownerStartOverride = 0;
  /** CIM query time of recent samples, ms (the silence limit scales with the slowest). */
  private readonly recentQueryMs: number[] = [];
  /** Largest observed event-loop lag (watchdog tick lateness), ms. */
  maxLoopLagMs = 0;
  /** Largest CIM query time the sampler reported, ms. */
  maxQueryMs = 0;
  /** Sampler cycles whose CIM query failed (reported, retried, not counted as samples). */
  samplerErrors = 0;
  lastSamplerError: string | null = null;

  constructor(
    private readonly limits: GuardLimits,
    private readonly onAbort: (info: AbortInfo) => void,
    private readonly intervalMs = 2000,
    private readonly queryAllowanceMs = QUERY_ALLOWANCE_MS,
    /** Process whose exit ends the sampler; the harness itself unless a diagnostic says otherwise. */
    private readonly ownerPid = process.pid,
  ) {}

  get abortInfo(): AbortInfo | null {
    return this.aborted;
  }

  /**
   * Start sampling; resolves after the first sample so limits are checked
   * before any render. Fails closed: if the sampler errors, exits, never
   * reports within START_TIMEOUT_MS, or goes silent for longer than
   * `silenceLimitMs` of listening time, or this process's event loop is
   * blocked longer than MAX_LOOP_LAG_MS, the guard aborts, because a blind
   * guard must not let the benchmark keep running.
   */
  start(): Promise<void> {
    if (process.platform !== "win32") return Promise.resolve();
    const proc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `& { ${PS_LOOP} } ${this.intervalMs} ${this.ownerPid} ${this.ownerStartOverride}`], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    this.proc = proc;
    let first!: () => void;
    this.ready = new Promise((r) => (first = r));
    const blind = (reason: string) => {
      if (this.proc !== proc) return; // stopped on purpose
      this.abort(`host-safety sampler ${reason}`);
      first();
    };
    proc.on("error", (err) => blind(`failed: ${err.message}`));
    proc.on("exit", (code, signal) => blind(`exited (${code ?? signal})`));
    const startTimer = setTimeout(() => blind(`sent no sample within ${START_TIMEOUT_MS} ms`), START_TIMEOUT_MS);
    startTimer.unref();
    this.startTimer = startTimer;
    let lastTickAt = Date.now();
    // Silence is measured in listening time since the last real sample, and
    // only a real sample resets it. A late tick means this process's event loop
    // was blocked (for example by the synchronous sweep()): samples sent
    // meanwhile may still be unread in the pipe (timers run before I/O), so
    // such a tick credits one interval of listening, not the blocked time.
    // Repeated stalls therefore still accumulate silence, so a hung sampler is
    // always caught; the blocking itself is bounded by MAX_LOOP_LAG_MS.
    let listenedMs = 0;
    this.resetSilence = () => (listenedMs = 0);
    this.watchdog = setInterval(() => {
      const now = Date.now();
      const elapsed = now - lastTickAt;
      lastTickAt = now;
      const lag = elapsed - this.intervalMs;
      if (lag > this.maxLoopLagMs) this.maxLoopLagMs = lag;
      if (lag > MAX_LOOP_LAG_MS) {
        blind(`unwatched: harness event loop blocked for ${lag} ms (> ${MAX_LOOP_LAG_MS} ms)`);
        return;
      }
      // Before the first sample the start timeout is in charge.
      if (!this.lastSampleAt) return;
      listenedMs += elapsed > 1.5 * this.intervalMs ? this.intervalMs : elapsed;
      const limit = this.silenceLimitMs;
      if (listenedMs > limit) {
        const err = this.lastSamplerError ? `; ${this.samplerErrors} failed sampler queries, last: ${this.lastSamplerError}` : "";
        blind(`silent for ${listenedMs} ms of listening (> ${limit} ms: 3 sample cycles + query allowance; ${now - this.lastSampleAt} ms wall since the last sample, max loop lag ${this.maxLoopLagMs} ms${err})`);
      }
    }, this.intervalMs);
    this.watchdog.unref();
    proc.stdout!.setEncoding("utf8");
    proc.stdout!.on("data", (chunk: string) => {
      this.buf += chunk;
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (line && this.ingest(line)) {
          this.lastSampleAt = Date.now();
          this.resetSilence();
          clearTimeout(startTimer);
          first();
        }
      }
    });
    return this.ready;
  }

  /**
   * Listening time without a sample after which the sampler counts as hung:
   * 3 sample cycles (sleep + the slowest CIM query among the last 10 samples)
   * plus the fixed query allowance. A busy host whose queries slow down
   * therefore widens the limit instead of tripping it; a hung sampler reports
   * no query time, so it cannot widen it.
   */
  get silenceLimitMs(): number {
    const slowest = Math.max(0, ...this.recentQueryMs);
    // Capped: one pathologically slow query must not blind the guard for minutes.
    return Math.min(MAX_SILENCE_LIMIT_MS, 3 * (this.intervalMs + slowest) + this.queryAllowanceMs);
  }

  private resetSilence: () => void = () => {};

  /** Test only: tell the sampler its owner started at a different time, as if the owner PID had been reused. */
  simulateOwnerPidReuse(): void {
    this.ownerStartOverride = 1;
  }

  /** Test only: stop reading samples while the sampler stays alive (a hung sampler, as seen from here). */
  simulateHungSampler(): void {
    this.proc?.stdout?.pause();
    this.proc?.stdout?.removeAllListeners("data");
  }

  /** Test only: PID of the sampler process. */
  get samplerPid(): number | undefined {
    return this.proc?.pid;
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
    let s: { t: number; q?: number; err?: string; p: RawProc[]; free: number; total: number; commit: number; limit: number };
    try {
      s = JSON.parse(line);
    } catch {
      return false;
    }
    if (typeof s.err === "string") {
      this.samplerErrors++;
      this.lastSamplerError = s.err.slice(0, 200);
      return false;
    }
    if (!Array.isArray(s.p) || typeof s.free !== "number" || typeof s.total !== "number") return false;
    if (typeof s.q === "number" && Number.isFinite(s.q) && s.q >= 0) {
      this.recentQueryMs.push(s.q);
      if (this.recentQueryMs.length > 10) this.recentQueryMs.shift();
      if (s.q > this.maxQueryMs) this.maxQueryMs = s.q;
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
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.startTimer) clearTimeout(this.startTimer);
    this.watchdog = null;
    this.startTimer = null;
    const proc = this.proc;
    this.proc = null;
    proc?.kill();
  }
}
