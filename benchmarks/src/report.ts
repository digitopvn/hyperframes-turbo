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

type Run = Record<string, any>;

/** Flat per-run metrics; also the column set of runs.csv. */
export interface RunMetrics {
  fixture: string;
  category: string;
  profile: string;
  run: number;
  kind: "cold" | "warm";
  ok: boolean;
  idleOk: boolean;
  idleAttempts: number | null;
  wallMs: number;
  frames: number | null;
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
  captureP95Ms: number | null;
  captureRpcP50Ms: number | null;
  captureRpcP95Ms: number | null;
  criticalPathTop: string | null;
  concurrencyFactor: number | null;
  untracedMs: number | null;
  cdpInboundBytes: number | null;
  readbackBytes: number | null;
  readbackBytesPerFrame: number | null;
  peakTreeWorkingSetMb: number | null;
  peakNodeRssMb: number | null;
  cpuSeconds: number | null;
  ioReadBytes: number | null;
  ioWriteBytes: number | null;
  tmpPeakBytes: number | null;
  peakVramDeltaMiB: number | null;
  gpuUtilMeanPct: number | null;
  encUtilMeanPct: number | null;
  extractCacheHits: number | null;
  extractCacheMisses: number | null;
  captureMode: string | null;
  workers: number | null;
  staticDedupSkipped: number | null;
  outputBytes: number | null;
  outputBitRate: number | null;
  videoCodec: string | null;
  pixFmt: string | null;
  colorTransfer: string | null;
  audioCodec: string | null;
}

const READBACK_METHODS = ["Page.captureScreenshot", "HeadlessExperimental.beginFrame", "Runtime.callFunctionOn", "Runtime.evaluate"];

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
  return runs.sort((a, b) => `${a.fixture}/${a.profile}/${String(a.run).padStart(3, "0")}`.localeCompare(`${b.fixture}/${b.profile}/${String(b.run).padStart(3, "0")}`));
}

export function runMetrics(r: Run): RunMetrics {
  const ps = r.perfSummary ?? {};
  const st = ps.stages ?? {};
  const video = r.output?.streams?.find((s: any) => s.type === "video");
  const audio = r.output?.streams?.find((s: any) => s.type === "audio");
  const frames = num(video?.packets) ?? num(ps.totalFrames);
  const trace = Array.isArray(r.traceEvents) && r.traceEvents.length ? analyzeTrace(r.traceEvents as TraceEvent[], r.wallMs) : null;
  const top = trace ? [...trace.criticalPath].sort((a, b) => b.ms - a.ms)[0] : undefined;
  const byMethod = r.cdpTap?.byMethod ?? {};
  const readbackBytes = r.cdpTap?.byMethod
    ? READBACK_METHODS.reduce((a, m) => a + (byMethod[m]?.bytes ?? 0), 0)
    : null;
  const shot = byMethod["Page.captureScreenshot"] ?? byMethod["HeadlessExperimental.beginFrame"];
  const lat: number[] = shot?.latenciesMs ?? [];
  const extraction = ps.observability?.extraction ?? {};
  const durationSec = num(r.output?.durationSec);
  return {
    fixture: r.fixture,
    category: r.category,
    profile: r.profile,
    run: r.run,
    kind: r.kind,
    ok: !r.error && !r.refused && r.jobStatus !== "failed",
    idleOk: r.idle?.ok ?? false,
    idleAttempts: num(r.idle?.attempts),
    wallMs: r.wallMs,
    frames,
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
    captureP95Ms: num(ps.captureCalibration?.p95Ms),
    captureRpcP50Ms: lat.length ? percentile(lat, 0.5) : null,
    captureRpcP95Ms: lat.length ? percentile(lat, 0.95) : null,
    criticalPathTop: top ? `${top.phase} (${Math.round(top.ms)} ms)` : null,
    concurrencyFactor: trace ? trace.concurrencyFactor : null,
    untracedMs: trace ? trace.untracedMs : null,
    cdpInboundBytes: num(r.cdpTap?.inboundBytes),
    readbackBytes,
    readbackBytesPerFrame: readbackBytes != null && frames ? readbackBytes / frames : null,
    peakTreeWorkingSetMb: num(r.processTree?.peakWorkingSetBytes) != null ? r.processTree.peakWorkingSetBytes / 2 ** 20 : null,
    peakNodeRssMb: num(ps.peakRssMb),
    cpuSeconds: num(r.processTree?.cpuSeconds),
    ioReadBytes: num(r.processTree?.readTransferBytes),
    ioWriteBytes: num(r.processTree?.writeTransferBytes),
    tmpPeakBytes: num(ps.tmpPeakBytes),
    peakVramDeltaMiB: num(r.gpu?.peakVramDeltaMiB),
    gpuUtilMeanPct: num(r.gpu?.avgUtilGpuPct),
    encUtilMeanPct: num(r.gpu?.avgUtilEncPct),
    extractCacheHits: num(extraction.cacheHits),
    extractCacheMisses: num(extraction.cacheMisses),
    captureMode: ps.observability?.capture?.captureMode ?? null,
    workers: num(ps.workers),
    staticDedupSkipped: num(ps.staticDedup?.reusedFrames),
    outputBytes: num(r.output?.sizeBytes),
    outputBitRate: num(r.output?.bitRate),
    videoCodec: video?.codec ?? null,
    pixFmt: video?.pixFmt ?? null,
    colorTransfer: video?.colorTransfer ?? null,
    audioCodec: audio?.codec ?? null,
  };
}

