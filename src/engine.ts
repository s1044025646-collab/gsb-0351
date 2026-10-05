/**
 * 有效积温积分引擎。
 *
 * 模型（唯一实现的模型）：
 *   瞬时有效温度 eff(T) = max(0, min(T, Tu) - Tb)
 *
 * 在相邻采样点之间对温度做线性插值，并对“截断之后”的有效温度
 * 关于时间积分。区间跨越 Tb 或 Tu 时，先在交点处把区间切分成
 * 若干段，再逐段累计三角形 / 梯形面积：
 *   - 绝不在端点先截断后只做一个梯形；
 *   - 绝不先平均温度再截断。
 *
 * 面积单位为 °C·分钟，除以 1440 换算为 °C·日。
 */

import type {
  AnalysisConfig,
  Crossing,
  GapViolation,
  IntegralSegment,
  IntervalResult,
  StageStatus,
} from "./types.js";
import { MINUTES_PER_DAY } from "./types.js";

const EPS = 1e-9;

/** 瞬时有效温度 max(0, min(T, Tu) - Tb) */
export function effectiveTemp(
  temp: number,
  baseTemp: number,
  upperTemp: number,
): number {
  const clipped = Math.min(temp, upperTemp);
  return Math.max(0, clipped - baseTemp);
}

interface Breakpoint {
  minute: number;
  temp: number;
}

/**
 * 计算一个采样区间内的全部内容：温度变化、交点、分段面积、
 * 区间积温。调用方负责累计 cumulativeGdd。
 */
export function integrateInterval(
  index: number,
  startMinute: number,
  startTemp: number,
  endMinute: number,
  endTemp: number,
  baseTemp: number,
  upperTemp: number,
): Omit<IntervalResult, "cumulativeGdd"> {
  const duration = endMinute - startMinute;

  // 零时长（单点序列 / 相同端点）：面积恒为 0。
  if (duration === 0) {
    return {
      index,
      startMinute,
      endMinute,
      startTemp,
      endTemp,
      durationMinutes: 0,
      slopePerMinute: 0,
      crossings: [],
      segments: [],
      intervalDegreeMinutes: 0,
      intervalGdd: 0,
    };
  }

  const slope = (endTemp - startTemp) / duration;
  const tempAt = (minute: number) =>
    startTemp + slope * (minute - startMinute);

  // 收集严格落在区间内部的阈值交点（温度线性，与每条水平线最多一个交点）。
  const crossings: Crossing[] = [];
  const inner: Breakpoint[] = [];
  const collect = (kind: Crossing["kind"], level: number) => {
    const lo = Math.min(startTemp, endTemp);
    const hi = Math.max(startTemp, endTemp);
    if (level > lo + EPS && level < hi - EPS) {
      // 线性插值求交点分钟：startTemp + slope*(m-startMinute) = level
      const minute = startMinute + (level - startTemp) / slope;
      if (minute > startMinute + EPS && minute < endMinute - EPS) {
        crossings.push({ kind, minute, temp: level });
        inner.push({ minute, temp: level });
      }
    }
  };
  collect("BASE", baseTemp);
  collect("UPPER", upperTemp);

  inner.sort((a, b) => a.minute - b.minute);

  const points: Breakpoint[] = [
    { minute: startMinute, temp: startTemp },
    ...inner,
    { minute: endMinute, temp: endTemp },
  ];

  const segments: IntegralSegment[] = [];
  let totalArea = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    const segDuration = p1.minute - p0.minute;
    const eff0 = effectiveTemp(p0.temp, baseTemp, upperTemp);
    const eff1 = effectiveTemp(p1.temp, baseTemp, upperTemp);
    // 有效温度在分段内不会穿越 0（交点已切开），故梯形公式即三角形/梯形面积。
    const area = ((eff0 + eff1) / 2) * segDuration;
    const shape: IntegralSegment["shape"] =
      eff0 === 0 && eff1 === 0
        ? "ZERO"
        : eff0 === 0 || eff1 === 0
          ? "TRIANGLE"
          : "TRAPEZOID";
    segments.push({
      startMinute: p0.minute,
      endMinute: p1.minute,
      startEffective: round(eff0),
      endEffective: round(eff1),
      shape,
      areaDegreeMinutes: round(area),
    });
    totalArea += area;
  }

  crossings.sort((a, b) => a.minute - b.minute);

  return {
    index,
    startMinute,
    endMinute,
    startTemp,
    endTemp,
    durationMinutes: duration,
    slopePerMinute: slope,
    crossings: crossings.map((c) => ({ ...c, minute: round(c.minute) })),
    segments,
    intervalDegreeMinutes: round(totalArea),
    intervalGdd: round(totalArea / MINUTES_PER_DAY),
  };
}

