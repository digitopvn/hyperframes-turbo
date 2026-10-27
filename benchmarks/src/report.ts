/**
 * Aggregates raw `run-N.json` files into summary.json, runs.csv, summary.csv
 * and report.md. Pure function of the raw directory, so a report can always be
 * regenerated:
 *
 *   node --import ./upstream/hyperframes/node_modules/tsx/dist/loader.mjs \
 *     benchmarks/src/report.ts benchmarks/results/<date>-<sha>
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, percentile, type Distribution } from "./stats.js";
import { analyzeTrace, type TraceEvent } from "./trace-analysis.js";

// Raw run JSON as written by render-worker.ts (several schema generations), read untyped.
type Run = Record<string, any>;

/**
 * Reference compute price used ONLY for the labelled cost estimate. It is not
 * measured. Override with BENCH_USD_PER_VCPU_HOUR.
 */
export const REFERENCE_RATE = {
  usdPerVcpuHour: Number(process.env.BENCH_USD_PER_VCPU_HOUR ?? 0.0446),
  source:
    process.env.BENCH_USD_PER_VCPU_HOUR !== undefined
      ? "BENCH_USD_PER_VCPU_HOUR (user supplied)"
      : "AWS EC2 c7i.xlarge on-demand Linux, us-east-1, $0.1785/h for 4 vCPU = $0.0446 per vCPU-hour; public list price as known to the authors in 2025, not re-verified on the run date. Override with BENCH_USD_PER_VCPU_HOUR.",
};

/** Flat per-run metrics; also the column set of runs.csv. */
export interface RunMetrics {
  fixture: string;
  category: string;
  profile: string;
  instrumented: boolean;
  run: number;
  kind: "cold" | "warm";
  ok: boolean;
  idleOk: boolean;
  idleAttempts: number | null;
  wallMs: number;
  frames: number | null;
  outputDurationSec: number | null;
  fps: number | null;
  /** Output duration / wall time (>1 = faster than real time). */
  renderFactor: number | null;
  compileMs: number | null;
  videoExtractMs: number | null;
  audioProcessMs: number | null;
  captureMs: number | null;
  captureSetupMs: number | null;
  captureFrameMs: number | null;
  encodeMs: number | null;
  assembleMs: number | null;
  captureAvgMs: number | null;
  captureP50Ms: number | null;
  /** Upstream `perfSummary.captureCalibration.p95Ms` (calibration frames only). */
  captureCalibrationP95Ms: number | null;
  captureRpcP50Ms: number | null;
  captureRpcP95Ms: number | null;
  /** Heuristic: longest segment of the trace critical path (see trace-analysis.ts). */
  criticalPathTop: string | null;
  concurrencyFactor: number | null;
  /** Wall time where >1 traced stage was active. */
  overlapMs: number | null;
  /** Phases whose interval came from perfSummary.stages because upstream emits no trace event. */
  inferredPhases: string | null;
  /** Why the trace analysis of this run is incomplete, if it is. */
  traceWarnings: string | null;
  untracedMs: number | null;
  cdpInboundBytes: number | null;
  cdpOutboundBytes: number | null;
  /** Response bytes of frame-producing CDP calls (FRAME_METHODS). */
  frameRpcResponseBytes: number | null;
  frameRpcResponseBytesPerFrame: number | null;
  peakTreeWorkingSetMb: number | null;
  peakNodeRssMb: number | null;
  cpuSeconds: number | null;
  cpuSecondsPerOutputMin: number | null;
  wallSecondsPerOutputMin: number | null;
  /** Estimate: cpuSecondsPerOutputMin × REFERENCE_RATE. Not measured. */
  estUsdPerOutputMin: number | null;
  ioReadBytes: number | null;
  ioWriteBytes: number | null;
  tmpPeakBytes: number | null;
  peakVramDeltaMiB: number | null;
  gpuUtilMeanPct: number | null;
  encUtilMeanPct: number | null;
  extractCacheHits: number | null;
  extractCacheMisses: number | null;
  captureMode: string | null;
  capturePath: string | null;
  /** Upstream logged "Auto-worker calibration failed" (conservative worker budget). */
  calibrationFailed: boolean;
  drawElementClampReason: string | null;
  workers: number | null;
  staticDedupReused: number | null;
  outputBytes: number | null;
  outputBitRate: number | null;
  videoCodec: string | null;
  pixFmt: string | null;
  colorTransfer: string | null;
  alphaMode: string | null;
  audioCodec: string | null;
}

