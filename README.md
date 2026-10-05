# 逐时温度有效积温与阶段阈值追踪后端

基于温度观测序列的**有效积温（GDD）分析服务**。在相邻采样点之间对温度做
**线性插值**，对截断后的瞬时有效温度关于时间积分，追踪生长季累计热量与
阶段阈值。只做 API 与 CLI，纯本地运行，无 Docker、WSL、付费服务或外部在线 API。

- 语言/运行时：TypeScript + Node.js（要求 Node `>= 22.5`，使用内置 `node:sqlite`，开发于 Node 25）
- 数据库：SQLite（项目内 `data/gdd.sqlite`，WAL 模式），零第三方运行时依赖
- 平台：Windows 本地（路径、端口、信号均按本机处理）

## 模型假设（唯一实现的模型）

1. 采样点用**从起点开始的整数分钟** `minute` 与**摄氏温度** `temp` 表示，时间严格递增。
2. 给定基温 `Tb` 与上限温度 `Tu`（`Tu > Tb`），瞬时有效温度为
   `eff(T) = max(0, min(T, Tu) - Tb)`。
3. 相邻采样点之间温度**线性变化**；积分按时间进行。区间跨越 `Tb` 或 `Tu` 时，
   先在**交点处分段**，再逐段累计三角形 / 梯形面积：
   - **不会**先把两个端点温度截断后直接做一个梯形；
   - **不会**先平均温度再截断（跨阈值时这两种做法都是错的）。
4. 面积单位为 **°C·分钟**，除以 **1440** 换算为 **°C·日**；非整天区间按实际
   分钟时长计算，不假定每条记录代表一天。
5. 阶段门槛为严格递增的正积温（°C·日）。报告每个阶段是否达成，以及首次跨过
   门槛发生在**哪两个观测之间**；**不反求精确跨越时刻**，也不把区间末端时间
   冒充真实发生时刻。累计值**恰好等于**门槛即视为达成。阶段名称不参与计算。
6. 设置最大允许采样间隔；任一区间超过即**拒绝整次分析**并指出缺口，不跨过长
   缺测断言阶段达成。
7. 本服务**只做上述确定性几何积分**：不预测真实作物产量、不关联病虫害处置、
   不获取在线天气、不控制任何农业设备、不做多站插值。

## 量级限制

| 项目 | 上限 |
| --- | --- |
| 观测条数 | 100,000 |
| 时间范围 | 0 – 1,500,000 分钟（约 3 年） |
| 温度绝对值 | 200 °C |
| 阈值绝对值 | 200 °C |
| 最大采样间隔 | 43,200 分钟（30 天） |
| 阶段数量 | 1,000 |
| 请求体 | 10 MB |

## 快速开始

```powershell
npm install
npm run build      # 编译到 dist/
npm test           # 构建 + 38 个测试（引擎/校验/持久化/HTTP）
npm run demo       # 四个手算核对演示
npm start          # 启动 HTTP API；默认自动选择空闲端口，输出 GDD_API_PORT=xxxx
```

指定端口或数据库：

```powershell
node dist/src/server.js --port 8080
$env:PORT="8080"; npm start
$env:GDD_DB="$PWD\data\custom.sqlite"; npm start
```

## CLI

CLI 与 API 共用同一存储层，默认数据库为 `data/gdd.sqlite`（`--db` 覆盖）。

```powershell
# 仅校验
node dist/src/cli.js validate demos/sample-config.json

# 导入并执行分析（展示各区间热量、累计、阶段状态）
node dist/src/cli.js import demos/sample-config.json

# 列表 / 报告 / 单区间解释
node dist/src/cli.js list
node dist/src/cli.js report 1
node dist/src/cli.js interval 1 2

# 参数版本比较（文件内只放要覆盖的 thresholds/stages/gapRule，不落库）
node dist/src/cli.js compare 1 demos/override.json

# 导出报告 + 输入快照
node dist/src/cli.js export 1 --out data/report-1.json
```

`report --json` 可输出机器可读 JSON。

### 输入文件格式（AnalysisConfig）

```json
{
  "originDescription": "2026-04-01T00:00:00+08:00 生长季起点说明（自由文本）",
  "observations": [
    { "minute": 0, "temp": 0 },
    { "minute": 1440, "temp": 20 }
  ],
  "thresholds": { "baseTemp": 10, "upperTemp": 30 },
  "stages": [
    { "id": 1, "name": "发芽", "thresholdGdd": 2.5 }
  ],
  "gapRule": { "maxIntervalMinutes": 1440 }
}
```

## HTTP API

