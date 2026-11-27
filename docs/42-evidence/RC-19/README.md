# RC-19 账号观测、截图/人工录入、复盘与账号记忆闭环

> 状态：**本机 dev 环境端到端实测完成（2026-11-27）；项 3、4、5 PASS，项 1、2 PARTIAL。存在 1 个未修复的 OPT-U05 数字解析缺陷与 2 处口径边界，本次不作为正式闭环。**

## 环境与前置

- 本轮为**本机 dev-only**：dev 库 `ops@127.0.0.1:5440`（Docker `ops-dev-postgres-1`），后端由源码 `go build ./cmd/ops` 生成并监听 `:8080`；生产 `https://ops-api.88813888.xyz` 未被访问或写入。
- 前端为唯一前端 `renderer` 的 Vite 6.4.5 开发态 `:5173`（代理 `/api`→`:8080`）；桌面形态为真实 Electron 44.9.1 窗口，`dataset.presentation=ops-creative-desktop`，CDP `:19310`，窗口标题「OPS Desktop — 未登录 · 服务器 AI」。
- 工作区「inspect-1792313152138 的工作区」（`4e2bd06c-...`），owner `71a6b917-...`；测试账号：小红书验收号 `05dfeb67-...`、小红书巡检号 `6c320a1b-...`、公众号「周末读书会（测试）」`bf07850c-...`。
- 后端环境：`OPS_DEV=1`、`OPS_DESKTOP_PLATFORM_ENABLED=1`、`OPS_DESKTOP_PLATFORM_AUTO_ADOPT=0`、`OPS_COOKIE_SECURE=0`、`NO_PROXY=127.0.0.1,localhost,::1`；因真实复盘首 token 超过默认 15s，追加 `OPS_FIRST_TOKEN_TIMEOUT=120s`（环境调参，不是代码修复）。
- AI 通道：真实本机网关 `http://127.0.0.1:3425/v1` 的 WorkBuddy Hy4（`workbuddy-ai/hy4flash-free`）与 OpenCode DeepSeek（`opencode-zen-free/deepseek-v4.1-flash-free`）；`default`、`metric_screenshot`、`tier_economy`、`agent_chat` 指向 WorkBuddy，`review_analysis` / `outline` / `title` 未单配、回落 `default`。本批 RC-19 AI 调用均命中 `:3425`，未使用 `:8091` 模拟模型。
- 登录走真实 `/auth/login` 页面。dev owner 原密码未知且既有会话已过期，收尾时已用临时散列进入；**业务源码零改动**，原 `password_hash` 已写回并与备份逐字符比对一致，临时密码再登录返回 401，临时密码、原散列备份、Electron userData 与辅助脚本均已删除。

## 通过标准逐项结果

