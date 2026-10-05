/**
 * 纯后端 HTTP API（无外部框架，Node 内置 http）。
 * 默认选择空闲端口；可用 PORT 环境变量或 --port 指定。
 * 数据存放于项目内 data/ 目录，可用 GDD_DB 覆盖。
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as createNetServer } from "node:net";
import { resolve } from "node:path";
import { Storage } from "./storage.js";
import { DomainError, type ErrorCode } from "./errors.js";

interface JsonLike {
  [key: string]: unknown;
}

const HTTP_STATUS: Record<ErrorCode, number> = {
  EMPTY_SEQUENCE: 400,
  NON_FINITE_TEMP: 400,
  NON_INTEGER_MINUTE: 400,
  TIME_NOT_STRICTLY_INCREASING: 400,
  DUPLICATE_TIME: 400,
  TIME_OUT_OF_RANGE: 400,
  TOO_MANY_OBSERVATIONS: 413,
  TEMP_OUT_OF_RANGE: 400,
  INVALID_BASE_TEMP: 400,
  INVALID_UPPER_TEMP: 400,
  UPPER_NOT_ABOVE_BASE: 400,
  DUPLICATE_STAGE_ID: 400,
  STAGE_THRESHOLD_NOT_POSITIVE: 400,
  STAGES_NOT_STRICTLY_INCREASING: 400,
  TOO_MANY_STAGES: 413,
  STAGE_THRESHOLD_OUT_OF_RANGE: 400,
  INVALID_GAP_RULE: 400,
  GAP_VIOLATION: 422,
  INVALID_ORIGIN: 400,
  NOT_FOUND: 404,
  CONFIG_VERSION_MISMATCH: 409,
  BAD_REQUEST: 400,
  INTERNAL: 500,
};

function pickPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createNetServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolvePort(port));
      } else {
        srv.close(() => reject(new Error("无法获取空闲端口")));
      }
    });
    srv.on("error", reject);
  });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 10 * 1024 * 1024) {
        rejectBody(new DomainError("BAD_REQUEST", "请求体超过 10MB 限制"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length === 0) return resolveBody({});
      try {
        resolveBody(JSON.parse(raw));
      } catch {
        rejectBody(new DomainError("BAD_REQUEST", "请求体不是合法 JSON"));
      }
    });
    req.on("error", rejectBody);
  });
}

export function createApp(storage: Storage): Server {
  const send = (
    res: ServerResponse,
    status: number,
    body: unknown,
  ) => {
    const json = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
    });
    res.end(json);
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";

    try {
      // 健康检查
      if (method === "GET" && path === "/health") {
        return send(res, 200, { ok: true });
      }

      // 创建分析：POST /analyses
      if (method === "POST" && path === "/analyses") {
        const body = await readJson(req);
        const report = storage.createAnalysis(body);
        return send(res, 201, report);
      }

      // 报告列表：GET /reports
      if (method === "GET" && path === "/reports") {
        return send(res, 200, { reports: storage.listReports() });
      }

      const reportMatch = path.match(/^\/reports\/(\d+)$/);
      if (method === "GET" && reportMatch) {
        return send(res, 200, storage.getReport(Number(reportMatch[1])));
      }

      // 区间解释：GET /reports/:id/intervals/:idx
      const intervalMatch = path.match(
        /^\/reports\/(\d+)\/intervals\/(\d+)$/,
      );
      if (method === "GET" && intervalMatch) {
        return send(
          res,
          200,
          storage.getInterval(
            Number(intervalMatch[1]),
            Number(intervalMatch[2]),
          ),
        );
      }

      // 参数版本比较：POST /configs/:id/compare
      const compareMatch = path.match(/^\/configs\/(\d+)\/compare$/);
      if (method === "POST" && compareMatch) {
        const body = (await readJson(req)) as JsonLike;
        return send(
          res,
          200,
          storage.compareWithParams(Number(compareMatch[1]), {
            thresholds: body.thresholds,
            stages: body.stages,
            gapRule: body.gapRule,
          }),
        );
      }

      // 导出：GET /reports/:id/export
      const exportMatch = path.match(/^\/reports\/(\d+)\/export$/);
      if (method === "GET" && exportMatch) {
        return send(res, 200, storage.exportReport(Number(exportMatch[1])));
      }

      return send(res, 404, {
        error: {
          code: "NOT_FOUND",
          message: `无此路由：${method} ${path}`,
        },
      });
    } catch (err) {
      if (err instanceof DomainError) {
        return send(res, HTTP_STATUS[err.code] ?? 400, {
          error: { code: err.code, message: err.message, details: err.details },
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      return send(res, 500, {
        error: { code: "INTERNAL", message },
      });
    }
  });
}

async function main(): Promise<void> {
  const argPort = parseArgPort(process.argv.slice(2));
  const port =
    argPort ??
    (process.env.PORT ? Number(process.env.PORT) : await pickPort());
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`非法端口：${port}`);
  }
  const dbPath =
    process.env.GDD_DB ?? resolve(process.cwd(), "data", "gdd.sqlite");
  const storage = new Storage(dbPath);
  const server = createApp(storage);
  server.listen(port, "127.0.0.1", () => {
    const actual = (server.address() as { port: number }).port;
    // 最后一行稳定输出，方便脚本捕获端口
    console.log(`GDD_API_PORT=${actual}`);
    console.log(`数据库: ${dbPath}`);
  });

  const shutdown = () => {
    server.close(() => {
      storage.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function parseArgPort(args: string[]): number | null {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1] !== undefined) {
      return Number(args[i + 1]);
    }
    if (args[i].startsWith("--port=")) {
      return Number(args[i].slice("--port=".length));
    }
  }
  return null;
}

const isMain = (() => {
  try {
    return process.argv[1] !== undefined &&
      (process.argv[1].endsWith("server.ts") ||
        process.argv[1].endsWith("server.js"));
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
