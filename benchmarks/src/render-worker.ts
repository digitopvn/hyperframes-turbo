/**
 * Child process for one (fixture, profile) cell: renders the fixture once cold
 * and N times warm in the SAME process, through the exact upstream API that
 * `packages/producer/src/benchmark.ts` and the regression harness use
 * (`createRenderJob` + `executeRenderJob`). Upstream source is not modified;
 * everything extra is observed from outside (logger, CDP tap, host samplers).
 *
 * Cold = fresh Node process, fresh Chrome, empty media extraction cache.
 * Warm = later renders in the same process (browser pool + extraction cache
 * may be reused exactly as upstream would reuse them).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { installCdpTap, resetCdpTap, snapshotCdpTap } from "./cdp-tap.js";
import { hashFixtureSource, loadManifest, prepareProject, resolveFixture, UPSTREAM_ROOT } from "./fixtures.js";
import { GpuSampler, ProcessTreeSampler, hasNvidiaSmi, summarizeGpu, waitForIdle, sampleGpu } from "./system-probes.js";
import type { TraceEvent } from "./trace-analysis.js";

/**
 * Idle gate thresholds over a 3 s window before every run. The CPU bar sits
 * above this host's measured desktop noise floor (~10-14 % with the desktop
 * session open) so it rejects real contention, not background chatter.
 */
const IDLE_CPU_PCT = 20;
const IDLE_GPU_PCT = 15;

interface Args {
  fixture: string;
  profile: string;
  warmRuns: number;
  outDir: string;
  strictIdle: boolean;
}

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (k: string) => {
    const i = a.indexOf(`--${k}`);
    return i >= 0 ? a[i + 1] : undefined;
  };
  return {
    fixture: get("fixture")!,
    profile: get("profile")!,
    warmRuns: Number(get("warm-runs") ?? 5),
    outDir: get("out")!,
    strictIdle: a.includes("--strict-idle"),
  };
}

function dirBytes(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    total += e.isDirectory() ? dirBytes(p) : statSync(p).size;
  }
  return total;
}

