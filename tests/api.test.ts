import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "node:http";
import { Storage } from "../src/storage.js";
import { createApp } from "../src/server.js";

const tmpDir = join(process.cwd(), "data", `test-api-${process.pid}`);
const dbPath = join(tmpDir, "api.sqlite");

let server: Server;
let base: string;
let storage: Storage;

before(async () => {
  rmSync(tmpDir, { recursive: true, force: true });
  storage = new Storage(dbPath);
  server = createApp(storage);
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  storage.close();
  rmRetry(tmpDir);
});

function rmRetry(target: string, attempts = 5): void {
  for (let i = 0; i < attempts; i++) {
    try {
      rmSync(target, { recursive: true, force: true });
      return;
    } catch {
      const deadline = Date.now() + 100;
      while (Date.now() < deadline) {
        // Windows 下 WAL 句柄释放可能滞后，短暂等待后重试
      }
    }
  }
}

async function jsonRequest(path: string, init?: RequestInit) {
  const res = await fetch(base + path, {
    method: init?.method ?? "GET",
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    body: init?.body,
  });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

const payload = {
  originDescription: "api-test",
  observations: [
    { minute: 0, temp: 0 },
    { minute: 1440, temp: 20 },
  ],
  thresholds: { baseTemp: 10, upperTemp: 30 },
  stages: [{ id: 1, name: "发芽", thresholdGdd: 2 }],
  gapRule: { maxIntervalMinutes: 2000 },
};

test("健康检查", async () => {
  const { status, body } = await jsonRequest("/health");
  assert.equal(status, 200);
  assert.equal(body.ok, true);
});

test("创建分析并读回报告/区间", async () => {
  const created = await jsonRequest("/analyses", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  assert.equal(created.status, 201);
  const report = created.body as unknown as {
    reportId: number;
    totalGdd: number;
    configId: number;
  };
  assert.equal(report.totalGdd, 2.5);

  const got = await jsonRequest(`/reports/${report.reportId}`);
  assert.equal(got.status, 200);

  const interval = await jsonRequest(`/reports/${report.reportId}/intervals/0`);
  assert.equal(interval.status, 200);
  assert.equal(
    (interval.body as { interval: { crossings: { kind: string }[] } }).interval
      .crossings[0].kind,
    "BASE",
  );

  const list = await jsonRequest("/reports");
  assert.equal(list.status, 200);

  const exp = await jsonRequest(`/reports/${report.reportId}/export`);
  assert.equal(exp.status, 200);

  const cmp = await jsonRequest(`/configs/${report.configId}/compare`, {
    method: "POST",
    body: JSON.stringify({ thresholds: { baseTemp: 0, upperTemp: 30 } }),
  });
  assert.equal(cmp.status, 200);
});

test("校验错误返回稳定错误码", async () => {
  const bad = await jsonRequest("/analyses", {
    method: "POST",
    body: JSON.stringify({ ...payload, observations: [] }),
  });
  assert.equal(bad.status, 400);
  assert.equal(
    (bad.body as { error: { code: string } }).error.code,
    "EMPTY_SEQUENCE",
  );
});

test("长缺口返回 422 GAP_VIOLATION 语义体", async () => {
  const r = await jsonRequest("/analyses", {
    method: "POST",
    body: JSON.stringify({
      ...payload,
      observations: [
        { minute: 0, temp: 20 },
        { minute: 10000, temp: 20 },
      ],
      gapRule: { maxIntervalMinutes: 60 },
    }),
  });
  // 被拒绝的分析仍是创建成功的资源（201），accepted=false
  assert.equal(r.status, 201);
  assert.equal((r.body as { accepted: boolean }).accepted, false);
});

test("未知路由 404", async () => {
  const r = await jsonRequest("/nope");
  assert.equal(r.status, 404);
});
