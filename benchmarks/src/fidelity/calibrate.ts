/**
 * Calibrate per-path fidelity thresholds from >= 5 repeated reference renders.
 *
 *   calibrate.ts --results <dir> [--cell producer-default] [--runs 1,2,3,4,5]
 *                [--path producer-default.<platform>] [--fixtures a,b]
 *
 * Inputs are the outputs kept by `run-benchmark.ts --keep-output`. Every pair
 * of the selected (warm) runs is measured with the same code the gate uses;
 * the raw per-pair data is written to fidelity/calibration/<path>.pairs.json
 * (committed, including unfavourable pairs) and the derived limits to
 * fidelity/thresholds/<path>.json. Cold-vs-warm pairs are measured and kept
 * separately for information; they never feed the limits.
 *
 * A fixture whose reference renders disagree on a hard invariant (frame
 * count, geometry, codec, timestamps) gets no thresholds at all, so the gate
 * then fails closed with THRESHOLD_MISSING for it.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { audioFrameMs, measure, type Measurements } from "./compare.js";
import { ANALYSIS_RATE } from "./metrics/audio.js";
import { probeMedia } from "./probe.js";
import { keptOutput } from "./run-fidelity.js";
import { fixtureContext, repoRelative, toJson, toolVersion } from "./schema.js";
import { CALIBRATION_DIR, deriveLimit, MIN_RUNS, pathName, THRESHOLDS_DIR, THRESHOLDS_SCHEMA, thresholdFileFor, type FixtureThresholds, type ThresholdFile } from "./thresholds.js";

export interface PairObservation {
  a: number;
  b: number;
  frames: [number, number];
  maxMse: number;
  minSsim: number;
  maxAbsDiff: number;
  maxDiffPixelPct: number;
  maxAlphaMse: number | null;
  maxThumbMse: number;
  avDriftMs: number | null;
  durationDeltaMs: number | null;
  residualDb: number | null;
  encodedPsnrMinDb: number | null;
  encodedSsimMin: number | null;
  vmafMin: number | null;
  bitrateDropPct: number | null;
  invariantProblems: string[];
  errors: Measurements["errors"];
  /** Sampled frames: [index, mse, ssim, maxAbsDiff]. */
  perFrame: Array<[number, number, number, number]>;
}

export function observe(a: number, b: number, m: Measurements): PairObservation {
  const px = m.pixels?.frames ?? [];
  const problems: string[] = [];
  const r = m.reference;
  const c = m.candidate;
  if (!r || !c) problems.push("probe failed");
  else {
    if (r.frames !== c.frames) problems.push(`frame count ${r.frames} vs ${c.frames}`);
    if (r.width !== c.width || r.height !== c.height || r.codec !== c.codec || r.pixFmt !== c.pixFmt) problems.push("geometry/codec differs");
    if (r.rFrameRate !== c.rFrameRate) problems.push(`r_frame_rate ${r.rFrameRate} vs ${c.rFrameRate}`);
    if (JSON.stringify(r.audio) !== JSON.stringify(c.audio)) problems.push("audio stream format differs");
  }
  if (m.timestamps && m.timestamps.reference.maxPtsErrorTicks !== m.timestamps.candidate.maxPtsErrorTicks) problems.push("timestamps differ");
  for (const [k, v] of Object.entries(m.errors)) problems.push(`${k}: ${v}`);
  let maxThumb = 0;
  if (m.thumbs) {
    const n = Math.min(m.thumbs.reference.length, m.thumbs.candidate.length);
    for (let i = 0; i < n; i++) {
      const x = m.thumbs.reference[i]!;
      const y = m.thumbs.candidate[i]!;
      let se = 0;
      for (let k = 0; k < x.length; k++) se += (x[k]! - y[k]!) ** 2;
      maxThumb = Math.max(maxThumb, se / x.length);
    }
  }
  const alpha = px.map((f) => f.alphaMse).filter((v): v is number => v !== null);
  return {
    a,
    b,
    frames: [r?.frames ?? 0, c?.frames ?? 0],
    maxMse: Math.max(0, ...px.map((f) => f.mse)),
    minSsim: Math.min(1, ...px.map((f) => f.ssim)),
    maxAbsDiff: Math.max(0, ...px.map((f) => f.maxAbsDiff)),
    maxDiffPixelPct: Math.max(0, ...px.map((f) => f.diffPixelPct)),
    maxAlphaMse: alpha.length ? Math.max(...alpha) : null,
    maxThumbMse: maxThumb,
    avDriftMs: m.audio?.avDriftMs ?? null,
    durationDeltaMs: m.audio?.durationDeltaMs ?? null,
    residualDb: m.audio?.residualDb ?? null,
    encodedPsnrMinDb: m.encoded?.psnrMinDb ?? null,
    encodedSsimMin: m.encoded?.ssimMin ?? null,
    vmafMin: m.encoded?.vmaf?.min ?? null,
    bitrateDropPct: m.encoded?.bitRateDeltaPct === null || m.encoded?.bitRateDeltaPct === undefined ? null : -m.encoded.bitRateDeltaPct,
    invariantProblems: problems,
    errors: m.errors,
    perFrame: px.map((f) => [f.index, f.mse, f.ssim, f.maxAbsDiff]),
  };
}

