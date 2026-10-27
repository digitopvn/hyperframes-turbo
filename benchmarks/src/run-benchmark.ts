/**
 * HyperFrames Turbo baseline benchmark driver.
 *
 * Extends upstream `packages/producer/src/benchmark.ts` (same fixture layout,
 * same createRenderJob/executeRenderJob entry points, same perfSummary) with:
 * cold vs warm separation, >=5 warm repetitions, profile pairing, stage
 * overlap/critical-path analysis, host samplers (GPU/VRAM, process-tree RSS,
 * CPU, I/O), CDP readback byte counting, an idle gate, and raw JSON/CSV plus a
 * Markdown report. See docs/benchmark-protocol.md.
 *
 *   node --import ./upstream/hyperframes/node_modules/tsx/dist/loader.mjs \
 *     benchmarks/src/run-benchmark.ts [--warm-runs 5] [--profiles a,b] \
 *     [--fixtures id,id] [--out dir] [--strict-idle] [--control profile | --no-control]
 */
import { spawn } from "node:child_process";
import { copyFileSync, createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectEnvironment } from "./collect-environment.js";
import { BENCH_ROOT, loadManifest, REPO_ROOT, UPSTREAM_ROOT } from "./fixtures.js";
import { PROFILES } from "./profiles.js";
import { writeReport } from "./report.js";
import { DEFAULT_LIMITS, killTree, ProcessGuard, type AbortInfo, type GuardLimits } from "./process-guard.js";
import { waitForIdle } from "./system-probes.js";

interface Args {
  warmRuns: number;
  profiles: string[];
  fixtures: string[] | null;
  out: string | null;
  strictIdle: boolean;
  /** Profile that also gets an uninstrumented control cell, or null. */
  control: string | null;
  /** Cooldown after the previous render's Chrome/FFmpeg children exit; 0 = back to back. */
  settleMs: number;
  limits: GuardLimits;
  /** Test only: kill one worker process (not its tree) this many ms into the last round. */
  injectKillMs: number | null;
}

/** Suffix of the result directory of an uninstrumented control cell. */
export const CONTROL_SUFFIX = ".control";

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (k: string) => {
    const i = a.indexOf(`--${k}`);
    return i >= 0 ? a[i + 1] : undefined;
  };
  return {
    warmRuns: Number(get("warm-runs") ?? 5),
    profiles: (get("profiles") ?? Object.keys(PROFILES).join(",")).split(","),
    fixtures: get("fixtures")?.split(",") ?? null,
    out: get("out") ?? null,
    strictIdle: a.includes("--strict-idle"),
    settleMs: Number(get("settle-ms") ?? 5000),
    control: a.includes("--no-control") ? null : (get("control") ?? "producer-default"),
    injectKillMs: get("inject-worker-kill-ms") ? Number(get("inject-worker-kill-ms")) : null,
    limits: {
      maxChrome: Number(get("max-chrome") ?? DEFAULT_LIMITS.maxChrome),
      minFreeRamFraction: Number(get("min-free-ram-pct") ?? DEFAULT_LIMITS.minFreeRamFraction * 100) / 100,
      minFreeRamBytes: Number(get("min-free-ram-gib") ?? DEFAULT_LIMITS.minFreeRamBytes / 2 ** 30) * 2 ** 30,
      maxCommitFraction: Number(get("max-commit-pct") ?? DEFAULT_LIMITS.maxCommitFraction * 100) / 100,
      maxConsecutiveFailures: Number(get("max-consecutive-failures") ?? DEFAULT_LIMITS.maxConsecutiveFailures),
    },
  };
}

/** Must match the marker render-worker.ts writes after each served run. */
const DONE_MARKER = "@@turbo-bench-done";

/** A render-worker child in `--serve` mode that renders one run per call. */
/** A single render never takes this long on the golden fixtures; past it the worker is presumed hung. */
const RUN_TIMEOUT_MS = 20 * 60_000;

interface ServedWorker {
  run(n: number): Promise<void>;
  /** Close stdin and wait for exit. */
  close(): Promise<number>;
}

