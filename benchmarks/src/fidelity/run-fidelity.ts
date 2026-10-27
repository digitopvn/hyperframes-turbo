/**
 * Fidelity gate: compare a candidate render against the Chromium reference.
 *
 *   Pair mode:
 *     run-fidelity.ts --fixture <id> --ref <file|png dir> --cand <file|png dir>
 *                     [--path <profile.platform>] [--thresholds <file>]
 *                     [--backend <name>] [--out <record.json>]
 *   Results mode (outputs kept by run-benchmark.ts --keep-output):
 *     run-fidelity.ts --results <dir> --ref-cell producer-default --ref-run 1
 *                     --cand-cell <cell> --cand-run 2 [--fixtures a,b] [--path ...]
 *     Writes `fidelity` into each candidate raw run JSON (turbo-bench-run/2)
 *     and fidelity-report.{json,md} into the results dir.
 *
 * Exit codes: 0 PASS, 1 FAIL (including any internal error), 3 FALLBACK,
 * 2 usage error. TURBO_FIDELITY=off records FALLBACK/DISABLED (never PASS).
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Output } from "../fixtures.js";
import { parseArgs, UsageError } from "./cli-args.js";
import { judge, measure, type CompareContext } from "./compare.js";
import { hasLibvmaf } from "./metrics/encoded.js";
import type { MediaInput } from "./probe.js";
import { liveProcessCount } from "./proc.js";
import { attachToRun, buildRecord, fixtureContext, renderMarkdown, repoRelative, toJson, toolVersion, type FidelityRecord } from "./schema.js";
import { candidateCellProblem, loadThresholds, pathName, type LoadedThresholds } from "./thresholds.js";
import { aggregate, EXIT_CODE, EXIT_USAGE, type Verdict } from "./verdict.js";

export interface EvaluateOptions {
  fixture: string;
  reference: string;
  candidate: string;
  path: string;
  thresholdsFile?: string;
  backend?: string;
  refMeta?: { cell?: string; run?: number };
  candMeta?: { cell?: string; run?: number };
  /** Fixture context override (tests with synthetic media); default: from the fixture manifests. */
  context?: CompareContext;
}

function mediaInput(path: string, fps: MediaInput["imageSequenceFps"]): MediaInput {
  return existsSync(path) && statSync(path).isDirectory() ? { path, imageSequenceFps: fps } : { path };
}

/** Compare one candidate output with its reference; never throws for gate outcomes. */
export async function evaluate(o: EvaluateOptions): Promise<FidelityRecord> {
  const loaded: LoadedThresholds | { error: string; file: string } = loadThresholds(o.path, o.thresholdsFile);
  const tools = { ffmpeg: await toolVersion(), libvmaf: await hasLibvmaf().catch(() => null) };
  const reference = { file: repoRelative(o.reference), sha256: existsSync(o.reference) ? await sha256Output(o.reference) : null, ...o.refMeta };
  const candidate = { file: repoRelative(o.candidate), sha256: existsSync(o.candidate) ? await sha256Output(o.candidate) : null, backend: o.backend ?? "chromium-reference", ...o.candMeta };
  const thresholds = { path: o.path, loaded };
  if (process.env.TURBO_FIDELITY === "off") {
    return buildRecord({ fixture: o.fixture, judgement: null, measurements: null, reference, candidate, thresholds, tools, overrideVerdict: { verdict: "FALLBACK", reasons: ["DISABLED"] } });
  }
  if ("data" in loaded && o.candMeta?.cell && o.refMeta?.cell) {
    const problem = candidateCellProblem(loaded.data, o.refMeta.cell, o.candMeta.cell);
    if (problem) {
      console.error(`[fidelity] ${o.fixture}: ${problem}`);
      return buildRecord({ fixture: o.fixture, judgement: null, measurements: null, reference, candidate, thresholds, tools, overrideVerdict: { verdict: "FAIL", reasons: ["THRESHOLD_INVALID"] } });
    }
  }
  const ctx = o.context ?? fixtureContext(o.fixture).ctx;
  const m = await measure(mediaInput(o.reference, ctx.fps), mediaInput(o.candidate, ctx.fps), ctx);
  const fxT = "data" in loaded ? (loaded.data.fixtures[o.fixture] ?? null) : null;
  const problem = "error" in loaded ? loaded.error : fxT ? null : `threshold file ${repoRelative(loaded.file)} has no entry for ${o.fixture}`;
  const j = judge(m, fxT, problem, ctx);
  return buildRecord({ fixture: o.fixture, judgement: j, measurements: m, reference, candidate, thresholds, tools });
}

