# RC-21 桌面端长跑与真实负载性能基线（已闭环 · 豁免空窗收口）

> 状态：**已闭环（2026-11-28，经项目负责人拍板豁免 hour 2–4 采样空窗正式收口）**。  
> 四项主场景实测（485.1 分钟长跑 + 1,080 作品 / 11,397 事件 P95 + 105 轮 UI 直发长对话修复回归 + 65 秒断服自愈）及核心 499 取消风暴代码根治均已落地并留存实证；因原守护 60m 被强杀导致的 266.83 分钟采样空窗、断服首轮探针路径偏差及冷启动 `/works` P95 `2013.2ms` 仍按事实保留于下方客观边界章节，不补造空窗采样点。

## 环境与隔离说明

- **隔离数据库**：独立库 `ops_rc21`（已于收尾 `DROP DATABASE` 清理）与 `ops_rc21_fix`（已清理），均位于本地开发容器 `ops-dev-postgres-1`（端口 `5440`），未触碰 `ops` 主开发库。
- **隔离服务端与桌面端**：未打包 Electron 44.9.1 + 本地同源静态产物（`renderer` `vite build --mode desktop` 设 `OPS_API_BASE=/`，产物中生产域名 `ops-api.88813888` 命中数为 `0`）挂载于独立隔离服务端（`:18121` 长跑 / 基线；`:18221` 105 轮修复复测）。
- **零线上与用户目录污染**：全程使用独立 `--user-data-dir`，未读写 `%APPDATA%\OPS Desktop`，未向生产服务发送压测数据；所有本机绝对路径在证据中已脱敏为 `<temp>`，不含 Cookie、CSRF、密码或真实账号数据。

---

## 四条通过标准逐项结果

| # | 通过标准 | 实测结果 | 关键证据 |
| --- | --- | --- | --- |
| 1 | ≥8 小时桌面端连续稳态运行 | **PARTIAL（485.1 分钟零崩零漏，含 266.83m 采样空窗）**：总运行 **485.1 分钟（8h05m）**、有效采样 **51 条**；同一 Electron `PID 33092`（启动时间 `2026-11-27 12:34:57`）全程未重启；**crash=0 / OOM=0 / console_errors=0 / page_errors=0 / unresponsive=0**；Electron RSS 由 `451.3 MB` 稳降至 `212.9 MB`（斜率 `-28.784 MB/h`），Server RSS 稳于 `37.5 MB`（斜率 `-5.555 MB/h`）。原守护 `node 23116` 于 60.04m 被外部 60 分钟超时强杀导致 hour 2/3/4 空窗（未补造任何采样点）。 | `soak-summary.json`、`soak-samples.jsonl` |
| 2 | 大数据量压测 P95（≥1000 作品 / ≥10000 事件） | **PASS（含 1 项冷启动首屏注意项）**：数据集 **1,080 作品**、4,290 段落、**11,397 条事件**（`ANALYZE` 已执行）。7 项 API P95 全部 `<220ms`（`works_list 27.9ms`、`search 97.6ms`、`editor_open 21.5ms`、`section_save 34.7ms`、`review_board 212ms`、`review_reports 23.5ms`、`push_preview 19.2ms`）；UI 6 项中 5 项 `<1300ms`（`editor 685.2ms`、`save 1280.4ms`、`push 411.8ms`、`review 899.8ms`、`search 910.9ms`），冷启动 `/works` 首屏 P95 为 **`2013.2ms`**（超 2000ms 线 13.2ms）。`EXPLAIN (ANALYZE, BUFFERS)` 实测 SQL 仅 `0.592ms` / `0.793ms`，瓶颈在全新 Electron 冷启动与空缓存首访串行装载。 | `step1-load-and-chat-baseline.json`、`explain-works.txt` |
| 3 | 100+ 轮长对话稳定性（含 499 取消风暴根治） | **PASS**：基线发现第 26 轮（约 90s）UI 直发因服务端 SSE 读取截止时间到期引发全接口 499 取消风暴与错误卡/停止按钮残留。根治服务端 `http_request.go`（移除 SSE `ReadDeadline`）与客户端 `agent-events.ts`/`useAgentRun.ts`/`api-retry.ts` 后，UI 直接发送（`textarea + Enter`）**105 / 105 全部完成，0 失败**、0 个 499 response / console error、错误卡 `false`、停止按钮残留 `false`、TTFT P95 **`232ms`**、总耗时 P95 **`1563ms`**、结束态 FPS **`144.6`**、JS Heap `13.58→18.58MB`（`+5.0MB`）、Electron RSS `637.1→765.0MB`、page errors `0`。 | `step1-load-and-chat-baseline.json`、`step1b-chat-105-ui-direct-fix.json`、`shot-chat-105-ui-direct-final.png` |
| 4 | 长跑中断服 1 分钟自动恢复 | **PASS（附探针路由偏差披露）**：在长跑第 `327.51` 分钟精确停服 `65 秒` 并拉起（Server PID `27436 → 34152`），`/healthz` **`517ms`** 恢复 200；停服及恢复期间同一 Electron `PID 33092` 未重启且存活响应；恢复后页面复核 `/api/v1/auth/me` 与 `/api/v1/accounts/49c6bd24-d993-46d4-8a62-bf387666a3b6/works?limit=1` 均返回 200。 | `outage-recovery.json`、`soak-summary.json` |

---

## 如实披露的 3 处客观边界

1. **采样空窗（60m → 327m）**：原守护进程 `node 23116` 于运行第 60.04 分钟被外部 60 分钟超时机制强制终止，热接管续采至总时长 485.1 分钟前存在 `266.83` 分钟（缺 hour 2 / 3 / 4）的采样空白；`soak-samples.jsonl` 未补造空窗期任何数据。
2. **断服恢复首轮探针路由偏差**：脚本首轮页面复核探针路径误写为不存在的 `/api/v1/works?limit=1`（返回 404），导致自动测算的 `pageRecoveryMs` 记为 `null`；随后以产品真实路由 `/api/v1/accounts/{accountId}/works?limit=1` 复核返回 200，已同步记录于 `outage-recovery.json`。
3. **测试形态与冷启动首屏延迟**：因打包 `.exe` 编译期硬编码生产域名，本批统一采用「未打包 Electron 44.9.1 + 同源本地隔离静态构建」运行；另外冷启动全新 Electron 访问 1,080 作品的 `/works` 首屏 P95 为 `2013.2ms`（超 2000ms 参考线 13.2ms，数据库本身耗时 `<0.8ms`），后续可评估客户端缓存与骨架屏并行优化。

---

## 归档文件清单

- `README.md`：本说明文档
- `soak-summary.json`：485.1 分钟长跑汇总（含每小时均值/峰值、斜率、空窗说明与断服汇总）
- `soak-samples.jsonl`：51 条实际采样点原始记录
- `outage-recovery.json`：65 秒停服重启与页面恢复记录
- `step1-load-and-chat-baseline.json`：1,080 作品 / 11,397 事件 P95 基线及修复前 105 轮对话缺陷基线
- `explain-works.txt`：`EXPLAIN (ANALYZE, BUFFERS)` 作品列表查询执行计划
- `step1b-chat-105-ui-direct-fix.json`：修复后 105 轮 UI 直接发送回归全量记录
- `shot-chat-105-ui-direct-final.png`：105 轮 UI 直发完成终态截图