| # | 通过标准 | 实测结果 | 关键证据 |
| --- | --- | --- | --- |
| 1 | 多源真实数据进入统一投影（观测逐条确认、截图识别、CSV 录入、粉丝记录） | **PARTIAL**：4 条真实路径均跑通并落库——① 小红书观测 `12a1aad4...` 逐条确认→`valid/bound`，生成 `227ea0ff...`（`xhs_browser`，day76，2026-11-19，likes27/fav30/com0/share2，reads NULL）；② 公众号观测 `14316a35...` 确认→`e93d62bd...`（`wechat_browser`，day106，read_times 1 但 reads NULL）；③ 真实小红书截图 `89/0/3/2/0` 经 OCR→人工修正→`metric_upload 359c3b97...`→`d4295181...`（`screenshot`，day2，reads89/likes3/fav2/com0/share0）；④ 公众号 CSV `3754_1`→`2d9c4419...`（`file`，day103，reads1/likes0/share0）。**边界**：OCR 的 5 个数字全部被 `shotNormalizer` 丢弃（详见披露 1），靠人工修正完成；粉丝两平台均「未采集/覆盖 0/2」，因无真实来源未补录、未造 0，该子项 PARTIAL。 | `03`–`06`、`08`–`16`、`18`、`local-db-verification.json` |
| 2 | 复盘看板与库一致、节点/口径透明 | **PARTIAL**：19 行页面 vs DB 核对全部一致；巡检号看板显示「工位上的松弛感」阅读 89/收藏 2/分享 0/记录方式「截图识别」；验收号 10 篇历史快照按 d7 取 day48 的 29（非 day76 的 30）；公众号 3754 阅读 1、3759 阅读 100（3759 为历史 manual 行）。**边界**：桌面看板表头固定「第7天」但实际节点为 day2/31–59/103/106，未显示「按第 N 天」，透明度不足；T1/T3/T7/T30 全部「没有可用正式指标」（`read_unit=unknown` 不计入统计）；同龄对比第7天「未采集」，第30天「非精确节点/样本 5 篇」但指标均未采集。 | `19`–`24`、`38`、`local-db-verification.json` |
| 3 | 安全采用与逐条确认红线 | **PASS**：三张平台连接卡的「自动采用（写入正式指标）」均固定未开启并提示「待每平台 10 篇以上逐字段正式验收完成后开放」；待确认观测、截图核对、写作结论、选题建议全部只有逐条按钮；页面「全部」类按钮计数 0；后端仅单条 confirm/remember/adopt 路由，无批量路由；`AUTO_ADOPT=0` 由启动脚本设置且无 `system_setting` 覆盖。 | `03`、`05`、`26`、`27`、`31`、`31b`、`32` |
| 4 | 复盘→记忆→创作正循环 | **PASS**：真实 `review_analysis` 生成 `review_report 9fc997e7...`（`analysis_v2` 5 个键、4 条 `writing_insights`）；「记住」生成 `account_memory 0a167d6f...`（wording/all/active/review）；`injection-preview` 1 条 / 59 字 / 0 丢弃；新作品 `f49abc33...` 大纲 6 项确认后，`outline`（458/1012 tokens，10.3s）与 `title`（766/2035 tokens，14.8s）均带 `context_refs` 记忆槽 `used=true`，`use_count` 0→1→2；`ai_call` 6 条凭证齐全（含 2 次 15s 首 token 超时失败，见披露 2）。 | `25`、`25b`、`26`–`30`、`local-db-verification.json` |
| 5 | 异常可读提示与零污染 | **PASS**：9 个非法用例（坏图/坏表头/负值/坏日期/空表 × 指标与粉丝）均得到可读错误；坏日期在预览阶段未标红、确认时服务端拒绝（已如实记录）；异常前后 `metric_snapshot` 25/25、`account_metric_daily` 30/0、`metric_upload` 1/1，工作区快照/上传哈希完全一致（`ea1da80a...` / `3019b2b6...`）。 | `33`–`37`、`local-db-verification.json` |

## 证据清单

