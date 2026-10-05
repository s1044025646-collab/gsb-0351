import { ERR, GddError, LIMITS } from "./errors.ts";

export interface Sample {
  /** integer minutes from the season origin t0, strictly increasing */
  t: number;
  /** temperature in Celsius */
  temp: number;
}

export interface StageDef {
  id: number;
  name: string;
  /** positive, strictly increasing cumulative GDD threshold in Celsius-days */
  threshold: number;
}

export interface Crossing {
  /** minutes from t0 where the linear segment crosses a threshold */
  t: number;
  kind: "Tb" | "Tu";
  temp: number;
}

export interface Segment {
  t0: number;
  t1: number;
  eff0: number;
  eff1: number;
  areaCMin: number;
}

export interface IntervalDetail {
  index: number; // interval between sample[index] and sample[index+1]
  t0: number;
  t1: number;
  temp0: number;
  temp1: number;
  deltaTemp: number;
  durationMin: number;
  crossings: Crossing[];
  segments: Segment[];
  gddCMin: number;
  gddCDay: number;
  cumulativeCDay: number;
}

export interface StageStatus {
  id: number;
  name: string;
  threshold: number;
  status: "reached" | "pending";
  /** first interval during which cumulative GDD reached the threshold */
  reachedBetween?: { fromIndex: number; toIndex: number; fromT: number; toT: number };
}

export interface AnalysisResult {
  tb: number;
  tu: number;
  maxGapMinutes: number;
  t0Description: string;
  sampleCount: number;
  durationMin: number;
  totalGddCDay: number;
  intervals: IntervalDetail[];
  stages: StageStatus[];
}

/** effective (clipped) temperature: max(0, min(T, Tu) - Tb) */
export function effTemp(temp: number, tb: number, tu: number): number {
  return Math.max(0, Math.min(temp, tu) - tb);
}

export function validateSamples(points: Sample[]): Sample[] {
  if (!Array.isArray(points)) throw new GddError(ERR.BAD_REQUEST, "points must be an array");
  if (points.length === 0) throw new GddError(ERR.EMPTY_SERIES, "observation series is empty");
  if (points.length > LIMITS.MAX_POINTS)
    throw new GddError(ERR.TOO_MANY_OBSERVATIONS, `too many observations (max ${LIMITS.MAX_POINTS})`);
  let prev = -Infinity;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (typeof p?.t !== "number" || !Number.isFinite(p.t) || !Number.isInteger(p.t))
      throw new GddError(ERR.NON_FINITE_TIME, `point ${i}: t must be a finite integer (minutes)`, { index: i });
    if (typeof p?.temp !== "number" || !Number.isFinite(p.temp))
      throw new GddError(ERR.NON_FINITE_TEMP, `point ${i}: temp must be finite`, { index: i });
    if (Math.abs(p.temp) > LIMITS.MAX_ABS_TEMP)
      throw new GddError(ERR.VALUE_OUT_OF_RANGE, `point ${i}: |temp| exceeds ${LIMITS.MAX_ABS_TEMP}`, { index: i });
    if (p.t === prev) throw new GddError(ERR.DUPLICATE_TIME, `duplicate time ${p.t}`, { index: i });
    if (p.t < prev) throw new GddError(ERR.TIME_NOT_INCREASING, `time not strictly increasing at index ${i}`, { index: i });
    prev = p.t;
  }
  const range = points[points.length - 1].t - points[0].t;
  if (range > LIMITS.MAX_RANGE_MINUTES)
    throw new GddError(ERR.RANGE_EXCEEDED, `time range exceeds ${LIMITS.MAX_RANGE_MINUTES} minutes`);
  return points;
}

export function validateThresholds(tb: number, tu: number): void {
  for (const [k, v] of [["tb", tb], ["tu", tu]] as const) {
    if (typeof v !== "number" || !Number.isFinite(v))
      throw new GddError(ERR.INVALID_THRESHOLDS, `${k} must be finite`);
    if (Math.abs(v) > LIMITS.MAX_ABS_THRESHOLD)
      throw new GddError(ERR.VALUE_OUT_OF_RANGE, `${k} out of range`);
  }
  if (!(tb < tu)) throw new GddError(ERR.INVALID_THRESHOLDS, "require Tb < Tu");
}

