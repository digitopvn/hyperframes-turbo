/**
 * Audio presence, format and A/V sync of a candidate against the reference.
 *
 * Both tracks are decoded by the same FFmpeg to mono f32 at ANALYSIS_RATE.
 * A/V offset = container offset (audio start - video start, candidate minus
 * reference) + content lag from normalised cross-correlation of the amplitude
 * envelope in up to three windows centred on the strongest onsets, at least
 * 1 s apart (so a constant offset and a drift both show). Lag resolution is
 * 1 / ANALYSIS_RATE s. A track with no onset (steady tone) has no measurable
 * content lag; then only the container offset counts and `windows` is empty.
 */
import { inputArgs, type MediaProbe } from "../probe.js";
import { FFMPEG, runTool } from "../proc.js";

export const ANALYSIS_RATE = 8000;
const WINDOW_SEC = 1.5;
const MAX_LAG_SEC = 0.25;
const SILENCE_RMS = 1e-4;

async function decodeMono(probe: MediaProbe): Promise<Float32Array> {
  const r = await runTool(FFMPEG, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    ...inputArgs(probe.input, probe),
    "-map",
    "0:a:0",
    "-ac",
    "1",
    "-ar",
    String(ANALYSIS_RATE),
    "-f",
    "f32le",
    "pipe:1",
  ]);
  const b = r.stdout;
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length - (b.length % 4)));
}

const rms = (x: Float32Array, a = 0, b = x.length): number => {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / Math.max(1, b - a));
};

/**
 * Amplitude envelope: moving average of |x| over ENVELOPE_SEC. Correlating the
 * envelope instead of the waveform avoids the period ambiguity of tonal audio
 * (a 220+330 Hz bed repeats every ~9 ms) while keeping sample-level lag
 * resolution for pure shifts.
 */
const ENVELOPE_SEC = 0.02;
function envelope(x: Float32Array): Float32Array {
  const w = Math.max(1, Math.round(ENVELOPE_SEC * ANALYSIS_RATE));
  const out = new Float32Array(x.length);
  let s = 0;
  for (let i = 0; i < x.length; i++) {
    s += Math.abs(x[i]!);
    if (i >= w) s -= Math.abs(x[i - w]!);
    out[i] = s / Math.min(i + 1, w);
  }
  return out;
}

/** Window starts centred on the strongest envelope rises (onsets, fade edges), >= 1 s apart. */
function transientWindows(env: Float32Array, len: number, maxLag: number, count: number): number[] {
  const step = Math.round(0.05 * ANALYSIS_RATE);
  const rises: Array<{ at: number; rise: number }> = [];
  for (let i = maxLag + len / 2; i + step < env.length - maxLag - len / 2; i += step) rises.push({ at: i, rise: env[i + step]! - env[i]! });
  rises.sort((a, b) => b.rise - a.rise);
  const picked: number[] = [];
  for (const r of rises) {
    if (picked.length >= count || r.rise < SILENCE_RMS) break;
    if (picked.every((p) => Math.abs(p - r.at) >= ANALYSIS_RATE)) picked.push(r.at);
  }
  return picked.sort((a, b) => a - b).map((c) => Math.round(c - len / 2));
}

/** Lag (samples) of `cand` relative to `ref` maximising mean-removed normalised correlation in [start, start+len). */
function bestLag(ref: Float32Array, cand: Float32Array, start: number, len: number, maxLag: number): { lag: number; corr: number } {
  let best = { lag: 0, corr: -Infinity };
  let mr = 0;
  for (let i = start; i < start + len; i++) mr += ref[i]!;
  mr /= len;
  let er = 0;
  for (let i = start; i < start + len; i++) er += (ref[i]! - mr) ** 2;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let mc = 0;
    for (let i = start; i < start + len; i++) {
      const j = i + lag;
      mc += j >= 0 && j < cand.length ? cand[j]! : 0;
    }
    mc /= len;
    let s = 0;
    let ec = 0;
    for (let i = start; i < start + len; i++) {
      const j = i + lag;
      const c = (j >= 0 && j < cand.length ? cand[j]! : 0) - mc;
      s += (ref[i]! - mr) * c;
      ec += c * c;
    }
    const corr = er > 0 && ec > 0 ? s / Math.sqrt(er * ec) : 0;
    // Strictly greater, scanning outward from 0, so ties resolve to the smallest |lag|.
    if (corr > best.corr + 1e-12 || (Math.abs(corr - best.corr) <= 1e-12 && Math.abs(lag) < Math.abs(best.lag))) best = { lag, corr };
  }
  return best;
}

