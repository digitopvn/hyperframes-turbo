/**
 * `turbo-fidelity/1` records, their attachment to raw run JSON (which then
 * becomes `turbo-bench-run/2`), the fixture context the comparator needs, and
 * the Markdown fidelity report.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { hashFixtureSource, loadManifest, REPO_ROOT, resolveFixture, type ResolvedFixture } from "../fixtures.js";
import type { CompareContext, FidelityChecks, Judgement, Measurements } from "./compare.js";
import { FFMPEG, runTool } from "./proc.js";
import { parseRational, ratToString } from "./rational.js";
import { cutTimesFromHtml, loadFidelitySpec, seedFor } from "./sample-plan.js";
import type { LoadedThresholds } from "./thresholds.js";
import type { Reason, Verdict } from "./verdict.js";

export const FIDELITY_SCHEMA = "turbo-fidelity/1";
export const RUN_SCHEMA_V1 = "turbo-bench-run/1";
export const RUN_SCHEMA_V2 = "turbo-bench-run/2";

export interface OutputRef {
  file: string;
  sha256: string | null;
  cell?: string;
  run?: number;
}

export interface FidelityRecord {
  schema: typeof FIDELITY_SCHEMA;
  generatedAt: string;
  fixture: string;
  verdict: Verdict;
  reasons: Reason[];
  reference: OutputRef & { backend: "chromium-reference" };
  candidate: OutputRef & { backend: string };
  thresholds: { path: string; file: string; sha256: string | null; error: string | null; calibration: unknown };
  tools: { ffmpeg: string; libvmaf: boolean | null };
  sampling: Measurements["sampling"];
  streams: { reference: Measurements["reference"]; candidate: Measurements["candidate"] };
  checks: FidelityChecks | null;
  measurementErrors: Measurements["errors"];
  peakRssBytes: number;
  wallMs: number;
}

/** JSON with ±Infinity spelled "inf"/"-inf" (identical frames have infinite PSNR). */
export function toJson(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => (x === Infinity ? "inf" : x === -Infinity ? "-inf" : typeof x === "bigint" ? x.toString() : x), 2) + "\n";
}

let ffmpegVersion: string | null = null;
export async function toolVersion(): Promise<string> {
  if (ffmpegVersion === null) {
    try {
      const r = await runTool(FFMPEG, ["-hide_banner", "-version"]);
      ffmpegVersion = r.stdout.toString("utf8").split("\n")[0]!.trim();
    } catch (e) {
      ffmpegVersion = `unavailable: ${(e as Error).message}`;
    }
  }
  return ffmpegVersion;
}

export function repoRelative(p: string): string {
  const r = relative(REPO_ROOT, p).replace(/\\/g, "/");
  return r.startsWith("..") ? p.replace(/\\/g, "/").split("/").slice(-4).join("/") : r;
}

/** Everything the comparator needs to know about a fixture, from its source and the fidelity manifest. */
export function fixtureContext(id: string): { ctx: CompareContext; fx: ResolvedFixture } {
  const entry = loadManifest("all").find((f) => f.id === id);
  if (!entry) throw new Error(`unknown fixture ${id}`);
  const fx = resolveFixture(entry);
  const fps = parseRational(fx.meta.renderConfig.fps);
  const settings = { fps: ratToString(fps), format: fx.meta.renderConfig.format ?? "mp4", hdr: !!fx.meta.renderConfig.hdr, motionBlur: fx.meta.renderConfig.motionBlur ?? null };
  const html = readFileSync(join(fx.dir, "src", "index.html"), "utf8");
  return {
    fx,
    ctx: { fixture: id, fps, seed: seedFor(hashFixtureSource(fx), settings), cutTimes: cutTimesFromHtml(html), spec: loadFidelitySpec(id) },
  };
}

