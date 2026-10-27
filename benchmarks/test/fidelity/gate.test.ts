/**
 * End-to-end gate tests on synthetic media generated with FFmpeg (no Chrome).
 *
 * For each stream kind (SDR h264+aac, VP9 alpha, HEVC 10-bit PQ) five
 * independent encodes are calibrated exactly like real reference renders;
 * the unmodified control must PASS and every applicable injected fault must
 * FAIL with its expected reason. All FFmpeg processes go through the guarded
 * runner in proc.ts and none may be left alive.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { deriveFixtureThresholds, observe } from "../../src/fidelity/calibrate.js";
import { measure, type CompareContext } from "../../src/fidelity/compare.js";
import { applicableFaults, EXPECTED, faultCaught, injectFault, NEAR_THRESHOLD, nearThresholdRequirement, pickFaultFrame, pickSubtleStaleFrame, type FaultKind } from "../../src/fidelity/inject-faults.js";
import { PNG_SEQUENCE_PATTERN, probeMedia } from "../../src/fidelity/probe.js";
import { FFMPEG, liveProcessCount, runTool } from "../../src/fidelity/proc.js";
import { rat } from "../../src/fidelity/rational.js";
import { evaluate } from "../../src/fidelity/run-fidelity.js";
import { parseFidelitySpec } from "../../src/fidelity/sample-plan.js";
import { THRESHOLDS_SCHEMA, toNum, type ThresholdFile } from "../../src/fidelity/thresholds.js";

const PATH = "synthetic.test";
const RUNS = 5;
const work = mkdtempSync(join(tmpdir(), "turbo-fidelity-test-"));
const thresholdsFile = join(work, `${PATH}.json`);

interface Kind {
  id: string;
  ext: string;
  spec: unknown;
  args: string[];
  faults: FaultKind[];
}

const VIDEO = "testsrc2=s=320x180:r=30:d=4";
const BURSTS = "aevalsrc='0.5*sin(2*PI*440*t)*lt(mod(t\\,1)\\,0.08)':s=48000:d=4";
const KINDS: Kind[] = [
  {
    id: "synthetic-sdr",
    ext: ".mp4",
    spec: { probes: [] },
    args: ["-f", "lavfi", "-i", VIDEO, "-f", "lavfi", "-i", BURSTS, "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-threads", "1", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-shortest"],
    faults: ["dropped-frame", "duplicated-frame", "reordered-frames", "stale-frame", "stale-frame-subtle", "pixel-corruption-sampled", "pixel-corruption-unsampled", "pixel-subtle-sampled", "pixel-subtle-unsampled", "wrong-fps", "vfr-timestamps", "wrong-resolution", "bitrate-drop", "audio-offset", "audio-offset-22ms", "audio-offset-25ms", "audio-offset-30ms", "missing-audio"],
  },
  {
    id: "synthetic-alpha",
    ext: ".webm",
    spec: { alpha: true, probes: [] },
    args: ["-f", "lavfi", "-i", `${VIDEO.replace("d=4", "d=2")},format=rgba,colorchannelmixer=aa=0.5`, "-c:v", "libvpx-vp9", "-lossless", "1", "-threads", "1", "-row-mt", "0", "-pix_fmt", "yuva420p"],
    faults: ["alpha-stripped", "dropped-frame", "duplicated-frame", "reordered-frames", "stale-frame", "stale-frame-subtle", "pixel-corruption-sampled", "pixel-corruption-unsampled", "pixel-subtle-sampled", "pixel-subtle-unsampled", "wrong-fps", "vfr-timestamps"],
  },
  {
    id: "synthetic-hdr-pq",
    ext: ".mp4",
    spec: { hdr: "pq", probes: [] },
    args: [
      "-f", "lavfi", "-i", VIDEO.replace("d=4", "d=2"),
      "-c:v", "libx265", "-preset", "ultrafast", "-pix_fmt", "yuv420p10le", "-tag:v", "hvc1",
      "-x265-params", "log-level=error:info=0:pools=1:frame-threads=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1):max-cll=1000,400",
      "-color_primaries", "bt2020", "-color_trc", "smpte2084", "-colorspace", "bt2020nc",
    ],
    faults: ["hdr-metadata-stripped", "hdr-sei-stripped", "hdr-max-cll-changed", "dropped-frame", "duplicated-frame", "reordered-frames", "stale-frame", "stale-frame-subtle", "pixel-corruption-sampled", "pixel-corruption-unsampled", "pixel-subtle-sampled", "pixel-subtle-unsampled", "wrong-fps", "vfr-timestamps"],
  },
];

const ctxFor = (k: Kind): CompareContext => ({ fixture: k.id, fps: rat(30, 1), seed: `test:${k.id}`, cutTimes: [], spec: parseFidelitySpec(k.id, k.spec) });
const out = (k: Kind, run: number) => join(work, `${k.id}-run-${run}${k.ext}`);

before(async () => {
  const file: ThresholdFile = {
    schema: THRESHOLDS_SCHEMA,
    path: PATH,
    calibration: { runs: [...Array(RUNS).keys()].map((i) => i + 1), createdAt: new Date().toISOString(), host: "test", platform: process.platform, upstreamSha: null, ffmpeg: null, resultsDir: work, cell: "producer-default", rawPairsFile: "none", command: "gate.test.ts" },
    fixtures: {},
  };
  for (const k of KINDS) {
    for (let r = 1; r <= RUNS; r++) await runTool(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...k.args, out(k, r)]);
    const obs = [];
    for (let a = 1; a <= RUNS; a++) for (let b = a + 1; b <= RUNS; b++) obs.push(observe(a, b, await measure({ path: out(k, a) }, { path: out(k, b) }, ctxFor(k))));
    const p = await probeMedia({ path: out(k, 1) });
    const t = deriveFixtureThresholds(RUNS, obs, p.audio ? { codec: p.audio.codec, sampleRate: p.audio.sampleRate } : null);
    assert.ok(t, `${k.id}: calibration withheld: ${obs.flatMap((o) => o.invariantProblems).join("; ")}`);
    file.fixtures[k.id] = t;
  }
  writeFileSync(thresholdsFile, JSON.stringify(file));
});

after(() => {
  rmSync(work, { recursive: true, force: true });
});

const fixtureThresholds = (id: string) => (JSON.parse(readFileSync(thresholdsFile, "utf8")) as ThresholdFile).fixtures[id]!;
const thumbTolerance = (id: string): number => toNum(fixtureThresholds(id).temporal.thumbMseTol.limit);

const run = (k: Kind, candidate: string, extra: Partial<Parameters<typeof evaluate>[0]> = {}) =>
  evaluate({ fixture: k.id, reference: out(k, 1), candidate, path: PATH, thresholdsFile, context: ctxFor(k), ...extra });

for (const k of KINDS) {
  describe(k.id, () => {
    test("unmodified control passes", async () => {
      const rec = await run(k, out(k, 2));
      assert.equal(rec.verdict, "PASS", rec.reasons.join(","));
    });

    test("all intended faults are applicable", async () => {
      const applicable = applicableFaults(await probeMedia({ path: out(k, 2) }), ctxFor(k));
      for (const f of k.faults) assert.ok(applicable.includes(f), `${f} not applicable`);
    });

    for (const fault of k.faults) {
      test(`fault ${fault} is caught`, async () => {
        const src = await probeMedia({ path: out(k, 2) });
        const tol = thumbTolerance(k.id);
        const frame = await pickFaultFrame(src, tol);
        assert.notEqual(frame, null, "no distinct frame neighbourhood");
        const subtle = fault === "stale-frame-subtle" ? await pickSubtleStaleFrame(src, tol) : null;
        if (fault === "stale-frame-subtle") assert.notEqual(subtle, null, "no observable subtle stale frame");
        if (NEAR_THRESHOLD.has(fault)) {
          // The synthetic fixtures are deterministic, so every near-threshold fault must be required here.
          const req = nearThresholdRequirement(fault, fixtureThresholds(k.id));
          assert.ok(req.required, `${fault} not required: ${req.why}`);
        }
        const target = join(work, `${k.id}-${fault}${k.ext}`);
        try {
          await injectFault(fault, src, target, ctxFor(k), frame!, subtle?.k);
          const rec = await run(k, target);
          assert.equal(rec.verdict, "FAIL", `verdict ${rec.verdict} (${rec.reasons.join(",")})`);
          assert.ok(faultCaught(fault, rec), `reasons ${rec.reasons.join(",")} do not match ${EXPECTED[fault].join("/")}`);
        } finally {
          rmSync(target, { force: true });
        }
      });
    }
  });
}

describe("pre-encode tier: lossless PNG sequence (upstream format png-sequence)", () => {
  const k: Kind = { id: "synthetic-png", ext: "", spec: { probes: [] }, args: [], faults: [] };
  const dir = (run: number) => join(work, `png-run-${run}`);
  const ctx = ctxFor(k);
  const seq = (p: string) => ({ path: p, imageSequenceFps: ctx.fps });

  before(async () => {
    for (let r = 1; r <= RUNS; r++) {
      mkdirSync(dir(r));
      await runTool(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=160x90:r=30:d=1", "-start_number", "1", join(dir(r), PNG_SEQUENCE_PATTERN)]);
    }
    const obs = [];
    for (let a = 1; a <= RUNS; a++) for (let b = a + 1; b <= RUNS; b++) obs.push(observe(a, b, await measure(seq(dir(a)), seq(dir(b)), ctx)));
    const t = deriveFixtureThresholds(RUNS, obs, null);
    assert.ok(t, obs.flatMap((o) => o.invariantProblems).join("; "));
    const file = JSON.parse(readFileSync(thresholdsFile, "utf8")) as ThresholdFile;
    file.fixtures[k.id] = t;
    writeFileSync(thresholdsFile, JSON.stringify(file));
  });

  test("identical lossless frames pass bit-exact", async () => {
    const rec = await evaluate({ fixture: k.id, reference: dir(1), candidate: dir(2), path: PATH, thresholdsFile, context: ctx });
    assert.equal(rec.verdict, "PASS", rec.reasons.join(","));
  });

  test("a missing frame file fails", async () => {
    const names = readdirSync(dir(3)).sort();
    // Shift every frame after #10 down by one: same naming scheme, one frame fewer.
    for (let i = 10; i < names.length; i++) renameSync(join(dir(3), names[i]!), join(dir(3), names[i - 1]!));
    const rec = await evaluate({ fixture: k.id, reference: dir(1), candidate: dir(3), path: PATH, thresholdsFile, context: ctx });
    assert.equal(rec.verdict, "FAIL");
    assert.ok(rec.reasons.includes("FRAME_COUNT_MISMATCH") && rec.reasons.includes("FRAME_DROPPED"), rec.reasons.join(","));
  });
});

const sdr = KINDS[0]!;

describe("fail-closed behaviour", () => {
  test("a candidate cell that fed the calibration fails with THRESHOLD_INVALID", async () => {
    const gate = (refCell: string, candCell: string) => run(sdr, out(sdr, 2), { refMeta: { cell: refCell, run: 1 }, candMeta: { cell: candCell, run: 2 } });
    // A non-reference cell gated against itself has no reference at all.
    const self = await gate("turbo-x", "turbo-x");
    assert.equal(self.verdict, "FAIL");
    assert.deepEqual(self.reasons, ["THRESHOLD_INVALID"]);
    // The accepted reference repeated (CI determinism check), and an independent candidate, are gated normally.
    assert.equal((await gate("producer-default", "producer-default.control")).verdict, "PASS");
    assert.equal((await gate("producer-default", "turbo-x")).verdict, "PASS");
  });

  test("missing threshold entry fails with THRESHOLD_MISSING", async () => {
    const rec = await run(sdr, out(sdr, 2), { fixture: "not-calibrated", context: { ...ctxFor(sdr), fixture: "not-calibrated" } });
    assert.equal(rec.verdict, "FAIL");
    assert.ok(rec.reasons.includes("THRESHOLD_MISSING"), rec.reasons.join(","));
  });

  test("missing threshold file fails with THRESHOLD_MISSING", async () => {
    const rec = await run(sdr, out(sdr, 2), { thresholdsFile: join(work, "absent.json") });
    assert.equal(rec.verdict, "FAIL");
    assert.ok(rec.reasons.includes("THRESHOLD_MISSING"), rec.reasons.join(","));
  });

  test("missing candidate fails with CHECK_ERROR", async () => {
    const rec = await run(sdr, join(work, "absent.mp4"));
    assert.equal(rec.verdict, "FAIL");
    assert.ok(rec.reasons.includes("CHECK_ERROR"), rec.reasons.join(","));
  });

  test("VMAF disabled on an SDR path downgrades to FALLBACK, never PASS", async () => {
    process.env.FIDELITY_DISABLE_VMAF = "1";
    try {
      const rec = await run(sdr, out(sdr, 2));
      assert.equal(rec.verdict, "FALLBACK", rec.reasons.join(","));
      assert.ok(rec.reasons.includes("TOOL_UNAVAILABLE"));
    } finally {
      delete process.env.FIDELITY_DISABLE_VMAF;
    }
  });

  test("TURBO_FIDELITY=off records FALLBACK/DISABLED", async () => {
    process.env.TURBO_FIDELITY = "off";
    try {
      const rec = await run(sdr, out(sdr, 2));
      assert.equal(rec.verdict, "FALLBACK");
      assert.deepEqual(rec.reasons, ["DISABLED"]);
    } finally {
      delete process.env.TURBO_FIDELITY;
    }
  });

  test("no FFmpeg process is left alive", () => {
    assert.equal(liveProcessCount(), 0);
  });
});