const FRAME_METHODS = ["Page.captureScreenshot", "HeadlessExperimental.beginFrame", "Runtime.callFunctionOn"];

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function loadRuns(outDir: string): Run[] {
  const raw = join(outDir, "raw");
  const runs: Run[] = [];
  if (!existsSync(raw)) return runs;
  for (const fixture of readdirSync(raw)) {
    for (const profile of readdirSync(join(raw, fixture))) {
      const dir = join(raw, fixture, profile);
      for (const f of readdirSync(dir).filter((n) => /^run-\d+\.json$/.test(n))) {
        runs.push(JSON.parse(readFileSync(join(dir, f), "utf8")));
      }
    }
  }
  return runs.sort((a, b) =>
    `${a.fixture}/${a.profile}/${String(a.run).padStart(3, "0")}`.localeCompare(
      `${b.fixture}/${b.profile}/${String(b.run).padStart(3, "0")}`,
    ),
  );
}

export function runMetrics(r: Run): RunMetrics {
  const ps = r.perfSummary ?? {};
  const st = ps.stages ?? {};
  const video = r.output?.streams?.find((s: { type?: string }) => s.type === "video");
  const audio = r.output?.streams?.find((s: { type?: string }) => s.type === "audio");
  const frames = num(video?.packets) ?? num(ps.totalFrames);
  const trace =
    Array.isArray(r.traceEvents) && r.traceEvents.length ? analyzeTrace(r.traceEvents as TraceEvent[], r.wallMs, st) : null;
  const top = trace ? [...trace.criticalPath].sort((a, b) => b.ms - a.ms)[0] : undefined;
  const byMethod = r.cdpTap?.byMethod ?? null;
  const frameBytes = byMethod ? FRAME_METHODS.reduce((a, m) => a + (byMethod[m]?.bytes ?? 0), 0) : null;
  const shot = byMethod?.["Page.captureScreenshot"] ?? byMethod?.["HeadlessExperimental.beginFrame"];
  const lat: number[] = shot?.latenciesMs ?? [];
  const extraction = ps.observability?.extraction ?? {};
  const durationSec = num(r.output?.durationSec);
  const outMin = durationSec ? durationSec / 60 : null;
  const cpuSeconds = num(r.processTree?.cpuSeconds);
  const cpuPerMin = cpuSeconds != null && outMin ? cpuSeconds / outMin : null;
  return {
    fixture: r.fixture,
    category: r.category,
    profile: r.profile,
    instrumented: r.instrumented !== false,
    run: r.run,
    kind: r.kind,
    ok: !r.error && !r.refused && r.jobStatus !== "failed",
    idleOk: r.idle?.ok ?? false,
    idleAttempts: num(r.idle?.attempts),
    wallMs: r.wallMs,
    frames,
    outputDurationSec: durationSec,
    fps: frames && r.wallMs ? frames / (r.wallMs / 1000) : null,
    renderFactor: durationSec && r.wallMs ? durationSec / (r.wallMs / 1000) : null,
    compileMs: num(st.compileMs),
    videoExtractMs: num(st.videoExtractMs),
    audioProcessMs: num(st.audioProcessMs),
    captureMs: num(st.captureMs),
    captureSetupMs: num(st.captureSetupMs),
    captureFrameMs: num(st.captureFrameMs),
    encodeMs: num(st.encodeMs),
    assembleMs: num(st.assembleMs),
    captureAvgMs: num(ps.captureAvgMs),
    captureP50Ms: num(ps.captureP50Ms),
    captureCalibrationP95Ms: num(ps.captureCalibration?.p95Ms),
    captureRpcP50Ms: lat.length ? percentile(lat, 0.5) : null,
    captureRpcP95Ms: lat.length ? percentile(lat, 0.95) : null,
    criticalPathTop: top ? `${top.phase} (${Math.round(top.ms)} ms)` : null,
    concurrencyFactor: trace ? trace.concurrencyFactor : null,
    overlapMs: trace ? trace.overlapMs : null,
    inferredPhases: trace?.inferredPhases.length ? trace.inferredPhases.join("+") : null,
    traceWarnings: trace?.warnings.length ? trace.warnings.join("; ") : null,
    untracedMs: trace ? trace.untracedMs : null,
    cdpInboundBytes: num(r.cdpTap?.inboundBytes),
    cdpOutboundBytes: num(r.cdpTap?.outboundBytes),
    frameRpcResponseBytes: frameBytes,
    frameRpcResponseBytesPerFrame: frameBytes != null && frames ? frameBytes / frames : null,
    peakTreeWorkingSetMb: num(r.processTree?.peakWorkingSetBytes) != null ? r.processTree.peakWorkingSetBytes / 2 ** 20 : null,
    peakNodeRssMb: num(ps.peakRssMb),
    cpuSeconds,
    cpuSecondsPerOutputMin: cpuPerMin,
    wallSecondsPerOutputMin: outMin ? r.wallMs / 1000 / outMin : null,
    estUsdPerOutputMin: cpuPerMin != null ? (cpuPerMin / 3600) * REFERENCE_RATE.usdPerVcpuHour : null,
    ioReadBytes: num(r.processTree?.readTransferBytes),
    ioWriteBytes: num(r.processTree?.writeTransferBytes),
    tmpPeakBytes: num(ps.tmpPeakBytes),
    peakVramDeltaMiB: num(r.gpu?.peakVramDeltaMiB),
    gpuUtilMeanPct: num(r.gpu?.avgUtilGpuPct),
    encUtilMeanPct: num(r.gpu?.avgUtilEncPct),
    extractCacheHits: num(extraction.cacheHits),
    extractCacheMisses: num(extraction.cacheMisses),
    captureMode: ps.observability?.capture?.captureMode ?? null,
    capturePath: ps.observability?.capture?.capturePath ?? null,
    calibrationFailed: (r.upstreamLog?.firstMessages ?? []).some((m: string) => m.includes("Auto-worker calibration failed")),
    drawElementClampReason: ps.drawElement?.clampReason ?? null,
    workers: num(ps.workers),
    staticDedupReused: num(ps.staticDedup?.reusedFrames),
    outputBytes: num(r.output?.sizeBytes),
    outputBitRate: num(r.output?.bitRate),
    videoCodec: video?.codec ?? null,
    pixFmt: video?.pixFmt ?? null,
    colorTransfer: video?.colorTransfer ?? null,
    alphaMode: video?.alphaMode ?? null,
    audioCodec: audio?.codec ?? null,
  };
}