const AGG_KEYS = [
  "wallMs", "fps", "renderFactor", "captureMs", "captureSetupMs", "captureFrameMs", "encodeMs", "videoExtractMs",
  "captureRpcP50Ms", "captureRpcP95Ms", "readbackBytes", "peakTreeWorkingSetMb", "peakVramDeltaMiB",
  "cpuSeconds", "ioWriteBytes", "tmpPeakBytes", "outputBytes", "outputBitRate",
] as const satisfies readonly (keyof RunMetrics)[];

export interface CellSummary {
  fixture: string;
  category: string;
  profile: string;
  cold: RunMetrics | null;
  warmRuns: number;
  warmFailed: number;
  idleFlagged: number;
  warm: Partial<Record<(typeof AGG_KEYS)[number], Distribution | null>>;
  /** Stage overlap of the warm run closest to the warm median wall time. */
  representativeTrace: ReturnType<typeof analyzeTrace> | null;
  facts: Pick<RunMetrics, "captureMode" | "workers" | "videoCodec" | "pixFmt" | "colorTransfer" | "audioCodec" | "frames">;
}

function csv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]!);
  const esc = (v: unknown) => {
    const s = v == null ? "" : typeof v === "number" ? String(Math.round(v * 1000) / 1000) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n") + "\n";
}

const fmt = (v: number | null | undefined, d = 0) => (v == null || !Number.isFinite(v) ? "—" : v.toFixed(d));
const mb = (v: number | null | undefined) => (v == null ? "—" : (v / 2 ** 20).toFixed(1));

