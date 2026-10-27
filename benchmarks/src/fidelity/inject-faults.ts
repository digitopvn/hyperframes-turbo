/**
 * Fault injection: derive deliberately broken candidates from a real
 * reference output and prove the gate catches each one with the right reason.
 *
 * Frame-level faults (drop, duplicate, reorder, stale, pixel corruption,
 * wrong fps, VFR) decode the source to raw frames, rewrite the frame sequence
 * in Node and re-encode LOSSLESSLY (x264 qp 0 for H.264, x265 lossless with
 * the HDR SEI re-emitted for HEVC 10-bit, libvpx-vp9 lossless with the alpha
 * plane for VP9 alpha) with the source's colour tags and time scale, so the
 * injected defect is the only difference. Near-threshold faults (A/V offsets
 * of 22/25/30 ms, a ±2 code-value luma block, the least distinct stale frame)
 * measure sensitivity next to the large ones. Container
 * faults (missing audio, HDR metadata) are stream copies; resolution, bitrate,
 * alpha and audio-offset faults re-encode only what they change.
 *
 *   inject-faults.ts --results <dir> [--cell producer-default] [--ref-run 1]
 *                    [--source-run 2] [--path <p>] [--fixtures a,b] [--out <dir>]
 * Writes <out>/<path>.json and .md (default benchmarks/fidelity/negative-results).
 * Exit 1 if any fault is missed or the unmodified control does not pass.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BENCH_ROOT } from "../fixtures.js";
import { parseArgs, UsageError } from "./cli-args.js";
import type { CompareContext } from "./compare.js";
import { decodeThumbnails } from "./decode.js";
import { ANALYSIS_RATE } from "./metrics/audio.js";
import { thumbMse } from "./metrics/pixels.js";
import { hasAlpha, inputArgs, probeMedia, type MediaProbe } from "./probe.js";
import { FFMPEG, FFPROBE, runTool, spawnTool } from "./proc.js";
import { ratToString } from "./rational.js";
import { buildSamplePlan } from "./sample-plan.js";
import { evaluate, keptOutput } from "./run-fidelity.js";
import { fixtureContext, repoRelative, toJson, type FidelityRecord } from "./schema.js";
import { loadThresholds, pathName, toNum, type FixtureThresholds } from "./thresholds.js";
import type { Reason } from "./verdict.js";

export type FaultKind =
  | "dropped-frame"
  | "duplicated-frame"
  | "reordered-frames"
  | "stale-frame"
  | "stale-frame-subtle"
  | "pixel-corruption-sampled"
  | "pixel-corruption-unsampled"
  | "pixel-subtle-sampled"
  | "pixel-subtle-unsampled"
  | "wrong-resolution"
  | "wrong-fps"
  | "vfr-timestamps"
  | "bitrate-drop"
  | "alpha-stripped"
  | "hdr-metadata-stripped"
  | "hdr-sei-stripped"
  | "hdr-max-cll-changed"
  | "audio-offset"
  | "audio-offset-22ms"
  | "audio-offset-25ms"
  | "audio-offset-30ms"
  | "missing-audio";

/** The gate must FAIL with at least one of these reasons. */
export const EXPECTED: Record<FaultKind, Reason[]> = {
  "dropped-frame": ["FRAME_DROPPED"],
  "duplicated-frame": ["FRAME_DUPLICATED"],
  "reordered-frames": ["FRAME_REORDERED"],
  "stale-frame": ["STALE_FRAME"],
  "stale-frame-subtle": ["STALE_FRAME"],
  "pixel-corruption-sampled": ["PIXEL_BELOW_THRESHOLD"],
  "pixel-corruption-unsampled": ["ENCODED_QUALITY_BELOW_THRESHOLD"],
  "pixel-subtle-sampled": ["PIXEL_BELOW_THRESHOLD"],
  "pixel-subtle-unsampled": ["ENCODED_QUALITY_BELOW_THRESHOLD"],
  "wrong-resolution": ["DIMENSION_CHANGED"],
  "wrong-fps": ["FPS_CHANGED"],
  "vfr-timestamps": ["VFR_DETECTED", "PTS_DRIFT"],
  "bitrate-drop": ["BITRATE_DROP"],
  "alpha-stripped": ["ALPHA_MISSING"],
  "hdr-metadata-stripped": ["HDR_TRANSFER_MISMATCH", "HDR_METADATA_MISMATCH"],
  "hdr-sei-stripped": ["HDR_METADATA_MISMATCH"],
  "hdr-max-cll-changed": ["HDR_METADATA_MISMATCH"],
  "audio-offset": ["AV_DRIFT"],
  "audio-offset-22ms": ["AV_DRIFT"],
  "audio-offset-25ms": ["AV_DRIFT"],
  "audio-offset-30ms": ["AV_DRIFT"],
  "missing-audio": ["AUDIO_MISSING"],
};

/** Audio delay injected by each audio-offset fault, ms. The floor of the A/V limit is one AAC frame (21.33 ms at 48 kHz). */
export const AUDIO_OFFSET_MS: Partial<Record<FaultKind, number>> = { "audio-offset": 40, "audio-offset-22ms": 22, "audio-offset-25ms": 25, "audio-offset-30ms": 30 };

/** Luma change of the subtle pixel faults: +SUBTLE_LUMA_DELTA 8-bit code values (scaled for 10-bit) on a SUBTLE_BLOCK x SUBTLE_BLOCK block. */
export const SUBTLE_LUMA_DELTA = 2;
export const SUBTLE_BLOCK = 64;

/**
 * Near-threshold faults: magnitudes chosen just above what a bit-exact path
 * can tolerate, to measure sensitivity rather than to break things visibly.
 * Whether each must be caught is decided by `nearThresholdRequirement`;
 * otherwise its outcome is recorded as informational, never silently dropped.
 */
export const NEAR_THRESHOLD = new Set<FaultKind>(["stale-frame-subtle", "pixel-subtle-sampled", "pixel-subtle-unsampled", "audio-offset-22ms", "audio-offset-25ms", "audio-offset-30ms"]);

