/**
 * Reference-vs-candidate comparison in two steps:
 *   measure() - decode and compute every metric (no thresholds involved; the
 *               calibrator uses exactly this on reference/reference pairs);
 *   judge()   - turn measurements into fail-closed per-check verdicts using
 *               the calibrated thresholds and the fixture's declared needs.
 * Any exception inside a measurement is kept and becomes CHECK_ERROR (FAIL).
 */
import { decodeFrames, decodeThumbnails, PIXFMT_LAYOUT, type RawPixFmt } from "./decode.js";
import { analyzeAudio, ANALYSIS_RATE, SILENCE_RMS, type AudioAnalysis } from "./metrics/audio.js";
import { analyzeEncoded, type EncodedAnalysis } from "./metrics/encoded.js";
import { comparePixels, type PixelStats } from "./metrics/pixels.js";
import { analyzeTemporal, analyzeTimestamps, type TemporalAnalysis, type TimestampAnalysis } from "./metrics/temporal.js";
import { hasAlpha, hdrStaticMetadata, probeMedia, type MediaInput, type MediaProbe, type VideoInfo } from "./probe.js";
import { parseRational, ratEq, ratToString, type Rational } from "./rational.js";
import { buildSamplePlan, type FixtureFidelitySpec, type SampledFrame } from "./sample-plan.js";
import { toNum, within, type FixtureThresholds } from "./thresholds.js";
import { aggregate, check, done, notApplicable, type CheckResult, type Reason, type Verdict } from "./verdict.js";

export interface CompareContext {
  fixture: string;
  /** Declared fixture frame rate (meta.json renderConfig.fps). */
  fps: Rational;
  seed: string;
  cutTimes: number[];
  spec: FixtureFidelitySpec;
}

/** `count` consecutive frames from `from` carrying the same HDR static metadata (`value`, "" = none). */
export interface HdrRun {
  from: number;
  count: number;
  value: string;
}

export function hdrRuns(perFrame: string[]): HdrRun[] {
  const out: HdrRun[] = [];
  perFrame.forEach((value, i) => {
    const last = out[out.length - 1];
    if (last && last.value === value) last.count++;
    else out.push({ from: i, count: 1, value });
  });
  return out;
}

/** First frame (within both) whose HDR static metadata differs, or null. */
export function firstHdrFrameMismatch(r: HdrRun[], c: HdrRun[]): { frame: number; reference: string; candidate: string } | null {
  const expand = (runs: HdrRun[]) => runs.flatMap((x) => Array<string>(x.count).fill(x.value));
  const a = expand(r);
  const b = expand(c);
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return { frame: i, reference: a[i]!, candidate: b[i]! };
  return null;
}

export interface StreamSummary {
  codec: string;
  profile: string | null;
  pixFmt: string;
  width: number;
  height: number;
  sar: string | null;
  rFrameRate: string;
  frames: number;
  colorRange: string | null;
  colorSpace: string | null;
  colorTransfer: string | null;
  colorPrimaries: string | null;
  alpha: boolean;
  /** Container/stream-level HDR static metadata (see `hdrStaticMetadata`). */
  hdrStream: string[];
  /** Per-frame HDR static metadata (SEI), run-length encoded over every frame. */
  hdrFrames: HdrRun[];
  formatName: string;
  sizeBytes: number;
  bitRate: number | null;
  audio: { codec: string; sampleRate: number; channels: number } | null;
}

export interface FrameComparison extends PixelStats {
  index: number;
  reasons: string[];
}

export interface Measurements {
  fixture: string;
  reference: StreamSummary | null;
  candidate: StreamSummary | null;
  timestamps: { reference: TimestampAnalysis; candidate: TimestampAnalysis } | null;
  sampling: { seed: string; frames: SampledFrame[] } | null;
  pixels: { pixFmt: RawPixFmt; frames: FrameComparison[]; decodedReference: number; decodedCandidate: number } | null;
  /** Thumbnails of every frame; kept in memory for judge(), never serialised. */
  thumbs: { reference: Buffer[]; candidate: Buffer[] } | null;
  audio: AudioAnalysis | null;
  encoded: EncodedAnalysis | null;
  errors: Partial<Record<"probe" | "thumbnails" | "pixels" | "audio" | "encoded", string>>;
  peakRssBytes: number;
  wallMs: number;
}

