/**
 * Fail-closed verdicts. A check is PASS only when it was measured and is
 * within its calibrated limit. Anything it could not establish is FALLBACK
 * (optional capability missing) or FAIL (error, missing threshold, violated
 * invariant); never PASS.
 */
export type Verdict = "PASS" | "FALLBACK" | "FAIL";
export type CheckVerdict = Verdict | "NOT_APPLICABLE";

/** Stable reason codes (also the vocabulary of the fault-injection tests). */
export const REASONS = [
  "FRAME_COUNT_MISMATCH",
  "FRAME_DROPPED",
  "FRAME_DUPLICATED",
  "FRAME_REORDERED",
  "STALE_FRAME",
  "PTS_DRIFT",
  "PTS_NON_MONOTONIC",
  "DTS_INVALID",
  "VFR_DETECTED",
  "FPS_CHANGED",
  "DIMENSION_CHANGED",
  "CODEC_CHANGED",
  "PIXEL_BELOW_THRESHOLD",
  "AUDIO_MISSING",
  "AUDIO_UNEXPECTED",
  "AUDIO_FORMAT_CHANGED",
  "AUDIO_DURATION_MISMATCH",
  "AUDIO_MISMATCH",
  "AV_DRIFT",
  "ALPHA_MISSING",
  "ALPHA_MISMATCH",
  "HDR_TRANSFER_MISMATCH",
  "HDR_METADATA_MISMATCH",
  "COLOR_METADATA_CHANGED",
  "ENCODED_QUALITY_BELOW_THRESHOLD",
  "BITRATE_DROP",
  "REFERENCE_INVALID",
  "THRESHOLD_MISSING",
  "TOOL_UNAVAILABLE",
  "CHECK_ERROR",
  "DISABLED",
] as const;
export type Reason = (typeof REASONS)[number];

export interface CheckResult<D = Record<string, unknown>> {
  verdict: CheckVerdict;
  reasons: Reason[];
  /** Human-readable explanation per reason (same order as `reasons`). */
  notes: string[];
  details: D;
}

export function check<D>(details: D): CheckResult<D> & { fail(r: Reason, note: string): void; fallback(r: Reason, note: string): void } {
  const c = {
    verdict: "PASS" as CheckVerdict,
    reasons: [] as Reason[],
    notes: [] as string[],
    details,
    fail(r: Reason, note: string) {
      c.verdict = "FAIL";
      c.reasons.push(r);
      c.notes.push(note);
    },
    fallback(r: Reason, note: string) {
      if (c.verdict !== "FAIL") c.verdict = "FALLBACK";
      c.reasons.push(r);
      c.notes.push(note);
    },
  };
  return c;
}

/** Strip the helper methods before serialising. */
export function done<D>(c: CheckResult<D>): CheckResult<D> {
  return { verdict: c.verdict, reasons: c.reasons, notes: c.notes, details: c.details };
}

export const notApplicable = <D>(details: D, note: string): CheckResult<D> => ({ verdict: "NOT_APPLICABLE", reasons: [], notes: [note], details });

/** FAIL if any FAIL; else FALLBACK if any FALLBACK; else PASS. An empty set is FAIL (nothing was verified). */
export function aggregate(verdicts: CheckVerdict[]): Verdict {
  const real = verdicts.filter((v) => v !== "NOT_APPLICABLE");
  if (real.length === 0) return "FAIL";
  if (real.includes("FAIL")) return "FAIL";
  if (real.includes("FALLBACK")) return "FALLBACK";
  return "PASS";
}

/** CLI exit codes. 2 is reserved for usage errors (bad arguments), never for a gate outcome. */
export const EXIT_CODE: Record<Verdict, number> = { PASS: 0, FAIL: 1, FALLBACK: 3 };
export const EXIT_USAGE = 2;
