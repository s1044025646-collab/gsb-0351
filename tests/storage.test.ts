import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Storage } from "../src/storage.js";
import { DomainError } from "../src/errors.js";

const tmpDir = join(process.cwd(), "data", `test-${process.pid}`);
const dbPath = join(tmpDir, "test.sqlite");

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    originDescription: "测试生长季起点 2026-04-01T00:00+08:00",
    observations: [
      { minute: 0, temp: 0 },
      { minute: 1440, temp: 20 },
    ],
    thresholds: { baseTemp: 10, upperTemp: 30 },
    stages: [{ id: 1, name: "发芽", thresholdGdd: 2 }],
    gapRule: { maxIntervalMinutes: 2000 },
    ...overrides,
  };
}

let storage: Storage;

before(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  storage = new Storage(dbPath);
});

after(() => {
  storage.close();
  rmRetry(tmpDir);
});

function rmRetry(target: string, attempts = 5): void {
  for (let i = 0; i < attempts; i++) {
    try {
      rmSync(target, { recursive: true, force: true });
      return;
    } catch {
      const waitUntil = Date.now() + 100;
      while (Date.now() < waitUntil) {
        // busy wait
      }
    }
  }
}

test("原子提交：成功后可完整读回报告", () => {
  const report = storage.createAnalysis(validPayload());
  assert.equal(report.accepted, true);
  approx(report.totalGdd, 2.5);
  const loaded = storage.getReport(report.reportId);
  assert.equal(loaded.totalGdd, report.totalGdd);
  assert.equal(loaded.intervals.length, 1);
  assert.equal(loaded.stages[0].reached, true);
});

test("事务回滚：校验失败不留配置/报告，且不产生半段累计", () => {
  const beforeConfigs = storage.db.prepare("SELECT COUNT(*) c FROM configs").get() as {
    c: number;
  };
  const beforeReports = storage.db.prepare("SELECT COUNT(*) c FROM reports").get() as {
    c: number;
  };
  assert.throws(
    () =>
      storage.createAnalysis(
        validPayload({
          observations: [], // 空序列，校验阶段即失败
        }),
      ),
    DomainError,
  );
  const afterConfigs = storage.db.prepare("SELECT COUNT(*) c FROM configs").get() as {
    c: number;
  };
  const afterReports = storage.db.prepare("SELECT COUNT(*) c FROM reports").get() as {
    c: number;
  };
  assert.equal(afterConfigs.c, beforeConfigs.c);
  assert.equal(afterReports.c, beforeReports.c);
});

test("长缺口报告被持久化为 rejected，且不含累计断言", () => {
  const report = storage.createAnalysis(
    validPayload({
      observations: [
        { minute: 0, temp: 20 },
        { minute: 10000, temp: 20 },
      ],
      gapRule: { maxIntervalMinutes: 60 },
    }),
  );
  assert.equal(report.accepted, false);
  assert.equal(report.totalGdd, 0);
  assert.equal(report.stages[0].reached, false);
  assert.equal(report.gaps[0].intervalMinutes, 10000);
  // 被拒绝报告读取区间应报错
  assert.throws(
    () => storage.getInterval(report.reportId, 0),
    (e: unknown) => e instanceof DomainError && e.code === "GAP_VIOLATION",
  );
});

test("修改任意输入建立新报告（不可变快照）", () => {
  const r1 = storage.createAnalysis(validPayload());
  const r2 = storage.createAnalysis(
    validPayload({ thresholds: { baseTemp: 5, upperTemp: 30 } }),
  );
  assert.notEqual(r1.reportId, r2.reportId);
  assert.notEqual(r1.configId, r2.configId);
});

test("重启后可查询相同区间并复算原报告", () => {
  const created = storage.createAnalysis(validPayload());
  storage.close();
  assert.ok(existsSync(dbPath));

  const reopened = new Storage(dbPath);
  const loaded = reopened.getReport(created.reportId);
  assert.equal(loaded.totalGdd, created.totalGdd);
  assert.equal(loaded.intervals[0].crossings[0].minute, 720);

  // 用同一快照配置复算，结果一致
  const cfg = reopened.getConfig(created.configId);
  assert.equal(cfg.observations.length, 2);
  const interval = reopened.getInterval(created.reportId, 0);
  approx(interval.interval.intervalGdd, 2.5);
  reopened.close();

  // 重新打开供 after 钩子关闭
  storage = new Storage(dbPath);
});

test("参数版本比较", () => {
  const created = storage.createAnalysis(validPayload());
  const cmp = storage.compareWithParams(created.configId, {
    thresholds: { baseTemp: 0, upperTemp: 30 },
  });
  // Tb=0 时整段都有效，面积更大
  assert.ok(cmp.variant.result.totalGdd > cmp.base.totalGdd);
});

test("导出包含报告与输入快照", () => {
  const created = storage.createAnalysis(validPayload());
  const exported = storage.exportReport(created.reportId);
  assert.equal(exported.report.reportId, created.reportId);
  assert.equal(exported.config.thresholds.baseTemp, 10);
  assert.equal(exported.config.observations[1].temp, 20);
});

test("不存在资源 -> NOT_FOUND", () => {
  assert.throws(
    () => storage.getReport(999999),
    (e: unknown) => e instanceof DomainError && e.code === "NOT_FOUND",
  );
});

function approx(actual: number, expected: number, eps = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= eps, `期望 ${expected}，实际 ${actual}`);
}
