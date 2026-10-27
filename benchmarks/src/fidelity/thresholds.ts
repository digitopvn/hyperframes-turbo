/**
 * Per-path thresholds calibrated from repeated reference renders.
 *
 * There is no universal cutoff. A path is `<profile>.<platform>` (renderer
 * configuration + OS image); each fixture on that path gets limits derived
 * from all pairwise comparisons of >= MIN_RUNS reference renders:
 *   - zero spread across pairs (deterministic): limit = the observed value
 *     exactly (bit-exact paths therefore demand bit-exact candidates);
 *   - otherwise: limit = worst observed -/+ max(3 * MAD, metric resolution).
 * A/V drift and audio duration additionally get a floor of one audio codec
 * frame, the granularity at which an encoder can place audio at all.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BENCH_ROOT } from "../fixtures.js";

export const THRESHOLDS_SCHEMA = "turbo-fidelity-thresholds/1";
export const MIN_RUNS = 5;
export const THRESHOLDS_DIR = join(BENCH_ROOT, "fidelity", "thresholds");
export const CALIBRATION_DIR = join(BENCH_ROOT, "fidelity", "calibration");

/** A limit; "inf"/"-inf" stand for the infinities JSON cannot carry (e.g. PSNR of identical frames). */
export type LimitValue = number | "inf" | "-inf";

export interface Limit {
  limit: LimitValue;
  /** Worst value observed over the calibration pairs. */
  worst: LimitValue;
  /** Median absolute deviation over the finite observations. */
  mad: number;
  margin: number;
  /** "exact" (zero spread), "worst+margin", or "floor" (codec-granularity floor applied). */
  rule: "exact" | "worst+margin" | "floor";
  n: number;
}

export interface FixtureThresholds {
  runs: number;
  pairs: number;
  /** Every calibration pair was bit-exact on every sampled frame and on every frame thumbnail. */
  bitExact: boolean;
  pixels: { maxMse: Limit; minSsim: Limit; maxAbsDiff: Limit; maxDiffPixelPct: Limit; maxAlphaMse: Limit | null };
  temporal: { thumbMseTol: Limit };
  audio: { maxAvDriftMs: Limit; maxDurationDeltaMs: Limit; maxResidualDb: Limit } | null;
  encoded: { minPsnrDb: Limit; minSsim: Limit; minVmaf: Limit | null; maxBitrateDropPct: Limit };
}

export interface ThresholdFile {
  schema: typeof THRESHOLDS_SCHEMA;
  path: string;
  calibration: {
    runs: number[];
    createdAt: string;
    host: string;
    platform: string;
    upstreamSha: string | null;
    ffmpeg: string | null;
    resultsDir: string;
    cell: string;
    rawPairsFile: string;
    command: string;
  };
  fixtures: Record<string, FixtureThresholds>;
}

export const toNum = (v: LimitValue): number => (v === "inf" ? Infinity : v === "-inf" ? -Infinity : v);
export const fromNum = (v: number): LimitValue => (v === Infinity ? "inf" : v === -Infinity ? "-inf" : v);

const median = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/**
 * Derive a limit from calibration observations.
 * direction "max": lower is better (limit is an upper bound); "min": higher is better.
 */
export function deriveLimit(values: number[], direction: "max" | "min", resolution: number, floor?: number): Limit {
  if (values.length === 0) throw new Error("no calibration observations");
  if (values.some((v) => Number.isNaN(v))) throw new Error("NaN calibration observation");
  const worst = direction === "max" ? Math.max(...values) : Math.min(...values);
  const best = direction === "max" ? Math.min(...values) : Math.max(...values);
  const finite = values.filter(Number.isFinite);
  const med = finite.length ? median(finite) : 0;
  const mad = finite.length ? median(finite.map((v) => Math.abs(v - med))) : 0;
  let limit: number;
  let margin = 0;
  let rule: Limit["rule"];
  if (worst === best) {
    limit = worst;
    rule = "exact";
  } else {
    margin = Math.max(3 * mad, resolution);
    limit = direction === "max" ? worst + margin : worst - margin;
    rule = "worst+margin";
  }
  if (floor !== undefined && direction === "max" && !(limit >= floor)) {
    limit = floor;
    rule = "floor";
  }
  return { limit: fromNum(limit), worst: fromNum(worst), mad, margin, rule, n: values.length };
}

