/**
 * Turns upstream `[Render:trace]` observation events into real time intervals
 * and computes how stages actually overlap.
 *
 * Upstream `perfSummary.stages` are per-stage durations; several of them run
 * concurrently (e.g. streaming encode overlaps capture), so summing them
 * overstates wall time. Here every `end` event contributes the interval
 * `[elapsedMs - durationMs, elapsedMs]` relative to the render's pipeline
 * start, and the timeline is swept to attribute each millisecond of wall
 * time to the set of stages active at that moment.
 */

export interface TraceEvent {
  phase: string;
  status: string;
  elapsedMs: number;
  durationMs?: number;
}

export interface StageInterval {
  phase: string;
  startMs: number;
  endMs: number;
}

export interface StageAttribution {
  phase: string;
  /** Sum of this stage's interval lengths (what naive summing would use). */
  activeMs: number;
  /** Wall time during which this stage was the ONLY active stage. */
  exclusiveMs: number;
  /** Wall time where this stage ran concurrently with at least one other stage. */
  overlappedMs: number;
  /** Wall time attributed to this stage when concurrent time is split evenly. */
  sharedAttributionMs: number;
  firstStartMs: number;
  lastEndMs: number;
}

export interface TraceAnalysis {
  intervals: StageInterval[];
  stages: StageAttribution[];
  /** Union of all stage intervals. */
  coveredMs: number;
  /** Render wall time not covered by any traced stage. */
  untracedMs: number;
  /** Sum of all stage active times divided by covered time (1 = fully serial). */
  concurrencyFactor: number;
  /**
   * Ordered chain of stages that bounds wall time: at each instant the stage
   * that ends last among active ones is "on the critical path". Consecutive
   * segments of the same stage are merged.
   */
  criticalPath: Array<{ phase: string; ms: number }>;
}

/** Trace phases that are wrappers around other phases, not work of their own. */
const CONTAINER_PHASES = new Set(["render", "render_job", "pipeline"]);

export function buildIntervals(events: TraceEvent[]): StageInterval[] {
  const out: StageInterval[] = [];
  for (const ev of events) {
    if (ev.status !== "end" || typeof ev.durationMs !== "number") continue;
    if (CONTAINER_PHASES.has(ev.phase)) continue;
    const endMs = ev.elapsedMs;
    const startMs = Math.max(0, endMs - ev.durationMs);
    if (endMs > startMs) out.push({ phase: ev.phase, startMs, endMs });
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

export function analyzeTrace(events: TraceEvent[], wallMs: number): TraceAnalysis {
  const intervals = buildIntervals(events);
  const boundaries = new Set<number>([0, wallMs]);
  for (const iv of intervals) {
    boundaries.add(iv.startMs);
    boundaries.add(iv.endMs);
  }
  const points = [...boundaries].sort((a, b) => a - b);

  const byPhase = new Map<string, StageAttribution>();
  const stat = (phase: string): StageAttribution => {
    let s = byPhase.get(phase);
    if (!s) {
      s = {
        phase,
        activeMs: 0,
        exclusiveMs: 0,
        overlappedMs: 0,
        sharedAttributionMs: 0,
        firstStartMs: Number.POSITIVE_INFINITY,
        lastEndMs: 0,
      };
      byPhase.set(phase, s);
    }
    return s;
  };
  for (const iv of intervals) {
    const s = stat(iv.phase);
    s.activeMs += iv.endMs - iv.startMs;
    s.firstStartMs = Math.min(s.firstStartMs, iv.startMs);
    s.lastEndMs = Math.max(s.lastEndMs, iv.endMs);
  }

  let coveredMs = 0;
  const critical: Array<{ phase: string; ms: number }> = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const len = b - a;
    if (len <= 0) continue;
    const active = intervals.filter((iv) => iv.startMs <= a && iv.endMs >= b);
    if (active.length === 0) continue;
    coveredMs += len;
    const phases = [...new Set(active.map((iv) => iv.phase))];
    for (const p of phases) {
      const s = stat(p);
      if (phases.length === 1) s.exclusiveMs += len;
      else s.overlappedMs += len;
      s.sharedAttributionMs += len / phases.length;
    }
    // The stage whose current interval ends last is what wall time waits on.
    const bounding = active.reduce((x, y) => (y.endMs > x.endMs ? y : x));
    const last = critical[critical.length - 1];
    if (last && last.phase === bounding.phase) last.ms += len;
    else critical.push({ phase: bounding.phase, ms: len });
  }

  const totalActive = [...byPhase.values()].reduce((a, s) => a + s.activeMs, 0);
  return {
    intervals,
    stages: [...byPhase.values()].sort((x, y) => y.sharedAttributionMs - x.sharedAttributionMs),
    coveredMs,
    untracedMs: Math.max(0, wallMs - coveredMs),
    concurrencyFactor: coveredMs > 0 ? totalActive / coveredMs : 0,
    criticalPath: critical,
  };
}