仅监听 `127.0.0.1`。响应统一 JSON；错误体形如
`{"error":{"code":"...","message":"...","details":...}}`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/analyses` | 校验输入、保存快照、执行分析、原子落库报告 |
| GET | `/reports` | 报告摘要列表 |
| GET | `/reports/:id` | 完整报告（区间、交点、分段面积、累计、阶段） |
| GET | `/reports/:id/intervals/:idx` | 单个采样区间的完整解释 |
| POST | `/configs/:id/compare` | 用新阈值/阶段/缺口规则比较参数版本（观测沿用快照，不落库） |
| GET | `/reports/:id/export` | 导出报告 + 完整输入快照 |

长缺口的分析仍是被持久化的资源（`201`），但报告体内 `"accepted": false`，
`intervals` 为空、`totalGdd` 为 0、阶段全部待达，并在 `gaps` 中列出违例。

### 错误码

| code | 含义 | HTTP |
| --- | --- | --- |
| `EMPTY_SEQUENCE` | 观测序列为空 | 400 |
| `NON_FINITE_TEMP` | 温度为 NaN/Infinity 等非有限值 | 400 |
| `NON_INTEGER_MINUTE` | 时间不是整数分钟 | 400 |
| `TIME_NOT_STRICTLY_INCREASING` | 时间重排 | 400 |
| `DUPLICATE_TIME` | 重复时间 | 400 |
| `TIME_OUT_OF_RANGE` / `TEMP_OUT_OF_RANGE` | 超量级 | 400 |
| `TOO_MANY_OBSERVATIONS` / `TOO_MANY_STAGES` | 超数量 | 413 |
| `INVALID_BASE_TEMP` / `INVALID_UPPER_TEMP` | 阈值非法 | 400 |
| `UPPER_NOT_ABOVE_BASE` | Tu 未严格大于 Tb | 400 |
| `DUPLICATE_STAGE_ID` | 阶段编号重复 | 400 |
| `STAGE_THRESHOLD_NOT_POSITIVE` | 门槛非正 | 400 |
| `STAGES_NOT_STRICTLY_INCREASING` | 门槛未严格递增 | 400 |
| `INVALID_GAP_RULE` | 缺口规则非法 | 400 |
| `GAP_VIOLATION` | 读取被拒绝报告的区间等 | 422 |
| `INVALID_ORIGIN` | 起点说明缺失/过长 | 400 |
| `NOT_FOUND` | 报告/配置/区间不存在或路由未知 | 404 |
| `BAD_REQUEST` / `INTERNAL` | 畸形 JSON 等 / 内部错误 | 400/500 |

## 手算示例

一天（1440 分钟）内温度从 0 °C 线性升到 20 °C，`Tb=10`、`Tu=30`：

- 温度在第 720 分钟穿过基温：`0 + (20/1440)·m = 10 => m = 720`。
- 0–720 分钟有效温度为 0；720–1440 分钟有效温度从 0 升到 10 °C，呈三角形。
- 面积 `= 1/2 × 10 °C × 720 分 = 3600 °C·分 = 2.5 °C·日`。

**平均温度法为何不同**：先平均 `(0+20)/2 = 10 °C`，再算有效温度
`max(0, 10−10) = 0`，会错误地得到 0；它抹掉了“区间后半段确实高于基温”这
一事实。本服务先在交点切分再积分，得到正确的 2.5 °C·日。

其余演示（全低于基温 = 0；全高于上限按 Tu 截断成矩形；同一区间同时跨越
`Tb` 与 `Tu` 分三段）见 `npm run demo` 输出与 `tests/engine.test.ts`。

## 持久化与一致性

- 每次输入（观测快照、起点说明、阈值、阶段、缺口规则）都作为不可变配置
  保存；**修改任意输入都会生成新的 config + report**，不覆盖历史。
- 报告写入与“接受/完成状态”在单个 SQLite 事务（`BEGIN IMMEDIATE` /
  `COMMIT` / `ROLLBACK`）内提交；失败整体回滚，不会留下半段累计值。
- 重启后可直接读取报告，或用保存的配置快照重新计算，结果一致（测试覆盖）。
- 原始观测温度单独存表，不会被截断后的有效温度覆盖。

## 项目结构

```
src/
  types.ts      领域类型与量级常量
  errors.ts     稳定错误码与 DomainError
  validate.ts   全部输入校验
  engine.ts     线性插值、交点分段、三角/梯形积分、阶段判定、缺口检查
  storage.ts    SQLite 模式、原子事务、快照/报告/比较/导出
  server.ts     HTTP API（默认空闲端口，可 --port / PORT）
  cli.ts        命令行
demos/demo.ts   四个手算演示
tests/          node:test 测试（引擎、校验、事务回滚、重启、HTTP）
data/           SQLite 数据目录（运行时生成）
```

## 明确限制

- 只做单站、单一确定性模型的热量积分与阈值追踪；不含预报、产量、病虫害、
  设备控制、在线天气或多站融合。
- 积温门槛只定位到“首次跨越所在的观测区间”，不提供区间内精确时刻反算。
- 时间轴是相对起点的整数分钟；绝对时间仅以 `originDescription` 文本保存说明，
  不做时区/历法换算。
