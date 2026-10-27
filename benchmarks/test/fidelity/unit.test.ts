/** Pure-logic tests of the fidelity gate (no FFmpeg, no Chrome). */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BENCH_ROOT, loadManifest } from "../../src/fixtures.js";
import { analyzeTemporal } from "../../src/fidelity/metrics/temporal.js";
import { comparePixels } from "../../src/fidelity/metrics/pixels.js";
import { frameAtOrAfter, frameTicks, parseRational, ptsErrorTicks, rat, ratToNumber } from "../../src/fidelity/rational.js";
import { buildSamplePlan, cutTimesFromHtml, loadFidelitySpec, parseFidelitySpec } from "../../src/fidelity/sample-plan.js";
import { deriveLimit, MIN_RUNS, validateThresholds, within } from "../../src/fidelity/thresholds.js";
import { aggregate } from "../../src/fidelity/verdict.js";

test("30000/1001 maps 10,000 frames to exact ticks with no drift", () => {
  const fps = parseRational("30000/1001");
  const tb = rat(1, 30000);
  for (let i = 0; i < 10_000; i++) {
    const t = frameTicks(i, fps, tb);
    assert.equal(t.den, 1n, `frame ${i} is not an integer tick`);
    assert.equal(t.num, BigInt(i) * 1001n);
    assert.equal(ptsErrorTicks(BigInt(i) * 1001n, i, fps, tb), 0);
  }
  // A float accumulation would be off here; the rational is exact.
  assert.equal(ratToNumber(frameTicks(9999, fps, rat(1, 90000))), 9999 * 3003);
});

test("parseRational rejects decimals and accepts integers", () => {
  assert.throws(() => parseRational("29.97"));
  assert.throws(() => parseRational(29.97));
  assert.deepEqual(parseRational(30), { num: 30n, den: 1n });
  assert.deepEqual(parseRational("60/2"), { num: 30n, den: 1n });
});

test("frameAtOrAfter rounds up to the first frame at or after t", () => {
  const ntsc = parseRational("30000/1001");
  assert.equal(frameAtOrAfter(0, ntsc), 0);
  assert.equal(frameAtOrAfter(6, parseRational(30)), 180);
  assert.equal(frameAtOrAfter(1, ntsc), 30); // 29.97 frames -> 30th frame starts after 1 s
});

test("verdict aggregation is fail-closed", () => {
  assert.equal(aggregate(["PASS", "PASS"]), "PASS");
  assert.equal(aggregate(["PASS", "FALLBACK"]), "FALLBACK");
  assert.equal(aggregate(["FALLBACK", "FAIL", "PASS"]), "FAIL");
  assert.equal(aggregate(["NOT_APPLICABLE", "PASS"]), "PASS");
  assert.equal(aggregate(["NOT_APPLICABLE"]), "FAIL", "nothing verified must not pass");
  assert.equal(aggregate([]), "FAIL");
});

test("deriveLimit: exact on zero spread, worst+margin otherwise, floor applied", () => {
  const exact = deriveLimit([0, 0, 0, 0, 0], "max", 0.01);
  assert.equal(exact.rule, "exact");
  assert.equal(exact.limit, 0);
  const inf = deriveLimit([Infinity, Infinity], "min", 0.01);
  assert.equal(inf.limit, "inf");
  const spread = deriveLimit([40, 41, 42, 43, 44], "min", 0.01);
  assert.equal(spread.rule, "worst+margin");
  assert.equal(spread.limit, 40 - 3); // MAD 1 -> margin 3
  const floored = deriveLimit([0, 0, 0], "max", 0.125, 21.333);
  assert.equal(floored.rule, "floor");
  assert.equal(floored.limit, 21.333);
  assert.equal(within(NaN, spread, "min"), false);
  assert.equal(within(null, spread, "min"), false);
  assert.equal(within(41, spread, "min"), true);
});

test("threshold validation rejects fewer than 5 runs and a wrong path", () => {
  const lim = { limit: 0, worst: 0, mad: 0, margin: 0, rule: "exact", n: 6 };
  const fx = {
    runs: 4,
    pairs: 6,
    bitExact: true,
    pixels: { maxMse: lim, minSsim: lim, maxAbsDiff: lim, maxDiffPixelPct: lim, maxAlphaMse: null },
    temporal: { thumbMseTol: lim },
    audio: null,
    encoded: { minPsnrDb: lim, minSsim: lim, minVmaf: null, maxBitrateDropPct: lim },
  };
  const file = { schema: "turbo-fidelity-thresholds/1", path: "p.linux", calibration: { runs: [1, 2, 3, 4] }, fixtures: { a: fx } };
  const problems = validateThresholds(file, "p.win32");
  assert.ok(problems.some((p) => p.includes("path")));
  assert.ok(problems.some((p) => p.includes(`>= ${MIN_RUNS}`)));
  assert.ok(problems.some((p) => p.includes("4 runs")));
});