const vals = (obs: PairObservation[], k: keyof PairObservation): number[] => obs.map((o) => o[k]).filter((v): v is number => typeof v === "number");

/** Derive one fixture's thresholds from its warm pairs; null when the references disagree on an invariant. */
export function deriveFixtureThresholds(runs: number, obs: PairObservation[], audio: { codec: string; sampleRate: number } | null): FixtureThresholds | null {
  if (obs.length === 0 || obs.some((o) => o.invariantProblems.length)) return null;
  const alpha = vals(obs, "maxAlphaMse");
  const vmaf = vals(obs, "vmafMin");
  const floorMs = audio ? audioFrameMs(audio.codec, audio.sampleRate) : 0;
  const psnr = vals(obs, "encodedPsnrMinDb");
  const encSsim = vals(obs, "encodedSsimMin");
  const drop = vals(obs, "bitrateDropPct");
  if (psnr.length !== obs.length || encSsim.length !== obs.length || drop.length !== obs.length) return null;
  return {
    runs,
    pairs: obs.length,
    bitExact: obs.every((o) => o.maxMse === 0 && o.maxThumbMse === 0 && o.encodedPsnrMinDb === Infinity),
    pixels: {
      maxMse: deriveLimit(vals(obs, "maxMse"), "max", 0.01),
      minSsim: deriveLimit(vals(obs, "minSsim"), "min", 1e-5),
      maxAbsDiff: deriveLimit(vals(obs, "maxAbsDiff"), "max", 1),
      maxDiffPixelPct: deriveLimit(vals(obs, "maxDiffPixelPct"), "max", 0.001),
      maxAlphaMse: alpha.length === obs.length ? deriveLimit(alpha, "max", 0.01) : null,
    },
    temporal: { thumbMseTol: deriveLimit(vals(obs, "maxThumbMse"), "max", 0.01) },
    audio: audio
      ? {
          maxAvDriftMs: deriveLimit(vals(obs, "avDriftMs"), "max", 1000 / ANALYSIS_RATE, floorMs),
          maxDurationDeltaMs: deriveLimit(vals(obs, "durationDeltaMs"), "max", 1000 / ANALYSIS_RATE, floorMs),
          maxResidualDb: deriveLimit(obs.map((o) => o.residualDb ?? -Infinity), "max", 0.1),
        }
      : null,
    encoded: {
      minPsnrDb: deriveLimit(psnr, "min", 0.01),
      minSsim: deriveLimit(encSsim, "min", 1e-5),
      minVmaf: vmaf.length === obs.length ? deriveLimit(vmaf, "min", 0.01) : null,
      maxBitrateDropPct: deriveLimit(drop, "max", 0.1),
    },
  };
}

function pairsOf(runs: number[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < runs.length; i++) for (let j = i + 1; j < runs.length; j++) out.push([runs[i]!, runs[j]!]);
  return out;
}

