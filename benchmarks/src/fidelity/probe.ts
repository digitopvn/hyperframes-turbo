/**
 * ffprobe timeline of one render output: container, video/audio stream
 * parameters, colour metadata and HDR side data, and every video frame's PTS
 * plus every video packet's PTS/DTS. Accepts an encoded file or an upstream
 * `png-sequence` directory (`frame_000001.png`, ...; lossless pre-encode frames).
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { FFMPEG, FFPROBE, runTool } from "./proc.js";
import { parseRational, ratToString, type Rational } from "./rational.js";

export interface MediaInput {
  path: string;
  /** Set for png-sequence directories: frame rate the frames are presented at. */
  imageSequenceFps?: Rational;
}

export interface VideoFrame {
  /** PTS in stream time-base ticks; null when the container has none. */
  pts: bigint | null;
  durationTicks: number | null;
  key: boolean;
}

export interface VideoInfo {
  codec: string;
  profile: string | null;
  pixFmt: string;
  width: number;
  height: number;
  sar: string | null;
  rFrameRate: string;
  avgFrameRate: string;
  timeBase: Rational;
  startTimeSec: number;
  colorRange: string | null;
  colorSpace: string | null;
  colorTransfer: string | null;
  colorPrimaries: string | null;
  bitsPerRawSample: number | null;
  /** VP8/VP9 only: "1" when libvpx decodes an alpha plane, "0" when not (verified by decoding, never from tags). */
  alphaMode: string | null;
  /** Side data on the stream and the first frame (mastering display, content light, ...). */
  sideData: Array<Record<string, unknown>>;
  frames: VideoFrame[];
  packets: Array<{ pts: bigint | null; dts: bigint | null }>;
}

export interface AudioInfo {
  codec: string;
  sampleRate: number;
  channels: number;
  channelLayout: string | null;
  startTimeSec: number;
  durationSec: number | null;
}

export interface MediaProbe {
  input: MediaInput;
  isImageSequence: boolean;
  formatName: string;
  sizeBytes: number;
  bitRate: number | null;
  durationSec: number | null;
  video: VideoInfo | null;
  audio: AudioInfo | null;
}

export const PNG_SEQUENCE_PATTERN = "frame_%06d.png";