/**
 * Whether a near-threshold fault must be caught on this fixture, and why.
 * - A/V offsets: required when the delay exceeds the calibrated A/V limit by
 *   more than the lag resolution (1 / ANALYSIS_RATE s).
 * - Pixel and temporal: required on a bit-exact fixture (every limit is the
 *   exact reference value, so any change exceeds it). On a non-deterministic
 *   fixture the change may sit inside the calibrated reference noise, so the
 *   outcome is informational there.
 */
export function nearThresholdRequirement(fault: FaultKind, t: FixtureThresholds | null): { required: boolean; why: string } {
  if (!t) return { required: true, why: "no thresholds: the gate must fail closed" };
  const offset = AUDIO_OFFSET_MS[fault];
  if (offset !== undefined) {
    if (!t.audio) return { required: true, why: "audio not calibrated: the gate must fail closed" };
    const limit = toNum(t.audio.maxAvDriftMs.limit);
    const resolution = 1000 / ANALYSIS_RATE;
    const required = offset > limit + resolution;
    return { required, why: `${offset} ms ${required ? ">" : "<="} A/V limit ${limit.toFixed(2)} ms + ${resolution} ms resolution` };
  }
  return t.bitExact ? { required: true, why: "bit-exact fixture: every limit is exact" } : { required: false, why: "non-deterministic fixture: change may lie within calibrated reference noise" };
}

/**
 * Faults that change exactly one property: the gate must FAIL with these
 * reasons and no other, so a different check cannot catch them by accident.
 */
export const ONLY: Partial<Record<FaultKind, Reason[]>> = {
  "hdr-sei-stripped": ["HDR_METADATA_MISMATCH"],
  "hdr-max-cll-changed": ["HDR_METADATA_MISMATCH"],
};

/** Whether the gate caught `fault`: FAIL, with an expected reason, and (for single-property faults) nothing else. */
export function faultCaught(fault: FaultKind, rec: { verdict: string; reasons: Reason[] }): boolean {
  if (rec.verdict !== "FAIL" || !EXPECTED[fault].some((r) => rec.reasons.includes(r))) return false;
  const only = ONLY[fault];
  return !only || rec.reasons.every((r) => only.includes(r));
}

/** In-band (SEI) content light level of the first frame that carries one. */
function seiContentLight(p: MediaProbe): { maxContent: number; maxAverage: number; frames: number } | null {
  const per = p.video!.frameSideData.map((l) => l.find((s) => /content light/i.test(String(s.side_data_type ?? ""))));
  const first = per.find(Boolean);
  if (!first) return null;
  const maxContent = Number(first.max_content);
  const maxAverage = Number(first.max_average);
  if (!Number.isInteger(maxContent) || !Number.isInteger(maxAverage)) return null;
  return { maxContent, maxAverage, frames: per.filter(Boolean).length };
}

const hasSeiHdrMetadata = (p: MediaProbe) => p.video!.frameSideData.some((l) => l.some((s) => /mastering display|content light/i.test(String(s.side_data_type ?? ""))));

const FRAME_REWRITE: FaultKind[] = [
  "dropped-frame",
  "duplicated-frame",
  "reordered-frames",
  "stale-frame",
  "stale-frame-subtle",
  "pixel-corruption-sampled",
  "pixel-corruption-unsampled",
  "pixel-subtle-sampled",
  "pixel-subtle-unsampled",
  "wrong-fps",
  "vfr-timestamps",
];

/** Faults that need a visually distinct frame neighbourhood (`pickFaultFrame`). */
const NEEDS_DISTINCT_FRAME = new Set<FaultKind>(["dropped-frame", "duplicated-frame", "reordered-frames", "stale-frame"]);

/** Bytes per raw frame for the native planar formats the rewriter supports. */
function nativeFrameBytes(pixFmt: string, w: number, h: number): number | null {
  if (pixFmt === "yuv420p") return (w * h * 3) / 2;
  if (pixFmt === "yuva420p") return (w * h * 5) / 2;
  if (pixFmt === "yuv420p10le") return w * h * 3;
  return null;
}

/**
 * Lossless re-encoder for each stream kind the frame rewriter supports, so a
 * rewritten frame sequence differs from the source only by the injected
 * defect. null = frame faults are not injectable into this stream.
 * - H.264 yuv420p: x264 qp 0.
 * - HEVC 10-bit (yuv420p10le): x265 lossless, with the source's VUI colour
 *   tags and its mastering-display / content-light SEI re-emitted.
 * - VP9 with alpha (yuva420p, libvpx-decoded): libvpx-vp9 lossless; libvpx
 *   writes the alpha plane as the WebM BlockAdditional side channel.
 */
export function losslessVideoEncoder(p: MediaProbe): string[] | null {
  const v = p.video;
  if (!v || p.isImageSequence) return null;
  if (v.codec === "h264" && v.pixFmt === "yuv420p") return ["-c:v", "libx264", "-qp", "0", "-preset", "ultrafast", "-pix_fmt", "yuv420p"];
  if (v.codec === "hevc" && v.pixFmt === "yuv420p10le") {
    const hdr = x265HdrParams(p);
    return ["-c:v", "libx265", "-preset", "ultrafast", "-pix_fmt", "yuv420p10le", "-tag:v", "hvc1", "-x265-params", ["lossless=1", "log-level=error", ...hdr].join(":")];
  }
  if (v.codec === "vp9" && hasAlpha(v)) return ["-c:v", "libvpx-vp9", "-lossless", "1", "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1", "-pix_fmt", "yuva420p"];
  return null;
}

/** Raw pixel format the rewriter decodes to (alpha VP9 decodes to yuva420p through libvpx). */
function rewritePixFmt(p: MediaProbe): string {
  const v = p.video!;
  return v.codec === "vp9" && hasAlpha(v) ? "yuva420p" : v.pixFmt;
}

/** ffprobe rational ("34000/50000") or number -> number; NaN when malformed. */
const ratio = (x: unknown): number => {
  const s = String(x ?? "");
  const m = /^(-?\d+)\/(\d+)$/.exec(s);
  return m ? Number(m[1]) / Number(m[2]) : Number(s);
};

