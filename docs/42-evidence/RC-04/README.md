# RC-04 证据：小红书正文、评论读取与评论拟稿闭环

状态：**主链五条 PASS；严格补充项全部 PASS**。日期：2026-11-23 执行（本地 UTC+8，实际部分操作跨到 11-24 凌晨）。2026-11-24 补做发布锁修复、真实失败/恢复 UI、自动 claim 复跑与日上限临时放宽/恢复。

## 验收对象

- 平台：小红书（xhs）
- 连接：`90137936-c681-4047-ae7c-1870a9ea5d43`
- OPS 账号：`6c320a1b-b6f1-4897-b39f-13b12e854271`（巡检号）
- 工作区：`4e2bd06c-210c-4840-9cfa-db2b36101083`
- 目标笔记：`6a7c6caf0000000005033660`「哪个更真实？」（本人已发布）
- 平台浏览器：Google Chrome `158.0.8127.36`

## 五条判定

| # | 验收条 | 结果 | 证据 |
|---|---|---|---|
| 1 | 抓到真实单篇详情 endpoint/页面契约并实现 `fetchNoteDetail` | **PASS** | `01-contract.md`；`platform-login.ts` 的 `resolveXhsNoteUrl/readXhsNoteDetail`；连接能力 `noteContent=supported` |
| 2 | 单篇正文进 `work_content`（`platform_work_mirror.body_text`）且 `content_state=complete` | **PASS** | `02-work-content.txt`（832 字）；`05-runs.txt` 的 content run `succeeded`；DB `content_state=complete` |
| 3 | 本人作品评论授权读取进 `comment_inbox`，昵称不落库 | **PASS** | `03-comment-inbox.txt`；2 条真实评论，`author_alias` 两行均为空；`author_alias`/`open_id`/token 未写证据 |
| 4 | 真实评论 → 拟稿 → 人工采用/拒绝并记录结果 | **PASS（采用路径）** | `04-draft-adoption.md`；草稿 29 码点、`category=question`、`reply_status=copied`；`04-comments-adopted.png` |
| 5 | 证据归档与文档台账同步 | **PASS** | 本目录；`docs/42`、`docs/08`、`docs/37 §8.2`、`docs/35`、`docs/21`、`docs/34` 已于 2026-11-24 更新（详见各文档 RC-04 段） |

## 严格补充判定（2026-11-24）

| # | 补充项 | 结果 | 证据 |
|---|---|---|---|
| S1 | 修掉发布循环 `publishInFlight` 泄漏与采集饿死 | **PASS** | `07-publish-lock-fix.md`；`PublishLoopLock` 5/5 单测；`pnpm test` 774 项 767 pass/7 skip/0 fail；运行时采集 claim 在发布 claim 后 3 秒发出 |
| S2 | 真实失败、恢复 UI | **PASS（本地服务不可达场景）** | `07-sync-failure.png`、`08-sync-recovered.png`；`08-sync-failure-recovery.md`；API 停止后 UI 显示“同步进度读取失败：请求失败（500）”，重启后消失 |
| S3 | 不靠临时绕过，真实自动采集 claim 到任务 | **PASS（claim 路由真实；预算闸门按用户授权临时放宽并已恢复）** | `10-auto-claim-success.md`；桌面真实 claim 4 次（10:18:20 / 10:20:20 / 10:21:20 / 10:22:20），profile/catalog/content/metrics 四个 run；操作最终 `partial/complete`（仅 profile 能力 `profile_capability_unverified`） |

## 关键数据

- `platform_connection.availability=ready`；`capabilities`: `noteContent/workList/perNoteMetrics=supported`，`followerTotal/noteImpressions=unknown`；`last_verified_at=2026-11-23T15:29:36.721301Z`。
- `platform_work_mirror`: `title=哪个更真实？`、`body_text` 长度 832、`content_state=complete`、`content_observed_at=2026-11-23T17:33:41.006Z`。
- `comment_inbox`: 2 行真实评论；`author_alias` 空；一条 `reply_status=copied/category=question/reply_draft` 29 字；`sent_manual_at` 空（没有声称外发）。
- `account_sync` 操作 `b8429d8a-3ee7-4fca-9e40-5a9648dd622b`：profile `partial/profile_capability_unverified`，catalog/content/metrics 均 `succeeded`，operation `partial/complete`。

## 本轮真实进展

- 登录链路：修复 profile slot 归属、`Page.windowOpen` 详情地址读取、详情读取后恢复 `note-manager`、`findOwnedConnection` 用 `is_holder` 判定；产品登录核对成功并刷新为 `ready`。
- 正文：`fetchNoteDetail` 只使用页面点击给出的 `/explore/` 地址，正文从 SSR `__INITIAL_STATE__` 读取；未构造 URL，未使用夹具。
- 评论：公开详情页直接导航不会稳定触发 `/comment/page`；产品从页面已渲染的 `.comment-item` DOM 读取真实评论，只取 `id/content/note_id`。真实 `/comment/page` 契约已另行抓取并登记；不读取头像/昵称/主页链接。
- 服务端修复：同一工作区同平台多连接时，`desktopIngestPlatformComment` 原按 `LIMIT 1` 任取活动连接导致 409；改为优先按 `result.ExternalAccountKey` 匹配连接，找不到匹配连接仍返回 409 而不是 404。`TestP04CommentIngestEndpoint` 通过。
- 拟稿：真实评论进入 `cx_comment_reply`，生成 29 码点、`question` 分类草稿；用户点击「复制草稿」采用，状态 `copied`；未点击「确认已人工发送」，不自动外发。

