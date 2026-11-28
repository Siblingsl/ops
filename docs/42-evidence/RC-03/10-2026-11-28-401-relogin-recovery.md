# RC-03 第 2 条实测：真实 401 → 产品内重登 → ready → 继续采集（2026-11-28）

> 结论：**PASS，RC-03 主闭环已收口（2026-11-28）**。本轮在已安装打包桌面端 OPS Desktop + 生产服务 `https://ops-api.88813888.xyz` + 真实小红书账号下，完整走通「真实 401/未登录 → UI 提示需要重新登录 → 产品内『重登』→ 真人扫码 → 连接恢复 ready → 继续完成真实采集并核对落库」。
>
> 第 5 条长周期 TTL 观察仍为 **1/3**，作为跨月顺延附项保留，不阻塞主闭环；本次人工制造的 401 **不计入自然 TTL**。

## 1. 环境与基线

| 项 | 值 |
|---|---|
| 生产 API | `https://ops-api.88813888.xyz` |
| 生产代码 | 提交 `18f13ba9`，运行镜像 `887ff05b25e7` |
| 平台开关 | `OPS_DESKTOP_PLATFORM_ENABLED=1`；`OPS_DESKTOP_PLATFORM_AUTO_ADOPT` 保持关闭 |
| 桌面端 | 已安装打包版 `OPS Desktop` v0.1.0（Electron 44.9.1，2026-11-28 01:47 构建） |
| 真实连接 | `85ec702c-a627-45db-adb0-8fa9f19dae8f`（`platform=xhs`） |
| 绑定设备 | `39db7e12-c551-4516-82cd-fa6635c875ca` |
| 操作 | `ca4619c3-8627-4344-a67b-fdeab2c0e52d`（`account_sync`） |
| 当日配额 | 3 次/主体；本轮依次使用第 1/3、2/3、3/3 次 |

## 2. 真实 401 制造方式（未改生产库）

1. 先确认本机无 OPS/Chrome 进程占用目标平台 profile，并对该连接对应的独立平台浏览器 profile 做**仅平台 profile** 的全量应急备份；未触碰 OPS 登录态与用户既有数据。
2. 只读确认该 profile 的 `Cookies` 中确有 `xiaohongshu.com` 站点 Cookie（15 条）。
3. 仅清理该平台 profile 内的站点存储：`Default\Network\Cookies`、`Cookies-journal`、`Default\Cookies*`、`Default\Local Storage`、`Default\Session Storage` 及小红书 IndexedDB。
4. 清理后 Cookie DB 不存在；Chrome 启动后真实跳转：
   `https://creator.xiaohongshu.com/login?source=&redirectReason=401&lastUrl=%2Fnew%2Fnote-manager`
5. **未直接修改生产数据库、未伪造 `state=401` 或 `login_required` 行**；401 由平台浏览器真实会话失效产生。

> 备份目录含本机用户名与旧 Cookie，属敏感临时物，未写入证据、未纳入仓库；仅在本次操作窗口内短期保留。

## 3. 端到端时序（2026-11-28，UTC+8）

| 阶段 | 实测 |
|---|---|
| T0 前 | 连接 `availability=ready`、`last_verified_at=2026-11-27T08:18:16Z`（昨日重登起点） |
| 制造 401 | 清理平台 profile 站点存储后，Chrome 真实落到 `redirectReason=401` 登录页 |
| 第 1/3 次运行 | 约 17:25 桌面端 30s presence + claim 领到 `account_sync`；`[platform-auto] 完成 {"runStatus":"failed","errorCode":"platform_login_required"}`；消耗第 1/3 次 |
| UI 提示 | 账号同步进度显示「等待重新登录」；「平台登录已失效 请重新登录并核对这个平台账号」「需要重新登录」「连续失败 1 次」；账号卡右上角「重登」可用 |
| 进入重登 | 点「重登」→ 业务页跳 `/settings/local/account-device`，本地设置 `WebContentsView` 弹出「连接小红书」三步弹窗 |
| 步骤 1 官方登录 | 点「打开专用登录窗口」→ Electron 启动独立 Chrome 打开 creator 登录页；地址栏保留 `redirectReason=401` |
| 真人扫码 | 用户在登录窗内现场扫码；登录后页面自动跳到 `creator.xiaohongshu.com/new/note-manager`（全部 2 篇） |
| 步骤 2 核对账号 | 回到弹窗点「我已完成登录，核对账号」→ 显示平台账号、稳定编号与目标 OPS 账号一致；点「确认连接此账号」 |
| 步骤 3 验证 | 显示「平台连接已验证」：平台登录已核对 / OPS 连接已收到服务端验证回执 / 作品数据权限待验证 / 自动读取关闭、自动采用关闭；点「完成」 |
| 恢复 ready | 连接卡「可用」；最近验证「今天 17:45」；API `last_verified_at=2026-11-28T17:45:39.228103+08:00`、`availability=ready`、`failure_count=0` |
| 继续采集（第 2/3 次） | 在「账号同步进度」点「继续同步」→ 操作由「等待重新登录」转「进行中」；`runStatus:succeeded, accepted:1, rejected:0`；1 条作品正文 `content_observed_at=2026-11-28T17:48:41+08:00` |
| 第 3/3 次 | 自动继续 `runStatus:succeeded, accepted:0`；日志 `follower total unavailable platform_capability_denied: 该签名接口没有登记触发页面` |
| 操作终态 | `status=partial`、`stage=complete`、`revision=17`；`counters.content_received=2`、`metrics_observed=2`、`pending_confirmation=2`、`failed=1`；coverage `catalog/content/metrics=complete`、`profile=unknown` |

