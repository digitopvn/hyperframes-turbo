/**
 * Diagnostic: does upstream auto-worker calibration fail because of state left
 * by the previous render (children still exiting), or on its own?
 *
 * Renders one fixture/profile N times in each of four modes and records, per
 * run in global start order, the capture path and whether upstream logged
 * "Auto-worker calibration failed" (with its full log metadata):
 *
 * - `fresh-settled`: new worker process per run, settle wait + cooldown first
 * - `fresh-back-to-back`: new worker process per run, no settle wait
 * - `same-back-to-back`: one worker process, runs back to back (no settle)
 * - `same-settled`: one worker process, settle wait + cooldown before each run
 *
 *   node --import ./upstream/hyperframes/node_modules/tsx/dist/loader.mjs \
 *     benchmarks/src/diag-calibration.ts --out <dir> [--fixture gsap-static-holds] [--runs 6] [--settle-ms 5000]
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BENCH_ROOT, REPO_ROOT, UPSTREAM_ROOT } from "./fixtures.js";
import { DEFAULT_LIMITS, killTree, ProcessGuard } from "./process-guard.js";
import { PROFILES } from "./profiles.js";
import { runMetrics } from "./report.js";

const a = process.argv.slice(2);
const get = (k: string) => {
  const i = a.indexOf(`--${k}`);
  return i >= 0 ? a[i + 1] : undefined;
};
const out = get("out");
if (!out) throw new Error("usage: diag-calibration.ts --out <dir>");
const fixture = get("fixture") ?? "gsap-static-holds";
const profile = get("profile") ?? "producer-default";
const runs = Number(get("runs") ?? 6);
const settleMs = Number(get("settle-ms") ?? 5000);

let current: number | undefined;
const guard = new ProcessGuard(DEFAULT_LIMITS, (info) => {
  console.error(`[diag] ABORT: ${info.reason}`);
  if (current) killTree(current);
  guard.sweep();
  process.exit(3);
});
process.on("exit", () => {
  if (current) killTree(current);
  guard.stop();
});
process.on("uncaughtException", (err) => {
  console.error(err);
  if (current) killTree(current);
  guard.sweep();
  process.exit(1);
});
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (current) killTree(current);
    guard.sweep();
    process.exit(130);
  });
}
await guard.start();

function worker(args: string[]): Promise<number> {
  const cacheDir = mkdtempSync(join(tmpdir(), "turbo-bench-xcache-"));
  const tsxLoader = join(UPSTREAM_ROOT, "node_modules", "tsx", "dist", "loader.mjs");
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--import", `file:///${tsxLoader.replace(/\\/g, "/")}`, join(BENCH_ROOT, "src", "render-worker.ts"), "--fixture", fixture, "--profile", profile, ...args],
      { env: { ...process.env, ...PROFILES[profile]!.env, HYPERFRAMES_EXTRACT_CACHE_DIR: cacheDir }, stdio: ["ignore", "ignore", "pipe"], cwd: REPO_ROOT, windowsHide: true },
    );
    guard.addRoot(child.pid);
    current = child.pid;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => {
      for (const line of d.split("\n")) if (line.startsWith("[worker]")) process.stderr.write(`${line}\n`);
    });
    child.on("exit", (code) => {
      current = undefined;
      const left = guard.sweep();
      if (left.length) console.error(`[diag] killed ${left.length} leftover process(es)`);
      rmSync(cacheDir, { recursive: true, force: true });
      resolve(code ?? 1);
    });
  });
}

const modes: Array<{ mode: string; fresh: boolean; settle: number }> = [
  { mode: "fresh-settled", fresh: true, settle: settleMs },
  { mode: "fresh-back-to-back", fresh: true, settle: 0 },
  { mode: "same-back-to-back", fresh: false, settle: 0 },
  { mode: "same-settled", fresh: false, settle: settleMs },
];

const rows: Array<Record<string, unknown>> = [];
for (const m of modes) {
  const dirs: string[] = [];
  if (m.fresh) {
    for (let i = 0; i < runs; i++) {
      const dir = join(out, m.mode, `process-${i}`);
      dirs.push(dir);
      await worker(["--warm-runs", "0", "--settle-ms", String(m.settle), "--out", dir]);
    }
  } else {
    const dir = join(out, m.mode, "process-0");
    dirs.push(dir);
    await worker(["--warm-runs", String(runs - 1), "--settle-ms", String(m.settle), "--out", dir]);
  }
  for (const dir of dirs) {
    for (let run = 0; ; run++) {
      let r: Record<string, any>;
      try {
        r = JSON.parse(readFileSync(join(dir, `run-${run}.json`), "utf8"));
      } catch {
        break;
      }
      const x = runMetrics(r);
      const warn = (r.upstreamLog?.warnMeta ?? []).find((w: { message: string }) => w.message.includes("calibration failed"));
      rows.push({
        mode: m.mode,
        process: dir.split(/[\\/]/).pop(),
        run,
        startedAt: r.startedAt,
        wallMs: x.wallMs,
        capturePath: x.capturePath,
        workers: x.workers,
        captureSetupMs: x.captureSetupMs,
        calibrationFailed: x.calibrationFailed,
        settle: r.settle,
        calibrationWarnMeta: warn?.meta ?? null,
      });
    }
  }
}

guard.stop();
mkdirSync(out, { recursive: true });
const summary = modes.map((m) => {
  const mine = rows.filter((r) => r.mode === m.mode);
  return {
    mode: m.mode,
    freshProcessPerRun: m.fresh,
    settleMs: m.settle,
    runs: mine.length,
    calibrationFailed: mine.filter((r) => r.calibrationFailed).length,
    sequence: mine.map((r) => (r.calibrationFailed ? "F" : "s")).join(""),
  };
});
writeFileSync(join(out, "calibration-diagnostic.json"), JSON.stringify({ fixture, profile, settleMs, summary, runs: rows }, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
