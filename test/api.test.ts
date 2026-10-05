import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, createDataset, createConfig, runAnalysis, getReport, getReportInterval } from "../src/db.ts";
import { createApp } from "../src/server.ts";

const tmpDb = () => join(mkdtempSync(join(tmpdir(), "gdd-")), "test.db");

// hourly samples over one day, temperature rising linearly 0 -> 20 °C
const dayPoints = Array.from({ length: 25 }, (_, h) => ({ t: h * 60, temp: (h * 20) / 24 }));

function seed(db: any) {
  const ds = createDataset(db, "day0", dayPoints);
  const cfg = createConfig(db, "base", 10, 30, [{ id: 1, name: "s1", threshold: 2.5 }], 180);
  return { ds, cfg };
}

test("persisted report survives restart and recomputes identically", () => {
  const path = tmpDb();
  let db = openDb(path);
  const { ds, cfg } = seed(db);
  const { reportId, result } = runAnalysis(db, ds, cfg);
  assert.ok(Math.abs(result.totalGddCDay - 2.5) < 1e-9);
  db.close();
  db = openDb(path); // restart
  const r = getReport(db, reportId);
  assert.equal(r.totalGddCDay, result.totalGddCDay);
  assert.equal(r.stages[0].status, "reached");
  // interval 12 (t=720..780): temp 10 -> 10.833, eff 0 -> 0.833, area = 0.5*0.8333*60 = 25 C.min
  const iv = getReportInterval(db, reportId, 12);
  assert.ok(Math.abs(iv.gddCMin - 25) < 1e-9);
  db.close();
});

test("transaction rollback leaves no partial report", () => {
  const path = tmpDb();
  const db = openDb(path);
  const { ds, cfg } = seed(db);
  // sabotage: drop intervals table so the multi-statement write fails midway
  db.exec("DROP TABLE report_intervals");
  assert.throws(() => runAnalysis(db, ds, cfg));
  const rows = db.prepare("SELECT COUNT(*) AS n FROM reports").get() as any;
  assert.equal(rows.n, 0, "no half-written report row");
  db.close();
});

test("modifying inputs creates a new report (immutability of history)", () => {
  const db = openDb(tmpDb());
  const { ds, cfg } = seed(db);
  const r1 = runAnalysis(db, ds, cfg);
  const cfg2 = createConfig(db, "warmer-base", 12, 30, [{ id: 1, name: "s1", threshold: 2.5 }], 180);
  const r2 = runAnalysis(db, ds, cfg2);
  assert.notEqual(r1.reportId, r2.reportId);
  assert.ok(r2.result.totalGddCDay < r1.result.totalGddCDay);
  db.close();
});

test("HTTP API end-to-end incl. error codes and export", async () => {
  const { server, db } = createApp(tmpDb());
  await new Promise<void>((res) => server.listen(0, res));
  try {
    const port = (server.address() as any).port;
    const base = `http://127.0.0.1:${port}`;
    const post = async (p: string, body: any) => {
      const res = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    };

    const bad = await post("/datasets", { t0Description: "x", points: [{ t: 1, temp: 5 }, { t: 1, temp: 6 }] });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, "DUPLICATE_TIME");

    const ds = await post("/datasets", { t0Description: "day0", points: dayPoints });
    assert.equal(ds.status, 201);
    const cfg = await post("/configs", { name: "c", tb: 10, tu: 30, maxGapMinutes: 180, stages: [{ id: 1, name: "s", threshold: 2.5 }] });
    const an = await post("/analyses", { datasetId: ds.body.id, configId: cfg.body.id });
    assert.equal(an.status, 201);
    assert.ok(Math.abs(an.body.result.totalGddCDay - 2.5) < 1e-9);

    const got = await (await fetch(`${base}/analyses/${an.body.reportId}`)).json();
    assert.equal(got.totalGddCDay, an.body.result.totalGddCDay);
    const iv = await (await fetch(`${base}/analyses/${an.body.reportId}/intervals/12`)).json();
    assert.ok(Math.abs(iv.gddCMin - 25) < 1e-9);

    const csv = await (await fetch(`${base}/analyses/${an.body.reportId}/export?format=csv`)).text();
    assert.match(csv, /cumulativeCDay/);

    // gap rejection through the API
    const ds2 = await post("/datasets", { t0Description: "gap", points: [{ t: 0, temp: 15 }, { t: 5000, temp: 20 }] });
    const an2 = await post("/analyses", { datasetId: ds2.body.id, configId: cfg.body.id });
    assert.equal(an2.status, 400);
    assert.equal(an2.body.error.code, "GAP_EXCEEDED");

    // compare two parameter versions
    const cfgB = await post("/configs", { name: "c2", tb: 12, tu: 30, maxGapMinutes: 180, stages: [{ id: 1, name: "s", threshold: 2.5 }] });
    const anB = await post("/analyses", { datasetId: ds.body.id, configId: cfgB.body.id });
    const cmp = await (await fetch(`${base}/analyses/compare?ids=${an.body.reportId},${anB.body.reportId}`)).json();
    assert.ok(cmp.totalGddDiff < 0);
  } finally {
    server.closeAllConnections();
    server.close();
    db.close();
  }
});