function summarize(p: MediaProbe): StreamSummary {
  const v = p.video;
  if (!v) throw new Error(`${p.input.path}: no video stream`);
  return {
    codec: v.codec,
    profile: v.profile,
    pixFmt: v.pixFmt,
    width: v.width,
    height: v.height,
    sar: v.sar,
    rFrameRate: v.rFrameRate,
    frames: v.frames.length,
    colorRange: v.colorRange,
    colorSpace: v.colorSpace,
    colorTransfer: v.colorTransfer,
    colorPrimaries: v.colorPrimaries,
    alpha: hasAlpha(v),
    hdrStream: hdrStaticMetadata(v.streamSideData),
    hdrFrames: hdrRuns(v.frameSideData.map((l) => hdrStaticMetadata(l).join("\n"))),
    formatName: p.formatName,
    sizeBytes: p.sizeBytes,
    bitRate: p.bitRate,
    audio: p.audio ? { codec: p.audio.codec, sampleRate: p.audio.sampleRate, channels: p.audio.channels } : null,
  };
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function rawFormatFor(v: VideoInfo, needAlpha: boolean): RawPixFmt {
  const deep = /(9|10|12|14|16)(le|be)?$/.test(v.pixFmt) || (v.bitsPerRawSample ?? 8) > 8;
  if (needAlpha) return deep ? "rgba64le" : "rgba";
  return deep ? "rgb48le" : "rgb24";
}

export async function measure(refIn: MediaInput, candIn: MediaInput, ctx: CompareContext): Promise<Measurements> {
  const t0 = performance.now();
  const m: Measurements = {
    fixture: ctx.fixture,
    reference: null,
    candidate: null,
    timestamps: null,
    sampling: null,
    pixels: null,
    thumbs: null,
    audio: null,
    encoded: null,
    errors: {},
    peakRssBytes: 0,
    wallMs: 0,
  };
  let ref: MediaProbe;
  let cand: MediaProbe;
  try {
    [ref, cand] = await Promise.all([probeMedia(refIn), probeMedia(candIn)]);
    m.reference = summarize(ref);
    m.candidate = summarize(cand);
    m.timestamps = { reference: analyzeTimestamps(ref.video!, ctx.fps), candidate: analyzeTimestamps(cand.video!, ctx.fps) };
  } catch (e) {
    m.errors.probe = errMsg(e);
    m.wallMs = performance.now() - t0;
    m.peakRssBytes = process.resourceUsage().maxRSS * 1024;
    return m;
  }
  const sameGeometry = ref.video!.width === cand.video!.width && ref.video!.height === cand.video!.height;

  try {
    const [r, c] = await Promise.all([decodeThumbnails(ref), decodeThumbnails(cand)]);
    m.thumbs = { reference: r, candidate: c };
  } catch (e) {
    m.errors.thumbnails = errMsg(e);
  }

  try {
    const frames = buildSamplePlan({ frameCount: ref.video!.frames.length, fps: ctx.fps, seed: ctx.seed, cutTimes: ctx.cutTimes, probes: ctx.spec.probes });
    m.sampling = { seed: ctx.seed, frames };
    if (sameGeometry) {
      const pixFmt = rawFormatFor(ref.video!, !!ctx.spec.alpha || hasAlpha(ref.video!) || hasAlpha(cand.video!));
      const indices = frames.map((f) => f.index);
      const ri = decodeFrames(ref, { pixFmt, indices });
      const ci = decodeFrames(cand, { pixFmt, indices: indices.filter((i) => i < cand.video!.frames.length) });
      const out: FrameComparison[] = [];
      let nr = 0;
      let nc = 0;
      try {
        for (;;) {
          const [a, b] = await Promise.all([ri.next(), ci.next()]);
          if (!a.done) nr++;
          if (!b.done) nc++;
          if (a.done || b.done) break;
          if (a.value.index !== b.value.index) throw new Error(`decoder index skew ${a.value.index} vs ${b.value.index}`);
          const reasons = frames.find((f) => f.index === a.value.index)!.reasons;
          out.push({ index: a.value.index, reasons, ...comparePixels(a.value.data, b.value.data, ref.video!.width, ref.video!.height, pixFmt) });
        }
        // Drain whichever side still has frames, to count them.
        for (let x = await ri.next(); !x.done; x = await ri.next()) nr++;
        for (let x = await ci.next(); !x.done; x = await ci.next()) nc++;
      } finally {
        await ri.return(undefined);
        await ci.return(undefined);
      }
      m.pixels = { pixFmt, frames: out, decodedReference: nr, decodedCandidate: nc };
    }
  } catch (e) {
    m.errors.pixels = errMsg(e);
  }

  if (ref.audio || cand.audio) {
    try {
      m.audio = await analyzeAudio(ref, cand);
    } catch (e) {
      m.errors.audio = errMsg(e);
    }
  }

  if (sameGeometry) {
    try {
      const vmafApplicable = !ctx.spec.hdr && !ctx.spec.alpha && !hasAlpha(ref.video!);
      m.encoded = await analyzeEncoded(ref, cand, { vmafApplicable });
    } catch (e) {
      m.errors.encoded = errMsg(e);
    }
  }
  m.peakRssBytes = process.resourceUsage().maxRSS * 1024;
  m.wallMs = performance.now() - t0;
  return m;
}

export interface FidelityChecks {
  dimensions: CheckResult;
  frameCount: CheckResult;
  timestamps: CheckResult;
  temporal: CheckResult;
  pixels: CheckResult;
  audio: CheckResult;
  alpha: CheckResult;
  color: CheckResult;
  encoded: CheckResult;
}

export interface Judgement {
  verdict: Verdict;
  reasons: Reason[];
  checks: FidelityChecks;
}

const TEMPORAL_REASON: Record<string, Reason> = { dropped: "FRAME_DROPPED", duplicated: "FRAME_DUPLICATED", reordered: "FRAME_REORDERED", stale: "STALE_FRAME" };
const TRANSFER: Record<"pq" | "hlg", string> = { pq: "smpte2084", hlg: "arib-std-b67" };

function thresholdMissing<D>(details: D, why: string): CheckResult<D> {
  const c = check(details);
  c.fail("THRESHOLD_MISSING", why);
  return done(c);
}

function errored<D>(details: D, what: string, msg: string): CheckResult<D> {
  const c = check(details);
  c.fail("CHECK_ERROR", `${what}: ${msg}`);
  return done(c);
}

/** One audio codec frame in ms: the finest step at which an encoder can place audio. */
export function audioFrameMs(codec: string | undefined, sampleRate: number): number {
  if (codec === "aac") return (1024 / sampleRate) * 1000;
  if (codec === "opus") return 20;
  if (codec === "mp3") return (1152 / sampleRate) * 1000;
  return 1000 / ANALYSIS_RATE;
}

export function judge(m: Measurements, t: FixtureThresholds | null, thresholdProblem: string | null, ctx: CompareContext): Judgement {
  const r = m.reference;
  const c = m.candidate;
  const tp = thresholdProblem ?? "no thresholds for this fixture";
  let checks: FidelityChecks;
  if (!r || !c || m.errors.probe) {
    const e = errored({}, "probe", m.errors.probe ?? "missing stream summary");
    checks = { dimensions: e, frameCount: e, timestamps: e, temporal: e, pixels: e, audio: e, alpha: e, color: e, encoded: e };
  } else {
    checks = {
      dimensions: judgeDimensions(r, c),
      frameCount: judgeFrameCount(r, c),
      timestamps: judgeTimestamps(m, ctx),
      temporal: t ? judgeTemporal(m, t) : thresholdMissing({}, tp),
      pixels: t ? judgePixels(m, t) : thresholdMissing({}, tp),
      audio: judgeAudio(m, t, tp),
      alpha: judgeAlpha(m, t, tp, ctx),
      color: judgeColor(r, c, ctx),
      encoded: t ? judgeEncoded(m, t) : thresholdMissing({}, tp),
    };
  }
  const all = Object.values(checks) as CheckResult[];
  const reasons = [...new Set(all.flatMap((x) => x.reasons))];
  return { verdict: aggregate(all.map((x) => x.verdict)), reasons, checks };
}

function judgeDimensions(r: StreamSummary, c: StreamSummary): CheckResult {
  const k = check({ reference: { width: r.width, height: r.height, sar: r.sar, codec: r.codec, profile: r.profile, pixFmt: r.pixFmt }, candidate: { width: c.width, height: c.height, sar: c.sar, codec: c.codec, profile: c.profile, pixFmt: c.pixFmt } });
  if (r.width !== c.width || r.height !== c.height || r.sar !== c.sar) k.fail("DIMENSION_CHANGED", `${c.width}x${c.height} sar ${c.sar} vs reference ${r.width}x${r.height} sar ${r.sar}`);
  if (r.codec !== c.codec || r.pixFmt !== c.pixFmt) k.fail("CODEC_CHANGED", `${c.codec}/${c.pixFmt} vs reference ${r.codec}/${r.pixFmt}`);
  return done(k);
}

function judgeFrameCount(r: StreamSummary, c: StreamSummary): CheckResult {
  const k = check({ reference: r.frames, candidate: c.frames });
  if (r.frames !== c.frames) k.fail("FRAME_COUNT_MISMATCH", `${c.frames} frames vs reference ${r.frames}`);
  return done(k);
}

function judgeTimestamps(m: Measurements, ctx: CompareContext): CheckResult {
  const ts = m.timestamps!;
  const k = check({ declaredFps: ratToString(ctx.fps), reference: ts.reference, candidate: ts.candidate });
  const rate = (s: string) => {
    try {
      return parseRational(s);
    } catch {
      return null;
    }
  };
  const rr = rate(ts.reference.rFrameRate);
  const cr = rate(ts.candidate.rFrameRate);
  if (!rr || !ratEq(rr, ctx.fps)) k.fail("REFERENCE_INVALID", `reference r_frame_rate ${ts.reference.rFrameRate} != declared ${ratToString(ctx.fps)}`);
  if (!cr || !ratEq(cr, ctx.fps)) k.fail("FPS_CHANGED", `candidate r_frame_rate ${ts.candidate.rFrameRate} != declared ${ratToString(ctx.fps)}`);
  if (ts.candidate.vfr && !ts.reference.vfr) k.fail("VFR_DETECTED", `candidate has ${ts.candidate.distinctIntervals} distinct frame intervals; reference is CFR`);
  const allowed = Math.max(ts.reference.maxPtsErrorTicks ?? 0, 1);
  if (ts.candidate.maxPtsErrorTicks === null || ts.candidate.maxPtsErrorTicks > allowed)
    k.fail("PTS_DRIFT", `max |pts - i/fps| = ${ts.candidate.maxPtsErrorTicks} ticks at frame ${ts.candidate.maxPtsErrorFrame} (allowed ${allowed})`);
  if (ts.candidate.nonMonotonicPts > ts.reference.nonMonotonicPts || ts.candidate.missingPts > ts.reference.missingPts)
    k.fail("PTS_NON_MONOTONIC", `${ts.candidate.nonMonotonicPts} non-monotonic, ${ts.candidate.missingPts} missing PTS`);
  if (ts.candidate.dtsGreaterThanPts > ts.reference.dtsGreaterThanPts || ts.candidate.nonMonotonicDts > ts.reference.nonMonotonicDts)
    k.fail("DTS_INVALID", `${ts.candidate.dtsGreaterThanPts} packets with DTS > PTS, ${ts.candidate.nonMonotonicDts} non-monotonic DTS`);
  return done(k);
}

export function judgeTemporal(m: Measurements, t: FixtureThresholds): CheckResult {
  if (m.errors.thumbnails || !m.thumbs) return errored({}, "thumbnail decode", m.errors.thumbnails ?? "no thumbnails");
  const tol = toNum(t.temporal.thumbMseTol.limit);
  const a: TemporalAnalysis = analyzeTemporal(m.thumbs.reference, m.thumbs.candidate, tol);
  const k = check({ thumbMseTol: tol, ...a });
  for (const e of a.events) k.fail(TEMPORAL_REASON[e.kind]!, `candidate frame ${e.candidateIndex} shows reference frame ${e.showsReferenceIndex} (${e.kind})`);
  // A frame that matches no nearby reference frame has an unknown identity:
  // the temporal check cannot vouch for it, so it never passes blind.
  if (a.contentMismatchFrames > 0) k.fail("FRAME_CONTENT_UNIDENTIFIED", `${a.contentMismatchFrames} candidate frame(s) match no reference frame within +/-3 (thumbnail tolerance ${tol})`);
  return done(k);
}

function judgePixels(m: Measurements, t: FixtureThresholds): CheckResult {
  if (m.errors.pixels) return errored({}, "pixel decode", m.errors.pixels);
  if (!m.pixels) {
    const k = check({});
    k.fail("DIMENSION_CHANGED", "frames of different geometry cannot be compared pixel by pixel");
    return done(k);
  }
  const p = t.pixels;
  const k = check({
    pixFmt: m.pixels.pixFmt,
    limits: { maxMse: p.maxMse.limit, minSsim: p.minSsim.limit, maxAbsDiff: p.maxAbsDiff.limit, maxDiffPixelPct: p.maxDiffPixelPct.limit },
    sampled: m.sampling?.frames.length ?? 0,
    compared: m.pixels.frames.length,
    frames: m.pixels.frames,
  });
  if (!m.sampling || m.sampling.frames.length === 0) k.fail("CHECK_ERROR", "empty sample plan");
  if (m.pixels.frames.length < (m.sampling?.frames.length ?? 0)) k.fail("FRAME_COUNT_MISMATCH", `only ${m.pixels.frames.length} of ${m.sampling!.frames.length} sampled frames exist in the candidate`);
  for (const f of m.pixels.frames) {
    const bad: string[] = [];
    if (!within(f.mse, p.maxMse, "max")) bad.push(`mse ${f.mse.toFixed(4)}`);
    if (!within(f.ssim, p.minSsim, "min")) bad.push(`ssim ${f.ssim.toFixed(6)}`);
    if (!within(f.maxAbsDiff, p.maxAbsDiff, "max")) bad.push(`max|diff| ${f.maxAbsDiff}`);
    if (!within(f.diffPixelPct, p.maxDiffPixelPct, "max")) bad.push(`diff px ${f.diffPixelPct.toFixed(4)} %`);
    if (bad.length) k.fail("PIXEL_BELOW_THRESHOLD", `frame ${f.index} (${f.reasons.join(",")}): ${bad.join(", ")}`);
  }
  return done(k);
}

export function judgeAudio(m: Measurements, t: FixtureThresholds | null, tp: string): CheckResult {
  const r = m.reference!.audio;
  const c = m.candidate!.audio;
  if (!r && !c) return notApplicable({}, "neither output has audio");
  const k = check({ ...(m.audio ?? {}) });
  if (r && !c) {
    k.fail("AUDIO_MISSING", "reference has an audio stream; candidate has none");
    return done(k);
  }
  if (!r && c) {
    k.fail("AUDIO_UNEXPECTED", "candidate has audio; reference has none");
    return done(k);
  }
  if (r!.codec !== c!.codec || r!.sampleRate !== c!.sampleRate || r!.channels !== c!.channels)
    k.fail("AUDIO_FORMAT_CHANGED", `${c!.codec} ${c!.sampleRate} Hz ${c!.channels} ch vs reference ${r!.codec} ${r!.sampleRate} Hz ${r!.channels} ch`);
  if (m.errors.audio || !m.audio) {
    k.fail("CHECK_ERROR", `audio analysis: ${m.errors.audio ?? "missing"}`);
    return done(k);
  }
  if (!t?.audio) {
    k.fail("THRESHOLD_MISSING", t ? "no audio thresholds for this fixture" : tp);
    return done(k);
  }
  const a = m.audio;
  if (!within(a.avDriftMs, t.audio.maxAvDriftMs, "max")) k.fail("AV_DRIFT", `A/V offset ${a.avDriftMs?.toFixed(2)} ms > ${t.audio.maxAvDriftMs.limit} ms`);
  if (!within(a.durationDeltaMs, t.audio.maxDurationDeltaMs, "max")) k.fail("AUDIO_DURATION_MISMATCH", `audio duration differs by ${a.durationDeltaMs?.toFixed(2)} ms`);
  if (a.residualDb !== null) {
    if (!within(a.residualDb, t.audio.maxResidualDb, "max")) k.fail("AUDIO_MISMATCH", `residual ${a.residualDb.toFixed(2)} dB > ${t.audio.maxResidualDb.limit} dB`);
  } else if (a.residualRms === null) {
    k.fallback("CHECK_ERROR", "audio residual could not be measured");
  } else if (a.residualRms > SILENCE_RMS) {
    // Silent reference: the candidate must be silent too (absolute floor, -80 dBFS).
    k.fail("AUDIO_MISMATCH", `reference is silent but the candidate residual is ${(20 * Math.log10(a.residualRms)).toFixed(2)} dBFS > ${20 * Math.log10(SILENCE_RMS)} dBFS`);
  }
  return done(k);
}

function judgeAlpha(m: Measurements, t: FixtureThresholds | null, tp: string, ctx: CompareContext): CheckResult {
  const r = m.reference!;
  const c = m.candidate!;
  if (!ctx.spec.alpha && !r.alpha && !c.alpha) return notApplicable({}, "fixture declares no alpha and neither output has an alpha plane");
  const k = check({ declared: !!ctx.spec.alpha, reference: { pixFmt: r.pixFmt, alpha: r.alpha }, candidate: { pixFmt: c.pixFmt, alpha: c.alpha } });
  if (ctx.spec.alpha && !r.alpha) k.fail("REFERENCE_INVALID", "fixture declares alpha but the reference has no alpha plane");
  if (r.alpha && !c.alpha) k.fail("ALPHA_MISSING", `candidate ${c.pixFmt} has no alpha plane`);
  if (!r.alpha && c.alpha) k.fail("ALPHA_MISMATCH", "candidate has an alpha plane the reference does not");
  if (r.alpha && c.alpha) {
    if (!t) k.fail("THRESHOLD_MISSING", tp);
    else if (!t.pixels.maxAlphaMse) k.fail("THRESHOLD_MISSING", "no alpha threshold for this fixture");
    else if (!m.pixels) k.fail("CHECK_ERROR", `alpha planes not decoded: ${m.errors.pixels ?? "geometry differs"}`);
    else
      for (const f of m.pixels.frames)
        if (!within(f.alphaMse, t.pixels.maxAlphaMse, "max")) k.fail("ALPHA_MISMATCH", `frame ${f.index}: alpha mse ${f.alphaMse} > ${t.pixels.maxAlphaMse.limit}`);
  }
  return done(k);
}

export function judgeColor(r: StreamSummary, c: StreamSummary, ctx: CompareContext): CheckResult {
  const pick = (s: StreamSummary) => ({ transfer: s.colorTransfer, primaries: s.colorPrimaries, matrix: s.colorSpace, range: s.colorRange, pixFmt: s.pixFmt, hdrStream: s.hdrStream, hdrFrames: s.hdrFrames });
  const k = check({ declaredHdr: ctx.spec.hdr ?? null, reference: pick(r), candidate: pick(c) });
  if (ctx.spec.hdr && r.colorTransfer !== TRANSFER[ctx.spec.hdr]) k.fail("REFERENCE_INVALID", `fixture declares ${ctx.spec.hdr} but reference transfer is ${r.colorTransfer}`);
  const transferish = (r.colorTransfer !== c.colorTransfer || r.colorPrimaries !== c.colorPrimaries || r.colorSpace !== c.colorSpace);
  const hdr = !!ctx.spec.hdr || r.colorTransfer === "smpte2084" || r.colorTransfer === "arib-std-b67";
  if (transferish)
    k.fail(hdr ? "HDR_TRANSFER_MISMATCH" : "COLOR_METADATA_CHANGED", `transfer/primaries/matrix ${c.colorTransfer}/${c.colorPrimaries}/${c.colorSpace} vs reference ${r.colorTransfer}/${r.colorPrimaries}/${r.colorSpace}`);
  if (r.colorRange !== c.colorRange) k.fail(hdr ? "HDR_METADATA_MISMATCH" : "COLOR_METADATA_CHANGED", `range ${c.colorRange} vs reference ${r.colorRange}`);
  if (hdr) {
    // Container boxes and in-band SEI are independent carriers: a muxer can keep
    // one while the encoder drops the other, so each is compared on its own.
    if (JSON.stringify(r.hdrStream) !== JSON.stringify(c.hdrStream))
      k.fail("HDR_METADATA_MISMATCH", `container mastering/content-light metadata ${JSON.stringify(c.hdrStream)} vs reference ${JSON.stringify(r.hdrStream)}`);
    const d = firstHdrFrameMismatch(r.hdrFrames, c.hdrFrames);
    if (d) k.fail("HDR_METADATA_MISMATCH", `frame ${d.frame} SEI mastering/content-light ${d.candidate || "(none)"} vs reference ${d.reference || "(none)"}`);
  }
  return done(k);
}

function judgeEncoded(m: Measurements, t: FixtureThresholds): CheckResult {
  if (m.errors.encoded) return errored({}, "encoded analysis", m.errors.encoded);
  if (!m.encoded) {
    const k = check({});
    k.fail("DIMENSION_CHANGED", "outputs of different geometry cannot be compared");
    return done(k);
  }
  const e = m.encoded;
  const L = t.encoded;
  const k = check({ ...e, limits: { minPsnrDb: L.minPsnrDb.limit, minSsim: L.minSsim.limit, minVmaf: L.minVmaf?.limit ?? null, maxBitrateDropPct: L.maxBitrateDropPct.limit } });
  if (!within(e.psnrMinDb, L.minPsnrDb, "min")) k.fail("ENCODED_QUALITY_BELOW_THRESHOLD", `worst-frame PSNR ${e.psnrMinDb.toFixed(2)} dB < ${L.minPsnrDb.limit}`);
  if (!within(e.ssimMin, L.minSsim, "min")) k.fail("ENCODED_QUALITY_BELOW_THRESHOLD", `worst-frame SSIM ${e.ssimMin.toFixed(6)} < ${L.minSsim.limit}`);
  if (e.vmafSkipped === "tool-unavailable" || e.vmafSkipped === "disabled") k.fallback("TOOL_UNAVAILABLE", `VMAF ${e.vmafSkipped}`);
  else if (e.vmaf) {
    if (!L.minVmaf) k.fail("THRESHOLD_MISSING", "VMAF measured but not calibrated for this fixture");
    else if (!within(e.vmaf.min, L.minVmaf, "min")) k.fail("ENCODED_QUALITY_BELOW_THRESHOLD", `worst-frame VMAF ${e.vmaf.min.toFixed(3)} < ${L.minVmaf.limit}`);
  }
  const drop = e.bitRateDeltaPct === null ? null : -e.bitRateDeltaPct;
  if (!within(drop, L.maxBitrateDropPct, "max")) k.fail("BITRATE_DROP", `bitrate ${e.candidateBitRate} vs reference ${e.referenceBitRate} (${e.bitRateDeltaPct?.toFixed(2)} %)`);
  return done(k);
}