const AGG_KEYS = [
  "wallMs", "fps", "renderFactor", "captureMs", "captureSetupMs", "captureFrameMs", "encodeMs", "videoExtractMs",
  "captureCalibrationP95Ms", "captureRpcP50Ms", "captureRpcP95Ms", "overlapMs", "cdpInboundBytes", "cdpOutboundBytes",
  "frameRpcResponseBytes", "peakTreeWorkingSetMb", "peakVramDeltaMiB", "cpuSeconds", "cpuSecondsPerOutputMin",
  "wallSecondsPerOutputMin", "estUsdPerOutputMin", "ioWriteBytes", "tmpPeakBytes", "extractCacheHits",
  "extractCacheMisses", "outputBytes", "outputBitRate",
] as const satisfies readonly (keyof RunMetrics)[];

export interface CellSummary {
  fixture: string;
  category: string;
  profile: string;
  instrumented: boolean;
  cold: RunMetrics | null;
  warmRuns: number;
  warmFailed: number;
  idleFlagged: number;
  /** Warm distribution per metric. With n < 20 the nearest-rank p95 equals the max. */
  warm: Partial<Record<(typeof AGG_KEYS)[number], Distribution | null>>;
  /** Stage overlap of the warm run closest to the warm median wall time. */
  representativeTrace: ReturnType<typeof analyzeTrace> | null;
  /**
   * Upstream auto-calibration can pick a different capture path or worker
   * count per run, so warm medians may mix pipelines. One entry per distinct
   * (capturePath, workers) among the warm runs, with its own distributions.
   */
  pathGroups: Array<{ capturePath: string | null; workers: number | null; runs: number[]; warm: Partial<Record<(typeof AGG_KEYS)[number], Distribution | null>> }>;
  /** True when the warm runs used more than one (capturePath, workers) pair. */
  mixedPath: boolean;
  facts: Pick<
    RunMetrics,
    "captureMode" | "capturePath" | "drawElementClampReason" | "workers" | "videoCodec" | "pixFmt" | "colorTransfer" | "alphaMode" | "audioCodec" | "frames"
  >;
}