function ffprobe(path: string): unknown {
  const r = spawnSync(
    "ffprobe",
    ["-v", "error", "-count_packets", "-show_format", "-show_streams", "-of", "json", path],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (r.status !== 0) return { error: r.stderr };
  const j = JSON.parse(r.stdout);
  return {
    sizeBytes: Number(j.format?.size),
    durationSec: Number(j.format?.duration),
    bitRate: Number(j.format?.bit_rate),
    formatName: j.format?.format_name,
    streams: (j.streams ?? []).map((s: any) => ({
      type: s.codec_type,
      codec: s.codec_name,
      profile: s.profile,
      pixFmt: s.pix_fmt,
      width: s.width,
      height: s.height,
      rFrameRate: s.r_frame_rate,
      avgFrameRate: s.avg_frame_rate,
      packets: s.nb_read_packets ? Number(s.nb_read_packets) : undefined,
      durationSec: s.duration ? Number(s.duration) : undefined,
      bitRate: s.bit_rate ? Number(s.bit_rate) : undefined,
      colorSpace: s.color_space,
      colorTransfer: s.color_transfer,
      colorPrimaries: s.color_primaries,
      sampleRate: s.sample_rate ? Number(s.sample_rate) : undefined,
      channels: s.channels,
      alphaMode: s.tags?.alpha_mode ?? s.tags?.ALPHA_MODE,
    })),
  };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const entry = loadManifest().find((f) => f.id === args.fixture);
  if (!entry) throw new Error(`Unknown fixture ${args.fixture}`);
  const fx = resolveFixture(entry);
  mkdirSync(args.outDir, { recursive: true });

  const tapped = process.env.BENCH_CDP_TAP === "0" ? [] : await installCdpTap(UPSTREAM_ROOT);
  const orchestrator = await import(
    pathToFileURL(join(UPSTREAM_ROOT, "packages", "producer", "src", "services", "renderOrchestrator.ts")).href
  );
  const { createRenderJob, executeRenderJob } = orchestrator;
  // Every engine flag as resolved from defaults + this profile's env, recorded
  // so a result always says which upstream fast paths were eligible.
  const { resolveConfig } = await import(
    pathToFileURL(join(UPSTREAM_ROOT, "packages", "engine", "src", "config.ts")).href
  );
  const resolvedEngineConfig = resolveConfig();
  const profileEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => /^(PRODUCER_|HF_|HYPERFRAMES_)/.test(k)),
  );
  const fpsRaw = fx.meta.renderConfig.fps;
  const format = fx.meta.renderConfig.format ?? "mp4";
  const sourceHash = hashFixtureSource(fx);
  const gpuAvailable = hasNvidiaSmi();
  const totalRuns = 1 + args.warmRuns;
  // One project directory for every run of this cell, like a user re-exporting
  // the same project: the extraction cache is keyed on source path + mtime, so
  // a fresh copy per run would turn every warm run into a cache miss.
  const tmpRoot = mkdtempSync(join(tmpdir(), `turbo-bench-${fx.id}-`));
  const projectDir = join(tmpRoot, "src");
  const inputs = prepareProject(fx, projectDir);

  for (let run = 0; run < totalRuns; run++) {
    const kind = run === 0 ? "cold" : "warm";
    const idle = await waitForIdle({ cpuPct: IDLE_CPU_PCT, gpuPct: IDLE_GPU_PCT, maxWaitMs: 60_000, windowMs: 3000 });
    if (!idle.ok && args.strictIdle) {
      writeFileSync(
        join(args.outDir, `run-${run}.json`),
        JSON.stringify({ fixture: fx.id, profile: args.profile, run, kind, refused: true, idle }, null, 2),
      );
      console.error(`[worker] ${fx.id}/${args.profile} run ${run}: host busy, refused (strict)`);
      continue;
    }
    const baselineVram = gpuAvailable ? (await sampleGpu(1000)).at(-1)?.memUsedMiB ?? null : null;

    const outputPath = join(tmpRoot, `output-${run}.${format}`);

    const events: TraceEvent[] = [];
    const logCounts = { error: 0, warn: 0, info: 0, debug: 0 };
    const warnings: string[] = [];
    const logger = {
      error: (m: string, meta?: Record<string, unknown>) => {
        logCounts.error++;
        warnings.push(`error: ${m}`);
        console.error(`[upstream:error] ${m}`, meta ?? "");
      },
      warn: (m: string) => {
        logCounts.warn++;
        if (warnings.length < 50) warnings.push(`warn: ${m}`);
      },
      info: (m: string, meta?: Record<string, unknown>) => {
        logCounts.info++;
        if (m === "[Render:trace]" && meta) {
          events.push({
            phase: String(meta.phase),
            status: String(meta.status),
            elapsedMs: Number(meta.elapsedMs),
            durationMs: typeof meta.durationMs === "number" ? meta.durationMs : undefined,
          });
        }
      },
      debug: () => {
        logCounts.debug++;
      },
      isLevelEnabled: (level: string) => level !== "debug",
    };

    const gpu = new GpuSampler();
    const tree = new ProcessTreeSampler(process.pid, 1000);
    resetCdpTap();
    if (gpuAvailable) gpu.start(200);
    tree.start();

    const job = createRenderJob({
      fps: fpsRaw,
      quality: "high",
      format,
      workers: fx.meta.renderConfig.workers,
      useGpu: false,
      debug: false,
      hdrMode: fx.meta.renderConfig.hdr ? "force-hdr" : "force-sdr",
      variables: fx.meta.renderConfig.variables,
      logger,
    });

    const t0 = performance.now();
    const startedAt = new Date().toISOString();
    let error: string | null = null;
    try {
      await executeRenderJob(job, projectDir, outputPath);
    } catch (err) {
      error = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
    }
    const wallMs = performance.now() - t0;
    const gpuSamples = gpu.stop();
    const treeSummary = tree.stop();
    const cdp = snapshotCdpTap();

    const output = !error && existsSync(outputPath) ? ffprobe(outputPath) : null;
    const extractCacheDir = process.env.HYPERFRAMES_EXTRACT_CACHE_DIR;
    const result = {
      schema: "turbo-bench-run/1",
      fixture: fx.id,
      category: fx.category,
      source: fx.source,
      fixtureSourceSha256: sourceHash,
      inputs,
      profile: args.profile,
      profileEnv,
      resolvedEngineConfig: run === 0 ? resolvedEngineConfig : undefined,
      run,
      kind,
      startedAt,
      wallMs,
      error,
      idle,
      cdpTap: { installedOn: tapped, ...cdp },
      gpu: summarizeGpu(gpuSamples, baselineVram),
      gpuTimeline: gpuSamples.map((s) => [s.t, s.utilGpu, s.utilEnc, s.utilDec, s.memUsedMiB]),
      processTree: treeSummary,
      processTreeTimeline: tree.samples.map((s) => [s.t, s.workingSetBytes, s.processCount]),
      extractCacheBytesAfter: extractCacheDir ? dirBytes(extractCacheDir) : null,
      output,
      upstreamLog: { counts: logCounts, firstMessages: warnings.slice(0, 50) },
      traceEvents: events,
      perfSummary: job.perfSummary ?? null,
      jobStatus: job.status,
    };
    writeFileSync(join(args.outDir, `run-${run}.json`), JSON.stringify(result, null, 2));
    console.error(
      `[worker] ${fx.id}/${args.profile} run ${run} (${kind}): ${error ? "FAILED" : `${Math.round(wallMs)} ms`}`,
    );
    rmSync(outputPath, { force: true });
  }
  rmSync(tmpRoot, { recursive: true, force: true });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[worker] fatal", err);
    process.exit(1);
  });
