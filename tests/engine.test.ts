import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, effectiveTemp, integrateInterval } from "../src/engine.js";
import type { AnalysisConfig } from "../src/types.js";
import { MINUTES_PER_DAY } from "../src/types.js";

const approx = (actual: number, expected: number, eps = 1e-6) =>
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `期望 ${expected}，实际 ${actual}`,
  );

function baseConfig(over: Partial<AnalysisConfig> = {}): AnalysisConfig {
  return {
    originDescription: "test-origin",
    observations: [{ minute: 0, temp: 0 }],
    thresholds: { baseTemp: 10, upperTemp: 30 },
    stages: [],
    gapRule: { maxIntervalMinutes: 43200 },
    ...over,
  };
}

test("有效温度公式", () => {
  assert.equal(effectiveTemp(5, 10, 30), 0);
  assert.equal(effectiveTemp(20, 10, 30), 10);
  assert.equal(effectiveTemp(40, 10, 30), 20);
  assert.equal(effectiveTemp(10, 10, 30), 0); // 恰在基温
  assert.equal(effectiveTemp(30, 10, 30), 20); // 恰在上限
});

test("演示：一天内 0->20 线性，Tb=10 Tu=30，得 2.5 °C·日（三角形手算）", () => {
  // 温度在 720 分钟处穿过 10。三角形面积 = 1/2 * 10 * 720 = 3600 °C·分 = 2.5 °C·日
  const result = analyze(
    baseConfig({
      observations: [
        { minute: 0, temp: 0 },
        { minute: 1440, temp: 20 },
      ],
    }),
  );
  assert.equal(result.accepted, true);
  approx(result.totalDegreeMinutes, 3600);
  approx(result.totalGdd, 2.5);
  assert.equal(result.intervals[0].crossings.length, 1);
  assert.equal(result.intervals[0].crossings[0].kind, "BASE");
  approx(result.intervals[0].crossings[0].minute, 720);
  // 两个分段：零面积梯形（实际为0）+ 三角形
  assert.equal(result.intervals[0].segments.length, 2);
  approx(result.intervals[0].segments[1].areaDegreeMinutes, 3600);
  assert.equal(result.intervals[0].segments[1].shape, "TRIANGLE");
});

test("平均温度法为何错误：全区间先平均再截断会得到 0", () => {
  // (0+20)/2 = 10 恰在基温 -> 朴素平均法给 0，而正确值 2.5
  const result = analyze(
    baseConfig({
      observations: [
        { minute: 0, temp: 0 },
        { minute: 1440, temp: 20 },
      ],
    }),
  );
  const naiveMean = (0 + 20) / 2;
  const naiveEffective = Math.max(0, Math.min(naiveMean, 30) - 10);
  assert.equal(naiveEffective, 0);
  assert.ok(result.totalGdd > 0);
});

test("全程低于基温：积温为 0，无交点", () => {
  const result = analyze(
    baseConfig({
      observations: [
        { minute: 0, temp: -5 },
        { minute: 100, temp: 9 },
      ],
    }),
  );
  assert.equal(result.totalGdd, 0);
  assert.equal(result.intervals[0].crossings.length, 0);
  // 单段梯形但两端有效温度均为 0
  assert.equal(result.intervals[0].segments.length, 1);
  assert.equal(result.intervals[0].segments[0].areaDegreeMinutes, 0);
});

test("全程高于上限：按上限截断后的矩形面积", () => {
  // 40 -> 50，Tu=30，Tb=10 => 有效 20 恒定；100 分钟 = 2000 °C·分
  const result = analyze(
    baseConfig({
      observations: [
        { minute: 0, temp: 40 },
        { minute: 100, temp: 50 },
      ],
    }),
  );
  approx(result.totalDegreeMinutes, 2000);
  assert.equal(result.intervals[0].crossings.length, 0);
  assert.equal(result.intervals[0].segments[0].shape, "TRAPEZOID");
});

test("同时跨越基温和上限：5 -> 40，两个交点分三段（手算）", () => {
  // 斜率 35/1400 = 0.025；过 Tb=10 在分钟 200；过 Tu=30 在分钟 1000。
  // 段1: 0-200 全 0；
  // 段2: 200-1000 三角形（0->20）= .5*20*800 = 8000；
  // 段3: 1000-1400 有效恒定 20 = 20*400 = 8000。
  // 合计 16000 °C·分。
  const result = analyze(
    baseConfig({
      observations: [
        { minute: 0, temp: 5 },
        { minute: 1400, temp: 40 },
      ],
    }),
  );
  const iv = result.intervals[0];
  assert.equal(iv.crossings.length, 2);
  assert.equal(iv.crossings[0].kind, "BASE");
  assert.equal(iv.crossings[1].kind, "UPPER");
  approx(iv.crossings[0].minute, 200);
  approx(iv.crossings[1].minute, 1000);
  assert.equal(iv.segments.length, 3);
  approx(iv.segments[0].areaDegreeMinutes, 0);
  approx(iv.segments[1].areaDegreeMinutes, 8000);
  approx(iv.segments[2].areaDegreeMinutes, 8000);
  approx(result.totalDegreeMinutes, 16000);
  // 若错误地先截断端点再做一个梯形：eff(5)=0, eff(40)=20 => .5*20*1400=14000（错）
});