| 文件 | 说明 | 字节 | 尺寸 / SHA-256 前缀 |
| --- | --- | --- | --- |
| `01-desktop-login-dashboard.png` | 登录后工作台：真实 `/auth/login` 进入工作区，顶部账号与工作区上下文 | 153,747 | 1803×1020；`b96998cbe24d0ac6` |
| `02-settings-accounts-list.png` | 设置 → 平台账号与凭证：小红书验收号、巡检号与公众号三张连接卡 | 94,160 | 1803×1020；`decb68ef7b31c509` |
| `03-settings-xhs-pending-observations.png` | 验收号设置页：自动采用固定未开启；最近观测逐条「确认这一条」 | 123,515 | 1803×1020；`eea7ca6a4fd3af9a` |
| `04-settings-xhs-observation-confirmed.png` | 点击「确认这一条」后 toast「已确认这一条观测」 | 99,910 | 1803×1020；`33fadfdeb5e3d3b4` |
| `05-settings-wechat-pending-observations.png` | 公众号设置页：待确认观测逐条「确认这一条」 | 126,828 | 1803×1020；`e04dc0d6b2cfd51d` |
| `06-settings-wechat-observation-confirmed.png` | 公众号确认观测后的 toast「已确认这一条观测」 | 139,406 | 1803×1020；`01a4c6fe571ce982` |
| `07-review-xhs-screenshot-dropzone.png` | 巡检号复盘页：`review-screenshot-dropzone` 截图拖拽区 | 112,733 | 1803×1020；`b042d53827d1574b` |
| `08-review-screenshot-recognized-dialog.png` | 真实截图 OCR 结果弹窗：标题匹配正确、数字识别结果与人工修正入口 | 218,097 | 1803×1020；`329c66caa1c59039` |
| `09-review-screenshot-values-corrected.png` | 人工修正 89 / 3 / 2 / 0 / 0 后的核对弹窗 | 220,361 | 1803×1020；`b3cc82d2adaf98e5` |
| `10-review-screenshot-row-imported.png` | 「导入这一行」成功 toast 与导入后的指标行 | 219,093 | 1803×1020；`d8dad86a74245efb` |
| `11-review-screenshot-metric-drawer.png` | 指标数据抽屉：截图导入行（来源、采集时间、阅读 89） | 173,090 | 1803×1020；`1cc28ab1cf8aace4` |
| `12-review-screenshot-captured-at-corrected.png` | 把采集时间改为截图真实回读时刻 2026-11-26 13:23 | 165,401 | 1803×1020；`bac3315c467c2589` |
| `13-review-screenshot-metric-saved.png` | 保存后看板：`工位上的松弛感` 阅读 89、收藏 2、分享 0、记录方式「截图识别」 | 164,621 | 1803×1020；`c5d0a44c8ba6b171` |
| `14-review-wechat-advanced-expanded.png` | 公众号复盘页高级面板展开（「导入表格（CSV）」入口） | 110,964 | 1803×1020；`27a086c791be747f` |
| `14b-review-wechat-before-csv-import.png` | CSV 导入前的公众号复盘页基线 | 103,881 | 1803×1020；`1edb8c8f8ff39c6c` |
| `15-review-wechat-csv-preview.png` | 公众号 CSV 预览：标题「公众号采集验证 2247483754_1」已精确匹配 | 196,055 | 1803×1020；`82105f1b3eb2a672` |
| `16-review-wechat-csv-imported.png` | 确认导入后 toast「已导入 1 行」与 3754 行数据 | 112,080 | 1803×1020；`cd5fe1822570c769` |
| `17-review-wechat-followers-backfill-form.png` | 粉丝记录「补录一天」表单已展开（未写入，无真实来源） | 99,175 | 1803×1020；`248650e9ffa90f2d` |
| `18-review-wechat-followers-empty.png` | 粉丝卡空态：两平台均「未采集」、合计「—」、覆盖 0 / 2 | 102,104 | 1803×1020；`289bf05d595fd74a` |
| `19-review-xhs-inspection-board-89.png` | 巡检号看板：`工位上的松弛感` 阅读 89、收藏 2、分享 0，记录方式「截图识别」 | 113,169 | 1803×1020；`45ab75dac5adb5f9` |
| `20-review-xhs-inspection-advanced.png` | 巡检号高级面板：T1/T3/T7/T30 均「没有可用正式指标」 | 104,722 | 1803×1020；`b2ce750cffaf9d12` |
| `21-review-xhs-verification-board.png` | 验收号看板：10 篇历史快照的阅读/点赞与「小红书后台口径不明（未计入统计）」 | 112,471 | 1803×1020；`991b6d40d7318723` |
| `22-review-xhs-verification-advanced.png` | 验收号高级面板：多时点视图与 d7 选择结果 | 108,038 | 1803×1020；`96699b707d9c2287` |
| `23-review-xhs-peer-compare.png` | 同龄对比第 7 天：「第 7 天节点未采集」 | 171,980 | 1803×1020；`7d89ea260c8e289a` |
| `24-review-xhs-peer-compare-30.png` | 同龄对比第 30 天：非精确节点、样本 5 篇、指标均未采集 | 171,443 | 1803×1020；`4675670c856938f6` |
| `25-review-real-report-generated.png` | 真实 AI 复盘报告生成完成：4 条写作结论、5 条结论、实验与限制 | 282,933 | 1803×1020；`6c07f186257720c4` |
| `25b-review-real-report-v2-evidence.png` | 报告 v2 证据区：数据窗口、缺失原因与来源修订入口 | 355,475 | 1803×1020；`c2cba8a816b054fe` |
| `26-review-report-insights-remember-buttons.png` | 写作结论逐条「记住 / 忽略」按钮 | 169,265 | 1803×1020；`2b1fd0609a71b201` |
| `27-review-insight-remembered.png` | 第 1 条写作结论点击「记住」后的「已记住」状态 | 172,963 | 1803×1020；`373c6172870c612f` |
| `28-work-outline-with-memory-basis.png` | 新作品大纲已生成 6 项；「本次参考：定位档案、AI 记忆 1 条、创作依据 2 项」 | 262,360 | 1803×1020；`8e4b889670c15571` |
| `29-work-ai-basis-memory-detail.png` | 创作依据详情：`confirmed_memory · 0a167d6f…` 与 59 字记忆全文 | 293,944 | 1803×1020；`8db1304dc06d6bb4` |
| `30-work-title-candidates-real.png` | 标题候选真实生成；「本次参考：AI 记忆 1 条、创作依据 8 项」 | 139,927 | 1803×1020；`4ffdbfa81a81d6b5` |
| `31-settings-auto-adopt-disabled.png` | 设置页：自动采集已开启、自动采用固定未开启并提示验收门槛 | 111,951 | 1803×1020；`57cbe56ad0c6816d` |
| `31b-settings-pending-observations-per-item.png` | 待确认观测区仅有逐条「确认这一条」，无批量按钮 | 112,761 | 1803×1020；`1271acf358ab6c82` |
| `32-review-topic-suggestions-per-item.png` | 写作结论已记住 1 条；其余逐条「记住/忽略」；选题建议逐条「采纳」 | 169,404 | 1803×1020；`91f6054d28306a63` |
| `33-anomaly-bad-image-error.png` | 异常：坏 PNG →「第 1 张不是可识别的图片（支持 PNG、JPEG）」 | 123,123 | 1803×1020；`b825c2b87d8acfd7` |
| `34-anomaly-metrics-csv-bad-header.png` | 异常：指标 CSV 非法表头 →「CSV 需要「标题」列以便匹配作品」 | 276,106 | 1803×1020；`fae5a60858e160b7` |
| `34-anomaly-metrics-csv-negative.png` | 异常：指标 CSV 负值 → 预览行级「「reads」列无法解析：-5」并跳过 | 422,685 | 1803×1020；`b1526101519ea64f` |
| `35a-anomaly-metrics-csv-bad-date-preview.png` | 异常：指标 CSV 坏日期 → 预览阶段未标红（如实记录 UI 缺口） | 422,949 | 1803×1020；`7140a79d4ad05a58` |
| `35b-anomaly-metrics-csv-bad-date-confirm-rejected.png` | 异常：坏日期点确认后服务端拒绝「第 1 行的采集时间格式无效」 | 414,585 | 1803×1020；`38a0f986b1bafef9` |
| `36-anomaly-metrics-csv-empty.png` | 异常：空指标 CSV →「CSV 无法解析或没有数据行」 | 276,277 | 1803×1020；`8e175e00ee65e4ef` |
| `37-anomaly-followers-csv-bad-date.png` | 异常：粉丝 CSV 坏日期 →「CSV 第 2 行日期格式应为 2026-10-01」 | 130,278 | 1803×1020；`86c7c8ac09fdf090` |
| `37-anomaly-followers-csv-bad-header.png` | 异常：粉丝 CSV 非法表头 →「CSV 第 1 行日期格式应为 2026-10-01」 | 128,761 | 1803×1020；`0129f8ac6d7f906d` |
| `37-anomaly-followers-csv-empty.png` | 异常：空粉丝 CSV →「CSV 不能为空」 | 127,794 | 1803×1020；`32bea6236e666a1e` |
| `37-anomaly-followers-csv-negative.png` | 异常：粉丝 CSV 负值 →「CSV 第 2 行粉丝数必须是非负整数」 | 129,599 | 1803×1020；`6a9d838eef7acc3e` |
| `38-review-wechat-board.png` | 公众号看板：3754 阅读 1 / 分享 0（本批 CSV），3759 阅读 100（历史 manual 行），其余「—」 | 103,759 | 1803×1020；`70695aa4f7d11337` |
| `local-db-verification.json` | dev 库只读核验：环境/进程/路由、基线、4 条新快照、2 条确认观测、上传、报告、记忆、injection、6 条 ai_call、19 行页面 vs DB、46 个证据文件哈希、11 条披露 | 132,172 | 合法 JSON；`555b5946` |

