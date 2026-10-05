#!/usr/bin/env node
/**
 * 命令行界面：直接操作本地 SQLite（与 API 共用同一存储层）。
 *
 * 用法：
 *   gdd import <file.json>              导入观测/配置并执行分析
 *   gdd analyze <file.json>             （import 的别名）
 *   gdd validate <file.json>            仅校验，不落库
 *   gdd list                            列出报告
 *   gdd report <id> [--json]            查看报告（各区间热量/累计/阶段）
 *   gdd interval <reportId> <idx>       读取单个区间解释
 *   gdd compare <configId> <file.json>  用新参数版本比较（不落库）
 *   gdd export <reportId>               导出报告 + 输入快照 JSON
 *
 * 输入文件即 AnalysisConfig 的 JSON。可用 --db 指定数据库路径，
 * 默认项目内 data/gdd.sqlite。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Storage } from "./storage.js";
import { validateConfig } from "./validate.js";
import { DomainError } from "./errors.js";
import type { AnalysisReport } from "./types.js";
import { MINUTES_PER_DAY } from "./types.js";

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      if (a.includes("=")) {
        const [k, ...rest] = a.split("=");
        flags.set(k, rest.join("="));
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        flags.set(a, argv[++i]);
      } else {
        flags.set(a, true);
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function defaultDbPath(): string {
  return process.env.GDD_DB ?? resolve(process.cwd(), "data", "gdd.sqlite");
}

function readJsonFile(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new DomainError(
      "NOT_FOUND",
      `无法读取文件 ${path}: ${(err as Error).message}`,
    );
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new DomainError("BAD_REQUEST", `文件 ${path} 不是合法 JSON`);
  }
}

function fmt(x: number): string {
  return x.toFixed(4).replace(/\.?0+$/, "");
}

function renderReport(report: AnalysisReport): string {
  const lines: string[] = [];
  lines.push(`报告 #${report.reportId}（配置 #${report.configId}）  生成于 ${report.createdAt}`);
  lines.push(
    `观测 ${report.observationCount} 条，跨度 ${report.spanMinutes} 分钟（${fmt(report.spanMinutes / MINUTES_PER_DAY)} 日）`,
  );

  if (!report.accepted) {
    lines.push("状态：拒绝（存在超过最大允许间隔的缺测缺口，未断言任何积温/阶段）");
    for (const g of report.gaps) {
      lines.push(
        `  缺口：区间 #${g.intervalIndex}，分钟 ${g.startMinute} -> ${g.endMinute}，间隔 ${g.intervalMinutes} > 允许 ${g.maxAllowedMinutes}`,
      );
    }
    lines.push("阶段：全部待达");
    for (const s of report.stages) {
      lines.push(`  [#${s.stageId}] ${s.name}（门槛 ${fmt(s.thresholdGdd)} °C·日）：待达`);
    }
    return lines.join("\n");
  }

  lines.push(
    `状态：接受  总积温 ${fmt(report.totalDegreeMinutes)} °C·分钟 = ${fmt(report.totalGdd)} °C·日`,
  );
  lines.push("");
  lines.push("各区间热量（原始温度不被截断结果覆盖）：");
  lines.push(
    "  #   分钟区间          原始温度(起->止)   时长   区间°C·日   累计°C·日   交点",
  );
  for (const iv of report.intervals) {
    const crossings = iv.crossings
      .map((c) => `${c.kind}@${fmt(c.minute)}`)
      .join(",");
    lines.push(
      `  ${String(iv.index).padStart(2)}  ` +
        `${String(iv.startMinute).padStart(5)}-${String(iv.endMinute).padStart(5)}      ` +
        `${fmt(iv.startTemp).padStart(7)} -> ${fmt(iv.endTemp).padStart(7)}   ` +
        `${String(iv.durationMinutes).padStart(5)}   ` +
        `${fmt(iv.intervalGdd).padStart(8)}   ${fmt(iv.cumulativeGdd).padStart(8)}   ${crossings}`,
    );
  }

  lines.push("");
  lines.push("阶段状态：");
  for (const s of report.stages) {
    if (s.reached && s.crossedBetweenMinutes) {
      lines.push(
        `  [#${s.stageId}] ${s.name}（门槛 ${fmt(s.thresholdGdd)} °C·日）：已达，首次跨过发生在观测区间 #${s.crossedBetweenIndex}（分钟 ${s.crossedBetweenMinutes[0]} 与 ${s.crossedBetweenMinutes[1]} 之间；不反求精确时刻）`,
      );
    } else {
      lines.push(
        `  [#${s.stageId}] ${s.name}（门槛 ${fmt(s.thresholdGdd)} °C·日）：待达`,
      );
    }
  }
  return lines.join("\n");
}

function usage(): string {
  return [
    "用法：gdd <command> [参数] [--db path] [--json]",
    "命令：",
    "  import|analyze <file.json>   导入配置并执行分析",
    "  validate <file.json>         仅校验输入，不落库",
    "  list                         列出所有报告摘要",
    "  report <id>                  查看报告（区间热量/累计/阶段）",
    "  interval <reportId> <idx>    查看单个区间解释",
    "  compare <configId> <file>    用文件中的 thresholds/stages/gapRule 覆盖并比较",
    "  export <reportId> [--out f]  导出报告+输入快照 JSON",
  ].join("\n");
}

export function run(argv: string[]): number {
  const { positional, flags } = parseArgs(argv);
  const command = positional[0];
  const asJson = flags.has("--json");
  const dbPath = (flags.get("--db") as string | undefined) ?? defaultDbPath();

  if (!command || command === "help" || command === "--help") {
    console.log(usage());
    return 0;
  }

  let storage: Storage | null = null;
  try {
    switch (command) {
      case "validate": {
        const file = positional[1];
        if (!file) throw new DomainError("BAD_REQUEST", "缺少配置文件参数");
        const config = validateConfig(readJsonFile(file));
        console.log(
          `校验通过：${config.observations.length} 条观测，${config.stages.length} 个阶段，Tb=${config.thresholds.baseTemp} Tu=${config.thresholds.upperTemp}，最大间隔 ${config.gapRule.maxIntervalMinutes} 分钟`,
        );
        return 0;
      }

      case "import":
      case "analyze": {
        const file = positional[1];
        if (!file) throw new DomainError("BAD_REQUEST", "缺少配置文件参数");
        storage = new Storage(dbPath);
        const report = storage.createAnalysis(readJsonFile(file));
        console.log(asJson ? JSON.stringify(report, null, 2) : renderReport(report));
        return 0;
      }

      case "list": {
        storage = new Storage(dbPath);
        const reports = storage.listReports();
        if (asJson) {
          console.log(JSON.stringify({ reports }, null, 2));
        } else if (reports.length === 0) {
          console.log("（暂无报告）");
        } else {
          for (const r of reports) {
            console.log(
              `#${r.reportId} 配置#${r.configId}  ${r.accepted ? "接受" : "拒绝"}  总积温 ${fmt(r.totalGdd)} °C·日  观测 ${r.observationCount}  ${r.createdAt}`,
            );
          }
        }
        return 0;
      }

      case "report": {
        const id = Number(positional[1]);
        if (!Number.isInteger(id)) throw new DomainError("BAD_REQUEST", "报告 id 必须是整数");
        storage = new Storage(dbPath);
        const report = storage.getReport(id);
        console.log(asJson ? JSON.stringify(report, null, 2) : renderReport(report));
        return 0;
      }

      case "interval": {
        const reportId = Number(positional[1]);
        const idx = Number(positional[2]);
        if (!Number.isInteger(reportId) || !Number.isInteger(idx)) {
          throw new DomainError("BAD_REQUEST", "需要 reportId 与区间序号两个整数");
        }
        storage = new Storage(dbPath);
        const data = storage.getInterval(reportId, idx);
        console.log(JSON.stringify(data, null, 2));
        return 0;
      }

      case "compare": {
        const configId = Number(positional[1]);
        const file = positional[2];
        if (!Number.isInteger(configId) || !file) {
          throw new DomainError("BAD_REQUEST", "用法：compare <configId> <file.json>");
        }
        const overrides = readJsonFile(file) as Record<string, unknown>;
        storage = new Storage(dbPath);
        const result = storage.compareWithParams(configId, {
          thresholds: overrides.thresholds,
          stages: overrides.stages,
          gapRule: overrides.gapRule,
        });
        const variantSummary = {
          accepted: result.variant.result.accepted,
          gaps: result.variant.result.gaps,
          totalDegreeMinutes: result.variant.result.totalDegreeMinutes,
          totalGdd: result.variant.result.totalGdd,
          stages: result.variant.result.stages,
        };
        console.log(
          JSON.stringify(
            {
              base: {
                reportId: result.base.reportId,
                accepted: result.base.accepted,
                totalGdd: result.base.totalGdd,
                stages: result.base.stages,
              },
              variant: variantSummary,
            },
            null,
            2,
          ),
        );
        return 0;
      }

      case "export": {
        const reportId = Number(positional[1]);
        if (!Number.isInteger(reportId)) {
          throw new DomainError("BAD_REQUEST", "需要 reportId 整数");
        }
        storage = new Storage(dbPath);
        const payload = storage.exportReport(reportId);
        const json = JSON.stringify(payload, null, 2);
        const out = flags.get("--out");
        if (typeof out === "string") {
          writeFileSync(out, json, "utf8");
          console.log(`已导出到 ${out}`);
        } else {
          console.log(json);
        }
        return 0;
      }

      default:
        console.error(`未知命令：${command}\n`);
        console.error(usage());
        return 2;
    }
  } catch (err) {
    if (err instanceof DomainError) {
      console.error(
        `错误 [${err.code}] ${err.message}${err.details ? "\n" + JSON.stringify(err.details) : ""}`,
      );
      return 1;
    }
    console.error(err);
    return 1;
  } finally {
    storage?.close();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("cli.ts") || process.argv[1].endsWith("cli.js"));

if (invokedDirectly) {
  process.exit(run(process.argv.slice(2)));
}
