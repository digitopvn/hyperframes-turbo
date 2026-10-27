/** Small, dependency-free descriptive statistics used by the report. */

export interface Distribution {
  n: number;
  min: number;
  max: number;
  mean: number;
  median: number;
  p95: number;
  /** Sample standard deviation (n-1). 0 when n < 2. */
  stdev: number;
  /** Coefficient of variation = stdev / mean. */
  cv: number;
  /** Median absolute deviation, scaled by nothing (raw MAD). */
  mad: number;
}

/** Nearest-rank percentile on a copy of `values` (q in [0,1]). */
export function percentile(values: number[], q: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(q * sorted.length)));
  return sorted[rank - 1]!;
}

export function median(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function describe(values: number[]): Distribution | null {
  const xs = values.filter((v) => Number.isFinite(v));
  if (xs.length === 0) return null;
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  const stdev = Math.sqrt(variance);
  const med = median(xs);
  return {
    n,
    min: Math.min(...xs),
    max: Math.max(...xs),
    mean,
    median: med,
    p95: percentile(xs, 0.95),
    stdev,
    cv: mean !== 0 ? stdev / mean : 0,
    mad: median(xs.map((x) => Math.abs(x - med))),
  };
}
