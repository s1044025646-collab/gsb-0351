import { DomainError } from "./errors.js";
import type {
  AnalysisConfig,
  Observation,
  Stage,
  Thresholds,
  GapRule,
} from "./types.js";
import { LIMITS } from "./types.js";

const isFiniteNum = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

/** 校验观测序列；返回规范化后的观测（不修改原值） */
export function validateObservations(input: unknown): Observation[] {
  if (!Array.isArray(input)) {
    throw new DomainError("BAD_REQUEST", "observations 必须是数组");
  }
  if (input.length === 0) {
    throw new DomainError("EMPTY_SEQUENCE", "观测序列不能为空");
  }
  if (input.length > LIMITS.MAX_OBSERVATIONS) {
    throw new DomainError(
      "TOO_MANY_OBSERVATIONS",
      `观测数量超过上限 ${LIMITS.MAX_OBSERVATIONS}`,
      { count: input.length, limit: LIMITS.MAX_OBSERVATIONS },
    );
  }

  const out: Observation[] = [];
  for (let i = 0; i < input.length; i++) {
    const row = input[i];
    if (
      row === null ||
      typeof row !== "object" ||
      !("minute" in row) ||
      !("temp" in row)
    ) {
      throw new DomainError("BAD_REQUEST", `第 ${i} 条观测格式非法`);
    }
    const minute = (row as Observation).minute;
    const temp = (row as Observation).temp;
    if (!isFiniteNum(temp)) {
      throw new DomainError(
        "NON_FINITE_TEMP",
        `第 ${i} 条观测温度不是有限数值`,
        { index: i },
      );
    }
    if (Math.abs(temp) > LIMITS.MAX_ABS_TEMP) {
      throw new DomainError(
        "TEMP_OUT_OF_RANGE",
        `第 ${i} 条观测温度超出允许量级 ±${LIMITS.MAX_ABS_TEMP}°C`,
        { index: i, temp },
      );
    }
    if (!isFiniteNum(minute) || !Number.isInteger(minute)) {
      throw new DomainError(
        "NON_INTEGER_MINUTE",
        `第 ${i} 条观测时间不是整数分钟`,
        { index: i, minute },
      );
    }
    if (minute < 0 || minute > LIMITS.MAX_MINUTE) {
      throw new DomainError(
        "TIME_OUT_OF_RANGE",
        `第 ${i} 条观测时间超出范围 [0, ${LIMITS.MAX_MINUTE}] 分钟`,
        { index: i, minute },
      );
    }
    if (i > 0) {
      const prev = out[i - 1].minute;
      if (minute === prev) {
        throw new DomainError(
          "DUPLICATE_TIME",
          `第 ${i} 条观测与前一条时间重复（${minute}）`,
          { index: i, minute },
        );
      }
      if (minute < prev) {
        throw new DomainError(
          "TIME_NOT_STRICTLY_INCREASING",
          `第 ${i} 条观测时间早于前一条（${minute} < ${prev}），时间必须严格递增`,
          { index: i, minute, previous: prev },
        );
      }
    }
    out.push({ minute, temp });
  }
  return out;
}

export function validateThresholds(input: unknown): Thresholds {
  if (input === null || typeof input !== "object") {
    throw new DomainError("BAD_REQUEST", "thresholds 必须是对象");
  }
  const t = input as Record<string, unknown>;
  const baseTemp = t.baseTemp;
  const upperTemp = t.upperTemp;
  if (!isFiniteNum(baseTemp)) {
    throw new DomainError("INVALID_BASE_TEMP", "baseTemp 必须是有限数值");
  }
  if (!isFiniteNum(upperTemp)) {
    throw new DomainError("INVALID_UPPER_TEMP", "upperTemp 必须是有限数值");
  }
  if (Math.abs(baseTemp) > LIMITS.MAX_ABS_THRESHOLD) {
    throw new DomainError(
      "INVALID_BASE_TEMP",
      `baseTemp 超出允许量级 ±${LIMITS.MAX_ABS_THRESHOLD}`,
    );
  }
  if (Math.abs(upperTemp) > LIMITS.MAX_ABS_THRESHOLD) {
    throw new DomainError(
      "INVALID_UPPER_TEMP",
      `upperTemp 超出允许量级 ±${LIMITS.MAX_ABS_THRESHOLD}`,
    );
  }
  if (!(upperTemp > baseTemp)) {
    throw new DomainError(
      "UPPER_NOT_ABOVE_BASE",
      "upperTemp 必须严格大于 baseTemp",
      { baseTemp, upperTemp },
    );
  }
  return { baseTemp, upperTemp };
}