## 边界与如实披露

1. **OPT-U05 数字解析缺陷（未修）**：`shotNormalizer` 先删空格再取数，`12:33 89 0 3 2 0` 被拼成 `2026-11-2412:33890320`，`rawNumbers` 仅剩 `33890320`，5 个数字全部 `dropped`；本轮用人工修正完成导入，业务代码未改。
2. **复盘首 token 超时**：`review_analysis` 默认首 token 超时 15s，真实复盘需 77.9s，前两次真实调用 `failed`；通过 `OPS_FIRST_TOKEN_TIMEOUT=120s` 重启解决（环境调参，非代码修复）。
3. **小红书历史快照节点**：既有快照为发布后 31–59 天，不是 24h/7d；本次真实截图回读为 48h50m，导入后落 day2，不进入 T1/T3/T7/T30 窗口。
4. **阅读/观看口径**：小红书观看、公众号阅读 `read_unit=unknown`，只存观测不计入正式统计；页面「口径不明」行为正确，但桌面看板表头「第7天」与真实节点不符且无「按第 N 天」提示。
5. **d7 节点选择**：看板 d7 对 09-04 取 day48（29），不取 11-19 day76（30）；两行均在库。
6. **公众号历史行**：3759 的 100/10 是 2026-10-21 人工历史行，不是本批写入。
7. **粉丝记录**：无可核实真实来源，未补录、未伪造 0，子项 PARTIAL。
8. **跨工作区写入**：另一工作区 `4bba819e...` 于 10:01 由 `wechat_api` 写入 3 行 `account_metric_daily`（全局 27→30），非本任务写操作；本工作区该表始终 0 行。
9. **观测字段路径**：`field_paths` 为 `fixture.note.*` / `fixture.article.*`，是 RulePack 既有命名字段路径，不是 mock 夹具。
10. **环境离线**：18:55–19:09 本机环境离线；离线期间无任何写入，恢复后复核三表行数与哈希完全未变。
11. **登录散列收尾**：使用临时密码散列（原散列先备份），2026-11-27 19:23 +08:00 已将原散列写回 dev 库并经逐字符比对一致，临时密码再登录返回 401；临时密码、原散列备份、Electron userData（含会话 cookie）与辅助脚本均已删除，业务源码零改动。