## 验证命令与结果

| 命令 | 结果 |
|---|---|
| `cd desktop; pnpm build` | EXIT=0（2026-11-24 发布锁修复后复跑） |
| `cd desktop; node --test test/publish-loop-lock.test.cjs` | 5/5 pass，0 fail，EXIT=0 |
| `cd desktop; pnpm test` | 774 tests：767 pass、7 skipped、0 fail，EXIT=0（63.9s） |
| `cd desktop; node --test test/platform-login-flow.test.cjs test/platform-xhs.test.cjs test/platform-collect.test.cjs` | 48/48 pass，0 fail，EXIT=0（2026-11-23） |
| `cd server; go test ./internal/app -run '^TestPlatformV2Content|^TestP04CommentIngestEndpoint|^TestPlatformSyncComment|^TestP04Comment' -count=1` | ok，8.928s，EXIT=0 |
| `cd server; go test ./internal/app -run '^TestPlatformV2Content\|^TestP04CommentIngestEndpoint$\|^TestPlatformBudget' -count=1` | ok，8.254s，EXIT=0（2026-11-24 恢复日上限后复跑） |
| `cd server; go vet ./internal/app` | EXIT=0 |

## 说明与边界

- 首轮为在单次本地验收窗口内跑完 account_sync 四个阶段，临时使用本地测试参数：`RunJobs` tick 30s、`platformDailyWindowStart=0`、临时放开日 run 上限；这些**未进入交付代码**，已恢复为 10 分钟、09 时窗口、日上限 3。2026-11-24 为补 S3 只临时放宽日 run 上限，完成后同样已恢复（见 `10-auto-claim-success.md`）。
- 桌面 claim 循环曾被发布循环的 `publishInFlight` 占用；起初验收时临时跳过发布领取。2026-11-24 已补 `PublishLoopLock` 与“锁占用 3 秒重试”，单测和运行时 claim 日志见 `07-publish-lock-fix.md`。09:00 窗口实测仍无 task（日预算，见 `09-claim-budget-blocker.md`）；用户明确授权临时放宽本地日上限后，10:18–10:22 桌面真实 claim 到 profile/catalog/content/metrics 四个 run，S3 闭环，见 `10-auto-claim-success.md`，随后已恢复日上限 3。
- 评论读取以页面已渲染 DOM 为主路径，`/comment/page` 只读监听为兜底；原因和契约差异已登记 `docs/21` §十七点六十九。
- 未自动外发；`sent_manual_at` 为空。未修改 `unknown` 为 `supported`；`followerTotal/noteImpressions` 仍为 unknown。
- 补充边界：未授权/无详情源/平台拒绝的 UI 可读提示与安全停止，现有原因码与定向单测覆盖；2026-11-24 补取了“本地 API 不可达”的真实失败/恢复 UI，但“平台拒绝/登录失效”场景仍未单独截取真实平台 UI。
- 证据不含平台昵称、open_id、xsec_token 或平台用户 key 明文；连接外部账号键在文档中统一写 `<redacted>`。

## 目录

- `01-contract.md`：详情/评论真实契约与页面路径。
- `02-work-content.txt`：真实正文（832 字）。
- `03-comment-inbox.txt`：真实评论与拟稿状态（无昵称列）。
- `04-draft-adoption.md`：拟稿/采用记录。
- `04-comments-adopted.png`：评论台账“已复制”截图。
- `05-runs.txt`：本轮 account_sync run 表（含 operation_stage / status / operation_id）。
- `06-verification.md`：命令与结果。
- `07-publish-lock-fix.md`：发布锁泄漏、采集饿死修复与运行时 claim 日志。
- `07-sync-failure.png`：停止本地 API 后的真实失败 UI。
- `08-sync-failure-recovery.md`：真实失败/恢复操作与边界。
- `08-sync-recovered.png`：API 重启后的恢复 UI。
- `09-claim-budget-blocker.md`：自动 claim 被日预算挡住的复核、命令与结论。
- `10-auto-claim-success.md`：临时放宽/恢复日上限的过程，四次真实 claim 与四个 run 的时间线、业务结果和边界。
- 台账同步：`docs/42` RC-04 行与段、`docs/08` RC-04 实施段、`docs/37` §8.2 T2-4/T2-6、`docs/35` CF-PS-04/07 与 CF-P2-CXEF-02/06、`docs/21` §十七点六十九、`docs/34` 对应卡片。
