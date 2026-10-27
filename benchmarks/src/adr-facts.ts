/**
 * Prints every range quoted in docs/adr/0001-*.md, computed from summary.json,
 * so prose numbers can be checked against raw data instead of transcribed by
 * hand. Writes `adr-facts.json` next to the summary.
 *
 *   node --import ./upstream/hyperframes/node_modules/tsx/dist/loader.mjs \
 *     benchmarks/src/adr-facts.ts benchmarks/results/<dir>
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
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
  return rangeOf(set.map((c) => ({ cell: `${c.fixture}/${c.profile}`, v: pick(c) })));
}
function rangeOf(items: Array<{ cell: string; v: number | null | undefined }>) {
  const vals = items.filter((x): x is { cell: string; v: number } => typeof x.v === "number" && Number.isFinite(x.v));
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

interface Overhead {
  fixture: string;
  profile: string;
  warmMedianOverheadPct: number | null;
  coldOverheadPct: number | null;
  controlWarmCv: number | null;
  instrumentedWarmCv: number | null;
}
function overheadRange(k: "warmMedianOverheadPct" | "coldOverheadPct") {
  const rows: Overhead[] = summary.harnessOverhead ?? [];
  return {
    ...rangeOf(rows.map((o) => ({ cell: `${o.fixture}/${o.profile}`, v: o[k] }))),
    perCell: rows.map((o) => ({ cell: `${o.fixture}/${o.profile}`, pct: o[k], controlCv: o.controlWarmCv, instrumentedCv: o.instrumentedWarmCv })),
  };
}

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
  harnessOverheadWarmPct: overheadRange("warmMedianOverheadPct"),
  harnessOverheadColdPct: overheadRange("coldOverheadPct"),
  mixedPathCells: summary.cells
    .filter((c: CellSummary) => c.mixedPath)
    .map((c: CellSummary) => ({
      cell: `${c.fixture}/${c.profile}`,
      groups: c.pathGroups.map((g) => ({ capturePath: g.capturePath, workers: g.workers, runs: g.runs, setupMedianMs: g.warm.captureSetupMs?.median ?? null, wallMedianMs: g.warm.wallMs?.median ?? null })),
    })),
  // Per capture path across every SDR cell (instrumented and control), so
  // bimodal cells are never summarised by a pooled median.
  ...Object.fromEntries(
    ["disk", "streaming"].flatMap((path) => {
      const groups = (summary.cells as CellSummary[])
        .filter((c) => !isHdr(c))
        .flatMap((c) => c.pathGroups.filter((g) => g.capturePath === path).map((g) => ({ cell: `${c.fixture}/${c.profile}`, g })));
      const r = (pick: (g: CellSummary["pathGroups"][number]) => number | null | undefined) =>
        rangeOf(groups.map(({ cell, g }) => ({ cell, v: pick(g) })));
      return [
        [`${path}PathWorkers`, [...new Set(groups.map(({ g }) => g.workers))]],
        [`${path}PathWarmRuns`, groups.reduce((a, { g }) => a + g.runs.length, 0)],
        [`${path}PathSetupMs`, r((g) => g.warm.captureSetupMs?.median)],
        [`${path}PathFramesMs`, r((g) => g.warm.captureFrameMs?.median)],
        [`${path}PathWallMs`, r((g) => g.warm.wallMs?.median)],
      ];
    }),
  ),
  // Only the cells whose warm runs flipped between paths.
  ...Object.fromEntries(
    ["disk", "streaming"].flatMap((path) => {
      const groups = (summary.cells as CellSummary[])
        .filter((c) => c.mixedPath)
        .flatMap((c) => c.pathGroups.filter((g) => g.capturePath === path).map((g) => ({ cell: `${c.fixture}/${c.profile}`, g })));
      return [
        [`mixedCells_${path}SetupMs`, rangeOf(groups.map(({ cell, g }) => ({ cell, v: g.warm.captureSetupMs?.median })))],
        [`mixedCells_${path}WallMs`, rangeOf(groups.map(({ cell, g }) => ({ cell, v: g.warm.wallMs?.median })))],
      ];
    }),
  ),
  // From runs.csv: every run's capture path against upstream's calibration-failure warning.
  calibrationVsPath: (() => {
    const [head, ...rows] = readFileSync(join(dir, "runs.csv"), "utf8").trim().split("\n").map((l) => l.split(","));
    const ix = (k: string) => head!.indexOf(k);
    const out: Record<string, number> = {};
    for (const r of rows) {
      const k = `${r[ix("capturePath")] || "none"}/calibrationFailed=${r[ix("calibrationFailed")]}`;
      out[k] = (out[k] ?? 0) + 1;
    }
    return out;
  })(),
  // From raw runs: calibration failures split by kind, with upstream's error text.
  calibrationFailures: (() => {
    const out = { cold: 0, warm: 0, errors: {} as Record<string, number>, renderFailures: {} as Record<string, number> };
    const raw = join(dir, "raw");
    for (const f of readdirSync(raw)) {
      for (const v of readdirSync(join(raw, f))) {
        for (const file of readdirSync(join(raw, f, v)).filter((n) => n.endsWith(".json"))) {
          const r = JSON.parse(readFileSync(join(raw, f, v, file), "utf8"));
          if (r.error) {
            const k = String(r.error).split("\n")[0]!;
            out.renderFailures[k] = (out.renderFailures[k] ?? 0) + 1;
          }
          const w = (r.upstreamLog?.warnMeta ?? []).find((x: { message: string }) => x.message.includes("calibration failed"));
          if (!w) continue;
          out[r.kind === "cold" ? "cold" : "warm"]++;
          const k = `${w.meta?.error ?? "?"} (protocolTimeout ${w.meta?.protocolTimeout ?? "?"})`;
          out.errors[k] = (out.errors[k] ?? 0) + 1;
        }
      }
    }
    return out;
  })(),
  mixedCellCount: (summary.cells as CellSummary[]).filter((c) => c.mixedPath).length,
  sdrCellCount: (summary.cells as CellSummary[]).filter((c) => !isHdr(c)).length,
  // Instrumented vs control, compared only within the same capture path.
  pathMatchedOverheadPct: (summary.cells as CellSummary[])
    .filter((c) => c.instrumented && !isHdr(c))
    .flatMap((c) => {
      const ctl = (summary.cells as CellSummary[]).find((x) => !x.instrumented && x.fixture === c.fixture && `${c.profile}.control` === x.profile);
      if (!ctl) return [];
      return c.pathGroups.flatMap((g) => {
        const h = ctl.pathGroups.find((x) => x.capturePath === g.capturePath && x.workers === g.workers);
        const a = g.warm.wallMs?.median;
        const b = h?.warm.wallMs?.median;
        return a != null && b ? [{ cell: `${c.fixture}/${c.profile}`, path: g.capturePath, nInstrumented: g.runs.length, nControl: h!.runs.length, pct: ((a - b) / b) * 100 }] : [];
      });
    }),
  concurrency: range(cells, (c) => c.representativeTrace?.concurrencyFactor),
  concurrencyInferredCells: range(
    cells.filter((c) => c.representativeTrace?.inferredPhases.length),
    (c) => c.representativeTrace?.concurrencyFactor,
  ),
  diskSetupExceedsFrames: (() => {
    const disk = sdr.filter((c) => c.facts.capturePath === "disk");
    const over = disk.filter((c) => (c.warm.captureSetupMs?.median ?? 0) > (c.warm.captureFrameMs?.median ?? Infinity));
    return { over: over.length, of: disk.length, cells: over.map((c) => `${c.fixture}/${c.profile}`) };
  })(),
};
writeFileSync(join(dir, "adr-facts.json"), JSON.stringify(facts, null, 2) + "\n");
console.log(JSON.stringify(facts, null, 2));
