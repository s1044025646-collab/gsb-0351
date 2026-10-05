import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze, type AnalysisResult, type Sample, type StageDef, validateSamples, validateStages, validateThresholds, validateGap } from "./core.ts";
import { ERR, GddError } from "./errors.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const DATA_DIR = process.env.GDD_DATA_DIR ?? join(root, "data");
export const DB_PATH = join(DATA_DIR, "gdd.db");

export function openDb(path = DB_PATH): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS datasets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      t0_description TEXT NOT NULL,
      points_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      tb REAL NOT NULL,
      tu REAL NOT NULL,
      max_gap_minutes REAL NOT NULL,
      stages_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dataset_id INTEGER NOT NULL REFERENCES datasets(id),
      config_id INTEGER NOT NULL REFERENCES configs(id),
      status TEXT NOT NULL CHECK (status IN ('complete')),
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS report_intervals (
      report_id INTEGER NOT NULL REFERENCES reports(id),
      idx INTEGER NOT NULL,
      detail_json TEXT NOT NULL,
      PRIMARY KEY (report_id, idx)
    );
  `);
  return db;
}

export function createDataset(db: DatabaseSync, t0Description: string, points: Sample[]): number {
  validateSamples(points);
  const r = db.prepare("INSERT INTO datasets (t0_description, points_json) VALUES (?, ?)")
    .run(t0Description, JSON.stringify(points));
  return Number(r.lastInsertRowid);
}

export function getDataset(db: DatabaseSync, id: number): { id: number; t0Description: string; points: Sample[] } {
  const row = db.prepare("SELECT * FROM datasets WHERE id = ?").get(id) as any;
  if (!row) throw new GddError(ERR.NOT_FOUND, `dataset ${id} not found`);
  return { id, t0Description: row.t0_description, points: JSON.parse(row.points_json) };
}

export function createConfig(db: DatabaseSync, name: string, tb: number, tu: number, stages: StageDef[], maxGapMinutes: number): number {
  validateThresholds(tb, tu);
  validateStages(stages);
  validateGap(maxGapMinutes);
  const r = db.prepare("INSERT INTO configs (name, tb, tu, max_gap_minutes, stages_json) VALUES (?, ?, ?, ?, ?)")
    .run(name, tb, tu, maxGapMinutes, JSON.stringify(stages));
  return Number(r.lastInsertRowid);
}

export function getConfig(db: DatabaseSync, id: number)
  : { id: number; name: string; tb: number; tu: number; maxGapMinutes: number; stages: StageDef[] } {
  const row = db.prepare("SELECT * FROM configs WHERE id = ?").get(id) as any;
  if (!row) throw new GddError(ERR.NOT_FOUND, `config ${id} not found`);
  return { id, name: row.name, tb: row.tb, tu: row.tu, maxGapMinutes: row.max_gap_minutes, stages: JSON.parse(row.stages_json) };
}

/**
 * Run an analysis and persist report + per-interval rows atomically.
 * Any failure rolls back: no partial accumulation is ever stored as a
 * complete-season result. Only status 'complete' exists in the schema.
 */
export function runAnalysis(db: DatabaseSync, datasetId: number, configId: number): { reportId: number; result: AnalysisResult } {
  const ds = getDataset(db, datasetId);
  const cfg = getConfig(db, configId);
  const result = analyze(ds.points, cfg.tb, cfg.tu, cfg.stages, cfg.maxGapMinutes, ds.t0Description);
  db.exec("BEGIN");
  try {
    const r = db.prepare("INSERT INTO reports (dataset_id, config_id, status, result_json) VALUES (?, ?, 'complete', ?)")
      .run(datasetId, configId, JSON.stringify(result));
    const reportId = Number(r.lastInsertRowid);
    const ins = db.prepare("INSERT INTO report_intervals (report_id, idx, detail_json) VALUES (?, ?, ?)");
    for (const iv of result.intervals) ins.run(reportId, iv.index, JSON.stringify(iv));
    db.exec("COMMIT");
    return { reportId, result };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function getReport(db: DatabaseSync, id: number): AnalysisResult & { reportId: number } {
  const row = db.prepare("SELECT * FROM reports WHERE id = ?").get(id) as any;
  if (!row) throw new GddError(ERR.NOT_FOUND, `report ${id} not found`);
  return { reportId: id, ...(JSON.parse(row.result_json) as AnalysisResult) };
}

export function getReportInterval(db: DatabaseSync, reportId: number, idx: number) {
  getReport(db, reportId);
  const row = db.prepare("SELECT detail_json FROM report_intervals WHERE report_id = ? AND idx = ?").get(reportId, idx) as any;
  if (!row) throw new GddError(ERR.NOT_FOUND, `interval ${idx} not found in report ${reportId}`);
  return JSON.parse(row.detail_json);
}

export function listReports(db: DatabaseSync) {
  return db.prepare("SELECT id, dataset_id, config_id, status, created_at FROM reports ORDER BY id").all();
}
