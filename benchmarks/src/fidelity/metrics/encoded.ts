/**
 * Encoded-output quality over EVERY frame (full sequence, full frame) with
 * FFmpeg's own filters on the native decoded planes: per-frame PSNR and SSIM
 * (mean and worst frame), optional VMAF, and container bitrate.
 *
 * VMAF is a perceptual model trained on natural video. It is computed only for
 * SDR outputs without alpha and is never the only gate: PSNR/SSIM and the
 * decoded-pixel checks always run alongside it.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inputArgs, type MediaProbe } from "../probe.js";
import { FFMPEG, runTool } from "../proc.js";

export interface EncodedAnalysis {
  frames: number;
  psnrMeanDb: number;
  psnrMinDb: number;
  ssimMean: number;
  ssimMin: number;
  vmaf: { mean: number; min: number; p5: number; model: string } | null;
  /** Why VMAF is null: not applicable to this output, or the tool is missing. */
  vmafSkipped: "not-applicable" | "tool-unavailable" | "disabled" | null;
  referenceBitRate: number | null;
  candidateBitRate: number | null;
  /** (candidate - reference) / reference * 100; negative = candidate smaller. */
  bitRateDeltaPct: number | null;
}

let vmafAvailable: boolean | null = null;
export async function hasLibvmaf(): Promise<boolean> {
  if (process.env.FIDELITY_DISABLE_VMAF === "1") return false;
  if (vmafAvailable === null) {
    const r = await runTool(FFMPEG, ["-hide_banner", "-filters"], { allowFailure: true });
    vmafAvailable = /\blibvmaf\b/.test(r.stdout.toString("utf8"));
  }
  return vmafAvailable;
}

const finite = (v: string | undefined): number => (v === undefined ? NaN : v === "inf" ? Infinity : Number(v));

function parseStats(file: string, key: RegExp): number[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .map((l) => key.exec(l)?.[1])
    .filter((v): v is string => v !== undefined)
    .map(finite);
}

export async function analyzeEncoded(ref: MediaProbe, cand: MediaProbe, opts: { vmafApplicable: boolean }): Promise<EncodedAnalysis> {
  const work = mkdtempSync(join(tmpdir(), "turbo-fidelity-enc-"));
  try {
    const pre = "[0:v]setpts=PTS-STARTPTS[c];[1:v]setpts=PTS-STARTPTS[r];[c]split[c1][c2];[r]split[r1][r2]";
    // Relative stats paths + cwd: FFmpeg filter arguments cannot carry a Windows drive colon.
    await runTool(
      FFMPEG,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        ...inputArgs(cand.input, null),
        ...inputArgs(ref.input, null),
        "-filter_complex",
        `${pre};[c1][r1]psnr=stats_file=psnr.log[o1];[c2][r2]ssim=stats_file=ssim.log[o2]`,
        "-map",
        "[o1]",
        "-f",
        "null",
        "-",
        "-map",
        "[o2]",
        "-f",
        "null",
        "-",
      ],
      { cwd: work },
    );
    const psnr = parseStats(join(work, "psnr.log"), /psnr_avg:(\S+)/);
    const ssim = parseStats(join(work, "ssim.log"), /All:(\S+)/);
    if (!psnr.length || !ssim.length) throw new Error("FFmpeg psnr/ssim produced no per-frame stats");
    let vmaf: EncodedAnalysis["vmaf"] = null;
    let vmafSkipped: EncodedAnalysis["vmafSkipped"] = null;
    if (!opts.vmafApplicable) vmafSkipped = "not-applicable";
    else if (process.env.FIDELITY_DISABLE_VMAF === "1") vmafSkipped = "disabled";
    else if (!(await hasLibvmaf())) vmafSkipped = "tool-unavailable";
    else {
      await runTool(
        FFMPEG,
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostdin",
          ...inputArgs(cand.input, null),
          ...inputArgs(ref.input, null),
          "-filter_complex",
          "[0:v]setpts=PTS-STARTPTS[c];[1:v]setpts=PTS-STARTPTS[r];[c][r]libvmaf=log_fmt=json:log_path=vmaf.json:n_threads=4",
          "-f",
          "null",
          "-",
        ],
        { cwd: work },
      );
      const j = JSON.parse(readFileSync(join(work, "vmaf.json"), "utf8")) as {
        version?: string;
        frames?: Array<{ metrics?: { vmaf?: number } }>;
        pooled_metrics?: { vmaf?: { mean?: number; min?: number } };
      };
      const per = (j.frames ?? []).map((f) => f.metrics?.vmaf).filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
      if (!per.length || typeof j.pooled_metrics?.vmaf?.mean !== "number") throw new Error("libvmaf log has no per-frame scores");
      vmaf = { mean: j.pooled_metrics.vmaf.mean, min: per[0]!, p5: per[Math.floor(per.length * 0.05)]!, model: `libvmaf ${j.version ?? "?"} default model` };
    }
    const rb = ref.bitRate;
    const cb = cand.bitRate;
    return {
      frames: psnr.length,
      psnrMeanDb: meanPsnr(psnr),
      psnrMinDb: Math.min(...psnr),
      ssimMean: ssim.reduce((a, b) => a + b, 0) / ssim.length,
      ssimMin: Math.min(...ssim),
      vmaf,
      vmafSkipped,
      referenceBitRate: rb,
      candidateBitRate: cb,
      bitRateDeltaPct: rb && cb !== null ? ((cb - rb) / rb) * 100 : null,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Mean PSNR over frames that differ; Infinity only when every frame is identical. */
function meanPsnr(v: number[]): number {
  if (v.every((x) => x === Infinity)) return Infinity;
  const f = v.filter(Number.isFinite);
  return f.reduce((a, b) => a + b, 0) / f.length;
}
