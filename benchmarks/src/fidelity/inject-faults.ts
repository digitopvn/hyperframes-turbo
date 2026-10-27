/**
 * Fault injection: derive deliberately broken candidates from a real
 * reference output and prove the gate catches each one with the right reason.
 *
 * Frame-level faults (drop, duplicate, reorder, stale, pixel corruption,
 * wrong fps, VFR) decode the source to raw frames, rewrite the frame sequence
 * in Node and re-encode LOSSLESSLY (x264 qp 0) with the source's colour tags
 * and time scale, so the injected defect is the only difference. Container
 * faults (missing audio, HDR metadata) are stream copies; resolution, bitrate,
 * alpha and audio-offset faults re-encode only what they change.
 *
 *   inject-faults.ts --results <dir> [--cell producer-default] [--ref-run 1]
 *                    [--source-run 2] [--path <p>] [--fixtures a,b] [--out <dir>]
 * Writes <out>/<path>.json and .md (default benchmarks/fidelity/negative-results).
 * Exit 1 if any fault is missed or the unmodified control does not pass.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BENCH_ROOT } from "../fixtures.js";
import type { CompareContext } from "./compare.js";
import { decodeThumbnails } from "./decode.js";
import { thumbMse } from "./metrics/pixels.js";
import { hasAlpha, inputArgs, probeMedia, type MediaProbe } from "./probe.js";
import { FFMPEG, FFPROBE, runTool, spawnTool } from "./proc.js";
import { ratToString } from "./rational.js";
import { buildSamplePlan } from "./sample-plan.js";
import { evaluate, keptOutput } from "./run-fidelity.js";
import { fixtureContext, repoRelative, toJson, type FidelityRecord } from "./schema.js";
import { loadThresholds, pathName, toNum } from "./thresholds.js";
import type { Reason } from "./verdict.js";

export type FaultKind =
  | "dropped-frame"
  | "duplicated-frame"
  | "reordered-frames"
  | "stale-frame"
  | "pixel-corruption-sampled"
  | "pixel-corruption-unsampled"
  | "wrong-resolution"
  | "wrong-fps"
  | "vfr-timestamps"
  | "bitrate-drop"
  | "alpha-stripped"
  | "hdr-metadata-stripped"
  | "hdr-sei-stripped"
  | "hdr-max-cll-changed"
  | "audio-offset"
  | "missing-audio";

/** The gate must FAIL with at least one of these reasons. */
export const EXPECTED: Record<FaultKind, Reason[]> = {
  "dropped-frame": ["FRAME_DROPPED"],
  "duplicated-frame": ["FRAME_DUPLICATED"],
  "reordered-frames": ["FRAME_REORDERED"],
  "stale-frame": ["STALE_FRAME"],
  "pixel-corruption-sampled": ["PIXEL_BELOW_THRESHOLD"],
  "pixel-corruption-unsampled": ["ENCODED_QUALITY_BELOW_THRESHOLD"],
  "wrong-resolution": ["DIMENSION_CHANGED"],
  "wrong-fps": ["FPS_CHANGED"],
  "vfr-timestamps": ["VFR_DETECTED", "PTS_DRIFT"],
  "bitrate-drop": ["BITRATE_DROP"],
  "alpha-stripped": ["ALPHA_MISSING"],
  "hdr-metadata-stripped": ["HDR_TRANSFER_MISMATCH", "HDR_METADATA_MISMATCH"],
  "hdr-sei-stripped": ["HDR_METADATA_MISMATCH"],
  "hdr-max-cll-changed": ["HDR_METADATA_MISMATCH"],
  "audio-offset": ["AV_DRIFT"],
  "missing-audio": ["AUDIO_MISSING"],
};

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

const FRAME_REWRITE: FaultKind[] = ["dropped-frame", "duplicated-frame", "reordered-frames", "stale-frame", "pixel-corruption-sampled", "pixel-corruption-unsampled", "wrong-fps", "vfr-timestamps"];

/** Bytes per raw frame for the native planar formats the rewriter supports. */
function nativeFrameBytes(pixFmt: string, w: number, h: number): number | null {
  if (pixFmt === "yuv420p") return (w * h * 3) / 2;
  if (pixFmt === "yuva420p") return (w * h * 5) / 2;
  if (pixFmt === "yuv420p10le") return w * h * 3;
  return null;
}