async function measurePairs(results: string, fixture: string, cell: string, pairs: Array<[number, number]>): Promise<PairObservation[]> {
  const { ctx } = fixtureContext(fixture);
  const out: PairObservation[] = [];
  const queue = [...pairs];
  const worker = async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      const [a, b] = p;
      const ra = keptOutput(results, fixture, cell, a);
      const rb = keptOutput(results, fixture, cell, b);
      if (!ra || !rb) throw new Error(`${fixture}/${cell}: missing kept output for run ${ra ? b : a}`);
      const m = await measure({ path: ra }, { path: rb }, ctx);
      out.push(observe(a, b, m));
      console.error(`[calibrate] ${fixture} ${a}-${b}: mse ${out.at(-1)!.maxMse.toFixed(4)} thumb ${out.at(-1)!.maxThumbMse.toFixed(4)}${out.at(-1)!.invariantProblems.length ? ` PROBLEMS ${out.at(-1)!.invariantProblems.join("; ")}` : ""}`);
    }
  };
  await Promise.all([worker(), worker()]);
  return out.sort((x, y) => x.a - y.a || x.b - y.b);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (k: string) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const resultsArg = get("results");
  if (!resultsArg) throw new Error("usage: calibrate.ts --results <dir> [--cell c] [--runs 1,2,3,4,5] [--path p] [--fixtures a,b]");
  const results = resolve(resultsArg);
  const cell = get("cell") ?? "producer-default";
  const path = get("path") ?? pathName(cell.replace(/\.control$/, ""));
  const fixtures = get("fixtures")?.split(",") ?? readdirSync(join(results, "outputs")).sort();
  const runsArg = get("runs")?.split(",").map(Number);
  const env = existsSync(join(results, "environment.json")) ? JSON.parse(readFileSync(join(results, "environment.json"), "utf8")) : null;
  const thresholds: ThresholdFile = {
    schema: THRESHOLDS_SCHEMA,
    path,
    calibration: {
      runs: [],
      createdAt: new Date().toISOString(),
      host: env?.host?.cpu?.Name ?? env?.host?.cpuModelNode ?? hostname(),
      platform: process.platform,
      upstreamSha: env?.upstream?.sha ?? null,
      ffmpeg: await toolVersion(),
      resultsDir: repoRelative(results),
      cell,
      rawPairsFile: repoRelative(join(CALIBRATION_DIR, `${path}.pairs.json`)),
      command: `calibrate.ts ${argv.join(" ")}`,
    },
    fixtures: {},
  };
  const raw: Record<string, { runs: number[]; warmPairs: PairObservation[]; coldPairs: PairObservation[]; thresholds: "written" | string }> = {};
  for (const fixture of fixtures) {
    const dir = join(results, "outputs", fixture, cell);
    const available = existsSync(dir) ? readdirSync(dir).map((n) => /^run-(\d+)\./.exec(n)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b) : [];
    const warm = (runsArg ?? available.filter((r) => r > 0)).filter((r) => available.includes(r));
    if (warm.length < MIN_RUNS) {
      raw[fixture] = { runs: warm, warmPairs: [], coldPairs: [], thresholds: `skipped: ${warm.length} warm runs < ${MIN_RUNS}` };
      console.error(`[calibrate] ${fixture}: only ${warm.length} warm outputs; no thresholds`);
      continue;
    }
    const warmPairs = await measurePairs(results, fixture, cell, pairsOf(warm));
    const coldPairs = available.includes(0) ? await measurePairs(results, fixture, cell, warm.map((w) => [0, w] as [number, number])) : [];
    const p = await probeMedia({ path: keptOutput(results, fixture, cell, warm[0]!)! });
    const t = deriveFixtureThresholds(warm.length, warmPairs, p.audio ? { codec: p.audio.codec, sampleRate: p.audio.sampleRate } : null);
    if (t) {
      thresholds.fixtures[fixture] = t;
      thresholds.calibration.runs = warm;
    }
    raw[fixture] = { runs: warm, warmPairs, coldPairs, thresholds: t ? "written" : "withheld: reference renders disagree on a hard invariant or a measurement failed (see invariantProblems)" };
    console.error(`[calibrate] ${fixture}: ${t ? (t.bitExact ? "bit-exact" : "non-deterministic, worst+margin") : "NO THRESHOLDS"}`);
  }
  mkdirSync(THRESHOLDS_DIR, { recursive: true });
  mkdirSync(CALIBRATION_DIR, { recursive: true });
  writeFileSync(join(CALIBRATION_DIR, `${path}.pairs.json`), toJson({ schema: "turbo-fidelity-calibration-pairs/1", path, calibration: thresholds.calibration, fixtures: raw }));
  writeFileSync(thresholdFileFor(path), toJson(thresholds));
  console.error(`[calibrate] wrote ${thresholdFileFor(path)} (${Object.keys(thresholds.fixtures).length}/${fixtures.length} fixtures)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
