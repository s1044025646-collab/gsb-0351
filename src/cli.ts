import { readFileSync } from "node:fs";
import { openDb, createDataset, createConfig, runAnalysis, getReport, getReportInterval, listReports, getDataset, getConfig } from "./db.ts";
import { analyze, validateSamples, type AnalysisResult, type Sample, type StageDef } from "./core.ts";
import { GddError } from "./errors.ts";
import { toCsv } from "./server.ts";

const db = openDb();

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function printResult(r: AnalysisResult & { reportId?: number }) {
  console.log(`=== GDD report${r.reportId ? " #" + r.reportId : ""} ===`);
  console.log(`t0: ${r.t0Description || "(minutes from season start)"}`);
  console.log(`Tb=${r.tb} Tu=${r.tu} maxGap=${r.maxGapMinutes}min samples=${r.sampleCount} duration=${r.durationMin}min`);
  console.log(`total GDD = ${r.totalGddCDay.toFixed(4)} °C·day`);
  console.log("\nintervals:");
  console.log("idx | t0->t1 (min) | T0->T1 (°C) | crossings | GDD(°C·min) | GDD(°C·day) | cumulative");
  for (const iv of r.intervals) {
    const cx = iv.crossings.map((c) => `${c.kind}@${c.t.toFixed(1)}`).join(",") || "-";
    console.log(
      `${String(iv.index).padStart(3)} | ${String(iv.t0).padStart(6)}->${String(iv.t1).padEnd(6)} | ` +
      `${iv.temp0.toFixed(1)}->${iv.temp1.toFixed(1)} | ${cx.padEnd(18)} | ${iv.gddCMin.toFixed(2).padStart(9)} | ` +
      `${iv.gddCDay.toFixed(4).padStart(9)} | ${iv.cumulativeCDay.toFixed(4)}`,
    );
  }
  console.log("\nstages:");
  for (const s of r.stages) {
    if (s.status === "reached" && s.reachedBetween) {
      console.log(`  [REACHED ] #${s.id} ${s.name} (>=${s.threshold} °C·d) first crossed between obs ${s.reachedBetween.fromIndex} (t=${s.reachedBetween.fromT}) and obs ${s.reachedBetween.toIndex} (t=${s.reachedBetween.toT})`);
    } else {
      console.log(`  [pending ] #${s.id} ${s.name} (>=${s.threshold} °C·d)`);
    }
  }
}

function parseStages(spec: string): StageDef[] {
  // "1:emergence:100,2:tillering:300"
  return spec.split(",").map((part) => {
    const [id, name, threshold] = part.split(":");
    return { id: Number(id), name, threshold: Number(threshold) };
  });
}

function loadPoints(file: string): { t0Description: string; points: Sample[] } {
  const j = JSON.parse(readFileSync(file, "utf8"));
  return { t0Description: String(j.t0Description ?? ""), points: j.points };
}

function demo() {
  console.log("--- Demo 1: 0 -> 20 °C linear over one day, Tb=10, Tu=30 ---");
  const r1 = analyze([{ t: 0, temp: 0 }, { t: 1440, temp: 20 }], 10, 30,
    [{ id: 1, name: "stage-2.5", threshold: 2.5 }, { id: 2, name: "stage-5", threshold: 5 }], 1440, "demo day");
  printResult(r1);
  console.log("\nHand check: crossing of Tb=10 at t=720min; effective temp is a triangle");
  console.log("base 720 min, height 10 °C -> 0.5*720*10 = 3600 °C·min = 3600/1440 = 2.5 °C·day.");
  console.log("Naive mean-temp method: mean=10 °C -> max(0,10-10)=0 -> 0 °C·day. Clipping before");
  console.log("averaging matters whenever a segment crosses a threshold.");

  console.log("\n--- Demo 2: all below Tb (0 -> 8 °C) ---");
  const r2 = analyze([{ t: 0, temp: 0 }, { t: 1440, temp: 8 }], 10, 30, [], 1440);
  console.log(`total = ${r2.totalGddCDay} °C·day (expected 0)`);

  console.log("\n--- Demo 3: all above Tu (32 -> 40 °C), Tu=30, Tb=10 ---");
  const r3 = analyze([{ t: 0, temp: 32 }, { t: 1440, temp: 40 }], 10, 30, [], 1440);
  console.log(`total = ${r3.totalGddCDay} °C·day (expected ${(30 - 10)} = clipped constant 20 °C for 1 day)`);

  console.log("\n--- Demo 4: crossing both thresholds (5 -> 35 °C over one day) ---");
  const r4 = analyze([{ t: 0, temp: 5 }, { t: 1440, temp: 35 }], 10, 30, [], 1440);
  printResult(r4);
  console.log("Hand check: eff=0 until t=240 (T reaches Tb=10), rises 0->20 by t=1200,");
  console.log("then clipped at 20. Area = 0.5*960*20 + 20*240 = 9600+4800 = 14400 C.min = 10 C.day.");
}