## 脱敏核验

- 46 张截图均为本次真实 Electron 页面，仅含页面 UI、账号昵称、平台公开数据与库内脱敏 ID；不含密码、cookie、API Key、数据库连接串、真实姓名/手机号/邮箱。
- `local-db-verification.json` 全文已检索 Windows 用户目录、仓库绝对路径与临时目录环境变量字面，命中 0；`evidence_dir` 已改为 `docs/42-evidence/RC-19`，启动脚本文本中的仓库与临时目录已替换为 `<repo>` / `<tmp>` 占位。
- 临时密码、原散列备份、登录 cookie 与全部辅助脚本位于本机临时目录，已在收尾时删除；仓库内不保留任何临时凭据。

## 最终判定

**RC-19 五项实测完成：项 3、4、5 PASS，项 1、2 PARTIAL。由于 OPT-U05 数字解析缺陷未修复、粉丝记录无真实来源、桌面看板节点标签不透明，本次不判定为正式闭环；证据可作为修复与复验基线。**

---

## fix-verify（2026-11-27）：RC-19 三项缺陷修复与定点复验

> 本节是在既有 46 张基线证据之后的追加章节，不覆盖、不重排原章节，也不改变原「最终判定」。新证据统一位于 `fix-verify/`；原 46 张基线 PNG、`local-db-verification.json` 均未改动。

### 修复与单测