/** x265 `master-display` / `max-cll` parameters reproducing the source's HDR static metadata (first frame carrying it, else stream level). */
export function x265HdrParams(p: MediaProbe): string[] {
  const v = p.video!;
  const lists = [...v.frameSideData, v.streamSideData];
  const find = (re: RegExp) => lists.map((l) => l.find((s) => re.test(String(s.side_data_type ?? "")))).find(Boolean);
  const out: string[] = [];
  const md = find(/mastering display/i);
  if (md) {
    const c = (k: string) => Math.round(ratio(md[k]) * 50000);
    const l = (k: string) => Math.round(ratio(md[k]) * 10000);
    const vals = [c("green_x"), c("green_y"), c("blue_x"), c("blue_y"), c("red_x"), c("red_y"), c("white_point_x"), c("white_point_y"), l("max_luminance"), l("min_luminance")];
    if (vals.some((n) => !Number.isFinite(n))) throw new Error(`unparseable mastering display metadata: ${JSON.stringify(md)}`);
    const [gx, gy, bx, by, rx, ry, wx, wy, maxL, minL] = vals;
    out.push(`master-display=G(${gx},${gy})B(${bx},${by})R(${rx},${ry})WP(${wx},${wy})L(${maxL},${minL})`);
  }
  const cll = find(/content light/i);
  if (cll) {
    const mc = Number(cll.max_content);
    const ma = Number(cll.max_average);
    if (!Number.isInteger(mc) || !Number.isInteger(ma)) throw new Error(`unparseable content light metadata: ${JSON.stringify(cll)}`);
    out.push(`max-cll=${mc},${ma}`);
  }
  return out;
}

/** Which faults make sense for this output (a fault the output cannot carry is not applicable, not passed). */
export function applicableFaults(p: MediaProbe, ctx: CompareContext): FaultKind[] {
  const v = p.video!;
  const out: FaultKind[] = [];
  if (losslessVideoEncoder(p)) out.push(...FRAME_REWRITE);
  // Resolution and bitrate faults re-encode with x264, so they stay H.264-only.
  if (v.codec === "h264" && v.pixFmt === "yuv420p" && !p.isImageSequence) out.push("wrong-resolution", "bitrate-drop");
  if (hasAlpha(v) && v.codec === "vp9") out.push("alpha-stripped");
  if (ctx.spec.hdr && v.codec === "hevc") {
    out.push("hdr-metadata-stripped");
    if (hasSeiHdrMetadata(p)) out.push("hdr-sei-stripped");
    if (seiContentLight(p)) out.push("hdr-max-cll-changed");
  }
  if (p.audio && !p.isImageSequence) out.push("audio-offset", "audio-offset-22ms", "audio-offset-25ms", "audio-offset-30ms", "missing-audio");
  return out;
}

function colorArgs(p: MediaProbe): string[] {
  const v = p.video!;
  return [
    ...(v.colorPrimaries ? ["-color_primaries", v.colorPrimaries] : []),
    ...(v.colorTransfer ? ["-color_trc", v.colorTransfer] : []),
    ...(v.colorSpace ? ["-colorspace", v.colorSpace] : []),
    ...(v.colorRange ? ["-color_range", v.colorRange] : []),
  ];
}

/**
 * Frames whose neighbourhood is visually distinct (so a temporal fault there
 * is observable at all), nearest the middle. `tol` is the calibrated
 * thumbnail tolerance; distinct means > 4*tol + 1.
 */
export async function pickFaultFrame(p: MediaProbe, tol: number): Promise<number | null> {
  const th = await decodeThumbnails(p);
  const d = (a: number, b: number) => thumbMse(th[a]!, th[b]!);
  const gap = 4 * tol + 1;
  const mid = Math.floor(th.length / 2);
  for (let off = 0; off < th.length; off++) {
    for (const k of [mid + off, mid - off]) {
      if (k < 2 || k + 2 >= th.length) continue;
      if (d(k, k - 1) > gap && d(k + 1, k) > gap && d(k + 1, k - 1) > gap && d(k + 2, k + 1) > gap && d(k - 1, k - 2) > gap) return k;
    }
  }
  return null;
}

/**
 * Near-threshold temporal fault position: the frame k whose difference from
 * its predecessor is the SMALLEST that is still observable, so replacing it by
 * frame k-1 (a stale frame) is the least visible stale frame the fixture
 * allows. Observable means both d(k, k-1) and d(k+1, k-1) exceed 2*tol (the
 * reference noise of both renders) so the stale frame matches only k-1.
 * Returns the frame and its thumbnail MSE to the predecessor.
 */
export async function pickSubtleStaleFrame(p: MediaProbe, tol: number): Promise<{ k: number; thumbMse: number } | null> {
  const th = await decodeThumbnails(p);
  const d = (a: number, b: number) => thumbMse(th[a]!, th[b]!);
  let best: { k: number; thumbMse: number } | null = null;
  for (let k = 2; k + 2 < th.length; k++) {
    const dk = d(k, k - 1);
    if (dk > 2 * tol && d(k + 1, k - 1) > 2 * tol && (!best || dk < best.thumbMse)) best = { k, thumbMse: dk };
  }
  return best;
}