### 3.1 三次运行日志（原文摘录，已脱敏）

```text
# 第 1/3 次
[platform-auto] 领到任务 {"platform":"xhs","taskKind":"account_sync"}
[platform-auto] 完成 {"runStatus":"failed","accepted":0,"rejected":0,"errorCode":"platform_login_required","adoptErrors":0,"adoptReason":null}

# 第 2/3 次
[platform-auto] 领到任务 {"platform":"xhs","taskKind":"account_sync"}
[platform-auto] 完成 {"runStatus":"succeeded","accepted":1,"rejected":0,"errorCode":null,"adoptErrors":0,"adoptReason":null}

# 第 3/3 次
[platform-auto] 领到任务 {"platform":"xhs","taskKind":"account_sync"}
[collect-v2] follower total unavailable platform_capability_denied: 该签名接口没有登记触发页面
[platform-auto] 完成 {"runStatus":"succeeded","accepted":0,"rejected":0,"errorCode":null,"adoptErrors":0,"adoptReason":null}
```

## 4. 生产只读 API 投影核对

> **边界**：本机没有生产库 `psql`/SSH 直连条件，本轮 DB 核对为**生产只读 API 投影**（`GET /platform-connection`、`GET /platform-sync-operations`、`GET /platform-sync-operations/{id}/items`），不是 `psql` 直连查询。完整 JSON 见 `10-2026-11-28-db-readonly-summary.md`。

- 连接：`availability=ready`、`state=active`、`failure_count=0`、`last_verified_at=2026-11-28T17:45:39.228103+08:00`、`last_seen_at=2026-11-28T18:38:28.850073+08:00`、`auto_collect=false`、`auto_adopt=false`。
- 操作：`status=partial`、`stage=complete`、`revision=17`；`created_at=2026-11-27T08:18:38.358819Z`、`expires_at=2026-12-05T17:48:24.632588+08:00`；`last_error.code=platform_login_required`。
- 计数：`content_received=2`、`created=2`、`discovered=2`、`metrics_observed=2`、`pending_confirmation=2`、`failed=1`，其余为 0。
- coverage：`catalog/content/metrics` 均 `state=complete`；`profile` 为 `state=unknown` / `reason=profile_capability_unverified`。
- items：2 条 content item 均 `content_state=complete`、`error_code=null`；其中 1 条 `content_observed_at=2026-11-28T17:48:41.027+08:00`（今日第 2/3 次运行，`source_run_id=c1410f31-26bc-4240-b297-cafe3269f613`），另 1 条为 `2026-11-27T16:47:56.596+08:00`（昨日运行）。

## 5. 五条判定

| 条款 | 判定 | 说明 |
|---|---|---|
| 1. presence 心跳可见 | **保持 PASS** | 2026-11-27 已实测；本轮桌面端全程 30s presence，恢复后 `last_seen_at` 继续推进 |
| 2. 401 重登恢复闭环 | **PASS（2026-11-28）** | 真实 401 → UI 可读提示 → 产品内「重登」→ 真人扫码 → step2/step3 核验 → `availability=ready` → 继续完成 1 次真实采集并落库 |
| 3. 主页 ≥3 页且无 `page_repeated` | **沿用 2026-11-19 真实 PASS** | 当前生产号仅 2 篇作品，无法在本轮产生 3 页；沿用 `5df84196-8894-44c6-a05d-3cd4ad32b497`（`pages_read=3`、`stop_reason=budget`、无 `page_repeated`、10 条观测/39 条镜像） |
| 4. 能力快照如实刷新 | **保持 PASS** | 2026-11-27 已刷新为 `Chrome/158.0.8127.38`，`workList/perNoteMetrics/noteContent=supported`，`followerTotal/noteImpressions=unknown`，`sessionTtlObserved=null` |
| 5. 长周期 TTL 观察附项 | **1/3 保持（不阻塞）** | 本次为人工制造 401，**不计入自然 TTL**；重登成功后按实际 `last_verified_at` 将新起点 T0 更新为 `2026-11-28T17:45:39+08:00` |

