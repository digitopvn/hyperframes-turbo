/**
 * Exit-code contract of the fidelity gate CLI (run-fidelity.ts), exercised as
 * a real child process: 0 PASS, 1 FAIL, 3 FALLBACK (TURBO_FIDELITY=off), 2
 * usage error. Uses small synthetic encodes calibrated against the context of
 * the real `audio-mix` fixture (30 fps), so no Chrome render is needed.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deriveFixtureThresholds, observe } from "../../src/fidelity/calibrate.js";
import { measure } from "../../src/fidelity/compare.js";
import { probeMedia } from "../../src/fidelity/probe.js";
import { FFMPEG, runTool } from "../../src/fidelity/proc.js";
import { fixtureContext } from "../../src/fidelity/schema.js";
import { THRESHOLDS_SCHEMA, type ThresholdFile } from "../../src/fidelity/thresholds.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, "../../src/fidelity/run-fidelity.ts");
// --import takes a URL: a bare Windows drive path ("D:\...") is rejected as an unknown scheme.
const TSX = pathToFileURL(resolve(HERE, "../../../upstream/hyperframes/node_modules/tsx/dist/loader.mjs")).href;
const FIXTURE = "audio-mix";
const PATH = "cli.test";
const RUNS = 5;
const work = mkdtempSync(join(tmpdir(), "turbo-fidelity-cli-"));
const thresholdsFile = join(work, `${PATH}.json`);
const run = (n: number) => join(work, `run-${n}.mp4`);
const silent = join(work, "no-audio.mp4");

const ENCODE = [
  "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=2",
  "-f", "lavfi", "-i", "aevalsrc='0.5*sin(2*PI*440*t)*lt(mod(t\\,1)\\,0.08)':s=48000:d=2",
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-threads", "1", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-shortest",
];

before(async () => {
  const { ctx } = fixtureContext(FIXTURE);
  for (let r = 1; r <= RUNS; r++) await runTool(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...ENCODE, run(r)]);
  await runTool(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-i", run(2), "-map", "0:v", "-c", "copy", silent]);
  const obs = [];
  for (let a = 1; a <= RUNS; a++) for (let b = a + 1; b <= RUNS; b++) obs.push(observe(a, b, await measure({ path: run(a) }, { path: run(b) }, ctx)));
  const p = await probeMedia({ path: run(1) });
  const t = deriveFixtureThresholds(RUNS, obs, p.audio ? { codec: p.audio.codec, sampleRate: p.audio.sampleRate } : null);
  assert.ok(t, obs.flatMap((o) => o.invariantProblems).join("; "));
  const file: ThresholdFile = {
    schema: THRESHOLDS_SCHEMA,
    path: PATH,
    calibration: { runs: [1, 2, 3, 4, 5], createdAt: new Date().toISOString(), host: "test", platform: process.platform, upstreamSha: null, ffmpeg: null, resultsDir: work, cell: "producer-default", rawPairsFile: "none", command: "cli.test.ts" },
    fixtures: { [FIXTURE]: t },
  };
  writeFileSync(thresholdsFile, JSON.stringify(file));
});

after(() => rmSync(work, { recursive: true, force: true }));

function gate(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, ["--import", TSX, CLI, ...args], { encoding: "utf8", windowsHide: true, timeout: 120_000, env: { ...process.env, ...env } });
  if (r.error) throw r.error;
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const files = (cand: string) => ["--fixture", FIXTURE, "--ref", run(1), "--cand", cand, "--path", PATH, "--thresholds", thresholdsFile];
const pair = (cand: string, refCell = "producer-default", candCell = "turbo-candidate") => [...files(cand), "--ref-cell", refCell, "--cand-cell", candCell];

test("unmodified control exits 0 (PASS)", () => {
  const r = gate(pair(run(2)));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /PASS/);
});

test("candidate without audio exits 1 (FAIL)", () => {
  const r = gate(pair(silent));
  assert.equal(r.code, 1, r.out);
  // A crash also exits 1: require the gate's own verdict line with the expected reason.
  assert.match(r.out, /^audio-mix: FAIL \(.*AUDIO_MISSING.*\)$/m);
});

test("TURBO_FIDELITY=off exits 3 (FALLBACK), never 0", () => {
  const r = gate(pair(run(2)), { TURBO_FIDELITY: "off" });
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /FALLBACK \(DISABLED\)/);
});

test("usage errors exit 2", () => {
  assert.equal(gate(["--fixture", FIXTURE]).code, 2);
  assert.equal(gate(["--results", work, "--ref-run", "one", "--cand-cell", "x", "--cand-run", "2"]).code, 2);
  assert.equal(gate(["--fixture"]).code, 2);
});

test("pair mode: a non-reference cell gated against itself exits 1 (THRESHOLD_INVALID)", () => {
  const r = gate(pair(run(2), "turbo-candidate", "turbo-candidate"));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^audio-mix: FAIL \(THRESHOLD_INVALID\)$/m);
});

test("pair mode without cell names is a usage error (exit 2)", () => {
  assert.equal(gate(files(run(2))).code, 2);
  assert.equal(gate([...files(run(2)), "--ref-cell", "producer-default"]).code, 2);
  assert.equal(gate([...files(run(2)), "--cand-cell", "turbo-candidate"]).code, 2);
});