/** FFmpeg input arguments (options + `-i path`) that read this media the same way everywhere. */
export function inputArgs(input: MediaInput, probe?: MediaProbe | null): string[] {
  if (input.imageSequenceFps) {
    return ["-framerate", ratToString(input.imageSequenceFps), "-start_number", "1", "-i", join(input.path, PNG_SEQUENCE_PATTERN)];
  }
  // FFmpeg's native VP9 decoder drops the alpha side channel; libvpx keeps it.
  const alphaVp9 = probe?.video?.codec === "vp9" && probe.video.alphaMode === "1";
  return [...(alphaVp9 ? ["-c:v", "libvpx-vp9"] : []), "-i", input.path];
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};
const big = (v: unknown): bigint | null => (typeof v === "number" || (typeof v === "string" && /^-?\d+$/.test(v)) ? BigInt(v) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" && v !== "unknown" ? v : null);

interface FfStream {
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  pix_fmt?: string;
  width?: number;
  height?: number;
  sample_aspect_ratio?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  time_base?: string;
  start_time?: string;
  duration?: string;
  color_range?: string;
  color_space?: string;
  color_transfer?: string;
  color_primaries?: string;
  bits_per_raw_sample?: string;
  sample_rate?: string;
  channels?: number;
  channel_layout?: string;
  tags?: Record<string, string>;
  side_data_list?: Array<Record<string, unknown>>;
}

async function ffprobeJson(args: string[]): Promise<Record<string, unknown>> {
  const r = await runTool(FFPROBE, ["-v", "error", "-of", "json", ...args], { timeoutMs: 5 * 60_000 });
  return JSON.parse(r.stdout.toString("utf8")) as Record<string, unknown>;
}

function probeInputArgs(input: MediaInput): string[] {
  return input.imageSequenceFps
    ? ["-f", "image2", "-framerate", ratToString(input.imageSequenceFps), "-start_number", "1", "-i", join(input.path, PNG_SEQUENCE_PATTERN)]
    : ["-i", input.path];
}

/**
 * VP8/VP9 alpha lives in a WebM side channel that FFmpeg's native decoder
 * ignores, and the `alpha_mode` stream tag is not evidence: a re-encode copies
 * it as a plain metadata tag even when the alpha plane is gone. Decode the
 * first frame with libvpx and infer from the raw frame size (yuva420p carries
 * 2.5 bytes/pixel, yuv420p 1.5). Returns "1" with alpha, "0" without.
 */
async function decodedVpxAlphaMode(path: string, vs: FfStream): Promise<string> {
  const w = vs.width ?? 0;
  const h = vs.height ?? 0;
  if (!w || !h) throw new Error(`${path}: VP8/VP9 stream without dimensions`);
  const r = await runTool(FFMPEG, ["-hide_banner", "-loglevel", "error", "-c:v", vs.codec_name === "vp8" ? "libvpx" : "libvpx-vp9", "-i", path, "-map", "0:v:0", "-frames:v", "1", "-f", "rawvideo", "pipe:1"], { timeoutMs: 60_000 });
  const n = r.stdout.length;
  const yuva = (w * h * 5) / 2;
  const yuv = (w * h * 3) / 2;
  if (n === yuva) return "1";
  if (n === yuv) return "0";
  throw new Error(`${path}: libvpx decoded ${n} bytes for one ${w}x${h} frame (expected ${yuv} or ${yuva})`);
}

export async function probeMedia(input: MediaInput): Promise<MediaProbe> {
  if (!existsSync(input.path)) throw new Error(`no such output: ${input.path}`);
  const isDir = statSync(input.path).isDirectory();
  if (isDir && !input.imageSequenceFps) throw new Error(`${input.path} is a directory; png-sequence input needs its fps`);
  const src = probeInputArgs(input);
  const head = await ffprobeJson(["-show_format", "-show_streams", ...src]);
  const streams = (head.streams as FfStream[] | undefined) ?? [];
  const format = (head.format as Record<string, unknown> | undefined) ?? {};
  const vs = streams.find((s) => s.codec_type === "video");
  const as = streams.find((s) => s.codec_type === "audio");
  const sizeBytes = isDir
    ? readdirSync(input.path).reduce((n, f) => n + statSync(join(input.path, f)).size, 0)
    : statSync(input.path).size;

  let video: VideoInfo | null = null;
  if (vs) {
    const timeline = await ffprobeJson([
      "-select_streams",
      "v:0",
      "-show_entries",
      "frame=pts,duration,key_frame:packet=pts,dts",
      "-show_frames",
      "-show_packets",
      ...src,
    ]);
    const first = await ffprobeJson(["-select_streams", "v:0", "-read_intervals", "%+#1", "-show_frames", "-show_entries", "frame=side_data_list", ...src]);
    const firstFrame = ((first.frames as Array<Record<string, unknown>> | undefined) ?? [])[0];
    // With both -show_frames and -show_packets, ffprobe interleaves them in one
    // `packets_and_frames` array, tagged by `type`.
    const mixed = (timeline.packets_and_frames as Array<Record<string, unknown>> | undefined) ?? [];
    const rawFrames = mixed.length ? mixed.filter((e) => e.type === "frame") : ((timeline.frames as Array<Record<string, unknown>> | undefined) ?? []);
    const rawPackets = mixed.length ? mixed.filter((e) => e.type === "packet") : ((timeline.packets as Array<Record<string, unknown>> | undefined) ?? []);
    if (mixed.length && rawFrames.length + rawPackets.length !== mixed.length) throw new Error(`ffprobe returned untyped timeline entries for ${input.path}`);
    const frames = rawFrames.map((f) => ({
      pts: big(f.pts),
      durationTicks: num(f.duration),
      key: f.key_frame === 1,
    }));
    const packets = rawPackets.map((p) => ({ pts: big(p.pts), dts: big(p.dts) }));
    video = {
      codec: vs.codec_name ?? "unknown",
      profile: str(vs.profile),
      pixFmt: vs.pix_fmt ?? "unknown",
      width: vs.width ?? 0,
      height: vs.height ?? 0,
      sar: str(vs.sample_aspect_ratio),
      rFrameRate: vs.r_frame_rate ?? "0/0",
      avgFrameRate: vs.avg_frame_rate ?? "0/0",
      timeBase: parseRational(vs.time_base ?? "1/1"),
      startTimeSec: num(vs.start_time) ?? 0,
      colorRange: str(vs.color_range),
      colorSpace: str(vs.color_space),
      colorTransfer: str(vs.color_transfer),
      colorPrimaries: str(vs.color_primaries),
      bitsPerRawSample: num(vs.bits_per_raw_sample),
      alphaMode: (vs.codec_name === "vp9" || vs.codec_name === "vp8") && !isDir ? await decodedVpxAlphaMode(input.path, vs) : null,
      sideData: [...(vs.side_data_list ?? []), ...(((firstFrame?.side_data_list as Array<Record<string, unknown>>) ?? []))],
      frames,
      packets,
    };
  }
  const audio: AudioInfo | null = as
    ? {
        codec: as.codec_name ?? "unknown",
        sampleRate: num(as.sample_rate) ?? 0,
        channels: as.channels ?? 0,
        channelLayout: str(as.channel_layout),
        startTimeSec: num(as.start_time) ?? 0,
        durationSec: num(as.duration),
      }
    : null;
  return {
    input,
    isImageSequence: isDir,
    formatName: String(format.format_name ?? "unknown"),
    sizeBytes,
    // An image sequence has no container bitrate; its total bytes over its duration is the equivalent
    // (a backend silently writing 8-bit instead of 16-bit PNGs shows up as a bitrate drop).
    bitRate: num(format.bit_rate) ?? (isDir && num(format.duration) ? Math.round((sizeBytes * 8) / num(format.duration)!) : null),
    durationSec: num(format.duration),
    video,
    audio,
  };
}

/** Side data entries of a given type name (ffprobe `side_data_type`). */
export function sideDataOfType(v: VideoInfo, type: RegExp): Array<Record<string, unknown>> {
  return v.sideData.filter((s) => type.test(String(s.side_data_type ?? "")));
}

/** True when the stream carries an alpha plane (alpha pix_fmt, or a libvpx-decoded VP8/VP9 alpha plane). */
export function hasAlpha(v: VideoInfo): boolean {
  return /^(yuva|rgba|bgra|argb|abgr|gbrap|ya)/.test(v.pixFmt) || v.alphaMode === "1";
}