export function validateStages(stages: StageDef[]): StageDef[] {
  if (!Array.isArray(stages)) throw new GddError(ERR.BAD_REQUEST, "stages must be an array");
  if (stages.length > LIMITS.MAX_STAGES) throw new GddError(ERR.INVALID_STAGE, "too many stages");
  const seen = new Set<number>();
  let prev = 0;
  for (const s of stages) {
    if (!Number.isInteger(s.id)) throw new GddError(ERR.INVALID_STAGE, "stage id must be an integer");
    if (seen.has(s.id)) throw new GddError(ERR.DUPLICATE_STAGE_ID, `duplicate stage id ${s.id}`);
    seen.add(s.id);
    if (typeof s.name !== "string" || s.name.length === 0)
      throw new GddError(ERR.INVALID_STAGE, "stage name must be a non-empty string");
    if (typeof s.threshold !== "number" || !Number.isFinite(s.threshold) || s.threshold <= 0)
      throw new GddError(ERR.INVALID_STAGE, `stage ${s.id}: threshold must be a positive finite number`);
    if (s.threshold > LIMITS.MAX_STAGE_THRESHOLD)
      throw new GddError(ERR.VALUE_OUT_OF_RANGE, `stage ${s.id}: threshold too large`);
    if (s.threshold <= prev)
      throw new GddError(ERR.STAGE_THRESHOLD_NOT_INCREASING, "stage thresholds must be strictly increasing");
    prev = s.threshold;
  }
  return stages;
}

export function validateGap(maxGapMinutes: number): void {
  if (typeof maxGapMinutes !== "number" || !Number.isFinite(maxGapMinutes) || maxGapMinutes <= 0)
    throw new GddError(ERR.BAD_REQUEST, "maxGapMinutes must be a positive finite number");
  if (maxGapMinutes > LIMITS.MAX_GAP_MINUTES)
    throw new GddError(ERR.VALUE_OUT_OF_RANGE, `maxGapMinutes exceeds ${LIMITS.MAX_GAP_MINUTES}`);
}

/**
 * Integrate effective temperature over one interval by splitting at the exact
 * crossings of Tb / Tu, then summing triangle/trapezoid areas of the clipped
 * effective temperature. Never clips endpoints first nor averages then clips.
 */
export function integrateInterval(
  index: number, t0: number, temp0: number, t1: number, temp1: number,
  tb: number, tu: number, cumulativeBefore: number,
): IntervalDetail {
  const crossings: Crossing[] = [];
  const dT = temp1 - temp0;
  if (dT !== 0) {
    for (const [kind, level] of [["Tb", tb], ["Tu", tu]] as const) {
      const frac = (level - temp0) / dT;
      if (frac > 0 && frac < 1) {
        crossings.push({ t: t0 + frac * (t1 - t0), kind, temp: level });
      }
    }
    crossings.sort((a, b) => a.t - b.t);
  }
  const breaks = [t0, ...crossings.map((c) => c.t), t1];
  const segments: Segment[] = [];
  let area = 0;
  for (let i = 0; i + 1 < breaks.length; i++) {
    const s0 = breaks[i], s1 = breaks[i + 1];
    const f = (s: number) => temp0 + ((s - t0) / (t1 - t0)) * dT;
    const e0 = effTemp(f(s0), tb, tu);
    const e1 = effTemp(f(s1), tb, tu);
    const a = ((e0 + e1) / 2) * (s1 - s0);
    segments.push({ t0: s0, t1: s1, eff0: e0, eff1: e1, areaCMin: a });
    area += a;
  }
  const gddCDay = area / 1440;
  return {
    index, t0, t1, temp0, temp1,
    deltaTemp: dT,
    durationMin: t1 - t0,
    crossings, segments,
    gddCMin: area,
    gddCDay,
    cumulativeCDay: cumulativeBefore + gddCDay,
  };
}

export function analyze(
  points: Sample[], tb: number, tu: number, stages: StageDef[],
  maxGapMinutes: number, t0Description = "",
): AnalysisResult {
  validateSamples(points);
  validateThresholds(tb, tu);
  validateStages(stages);
  validateGap(maxGapMinutes);

  const gaps: { fromIndex: number; toIndex: number; fromT: number; toT: number; gapMinutes: number }[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const gap = points[i + 1].t - points[i].t;
    if (gap > maxGapMinutes)
      gaps.push({ fromIndex: i, toIndex: i + 1, fromT: points[i].t, toT: points[i + 1].t, gapMinutes: gap });
  }
  if (gaps.length > 0)
    throw new GddError(ERR.GAP_EXCEEDED, `sampling gap exceeds maxGapMinutes=${maxGapMinutes}`, gaps);

  const intervals: IntervalDetail[] = [];
  let cumulative = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const iv = integrateInterval(i, points[i].t, points[i].temp, points[i + 1].t, points[i + 1].temp, tb, tu, cumulative);
    intervals.push(iv);
    cumulative = iv.cumulativeCDay;
  }

  const stageStatus: StageStatus[] = stages.map((s) => ({ ...s, status: "pending" as const }));
  for (const s of stageStatus) {
    for (const iv of intervals) {
      if (iv.cumulativeCDay >= s.threshold) {
        s.status = "reached";
        s.reachedBetween = {
          fromIndex: iv.index, toIndex: iv.index + 1,
          fromT: iv.t0, toT: iv.t1,
        };
        break;
      }
    }
  }

  return {
    tb, tu, maxGapMinutes, t0Description,
    sampleCount: points.length,
    durationMin: points.length > 1 ? points[points.length - 1].t - points[0].t : 0,
    totalGddCDay: cumulative,
    intervals,
    stages: stageStatus,
  };
}