- **任务 1（P1，截图数字空格粘连）**：`server/internal/app/metric_screenshot.go` 新增 token 正则 `shotNumberTokenRe`，`rawNumbers` / `rawNumbers64` 先对原始 `raw_text` 分词，再仅对每个独立 token 调用 `shotNormalizer.Replace`；`shotValue` / `shotValue64` 的单值归一化保持不变。`TestDR05NumberFaithfulness` 已扩展覆盖 RC-19 两条真实 `raw_text`、空格列、千分位、非千分位逗号、`1.2 w` / `3 万` / `10万+` / `1.2\u00a0万`、`9007199254740993` int64，以及 `999/88/890320` 不得凭空命中。
- **任务 2（P2，桌面看板节点透明）**：`renderer/pages/Review.tsx` 新增 `reviewNodeNote`、`hasNonSevenNode`，桌面 `RecordCell` 对非第 7 天/未知节点逐行标注；`renderer/styles/desktop-creative.css` 新增节点样式。全 `day_offset=7` 时仍使用 `作品数据 · 发布后第 7 天`，不插入节点 span、不增加 class、不预留额外 padding；存在非第 7 天节点时标题切换为 `作品数据 · 默认第 7 天（缺第 7 天按实采节点）` 并保持单行。新增 `renderer/tests/review-node-transparency.test.mjs` 4 条源码契约测试。
- **任务 3（P2，指标预览坏日期）**：`server/internal/app/metrics_import.go` 新增 `validateMetricPreviewDates`，在 `parseMetricText` 与 CSV 预览循环中、调用 `matchMetricImportRow` 之前执行；`matchMetricImportRow` 对已有 `error` 的行早退，保证 `work_id=nil / matched=false` 与负值行一致。前端 `ImportMetrics.confirmImport` 对 `r.work_id && r.error` 的行提示「存在格式错误的行，请先修正或跳过后再导入」并阻止提交；预览卡片在无错误且 `captured_at` 非空时展示 ` · 采集 <时间>`，匹配结论另起独立 span，避免破坏既有 E2E 的精确文本「已精确匹配」。新增 `TestU106MetricsImportPreviewDateValidation` 覆盖 CSV 与粘贴两种入口的非法 `captured_at` / `published_at`，以及合法 RFC3339 仍匹配并成功导入。

### 自动化验证（2026-11-27，本机）

| 命令 | 结果 |
|---|---|
| `cd server; go test ./internal/app -run 'TestDR05\|TestToutiaoScreenshot\|TestU106\|TestToutiaoPlatform\|TestHC' -count=1` | `ok ops/internal/app 49.516s` |
| `cd renderer; pnpm typecheck` | 通过 |
| `cd renderer; pnpm test:unit` | `257/257 pass, 0 fail`（5.6s） |
| `cd desktop; pnpm build:renderer` | 通过 |
| `cd renderer; pnpm exec playwright test e2e/g6-review-import-quality.spec.ts --project=desktop-windows-electron --reporter=line` | **4 passed（2.5m）**，含 CSV 预览、确认、复盘反馈 20 次样本；反馈 p50=63ms / p95=76ms，failures=0 |
| `cd renderer; pnpm exec playwright test e2e/desktop-review-restoration.spec.ts --project=desktop-renderer --reporter=line` | **1 failed**；唯一失败为既有过时像素基线，详见下节 |

**过时像素基线的如实记录**：`desktop-review-restoration.spec.ts` 的 `.desktop-review-board-heading` 实测 `y=398.5 / height=80`，静态原型期望 `y=269.09375 / height=31`；`y` 偏差 `129.40625px`。这不是本次修复引入：`docs/43-桌面端主攻与全局优化实施方案.md` §OPT-U05 已登记 HEAD 即为红灯——`aa9ac5f5` 起 `boardSortControls` 两个 36px Select 换行使标题高 80，OPT-U05 顶部引导卡再使之下移 129.4px；本次实测数值与该登记完全一致。本次未改该 spec、未改 dropzone、未改排序控件；全 day7 分支没有新增 DOM/CSS，新增单测锁定默认标题与零多余提示。若把该像素段作为强制门槛，则本项仍不能宣称全绿，剩余责任在既有测试基线而非本次 3 项修复。

