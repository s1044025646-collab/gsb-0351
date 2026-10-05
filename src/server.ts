import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { openDb } from "./db.ts";
import { GddError } from "./errors.ts";
import * as store from "./db.ts";
import { validateSamples, type AnalysisResult } from "./core.ts";

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const isString = typeof body === "string";
  const payload = isString ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": isString ? "text/csv; charset=utf-8" : "application/json; charset=utf-8", ...headers });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 32 * 1024 * 1024) reject(new GddError("BAD_REQUEST", "body too large"));
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new GddError("BAD_REQUEST", "invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

export function toCsv(result: AnalysisResult): string {
  const lines = ["index,t0,t1,temp0,temp1,deltaTemp,durationMin,crossings,gddCMin,gddCDay,cumulativeCDay"];
  for (const iv of result.intervals) {
    const cx = iv.crossings.map((c) => `${c.kind}@${c.t.toFixed(3)}`).join("|");
    lines.push([iv.index, iv.t0, iv.t1, iv.temp0, iv.temp1, iv.deltaTemp, iv.durationMin, `"${cx}"`,
      iv.gddCMin.toFixed(6), iv.gddCDay.toFixed(6), iv.cumulativeCDay.toFixed(6)].join(","));
  }
  return lines.join("\n") + "\n";
}

export function createApp(dbPath?: string) {
  const db = openDb(dbPath);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      // POST /datasets {t0Description, points:[{t,temp}]}
      if (req.method === "POST" && parts[0] === "datasets" && parts.length === 1) {
        const b = await readBody(req);
        const id = store.createDataset(db, String(b.t0Description ?? ""), b.points);
        return send(res, 201, { id });
      }
      // POST /datasets/validate  (validate only, no persistence)
      if (req.method === "POST" && parts[0] === "datasets" && parts[1] === "validate") {
        const b = await readBody(req);
        validateSamples(b.points);
        return send(res, 200, { ok: true, count: b.points.length });
      }
      // POST /configs {name, tb, tu, maxGapMinutes, stages:[{id,name,threshold}]}
      if (req.method === "POST" && parts[0] === "configs" && parts.length === 1) {
        const b = await readBody(req);
        const id = store.createConfig(db, String(b.name ?? "config"), b.tb, b.tu, b.stages ?? [], b.maxGapMinutes);
        return send(res, 201, { id });
      }
      // POST /analyses {datasetId, configId}
      if (req.method === "POST" && parts[0] === "analyses" && parts.length === 1) {
        const b = await readBody(req);
        const { reportId, result } = store.runAnalysis(db, Number(b.datasetId), Number(b.configId));
        return send(res, 201, { reportId, result });
      }
      // GET /analyses  list
      if (req.method === "GET" && parts[0] === "analyses" && parts.length === 1) {
        return send(res, 200, store.listReports(db));
      }
      // GET /analyses/compare?ids=1,2
      if (req.method === "GET" && parts[0] === "analyses" && parts[1] === "compare") {
        const ids = (url.searchParams.get("ids") ?? "").split(",").filter(Boolean).map(Number);
        if (ids.length < 2) throw new GddError("BAD_REQUEST", "need at least two report ids, e.g. ?ids=1,2");
        const reports = ids.map((id) => store.getReport(db, id));
        return send(res, 200, {
          reports: reports.map((r) => ({
            reportId: r.reportId, tb: r.tb, tu: r.tu, maxGapMinutes: r.maxGapMinutes,
            totalGddCDay: r.totalGddCDay,
            stages: r.stages.map((s) => ({ id: s.id, name: s.name, threshold: s.threshold, status: s.status })),
          })),
          totalGddDiff: reports[1].totalGddCDay - reports[0].totalGddCDay,
        });
      }
      // GET /analyses/:id
      if (req.method === "GET" && parts[0] === "analyses" && parts.length === 2) {
        return send(res, 200, store.getReport(db, Number(parts[1])));
      }
      // GET /analyses/:id/intervals/:idx
      if (req.method === "GET" && parts[0] === "analyses" && parts[2] === "intervals" && parts.length === 4) {
        return send(res, 200, store.getReportInterval(db, Number(parts[1]), Number(parts[3])));
      }
      // GET /analyses/:id/export?format=csv|json
      if (req.method === "GET" && parts[0] === "analyses" && parts[2] === "export") {
        const r = store.getReport(db, Number(parts[1]));
        if ((url.searchParams.get("format") ?? "json") === "csv") return send(res, 200, toCsv(r));
        return send(res, 200, r);
      }
      send(res, 404, { error: { code: "NOT_FOUND", message: "unknown route" } });
    } catch (e) {
      if (e instanceof GddError) return send(res, 400, { error: { code: e.code, message: e.message, details: e.details ?? null } });
      send(res, 500, { error: { code: "INTERNAL", message: String(e) } });
    }
  });
  return { server, db };
}

const isMain = process.argv[1] && import.meta.filename === process.argv[1];
if (isMain) {
  const portArg = process.argv.indexOf("--port");
  const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : Number(process.env.PORT ?? 0); // 0 = pick a free port
  const { server } = createApp();
  server.listen(port, () => {
    const addr = server.address();
    console.log(`GDD API listening on http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : port}`);
  });
}