/** Which faults make sense for this output (a fault the output cannot carry is not applicable, not passed). */
export function applicableFaults(p: MediaProbe, ctx: CompareContext): FaultKind[] {
  const v = p.video!;
  const out: FaultKind[] = [];
  const rewritable = v.codec === "h264" && v.pixFmt === "yuv420p" && !p.isImageSequence;
  if (rewritable) out.push(...FRAME_REWRITE, "wrong-resolution", "bitrate-drop");
  if (hasAlpha(v) && v.codec === "vp9") out.push("alpha-stripped");
  if (ctx.spec.hdr && v.codec === "hevc") {
    out.push("hdr-metadata-stripped");
    if (hasSeiHdrMetadata(p)) out.push("hdr-sei-stripped");
    if (seiContentLight(p)) out.push("hdr-max-cll-changed");
  }
  if (p.audio && !p.isImageSequence) out.push("audio-offset", "missing-audio");
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

/** Rewrite the frame sequence: `seq` lists source frame indices in output order. */
async function rewriteFrames(src: MediaProbe, out: string, seq: number[], opts: { fps?: string; mutate?: (outPos: number, frame: Buffer) => Buffer; vf?: string }): Promise<void> {
  const v = src.video!;
  const size = nativeFrameBytes(v.pixFmt, v.width, v.height);
  if (size === null) throw new Error(`rewrite unsupported for ${v.pixFmt}`);
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
      "-f", "rawvideo", "-pix_fmt", v.pixFmt, "-s", `${v.width}x${v.height}`, "-framerate", fps, "-i", "pipe:0",
      ...inputArgs(src.input, src),
      "-map", "0:v", "-map", "1:a?",
      ...(filters.length ? ["-vf", filters.join(",")] : []),
      // The encoder time base defaults to 1/fps, which would re-quantise shifted timestamps.
      ...(opts.vf ? ["-fps_mode", "passthrough", "-enc_time_base", `1/${v.timeBase.den}`] : []),
      "-c:v", "libx264", "-qp", "0", "-preset", "ultrafast", "-pix_fmt", v.pixFmt, ...colorArgs(src),
      "-video_track_timescale", String(v.timeBase.den),
      "-c:a", "copy", out,
    ],
    { stdin: true },
  );
  enc.child.stdout!.resume();
  const dec = await spawnTool(FFMPEG, ["-hide_banner", "-loglevel", "error", ...inputArgs(src.input, src), "-map", "0:v:0", "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", v.pixFmt, "pipe:1"]);
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
/** Paint a 25 % x 25 % white block into the luma plane (visible, local corruption). */
function corruptLuma(frame: Buffer, w: number, h: number): Buffer {
  const bw = Math.floor(w / 4);
  const bh = Math.floor(h / 4);
  for (let y = Math.floor(h / 2) - (bh >> 1); y < Math.floor(h / 2) + (bh >> 1); y++) frame.fill(235, y * w + Math.floor(w / 2) - (bw >> 1), y * w + Math.floor(w / 2) + (bw >> 1));
  return frame;
}

