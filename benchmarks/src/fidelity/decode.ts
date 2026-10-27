/**
 * Bounded raw-frame decoding: FFmpeg writes rawvideo to a pipe and frames are
 * yielded one at a time (async iterator backpressure), so memory stays at a
 * couple of frames regardless of video length or resolution.
 *
 * `-fps_mode passthrough` stops FFmpeg from duplicating or dropping frames to
 * fit a rate, which would otherwise hide exactly the faults the gate looks for.
 */
import { inputArgs, type MediaProbe } from "./probe.js";
import { FFMPEG, spawnTool } from "./proc.js";

/** Packed pixel formats the comparator reads. */
export type RawPixFmt = "gray" | "rgb24" | "rgba" | "rgb48le" | "rgba64le";

export const PIXFMT_LAYOUT: Record<RawPixFmt, { channels: number; bytesPerSample: 1 | 2; alpha: boolean }> = {
  gray: { channels: 1, bytesPerSample: 1, alpha: false },
  rgb24: { channels: 3, bytesPerSample: 1, alpha: false },
  rgba: { channels: 4, bytesPerSample: 1, alpha: true },
  rgb48le: { channels: 3, bytesPerSample: 2, alpha: false },
  rgba64le: { channels: 4, bytesPerSample: 2, alpha: true },
};

export interface DecodeOptions {
  pixFmt: RawPixFmt;
  /** Only these presentation-order frame indices (ascending); all frames when absent. */
  indices?: number[];
  /** Downscale to this size (area filter) before conversion, e.g. thumbnails. */
  scale?: { width: number; height: number };
}

export function frameBytes(width: number, height: number, pixFmt: RawPixFmt): number {
  const l = PIXFMT_LAYOUT[pixFmt];
  return width * height * l.channels * l.bytesPerSample;
}

/** Yields `{ index, data }` for each decoded frame, in presentation order. */
export async function* decodeFrames(probe: MediaProbe, opts: DecodeOptions): AsyncGenerator<{ index: number; data: Buffer }> {
  const v = probe.video;
  if (!v) throw new Error(`${probe.input.path}: no video stream`);
  const width = opts.scale?.width ?? v.width;
  const height = opts.scale?.height ?? v.height;
  const filters: string[] = [];
  if (opts.indices) {
    if (opts.indices.length === 0) return;
    filters.push(`select='${opts.indices.map((i) => `eq(n\\,${i})`).join("+")}'`);
  }
  if (opts.scale) filters.push(`scale=${width}:${height}:flags=area`);
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    ...inputArgs(probe.input, probe),
    "-map",
    "0:v:0",
    ...(filters.length ? ["-vf", filters.join(",")] : []),
    "-fps_mode",
    "passthrough",
    "-pix_fmt",
    opts.pixFmt,
    "-f",
    "rawvideo",
    "pipe:1",
  ];
  const { child, done } = await spawnTool(FFMPEG, args);
  const size = frameBytes(width, height, opts.pixFmt);
  const order = opts.indices ?? null;
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let k = 0;
  let finished = false;
  try {
    for await (const chunk of child.stdout! as AsyncIterable<Buffer>) {
      pending.push(chunk);
      pendingBytes += chunk.length;
      while (pendingBytes >= size) {
        const all = pending.length === 1 ? pending[0]! : Buffer.concat(pending, pendingBytes);
        const data = Buffer.from(all.subarray(0, size));
        const rest = all.subarray(size);
        pending = rest.length ? [rest] : [];
        pendingBytes = rest.length;
        const index = order ? order[k] : k;
        if (index === undefined) throw new Error(`${probe.input.path}: decoder produced more frames than selected`);
        k++;
        yield { index, data };
      }
    }
    finished = true;
  } finally {
    if (!finished && child.pid !== undefined && child.exitCode === null) child.kill();
    const { code, stderr } = await done;
    if (finished) {
      if (code !== 0) throw new Error(`${probe.input.path}: ffmpeg decode exited ${code}: ${stderr.trim().split("\n").slice(-3).join(" | ")}`);
      if (pendingBytes !== 0) throw new Error(`${probe.input.path}: truncated frame (${pendingBytes} of ${size} bytes)`);
    }
  }
}

/** Decode every frame as a small grayscale thumbnail (temporal analysis). */
export async function decodeThumbnails(probe: MediaProbe, width = 64, height = 36): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for await (const f of decodeFrames(probe, { pixFmt: "gray", scale: { width, height } })) out.push(f.data);
  return out;
}
