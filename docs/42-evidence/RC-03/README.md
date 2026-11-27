# RC-03 证据目录

主题：小红书真实登录、会话 TTL 与主页采集（2026-11-23）。

## 结论入口

- `RC-03-report.md`：五条验收判定、已观测 TTL 次数、下次续跑时间、阻塞与验证命令。
- `00-connection.md`：真实连接/账号/设备/外部键核对（值已脱敏）。

## 分条证据

| 文件 | 用途 |
|---|---|
| `01-criterion1-presence.md` | 第 1 条：平台开关、presence 心跳、DB last_seen |
| `01-capabilities.json` | `/api/v1/desktop/capabilities` 原样响应 |
| `01-presence.log` | 20 个连续 presence 请求（每 30s、200） |
| `01-db-connection.txt` | 连接状态/availability/last_seen 的 DB 行 |
| `02-criterion2-ttl.md` | 第 2 条：TTL 1/3 与口径说明 |
| `02-ttl-and-multipage-runs.txt` | 失效 run 与 3 页 run 的原始行 |
| `03-criterion3-401.md` | 第 3 条：401 时序 PARTIAL 说明 |
| `00-platform-login-required.png` | 用户可见“需要重新登录”卡片（已裁剪，无昵称） |
| `02-401-landing.png` | 真实 Chrome 401 登录页（地址含 redirectReason=401） |
| `02-401-relogin-recovery.mp4` | 30 分钟真实屏幕录制（含 401 页，不含成功恢复） |
| `02-contact-sheet.jpg` | 录制关键帧拼图 |
| `02-record-probe.txt` / `02-record.log` | 录制元数据与 ffmpeg 日志 |
| `04-criterion4-multipage.md` | 第 4 条：真实 3 页运行与入库 |
| `04-multipage-run-receipt.txt` | 3 页 run 的 accepted=10/rejected=0/counters |
| `04-multipage-db.txt` | 10 条观测、39 条作品镜像统计 |
| `04-multipage-operation.txt` | 同账号 account_sync 操作计数 |
| `05-criterion5-capability.md` | 第 5 条：能力快照未刷新 |
| `05-capabilities-db.txt` | 当前 capabilities JSON 原样 |
| `06-2026-11-27-prod-stage-update.md` | 2026-11-27 生产阶段更新（presence、Chrome/158 快照刷新、T0、派发修复上线） |

## 脱敏

- 已删除含账号昵称的 `00-desktop-ui.png`、`00-platform-full.png`。
- 证据中不写账号昵称、外部键值、open_id、token、Cookie。
- 录制与截图只保留平台卡片和登录页；登录页未输入手机号/验证码。
