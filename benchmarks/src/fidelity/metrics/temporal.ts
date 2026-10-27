/**
 * Temporal integrity: which reference frame each candidate frame shows, and
 * whether the timestamps say what the frames are.
 *
 * Frame identity uses a 64x36 grayscale thumbnail of EVERY frame of both
 * outputs (not only sampled ones). Candidate frame i "matches" reference
 * frame j when their thumbnail MSE is <= tol (tol is calibrated per path; 0
 * on a bit-exact path). Walking the candidate with a running offset classifies:
 *   dropped    - cand i shows ref i+1 and the shift persists, cand shorter
 *   duplicated - cand i repeats ref i-1 and the shift persists, cand longer
 *   reordered  - cand i shows ref i+1 and cand i+1 shows ref i (swap), or
 *                any other out-of-place match within +/-3 frames
 *   stale      - cand i repeats ref i-1, then cand i+1 is back in sync
 * A frame that matches no nearby reference frame is a content mismatch and is
 * left to the pixel checks. Where consecutive reference frames are identical
 * (static holds) an event is undetectable by construction and is not claimed.
 */
import { ptsErrorTicks, ratToNumber, type Rational } from "../rational.js";
import type { VideoInfo } from "../probe.js";
import { thumbMse } from "./pixels.js";

export type TemporalEventKind = "dropped" | "duplicated" | "reordered" | "stale";

export interface TemporalEvent {
  kind: TemporalEventKind;
  /** Candidate frame index where the event was detected. */
  candidateIndex: number;
  /** Reference frame index the candidate frame actually shows. */
  showsReferenceIndex: number;
}

export interface TemporalAnalysis {
  referenceFrames: number;
  candidateFrames: number;
  events: TemporalEvent[];
  contentMismatchFrames: number;
  /** Largest same-index thumbnail MSE over frames that matched (calibration input). */
  maxMatchedThumbMse: number;
  /** Largest same-index thumbnail MSE over all common frames. */
  maxSameIndexThumbMse: number;
}

const WINDOW = 3;
const MAX_EVENTS = 50;

export function analyzeTemporal(ref: Buffer[], cand: Buffer[], tol: number): TemporalAnalysis {
  const n = ref.length;
  const m = cand.length;
  const match = (i: number, j: number) => i >= 0 && i < m && j >= 0 && j < n && thumbMse(cand[i]!, ref[j]!) <= tol;
  const events: TemporalEvent[] = [];
  let contentMismatch = 0;
  let maxMatched = 0;
  let maxSame = 0;
  for (let i = 0; i < Math.min(n, m); i++) {
    const d = thumbMse(cand[i]!, ref[i]!);
    if (d > maxSame) maxSame = d;
  }
  let off = 0; // candidate i corresponds to reference i + off
  for (let i = 0; i < m && events.length < MAX_EVENTS; i++) {
    const r = i + off;
    if (r >= n) {
      // Extra trailing candidate frames: duplicates of the last reference frame or unknown content.
      if (match(i, n - 1)) events.push({ kind: "duplicated", candidateIndex: i, showsReferenceIndex: n - 1 });
      else contentMismatch++;
      continue;
    }
    if (match(i, r)) {
      const d = thumbMse(cand[i]!, ref[r]!);
      if (d > maxMatched) maxMatched = d;
      continue;
    }
    if (match(i, r + 1) && match(i + 1, r)) {
      events.push({ kind: "reordered", candidateIndex: i, showsReferenceIndex: r + 1 });
      i++; // the swapped partner is part of the same event
      continue;
    }
    if (match(i, r + 1) && (match(i + 1, r + 2) || i + 1 >= m) && m < n) {
      events.push({ kind: "dropped", candidateIndex: i, showsReferenceIndex: r + 1 });
      off++;
      continue;
    }
    if (match(i, r - 1) && (match(i + 1, r) || i + 1 >= m) && m > n) {
      events.push({ kind: "duplicated", candidateIndex: i, showsReferenceIndex: r - 1 });
      off--;
      continue;
    }
    if (match(i, r - 1)) {
      events.push({ kind: "stale", candidateIndex: i, showsReferenceIndex: r - 1 });
      continue;
    }
    let found = -1;
    for (let j = r - WINDOW; j <= r + WINDOW; j++) if (j !== r && match(i, j)) found = found < 0 || Math.abs(j - r) < Math.abs(found - r) ? j : found;
    if (found >= 0) events.push({ kind: "reordered", candidateIndex: i, showsReferenceIndex: found });
    else contentMismatch++;
  }
  if (m < n && !events.some((e) => e.kind === "dropped")) {
    // Missing trailing frames.
    events.push({ kind: "dropped", candidateIndex: m, showsReferenceIndex: m + off });
  }
  return { referenceFrames: n, candidateFrames: m, events, contentMismatchFrames: contentMismatch, maxMatchedThumbMse: maxMatched, maxSameIndexThumbMse: maxSame };
}

