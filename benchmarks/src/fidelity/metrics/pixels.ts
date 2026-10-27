/**
 * Full-frame pixel comparison of two decoded frames of identical layout:
 * MSE/PSNR over colour channels, alpha MSE/PSNR separately, max absolute
 * difference, share of pixels that differ at all, and SSIM on luma
 * (8x8 windows, stride 4, the windowing FFmpeg's ssim filter uses).
 *
 * PSNR is derived from MSE; identical frames have MSE 0 and PSNR = Infinity
 * (serialised as null in JSON, so consumers must read `mse`).
 */
import { PIXFMT_LAYOUT, type RawPixFmt } from "../decode.js";

export interface PixelStats {
  mse: number;
  psnrDb: number;
  ssim: number;
  maxAbsDiff: number;
  diffPixelPct: number;
  alphaMse: number | null;
  alphaPsnrDb: number | null;
}

export const psnrFromMse = (mse: number, peak: number): number => (mse === 0 ? Infinity : 10 * Math.log10((peak * peak) / mse));

function sample(buf: Buffer, i: number, bps: 1 | 2): number {
  return bps === 1 ? buf[i]! : buf.readUInt16LE(i * 2);
}

function luma(buf: Buffer, width: number, height: number, pixFmt: RawPixFmt): Float32Array {
  const { channels, bytesPerSample } = PIXFMT_LAYOUT[pixFmt];
  const y = new Float32Array(width * height);
  for (let p = 0; p < width * height; p++) {
    const o = p * channels;
    y[p] =
      channels === 1
        ? sample(buf, o, bytesPerSample)
        : 0.299 * sample(buf, o, bytesPerSample) + 0.587 * sample(buf, o + 1, bytesPerSample) + 0.114 * sample(buf, o + 2, bytesPerSample);
  }
  return y;
}

export function ssimLuma(a: Float32Array, b: Float32Array, width: number, height: number, peak: number): number {
  const c1 = (0.01 * peak) ** 2;
  const c2 = (0.03 * peak) ** 2;
  const W = 8;
  const S = 4;
  let sum = 0;
  let n = 0;
  for (let y0 = 0; y0 + W <= height; y0 += S) {
    for (let x0 = 0; x0 + W <= width; x0 += S) {
      let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
      for (let y = y0; y < y0 + W; y++) {
        const row = y * width;
        for (let x = x0; x < x0 + W; x++) {
          const va = a[row + x]!;
          const vb = b[row + x]!;
          sa += va;
          sb += vb;
          saa += va * va;
          sbb += vb * vb;
          sab += va * vb;
        }
      }
      const N = W * W;
      const ma = sa / N;
      const mb = sb / N;
      const va = saa / N - ma * ma;
      const vb = sbb / N - mb * mb;
      const cov = sab / N - ma * mb;
      sum += ((2 * ma * mb + c1) * (2 * cov + c2)) / ((ma * ma + mb * mb + c1) * (va + vb + c2));
      n++;
    }
  }
  return n ? sum / n : 1;
}

export function comparePixels(a: Buffer, b: Buffer, width: number, height: number, pixFmt: RawPixFmt): PixelStats {
  if (a.length !== b.length) throw new Error(`frame size mismatch: ${a.length} vs ${b.length} bytes`);
  const { channels, bytesPerSample, alpha } = PIXFMT_LAYOUT[pixFmt];
  const peak = bytesPerSample === 1 ? 255 : 65535;
  const colorCh = alpha ? channels - 1 : channels;
  let se = 0;
  let seAlpha = 0;
  let maxAbs = 0;
  let diffPixels = 0;
  const pixels = width * height;
  for (let p = 0; p < pixels; p++) {
    let differs = false;
    for (let c = 0; c < channels; c++) {
      const i = p * channels + c;
      const d = sample(a, i, bytesPerSample) - sample(b, i, bytesPerSample);
      if (d === 0) continue;
      differs = true;
      const ad = d < 0 ? -d : d;
      if (ad > maxAbs) maxAbs = ad;
      if (alpha && c === channels - 1) seAlpha += d * d;
      else se += d * d;
    }
    if (differs) diffPixels++;
  }
  const mse = se / (pixels * colorCh);
  const alphaMse = alpha ? seAlpha / pixels : null;
  const ssim = mse === 0 ? 1 : ssimLuma(luma(a, width, height, pixFmt), luma(b, width, height, pixFmt), width, height, peak);
  return {
    mse,
    psnrDb: psnrFromMse(mse, peak),
    ssim,
    maxAbsDiff: maxAbs,
    diffPixelPct: (diffPixels / pixels) * 100,
    alphaMse,
    alphaPsnrDb: alphaMse === null ? null : psnrFromMse(alphaMse, peak),
  };
}

/** Mean squared difference of two equally sized grayscale thumbnails. */
export function thumbMse(a: Buffer, b: Buffer): number {
  if (a.length !== b.length) return Infinity;
  let se = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - b[i]!;
    se += d * d;
  }
  return se / a.length;
}