function spawnWorker(args: string[], env: NodeJS.ProcessEnv, logPath: string, guard: ProcessGuard): ServedWorker & { pid: number | undefined } {
  const tsxLoader = join(UPSTREAM_ROOT, "node_modules", "tsx", "dist", "loader.mjs");
  // windowsHide: the worker gets a hidden console, which Chrome and FFmpeg
  // (console programs puppeteer/upstream spawn without windowsHide) inherit,
  // so no render child can open a visible console window.
  const child = spawn(
    process.execPath,
    ["--import", `file:///${tsxLoader.replace(/\\/g, "/")}`, join(BENCH_ROOT, "src", "render-worker.ts"), "--serve", ...args],
    { env, stdio: ["pipe", "pipe", "pipe"], cwd: REPO_ROOT, windowsHide: true },
  );
  guard.addRoot(child.pid);
  // Full worker stderr is kept: upstream prints its GPU-mode probe and
  // Chrome launch errors there, not through the job logger.
  const log = createWriteStream(logPath, { flags: "a" });
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (d: string) => {
    log.write(redactPaths(d));
    for (const line of d.split("\n")) if (line.startsWith("[worker]") || line.includes("error")) process.stderr.write(`${line}\n`);
  });
  child.on("exit", () => log.end());
  let exitCode: number | null = null;
  const exited = new Promise<number>((resolve) =>
    child.on("exit", (code) => {
      exitCode = code ?? 1;
      resolve(exitCode);
    }),
  );
  let pending: { n: number; resolve: () => void; reject: (e: Error) => void } | null = null;
  let buf = "";
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (d: string) => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (pending && line === `${DONE_MARKER} ${pending.n}`) {
        const p = pending;
        pending = null;
        p.resolve();
      }
    }
  });
  void exited.then((code) => pending?.reject(new Error(`worker exited (${code}) during run ${pending.n}`)));
  // A worker that died between its turns closes stdin; writes then fail instead of hanging.
  child.stdin!.on("error", (err) => pending?.reject(err));
  return {
    pid: child.pid,
    run: (n) =>
      new Promise<void>((resolve, reject) => {
        if (exitCode !== null) {
          reject(new Error(`worker already exited (${exitCode}) before run ${n}`));
          return;
        }
        // A hung render is killed with its whole tree; exit then rejects the run.
        const timer = setTimeout(() => {
          console.error(`[bench] run ${n} exceeded ${RUN_TIMEOUT_MS} ms; killing worker tree`);
          if (child.pid) killTree(child.pid);
        }, RUN_TIMEOUT_MS);
        const done = (fn: () => void) => () => {
          clearTimeout(timer);
          fn();
        };
        pending = { n, resolve: done(resolve), reject: (e) => done(() => reject(e))() };
        child.stdin!.write(`run ${n}\n`);
      }),
    close: () => {
      child.stdin!.end();
      const t = setTimeout(() => child.pid && killTree(child.pid), 60_000);
      return exited.finally(() => clearTimeout(t));
    },
  };
}

/** Committed logs never carry the host user name: home dir -> ~, temp dir -> $TMP. */
function redactPaths(text: string): string {
  return text.split(tmpdir()).join("$TMP").split(homedir()).join("~");
}

/** [failed, detail] for one finished run, from its raw JSON. */
function runOutcome(path: string): [boolean, string] {
  let r: { error?: string | null; upstreamLog?: { warnMeta?: Array<{ message: string; meta?: { error?: string } }> } };
  try {
    r = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [true, `${path}: no readable run record`];
  }
  if (r.error) return [true, r.error];
  const cal = r.upstreamLog?.warnMeta?.find((w) => w.message.includes("calibration failed"));
  return cal ? [true, `calibration failed: ${cal.meta?.error ?? cal.message}`] : [false, ""];
}

/**
 * Run order for one fixture: every variant's cold run first, then warm rounds
 * in which each variant renders once (A,B,C,A,B,C,...). The variant order
 * rotates per fixture and per round so no variant is always first or last.
 */
