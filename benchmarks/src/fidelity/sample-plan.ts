/**
 * Deterministic choice of the frames that get a full-frame pixel comparison.
 *
 * Every fixture gets frame 0, the last frame and RANDOM_FRAMES seeded random
 * frames (seed = SHA-256 of fixture source hash + settings, so every backend
 * and every run compares the same set). On top of that:
 * - cuts: the frame before / at / after every clip boundary, derived from the
 *   fixture HTML's data-start / data-duration attributes;
 * - probes from fidelity-manifest.json: transitions (first/middle/last),
 *   opacity boundaries, rapid motion, filter-heavy frames, motion-blur
 *   neighbours (t-1, t, t+1) and static holds (first, last, first after).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BENCH_ROOT } from "../fixtures.js";
import { frameAtOrAfter, type Rational } from "./rational.js";

export const RANDOM_FRAMES = 8;

export type ProbeKind = "rapid-motion" | "filter-heavy" | "opacity-boundary" | "motion-blur" | "transition" | "static-hold";

export type Probe =
  | { kind: "rapid-motion" | "filter-heavy" | "opacity-boundary" | "motion-blur"; t: number }
  | { kind: "transition" | "static-hold"; start: number; end: number };

export interface FixtureFidelitySpec {
  /** The output must carry an alpha plane. */
  alpha?: boolean;
  /** The output must be HDR with this transfer. */
  hdr?: "pq" | "hlg";
  probes: Probe[];
}

export interface SampledFrame {
  index: number;
  reasons: string[];
}

const POINT_KINDS = new Set(["rapid-motion", "filter-heavy", "opacity-boundary", "motion-blur"]);
const SPAN_KINDS = new Set(["transition", "static-hold"]);

/** Validate the fidelity section of fidelity-manifest.json for one fixture (boundary input). */
export function parseFidelitySpec(id: string, raw: unknown): FixtureFidelitySpec {
  if (!raw || typeof raw !== "object") throw new Error(`fidelity-manifest: no fidelity entry for ${id}`);
  const r = raw as Record<string, unknown>;
  if (r.alpha !== undefined && typeof r.alpha !== "boolean") throw new Error(`fidelity-manifest ${id}: alpha must be boolean`);
  if (r.hdr !== undefined && r.hdr !== "pq" && r.hdr !== "hlg") throw new Error(`fidelity-manifest ${id}: hdr must be "pq" or "hlg"`);
  if (!Array.isArray(r.probes)) throw new Error(`fidelity-manifest ${id}: probes must be an array`);
  const probes = r.probes.map((p: Record<string, unknown>, i: number): Probe => {
    const where = `fidelity-manifest ${id} probe ${i}`;
    if (POINT_KINDS.has(String(p.kind))) {
      if (typeof p.t !== "number" || p.t < 0) throw new Error(`${where}: t must be a non-negative number`);
      return { kind: p.kind as "rapid-motion", t: p.t };
    }
    if (SPAN_KINDS.has(String(p.kind))) {
      if (typeof p.start !== "number" || typeof p.end !== "number" || p.end <= p.start || p.start < 0) throw new Error(`${where}: needs 0 <= start < end`);
      return { kind: p.kind as "transition", start: p.start, end: p.end };
    }
    throw new Error(`${where}: unknown kind ${String(p.kind)}`);
  });
  return { alpha: r.alpha as boolean | undefined, hdr: r.hdr as "pq" | "hlg" | undefined, probes };
}

export function loadFidelitySpec(id: string): FixtureFidelitySpec {
  const raw = JSON.parse(readFileSync(join(BENCH_ROOT, "fixtures", "fidelity-manifest.json"), "utf8"));
  return parseFidelitySpec(id, raw.fidelity?.[id]);
}

/**
 * Clip boundaries (seconds) from the static HTML: every data-start and
 * data-start + data-duration of an element that is not the composition root.
 */
export function cutTimesFromHtml(html: string): number[] {
  const out = new Set<number>();
  for (const m of html.matchAll(/<[a-zA-Z][^>]*>/g)) {
    const tag = m[0];
    if (/data-composition-id=/.test(tag)) continue;
    const start = /data-start="([\d.]+)"/.exec(tag);
    if (!start) continue;
    const s = Number(start[1]);
    if (s > 0) out.add(s);
    const dur = /data-duration="([\d.]+)"/.exec(tag);
    if (dur) out.add(Math.round((s + Number(dur[1])) * 1000) / 1000);
  }
  return [...out].sort((a, b) => a - b);
}

export function seedFor(fixtureSourceSha256: string, settings: Record<string, unknown>): string {
  return createHash("sha256").update(fixtureSourceSha256).update(JSON.stringify(settings)).digest("hex");
}

export function buildSamplePlan(opts: {
  frameCount: number;
  fps: Rational;
  seed: string;
  cutTimes: number[];
  probes: Probe[];
}): SampledFrame[] {
  const { frameCount, fps } = opts;
  if (frameCount <= 0) throw new Error("cannot sample an output with no frames");
  const picks = new Map<number, Set<string>>();
  const add = (i: number, reason: string) => {
    if (i < 0 || i >= frameCount) return;
    const s = picks.get(i) ?? new Set<string>();
    s.add(reason);
    picks.set(i, s);
  };
  add(0, "first");
  add(frameCount - 1, "last");
  for (const t of opts.cutTimes) {
    const f = frameAtOrAfter(t, fps);
    add(f - 1, "cut-before");
    add(f, "cut");
    add(f + 1, "cut-after");
  }
  for (const p of opts.probes) {
    if ("t" in p) {
      const f = frameAtOrAfter(p.t, fps);
      if (p.kind === "motion-blur") {
        add(f - 1, "motion-blur-neighbour");
        add(f, "motion-blur");
        add(f + 1, "motion-blur-neighbour");
      } else if (p.kind === "rapid-motion") {
        add(f, "rapid-motion");
        add(f + 1, "rapid-motion");
      } else {
        add(f, p.kind);
      }
    } else {
      const a = frameAtOrAfter(p.start, fps);
      const b = frameAtOrAfter(p.end, fps);
      if (p.kind === "transition") {
        add(a, "transition-start");
        add(Math.floor((a + b) / 2), "transition-mid");
        add(b, "transition-end");
      } else {
        add(a, "hold-start");
        add(b - 1, "hold-end");
        add(b, "hold-after");
      }
    }
  }
  // Seeded random frames: SHA-256(seed || counter) mod frameCount, skipping repeats.
  let added = 0;
  for (let c = 0; added < Math.min(RANDOM_FRAMES, frameCount) && c < 10_000; c++) {
    const h = createHash("sha256").update(opts.seed).update(String(c)).digest();
    const i = Number(h.readBigUInt64BE(0) % BigInt(frameCount));
    if (picks.get(i)?.has("random")) continue;
    add(i, "random");
    added++;
  }
  return [...picks.entries()].sort((a, b) => a[0] - b[0]).map(([index, r]) => ({ index, reasons: [...r].sort() }));
}