export function buildRecord(opts: {
  fixture: string;
  judgement: Judgement | null;
  measurements: Measurements | null;
  reference: OutputRef;
  candidate: OutputRef & { backend: string };
  thresholds: { path: string; loaded: LoadedThresholds | { error: string; file: string } };
  tools: FidelityRecord["tools"];
  overrideVerdict?: { verdict: Verdict; reasons: Reason[] };
}): FidelityRecord {
  const t = opts.thresholds.loaded;
  const m = opts.measurements;
  return {
    schema: FIDELITY_SCHEMA,
    generatedAt: new Date().toISOString(),
    fixture: opts.fixture,
    verdict: opts.overrideVerdict?.verdict ?? opts.judgement?.verdict ?? "FAIL",
    reasons: opts.overrideVerdict?.reasons ?? opts.judgement?.reasons ?? ["CHECK_ERROR"],
    reference: { ...opts.reference, backend: "chromium-reference" },
    candidate: opts.candidate,
    thresholds: {
      path: opts.thresholds.path,
      file: repoRelative(t.file),
      sha256: "sha256" in t ? t.sha256 : null,
      error: "error" in t ? t.error : null,
      calibration: "data" in t ? t.data.calibration : null,
    },
    tools: opts.tools,
    sampling: m?.sampling ?? null,
    streams: { reference: m?.reference ?? null, candidate: m?.candidate ?? null },
    checks: opts.judgement?.checks ?? null,
    measurementErrors: m?.errors ?? {},
    peakRssBytes: m?.peakRssBytes ?? 0,
    wallMs: m?.wallMs ?? 0,
  };
}

/** Write `fidelity` into a raw run JSON and mark it `turbo-bench-run/2`. Never rewrites anything else. */
export function attachToRun(runJsonPath: string, record: FidelityRecord): void {
  if (!existsSync(runJsonPath)) throw new Error(`no run record at ${runJsonPath}`);
  const run = JSON.parse(readFileSync(runJsonPath, "utf8")) as Record<string, unknown>;
  if (run.schema !== RUN_SCHEMA_V1 && run.schema !== RUN_SCHEMA_V2) throw new Error(`${runJsonPath}: unknown run schema ${String(run.schema)}`);
  run.schema = RUN_SCHEMA_V2;
  run.fidelity = JSON.parse(toJson(record));
  writeFileSync(runJsonPath, JSON.stringify(run, null, 2));
}

const f = (v: unknown, d = 2): string => (v === "inf" || v === Infinity ? "∞" : v === "-inf" || v === -Infinity ? "−∞" : typeof v === "number" && Number.isFinite(v) ? v.toFixed(d) : "—");

/** Markdown summary of a set of fidelity records. */
export function renderMarkdown(title: string, records: FidelityRecord[], context: string[]): string {
  const L = [`# ${title}`, "", ...context, ""];
  L.push("| fixture | verdict | reasons | frames ref/cand | sampled | worst sampled PSNR dB | worst sampled SSIM | worst-frame PSNR (all frames) dB | VMAF min | A/V drift ms | wall s | peak RSS MiB |");
  L.push("|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const r of records) {
    const px = (r.checks?.pixels.details as { frames?: Array<{ psnrDb: number; ssim: number }> } | undefined)?.frames ?? [];
    const enc = r.checks?.encoded.details as { psnrMinDb?: number; vmaf?: { min: number } | null } | undefined;
    const au = r.checks?.audio.details as { avDriftMs?: number | null } | undefined;
    L.push(
      `| ${r.fixture} | **${r.verdict}** | ${r.reasons.join(", ") || "—"} | ${r.streams.reference?.frames ?? "—"}/${r.streams.candidate?.frames ?? "—"} | ${px.length} | ${f(px.length ? Math.min(...px.map((p) => p.psnrDb)) : NaN)} | ${f(px.length ? Math.min(...px.map((p) => p.ssim)) : NaN, 6)} | ${f(enc?.psnrMinDb)} | ${f(enc?.vmaf?.min, 3)} | ${f(au?.avDriftMs)} | ${f(r.wallMs / 1000, 1)} | ${f(r.peakRssBytes / 2 ** 20, 0)} |`,
    );
  }
  L.push("");
  const failing = records.filter((r) => r.verdict !== "PASS");
  if (failing.length) {
    L.push("## Non-PASS details", "");
    for (const r of failing) {
      L.push(`### ${r.fixture}: ${r.verdict}`, "");
      for (const [name, c] of Object.entries(r.checks ?? {})) {
        if (c.verdict === "PASS" || c.verdict === "NOT_APPLICABLE") continue;
        L.push(`- **${name}** ${c.verdict}: ${c.notes.slice(0, 5).join("; ")}${c.notes.length > 5 ? ` (+${c.notes.length - 5} more)` : ""}`);
      }
      if (!r.checks) L.push(`- ${r.reasons.join(", ")}: ${Object.values(r.measurementErrors).join("; ") || r.thresholds.error || "see record"}`);
      L.push("");
    }
  }
  return L.join("\n");
}
