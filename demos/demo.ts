/**
 * 演示脚本（不落库，纯计算并打印手算核对）：
 *   1) 一天 0->20°C，Tb=10 Tu=30，三角形 2.5 °C·日，并对比平均温度法；
 *   2) 全程低于基温；3) 全程高于上限；4) 同时跨越两阈值。
 *
 * 运行：npm run demo
 */

import { analyze, integrateInterval } from "../src/engine.js";
import type { AnalysisConfig } from "../src/types.js";

function show(title: string, config: AnalysisConfig, handCheck: string): void {
  const result = analyze(config);
  console.log("=".repeat(72));
  console.log(title);
  console.log("-".repeat(72));
  if (!result.accepted) {
    console.log("被拒绝：存在长缺口", JSON.stringify(result.gaps));
    return;
  }
  for (const iv of result.intervals) {
    console.log(
      `区间 #${iv.index}: ${iv.startTemp}°C@${iv.startMinute}分 -> ` +
        `${iv.endTemp}°C@${iv.endMinute}分，时长 ${iv.durationMinutes} 分`,
    );
    for (const c of iv.crossings) {
      console.log(`  交点：${c.kind}（${c.kind === "BASE" ? "Tb" : "Tu"}）位于第 ${c.minute} 分钟`);
    }
    for (const s of iv.segments) {
      console.log(
        `  分段 ${s.startMinute}-${s.endMinute} 分：${s.shape}，` +
          `有效温度 ${s.startEffective}->${s.endEffective}°C，面积 ${s.areaDegreeMinutes} °C·分`,
      );
    }
    console.log(
      `  区间积温 ${iv.intervalDegreeMinutes} °C·分 = ${iv.intervalGdd} °C·日；累计 ${iv.cumulativeGdd} °C·日`,
    );
  }
  console.log(
    `总计 ${result.totalDegreeMinutes} °C·分 = ${result.totalGdd} °C·日`,
  );
  console.log(`手算核对：${handCheck}`);
}

const thresholds = { baseTemp: 10, upperTemp: 30 };

show(
  "演示 1：一天内 0 -> 20°C 线性升温（Tb=10, Tu=30）",
  {
    originDescription: "demo-1",
    observations: [
      { minute: 0, temp: 0 },
      { minute: 1440, temp: 20 },
    ],
    thresholds,
    stages: [{ id: 1, name: "发芽（演示门槛 2.5 恰好命中）", thresholdGdd: 2.5 }],
    gapRule: { maxIntervalMinutes: 43200 },
  },
  "720 分处穿过 Tb；三角形 = 1/2 × 10°C × 720 分 = 3600 °C·分 = 2.5 °C·日",
);

const r1 = analyze({
  originDescription: "demo-1",
  observations: [
    { minute: 0, temp: 0 },
    { minute: 1440, temp: 20 },
  ],
  thresholds,
  stages: [],
  gapRule: { maxIntervalMinutes: 43200 },
});
console.log("-".repeat(72));
console.log(
  `平均温度法对比：先平均 (0+20)/2 = 10°C，截断后有效温度 = max(0,10-10) = 0，` +
    `会错误地得到 0 °C·日；正确分段积分为 ${r1.totalGdd} °C·日。`,
);

show(
  "演示 2：全程低于基温（-5 -> 9°C）",
  {
    originDescription: "demo-2",
    observations: [
      { minute: 0, temp: -5 },
      { minute: 1000, temp: 9 },
    ],
    thresholds,
    stages: [],
    gapRule: { maxIntervalMinutes: 43200 },
  },
  "有效温度恒为 0，面积 = 0",
);

show(
  "演示 3：全程高于上限（40 -> 50°C）",
  {
    originDescription: "demo-3",
    observations: [
      { minute: 0, temp: 40 },
      { minute: 100, temp: 50 },
    ],
    thresholds,
    stages: [],
    gapRule: { maxIntervalMinutes: 43200 },
  },
  "截断在 Tu=30，有效恒定 20°C；矩形 = 20 × 100 = 2000 °C·分",
);

show(
  "演示 4：同一区间同时跨越基温与上限（5 -> 40°C，1400 分）",
  {
    originDescription: "demo-4",
    observations: [
      { minute: 0, temp: 5 },
      { minute: 1400, temp: 40 },
    ],
    thresholds,
    stages: [],
    gapRule: { maxIntervalMinutes: 43200 },
  },
  "200 分过 Tb、1000 分过 Tu；0 + 三角形8000 + 矩形8000 = 16000 °C·分。" +
    " 先截断端点再做一个梯形只会得 14000（错误）",
);

// 几何不变性快速核对
const single = integrateInterval(0, 0, 5, 1400, 40, 10, 30);
const split = [
  integrateInterval(0, 0, 5, 300, 12.5, 10, 30),
  integrateInterval(1, 300, 12.5, 600, 20, 10, 30),
  integrateInterval(2, 600, 20, 1000, 30, 10, 30),
  integrateInterval(3, 1000, 30, 1400, 40, 10, 30),
].reduce((sum, iv) => sum + iv.intervalDegreeMinutes, 0);
console.log("=".repeat(72));
console.log(
  `不变性核对：单区间 ${single.intervalDegreeMinutes} °C·分，` +
    `插入 3 个共线中间采样后 ${split} °C·分（应相等）`,
);