/** Rewrite the frame sequence: `seq` lists source frame indices in output order. */
async function rewriteFrames(src: MediaProbe, out: string, seq: number[], opts: { fps?: string; mutate?: (outPos: number, frame: Buffer) => Buffer; vf?: string }): Promise<void> {
  const v = src.video!;
  const encoder = losslessVideoEncoder(src);
  if (!encoder) throw new Error(`frame rewrite unsupported for ${v.codec} ${v.pixFmt}`);
  const pixFmt = rewritePixFmt(src);
  const size = nativeFrameBytes(pixFmt, v.width, v.height);
  if (size === null) throw new Error(`rewrite unsupported for ${pixFmt}`);
  const mp4 = /\.(mp4|mov|m4v)$/i.test(out);
  const fps = opts.fps ?? v.rFrameRate;
  // A raw pipe carries neither SAR nor a fine time base: restore the source SAR
  // so only the injected fault differs, and move to the source time base before
  // any timestamp expression so sub-frame shifts are not rounded away.
  // Raw frames are also untagged: give them the source's exact colour
  // description first, so FFmpeg neither converts them nor drops the tags.
  const colour = [
    v.colorRange ? `range=${v.colorRange}` : null,
    v.colorPrimaries ? `color_primaries=${v.colorPrimaries}` : null,
    v.colorTransfer ? `color_trc=${v.colorTransfer}` : null,
    v.colorSpace ? `colorspace=${v.colorSpace}` : null,
  ].filter(Boolean);
  const filters = [
    ...(colour.length ? [`setparams=${colour.join(":")}`] : []),
    ...(opts.vf ? [`settb=1/${v.timeBase.den}`, opts.vf] : []),
    ...(v.sar && /^\d+:\d+$/.test(v.sar) && v.sar !== "0:1" ? [`setsar=${v.sar.replace(":", "/")}`] : []),
  ];
  const enc = await spawnTool(
    FFMPEG,
    [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "rawvideo", "-pix_fmt", pixFmt, "-s", `${v.width}x${v.height}`, "-framerate", fps, "-i", "pipe:0",
      ...inputArgs(src.input, src),
      "-map", "0:v", "-map", "1:a?",
      ...(filters.length ? ["-vf", filters.join(",")] : []),
      // The encoder time base defaults to 1/fps, which would re-quantise shifted timestamps.
      ...(opts.vf ? ["-fps_mode", "passthrough", "-enc_time_base", `1/${v.timeBase.den}`] : []),
      ...encoder, ...colorArgs(src),
      // A muxer option of MP4/MOV only; Matroska/WebM always uses a 1/1000 time base.
      ...(mp4 ? ["-video_track_timescale", String(v.timeBase.den)] : []),
      "-c:a", "copy", out,
    ],
    { stdin: true },
  );
  enc.child.stdout!.resume();
  const dec = await spawnTool(FFMPEG, ["-hide_banner", "-loglevel", "error", ...inputArgs(src.input, src), "-map", "0:v:0", "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", pixFmt, "pipe:1"]);
  const need = new Map<number, number>(); // source index -> remaining uses
  for (const s of seq) need.set(s, (need.get(s) ?? 0) + 1);
  const held = new Map<number, Buffer>();
  let pos = 0;
  const write = async (b: Buffer) => {
    if (!enc.child.stdin!.write(b)) await new Promise<void>((r) => enc.child.stdin!.once("drain", r));
  };
  const flush = async () => {
    while (pos < seq.length && held.has(seq[pos]!)) {
      const s = seq[pos]!;
      const frame = held.get(s)!;
      await write(opts.mutate ? opts.mutate(pos, Buffer.from(frame)) : frame);
      const left = need.get(s)! - 1;
      need.set(s, left);
      if (left === 0) held.delete(s);
      pos++;
    }
  };
  let buf: Buffer = Buffer.alloc(0);
  let idx = 0;
  for await (const chunk of dec.child.stdout! as AsyncIterable<Buffer>) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= size) {
      const frame = Buffer.from(buf.subarray(0, size));
      buf = buf.subarray(size);
      if (need.has(idx)) held.set(idx, frame);
      idx++;
      await flush();
    }
  }
  enc.child.stdin!.end();
  const [d, e] = await Promise.all([dec.done, enc.done]);
  if (d.code !== 0) throw new Error(`fault decode failed: ${d.stderr}`);
  if (e.code !== 0) throw new Error(`fault encode failed: ${e.stderr}`);
  if (pos !== seq.length) throw new Error(`fault rewrite wrote ${pos} of ${seq.length} frames`);
}

/** A different MaxCLL whose two bytes are both non-zero (no new emulation-prevention pattern). */
function nextContentLight(v: number): number {
  for (let n = v + 100; n !== v; n = (n + 1) & 0xffff) if (n >> 8 !== 0 && (n & 0xff) !== 0) return n;
  throw new Error("no replacement MaxCLL value");
}

/**
 * Rewrite MaxCLL in every HEVC content-light-level SEI payload (type 144,
 * size 4: MaxCLL u16, MaxFALL u16), in-band and in hvcC alike. The result is
 * verified by decoding, so a stray match in slice data cannot pass unnoticed.
 */
function patchContentLight(file: Buffer, cll: { maxContent: number; maxAverage: number }, next: number): { file: Buffer; count: number } {
  const needle = Buffer.from([0x90, 0x04, cll.maxContent >> 8, cll.maxContent & 0xff, cll.maxAverage >> 8, cll.maxAverage & 0xff]);
  const out = Buffer.from(file);
  let count = 0;
  for (let i = file.indexOf(needle); i >= 0; i = file.indexOf(needle, i + 1)) {
    out[i + 2] = next >> 8;
    out[i + 3] = next & 0xff;
    count++;
  }
  if (!count) throw new Error("content light SEI payload not found");
  return { file: out, count };
}

const SEI_PREFIX = 39;
const RESERVED_NON_VCL = 41;
const retypeNalHeader = (b: Buffer, at: number) => (b[at] = (b[at]! & 0x81) | (RESERVED_NON_VCL << 1));