export interface TimestampAnalysis {
  frames: number;
  timeBase: string;
  rFrameRate: string;
  avgFrameRate: string;
  /** Max |pts_i - i/fps| in ticks against the declared rational fps. */
  maxPtsErrorTicks: number | null;
  /** Index of the frame with the largest error. */
  maxPtsErrorFrame: number | null;
  nonMonotonicPts: number;
  missingPts: number;
  /** Packets whose DTS is greater than PTS (decode after display: invalid). */
  dtsGreaterThanPts: number;
  nonMonotonicDts: number;
  /** Distinct frame intervals (ticks) seen; >1 interval beyond +/-1 tick of rounding means VFR. */
  distinctIntervals: number;
  vfr: boolean;
  /** Seconds between first and last frame + one frame interval. */
  spanSec: number | null;
}

/** Timestamps of one stream against a declared rational fps (exact arithmetic). */
export function analyzeTimestamps(v: VideoInfo, fps: Rational): TimestampAnalysis {
  const pts = v.frames.map((f) => f.pts);
  const t0 = pts.find((p) => p !== null) ?? 0n;
  let maxErr: number | null = null;
  let maxErrFrame: number | null = null;
  let nonMono = 0;
  let missing = 0;
  let prev: bigint | null = null;
  const intervals: bigint[] = [];
  pts.forEach((p, i) => {
    if (p === null) {
      missing++;
      return;
    }
    const e = ptsErrorTicks(p - t0, i, fps, v.timeBase);
    if (maxErr === null || e > maxErr) {
      maxErr = e;
      maxErrFrame = i;
    }
    if (prev !== null) {
      if (p <= prev) nonMono++;
      else intervals.push(p - prev);
    }
    prev = p;
  });
  // Rounding of i/fps into an integer time base yields intervals that differ by 1 tick; that is CFR.
  const uniq = [...new Set(intervals.map(String))].map(BigInt).sort((a, b) => (a < b ? -1 : 1));
  const vfr = uniq.length > 0 && uniq[uniq.length - 1]! - uniq[0]! > 1n;
  let dtsGtPts = 0;
  let nonMonoDts = 0;
  let prevDts: bigint | null = null;
  for (const pk of v.packets) {
    if (pk.pts !== null && pk.dts !== null && pk.dts > pk.pts) dtsGtPts++;
    if (pk.dts !== null) {
      if (prevDts !== null && pk.dts <= prevDts) nonMonoDts++;
      prevDts = pk.dts;
    }
  }
  const last = [...pts].reverse().find((p) => p !== null);
  const tb = ratToNumber(v.timeBase);
  return {
    frames: pts.length,
    timeBase: `${v.timeBase.num}/${v.timeBase.den}`,
    rFrameRate: v.rFrameRate,
    avgFrameRate: v.avgFrameRate,
    maxPtsErrorTicks: maxErr,
    maxPtsErrorFrame: maxErrFrame,
    nonMonotonicPts: nonMono,
    missingPts: missing,
    dtsGreaterThanPts: dtsGtPts,
    nonMonotonicDts: nonMonoDts,
    distinctIntervals: uniq.length,
    vfr,
    spanSec: last !== undefined ? Number(last - t0) * tb + Number(fps.den) / Number(fps.num) : null,
  };
}
