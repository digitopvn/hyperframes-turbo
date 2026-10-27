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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { deriveFixtureThresholds, observe } from "../../src/fidelity/calibrate.js";
import { measure, type CompareContext } from "../../src/fidelity/compare.js";
import { applicableFaults, EXPECTED, injectFault, pickFaultFrame, type FaultKind } from "../../src/fidelity/inject-faults.js";
import { probeMedia } from "../../src/fidelity/probe.js";
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
    faults: ["dropped-frame", "duplicated-frame", "reordered-frames", "stale-frame", "pixel-corruption-sampled", "pixel-corruption-unsampled", "wrong-resolution", "wrong-fps", "vfr-timestamps", "bitrate-drop", "audio-offset", "missing-audio"],
  },
  {
    id: "synthetic-alpha",
    ext: ".webm",
    spec: { alpha: true, probes: [] },
    args: ["-f", "lavfi", "-i", `${VIDEO.replace("d=4", "d=2")},format=rgba,colorchannelmixer=aa=0.5`, "-c:v", "libvpx-vp9", "-lossless", "1", "-threads", "1", "-row-mt", "0", "-pix_fmt", "yuva420p"],
    faults: ["alpha-stripped"],
  },
  {
    id: "synthetic-hdr-pq",
    ext: ".mp4",
    spec: { hdr: "pq", probes: [] },
    args: [
      "-f", "lavfi", "-i", VIDEO.replace("d=4", "d=2"),
      "-c:v", "libx265", "-preset", "ultrafast", "-pix_fmt", "yuv420p10le", "-tag:v", "hvc1",
      "-x265-params", "log-level=error:pools=1:frame-threads=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1):max-cll=1000,400",
      "-color_primaries", "bt2020", "-color_trc", "smpte2084", "-colorspace", "bt2020nc",
    ],
    faults: ["hdr-metadata-stripped"],
  },
];

const ctxFor = (k: Kind): CompareContext => ({ fixture: k.id, fps: rat(30, 1), seed: `test:${k.id}`, cutTimes: [], spec: parseFidelitySpec(k.id, k.spec) });
const out = (k: Kind, run: number) => join(work, `${k.id}-run-${run}${k.ext}`);

before(async () => {
  const file: ThresholdFile = {
    schema: THRESHOLDS_SCHEMA,
    path: PATH,
    calibration: { runs: [...Array(RUNS).keys()].map((i) => i + 1), createdAt: new Date().toISOString(), host: "test", platform: process.platform, upstreamSha: null, ffmpeg: null, resultsDir: work, cell: "synthetic", rawPairsFile: "none", command: "gate.test.ts" },
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

function thumbTolerance(id: string): number {
  const file = JSON.parse(readFileSync(thresholdsFile, "utf8")) as ThresholdFile;
  return toNum(file.fixtures[id]!.temporal.thumbMseTol.limit);
}

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
        const target = join(work, `${k.id}-${fault}${k.ext}`);
        try {
          await injectFault(fault, src, target, ctxFor(k), frame!);
          const rec = await run(k, target);
          assert.equal(rec.verdict, "FAIL", `verdict ${rec.verdict} (${rec.reasons.join(",")})`);
          assert.ok(EXPECTED[fault].some((r) => rec.reasons.includes(r)), `reasons ${rec.reasons.join(",")} lack ${EXPECTED[fault].join("/")}`);
        } finally {
          rmSync(target, { force: true });
        }
      });
    }
  });
}

const sdr = KINDS[0]!;

describe("fail-closed behaviour", () => {
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