test("sample plan is deterministic and covers first, last, cuts and probes", () => {
  const opts = { frameCount: 300, fps: parseRational(30), seed: "abc", cutTimes: [6], probes: [{ kind: "motion-blur" as const, t: 2 }, { kind: "static-hold" as const, start: 3, end: 5 }] };
  const a = buildSamplePlan(opts);
  assert.deepEqual(a, buildSamplePlan(opts));
  const idx = new Map(a.map((f) => [f.index, f.reasons]));
  assert.ok(idx.get(0)!.includes("first"));
  assert.ok(idx.get(299)!.includes("last"));
  for (const i of [179, 180, 181]) assert.ok(idx.get(i)!.some((r) => r.startsWith("cut")), `cut frame ${i}`);
  assert.ok(idx.get(59)!.includes("motion-blur-neighbour") && idx.get(60)!.includes("motion-blur") && idx.get(61)!.includes("motion-blur-neighbour"));
  assert.ok(idx.get(149)!.includes("hold-end") && idx.get(150)!.includes("hold-after"));
  assert.equal(a.filter((f) => f.reasons.includes("random")).length, 8);
  assert.notDeepEqual(buildSamplePlan({ ...opts, seed: "abd" }), a);
});

test("cut times come from data-start/data-duration, root excluded", () => {
  const html = readFileSync(join(BENCH_ROOT, "fixtures", "mixed-complex", "src", "index.html"), "utf8");
  assert.deepEqual(cutTimesFromHtml(html), [6, 6.3, 8, 10]);
});

test("every fixture in both manifests has a valid fidelity spec; fidelity fixtures stay out of the baseline", () => {
  const baseline = loadManifest("baseline").map((f) => f.id);
  const fidelity = loadManifest("fidelity").map((f) => f.id);
  assert.deepEqual(fidelity.sort(), ["fps-ntsc-30000-1001", "motion-blur", "transition-crossfade"]);
  for (const id of fidelity) assert.ok(!baseline.includes(id));
  for (const f of loadManifest("all")) loadFidelitySpec(f.id);
  assert.equal(loadFidelitySpec("webm-transparency").alpha, true);
  assert.equal(loadFidelitySpec("hdr-regression").hdr, "pq");
  assert.throws(() => parseFidelitySpec("x", { probes: [{ kind: "nope", t: 1 }] }));
  assert.throws(() => parseFidelitySpec("x", { probes: [{ kind: "transition", start: 2, end: 1 }] }));
});

const thumbs = (n: number) => [...Array(n).keys()].map((i) => Buffer.alloc(16, i * 7));

test("temporal analysis classifies drop, duplicate, reorder and stale", () => {
  const ref = thumbs(20);
  const kind = (cand: Buffer[]) => analyzeTemporal(ref, cand, 0).events.map((e) => e.kind);
  assert.deepEqual(kind(ref), []);
  assert.deepEqual(kind(ref.filter((_, i) => i !== 9)), ["dropped"]);
  assert.deepEqual(kind(ref.flatMap((b, i) => (i === 9 ? [b, b] : [b]))), ["duplicated"]);
  assert.deepEqual(kind(ref.map((b, i) => (i === 9 ? ref[10]! : i === 10 ? ref[9]! : b))), ["reordered"]);
  assert.deepEqual(kind(ref.map((b, i) => (i === 9 ? ref[8]! : b))), ["stale"]);
  assert.deepEqual(kind(ref.slice(0, 18)), ["dropped"], "missing tail frames");
});

test("pixel stats: identical frames are exact, a changed pixel is seen", () => {
  const a = Buffer.alloc(16 * 16 * 3, 100);
  assert.deepEqual(comparePixels(a, Buffer.from(a), 16, 16, "rgb24"), { mse: 0, psnrDb: Infinity, ssim: 1, maxAbsDiff: 0, diffPixelPct: 0, alphaMse: null, alphaPsnrDb: null });
  const b = Buffer.from(a);
  b[0] = 110;
  const s = comparePixels(a, b, 16, 16, "rgb24");
  assert.equal(s.maxAbsDiff, 10);
  assert.ok(s.mse > 0 && s.ssim < 1);
  assert.equal(s.diffPixelPct, (1 / 256) * 100);
  const rgba = Buffer.alloc(4 * 4 * 4, 200);
  const rgba2 = Buffer.from(rgba);
  rgba2[3] = 0; // alpha only
  const t = comparePixels(rgba, rgba2, 4, 4, "rgba");
  assert.equal(t.mse, 0);
  assert.ok(t.alphaMse! > 0);
});