test("插入共线中间采样不改变总积温", () => {
  const a = analyze(
    baseConfig({
      observations: [
        { minute: 0, temp: 5 },
        { minute: 1400, temp: 40 },
      ],
    }),
  );
  const b = analyze(
    baseConfig({
      observations: [
        { minute: 0, temp: 5 },
        { minute: 300, temp: 12.5 },
        { minute: 600, temp: 20 },
        { minute: 1000, temp: 30 },
        { minute: 1400, temp: 40 },
      ],
    }),
  );
  approx(b.totalDegreeMinutes, a.totalDegreeMinutes, 1e-6);
});

test("整体平移温度与两阈值不改变结果", () => {
  const make = (shift: number) =>
    analyze(
      baseConfig({
        observations: [
          { minute: 0, temp: 5 + shift },
          { minute: 700, temp: 22 + shift },
          { minute: 1400, temp: 38 + shift },
        ],
        thresholds: { baseTemp: 10 + shift, upperTemp: 30 + shift },
      }),
    );
  approx(make(100).totalDegreeMinutes, make(0).totalDegreeMinutes, 1e-6);
  approx(make(-7).totalDegreeMinutes, make(0).totalDegreeMinutes, 1e-6);
});

test("单位换算：°C·分钟 / 1440 = °C·日；非整天按时长计", () => {
  // 20 -> 20 恒定有效 10，720 分钟（半天）= 7200 °C·分 = 5 °C·日
  const result = analyze(
    baseConfig({
      observations: [
        { minute: 0, temp: 20 },
        { minute: 720, temp: 20 },
      ],
    }),
  );
  approx(result.totalDegreeMinutes, 7200);
  approx(result.totalGdd, 5);
  assert.equal(MINUTES_PER_DAY, 1440);
});

test("门槛恰好命中视为已达，且定位到正确区间", () => {
  // 区间 0-1440：0->20，积温 2.5 °C·日（末端累计 2.5）；
  // 区间 1440-2880：恒温 20，再积 10 °C·日。
  const result = analyze(
    baseConfig({
      observations: [
        { minute: 0, temp: 0 },
        { minute: 1440, temp: 20 },
      ],
      stages: [
        { id: 1, name: "发芽", thresholdGdd: 2.5 },
        { id: 2, name: "未达阶段", thresholdGdd: 10 },
      ],
    }),
  );
  assert.equal(result.stages[0].reached, true);
  assert.equal(result.stages[0].crossedBetweenIndex, 0);
  assert.deepEqual(result.stages[0].crossedBetweenMinutes, [0, 1440]);
  assert.equal(result.stages[1].reached, false);
  assert.equal(result.stages[1].crossedBetweenIndex, null);
});

test("单点序列：零时长零积温", () => {
  const result = analyze(baseConfig());
  assert.equal(result.accepted, true);
  assert.equal(result.totalGdd, 0);
  assert.deepEqual(result.intervals, []);
});

test("长缺口：拒绝整次分析并指出缺口，阶段全部待达", () => {
  const result = analyze(
    baseConfig({
      observations: [
        { minute: 0, temp: 20 },
        { minute: 5000, temp: 20 },
      ],
      gapRule: { maxIntervalMinutes: 60 },
      stages: [{ id: 1, name: "S", thresholdGdd: 1 }],
    }),
  );
  assert.equal(result.accepted, false);
  assert.equal(result.gaps.length, 1);
  assert.equal(result.gaps[0].intervalIndex, 0);
  assert.equal(result.gaps[0].intervalMinutes, 5000);
  assert.equal(result.totalGdd, 0);
  assert.equal(result.stages[0].reached, false);
  assert.deepEqual(result.intervals, []);
});

test("降温跨阈值同样正确分段", () => {
  // 40 -> 5：反向穿越，总面积与升温对称
  const up = integrateInterval(0, 0, 5, 1400, 40, 10, 30);
  const down = integrateInterval(0, 0, 40, 1400, 5, 10, 30);
  approx(up.intervalDegreeMinutes, down.intervalDegreeMinutes, 1e-6);
  approx(down.intervalDegreeMinutes, 16000);
});