/** `<results>/outputs/<fixture>/<cell>/run-<n>.<ext>` as kept by render-worker --keep-output. */
export function keptOutput(results: string, fixture: string, cell: string, run: number): string | null {
  const dir = join(results, "outputs", fixture, cell);
  if (!existsSync(dir)) return null;
  const hit = readdirSync(dir).find((n) => n.startsWith(`run-${run}.`));
  return hit ? join(dir, hit) : null;
}

function cliArgs(argv: string[]) {
  const { get, int, list } = parseArgs(argv);
  return {
    fixture: get("fixture"),
    ref: get("ref"),
    cand: get("cand"),
    path: get("path"),
    thresholds: get("thresholds"),
    backend: get("backend"),
    out: get("out"),
    results: get("results"),
    refCell: get("ref-cell") ?? "producer-default",
    refRun: int("ref-run"),
    candCell: get("cand-cell"),
    candRun: int("cand-run"),
    fixtures: list("fixtures"),
  };
}

async function main(): Promise<number> {
  const a = cliArgs(process.argv.slice(2));
  const path = a.path ?? pathName(a.refCell.replace(/\.control$/, ""));
  const records: FidelityRecord[] = [];
  if (a.results) {
    if (a.refRun === undefined || !a.candCell || a.candRun === undefined) throw new UsageError("results mode needs --ref-run, --cand-cell and --cand-run");
    const results = resolve(a.results);
    const fixtures = a.fixtures ?? readdirSync(join(results, "outputs"));
    for (const fixture of fixtures) {
      const ref = keptOutput(results, fixture, a.refCell, a.refRun);
      const cand = keptOutput(results, fixture, a.candCell, a.candRun);
      const rec = await evaluate({
        fixture,
        reference: ref ?? join(results, "outputs", fixture, a.refCell, `run-${a.refRun}.missing`),
        candidate: cand ?? join(results, "outputs", fixture, a.candCell, `run-${a.candRun}.missing`),
        path,
        thresholdsFile: a.thresholds,
        backend: a.backend,
        refMeta: { cell: a.refCell, run: a.refRun },
        candMeta: { cell: a.candCell, run: a.candRun },
      });
      records.push(rec);
      const runJson = join(results, "raw", fixture, a.candCell, `run-${a.candRun}.json`);
      if (existsSync(runJson)) attachToRun(runJson, rec);
      console.error(`[fidelity] ${fixture}: ${rec.verdict}${rec.reasons.length ? ` (${rec.reasons.join(", ")})` : ""}`);
    }
    const verdict = aggregate(records.map((r) => r.verdict));
    writeFileSync(join(results, "fidelity-report.json"), toJson({ schema: "turbo-fidelity-report/1", verdict, path, reference: { cell: a.refCell, run: a.refRun }, candidate: { cell: a.candCell, run: a.candRun }, records }));
    writeFileSync(
      join(results, "fidelity-report.md"),
      renderMarkdown(`Fidelity report: ${a.candCell} run ${a.candRun} vs ${a.refCell} run ${a.refRun}`, records, [
        `- Overall verdict: **${verdict}** (exit code ${EXIT_CODE[verdict]})`,
        `- Threshold path: \`${path}\``,
        `- Tools: ${records[0]?.tools.ffmpeg ?? "?"}; libvmaf ${records[0]?.tools.libvmaf ? "available" : "unavailable"}`,
        `- Peak RSS is the comparator Node process (FFmpeg children excluded).`,
      ]),
    );
    console.error(`[fidelity] overall ${verdict}: ${join(results, "fidelity-report.md")}`);
    return EXIT_CODE[verdict];
  }
  if (!a.fixture || !a.ref || !a.cand) throw new UsageError("pair mode needs --fixture, --ref and --cand (or use --results)");
  const rec = await evaluate({ fixture: a.fixture, reference: resolve(a.ref), candidate: resolve(a.cand), path, thresholdsFile: a.thresholds, backend: a.backend });
  if (a.out) {
    mkdirSync(dirname(resolve(a.out)), { recursive: true });
    writeFileSync(a.out, toJson(rec));
  }
  console.log(`${rec.fixture}: ${rec.verdict}${rec.reasons.length ? ` (${rec.reasons.join(", ")})` : ""}`);
  return EXIT_CODE[rec.verdict as Verdict];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main()
    .then((code) => {
      if (liveProcessCount() !== 0) console.error(`[fidelity] warning: ${liveProcessCount()} tool process(es) still alive at exit; killing`);
      process.exit(code);
    })
    .catch((err) => {
      console.error(`[fidelity] ${err instanceof UsageError ? "usage" : "internal error (fail-closed)"}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      process.exit(err instanceof UsageError ? EXIT_USAGE : EXIT_CODE.FAIL);
    });
}