function csv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]!);
  const esc = (v: unknown) => {
    const s = v == null ? "" : typeof v === "number" ? String(Math.round(v * 1e6) / 1e6) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n") + "\n";
}

const fmt = (v: number | null | undefined, d = 0) => (v == null || !Number.isFinite(v) ? "—" : v.toFixed(d));
const mib = (v: number | null | undefined, d = 1) => (v == null ? "—" : (v / 2 ** 20).toFixed(d));
const gib = (v: number | null | undefined) => (v == null ? "—" : (v / 2 ** 30).toFixed(2));

function summarize(cr: Run[], m: RunMetrics[]): CellSummary {
  const cold = m.find((x) => x.kind === "cold") ?? null;
  const warmAll = m.filter((x) => x.kind === "warm");
  const warm = warmAll.filter((x) => x.ok);
  const agg: CellSummary["warm"] = {};
  for (const k of AGG_KEYS) agg[k] = describe(warm.map((x) => x[k] as number).filter((v) => v != null));
  const med = agg.wallMs?.median;
  const rep = med != null && warm.length ? warm.reduce((a, b) => (Math.abs(b.wallMs - med) < Math.abs(a.wallMs - med) ? b : a)) : null;
  const repRun = rep ? cr.find((r) => r.run === rep.run) : null;
  const ref = rep ?? cold;
  const groups = new Map<string, RunMetrics[]>();
  for (const x of warm) {
    const k = `${x.capturePath}/${x.workers}`;
    groups.set(k, [...(groups.get(k) ?? []), x]);
  }
  const pathGroups = [...groups.values()].map((g) => {
    const d: CellSummary["warm"] = {};
    for (const k of AGG_KEYS) d[k] = describe(g.map((x) => x[k] as number).filter((v) => v != null));
    return { capturePath: g[0]!.capturePath, workers: g[0]!.workers, runs: g.map((x) => x.run), warm: d };
  });
  return {
    fixture: m[0]!.fixture,
    category: m[0]!.category,
    profile: m[0]!.profile,
    instrumented: m[0]!.instrumented,
    cold,
    warmRuns: warmAll.length,
    warmFailed: warmAll.length - warm.length,
    idleFlagged: m.filter((x) => !x.idleOk).length,
    warm: agg,
    pathGroups,
    mixedPath: pathGroups.length > 1,
    representativeTrace: repRun?.traceEvents?.length
      ? analyzeTrace(repRun.traceEvents, repRun.wallMs, repRun.perfSummary?.stages)
      : null,
    facts: {
      captureMode: ref?.captureMode ?? null,
      capturePath: pathGroups.length > 1 ? "mixed" : (ref?.capturePath ?? null),
      drawElementClampReason: ref?.drawElementClampReason ?? null,
      workers: pathGroups.length > 1 ? null : (ref?.workers ?? null),
      videoCodec: ref?.videoCodec ?? null,
      pixFmt: ref?.pixFmt ?? null,
      colorTransfer: ref?.colorTransfer ?? null,
      alphaMode: ref?.alphaMode ?? null,
      audioCodec: ref?.audioCodec ?? null,
      frames: ref?.frames ?? null,
    },
  };
}

