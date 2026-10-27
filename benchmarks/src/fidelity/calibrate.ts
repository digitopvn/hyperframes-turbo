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
 *
 * Cross-reference calibration (`--against-cell <c2> --path <p>`): the pairs
 * are every (run of --cell, run of --against-cell), two cells that are both
 * accepted Chromium reference configurations. The limits then describe how
 * far two correct references are allowed to differ, which is the tolerance a
 * candidate backend is held to (docs/fidelity-protocol.md, *Candidate
 * tolerances*). The candidate itself never feeds its own limits.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, UsageError } from "./cli-args.js";
import { audioFrameMs, measure, type Measurements } from "./compare.js";
import { ANALYSIS_RATE } from "./metrics/audio.js";
import { probeMedia } from "./probe.js";
import { keptOutput } from "./run-fidelity.js";
import { fixtureContext, repoRelative, toJson, toolVersion } from "./schema.js";
import { baseCell, CALIBRATION_DIR, deriveLimit, isReferenceCell, referenceCells, MIN_RUNS, pathName, THRESHOLDS_DIR, THRESHOLDS_SCHEMA, thresholdFileFor, type FixtureThresholds, type ThresholdFile } from "./thresholds.js";

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

/**
 * Derive one fixture's thresholds from its warm pairs; null when the references
 * disagree on an invariant. `againstRuns` marks a cross-reference calibration
 * (pairs = runs x againstRuns between two accepted reference cells).
 */
export function deriveFixtureThresholds(runs: number, obs: PairObservation[], audio: { codec: string; sampleRate: number } | null, againstRuns?: number): FixtureThresholds | null {
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
    ...(againstRuns !== undefined ? { againstRuns } : {}),
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

/** Every (run of cell A, run of cell B) pair: the cross-reference calibration set. */
export function crossPairsOf(a: number[], b: number[]): Array<[number, number]> {
  return a.flatMap((x) => b.map((y) => [x, y] as [number, number]));
}

async function measurePairs(results: string, fixture: string, cells: [string, string], pairs: Array<[number, number]>): Promise<PairObservation[]> {
  const { ctx } = fixtureContext(fixture);
  const out: PairObservation[] = [];
  const queue = [...pairs];
  const worker = async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      const [a, b] = p;
      const ra = keptOutput(results, fixture, cells[0], a);
      const rb = keptOutput(results, fixture, cells[1], b);
      if (!ra || !rb) throw new Error(`${fixture}: missing kept output for ${ra ? `${cells[1]} run ${b}` : `${cells[0]} run ${a}`}`);
      const m = await measure({ path: ra }, { path: rb }, ctx);
      out.push(observe(a, b, m));
      console.error(`[calibrate] ${fixture} ${a}-${b}: mse ${out.at(-1)!.maxMse.toFixed(4)} thumb ${out.at(-1)!.maxThumbMse.toFixed(4)}${out.at(-1)!.invariantProblems.length ? ` PROBLEMS ${out.at(-1)!.invariantProblems.join("; ")}` : ""}`);
    }
  };
  await Promise.all([worker(), worker()]);
  return out.sort((x, y) => x.a - y.a || x.b - y.b);
}

/** Warm runs of `cell` with a kept output, optionally restricted to `wanted`. */
function warmRuns(results: string, fixture: string, cell: string, wanted: number[] | undefined): { available: number[]; warm: number[] } {
  const dir = join(results, "outputs", fixture, cell);
  const available = existsSync(dir) ? readdirSync(dir).map((n) => /^run-(\d+)\./.exec(n)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b) : [];
  return { available, warm: (wanted ?? available.filter((r) => r > 0)).filter((r) => available.includes(r)) };
}

const USAGE = "usage: calibrate.ts --results <dir> [--cell c] [--runs 1,2,3,4,5] [--path p] [--fixtures a,b] [--against-cell c2 --path p [--against-runs 1,2,3,4,5]]";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const resultsArg = args.get("results");
  if (!resultsArg) throw new UsageError(USAGE);
  const results = resolve(resultsArg);
  const cell = args.get("cell") ?? "producer-default";
  const against = args.get("against-cell");
  // A cross-reference file is a deliberate, named tolerance set: no default path.
  if (against && !args.get("path")) throw new UsageError(`--against-cell needs an explicit --path. ${USAGE}`);
  for (const c of [cell, ...(against ? [against] : [])]) if (!isReferenceCell(c)) throw new UsageError(`${c} is not an accepted reference cell (benchmarks/fidelity/reference-cells.json: ${referenceCells().join(", ")}); a candidate never calibrates its own limits`);
  if (against && baseCell(against) === baseCell(cell)) throw new UsageError("--against-cell must differ from --cell (a .control alias is the same cell)");
  const path = args.get("path") ?? pathName(cell.replace(/\.control$/, ""));
  const fixtures = args.list("fixtures") ?? readdirSync(join(results, "outputs")).sort();
  const runsArg = args.intList("runs");
  const againstRunsArg = args.intList("against-runs");
  if (!against && againstRunsArg) throw new UsageError("--against-runs needs --against-cell");
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
      ...(against ? { kind: "cross-reference" as const, againstCell: against, againstRuns: [] } : { kind: "repeat" as const }),
    },
    fixtures: {},
  };
  const raw: Record<string, { runs: number[]; againstRuns?: number[]; warmPairs: PairObservation[]; coldPairs: PairObservation[]; thresholds: "written" | string }> = {};
  for (const fixture of fixtures) {
    const { available, warm } = warmRuns(results, fixture, cell, runsArg);
    const other = against ? warmRuns(results, fixture, against, againstRunsArg).warm : null;
    if (warm.length < MIN_RUNS || (other && other.length < MIN_RUNS)) {
      const why = `skipped: ${warm.length} warm runs of ${cell}${other ? ` and ${other.length} of ${against}` : ""} (need >= ${MIN_RUNS} each)`;
      raw[fixture] = { runs: warm, ...(other ? { againstRuns: other } : {}), warmPairs: [], coldPairs: [], thresholds: why };
      console.error(`[calibrate] ${fixture}: ${why}; no thresholds`);
      continue;
    }
    // Repeat: every pair of one reference cell. Cross-reference: every pair of
    // (reference cell run, second accepted reference cell run); cold runs never feed either.
    const warmPairs = other ? await measurePairs(results, fixture, [cell, against!], crossPairsOf(warm, other)) : await measurePairs(results, fixture, [cell, cell], pairsOf(warm));
    const coldPairs = !other && available.includes(0) ? await measurePairs(results, fixture, [cell, cell], warm.map((w) => [0, w] as [number, number])) : [];
    const p = await probeMedia({ path: keptOutput(results, fixture, cell, warm[0]!)! });
    const t = deriveFixtureThresholds(warm.length, warmPairs, p.audio ? { codec: p.audio.codec, sampleRate: p.audio.sampleRate } : null, other?.length);
    if (t) {
      thresholds.fixtures[fixture] = t;
      thresholds.calibration.runs = warm;
      if (other && thresholds.calibration.kind === "cross-reference") thresholds.calibration.againstRuns = other;
    }
    raw[fixture] = {
      runs: warm,
      ...(other ? { againstRuns: other } : {}),
      warmPairs,
      coldPairs,
      thresholds: t ? "written" : `withheld: ${other ? "the two references" : "reference renders"} disagree on a hard invariant or a measurement failed (see invariantProblems)`,
    };
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
      console.error(err instanceof UsageError ? `[calibrate] usage: ${err.message}` : err);
      process.exit(err instanceof UsageError ? 2 : 1);
    },
  );
}