/** Byte offset and size of every video packet (ffprobe `pos`/`size`). */
async function videoPacketSpans(path: string): Promise<Array<{ pos: number; size: number }>> {
  const r = await runTool(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pos,size", "-of", "json", path]);
  const raw = ((JSON.parse(r.stdout.toString("utf8")) as { packets?: Array<{ pos?: string; size?: string }> }).packets ?? []).map((p) => ({ pos: Number(p.pos), size: Number(p.size) }));
  if (!raw.length || raw.some((p) => !Number.isInteger(p.pos) || !Number.isInteger(p.size) || p.pos < 0 || p.size < 0)) throw new Error(`${path}: packet positions unavailable`);
  return raw;
}

/**
 * Retype every HEVC prefix-SEI NAL unit to a reserved type, in place: those in
 * the MP4 hvcC box (ISO/IEC 14496-15: 22-byte header with lengthSizeMinusOne
 * at byte 21, numOfArrays, then per array a type byte, numNalus and u16
 * length-prefixed NALs) and those in-band in each length-prefixed sample.
 */
function retypeHevcSei(file: Buffer, packets: Array<{ pos: number; size: number }>): { file: Buffer; config: number; inBand: number } {
  const out = Buffer.from(file);
  const at = out.indexOf("hvcC");
  if (at < 4) throw new Error("no hvcC box (only MP4/MOV HEVC is supported)");
  const end = at - 4 + out.readUInt32BE(at - 4);
  const lengthSize = (out[at + 4 + 21]! & 3) + 1;
  let o = at + 4 + 22;
  const arrays = out[o++]!;
  let config = 0;
  for (let a = 0; a < arrays; a++) {
    const typeAt = o++;
    const sei = (out[typeAt]! & 0x3f) === SEI_PREFIX;
    const nalus = out.readUInt16BE(o);
    o += 2;
    for (let k = 0; k < nalus; k++) {
      const len = out.readUInt16BE(o);
      o += 2;
      if (sei) {
        retypeNalHeader(out, o);
        config++;
      }
      o += len;
    }
    if (sei) out[typeAt] = (out[typeAt]! & 0xc0) | RESERVED_NON_VCL;
    if (o > end) throw new Error("malformed hvcC box");
  }
  let inBand = 0;
  for (const p of packets) {
    for (let q = p.pos; q < p.pos + p.size; ) {
      const len = out.readUIntBE(q, lengthSize);
      q += lengthSize;
      if (len < 2 || q + len > p.pos + p.size) throw new Error(`malformed NAL length at byte ${q - lengthSize}`);
      if (((out[q]! >> 1) & 0x3f) === SEI_PREFIX) {
        retypeNalHeader(out, q);
        inBand++;
      }
      q += len;
    }
  }
  return { file: out, config, inBand };
}
/**
 * Apply `f` to every luma sample of a centred bw x bh block. The luma plane
 * comes first in every supported planar format; >8-bit samples are 16-bit LE
 * and `f` works on the 8-bit scale (shifted to the stream's bit depth).
 */
function editLumaBlock(frame: Buffer, pixFmt: string, w: number, h: number, bw: number, bh: number, f: (y8: number) => number): Buffer {
  const deep = /10le$/.test(pixFmt);
  const max = deep ? 1023 : 255;
  const x0 = Math.floor(w / 2) - (bw >> 1);
  const y0 = Math.floor(h / 2) - (bh >> 1);
  for (let y = y0; y < y0 + bh; y++) {
    for (let x = x0; x < x0 + bw; x++) {
      if (deep) {
        const at = 2 * (y * w + x);
        frame.writeUInt16LE(Math.min(max, Math.max(0, f(frame.readUInt16LE(at) / 4) * 4)), at);
      } else {
        frame[y * w + x] = Math.min(max, Math.max(0, f(frame[y * w + x]!)));
      }
    }
  }
  return frame;
}

/** Paint a 25 % x 25 % white block into the luma plane (visible, local corruption). */
const corruptLuma = (frame: Buffer, pixFmt: string, w: number, h: number) => editLumaBlock(frame, pixFmt, w, h, Math.floor(w / 4), Math.floor(h / 4), () => 235);

/** Raise luma by SUBTLE_LUMA_DELTA code values (8-bit scale) in a SUBTLE_BLOCK square: a near-threshold corruption. */
const subtleLuma = (frame: Buffer, pixFmt: string, w: number, h: number) =>
  editLumaBlock(frame, pixFmt, w, h, Math.min(SUBTLE_BLOCK, w), Math.min(SUBTLE_BLOCK, h), (y) => (y + SUBTLE_LUMA_DELTA <= 235 ? y + SUBTLE_LUMA_DELTA : y - SUBTLE_LUMA_DELTA));

/**
 * Inject `kind` into a copy of `src` written to `out`. `k` is the frame for
 * the temporal faults (`pickFaultFrame`); `subtleK` the frame for
 * stale-frame-subtle (`pickSubtleStaleFrame`).
 */
export async function injectFault(kind: FaultKind, src: MediaProbe, out: string, ctx: CompareContext, k: number, subtleK?: number): Promise<{ detail: string }> {
  const v = src.video!;
  const n = v.frames.length;
  const all = [...Array(n).keys()];
  const ff = (args: string[]) => runTool(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args, out]);
  const pixFmt = v.codec === "h264" || v.codec === "hevc" || v.codec === "vp9" ? rewritePixFmt(src) : v.pixFmt;
  const sampledPool = (sampled: boolean) => {
    const plan = new Set(buildSamplePlan({ frameCount: n, fps: ctx.fps, seed: ctx.seed, cutTimes: ctx.cutTimes, probes: ctx.spec.probes }).map((f) => f.index));
    const pool = all.filter((i) => plan.has(i) === sampled);
    const target = pool[Math.floor(pool.length / 2)];
    if (target === undefined) throw new Error(`no ${sampled ? "sampled" : "unsampled"} frame to corrupt`);
    return target;
  };
  switch (kind) {
    case "dropped-frame":
      await rewriteFrames(src, out, all.filter((i) => i !== k), {});
      return { detail: `removed frame ${k}` };
    case "duplicated-frame":
      await rewriteFrames(src, out, all.flatMap((i) => (i === k ? [i, i] : [i])), {});
      return { detail: `frame ${k} written twice` };
    case "reordered-frames":
      await rewriteFrames(src, out, all.map((i) => (i === k ? k + 1 : i === k + 1 ? k : i)), {});
      return { detail: `frames ${k} and ${k + 1} swapped` };
    case "stale-frame":
      await rewriteFrames(src, out, all.map((i) => (i === k ? k - 1 : i)), {});
      return { detail: `frame ${k} replaced by frame ${k - 1}` };
    case "stale-frame-subtle": {
      if (subtleK === undefined) throw new Error("stale-frame-subtle needs a frame from pickSubtleStaleFrame");
      await rewriteFrames(src, out, all.map((i) => (i === subtleK ? subtleK - 1 : i)), {});
      return { detail: `frame ${subtleK} replaced by frame ${subtleK - 1} (least distinct observable neighbour pair)` };
    }
    case "pixel-corruption-sampled":
    case "pixel-corruption-unsampled": {
      const target = sampledPool(kind === "pixel-corruption-sampled");
      await rewriteFrames(src, out, all, { mutate: (p, f) => (p === target ? corruptLuma(f, pixFmt, v.width, v.height) : f) });
      return { detail: `white block painted into ${kind.endsWith("unsampled") ? "unsampled" : "sampled"} frame ${target}` };
    }
    case "pixel-subtle-sampled":
    case "pixel-subtle-unsampled": {
      const target = sampledPool(kind === "pixel-subtle-sampled");
      await rewriteFrames(src, out, all, { mutate: (p, f) => (p === target ? subtleLuma(f, pixFmt, v.width, v.height) : f) });
      const side = Math.min(SUBTLE_BLOCK, v.width, v.height);
      return { detail: `luma ±${SUBTLE_LUMA_DELTA} code values (8-bit scale) in a ${side}x${side} block of ${kind.endsWith("unsampled") ? "unsampled" : "sampled"} frame ${target}` };
    }
    case "wrong-fps":
      await rewriteFrames(src, out, all, { fps: "25/1" });
      return { detail: `same frames re-timed to 25/1 (declared ${ratToString(ctx.fps)})` };
    case "vfr-timestamps":
      await rewriteFrames(src, out, all, { vf: "setpts='N/(FRAME_RATE*TB)+if(eq(mod(N\\,7)\\,3)\\,0.4/(FRAME_RATE*TB)\\,0)'" });
      return { detail: "every 7th frame (n mod 7 = 3) shifted by 0.4 frame interval" };
    case "wrong-resolution":
      await ff([...inputArgs(src.input, src), "-map", "0:v", "-map", "0:a?", "-vf", `scale=${v.width - 2}:${v.height}`, "-c:v", "libx264", "-qp", "0", "-preset", "ultrafast", "-pix_fmt", v.pixFmt, ...colorArgs(src), "-c:a", "copy"]);
      return { detail: `scaled to ${v.width - 2}x${v.height}` };
    case "bitrate-drop":
      await ff([...inputArgs(src.input, src), "-map", "0:v", "-map", "0:a?", "-c:v", "libx264", "-crf", "40", "-preset", "medium", "-pix_fmt", v.pixFmt, ...colorArgs(src), "-video_track_timescale", String(v.timeBase.den), "-c:a", "copy"]);
      return { detail: "re-encoded at x264 crf 40" };
    case "alpha-stripped":
      await ff([...inputArgs(src.input, src), "-map", "0:v", "-map", "0:a?", "-c:v", "libvpx-vp9", "-lossless", "1", "-row-mt", "1", "-pix_fmt", "yuv420p", "-c:a", "copy"]);
      return { detail: "re-encoded VP9 lossless as yuv420p (alpha plane dropped)" };
    case "hdr-metadata-stripped":
      await ff(["-i", src.input.path, "-map", "0", "-c", "copy", "-bsf:v", "filter_units=remove_types=39,hevc_metadata=colour_primaries=2:transfer_characteristics=2:matrix_coefficients=2", "-color_primaries", "unknown", "-color_trc", "unknown", "-colorspace", "unknown"]);
      return { detail: "stream copy: prefix SEI NAL units removed, VUI and container colour description set to unspecified (container mastering/CLL boxes may survive)" };
    case "hdr-sei-stripped": {
      // Prefix SEI (NAL type 39) lives in two places: in-band in the samples and
      // in the hvcC decoder configuration, which a stream copy keeps and the
      // decoder applies to every frame. Both are retyped in place to reserved
      // NAL type 41, which decoders skip. Byte-neutral: file size, bitrate,
      // slices, timestamps, VUI and container tags stay identical, so the only
      // observable change is the missing HDR metadata.
      const pkts = await videoPacketSpans(src.input.path);
      const retyped = retypeHevcSei(readFileSync(src.input.path), pkts);
      writeFileSync(out, retyped.file);
      const after = await probeMedia({ path: out });
      if (hasSeiHdrMetadata(after)) throw new Error("HDR SEI still decoded after stripping");
      if (after.video!.frames.length !== n) throw new Error(`SEI strip changed the frame count ${n} -> ${after.video!.frames.length}`);
      return { detail: `${retyped.inBand} in-band and ${retyped.config} hvcC prefix-SEI NAL(s) retyped in place to reserved type 41 (byte-neutral); VUI, container colour tags, timestamps and slices identical` };
    }
    case "hdr-max-cll-changed": {
      const cll = seiContentLight(src);
      if (!cll) throw new Error("no content light level SEI to change");
      const next = nextContentLight(cll.maxContent);
      const patched = patchContentLight(readFileSync(src.input.path), cll, next);
      writeFileSync(out, patched.file);
      const after = seiContentLight(await probeMedia({ path: out }));
      if (!after || after.maxContent !== next || after.maxAverage !== cll.maxAverage || after.frames !== cll.frames)
        throw new Error(`MaxCLL patch not decoded as intended: ${JSON.stringify(after)}`);
      return { detail: `byte patch of ${patched.count} content-light SEI payload(s): MaxCLL ${cll.maxContent} -> ${next} (MaxFALL ${cll.maxAverage} kept) on all ${cll.frames} frames; nothing else changed` };
    }
    case "audio-offset":
    case "audio-offset-22ms":
    case "audio-offset-25ms":
    case "audio-offset-30ms": {
      const a = src.audio!;
      const ms = AUDIO_OFFSET_MS[kind]!;
      const dur = a.durationSec ?? src.durationSec ?? 0;
      await ff([...inputArgs(src.input, src), "-map", "0:v", "-map", "0:a", "-c:v", "copy", "-af", `adelay=delays=${ms}:all=1,atrim=end=${dur}`, "-c:a", a.codec === "opus" ? "libopus" : "aac", "-b:a", "192k", "-ar", String(a.sampleRate)]);
      return { detail: `audio delayed by ${ms} ms (re-encoded, same length)` };
    }
    case "missing-audio":
      await ff(["-i", src.input.path, "-map", "0:v", "-c", "copy", "-an"]);
      return { detail: "audio stream removed (stream copy)" };
  }
}