/** 找出超过最大允许间隔的缺口 */
export function findGaps(
  observations: { minute: number }[],
  maxIntervalMinutes: number,
): GapViolation[] {
  const gaps: GapViolation[] = [];
  for (let i = 0; i < observations.length - 1; i++) {
    const delta =
      observations[i + 1].minute - observations[i].minute;
    if (delta > maxIntervalMinutes) {
      gaps.push({
        intervalIndex: i,
        startMinute: observations[i].minute,
        endMinute: observations[i + 1].minute,
        intervalMinutes: delta,
        maxAllowedMinutes: maxIntervalMinutes,
      });
    }
  }
  return gaps;
}

export interface EngineOutcome {
  accepted: boolean;
  gaps: GapViolation[];
  intervals: IntervalResult[];
  stages: StageStatus[];
  totalDegreeMinutes: number;
  totalGdd: number;
  spanMinutes: number;
}

/**
 * 执行整份配置的分析（纯函数）。
 * 若存在长缺口，accepted=false 且不给出任何积温/阶段断言。
 */
export function analyze(config: AnalysisConfig): EngineOutcome {
  const { observations, thresholds, stages, gapRule } = config;
  const gaps = findGaps(observations, gapRule.maxIntervalMinutes);

  const span =
    observations.length >= 1
      ? observations[observations.length - 1].minute -
        observations[0].minute
      : 0;

  if (gaps.length > 0) {
    // 拒绝整次分析：阶段一律保留待达，不产生完整季节累计结论。
    return {
      accepted: false,
      gaps,
      intervals: [],
      stages: stages.map((s) => ({
        stageId: s.id,
        name: s.name,
        thresholdGdd: s.thresholdGdd,
        reached: false,
        crossedBetweenIndex: null,
        crossedBetweenMinutes: null,
      })),
      totalDegreeMinutes: 0,
      totalGdd: 0,
      spanMinutes: span,
    };
  }

  const intervals: IntervalResult[] = [];
  let cumulativeMinutes = 0;

  // 每个阶段首次跨越所在区间（恰好在区间末端达到也算该区间跨越）。
  const stageCross = new Map<number, number>();

  for (let i = 0; i < observations.length - 1; i++) {
    const a = observations[i];
    const b = observations[i + 1];
    const part = integrateInterval(
      i,
      a.minute,
      a.temp,
      b.minute,
      b.temp,
      thresholds.baseTemp,
      thresholds.upperTemp,
    );
    const before = cumulativeMinutes;
    cumulativeMinutes += part.intervalDegreeMinutes;
    const after = cumulativeMinutes;
    const beforeGdd = before / MINUTES_PER_DAY;
    const afterGdd = after / MINUTES_PER_DAY;

    for (const stage of stages) {
      if (
        !stageCross.has(stage.id) &&
        beforeGdd < stage.thresholdGdd - EPS &&
        afterGdd >= stage.thresholdGdd - EPS
      ) {
        stageCross.set(stage.id, i);
      }
    }

    intervals.push({ ...part, cumulativeGdd: round(afterGdd) });
  }

  // 单点序列：只有一个零时长、零积温的占位区间视图不适用；
  // 返回空区间列表，累计为 0（语义上即零时长零积温）。
  const stageStatuses: StageStatus[] = stages.map((s) => {
    const idx = stageCross.get(s.id) ?? null;
    const reached = idx !== null;
    return {
      stageId: s.id,
      name: s.name,
      thresholdGdd: s.thresholdGdd,
      reached,
      crossedBetweenIndex: idx,
      crossedBetweenMinutes:
        idx !== null
          ? [observations[idx].minute, observations[idx + 1].minute]
          : null,
    };
  });

  return {
    accepted: true,
    gaps: [],
    intervals,
    stages: stageStatuses,
    totalDegreeMinutes: round(cumulativeMinutes),
    totalGdd: round(cumulativeMinutes / MINUTES_PER_DAY),
    spanMinutes: span,
  };
}

/** 统一保留 10 位小数，消除浮点噪声，同时不损失几何精度 */
function round(x: number): number {
  if (!Number.isFinite(x)) return x;
  return Math.round(x * 1e10) / 1e10;
}