export function writeReport(outDir: string): CellSummary[] {
  const runs = loadRuns(outDir);
  const metrics = runs.filter((r) => !r.refused).map(runMetrics);
  const refused = runs.filter((r) => r.refused).length;
  const cells = new Map<string, { runs: Run[]; m: RunMetrics[] }>();
  runs.filter((r) => !r.refused).forEach((r, i) => {
    const k = `${r.fixture}\u0000${r.profile}`;
    const c = cells.get(k) ?? { runs: [], m: [] };
    c.runs.push(r);
    c.m.push(metrics[i]!);
    cells.set(k, c);
  });

  const summaries: CellSummary[] = [];
  for (const { runs: cr, m } of cells.values()) {
    const cold = m.find((x) => x.kind === "cold") ?? null;
    const warmAll = m.filter((x) => x.kind === "warm");
    const warm = warmAll.filter((x) => x.ok);
    const agg: CellSummary["warm"] = {};
    for (const k of AGG_KEYS) agg[k] = describe(warm.map((x) => x[k] as number).filter((v) => v != null));
    const med = agg.wallMs?.median;
    const rep = med != null ? warm.reduce((a, b) => (Math.abs(b.wallMs - med) < Math.abs(a.wallMs - med) ? b : a)) : null;
    const repRun = rep ? cr.find((r) => r.run === rep.run) : null;
    const ref = rep ?? cold;
    summaries.push({
      fixture: m[0]!.fixture,
      category: m[0]!.category,
      profile: m[0]!.profile,
      cold,
      warmRuns: warmAll.length,
      warmFailed: warmAll.length - warm.length,
      idleFlagged: m.filter((x) => !x.idleOk).length,
      warm: agg,
      representativeTrace: repRun?.traceEvents?.length ? analyzeTrace(repRun.traceEvents, repRun.wallMs) : null,
      facts: {
        captureMode: ref?.captureMode ?? null,
        workers: ref?.workers ?? null,
        videoCodec: ref?.videoCodec ?? null,
        pixFmt: ref?.pixFmt ?? null,
        colorTransfer: ref?.colorTransfer ?? null,
        audioCodec: ref?.audioCodec ?? null,
        frames: ref?.frames ?? null,
      },
    });
  }

  const env = existsSync(join(outDir, "environment.json")) ? JSON.parse(readFileSync(join(outDir, "environment.json"), "utf8")) : null;
  const manifest = existsSync(join(outDir, "run-manifest.json")) ? JSON.parse(readFileSync(join(outDir, "run-manifest.json"), "utf8")) : null;

  writeFileSync(join(outDir, "runs.csv"), csv(metrics as unknown as Record<string, unknown>[]));
  writeFileSync(
    join(outDir, "summary.csv"),
    csv(
      summaries.map((s) => ({
        fixture: s.fixture,
        category: s.category,
        profile: s.profile,
        warmRuns: s.warmRuns,
        warmFailed: s.warmFailed,
        idleFlagged: s.idleFlagged,
        coldWallMs: s.cold?.wallMs,
        ...Object.fromEntries(
          AGG_KEYS.flatMap((k) => [
            [`${k}_median`, s.warm[k]?.median],
            [`${k}_p95`, s.warm[k]?.p95],
            [`${k}_cv`, s.warm[k]?.cv],
          ]),
        ),
        captureMode: s.facts.captureMode,
        workers: s.facts.workers,
      })),
    ),
  );
  writeFileSync(
    join(outDir, "summary.json"),
    JSON.stringify({ schema: "turbo-bench-summary/1", generatedAt: new Date().toISOString(), refusedRuns: refused, cells: summaries }, null, 2) + "\n",
  );

  const L: string[] = [];
  const up = env?.upstream;
  const host = env?.host;
  L.push(`# Baseline benchmark report`, "");
  L.push(`Generated by \`benchmarks/src/report.ts\` from \`raw/\`. Every number below is measured on the host described in \`environment.json\`; nothing is estimated.`, "");
  if (env) {
    L.push(`- Upstream: \`${up?.sha}\` (producer ${up?.producerVersion}, bun.lock sha256 \`${String(up?.lockfileSha256).slice(0, 16)}…\`)`);
    L.push(`- Chrome: ${env.toolchain?.chrome?.version} · Node ${env.toolchain?.node} · ${env.toolchain?.ffmpeg}`);
    L.push(`- Host: ${host?.cpu?.Name ?? host?.cpuModelNode}, ${(host?.ramBytes / 2 ** 30).toFixed(0)} GiB RAM, ${(host?.gpu ?? []).map((g: any) => `${g.name} (driver ${g.driver})`).join(", ")}, ${host?.os?.Caption} ${host?.os?.Version}`);
    L.push(`- Not tested: ${(env.notTested ?? []).join("; ")}`);
  }
  if (manifest) {
    L.push(`- Command: \`${manifest.command}\``);
    L.push(`- Window: ${manifest.startedAt} → ${manifest.finishedAt}; preflight idle ok=${manifest.preflight?.ok} (cpu ${fmt(manifest.preflight?.cpuBusyPct, 1)} %, gpu ${fmt(manifest.preflight?.gpuUtilPct, 1)} %)`);
  }
  L.push(`- Refused runs (host busy under --strict-idle): ${refused}`, "");
  L.push(`Warm columns are the median of the successful warm runs, with p95 and coefficient of variation (cv). Cold = first render in a fresh process with an empty extraction cache, reported separately.`, "");

  L.push(`## Wall time and throughput`, "");
  L.push(`| fixture | profile | mode | frames | cold s | warm median s | p95 s | cv % | fps | render× | warm ok/n | idle flags |`);
  L.push(`|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|`);
  for (const s of summaries) {
    const w = s.warm;
    L.push(`| ${s.fixture} | ${s.profile} | ${s.facts.captureMode ?? "—"} | ${s.facts.frames ?? "—"} | ${fmt((s.cold?.wallMs ?? NaN) / 1000, 2)} | ${fmt((w.wallMs?.median ?? NaN) / 1000, 2)} | ${fmt((w.wallMs?.p95 ?? NaN) / 1000, 2)} | ${fmt((w.wallMs?.cv ?? NaN) * 100, 1)} | ${fmt(w.fps?.median, 1)} | ${fmt(w.renderFactor?.median, 2)} | ${s.warmRuns - s.warmFailed}/${s.warmRuns} | ${s.idleFlagged} |`);
  }
  L.push("");

  L.push(`## Stage time (warm medians, ms) and critical path`, "");
  L.push(`Stage values are upstream \`perfSummary.stages\`. They overlap (streaming encode runs during capture), so they do not sum to wall time; the critical path comes from the trace sweep in \`trace-analysis.ts\` on the run closest to the warm median.`, "");
  L.push(`| fixture | profile | extract | capture | capture setup | capture frames | encode | concurrency× | untraced ms | critical path |`);
  L.push(`|---|---|---:|---:|---:|---:|---:|---:|---:|---|`);
  for (const s of summaries) {
    const w = s.warm;
    const t = s.representativeTrace;
    const cp = t ? t.criticalPath.filter((c) => c.ms >= 50).map((c) => `${c.phase} ${Math.round(c.ms)}`).join(" → ") : "—";
    L.push(`| ${s.fixture} | ${s.profile} | ${fmt(w.videoExtractMs?.median)} | ${fmt(w.captureMs?.median)} | ${fmt(w.captureSetupMs?.median)} | ${fmt(w.captureFrameMs?.median)} | ${fmt(w.encodeMs?.median)} | ${fmt(t?.concurrencyFactor, 2)} | ${fmt(t?.untracedMs)} | ${cp} |`);
  }
  L.push("");

  L.push(`## Readback, memory, GPU and IO (warm medians)`, "");
  L.push(`Readback = CDP response bytes of frame-producing calls (${READBACK_METHODS.join(", ")}), counted at the puppeteer connection. Capture RPC latency is per call, as seen by Node. Peak tree WS = summed working set of Node + Chrome + FFmpeg descendants.`, "");
  L.push(`| fixture | profile | readback MiB | per frame KiB | capture RPC p50/p95 ms | peak tree WS MiB | ΔVRAM MiB | CPU s | write MiB | tmp peak MiB | cache hit/miss | output MiB | bitrate Mb/s | codec |`);
  L.push(`|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|`);
  for (const s of summaries) {
    const w = s.warm;
    const perFrame = w.readbackBytes?.median != null && s.facts.frames ? w.readbackBytes.median / s.facts.frames / 1024 : null;
    const rep = s.cold;
    L.push(`| ${s.fixture} | ${s.profile} | ${mb(w.readbackBytes?.median)} | ${fmt(perFrame)} | ${fmt(w.captureRpcP50Ms?.median, 1)}/${fmt(w.captureRpcP95Ms?.median, 1)} | ${fmt(w.peakTreeWorkingSetMb?.median)} | ${fmt(w.peakVramDeltaMiB?.median)} | ${fmt(w.cpuSeconds?.median, 1)} | ${mb(w.ioWriteBytes?.median)} | ${mb(w.tmpPeakBytes?.median)} | ${rep ? `${fmt(rep.extractCacheHits)}/${fmt(rep.extractCacheMisses)} cold` : "—"} | ${mb(w.outputBytes?.median)} | ${fmt((w.outputBitRate?.median ?? NaN) / 1e6, 2)} | ${[s.facts.videoCodec, s.facts.pixFmt, s.facts.colorTransfer, s.facts.audioCodec].filter(Boolean).join(" ")} |`);
  }
  L.push("");
  L.push(`Warm-run extraction cache hits per cell are in \`runs.csv\` (\`extractCacheHits\`).`, "");
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
  return summaries;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = process.argv[2];
  if (!dir) throw new Error("usage: report.ts <results-dir>");
  writeReport(dir);
  console.log(`report written to ${join(dir, "report.md")}`);
}