export interface FaultResult {
  fixture: string;
  fault: FaultKind | "control-unmodified";
  detail: string;
  expected: Reason[];
  verdict: FidelityRecord["verdict"] | "ERROR";
  reasons: Reason[];
  caught: boolean;
  /** A row that is not caught counts as a miss only when required. Near-threshold faults may be informational (see `requirement`). */
  required: boolean;
  /** Near-threshold faults: why this row is required or informational. */
  requirement?: string;
  /** Near-threshold faults: what the gate measured, from the relevant check's notes or A/V analysis. */
  measured?: string;
  error?: string;
}

/** Gate observations relevant to a near-threshold fault (empty notes = the check saw nothing beyond its limit). */
function measuredFor(fault: FaultKind, rec: FidelityRecord): string {
  const c = rec.checks;
  if (!c) return "no checks ran";
  if (AUDIO_OFFSET_MS[fault] !== undefined) {
    const d = (c.audio.details as { avDriftMs?: unknown }).avDriftMs;
    return `A/V drift ${typeof d === "number" ? d.toFixed(3) : "n/a"} ms`;
  }
  const keys: Array<keyof typeof c> = fault === "stale-frame-subtle" ? ["temporal"] : ["temporal", "pixels", "encoded"];
  const notes = keys.flatMap((k) => c[k].notes.map((n) => `${k}: ${n}`));
  return notes.length ? notes.join("; ") : "no check exceeded its limit";
}

