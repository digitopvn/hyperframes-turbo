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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectEnvironment } from "./collect-environment.js";
import { BENCH_ROOT, loadManifest, REPO_ROOT, UPSTREAM_ROOT } from "./fixtures.js";
import { PROFILES } from "./profiles.js";
import { writeReport } from "./report.js";
import { waitForIdle } from "./system-probes.js";

interface Args {
  warmRuns: number;
  profiles: string[];
  fixtures: string[] | null;
  out: string | null;
  strictIdle: boolean;
  /** Profile that also gets an uninstrumented control cell, or null. */
  control: string | null;
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
    control: a.includes("--no-control") ? null : (get("control") ?? "producer-default"),
  };
}

/** Must match the marker render-worker.ts writes after each served run. */
const DONE_MARKER = "@@turbo-bench-done";

/** A render-worker child in `--serve` mode that renders one run per call. */
interface ServedWorker {
  run(n: number): Promise<void>;
  /** Close stdin and wait for exit. */
  close(): Promise<number>;
}

function spawnWorker(args: string[], env: NodeJS.ProcessEnv): ServedWorker {
  const tsxLoader = join(UPSTREAM_ROOT, "node_modules", "tsx", "dist", "loader.mjs");
  const child = spawn(
    process.execPath,
    ["--import", `file:///${tsxLoader.replace(/\\/g, "/")}`, join(BENCH_ROOT, "src", "render-worker.ts"), "--serve", ...args],
    { env, stdio: ["pipe", "pipe", "pipe"], cwd: REPO_ROOT },
  );
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (d: string) => {
    for (const line of d.split("\n")) if (line.startsWith("[worker]") || line.includes("error")) process.stderr.write(`${line}\n`);
  });
  const exited = new Promise<number>((resolve) => child.on("exit", (code) => resolve(code ?? 1)));
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
  return {
    run: (n) =>
      new Promise<void>((resolve, reject) => {
        pending = { n, resolve, reject };
        child.stdin!.write(`run ${n}\n`);
      }),
    close: () => {
      child.stdin!.end();
      return exited;
    },
  };
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
  const preflight = await waitForIdle({ cpuPct: 20, gpuPct: 15, maxWaitMs: 300_000, windowMs: 10_000 });
  console.error(`[bench] preflight idle: ${JSON.stringify(preflight)}`);
  if (!preflight.ok && args.strictIdle) {
    console.error("[bench] host busy before benchmark start; refusing (--strict-idle)");
    process.exit(2);
  }

  const startedAt = new Date().toISOString();
  const cells: Array<{ fixture: string; profile: string; exitCode: number }> = [];
  delete process.env.HF_PROFILE_FALLBACK_CAPTURE;
  const variants = [
    ...args.profiles.map((profile) => ({ profile, control: false })),
    ...(args.control ? [{ profile: args.control, control: true }] : []),
  ];
  for (const [fi, fx] of manifest.entries()) {
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
      return { cellName, cacheDir, worker: spawnWorker(childArgs, childEnv), failed: false };
    });
    for (const { variant, run } of interleavedSchedule(workers.length, args.warmRuns, fi)) {
      const w = workers[variant]!;
      if (w.failed) continue;
      try {
        await w.worker.run(run);
      } catch (err) {
        w.failed = true;
        console.error(`[bench] ${fx.id}/${w.cellName}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    for (const w of workers) {
      const exitCode = await w.worker.close();
      cells.push({ fixture: fx.id, profile: w.cellName, exitCode: w.failed ? 1 : exitCode });
      rmSync(w.cacheDir, { recursive: true, force: true });
    }
  }

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
        orderRule: "per fixture: all cold runs, then warm rounds A,B,C,...; variant order rotates by (fixture index + run)",
        preflight,
        cells,
      },
      null,
      2,
    ) + "\n",
  );
  writeReport(outDir);
  console.error(`[bench] done: ${join(outDir, "report.md")}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