export async function injectFault(kind: FaultKind, src: MediaProbe, out: string, ctx: CompareContext, k: number): Promise<{ detail: string }> {
  const v = src.video!;
  const n = v.frames.length;
  const all = [...Array(n).keys()];
  const ff = (args: string[]) => runTool(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args, out]);
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
    case "pixel-corruption-sampled":
    case "pixel-corruption-unsampled": {
      const sampled = new Set(buildSamplePlan({ frameCount: n, fps: ctx.fps, seed: ctx.seed, cutTimes: ctx.cutTimes, probes: ctx.spec.probes }).map((f) => f.index));
      const pool = all.filter((i) => (kind === "pixel-corruption-sampled" ? sampled.has(i) : !sampled.has(i)));
      const target = pool[Math.floor(pool.length / 2)];
      if (target === undefined) throw new Error("no frame to corrupt");
      await rewriteFrames(src, out, all, { mutate: (p, f) => (p === target ? corruptLuma(f, v.width, v.height) : f) });
      return { detail: `white block painted into ${kind.endsWith("unsampled") ? "unsampled" : "sampled"} frame ${target}` };
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
    case "audio-offset": {
      const a = src.audio!;
      const dur = a.durationSec ?? src.durationSec ?? 0;
      await ff([...inputArgs(src.input, src), "-map", "0:v", "-map", "0:a", "-c:v", "copy", "-af", `adelay=delays=40:all=1,atrim=end=${dur}`, "-c:a", a.codec === "opus" ? "libopus" : "aac", "-b:a", "192k", "-ar", String(a.sampleRate)]);
      return { detail: "audio delayed by 40 ms (re-encoded, same length)" };
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
  error?: string;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const get = (key: string) => {
    const i = argv.indexOf(`--${key}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const results = resolve(get("results") ?? "");
  if (!get("results")) throw new Error("usage: inject-faults.ts --results <dir> [--cell c] [--ref-run 1] [--source-run 2] [--path p] [--fixtures a,b] [--out dir]");
  const cell = get("cell") ?? "producer-default";
  const refRun = Number(get("ref-run") ?? 1);
  const srcRun = Number(get("source-run") ?? 2);
  const path = get("path") ?? pathName(cell);
  const outDir = resolve(get("out") ?? join(BENCH_ROOT, "fidelity", "negative-results"));
  const loaded = loadThresholds(path);
  const fixtures = get("fixtures")?.split(",") ?? ("data" in loaded ? Object.keys(loaded.data.fixtures) : []);
  if (!fixtures.length) throw new Error(`no fixtures (threshold file: ${"error" in loaded ? loaded.error : "empty"})`);
  const work = mkdtempSync(join(tmpdir(), "turbo-fidelity-faults-"));
  const rows: FaultResult[] = [];
  try {
    for (const fixture of fixtures) {
      const ref = keptOutput(results, fixture, cell, refRun);
      const srcPath = keptOutput(results, fixture, cell, srcRun);
      if (!ref || !srcPath) throw new Error(`${fixture}: kept outputs for runs ${refRun}/${srcRun} not found under ${results}`);
      const { ctx } = fixtureContext(fixture);
      const src = await probeMedia({ path: srcPath });
      const control = await evaluate({ fixture, reference: ref, candidate: srcPath, path });
      const controlOk = control.verdict === "PASS" || (control.verdict === "FALLBACK" && control.reasons.every((r) => r === "TOOL_UNAVAILABLE"));
      rows.push({ fixture, fault: "control-unmodified", detail: `run ${srcRun} vs run ${refRun}, unmodified`, expected: [], verdict: control.verdict, reasons: control.reasons, caught: controlOk });
      console.error(`[faults] ${fixture} control: ${control.verdict} ${control.reasons.join(",")}`);
      const tol = "data" in loaded && loaded.data.fixtures[fixture] ? toNum(loaded.data.fixtures[fixture]!.temporal.thumbMseTol.limit) : 0;
      const k = await pickFaultFrame(src, tol);
      for (const fault of applicableFaults(src, ctx)) {
        const ext = srcPath.slice(srcPath.lastIndexOf("."));
        const out = join(work, `${fixture}-${fault}${ext}`);
        const row: FaultResult = { fixture, fault, detail: "", expected: EXPECTED[fault], verdict: "ERROR", reasons: [], caught: false };
        try {
          if (FRAME_REWRITE.includes(fault) && fault !== "wrong-fps" && !fault.startsWith("pixel") && fault !== "vfr-timestamps" && k === null) {
            row.detail = "no visually distinct frame neighbourhood; temporal fault not observable on this fixture";
            row.verdict = "ERROR";
            row.caught = false;
            row.error = "not injectable";
          } else {
            row.detail = (await injectFault(fault, src, out, ctx, k ?? 2)).detail;
            const rec = await evaluate({ fixture, reference: ref, candidate: out, path, backend: `fault:${fault}` });
            row.verdict = rec.verdict;
            row.reasons = rec.reasons;
            row.caught = faultCaught(fault, rec);
          }
        } catch (e) {
          row.error = (e as Error).message;
        } finally {
          rmSync(out, { force: true });
        }
        rows.push(row);
        console.error(`[faults] ${fixture} ${fault}: ${row.verdict} ${row.reasons.join(",")} -> ${row.caught ? "caught" : "MISSED"}${row.error ? ` (${row.error})` : ""}`);
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  mkdirSync(outDir, { recursive: true });
  const missed = rows.filter((r) => !r.caught);
  const kinds = new Set(rows.filter((r) => r.fault !== "control-unmodified" && r.caught).map((r) => r.fault));
  writeFileSync(join(outDir, `${path}.json`), toJson({ schema: "turbo-fidelity-negative/1", path, results: repoRelative(results), cell, refRun, sourceRun: srcRun, generatedAt: new Date().toISOString(), distinctFaultKindsCaught: kinds.size, rows }));
  const L = [
    `# Fault injection: ${path}`,
    "",
    `Generated by \`benchmarks/src/fidelity/inject-faults.ts\` from \`${repoRelative(results)}\` (${cell}, faults injected into run ${srcRun}, compared with run ${refRun}). Every row is kept, including misses.`,
    "",
    `- Distinct fault kinds caught: ${kinds.size}`,
    `- Missed or errored: ${missed.length}`,
    "",
    "| fixture | fault | injected | expected reason | verdict | reasons | caught |",
    "|---|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.fixture} | ${r.fault} | ${r.detail}${r.error ? ` — error: ${r.error}` : ""} | ${r.fault !== "control-unmodified" && ONLY[r.fault] ? `only ${ONLY[r.fault]!.join(", ")}` : r.expected.join(" / ") || "PASS"} | ${r.verdict} | ${r.reasons.join(", ") || "—"} | ${r.caught ? "yes" : "**NO**"} |`),
    "",
  ];
  writeFileSync(join(outDir, `${path}.md`), L.join("\n"));
  console.error(`[faults] ${kinds.size} fault kinds caught, ${missed.length} missed -> ${join(outDir, `${path}.md`)}`);
  return missed.length ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().then(
    (c) => process.exit(c),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