/** environment.json fields that must agree between results dirs combined into one fault-injection run (timestamps excluded). */
const ENV_KEYS = ["repo", "upstream", "toolchain", "host", "testedPlatforms"] as const;

/**
 * Results dirs that may feed fault injection, plus provenance warnings.
 * A dir whose run-manifest records a fail-closed `abort` is skipped unless
 * `allowAborted` (its completed fixtures are still whole renders, but the
 * caller has to opt in and the choice is recorded). Environments that differ
 * between dirs (including a dirty working tree) are reported, never hidden.
 */
export function usableResultsDirs(dirs: string[], allowAborted: boolean): { dirs: string[]; notes: string[] } {
  const notes: string[] = [];
  const readJson = (file: string): Record<string, unknown> | null => {
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch (e) {
      throw new Error(`unparseable ${file}: ${(e as Error).message}`);
    }
  };
  const usable = dirs.filter((d) => {
    const abort = readJson(join(d, "run-manifest.json"))?.abort as { reason?: string } | undefined;
    if (!abort) return true;
    notes.push(`${repoRelative(d)} aborted fail-closed (${abort.reason ?? "no reason"}): ${allowAborted ? "used because --allow-aborted was given" : "skipped (pass --allow-aborted to use its completed fixtures)"}`);
    return allowAborted;
  });
  const envs = usable.map((d) => ({ d, env: readJson(join(d, "environment.json")) }));
  for (const { d, env } of envs) {
    if (!env) notes.push(`${repoRelative(d)} has no environment.json`);
    else if ((env.repo as { turboDirty?: boolean } | undefined)?.turboDirty) notes.push(`${repoRelative(d)} was rendered from a dirty working tree (turboDirty: true)`);
  }
  const first = envs.find((e) => e.env);
  for (const { d, env } of envs) {
    if (!env || !first || env === first.env) continue;
    const differ = ENV_KEYS.filter((k) => JSON.stringify(env[k]) !== JSON.stringify(first.env![k]));
    if (differ.length) notes.push(`${repoRelative(d)} environment differs from ${repoRelative(first.d)} in: ${differ.join(", ")}`);
  }
  return { dirs: usable, notes };
}

