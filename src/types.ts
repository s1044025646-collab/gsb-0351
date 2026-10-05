/**
 * 领域类型定义。
 *
 * 时间轴：所有采样点使用从起点开始的整数分钟（minute offset），
 * 必须严格递增。温度单位为摄氏度。
 */

/** 单条温度观测：从起点开始的整数分钟 + 摄氏温度 */
export interface Observation {
  /** 从起点开始的分钟数（整数，严格递增） */
 minute: number;
  /** 摄氏温度 */
  temp: number;
}

/** 温度阈值配置 */
export interface Thresholds {
  /** 基温 Tb（摄氏度） */
  baseTemp: number;
  /** 上限温度 Tu（摄氏度，须严格大于 Tb） */
  upperTemp: number;
}

/** 阶段配置：严格递增的正积温门槛（摄氏度日） */
export interface Stage {
  /** 阶段编号（正整数，同一配置内唯一） */
  id: number;
  /** 阶段名称（不参与数值计算） */
  name: string;
  /** 达成所需累计有效积温（摄氏度日，严格递增、为正） */
  thresholdGdd: number;
}

/** 缺口规则：相邻观测允许的最大间隔（分钟） */
export interface GapRule {
  /** 最大允许采样间隔（分钟，正整数）；超过则拒绝整次分析 */
  maxIntervalMinutes: number;
}

/** 一份完整的分析输入配置（观测快照 + 阈值 + 阶段 + 缺口规则） */
export interface AnalysisConfig {
  /** 时间起点说明（自由文本，例如 2026-04-01T00:00:00+08:00） */
  originDescription: string;
  observations: Observation[];
  thresholds: Thresholds;
  stages: Stage[];
  gapRule: GapRule;
}

/** 交点类型 */
export type CrossingKind = "BASE" | "UPPER";

/** 阈值交点（线性插值与 Tb/Tu 水平线的交点） */
export interface Crossing {
  kind: CrossingKind;
  /** 交点所在分钟（可为分数） */
  minute: number;
  /** 交点温度，即对应阈值 */
  temp: number;
}

/** 区间内被交点切分后的一个积分分段（三角形或梯形） */
export interface IntegralSegment {
  /** 分段起点分钟 */
  startMinute: number;
  /** 分段终点分钟 */
  endMinute: number;
  /** 分段起点有效温度（摄氏度） */
  startEffective: number;
  /** 分段终点有效温度（摄氏度） */
  endEffective: number;
  /** 分段形状：仅一个端点在阈值上呈三角形时标注，否则为梯形 */
  shape: "TRIANGLE" | "TRAPEZOID" | "ZERO";
  /** 分段面积（摄氏度·分钟） */
  areaDegreeMinutes: number;
}

/** 单个采样区间的完整解释 */
export interface IntervalResult {
  /** 区间序号（从 0 开始） */
  index: number;
  startMinute: number;
  endMinute: number;
  startTemp: number;
  endTemp: number;
  /** 区间时长（分钟） */
  durationMinutes: number;
  /** 线性温度变化率（摄氏度/分钟） */
  slopePerMinute: number;
  crossings: Crossing[];
  segments: IntegralSegment[];
  /** 区间有效积温（摄氏度·分钟） */
  intervalDegreeMinutes: number;
  /** 区间有效积温（摄氏度·日） */
  intervalGdd: number;
  /** 截至本区间末的累计有效积温（摄氏度·日） */
  cumulativeGdd: number;
}

/** 单个阶段的状态 */
export interface StageStatus {
  stageId: number;
  name: string;
  thresholdGdd: number;
  /** 是否已达成（恰好达到也算达成） */
  reached: boolean;
  /**
   * 首次跨过门槛所在区间的序号（后一个观测的区间下标）。
   * 未达成时为 null。不反求精确时刻。
   */
  crossedBetweenIndex: number | null;
  /** 跨越发生在哪两个观测分钟之间（仅定位，不声称真实时刻） */
  crossedBetweenMinutes: [number, number] | null;
}

/** 一次完整分析的结果 */
export interface AnalysisReport {
  reportId: number;
  configId: number;
  createdAt: string;
  accepted: boolean;
  /** 被拒绝时的缺口说明（可多个） */
  gaps: GapViolation[];
  totalDegreeMinutes: number;
  totalGdd: number;
  intervals: IntervalResult[];
  stages: StageStatus[];
  observationCount: number;
  spanMinutes: number;
}

/** 缺口违例 */
export interface GapViolation {
  intervalIndex: number;
  startMinute: number;
  endMinute: number;
  intervalMinutes: number;
  maxAllowedMinutes: number;
}

/** 输入量级限制 */
export const LIMITS = {
  /** 最大观测条数 */
  MAX_OBSERVATIONS: 100000,
  /** 时间轴最大范围（分钟），约 3 年 */
  MAX_MINUTE: 1_500_000,
  /** 温度绝对值上限（摄氏度） */
  MAX_ABS_TEMP: 200,
  /** 阈值绝对值上限 */
  MAX_ABS_THRESHOLD: 200,
  /** 最大允许采样间隔上限（分钟），30 天 */
  MAX_INTERVAL_MINUTES: 43200,
  /** 阶段数量上限 */
  MAX_STAGES: 1000,
  /** 积温门槛上限（摄氏度·日） */
  MAX_STAGE_GDD: 1_000_000,
} as const;

/** 摄氏度·分钟 -> 摄氏度·日 的换算除数 */
export const MINUTES_PER_DAY = 1440;
