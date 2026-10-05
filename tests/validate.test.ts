import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateObservations,
  validateThresholds,
  validateStages,
  validateGapRule,
  validateConfig,
} from "../src/validate.js";
import { DomainError } from "../src/errors.js";

function expectCode(fn: () => unknown, code: string): void {
  assert.throws(
    fn,
    (err: unknown) => err instanceof DomainError && err.code === code,
    `应抛出错误码 ${code}`,
  );
}

test("空序列 -> EMPTY_SEQUENCE", () => {
  expectCode(() => validateObservations([]), "EMPTY_SEQUENCE");
});

test("非有限温度 -> NON_FINITE_TEMP", () => {
  expectCode(
    () => validateObservations([{ minute: 0, temp: NaN }]),
    "NON_FINITE_TEMP",
  );
  expectCode(
    () => validateObservations([{ minute: 0, temp: Infinity }]),
    "NON_FINITE_TEMP",
  );
});

test("时间重排 -> TIME_NOT_STRICTLY_INCREASING", () => {
  expectCode(
    () =>
      validateObservations([
        { minute: 10, temp: 1 },
        { minute: 5, temp: 1 },
      ]),
    "TIME_NOT_STRICTLY_INCREASING",
  );
});

test("重复时间 -> DUPLICATE_TIME", () => {
  expectCode(
    () =>
      validateObservations([
        { minute: 10, temp: 1 },
        { minute: 10, temp: 2 },
      ]),
    "DUPLICATE_TIME",
  );
});

test("非整数分钟 -> NON_INTEGER_MINUTE", () => {
  expectCode(
    () => validateObservations([{ minute: 1.5, temp: 1 }]),
    "NON_INTEGER_MINUTE",
  );
});

test("温度/时间超量级", () => {
  expectCode(
    () => validateObservations([{ minute: 0, temp: 9999 }]),
    "TEMP_OUT_OF_RANGE",
  );
  expectCode(
    () => validateObservations([{ minute: 3_000_000, temp: 1 }]),
    "TIME_OUT_OF_RANGE",
  );
});

test("非法上下限", () => {
  expectCode(() => validateThresholds({ baseTemp: NaN, upperTemp: 5 }), "INVALID_BASE_TEMP");
  expectCode(
    () => validateThresholds({ baseTemp: 30, upperTemp: 10 }),
    "UPPER_NOT_ABOVE_BASE",
  );
  expectCode(
    () => validateThresholds({ baseTemp: 10, upperTemp: 10 }),
    "UPPER_NOT_ABOVE_BASE",
  );
});

test("重复阶段编号 -> DUPLICATE_STAGE_ID", () => {
  expectCode(
    () =>
      validateStages([
        { id: 1, name: "A", thresholdGdd: 1 },
        { id: 1, name: "B", thresholdGdd: 2 },
      ]),
    "DUPLICATE_STAGE_ID",
  );
});

test("阶段门槛非正/未递增", () => {
  expectCode(
    () => validateStages([{ id: 1, name: "A", thresholdGdd: 0 }]),
    "STAGE_THRESHOLD_NOT_POSITIVE",
  );
  expectCode(
    () =>
      validateStages([
        { id: 1, name: "A", thresholdGdd: 5 },
        { id: 2, name: "B", thresholdGdd: 5 },
      ]),
    "STAGES_NOT_STRICTLY_INCREASING",
  );
});

test("缺口规则校验", () => {
  assert.deepEqual(validateGapRule({ maxIntervalMinutes: 60 }), {
    maxIntervalMinutes: 60,
  });
  expectCode(() => validateGapRule({ maxIntervalMinutes: 0 }), "INVALID_GAP_RULE");
  expectCode(() => validateGapRule({ maxIntervalMinutes: -1 }), "INVALID_GAP_RULE");
});

test("缺少起点说明 -> INVALID_ORIGIN", () => {
  expectCode(
    () =>
      validateConfig({
        observations: [{ minute: 0, temp: 1 }],
        thresholds: { baseTemp: 0, upperTemp: 10 },
        stages: [],
        gapRule: { maxIntervalMinutes: 60 },
      }),
    "INVALID_ORIGIN",
  );
});

test("合法配置通过并返回规范化对象", () => {
  const cfg = validateConfig({
    originDescription: "2026-04-01",
    observations: [{ minute: 0, temp: 1 }],
    thresholds: { baseTemp: 0, upperTemp: 10 },
    stages: [],
    gapRule: { maxIntervalMinutes: 60 },
  });
  assert.equal(cfg.observations.length, 1);
});
