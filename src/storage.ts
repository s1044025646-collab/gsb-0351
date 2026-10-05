/**
 * SQLite 持久化层。
 *
 * 保存：观测快照、时间起点说明、温度阈值、阶段配置、缺口规则、
 * 分析结果。任何输入变化都会创建新的 config + report 行（不可变
 * 快照），报告与完成状态在单个事务内原子提交；失败时不留下半段
 * 累计值。进程重启后可用同一区间数据复算并读回原报告。
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DomainError } from "./errors.js";
import { analyze } from "./engine.js";
import {
  validateConfig,
  validateGapRule,
  validateStages,
  validateThresholds,
} from "./validate.js";
import type {
  AnalysisConfig,
  AnalysisReport,
  Observation,
  Stage,
} from "./types.js";

interface ConfigRow {
  id: number;
  origin_description: string;
  base_temp: number;
  upper_temp: number;
  max_interval_minutes: number;
  created_at: string;
}

export class Storage {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS configs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        origin_description TEXT NOT NULL,
        base_temp REAL NOT NULL,
        upper_temp REAL NOT NULL,
        max_interval_minutes INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE IF NOT EXISTS observations (
        config_id INTEGER NOT NULL REFERENCES configs(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        minute INTEGER NOT NULL,
        temp REAL NOT NULL,
        PRIMARY KEY (config_id, seq)
      );
      CREATE TABLE IF NOT EXISTS stages (
        config_id INTEGER NOT NULL REFERENCES configs(id) ON DELETE CASCADE,
        stage_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        threshold_gdd REAL NOT NULL,
        seq INTEGER NOT NULL,
        PRIMARY KEY (config_id, stage_id)
      );
      CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        config_id INTEGER NOT NULL UNIQUE REFERENCES configs(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        accepted INTEGER NOT NULL,
        total_degree_minutes REAL NOT NULL,
        total_gdd REAL NOT NULL,
        span_minutes INTEGER NOT NULL,
        observation_count INTEGER NOT NULL,
        gaps_json TEXT NOT NULL,
        intervals_json TEXT NOT NULL,
        stages_json TEXT NOT NULL
      );
    `);
  }

  /**
   * 原子地：校验输入 -> 落库配置快照 -> 计算 -> 落库完整报告。
   * 任一步失败整个事务回滚，不会留下“配置已存但报告缺失”或
   * 半段累计的中间状态。
   */
  createAnalysis(rawInput: unknown): AnalysisReport {
    const config = validateConfig(rawInput);

    const insertConfig = this.db.prepare(
      `INSERT INTO configs (origin_description, base_temp, upper_temp, max_interval_minutes)
       VALUES (?, ?, ?, ?)`,
    );
    const insertObs = this.db.prepare(
      `INSERT INTO observations (config_id, seq, minute, temp) VALUES (?, ?, ?, ?)`,
    );
    const insertStage = this.db.prepare(
      `INSERT INTO stages (config_id, stage_id, name, threshold_gdd, seq)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const insertReport = this.db.prepare(
      `INSERT INTO reports
        (config_id, accepted, total_degree_minutes, total_gdd, span_minutes,
         observation_count, gaps_json, intervals_json, stages_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const outcome = analyze(config);

    this.db.exec("BEGIN IMMEDIATE");
    let report: AnalysisReport;
    try {
      const info = insertConfig.run(
        config.originDescription,
        config.thresholds.baseTemp,
        config.thresholds.upperTemp,
        config.gapRule.maxIntervalMinutes,
      );
      const configId = Number(info.lastInsertRowid);
      config.observations.forEach((o, i) =>
        insertObs.run(configId, i, o.minute, o.temp),
      );
      config.stages.forEach((s, i) =>
        insertStage.run(configId, s.id, s.name, s.thresholdGdd, i),
      );
      const repInfo = insertReport.run(
        configId,
        outcome.accepted ? 1 : 0,
        outcome.totalDegreeMinutes,
        outcome.totalGdd,
        outcome.spanMinutes,
        config.observations.length,
        JSON.stringify(outcome.gaps),
        JSON.stringify(outcome.intervals),
        JSON.stringify(outcome.stages),
      );
      const createdAt = this.db
        .prepare(`SELECT created_at FROM reports WHERE id = ?`)
        .get(Number(repInfo.lastInsertRowid)) as { created_at: string };
      report = {
        reportId: Number(repInfo.lastInsertRowid),
        configId,
        createdAt: createdAt.created_at,
        accepted: outcome.accepted,
        gaps: outcome.gaps,
        totalDegreeMinutes: outcome.totalDegreeMinutes,
        totalGdd: outcome.totalGdd,
        intervals: outcome.intervals,
        stages: outcome.stages,
        observationCount: config.observations.length,
        spanMinutes: outcome.spanMinutes,
      };
      report = {
        reportId: Number(repInfo.lastInsertRowid),
        configId,
        createdAt: createdAt.created_at,
        accepted: outcome.accepted,
        gaps: outcome.gaps,
        totalDegreeMinutes: outcome.totalDegreeMinutes,
        totalGdd: outcome.totalGdd,
        intervals: outcome.intervals,
        stages: outcome.stages,
        observationCount: config.observations.length,
        spanMinutes: outcome.spanMinutes,
      };
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return report;
  }

  listReports(): Array<{
    reportId: number;
    configId: number;
    createdAt: string;
    accepted: boolean;
    totalGdd: number;
    observationCount: number;
  }> {
    const rows = this.db
      .prepare(
        `SELECT id, config_id, created_at, accepted, total_gdd, observation_count
         FROM reports ORDER BY id`,
      )
      .all() as Array<{
      id: number;
      config_id: number;
      created_at: string;
      accepted: number;
      total_gdd: number;
      observation_count: number;
    }>;
    return rows.map((r) => ({
      reportId: r.id,
      configId: r.config_id,
      createdAt: r.created_at,
      accepted: r.accepted === 1,
      totalGdd: r.total_gdd,
      observationCount: r.observation_count,
    }));
  }

  getReport(reportId: number): AnalysisReport {
    const row = this.db
      .prepare(`SELECT * FROM reports WHERE id = ?`)
      .get(reportId) as
      | {
          id: number;
          config_id: number;
          created_at: string;
          accepted: number;
          total_degree_minutes: number;
          total_gdd: number;
          span_minutes: number;
          observation_count: number;
          gaps_json: string;
          intervals_json: string;
          stages_json: string;
        }
      | undefined;
    if (!row) {
      throw new DomainError("NOT_FOUND", `报告 ${reportId} 不存在`, {
        reportId,
      });
    }
    return {
      reportId: row.id,
      configId: row.config_id,
      createdAt: row.created_at,
      accepted: row.accepted === 1,
      gaps: JSON.parse(row.gaps_json),
      totalDegreeMinutes: row.total_degree_minutes,
      totalGdd: row.total_gdd,
      intervals: JSON.parse(row.intervals_json),
      stages: JSON.parse(row.stages_json),
      observationCount: row.observation_count,
      spanMinutes: row.span_minutes,
    };
  }

  /** 读取单个采样区间解释（从已持久化的报告中） */
  getInterval(reportId: number, intervalIndex: number) {
    const report = this.getReport(reportId);
    if (!report.accepted) {
      throw new DomainError(
        "GAP_VIOLATION",
        `报告 ${reportId} 因长缺口被拒绝，不存在已接受的区间解释`,
      );
    }
    const interval = report.intervals[intervalIndex];
    if (!interval) {
      throw new DomainError(
        "NOT_FOUND",
        `报告 ${reportId} 中不存在区间 ${intervalIndex}（共 ${report.intervals.length} 个）`,
        { intervalIndex, intervalCount: report.intervals.length },
      );
    }
    return { reportId, interval };
  }

  /** 读取某份配置的完整快照（观测、阈值、阶段、缺口规则） */
  getConfig(configId: number): AnalysisConfig {
    const cfg = this.db
      .prepare(`SELECT * FROM configs WHERE id = ?`)
      .get(configId) as ConfigRow | undefined;
    if (!cfg) {
      throw new DomainError("NOT_FOUND", `配置 ${configId} 不存在`, {
        configId,
      });
    }
    const obs = this.db
      .prepare(
        `SELECT minute, temp FROM observations WHERE config_id = ? ORDER BY seq`,
      )
      .all(configId) as unknown as Observation[];
    const stages = this.db
      .prepare(
        `SELECT stage_id, name, threshold_gdd FROM stages
         WHERE config_id = ? ORDER BY seq`,
      )
      .all(configId) as Array<{
      stage_id: number;
      name: string;
      threshold_gdd: number;
    }>;
    return {
      originDescription: cfg.origin_description,
      observations: obs.map((o) => ({
        minute: o.minute,
        temp: o.temp,
      })),
      thresholds: { baseTemp: cfg.base_temp, upperTemp: cfg.upper_temp },
      stages: stages.map(
        (s): Stage => ({
          id: s.stage_id,
          name: s.name,
          thresholdGdd: s.threshold_gdd,
        }),
      ),
      gapRule: { maxIntervalMinutes: cfg.max_interval_minutes },
    };
  }

  /**
   * 参数版本比较：沿用某份已存配置的观测快照，替换阈值/阶段/缺口
   * 规则后重新计算（不落库），并与原报告并排返回。观测无法在线
   * 修改，只比较参数版本。
   */
  compareWithParams(
    configId: number,
    overrides: {
      thresholds?: unknown;
      stages?: unknown;
      gapRule?: unknown;
    },
  ): {
    base: AnalysisReport;
    variant: AnalysisConfig & { result: ReturnType<typeof analyze> };
  } {
    const baseConfig = this.getConfig(configId);
    const variant: AnalysisConfig = {
      originDescription: baseConfig.originDescription,
      observations: baseConfig.observations,
      thresholds:
        overrides.thresholds !== undefined
          ? validateThresholds(overrides.thresholds)
          : baseConfig.thresholds,
      stages:
        overrides.stages !== undefined
          ? validateStages(overrides.stages)
          : baseConfig.stages,
      gapRule:
        overrides.gapRule !== undefined
          ? validateGapRule(overrides.gapRule)
          : baseConfig.gapRule,
    };
    const reportRow = this.db
      .prepare(`SELECT id FROM reports WHERE config_id = ?`)
      .get(configId) as { id: number } | undefined;
    const base = this.getReport(reportRow!.id);
    return { base, variant: { ...variant, result: analyze(variant) } };
  }

  /** 导出：报告 + 完整输入快照 */
  exportReport(reportId: number) {
    const report = this.getReport(reportId);
    const config = this.getConfig(report.configId);
    return { report, config };
  }
}
