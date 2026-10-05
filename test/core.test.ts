import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, integrateInterval, effTemp } from "../src/core.ts";
import { GddError } from "../src/errors.ts";

const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("demo: 0->20 over a day, Tb=10 Tu=30 gives 2.5 °C·day", () => {
  const r = analyze([{ t: 0, temp: 0 }, { t: 1440, temp: 20 }], 10, 30, [], 1440);
  close(r.totalGddCDay, 2.5);
  assert.equal(r.intervals.length, 1);
  assert.equal(r.intervals[0].crossings.length, 1);
  close(r.intervals[0].crossings[0].t, 720);
  assert.equal(r.intervals[0].crossings[0].kind, "Tb");
  close(r.intervals[0].gddCMin, 3600);
});

test("mean-temp method differs across a threshold", () => {
  // mean of 0 and 20 is 10 -> naive clipped mean gives 0, exact integral gives 2.5
  const naive = Math.max(0, Math.min((0 + 20) / 2, 30) - 10);
  const r = analyze([{ t: 0, temp: 0 }, { t: 1440, temp: 20 }], 10, 30, [], 1440);
  assert.equal(naive, 0);
  close(r.totalGddCDay, 2.5);
});

test("all below Tb -> 0", () => {
  const r = analyze([{ t: 0, temp: 0 }, { t: 1440, temp: 8 }], 10, 30, [], 1440);
  assert.equal(r.totalGddCDay, 0);
});

test("all above Tu -> clipped constant (Tu-Tb)", () => {
  const r = analyze([{ t: 0, temp: 32 }, { t: 1440, temp: 40 }], 10, 30, [], 1440);
  close(r.totalGddCDay, 20);
});

test("crossing both thresholds: hand-checked geometry", () => {
  const r = analyze([{ t: 0, temp: 5 }, { t: 1440, temp: 35 }], 10, 30, [], 1440);
  const iv = r.intervals[0];
  assert.equal(iv.crossings.length, 2);
  close(iv.crossings[0].t, 240);   // Tb
  close(iv.crossings[1].t, 1200);  // Tu
  // eff=0 until t=240; then 0.5*960*20 + 20*240 = 9600+4800 = 14400
  close(iv.gddCMin, 14400);
  close(r.totalGddCDay, 10);
});

test("collinear midpoint insertion does not change total", () => {
  const pts = [{ t: 0, temp: 5 }, { t: 1440, temp: 35 }];
  const mid = [{ t: 0, temp: 5 }, { t: 720, temp: 20 }, { t: 1440, temp: 35 }];
  const a = analyze(pts, 10, 30, [], 1440);
  const b = analyze(mid, 10, 30, [], 1440);
  close(a.totalGddCDay, b.totalGddCDay);
});

test("shifting temps and both thresholds together leaves result unchanged", () => {
  const pts = [{ t: 0, temp: 5 }, { t: 720, temp: 20 }, { t: 1440, temp: 35 }];
  const a = analyze(pts, 10, 30, [], 1440);
  const shifted = pts.map((p) => ({ t: p.t, temp: p.temp + 7 }));
  const b = analyze(shifted, 17, 37, [], 1440);
  close(a.totalGddCDay, b.totalGddCDay);
});

test("unit conversion: °C·min / 1440 = °C·day; partial days use real duration", () => {
  // constant effective 10 °C for 720 min -> 7200 °C·min = 5 °C·day
  const r = analyze([{ t: 0, temp: 20 }, { t: 720, temp: 20 }], 10, 30, [], 1440);
  close(r.intervals[0].gddCMin, 7200);
  close(r.totalGddCDay, 5);
});

test("stage exactly hit counts as reached", () => {
  const r = analyze([{ t: 0, temp: 0 }, { t: 1440, temp: 20 }], 10, 30,
    [{ id: 1, name: "x", threshold: 2.5 }, { id: 2, name: "y", threshold: 10 }], 1440);
  assert.equal(r.stages[0].status, "reached");
  assert.deepEqual(r.stages[0].reachedBetween, { fromIndex: 0, toIndex: 1, fromT: 0, toT: 1440 });
  assert.equal(r.stages[1].status, "pending");
});

test("single point: zero duration, zero GDD", () => {
  const r = analyze([{ t: 0, temp: 25 }], 10, 30, [], 1440);
  assert.equal(r.totalGddCDay, 0);
  assert.equal(r.intervals.length, 0);
});

test("stable error codes", () => {
  assert.throws(() => analyze([], 10, 30, [], 1440), (e: any) => e.code === "EMPTY_SERIES");
  assert.throws(() => analyze([{ t: 0, temp: NaN }], 10, 30, [], 1440), (e: any) => e.code === "NON_FINITE_TEMP");
  assert.throws(() => analyze([{ t: 10, temp: 1 }, { t: 5, temp: 2 }], 10, 30, [], 1440), (e: any) => e.code === "TIME_NOT_INCREASING");
  assert.throws(() => analyze([{ t: 5, temp: 1 }, { t: 5, temp: 2 }], 10, 30, [], 1440), (e: any) => e.code === "DUPLICATE_TIME");
  assert.throws(() => analyze([{ t: 0, temp: 1 }], 30, 10, [], 1440), (e: any) => e.code === "INVALID_THRESHOLDS");
  assert.throws(
    () => analyze([{ t: 0, temp: 1 }], 10, 30, [{ id: 1, name: "a", threshold: 1 }, { id: 1, name: "b", threshold: 2 }], 1440),
    (e: any) => e.code === "DUPLICATE_STAGE_ID");
  assert.throws(
    () => analyze([{ t: 0, temp: 1 }], 10, 30, [{ id: 1, name: "a", threshold: 5 }, { id: 2, name: "b", threshold: 5 }], 1440),
    (e: any) => e.code === "STAGE_THRESHOLD_NOT_INCREASING");
});

test("long gap rejects the whole analysis and names the gap", () => {
  const pts = [
    { t: 0, temp: 15 }, { t: 60, temp: 18 },
    { t: 60 + 1440, temp: 20 }, { t: 120 + 1440, temp: 22 },
  ];
  try {
    analyze(pts, 10, 30, [{ id: 1, name: "s", threshold: 0.1 }], 180);
    assert.fail("should throw");
  } catch (e: any) {
    assert.equal(e.code, "GAP_EXCEEDED");
    assert.equal(e.details.length, 1);
    assert.equal(e.details[0].gapMinutes, 1440);
  }
});

test("effTemp clipping", () => {
  assert.equal(effTemp(5, 10, 30), 0);
  assert.equal(effTemp(15, 10, 30), 5);
  assert.equal(effTemp(40, 10, 30), 20);
});

test("integrateInterval never clips endpoints before integrating", () => {
  // 0->20 with Tb=10: endpoint-clip-first trapezoid would give (0+10)/2*1440=7200; exact is 3600
  const iv = integrateInterval(0, 0, 0, 1440, 20, 10, 30, 0);
  close(iv.gddCMin, 3600);
});