export function interleavedSchedule(variantCount: number, warmRuns: number, fixtureIndex: number): Array<{ variant: number; run: number }> {
  const out: Array<{ variant: number; run: number }> = [];
  for (let run = 0; run <= warmRuns; run++) {
    for (let i = 0; i < variantCount; i++) out.push({ variant: (i + fixtureIndex + run) % variantCount, run });
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs();
  for (const p of args.profiles) if (!PROFILES[p]) throw new Error(`Unknown profile ${p}`);
  const manifest = loadManifest().filter((f) => !args.fixtures || args.fixtures.includes(f.id));

  const env = await collectEnvironment();
  const upstreamSha = String((env.upstream as { sha: string }).sha);
  const date = new Date().toISOString().slice(0, 10);
  const outDir = args.out ?? join(BENCH_ROOT, "results", `${date}-${upstreamSha.slice(0, 7)}`);
  mkdirSync(join(outDir, "raw"), { recursive: true });
  writeFileSync(join(outDir, "environment.json"), JSON.stringify(env, null, 2) + "\n");
  // benchmarks/environment.json is a copy of the latest default-location run's
  // manifest, never written by hand and never from ad-hoc --out runs.
  if (!args.out) copyFileSync(join(outDir, "environment.json"), join(BENCH_ROOT, "environment.json"));

  console.error(`[bench] ${manifest.length} fixture(s) x ${args.profiles.length} profile(s) x (1 cold + ${args.warmRuns} warm) -> ${outDir}`);

  // Every live worker; an abort or a harness exit kills each whole tree, then
  // the guard sweeps tracked survivors whose parent already died.
  const live = new Set<number>();
  const teardown = (why: string) => {
    for (const pid of live) killTree(pid);
    const left = guard.sweep();
    if (left.length) console.error(`[bench] ${why}: killed ${left.length} leftover tracked process(es): ${left.map((p) => `${p.name}#${p.pid}`).join(", ")}`);
    return left;
  };
  const guard = new ProcessGuard(args.limits, (info: AbortInfo) => {
    console.error(`[bench] ABORT: ${info.reason}`);
    for (const pid of live) killTree(pid);
  });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      teardown(sig);
      guard.stop();
      process.exit(130);
    });
  }
  process.on("exit", () => {
    for (const pid of live) killTree(pid);
  });
  await guard.start();
  if (guard.abortInfo) {
    guard.stop();
    throw new Error(`host already over a resource limit before start: ${guard.abortInfo.reason}`);
  }

  const preflight = await waitForIdle({ cpuPct: 20, gpuPct: 15, maxWaitMs: 300_000, windowMs: 10_000 });
  console.error(`[bench] preflight idle: ${JSON.stringify(preflight)}`);
  if (!preflight.ok && args.strictIdle) {
    console.error("[bench] host busy before benchmark start; refusing (--strict-idle)");
    process.exit(2);
  }

  const startedAt = new Date().toISOString();
  const cells: Array<{ fixture: string; profile: string; exitCode: number }> = [];
  const leftovers: Array<{ after: string; processes: Array<{ pid: number; name: string }> }> = [];
  delete process.env.HF_PROFILE_FALLBACK_CAPTURE;
  const variants = [
    ...args.profiles.map((profile) => ({ profile, control: false })),
    ...(args.control ? [{ profile: args.control, control: true }] : []),
  ];
  for (const [fi, fx] of manifest.entries()) {
    if (guard.abortInfo as AbortInfo | null) break;
    // All variants of a fixture stay alive in their own warm process and
    // their runs are interleaved, so slow host drift hits every variant alike.
    const workers = variants.map(({ profile, control }) => {
      const cacheDir = mkdtempSync(join(tmpdir(), `turbo-bench-xcache-`));
      const childEnv = {
        ...process.env,
        ...PROFILES[profile]!.env,
        HYPERFRAMES_EXTRACT_CACHE_DIR: cacheDir,
        // Opt-in upstream diagnostic: per-frame p50/p95/p99 on the screenshot fallback path.
        // Left off in control cells so they measure upstream with no harness additions.
        ...(control ? {} : { HF_PROFILE_FALLBACK_CAPTURE: "true" }),
      };
      const cellName = control ? `${profile}${CONTROL_SUFFIX}` : profile;
      const childArgs = ["--fixture", fx.id, "--profile", cellName, "--warm-runs", String(args.warmRuns), "--out", join(outDir, "raw", fx.id, cellName)];
      if (args.strictIdle) childArgs.push("--strict-idle");
      if (control) childArgs.push("--uninstrumented");
      childArgs.push("--settle-ms", String(args.settleMs));
      const rawDir = join(outDir, "raw", fx.id, cellName);
      mkdirSync(rawDir, { recursive: true });
      const worker = spawnWorker(childArgs, childEnv, join(rawDir, "worker-stderr.log"), guard);
      if (worker.pid) live.add(worker.pid);
      return { cellName, cacheDir, rawDir, worker, failed: false };
    });
    for (const { variant, run } of interleavedSchedule(workers.length, args.warmRuns, fi)) {
      if (guard.abortInfo as AbortInfo | null) break;
      const w = workers[variant]!;
      if (w.failed) continue;
      try {
        // Fault injection (--inject-worker-kill-ms): kill only the worker
        // process, not its tree, mid-run, orphaning its Chrome/FFmpeg children.
        const inject =
          args.injectKillMs !== null && run === args.warmRuns && variant === 0
            ? setTimeout(() => {
                console.error(`[bench] fault injection: killing worker ${w.worker.pid} (process only)`);
                if (w.worker.pid) process.kill(w.worker.pid);
              }, args.injectKillMs)
            : null;
        await w.worker.run(run).finally(() => inject && clearTimeout(inject));
        guard.recordRun(...runOutcome(join(w.rawDir, `run-${run}.json`)));
      } catch (err) {
        w.failed = true;
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[bench] ${fx.id}/${w.cellName}: ${msg}`);
        guard.recordRun(true, `${fx.id}/${w.cellName} run ${run}: ${msg}`);
      }
    }
    for (const w of workers) {
      const exitCode = await w.worker.close();
      if (w.worker.pid) live.delete(w.worker.pid);
      cells.push({ fixture: fx.id, profile: w.cellName, exitCode: w.failed ? 1 : exitCode });
      rmSync(w.cacheDir, { recursive: true, force: true });
    }
    const leftover = teardown(`after ${fx.id}`);
    if (leftover.length) leftovers.push({ after: fx.id, processes: leftover });
  }
  guard.stop();
  // Re-read: the abort callback may have fired since the pre-start check narrowed it.
  const abort = guard.abortInfo as AbortInfo | null;

  writeFileSync(
    join(outDir, "run-manifest.json"),
    JSON.stringify(
      {
        schema: "turbo-bench-manifest/1",
        startedAt,
        finishedAt: new Date().toISOString(),
        command: `node --import ./upstream/hyperframes/node_modules/tsx/dist/loader.mjs benchmarks/src/run-benchmark.ts ${process.argv.slice(2).join(" ")}`.trim(),
        warmRuns: args.warmRuns,
        profiles: Object.fromEntries(args.profiles.map((p) => [p, PROFILES[p]])),
        control: args.control ? { profile: args.control, cell: `${args.control}${CONTROL_SUFFIX}`, instrumentation: "none (no CDP tap, no host samplers, HF_PROFILE_FALLBACK_CAPTURE unset)" } : null,
        settle: args.settleMs > 0 ? `before every run: wait for chrome-headless-shell/ffmpeg/ffprobe to exit (≤60 s), then ${args.settleMs} ms` : "none (back to back)",
        orderRule: "per fixture: all cold runs, then warm rounds A,B,C,...; variant order rotates by (fixture index + run)",
        preflight,
        guard: {
          limits: args.limits,
          peak: {
            chrome: Math.max(0, ...guard.samples.map((s) => s.chrome)),
            tracked: Math.max(0, ...guard.samples.map((s) => s.tracked)),
            minFreeRamBytes: Math.min(...guard.samples.map((s) => s.freeRamBytes)),
            maxCommittedBytes: Math.max(0, ...guard.samples.map((s) => s.committedBytes)),
          },
          leftovers,
        },
        abort,
        cells,
      },
      null,
      2,
    ) + "\n",
  );
  if (abort) {
    console.error(`[bench] aborted fail-closed: ${abort.reason}; no report written`);
    process.exit(3);
  }
  writeReport(outDir);
  console.error(`[bench] done: ${join(outDir, "report.md")}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