export function writeReport(outDir: string): CellSummary[] {
  const runs = loadRuns(outDir).filter((r) => !r.refused);
  const refused = loadRuns(outDir).length - runs.length;
  const metrics = runs.map(runMetrics);
  const cells = new Map<string, { runs: Run[]; m: RunMetrics[] }>();
  runs.forEach((r, i) => {
    const k = `${r.fixture}\u0000${r.profile}`;
    const c = cells.get(k) ?? { runs: [], m: [] };
    c.runs.push(r);
    c.m.push(metrics[i]!);
    cells.set(k, c);
  });
  const all = [...cells.values()].map(({ runs: cr, m }) => summarize(cr, m));
  const summaries = all.filter((s) => s.instrumented);
  const controls = all.filter((s) => !s.instrumented);

  const env = existsSync(join(outDir, "environment.json")) ? JSON.parse(readFileSync(join(outDir, "environment.json"), "utf8")) : null;
  const manifest = existsSync(join(outDir, "run-manifest.json"))
    ? JSON.parse(readFileSync(join(outDir, "run-manifest.json"), "utf8"))
    : null;

  // Overhead of the harness: instrumented cell vs the uninstrumented control of the same profile.
  const overhead = controls.flatMap((c) => {
    const base = c.profile.replace(/\.control$/, "");
    const inst = summaries.find((s) => s.fixture === c.fixture && s.profile === base);
    if (!inst) return [];
    const pct = (a?: number | null, b?: number | null) => (a != null && b != null && b > 0 ? ((a - b) / b) * 100 : null);
    return [
      {
        fixture: c.fixture,
        profile: base,
        controlColdMs: c.cold?.wallMs ?? null,
        instrumentedColdMs: inst.cold?.wallMs ?? null,
        coldOverheadPct: pct(inst.cold?.wallMs, c.cold?.wallMs),
        controlWarmMedianMs: c.warm.wallMs?.median ?? null,
        instrumentedWarmMedianMs: inst.warm.wallMs?.median ?? null,
        warmMedianOverheadPct: pct(inst.warm.wallMs?.median, c.warm.wallMs?.median),
        controlWarmCv: c.warm.wallMs?.cv ?? null,
        instrumentedWarmCv: inst.warm.wallMs?.cv ?? null,
      },
    ];
  });

  writeFileSync(join(outDir, "runs.csv"), csv(metrics as unknown as Record<string, unknown>[]));
  writeFileSync(
    join(outDir, "summary.csv"),
    csv(
      all.map((s) => ({
        fixture: s.fixture,
        category: s.category,
        profile: s.profile,
        instrumented: s.instrumented,
        warmRuns: s.warmRuns,
        warmFailed: s.warmFailed,
        idleFlagged: s.idleFlagged,
        coldWallMs: s.cold?.wallMs,
        coldVideoExtractMs: s.cold?.videoExtractMs,
        coldExtractCacheHits: s.cold?.extractCacheHits,
        coldExtractCacheMisses: s.cold?.extractCacheMisses,
        ...Object.fromEntries(
          AGG_KEYS.flatMap((k) => [
            [`${k}_median`, s.warm[k]?.median],
            [`${k}_max`, s.warm[k]?.max],
            [`${k}_cv`, s.warm[k]?.cv],
          ]),
        ),
        concurrencyFactor: s.representativeTrace?.concurrencyFactor,
        inferredPhases: s.representativeTrace?.inferredPhases.join("+") ?? "",
        captureMode: s.facts.captureMode,
        capturePath: s.facts.capturePath,
        drawElementClampReason: s.facts.drawElementClampReason,
        workers: s.facts.workers,
      })),
    ),
  );
  writeFileSync(join(outDir, "overhead.csv"), csv(overhead));
  writeFileSync(
    join(outDir, "summary.json"),
    JSON.stringify(
      {
        schema: "turbo-bench-summary/2",
        generatedAt: new Date().toISOString(),
        refusedRuns: refused,
        referenceRate: REFERENCE_RATE,
        cells: all,
        harnessOverhead: overhead,
      },
      null,
      2,
    ) + "\n",
  );

  const L: string[] = [];
  const up = env?.upstream;
  const host = env?.host;
  L.push(`# Baseline benchmark report`, "");
  L.push(
    `Generated by \`benchmarks/src/report.ts\` from \`raw/\`. Every number is measured on the host in \`environment.json\`, except the column explicitly labelled *estimate*.`,
    "",
  );
  if (env) {
    L.push(`- Upstream: \`${up?.sha}\` (producer ${up?.producerVersion}, bun.lock sha256 \`${String(up?.lockfileSha256).slice(0, 16)}…\`)`);
    L.push(`- Chrome: ${env.toolchain?.chrome?.version} · Node ${env.toolchain?.node} · ${env.toolchain?.ffmpeg}`);
    L.push(
      `- Host: ${host?.cpu?.Name ?? host?.cpuModelNode}, ${(host?.ramBytes / 2 ** 30).toFixed(0)} GiB RAM, ${(host?.gpu ?? [])
        .map((g: { name?: string; driver?: string }) => `${g.name} (driver ${g.driver})`)
        .join(", ")}, ${host?.os?.Caption} ${host?.os?.Version}`,
    );
    L.push(`- Not tested: ${(env.notTested ?? []).join("; ")}`);
  }
  if (manifest) {
    L.push(`- Command: \`${manifest.command}\``);
    L.push(
      `- Window: ${manifest.startedAt} → ${manifest.finishedAt}; preflight idle ok=${manifest.preflight?.ok} (cpu ${fmt(manifest.preflight?.cpuBusyPct, 1)} %, gpu ${fmt(manifest.preflight?.gpuUtilPct, 1)} %)`,
    );
    if (manifest.orderRule) L.push(`- Order: ${manifest.orderRule}`);
  }
  L.push(`- Refused runs (host busy under --strict-idle): ${refused}`, "");
  L.push(
    `Warm = the successful warm runs of each cell (n per cell in the *warm ok/n* column): median, **max** and coefficient of variation (cv). With n ≤ 5 a nearest-rank p95 is the max, so the max is reported under its own name. Cold = first render in a fresh process with an empty extraction cache, reported separately.`,
    "",
  );

  L.push(`## Wall time and throughput`, "");
  L.push(`| fixture | profile | capture path | frames | cold s | warm median s | warm max s | cv % | fps | render× | warm ok/n | idle flags |`);
  L.push(`|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|`);
  for (const s of summaries) {
    const w = s.warm;
    L.push(
      `| ${s.fixture} | ${s.profile} | ${s.facts.captureMode ?? "—"}/${s.facts.capturePath ?? "—"} | ${s.facts.frames ?? "—"} | ${fmt((s.cold?.wallMs ?? NaN) / 1000, 2)} | ${fmt((w.wallMs?.median ?? NaN) / 1000, 2)} | ${fmt((w.wallMs?.max ?? NaN) / 1000, 2)} | ${fmt((w.wallMs?.cv ?? NaN) * 100, 1)} | ${fmt(w.fps?.median, 1)} | ${fmt(w.renderFactor?.median, 2)} | ${s.warmRuns - s.warmFailed}/${s.warmRuns} | ${s.idleFlagged} |`,
    );
  }
  L.push("");

  L.push(`## Stage time (warm medians, ms), overlap and critical path`, "");
  L.push(
    `Stage values are upstream \`perfSummary.stages\`. Overlap and the critical path come from the trace sweep in \`trace-analysis.ts\` on the warm run closest to the median. **Inferred**: upstream emits no \`encode\` trace event for self-encoding capture stages (\`capture_streaming\`, \`capture_hdr_layered\`), so that interval is rebuilt from \`stages.encodeMs\`, aligned to the end of the capture stage. The critical path is a heuristic (the stage that ends last at each instant), not a dependency graph.`,
    "",
  );
  L.push(`| fixture | profile | extract | capture | setup | frames | encode | overlap ms | concurrency× | inferred | untraced ms | critical path (≥50 ms segments) |`);
  L.push(`|---|---|---:|---:|---:|---:|---:|---:|---:|---|---:|---|`);
  for (const s of summaries) {
    const w = s.warm;
    const t = s.representativeTrace;
    const cp = t ? t.criticalPath.filter((c) => c.ms >= 50).map((c) => `${c.phase} ${Math.round(c.ms)}`).join(" → ") : "—";
    L.push(
      `| ${s.fixture} | ${s.profile} | ${fmt(w.videoExtractMs?.median)} | ${fmt(w.captureMs?.median)} | ${fmt(w.captureSetupMs?.median)} | ${fmt(w.captureFrameMs?.median)} | ${fmt(w.encodeMs?.median)} | ${fmt(w.overlapMs?.median)} | ${fmt(t?.concurrencyFactor, 2)} | ${t?.inferredPhases.join("+") || "—"} | ${fmt(t?.untracedMs)} | ${cp} |`,
    );
  }
  L.push("");

  L.push(`## Transport, capture latency and media cache`, "");
  L.push(
    `CDP bytes are counted at the puppeteer connection in both directions. Frame RPC = response bytes of ${FRAME_METHODS.join(", ")}. Capture RPC latency is per \`Page.captureScreenshot\` call as seen by Node. Calibration p95 = upstream \`captureCalibration.p95Ms\`. Disk write = I/O transfer bytes of the whole process tree. Pixels that never cross CDP (for example pre-extracted HDR video frames composited in Node) appear in disk/IO, not in CDP.`,
    "",
  );
  L.push(`| fixture | profile | CDP in MiB | CDP out MiB | frame RPC KiB/frame | capture RPC p50/p95 ms | calib p95 ms | disk write GiB | tmp peak MiB | cold extract ms | cache hit/miss cold → warm |`);
  L.push(`|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|`);
  for (const s of summaries) {
    const w = s.warm;
    const perFrame = w.frameRpcResponseBytes?.median != null && s.facts.frames ? w.frameRpcResponseBytes.median / s.facts.frames / 1024 : null;
    const cache =
      s.cold?.extractCacheHits == null && s.cold?.extractCacheMisses == null
        ? "no video"
        : `${fmt(s.cold?.extractCacheHits)}/${fmt(s.cold?.extractCacheMisses)} → ${fmt(w.extractCacheHits?.median)}/${fmt(w.extractCacheMisses?.median)}`;
    L.push(
      `| ${s.fixture} | ${s.profile} | ${mib(w.cdpInboundBytes?.median)} | ${mib(w.cdpOutboundBytes?.median)} | ${fmt(perFrame)} | ${fmt(w.captureRpcP50Ms?.median, 1)}/${fmt(w.captureRpcP95Ms?.median, 1)} | ${fmt(w.captureCalibrationP95Ms?.median)} | ${gib(w.ioWriteBytes?.median)} | ${mib(w.tmpPeakBytes?.median)} | ${fmt(s.cold?.videoExtractMs)} | ${cache} |`,
    );
  }
  L.push("");

  L.push(`## Peak resources and cost per output minute (warm medians)`, "");
  L.push(
    `Peak tree WS = summed working set of Node + Chrome + FFmpeg descendants, sampled every 1 s. CPU s = CPU time of that tree. **Est. $/output-min is an estimate, not a measurement**: CPU-seconds per output minute × ${REFERENCE_RATE.usdPerVcpuHour} USD per vCPU-hour (${REFERENCE_RATE.source}).`,
    "",
  );
  L.push(`| fixture | profile | peak tree WS MiB | ΔVRAM MiB | GPU util % | CPU s | CPU s / output-min | wall s / output-min | est. $ / output-min | output MiB | bitrate Mb/s | output |`);
  L.push(`|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|`);
  for (const s of summaries) {
    const w = s.warm;
    const out = [s.facts.videoCodec, s.facts.pixFmt, s.facts.colorTransfer, s.facts.alphaMode ? `alpha_mode=${s.facts.alphaMode}` : null, s.facts.audioCodec]
      .filter(Boolean)
      .join(" ");
    const gpu = s.cold ? metrics.filter((x) => x.fixture === s.fixture && x.profile === s.profile && x.kind === "warm" && x.ok).map((x) => x.gpuUtilMeanPct ?? NaN) : [];
    L.push(
      `| ${s.fixture} | ${s.profile} | ${fmt(w.peakTreeWorkingSetMb?.median)} | ${fmt(w.peakVramDeltaMiB?.median)} | ${fmt(describe(gpu)?.median, 1)} | ${fmt(w.cpuSeconds?.median, 1)} | ${fmt(w.cpuSecondsPerOutputMin?.median)} | ${fmt(w.wallSecondsPerOutputMin?.median)} | ${fmt(w.estUsdPerOutputMin?.median, 4)} | ${mib(w.outputBytes?.median)} | ${fmt((w.outputBitRate?.median ?? NaN) / 1e6, 2)} | ${out} |`,
    );
  }
  L.push("");

  if (overhead.length) {
    L.push(`## Harness overhead (uninstrumented control)`, "");
    L.push(
      `Control cells run the same fixture and profile with no CDP tap, no host samplers and \`HF_PROFILE_FALLBACK_CAPTURE\` unset, measuring wall time only. Overhead = (instrumented − control) / control. The idle gate still runs before each run. Treat differences within the cv as noise.`,
      "",
    );
    L.push(`| fixture | profile | control cold s | instrumented cold s | cold Δ % | control warm median s | instrumented warm median s | warm Δ % | control cv % | instrumented cv % |`);
    L.push(`|---|---|---:|---:|---:|---:|---:|---:|---:|---:|`);
    for (const o of overhead) {
      L.push(
        `| ${o.fixture} | ${o.profile} | ${fmt((o.controlColdMs ?? NaN) / 1000, 2)} | ${fmt((o.instrumentedColdMs ?? NaN) / 1000, 2)} | ${fmt(o.coldOverheadPct, 1)} | ${fmt((o.controlWarmMedianMs ?? NaN) / 1000, 2)} | ${fmt((o.instrumentedWarmMedianMs ?? NaN) / 1000, 2)} | ${fmt(o.warmMedianOverheadPct, 1)} | ${fmt((o.controlWarmCv ?? NaN) * 100, 1)} | ${fmt((o.instrumentedWarmCv ?? NaN) * 100, 1)} |`,
      );
    }
    L.push("");
  }

  const mixed = all.filter((s) => s.mixedPath);
  if (mixed.length) {
    L.push(`## Mixed capture path within a cell`, "");
    L.push(
      `Upstream auto-calibration chose a different capture path or worker count across the warm runs of these cells, so their pooled warm medians mix pipelines. Per-path distributions (warm medians, n = runs on that path):`,
      "",
    );
    L.push(`| fixture | profile | capture path | workers | runs | n | wall median s | wall max s | setup median ms | frames median ms | encode median ms |`);
    L.push(`|---|---|---|---:|---|---:|---:|---:|---:|---:|---:|`);
    for (const s of mixed) {
      for (const g of s.pathGroups) {
        L.push(
          `| ${s.fixture} | ${s.profile} | ${g.capturePath ?? "—"} | ${g.workers ?? "—"} | ${g.runs.join(",")} | ${g.runs.length} | ${fmt((g.warm.wallMs?.median ?? NaN) / 1000, 2)} | ${fmt((g.warm.wallMs?.max ?? NaN) / 1000, 2)} | ${fmt(g.warm.captureSetupMs?.median)} | ${fmt(g.warm.captureFrameMs?.median)} | ${fmt(g.warm.encodeMs?.median)} |`,
        );
      }
    }
    L.push("");
  }

  const noisy = summaries.filter((s) => (s.warm.wallMs?.cv ?? 0) > 0.1);
  if (noisy.length) {
    L.push(`## High-variance cells (warm cv > 10 %)`, "");
    for (const s of noisy) {
      const warm = metrics.filter((x) => x.fixture === s.fixture && x.profile === s.profile && x.kind === "warm");
      L.push(
        `- ${s.fixture}/${s.profile}: ` +
          warm.map((x) => `run ${x.run} ${fmt(x.wallMs / 1000, 2)} s (${x.capturePath ?? "—"}, workers ${fmt(x.workers)}, setup ${fmt(x.captureSetupMs)} ms, idle attempts ${fmt(x.idleAttempts)})`).join("; "),
      );
    }
    L.push("");
  }

  const failures = metrics.filter((x) => !x.ok);
  if (failures.length) {
    L.push(`## Failed runs`, "");
    for (const f of failures) {
      const r = runs.find((x) => x.fixture === f.fixture && x.profile === f.profile && x.run === f.run);
      L.push(`- ${f.fixture}/${f.profile} run ${f.run}: ${String(r?.error ?? r?.jobStatus).split("\n")[0]}`);
    }
    L.push("");
  }
  writeFileSync(join(outDir, "report.md"), L.join("\n"));
  return all;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = process.argv[2];
  if (!dir) throw new Error("usage: report.ts <results-dir>");
  writeReport(dir);
  console.log(`report written to ${join(dir, "report.md")}`);
}