/** Within limit? NaN or missing measurements are never within. */
export function within(value: number | null | undefined, l: Limit, direction: "max" | "min"): boolean {
  if (value === null || value === undefined || Number.isNaN(value)) return false;
  const lim = toNum(l.limit);
  return direction === "max" ? value <= lim : value >= lim;
}

export function pathName(profile: string, platform: string = process.platform): string {
  return `${profile}.${platform}`;
}

export function thresholdFileFor(path: string): string {
  return join(THRESHOLDS_DIR, `${path}.json`);
}

function isLimit(x: unknown): x is Limit {
  if (!x || typeof x !== "object") return false;
  const l = x as Record<string, unknown>;
  const ok = (v: unknown) => typeof v === "number" || v === "inf" || v === "-inf";
  return ok(l.limit) && ok(l.worst) && typeof l.n === "number" && typeof l.rule === "string";
}

/** Validate a parsed threshold file; returns a list of problems (empty = valid). */
export function validateThresholds(t: unknown, expectedPath: string): string[] {
  const p: string[] = [];
  if (!t || typeof t !== "object") return ["not an object"];
  const f = t as Partial<ThresholdFile>;
  if (f.schema !== THRESHOLDS_SCHEMA) p.push(`schema is ${String(f.schema)}, expected ${THRESHOLDS_SCHEMA}`);
  if (f.path !== expectedPath) p.push(`path is ${String(f.path)}, expected ${expectedPath}`);
  if (!f.calibration || !Array.isArray(f.calibration.runs) || f.calibration.runs.length < MIN_RUNS) p.push(`calibration needs >= ${MIN_RUNS} reference runs`);
  if (!f.fixtures || typeof f.fixtures !== "object") return [...p, "no fixtures"];
  for (const [id, fx] of Object.entries(f.fixtures)) {
    if (fx.runs < MIN_RUNS) p.push(`${id}: ${fx.runs} runs < ${MIN_RUNS}`);
    if (fx.pairs !== (fx.runs * (fx.runs - 1)) / 2) p.push(`${id}: ${fx.pairs} pairs for ${fx.runs} runs`);
    const limits = [
      fx.pixels?.maxMse,
      fx.pixels?.minSsim,
      fx.pixels?.maxAbsDiff,
      fx.pixels?.maxDiffPixelPct,
      fx.temporal?.thumbMseTol,
      fx.encoded?.minPsnrDb,
      fx.encoded?.minSsim,
      fx.encoded?.maxBitrateDropPct,
    ];
    if (!limits.every(isLimit)) p.push(`${id}: malformed limit`);
    if (fx.audio && ![fx.audio.maxAvDriftMs, fx.audio.maxDurationDeltaMs, fx.audio.maxResidualDb].every(isLimit)) p.push(`${id}: malformed audio limit`);
  }
  return p;
}

export interface LoadedThresholds {
  file: string;
  sha256: string;
  data: ThresholdFile;
}

/** Load and validate; returns the problem instead of throwing so the caller can fail closed with THRESHOLD_MISSING. */
export function loadThresholds(path: string, file = thresholdFileFor(path)): LoadedThresholds | { error: string; file: string } {
  if (!existsSync(file)) return { error: `no threshold file for path ${path}`, file };
  const raw = readFileSync(file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch (err) {
    return { error: `unparseable threshold file: ${(err as Error).message}`, file };
  }
  const problems = validateThresholds(parsed, path);
  if (problems.length) return { error: `invalid threshold file: ${problems.join("; ")}`, file };
  return { file, sha256: createHash("sha256").update(raw).digest("hex"), data: parsed as ThresholdFile };
}