**总判定：RC-03 已闭环（2026-11-28；第 5 条长周期 TTL 观察 1/3 保持跨月顺延附项）。**

## 6. 证据与脱敏

### 6.1 正式证据视频

- 文件：`docs/42-evidence/RC-03/10-2026-11-28-401-relogin-recovery.mp4`
- 规格：H.264，1536×816，25fps，117 秒，4,681,204 bytes
- SHA-256：`70CAA0E9C2144284EB57A6F286A6689271466C6FC05351723E7174828B9BEF56`
- 结构：
  - 0–6s 标题卡；
  - 6–14s 401 故障态静帧；
  - 14–20s 重登入口静帧；
  - 20–50s 产品内「连接小红书」step1 真实动态段（昵称/目标账号行已打码）；
  - 50–74s Chrome 官方登录页真实动态段（地址栏保留 `redirectReason=401`，二维码整卡黑块）；
  - 74–80s 扫码后 creator 首页静帧（作品卡整块黑块，保留「全部 2」）；
  - 80–86s step2 核对账号静帧（裁剪至标题/步骤条，目标账号行打码）；
  - 86–92s step3 平台连接已验证静帧（同上）；
  - 92–98s 恢复 ready 静帧；
  - 98–103s 继续同步静帧（toast「同步已继续」）；
  - 103–109s 最终 partial/已结束静帧；
  - 109–117s 结论卡。

> **如实说明**：原始连续录屏在 90–108s 切到其他桌面应用、110–120s Chrome 前台露出头像/昵称，且 OPS 弹窗阶段窗口位置漂移导致固定打码框漏昵称；原始连续录屏**含 PII，不能直接归档**。因此正式视频采用「同一会话脱敏剪辑」：产品弹窗与 Chrome 登录页保留真实动态段，step2/step3/ready/继续/终态用同会话静帧补齐，不冒充单镜到底连续录屏。

### 6.2 关键截图

| 文件 | 内容 |
|---|---|
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

### 6.3 脱敏核查

- 不出现小红书昵称、头像可识别信息、手机号、扫码二维码全图、Cookie/Token、明文密码；
- 不出现本机绝对用户名路径、服务器 IP；
- 平台账号数字、稳定编号、作品标题/外部 ID 在证据中均未展示或已打码；
- 旧证据 `00-platform-login-required.png`、`02-401-landing.png`、`02-401-relogin-recovery.mp4` 等未删除、未修改；本轮新证据统一 `10-` 前缀。

## 7. 已知边界与文案残留

1. **UI「最近状态」残留旧登录失效文案**：操作记录的 `last_error.code` 仍为 `platform_login_required`，因此恢复成功后 UI 的「最近状态」可能继续显示旧的登录失效提示。判定以 `status=partial`、`stage=complete`、`availability=ready`、`last_verified_at` 更新、`failure_count=0` 与今日真实采集为准；这是历史留痕，不是当前故障。
2. **操作终态为 `partial` 而非 `succeeded`**：`profile` 能力仍未核验（`profile_capability_unverified`），账号资料显示「未知」；`catalog/content/metrics` 均 `complete`，主采集链已完成。`partial` 不等于 401 未恢复。
3. **未直连生产 psql**：本机无 SSH 私钥，云主机无 `psql`/key；DB 核对为生产只读 API 投影，报告不宣称“psql 直连核对”。
4. **第 3 条沿用历史 3 页证据**：生产号当前仅 2 篇作品，本轮无法真实产生第 3 页；不伪造翻页。
5. **长周期 TTL 仍 1/3**：本次为人工 401，不计入自然 TTL；自然失效样本数保持 1/3，`sessionTtlObserved` 不写估算值。

## 8. 收口与同步

- RC-03 主闭环收口：第 1、2、4 条 PASS；第 3 条沿用 2026-11-19 真实 3 页 PASS；第 5 条 1/3 附项跨月顺延。
- 同步文件：`docs/42-真实闭环验收总台账.md`（§1 总表 10/13、RC-03 卡片与本节闭环记录、§6 变更记录）、`docs/08-开发与测试计划.md`、`docs/35-未完成功能收口清单与完成度.md`（CF-PS-01/03/05）、`docs/43-桌面端主攻与全局优化实施方案.md`（第 0.1 节闭环率 10 项）。
- `docs/20`、`docs/21`、`docs/37` 当前不在仓库工作区，未强改不存在路径；以本报告与 `docs/42` 为准。