const cmd = process.argv[2];
try {
  switch (cmd) {
    case "serve": {
      const { createApp } = await import("./server.ts");
      const port = Number(arg("--port") ?? process.env.PORT ?? 0);
      const { server } = createApp();
      server.listen(port, () => {
        const a = server.address();
        console.log(`GDD API listening on http://127.0.0.1:${typeof a === "object" && a ? a.port : port}`);
      });
      break;
    }
    case "import": {
      const { t0Description, points } = loadPoints(process.argv[3]);
      const id = createDataset(db, t0Description, points);
      console.log(`dataset id=${id} (${points.length} points)`);
      break;
    }
    case "validate": {
      const { points } = loadPoints(process.argv[3]);
      validateSamples(points);
      console.log(`ok: ${points.length} points valid`);
      break;
    }
    case "config": {
      const id = createConfig(db, arg("--name") ?? "config",
        Number(arg("--tb")), Number(arg("--tu")),
        parseStages(arg("--stages") ?? ""), Number(arg("--max-gap") ?? 180));
      console.log(`config id=${id}`);
      break;
    }
    case "analyze": {
      const { reportId, result } = runAnalysis(db, Number(arg("--dataset")), Number(arg("--config")));
      printResult({ reportId, ...result });
      break;
    }
    case "show":
      printResult(getReport(db, Number(process.argv[3])));
      break;
    case "interval":
      console.log(JSON.stringify(getReportInterval(db, Number(process.argv[3]), Number(process.argv[4])), null, 2));
      break;
    case "compare": {
      const a = getReport(db, Number(process.argv[3]));
      const b = getReport(db, Number(process.argv[4]));
      console.log(`report ${a.reportId}: Tb=${a.tb} Tu=${a.tu} total=${a.totalGddCDay.toFixed(4)} °C·d`);
      console.log(`report ${b.reportId}: Tb=${b.tb} Tu=${b.tu} total=${b.totalGddCDay.toFixed(4)} °C·d`);
      console.log(`diff (b-a) = ${(b.totalGddCDay - a.totalGddCDay).toFixed(4)} °C·d`);
      break;
    }
    case "export": {
      const r = getReport(db, Number(process.argv[3]));
      if (arg("--csv") !== undefined || process.argv.includes("--csv")) process.stdout.write(toCsv(r));
      else console.log(JSON.stringify(r, null, 2));
      break;
    }
    case "reports":
      console.log(JSON.stringify(listReports(db), null, 2));
      break;
    case "demo":
      demo();
      break;
    default:
      console.log(`usage: node src/cli.ts <command>
  serve [--port N]                 start API (default: pick a free port)
  import <file.json>               import {t0Description, points:[{t,temp}]}
  validate <file.json>             validate only
  config --name N --tb 10 --tu 30 --max-gap 180 --stages "1:name:100,2:name2:300"
  analyze --dataset ID --config ID run analysis, store report
  show <reportId>                  show intervals + stage status
  interval <reportId> <idx>        show one interval explanation
  compare <idA> <idB>              compare two parameter versions
  export <reportId> [--csv]        export report
  reports                          list reports
  demo                             run built-in demos`);
  }
} catch (e) {
  if (e instanceof GddError) {
    console.error(`error [${e.code}]: ${e.message}`);
    if (e.details) console.error(JSON.stringify(e.details, null, 2));
    process.exitCode = 2;
  } else throw e;
}
