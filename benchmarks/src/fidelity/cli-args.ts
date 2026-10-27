/**
 * Validated command-line arguments for the fidelity CLIs. A malformed value
 * is a usage error (exit 2), never a silently coerced number: `Number("x")`
 * is NaN and `Number("")` is 0, and either would select the wrong run.
 */
export class UsageError extends Error {}

export interface Args {
  /** Value of `--key`, or undefined when absent. A flag followed by nothing or by another flag is a usage error. */
  get(key: string): string | undefined;
  /** Non-negative integer value of `--key`, or `fallback` when absent. */
  int(key: string, fallback?: number): number | undefined;
  /** Comma-separated non-negative integers of `--key` (at least one), or undefined when absent. */
  intList(key: string): number[] | undefined;
  /** Comma-separated non-empty names of `--key`, or undefined when absent. */
  list(key: string): string[] | undefined;
}

const NON_NEGATIVE_INT = /^\d+$/;

export function parseArgs(argv: string[]): Args {
  const get = (key: string): string | undefined => {
    const i = argv.indexOf(`--${key}`);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new UsageError(`--${key} needs a value`);
    return v;
  };
  const toInt = (key: string, v: string): number => {
    if (!NON_NEGATIVE_INT.test(v) || !Number.isSafeInteger(Number(v))) throw new UsageError(`--${key} must be a non-negative integer (got "${v}")`);
    return Number(v);
  };
  return {
    get,
    int(key, fallback) {
      const v = get(key);
      return v === undefined ? fallback : toInt(key, v);
    },
    intList(key) {
      const v = get(key);
      if (v === undefined) return undefined;
      const out = v.split(",").map((s) => toInt(key, s.trim()));
      if (new Set(out).size !== out.length) throw new UsageError(`--${key} lists a value twice`);
      return out;
    },
    list(key) {
      const v = get(key);
      if (v === undefined) return undefined;
      const out = v.split(",").map((s) => s.trim());
      if (out.some((s) => !s)) throw new UsageError(`--${key} has an empty entry`);
      return out;
    },
  };
}