### 本机 dev 真实 Electron 定点复验

环境：修改后源码重新编译的 `ops`（`:8080`，`OPS_DEV=1`、`OPS_DESKTOP_PLATFORM_ENABLED=1`、`OPS_DESKTOP_PLATFORM_AUTO_ADOPT=0`、`OPS_COOKIE_SECURE=0`、`NO_PROXY=127.0.0.1,localhost,::1`、`OPS_FIRST_TOKEN_TIMEOUT=60s` 仅本次进程环境变量）+ `renderer` Vite（`:5173`）+ 真实 Electron 窗口；工作区 `4e2bd06c-...`；视觉走本机 `:3425` 真实模型，未使用 `:8091` mock。

1. **项 1 PASS（截图识图零丢数）**：巡检号复盘页通过 `review-screenshot-dropzone` 上传 `docs/42-evidence/RC-05/13-readback-2026-11-26.png`；弹窗「工位上的松弛感」自动填出 `观看 89 / 点赞 3 / 收藏 2 / 评论 0 / 分享 0`；`raw_text` 为 `工位上的松弛感 2026-11-24 12:33 89 0 3 2 0`；`dropped` 警告计数为 0。截图见 `fix-verify/01-opt-u05-real-screenshot-preview.png`；为免污染未点「导入这一行」，故未产生新快照。
2. **项 2 PASS（看板节点透明）**：巡检号（`day2`）行显示 `按第 2 天`；验收号显示 `按第 31/36/45/48/51/55/56/57/58 天`；公众号 `3759` 第 7 天行无多余节点提示且阅读 100，`3754` 显示 `按第 103 天` 且阅读 1，`3739` 显示 `按第 106 天`；三页标题均为 `作品数据 · 默认第 7 天（缺第 7 天按实采节点）`。截图见 `02-xhs-inspection-day2-board.png`、`03-xhs-acceptance-day31-58-board.png`、`04-wechat-mixed-node-board.png`。
3. **项 3 PASS（坏日期预览标红 + 零污染）**：上传 `采集时间 = 2026-13-45 99:99` 的指标 CSV，预览弹窗该行红框、显示 `「采集时间」格式无效（需 RFC3339）：2026-13-45 99:99`、下拉默认「跳过此行」；未点确认。截图见 `05-metrics-csv-bad-date-preview.png`。复验前后 `metric_snapshot=25→25`、`account_metric_daily=30→30`，无异常写入。

**页面与库交叉核对**：`db-crosscheck.json` 对三账号 14 条有 `d7` 的页面行逐项比对 `reads/favorites/shares` 与 `work_metric_d7`，`all_match=true`、`mismatches=[]`；页面数字与数据库一致。

### 脱敏、清理与边界

- 临时登录严格沿用既有流程：先备份原 `password_hash`，临时散列登录，复验后逐字符写回并 `HASH_RESTORED_EXACT=True`，临时密码登录返回 `401`；临时散列、备份、CSV、Electron userData、脚本与日志已删除。
- 仅按本次精确 PID 停止自启的 `ops`（30980）与 Vite（22120）；8080/5173 已释放；未执行无差别 `Stop-Process -Name ops/node/electron`，未触碰 RC-21 长跑进程。
- `git status` 中 RC-21 并发文件仍为未提交状态，本任务未修改、未暂存、未回退；另有一个并发的 `server/internal/app/opt15_test.go`（`TestRC21SSEHasNoReadDeadline`）改动同样未触碰。本任务改动为 `metric_screenshot.go`、`dr05_screenshot_test.go`、`metrics_import.go`、`u106_backfill_test.go`、`Review.tsx`、`desktop-creative.css` 与新增 `review-node-transparency.test.mjs`；未 commit、未 push、未改生产、未改 `docs/42` 总台账为「已闭环」。
- 证据目录已扫描本机绝对路径、散列、临时密码、Cookie、Token 字面，零命中；`verification.json` 仅保留页面/库事实与相对文件名。
- RC-19 原有客观边界仍在：真实满 7 天节点与真实粉丝来源尚未补齐，不能凭本修复判定整个 RC-19 正式闭环。
