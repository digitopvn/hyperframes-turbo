/**
 * Prints every range quoted in docs/adr/0001-*.md, computed from summary.json,
 * so prose numbers can be checked against raw data instead of transcribed by
 * hand. Writes `adr-facts.json` next to the summary.
 *
 *   node --import ./upstream/hyperframes/node_modules/tsx/dist/loader.mjs \
 *     benchmarks/src/adr-facts.ts benchmarks/results/<dir>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CellSummary } from "./report.js";

const dir = process.argv[2];
if (!dir) throw new Error("usage: adr-facts.ts <results-dir>");
const summary = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
const cells: CellSummary[] = summary.cells.filter((c: CellSummary) => c.instrumented);
const isHdr = (c: CellSummary) => c.facts.capturePath === "hdr_layered";
const sdr = cells.filter((c) => !isHdr(c));
const hdr = cells.filter(isHdr);

type Pick = (c: CellSummary) => number | null | undefined;
function range(set: CellSummary[], pick: Pick) {
  const vals = set
    .map((c) => ({ cell: `${c.fixture}/${c.profile}`, v: pick(c) }))
    .filter((x): x is { cell: string; v: number } => typeof x.v === "number" && Number.isFinite(x.v));
  if (!vals.length) return null;
  const lo = vals.reduce((a, b) => (b.v < a.v ? b : a));
  const hi = vals.reduce((a, b) => (b.v > a.v ? b : a));
  return { min: lo.v, minCell: lo.cell, max: hi.v, maxCell: hi.cell, n: vals.length };
}

const med = (k: keyof CellSummary["warm"]) => (c: CellSummary) => c.warm[k]?.median;
const share = (c: CellSummary) => {
  const w = c.warm;
  return w.captureMs?.median != null && w.wallMs?.median ? w.captureMs.median / w.wallMs.median : null;
};
const byProfile = (fixture: string, profile: string) => cells.find((c) => c.fixture === fixture && c.profile === profile);
const fixtures = [...new Set(cells.map((c) => c.fixture))];
const cliVsProducer = fixtures.map((f) => {
  const a = byProfile(f, "producer-default")?.warm.wallMs?.median;
  const b = byProfile(f, "cli-local-default")?.warm.wallMs?.median;
  return { fixture: f, producerMs: a, cliMs: b, cliDeltaPct: a && b ? ((b - a) / a) * 100 : null };
});

const facts = {
  source: join(dir, "summary.json"),
  sdrCaptureModes: [...new Set(sdr.map((c) => `${c.facts.captureMode}/${c.facts.capturePath}`))],
  drawElementClampReasons: Object.fromEntries(cells.map((c) => [`${c.fixture}/${c.profile}`, c.facts.drawElementClampReason])),
  sdrRenderFactor: range(sdr, med("renderFactor")),
  hdrRenderFactor: range(hdr, med("renderFactor")),
  hdrFps: range(hdr, med("fps")),
  sdrCaptureShareOfWall: range(sdr, share),
  sdrCaptureSetupMs: range(sdr, med("captureSetupMs")),
  sdrEncodeMs: range(sdr, med("encodeMs")),
  overlapMs: range(cells, med("overlapMs")),
  cellsWithInferredEncode: cells.filter((c) => c.representativeTrace?.inferredPhases.length).map((c) => `${c.fixture}/${c.profile}`),
  sdrCaptureRpcP50Ms: range(sdr, med("captureRpcP50Ms")),
  sdrFrameRpcKiBPerFrame: range(sdr, (c) =>
    c.warm.frameRpcResponseBytes?.median != null && c.facts.frames ? c.warm.frameRpcResponseBytes.median / c.facts.frames / 1024 : null,
  ),
  hdrCdpInMiB: range(hdr, (c) => (c.warm.cdpInboundBytes?.median ?? NaN) / 2 ** 20),
  hdrCdpOutMiB: range(hdr, (c) => (c.warm.cdpOutboundBytes?.median ?? NaN) / 2 ** 20),
  hdrDiskWriteGiB: range(hdr, (c) => (c.warm.ioWriteBytes?.median ?? NaN) / 2 ** 30),
  sdrDiskWriteMiB: range(sdr, (c) => (c.warm.ioWriteBytes?.median ?? NaN) / 2 ** 20),
  hdrCpuSeconds: range(hdr, med("cpuSeconds")),
  sdrCpuSeconds: range(sdr, med("cpuSeconds")),
  cpuSecondsPerOutputMin: range(cells, med("cpuSecondsPerOutputMin")),
  estUsdPerOutputMin: range(cells, med("estUsdPerOutputMin")),
  coldVideoExtractMs: range(cells.filter((c) => (c.cold?.extractCacheMisses ?? 0) > 0), (c) => c.cold?.videoExtractMs),
  warmVideoExtractMs: range(cells.filter((c) => (c.cold?.extractCacheMisses ?? 0) > 0), med("videoExtractMs")),
  peakTreeWorkingSetMiB: range(cells, med("peakTreeWorkingSetMb")),
  peakVramDeltaMiB: range(cells, med("peakVramDeltaMiB")),
  warmCv: range(cells, (c) => c.warm.wallMs?.cv),
  cliVsProducer,
  cliSlowerCount: cliVsProducer.filter((x) => (x.cliDeltaPct ?? 0) > 0).length,
  harnessOverheadWarmPct: range(
    (summary.harnessOverhead ?? []).map((o: any) => ({ fixture: o.fixture, profile: o.profile, warm: { o: { median: o.warmMedianOverheadPct } } })) as any,
    (c: any) => c.warm.o.median,
  ),
  harnessOverheadColdPct: range(
    (summary.harnessOverhead ?? []).map((o: any) => ({ fixture: o.fixture, profile: o.profile, warm: { o: { median: o.coldOverheadPct } } })) as any,
    (c: any) => c.warm.o.median,
  ),
};
writeFileSync(join(dir, "adr-facts.json"), JSON.stringify(facts, null, 2) + "\n");
console.log(JSON.stringify(facts, null, 2));
