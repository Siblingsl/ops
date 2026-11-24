# RC-03 验收报告（2026-11-23）

## 结论

**RC-03 未闭环。** 五条中第 1、4 条已 PASS；第 2 条 1/3；第 3 条 PARTIAL；第 5 条 FAIL。未用 mock、夹具或估算值补齐。

| # | 验收条 | 判定 | 关键事实 | 证据 |
|---|---|---|---|---|
| 1 | 真实账号 + `OPS_DESKTOP_PLATFORM_ENABLED=1`（重启 API）+ presence | **PASS** | API 开关 `enabled=true`、`v2.enabled=true`；presence 每 30s 一次、20 个连续样本 200；`last_seen_at=2026-11-23 11:30:52Z` | `00-connection.md`、`01-criterion1-presence.md`、`01-capabilities.json`、`01-presence.log`、`01-db-connection.txt` |
| 2 | 连续 3 次真实会话 TTL，写入 `sessionTtlObserved` | **未完成（1/3）** | 第 1 次 `2026-10-22 02:46:58Z` → `2026-11-23 09:50:08Z`，`32d7h3m10s`；`sessionTtlObserved` 仍 null；无持久化写入路径 | `02-criterion2-ttl.md`、`02-ttl-and-multipage-runs.txt`、`05-capabilities-db.txt` |
| 3 | 真浏览器 401 时序录屏（失效→提示→重登→恢复） | **PARTIAL** | 已录真实 401 登录页、用户可见“需要重新登录”提示、30 分钟录屏；缺成功重登与恢复采集；dev 构建“重登”入口未创建本地设置 view | `03-criterion3-401.md`、`00-platform-login-required.png`、`02-401-landing.png`、`02-401-relogin-recovery.mp4`、`02-contact-sheet.jpg` |
| 4 | 真实主页 ≥3 页、真实入库、stop_reason 不含 `page_repeated` | **PASS（历史真实运行，本轮未重跑）** | 11-19 daily collect `pages_read=3`、stop_reason=`budget`、`page_repeated` 未出现；batch accepted=10、rejected=0；10 条 `xhs_browser` 观测入库；39 条真实作品镜像 | `04-criterion4-multipage.md`、`04-multipage-run-receipt.txt`、`04-multipage-db.txt`、`04-multipage-operation.txt` |
| 5 | 能力快照刷新，unknown 保持 unknown | **FAIL** | `detectedAt=2026-10-22`、`browserVersion=Chrome/155`（实际 158）、`sessionTtlObserved=null`、三项能力仍 unknown；未用 mock 抬键 | `05-criterion5-capability.md`、`05-capabilities-db.txt`、`01-capabilities.json` |

## 真实连接

- 使用既有连接 `85b42915-3459-4d89-958e-fe0a47ce50fb`，未新建账号、未改密码。
- 账号/设备/外部键已核对；昵称、外部键值、token 未落证据。
- 另一连接 `90137936-c681-4047-ae7c-1870a9ea5d43` 的 availability 为 `identity_mismatch`，已排除。

## 已观测 TTL 次数与下次续跑

- **已观测：1/3。** 第 1 次区间 `32 天 7 小时 3 分 10 秒`；这是“上次成功验证→首次观测失效”，不是精确 TTL，且会话最后可用证据到 2026-11-19。
- **第 2 次起点**：必须在真实重登成功后记录 T0，不能在本次失效区间上续算。
- **下次续跑时间**：重登成功后立即补录 401 恢复段、刷新能力快照；TTL 第 2 次自然失效检查从 **2026-12-26 前后**开始每日巡检（按首段 32.3 天仅作排期参考，**不是 TTL 值**，实际以真实失效为准）。第 3 次同理，至少跨到下一次自然失效。

## 当前阻塞

1. **真实登录需要用户本人操作**：401 登录页已打开并录屏，但用户未完成扫码/短信验证码；登录窗口已过期。没有新会话就无法完成第 3 条后半段、第 5 条刷新及第 2 条后续样本。
2. **桌面“重登”入口在 dev 构建中不可用**：点击后跳到本机设置页且不创建本地设置 view（popup blocker 推断），只以主进程运行时诊断绕过，不能作为产品证据。已登记到 `docs/21`。
3. **`sessionTtlObserved` 无写入路径**：当前只有入参、没有观测后持久化；3 次样本齐备前保持 null，不先改代码造写入。

## 验证命令与结果

| 命令 | 结果 |
|---|---|
| `docker exec ops-dev-postgres-1 psql -U ops -d ops -c "select ... from platform_connection where id='85b42915-...'"` | 返回 `state=active`、`availability=login_required`、`failure_count=1`、`last_seen_at=2026-11-23 11:30:52Z` |
| 同上查 `platform_sync_run`（`4545c3b5...`、`5df84196...`） | 前者 failed/login_required；后者 partial/budget、`pages_read=3`、`has_more=true` |
| 同上查 `platform_metric_observation` | 3 页 run 10 行；`first_observed=last_observed=2026-11-19 09:13:50.44Z` |
| 同上查 `platform_work_mirror` | 39 行，更新时间 2026-10-27 01:37:10Z～01:47:17Z |
| `Select-String 00-api-server.err.log -Pattern 'route=/api/v1/desktop/platform/presence'` | 连续 20 条 200，间隔 30s（19:22:22～19:31:52） |
| `ffprobe 02-401-relogin-recovery.mp4` | h264、1920×1080、8fps、1800s、39,304,961 bytes |

本轮未改产品代码，未跑 Go/前端全量测试；结论只基于真实运行、DB 行、API 日志和既有录制，不用测试绿灯替代真实链路。

## 未验证 / 不冒充

- 未取得第 2、3 次 TTL；`sessionTtlObserved` 未写非 null。
- 未取得“重登成功→恢复采集”录屏；现有 mp4 只到 401 登录页。
- 未在本日重跑 3 页采集；第 4 条采用 11-19 真实历史运行。
- 能力快照未刷新；`supported` 旧值仍是 10-22 的，不是本轮结果。
- 未证明桌面“重登”产品入口可用；运行时诊断调用不算产品通过。

## 证据目录

`docs/42-evidence/RC-03/`；索引见 `README.md`。