const USAGE ="usage: inject-faults.ts --results <dir>[,<dir>...] [--cell c] [--ref-run 1] [--source-run 2] [--path p] [--fixtures a,b] [--out dir]";

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  // Several results dirs are allowed (for example a render resumed after a
  // fail-closed abort); each fixture is taken from the first dir that kept it.
  const requestedDirs = args.list("results")?.map((d) => resolve(d));
  if (!requestedDirs) throw new UsageError(USAGE);
  const allowAborted = argv.includes("--allow-aborted");
  const { dirs: resultsDirs, notes: provenanceNotes } = usableResultsDirs(requestedDirs, allowAborted);
  for (const n of provenanceNotes) console.error(`[faults] warning: ${n}`);
  if (!resultsDirs.length) throw new Error(`no usable results dir among ${requestedDirs.join(", ")}`);
  const cell = args.get("cell") ?? "producer-default";
  const refRun = args.int("ref-run", 1)!;
  const srcRun = args.int("source-run", 2)!;
  if (refRun === srcRun) throw new UsageError("--ref-run and --source-run must differ");
  const path = args.get("path") ?? pathName(cell);
  const outDir = resolve(args.get("out") ?? join(BENCH_ROOT, "fidelity", "negative-results"));
  const loaded = loadThresholds(path);
  const fixtures = args.list("fixtures") ?? ("data" in loaded ? Object.keys(loaded.data.fixtures) : []);
  if (!fixtures.length) throw new Error(`no fixtures (threshold file: ${"error" in loaded ? loaded.error : "empty"})`);
  const work = mkdtempSync(join(tmpdir(), "turbo-fidelity-faults-"));
  const rows: FaultResult[] = [];
  const fixtureResults: Record<string, string> = {};
  try {
    for (const fixture of fixtures) {
      const results = resultsDirs.find((d) => keptOutput(d, fixture, cell, refRun) && keptOutput(d, fixture, cell, srcRun));
      if (!results) throw new Error(`${fixture}: kept outputs for runs ${refRun}/${srcRun} not found under ${resultsDirs.join(", ")}`);
      const ref = keptOutput(results, fixture, cell, refRun)!;
      const srcPath = keptOutput(results, fixture, cell, srcRun)!;
      fixtureResults[fixture] = repoRelative(results);
      const { ctx } = fixtureContext(fixture);
      const src = await probeMedia({ path: srcPath });
      const control = await evaluate({ fixture, reference: ref, candidate: srcPath, path, refMeta: { cell, run: refRun }, candMeta: { cell, run: srcRun } });
      const controlOk = control.verdict === "PASS" || (control.verdict === "FALLBACK" && control.reasons.every((r) => r === "TOOL_UNAVAILABLE"));
      rows.push({ fixture, fault: "control-unmodified", detail: `run ${srcRun} vs run ${refRun}, unmodified`, expected: [], verdict: control.verdict, reasons: control.reasons, caught: controlOk, required: true });
      console.error(`[faults] ${fixture} control: ${control.verdict} ${control.reasons.join(",")}`);
      const fxT = "data" in loaded ? (loaded.data.fixtures[fixture] ?? null) : null;
      const tol = fxT ? toNum(fxT.temporal.thumbMseTol.limit) : 0;
      const faults = applicableFaults(src, ctx);
      const k = faults.some((f) => NEEDS_DISTINCT_FRAME.has(f)) ? await pickFaultFrame(src, tol) : null;
      const subtle = faults.includes("stale-frame-subtle") ? await pickSubtleStaleFrame(src, tol) : null;
      for (const fault of faults) {
        const ext = srcPath.slice(srcPath.lastIndexOf("."));
        const out = join(work, `${fixture}-${fault}${ext}`);
        const near = NEAR_THRESHOLD.has(fault) ? nearThresholdRequirement(fault, fxT) : null;
        const row: FaultResult = { fixture, fault, detail: "", expected: EXPECTED[fault], verdict: "ERROR", reasons: [], caught: false, required: near?.required ?? true, ...(near ? { requirement: near.why } : {}) };
        try {
          if ((NEEDS_DISTINCT_FRAME.has(fault) && k === null) || (fault === "stale-frame-subtle" && subtle === null)) {
            row.detail = "no visually distinct frame neighbourhood; temporal fault not observable on this fixture";
            row.error = "not injectable";
          } else {
            row.detail = (await injectFault(fault, src, out, ctx, k ?? 2, subtle?.k)).detail;
            if (fault === "stale-frame-subtle") row.detail += `; thumbnail MSE to its predecessor ${subtle!.thumbMse.toFixed(4)} (match tolerance ${tol})`;
            const rec = await evaluate({ fixture, reference: ref, candidate: out, path, backend: `fault:${fault}`, refMeta: { cell, run: refRun }, candMeta: { cell, run: srcRun } });
            row.verdict = rec.verdict;
            row.reasons = rec.reasons;
            row.caught = faultCaught(fault, rec);
            if (near) row.measured = measuredFor(fault, rec);
          }
        } catch (e) {
          row.error = (e as Error).message;
        } finally {
          rmSync(out, { force: true });
        }
        rows.push(row);
        console.error(`[faults] ${fixture} ${fault}: ${row.verdict} ${row.reasons.join(",")} -> ${row.caught ? "caught" : row.required ? "MISSED" : "not caught (informational)"}${row.error ? ` (${row.error})` : ""}`);
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  mkdirSync(outDir, { recursive: true });
  // An errored row is a miss even when informational: the fault was never measured.
  const missed = rows.filter((r) => !r.caught && (r.required || r.error));
  const informational = rows.filter((r) => !r.caught && !r.required && !r.error);
  const kinds = new Set(rows.filter((r) => r.fault !== "control-unmodified" && r.caught).map((r) => r.fault));
  writeFileSync(
    join(outDir, `${path}.json`),
    toJson({ schema: "turbo-fidelity-negative/2", path, results: resultsDirs.map(repoRelative), fixtureResults, provenanceNotes, cell, refRun, sourceRun: srcRun, generatedAt: new Date().toISOString(), distinctFaultKindsCaught: kinds.size, missed: missed.length, informationalNotCaught: informational.length, rows }),
  );
  const status = (r: FaultResult) => (r.caught ? "yes" : r.required || r.error ? "**NO**" : "no (informational)");
  const L = [
    `# Fault injection: ${path}`,
    "",
    `Generated by \`benchmarks/src/fidelity/inject-faults.ts\` from ${resultsDirs.map((d) => `\`${repoRelative(d)}\``).join(" + ")} (${cell}, faults injected into run ${srcRun}, compared with run ${refRun}). Every row is kept, including misses.`,
    "",
    `- Distinct fault kinds caught: ${kinds.size}`,
    `- Missed or errored: ${missed.length}`,
    ...provenanceNotes.map((n) => `- Provenance: ${n}`),
    `- Near-threshold faults not caught where not required (informational): ${informational.length}`,
    "",
    "| fixture | fault | injected | expected reason | verdict | reasons | caught |",
    "|---|---|---|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${r.fixture} | ${r.fault} | ${r.detail}${r.error ? ` — error: ${r.error}` : ""} | ${r.fault !== "control-unmodified" && ONLY[r.fault] ? `only ${ONLY[r.fault]!.join(", ")}` : r.expected.join(" / ") || "PASS"} | ${r.verdict} | ${r.reasons.join(", ") || "—"} | ${status(r)} |`,
    ),
    "",
    "## Near-threshold faults",
    "",
    `Magnitudes: A/V offsets of ${Object.entries(AUDIO_OFFSET_MS).filter(([f]) => NEAR_THRESHOLD.has(f as FaultKind)).map(([, ms]) => `${ms} ms`).join(", ")} against a limit floored at one audio codec frame; luma ±${SUBTLE_LUMA_DELTA} code values (8-bit scale) in a ${SUBTLE_BLOCK}x${SUBTLE_BLOCK} block; a stale frame at the least distinct observable neighbour pair. A row is required when it is an A/V offset larger than the calibrated A/V limit plus the 0.125 ms lag resolution, or a pixel or temporal fault on a bit-exact fixture (every limit there is the exact reference value). The magnitude of a pixel or temporal fault is not compared with the limit; on a non-deterministic fixture its outcome is informational.`,
    "",
    "| fixture | fault | required | why | gate measured | caught |",
    "|---|---|---|---|---|---|",
    ...rows.filter((r) => r.fault !== "control-unmodified" && NEAR_THRESHOLD.has(r.fault)).map((r) => `| ${r.fixture} | ${r.fault} | ${r.required ? "yes" : "no"} | ${r.requirement ?? ""} | ${r.measured ?? (r.error ? `error: ${r.error}` : "—")} | ${status(r)} |`),
    "",
  ];
  writeFileSync(join(outDir, `${path}.md`), L.join("\n"));
  console.error(`[faults] ${kinds.size} fault kinds caught, ${missed.length} missed, ${informational.length} informational -> ${join(outDir, `${path}.md`)}`);
  return missed.length ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().then(
    (c) => process.exit(c),
    (err) => {
      console.error(err instanceof UsageError ? `[faults] usage: ${err.message}` : err);
      process.exit(err instanceof UsageError ? 2 : 1);
    },
  );
}
