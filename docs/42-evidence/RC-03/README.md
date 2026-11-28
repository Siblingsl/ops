# RC-03 证据目录

主题：小红书真实登录、会话 TTL 与主页采集（2026-11-23 基线；**2026-11-28 主闭环已收口**）。

## 结论入口

- `10-2026-11-28-401-relogin-recovery.md`：**2026-11-28 最终收口报告**——真实 401 → 产品内重登 → ready → 继续采集，五条判定、录屏/截图对应、脱敏核查与边界。
- `10-2026-11-28-db-readonly-summary.md`：生产只读 API 投影（连接/操作/内容条目），明确不是 psql 直连。
- `RC-03-report.md`：2026-11-23 基线五条验收判定与当时阻塞。
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
| `03-criterion3-401.md` | 2026-11-23 基线：401 时序 PARTIAL 说明（2026-11-28 已由 `10-` 报告更新为 PASS） |
| `00-platform-login-required.png` | 用户可见“需要重新登录”卡片（已裁剪，无昵称） |
| `02-401-landing.png` | 真实 Chrome 401 登录页（地址含 redirectReason=401） |
| `02-401-relogin-recovery.mp4` | 30 分钟真实屏幕录制（含 401 页，不含成功恢复） |
| `02-contact-sheet.jpg` | 录制关键帧拼图 |
| `02-record-probe.txt` / `02-record.log` | 录制元数据与 ffmpeg 日志 |
| `04-criterion4-multipage.md` | 第 4 条：真实 3 页运行与入库 |
| `04-multipage-run-receipt.txt` | 3 页 run 的 accepted=10/rejected=0/counters |
| `04-multipage-db.txt` | 10 条观测、39 条作品镜像统计 |
| `04-multipage-operation.txt` | 同账号 account_sync 操作计数 |
| `05-criterion5-capability.md` | 2026-11-23 基线：能力快照未刷新（2026-11-27 已刷新，见 `06-` 记录） |
| `05-capabilities-db.txt` | 当前 capabilities JSON 原样 |
| `06-2026-11-27-prod-stage-update.md` | 2026-11-27 生产阶段更新（presence、Chrome/158 快照刷新、T0、派发修复上线） |
| `10-2026-11-28-401-relogin-recovery.md` | **2026-11-28 最终收口报告**（真实 401 重登恢复全时序与五条判定） |
| `10-2026-11-28-db-readonly-summary.md` | 生产只读 API 投影（连接/操作/内容条目） |
| `10-2026-11-28-401-relogin-recovery.mp4` | 117s 脱敏证据视频（产品 step1 动态段 + Chrome 登录页动态段 + 关键阶段静帧） |
| `10-01-401-status.png` | 401 故障态：等待重新登录 / 平台登录已失效 / 需要重新登录 |
| `10-02-relogin-entry.png` | 账号卡右上角「重登」入口 |
| `10-03-login-modal-step1.png` | 产品内「连接小红书」step1 官方登录弹窗 |
| `10-04-login-page-401.png` | 官方登录页，URL 可见 `redirectReason=401`，二维码整卡打码 |
| `10-05-creator-home.png` | 扫码后 creator 首页（作品卡整块打码，保留「全部 2」） |
| `10-06-step2-verify.png` | step2「确认连接此账号」头部（目标账号行打码） |
| `10-07-step3-verified.png` | step3「平台连接已验证」头部（目标账号行打码） |
| `10-08-ready-state.png` | 恢复 ready：平台账号可用 / 最近验证今天 17:45 / 继续同步 |
| `10-09-continue-sync.png` | 点「继续同步」后 toast「同步已继续」 |
| `10-10-final-partial.png` | 最终「部分完成 / 已结束」、作品指标完整、账号资料未知 |

## 脱敏

- 已删除含账号昵称的 `00-desktop-ui.png`、`00-platform-full.png`。
- 证据中不写账号昵称、外部键值、open_id、token、Cookie。
- 录制与截图只保留平台卡片和登录页；登录页未输入手机号/验证码。
- 2026-11-28 新证据：昵称/头像/平台账号数字/稳定编号/二维码/作品标题与外部 ID 均未展示或已打码；不含本机绝对用户名路径、服务器 IP。
- `10-2026-11-28-401-relogin-recovery.mp4` 为同会话脱敏剪辑：产品弹窗与 Chrome 登录页保留真实动态段，step2/step3/ready/继续/终态用同会话静帧补齐；原始连续录屏含 PII，不归档。
