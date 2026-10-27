/**
 * Exact rational arithmetic (BigInt) for frame rates and timestamps, so
 * 30000/1001 never accumulates floating-point drift over long renders.
 */
export interface Rational {
  num: bigint;
  den: bigint;
}

function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) [a, b] = [b, a % b];
  return a;
}

export function rat(num: bigint | number, den: bigint | number = 1n): Rational {
  let n = BigInt(num);
  let d = BigInt(den);
  if (d === 0n) throw new Error("rational with zero denominator");
  if (d < 0n) [n, d] = [-n, -d];
  const g = gcd(n, d) || 1n;
  return { num: n / g, den: d / g };
}

/**
 * Parse "30000/1001", "30/1", "30" or an integer number. Decimals are
 * rejected: 29.97 is not 30000/1001 and guessing would hide a real mismatch.
 */
export function parseRational(input: string | number): Rational {
  if (typeof input === "number") {
    if (!Number.isInteger(input)) throw new Error(`non-integer rate ${input}; spell rationals as "num/den"`);
    return rat(input);
  }
  const m = /^\s*(-?\d+)\s*(?:\/\s*(\d+))?\s*$/.exec(input);
  if (!m) throw new Error(`not a rational: ${JSON.stringify(input)}`);
  return rat(BigInt(m[1]!), BigInt(m[2] ?? "1"));
}

export const ratEq = (a: Rational, b: Rational): boolean => a.num === b.num && a.den === b.den;
export const ratToString = (r: Rational): string => `${r.num}/${r.den}`;
export const ratToNumber = (r: Rational): number => Number(r.num) / Number(r.den);
export const ratMul = (a: Rational, b: Rational): Rational => rat(a.num * b.num, a.den * b.den);
export const ratDiv = (a: Rational, b: Rational): Rational => rat(a.num * b.den, a.den * b.num);
export const ratSub = (a: Rational, b: Rational): Rational => rat(a.num * b.den - b.num * a.den, a.den * b.den);

/** Ideal presentation time of frame `index` at `fps`, in seconds (exact). */
export function frameTime(index: number, fps: Rational): Rational {
  return rat(BigInt(index) * fps.den, fps.num);
}

/** Ideal presentation time of frame `index` in ticks of `timeBase` (exact rational ticks). */
export function frameTicks(index: number, fps: Rational, timeBase: Rational): Rational {
  return ratDiv(frameTime(index, fps), timeBase);
}

/** |pts - ideal| in ticks for frame `index`; pts is an integer tick count. */
export function ptsErrorTicks(pts: bigint, index: number, fps: Rational, timeBase: Rational): number {
  const err = ratSub(rat(pts), frameTicks(index, fps, timeBase));
  return Math.abs(ratToNumber(err));
}

/** First frame whose ideal start time is >= `seconds` (seconds given as a decimal with ms precision). */
export function frameAtOrAfter(seconds: number, fps: Rational): number {
  const t = rat(Math.round(seconds * 1000), 1000);
  const f = ratMul(t, fps); // frames, exact
  return Number((f.num + f.den - 1n) / f.den);
}
