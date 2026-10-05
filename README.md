# 逐时温度有效积温与阶段阈值追踪后端

基于温度观测序列的有效积温（GDD）分析服务。仅做离线分析：不预测产量、不关联病虫害处置、不获取在线天气、不控制任何设备。纯本地运行：TypeScript + Node.js（>= 22.5，使用内置 `node:sqlite`）+ SQLite，无 Docker / WSL / 外部服务，零运行时依赖。

## 模型假设

- 观测点为 `(t, temp)`：`t` 为从季节起点 t0 起的**整数分钟**（严格递增），`temp` 为摄氏温度。原始温度永不截断，截断只发生在积分内部。
- 瞬时有效温度 `eff(T) = max(0, min(T, Tu) - Tb)`，要求 `Tb < Tu`。
- 相邻采样点之间**线性插值**温度；先对温度线性插值、再做截断，而不是先截断端点再梯形积分，也不是先平均再截断。区间内若线性段跨越 Tb 或 Tu，在**精确交点**处分段，对每段累加三角形/梯形面积。
- 面积单位为 °C·min，除以 **1440** 换为 °C·day；非整天区间按实际时长计。
- 阶段为严格递增的正积温门槛（°C·day）。累计值 `>=` 门槛即视为已达（恰好命中也算）；报告首次跨过门槛的是**哪两个观测之间**，不反求精确跨越时刻，也不把区间末端时间冒充发生时刻。未达阶段保持 `pending`。阶段名称仅为标签，不参与数值计算。
- 缺口规则：`maxGapMinutes` 为最大允许采样间隔；任一区间超过即**拒绝整次分析**并列出缺口（`GAP_EXCEEDED`），不会跨长缺测断言阶段达成。
- 单点序列合法：零时长、零积温；空序列拒绝（`EMPTY_SERIES`）。
- 规模限制：最多 100000 个观测、时间跨度 ≤ 约 10 年、|temp| ≤ 150 °C、阶段 ≤ 1000 个。不做在线无限流与多站插值。

## 构建 / 测试 / 启动 / 演示

```powershell
npm install        # 仅开发依赖 typescript + @types/node
npm run build      # 编译到 dist/
npm test           # node:test，18 个用例
npm start          # 启动 API（默认选择空闲端口；--port N 或 PORT 指定）
npm run demo       # 内置演示（含手算几何核对）
node src/cli.ts    # 查看全部 CLI 命令
```

数据目录为项目内 `data/`（可用环境变量 `GDD_DATA_DIR` 覆盖），SQLite 文件 `data/gdd.db`。

## CLI

```
node src/cli.ts serve [--port N]
node src/cli.ts import <file.json>            # {t0Description, points:[{t,temp}]}
node src/cli.ts validate <file.json>
node src/cli.ts config --name c1 --tb 10 --tu 30 --max-gap 180 --stages "1:出苗:100,2:拔节:300"
node src/cli.ts analyze --dataset 1 --config 1
node src/cli.ts show <reportId>               # 各区间热量、累计值、阶段状态
node src/cli.ts interval <reportId> <idx>     # 单区间解释（交点、分段面积）
node src/cli.ts compare <idA> <idB>           # 比较两个参数版本
node src/cli.ts export <reportId> [--csv]
node src/cli.ts reports
node src/cli.ts demo
```

## HTTP API（JSON）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/datasets` | 导入观测 `{t0Description, points}` |
| POST | `/datasets/validate` | 仅校验 |
| POST | `/configs` | `{name, tb, tu, maxGapMinutes, stages:[{id,name,threshold}]}` |
| POST | `/analyses` | `{datasetId, configId}`，返回完整报告 |
| GET | `/analyses` / `/analyses/:id` | 列表 / 读取报告（重启后可复算同一区间） |
| GET | `/analyses/:id/intervals/:idx` | 单区间解释 |
| GET | `/analyses/compare?ids=1,2` | 参数版本比较 |
| GET | `/analyses/:id/export?format=csv` | 导出 CSV（默认 JSON） |

错误响应统一为 `{error:{code,message,details}}`。

## 稳定错误码

`EMPTY_SERIES` `NON_FINITE_TEMP` `NON_FINITE_TIME` `TIME_NOT_INCREASING` `DUPLICATE_TIME` `INVALID_THRESHOLDS`（含 Tb>=Tu）`INVALID_STAGE` `DUPLICATE_STAGE_ID` `STAGE_THRESHOLD_NOT_INCREASING` `GAP_EXCEEDED` `TOO_MANY_OBSERVATIONS` `RANGE_EXCEEDED` `VALUE_OUT_OF_RANGE` `NOT_FOUND` `BAD_REQUEST`

## 持久化与原子性

SQLite 保存：观测快照（含 t0 说明）、温度门槛、阶段配置、缺口规则、分析报告与逐区间明细。修改任意输入会生成**新报告**，历史报告不可变。报告与区间明细在同一事务中提交，失败整体回滚，不会留下半截累计值冒充完整季节结果（有专门测试：删表制造写入失败，验证 `reports` 无残留行）。

## 演示与核对

`npm run demo` 演示：一天内 0→20 °C 线性升温、Tb=10、Tu=30，结果 **2.5 °C·day**。手算：t=720min 处穿过 Tb，有效温度是底 720min、高 10°C 的三角形，面积 3600 °C·min ÷ 1440 = 2.5。若用“先平均再截断”：平均温度 10°C → max(0,10-10)=0，得到 0 —— 跨阈值区间上两种方法结果不同，本实现采用前者（先插值后截断的精确积分）。另演示全低于基温（0）、全高于上限（恒为 Tu-Tb）、同时跨越两阈值（5→35 °C，14400 °C·min = 10 °C·day）等情形。

测试覆盖：共线中间采样插入不改变总积温、温度与两阈值整体平移结果不变、°C·min↔°C·day 换算、门槛恰好命中视为已达、长缺口拒绝、事务回滚、重启后读取复算。

## 限制

- 仅实现上述明确的分段线性 + 截断积分模型，不含正弦/三角等其它日积分近似法。
- 阶段达成只定位到观测区间，不反求精确跨越时刻。
- 单站、离线、有界输入；不做实时流、多站插值或任何在线数据获取。
