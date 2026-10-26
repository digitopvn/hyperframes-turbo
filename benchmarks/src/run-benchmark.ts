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
 *     [--fixtures id,id] [--out dir] [--strict-idle]
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
}

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
  };
}

function runChild(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const tsxLoader = join(UPSTREAM_ROOT, "node_modules", "tsx", "dist", "loader.mjs");
    const child = spawn(
      process.execPath,
      ["--import", `file:///${tsxLoader.replace(/\\/g, "/")}`, join(BENCH_ROOT, "src", "render-worker.ts"), ...args],
      { env, stdio: ["ignore", "ignore", "pipe"], cwd: REPO_ROOT },
    );
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => {
      for (const line of d.split("\n")) if (line.startsWith("[worker]") || line.includes("error")) process.stderr.write(`${line}\n`);
    });
    child.on("exit", (code) => resolve(code ?? 1));
  });
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
  copyFileSync(join(outDir, "environment.json"), join(BENCH_ROOT, "environment.json"));

  console.error(`[bench] ${manifest.length} fixture(s) x ${args.profiles.length} profile(s) x (1 cold + ${args.warmRuns} warm) -> ${outDir}`);
  const preflight = await waitForIdle({ cpuPct: 20, gpuPct: 15, maxWaitMs: 300_000, windowMs: 10_000 });
  console.error(`[bench] preflight idle: ${JSON.stringify(preflight)}`);
  if (!preflight.ok && args.strictIdle) {
    console.error("[bench] host busy before benchmark start; refusing (--strict-idle)");
    process.exit(2);
  }

  const startedAt = new Date().toISOString();
  const cells: Array<{ fixture: string; profile: string; exitCode: number }> = [];
  for (const fx of manifest) {
    // Profiles run back to back per fixture so each pair shares the same host state.
    for (const profile of args.profiles) {
      const cacheDir = mkdtempSync(join(tmpdir(), `turbo-bench-xcache-`));
      const childEnv = {
        ...process.env,
        ...PROFILES[profile]!.env,
        HYPERFRAMES_EXTRACT_CACHE_DIR: cacheDir,
        // Opt-in upstream diagnostic: per-frame p50/p95/p99 on the screenshot fallback path.
        HF_PROFILE_FALLBACK_CAPTURE: "true",
      };
      const childArgs = ["--fixture", fx.id, "--profile", profile, "--warm-runs", String(args.warmRuns), "--out", join(outDir, "raw", fx.id, profile)];
      if (args.strictIdle) childArgs.push("--strict-idle");
      const exitCode = await runChild(childArgs, childEnv);
      cells.push({ fixture: fx.id, profile, exitCode });
      rmSync(cacheDir, { recursive: true, force: true });
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