export interface AudioWindow {
  atSec: number;
  lagMs: number | null;
  correlation: number | null;
  silent: boolean;
}

export interface AudioAnalysis {
  reference: { codec: string; sampleRate: number; channels: number; durationSec: number | null } | null;
  candidate: { codec: string; sampleRate: number; channels: number; durationSec: number | null } | null;
  /** (audio start - video start) of candidate minus the same for the reference, ms. */
  containerOffsetDeltaMs: number | null;
  windows: AudioWindow[];
  /** Max |container offset + content lag| over non-silent windows, ms. */
  avDriftMs: number | null;
  /** |decoded duration candidate - reference|, ms. */
  durationDeltaMs: number | null;
  /** RMS of (cand - ref) after alignment, relative to reference RMS, dB (-Infinity = identical). */
  residualDb: number | null;
}

export async function analyzeAudio(ref: MediaProbe, cand: MediaProbe): Promise<AudioAnalysis> {
  const desc = (p: MediaProbe) => (p.audio ? { codec: p.audio.codec, sampleRate: p.audio.sampleRate, channels: p.audio.channels, durationSec: p.audio.durationSec } : null);
  const base: AudioAnalysis = {
    reference: desc(ref),
    candidate: desc(cand),
    containerOffsetDeltaMs: null,
    windows: [],
    avDriftMs: null,
    durationDeltaMs: null,
    residualDb: null,
  };
  if (!ref.audio || !cand.audio || !ref.video || !cand.video) return base;
  const off = (p: MediaProbe) => (p.audio!.startTimeSec - p.video!.startTimeSec) * 1000;
  const containerDelta = off(cand) - off(ref);
  const [r, c] = await Promise.all([decodeMono(ref), decodeMono(cand)]);
  const len = Math.round(WINDOW_SEC * ANALYSIS_RATE);
  const maxLag = Math.round(MAX_LAG_SEC * ANALYSIS_RATE);
  const er = envelope(r);
  const ec = envelope(c);
  const starts = transientWindows(er, len, maxLag, 3);
  const windows: AudioWindow[] = starts.map((s) => {
    if (rms(r, s, s + len) < SILENCE_RMS) return { atSec: s / ANALYSIS_RATE, lagMs: null, correlation: null, silent: true };
    const b = bestLag(er, ec, s, len, maxLag);
    return { atSec: s / ANALYSIS_RATE, lagMs: (b.lag / ANALYSIS_RATE) * 1000, correlation: b.corr, silent: false };
  });
  const lags = windows.filter((w) => !w.silent).map((w) => w.lagMs!);
  const drift = lags.length ? Math.max(...lags.map((l) => Math.abs(l + containerDelta))) : Math.abs(containerDelta);
  // Residual after removing the median lag.
  const sortedLags = [...lags].sort((a, b) => a - b);
  const lagSamples = sortedLags.length ? Math.round((sortedLags[Math.floor(sortedLags.length / 2)]! / 1000) * ANALYSIS_RATE) : 0;
  let se = 0;
  let n = 0;
  for (let i = 0; i < r.length; i++) {
    const j = i + lagSamples;
    const cv = j >= 0 && j < c.length ? c[j]! : 0;
    se += (cv - r[i]!) ** 2;
    n++;
  }
  const refRms = rms(r);
  const resRms = Math.sqrt(se / Math.max(1, n));
  return {
    ...base,
    containerOffsetDeltaMs: containerDelta,
    windows,
    avDriftMs: drift,
    durationDeltaMs: (Math.abs(r.length - c.length) / ANALYSIS_RATE) * 1000,
    residualDb: refRms > 0 ? (resRms === 0 ? -Infinity : 20 * Math.log10(resRms / refRms)) : null,
  };
}