export function validateStages(input: unknown): Stage[] {
  if (!Array.isArray(input)) {
    throw new DomainError("BAD_REQUEST", "stages 必须是数组");
  }
  if (input.length > LIMITS.MAX_STAGES) {
    throw new DomainError(
      "TOO_MANY_STAGES",
      `阶段数量超过上限 ${LIMITS.MAX_STAGES}`,
    );
  }
  const seen = new Set<number>();
  let prevThreshold = 0;
  const out: Stage[] = [];
  for (let i = 0; i < input.length; i++) {
    const row = input[i];
    if (row === null || typeof row !== "object") {
      throw new DomainError("BAD_REQUEST", `第 ${i} 个阶段格式非法`);
    }
    const s = row as Record<string, unknown>;
    const id = s.id;
    const name = s.name;
    const thresholdGdd = s.thresholdGdd;
    if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
      throw new DomainError("BAD_REQUEST", `第 ${i} 个阶段 id 必须是正整数`);
    }
    if (seen.has(id)) {
      throw new DomainError(
        "DUPLICATE_STAGE_ID",
        `阶段编号 ${id} 重复`,
        { stageId: id },
      );
    }
    seen.add(id);
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new DomainError("BAD_REQUEST", `第 ${i} 个阶段名称不能为空`);
    }
    if (!isFiniteNum(thresholdGdd)) {
      throw new DomainError(
        "STAGE_THRESHOLD_NOT_POSITIVE",
        `阶段 ${id} 的门槛必须是有限数值`,
      );
    }
    if (!(thresholdGdd > 0)) {
      throw new DomainError(
        "STAGE_THRESHOLD_NOT_POSITIVE",
        `阶段 ${id} 的门槛必须为正数`,
        { stageId: id, thresholdGdd },
      );
    }
    if (thresholdGdd > LIMITS.MAX_STAGE_GDD) {
      throw new DomainError(
        "STAGE_THRESHOLD_OUT_OF_RANGE",
        `阶段 ${id} 的门槛超过上限 ${LIMITS.MAX_STAGE_GDD}`,
      );
    }
    if (i > 0 && !(thresholdGdd > prevThreshold)) {
      throw new DomainError(
        "STAGES_NOT_STRICTLY_INCREASING",
        `阶段 ${id} 的门槛未严格递增（${thresholdGdd} <= ${prevThreshold}）`,
        { stageId: id, thresholdGdd, previous: prevThreshold },
      );
    }
    prevThreshold = thresholdGdd;
    out.push({ id, name: name, thresholdGdd });
  }
  return out;
}

export function validateGapRule(input: unknown): GapRule {
  if (input === null || typeof input !== "object") {
    throw new DomainError("BAD_REQUEST", "gapRule 必须是对象");
  }
  const max = (input as Record<string, unknown>).maxIntervalMinutes;
  if (
    typeof max !== "number" ||
    !Number.isFinite(max) ||
    !Number.isInteger(max) ||
    max <= 0 ||
    max > LIMITS.MAX_INTERVAL_MINUTES
  ) {
    throw new DomainError(
      "INVALID_GAP_RULE",
      `maxIntervalMinutes 必须是 (0, ${LIMITS.MAX_INTERVAL_MINUTES}] 内的整数分钟`,
      { maxIntervalMinutes: max },
    );
  }
  return { maxIntervalMinutes: max };
}

/** 校验整份分析配置 */
export function validateConfig(input: unknown): AnalysisConfig {
  if (input === null || typeof input !== "object") {
    throw new DomainError("BAD_REQUEST", "请求体必须是对象");
  }
  const body = input as Record<string, unknown>;
  const originDescription = body.originDescription;
  if (
    typeof originDescription !== "string" ||
    originDescription.trim().length === 0
  ) {
    throw new DomainError(
      "INVALID_ORIGIN",
      "originDescription 必须是非空字符串（时间起点说明）",
    );
  }
  if (originDescription.length > 500) {
    throw new DomainError("INVALID_ORIGIN", "originDescription 过长（<=500）");
  }
  return {
    originDescription: originDescription.trim(),
    observations: validateObservations(body.observations),
    thresholds: validateThresholds(body.thresholds),
    stages: validateStages(body.stages ?? []),
    gapRule: validateGapRule(body.gapRule),
  };
}
