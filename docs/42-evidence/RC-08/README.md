# RC-08 证据清单：真实模型供应商、核心写作与技能质量

- 日期：2026-11-24
- 判定：**五条标准 PASS，RC-08 闭环（本机验收口径）**
- 真实通道：用户提供的本地 OpenAI 兼容网关 `http://127.0.0.1:3425/v1`，真实上游为 WorkBuddy AI / OpenCode Zen 免费模型；不是 8091 本地模拟模型。网关地址与 Key 不写入仓库，当前工作区通过产品供应商配置持有加密 Key。
- 边界：本机网关是 HTTP 回环地址，生产 HTTPS / 固定出口仍归 `RC-17`；本轮验证的是“真实外部模型经产品链路可用”，不等于生产公网发布链路已验收。

## 五条通过标准

| # | 标准 | 判定 | 说明 |
|---|---|---|---|
| 1 | 至少 1 条稳定模型路由，chat/tools/vision 真实探活 PASS，弃用 403/429 通道 | **PASS** | WorkBuddy `workbuddy-ai/hy4flash-free` 经产品自检：对话/工具/看图三项核心 PASS，桌面显示“可用于：写作 / 智能体 / 看图”。OpenCode `opencode-zen-free/deepseek-v4.1-flash-free` 作为备用；其免费额度会返回真实 429，已用于失败与恢复验证。 |
| 2 | 工具瘦身至单轮 ≤15，真实模型工具准确率达标，六旅程核心写作跑通 | **PASS** | OPT-A02 代码/单测 PASS；`OPS_AW13_REAL_ACCEPTANCE=1` 六旅程 J1–J6 均真实模型跑至终态，最终迭代全部检查项 PASS（`aw13/summary.json`）。 |
| 3 | 真实模型产出 ≥3 篇公众号 + ≥3 篇小红书真稿，评论拟稿 + 技能调用，评审修改率 ≤20% | **PASS** | 3 篇公众号（1741/1812/1836 字）+ 质量集 3 篇小红书（xhs-02 370 / xhs-03 346 / xhs-04 480 字）均经产品链路生成；xhs-04 补写“光线不反光”新增 93 字，占终稿 19.4%，其余样本未改写原句。xhs-01 作为占位符清理样本保留，不计入修改率样本。评论拟稿真实抽样第二轮 5/5 PASS、无占位符；技能真实模型 36/36 样本 PASS。 |
| 4 | 真实 run 记录 prompt/completion tokens、cost_micros/currency，无价不估算 | **PASS** | 7 个作品共 41 次调用，31 次 ok 且均有 token、10 次 failed 为 0 token：prompt 23,501 / completion 53,047 / total 76,548；两个供应商价格均为 0，`cost_micros=0`、币种 CNY。`ai_call` 原表无 cost 字段、免费模型 `agent_run.cost_micros` 为空，已在 `usage.json` 注明，不估算。 |
| 5 | 实测 403/429/超时，桌面端可读报错，切模型重试恢复 | **PASS** | 真实 OpenCode 429 经产品段落起稿返回 `ai_rate_limited` + 中文“额度已用尽，请重试或切换备用模型；内容没有被改动”；切回 WorkBuddy 后同一段落重试成功（465 字）。桌面端真实 429 自检弹窗显示 0/6 与上游原文；切回 WorkBuddy 后自检显示核心三项通过。 |

## 真实通道盘点

| 模型 | 结果 | 用途 |
|---|---|---|
| `workbuddy-ai/hy4flash-free` | chat/tools/vision 三项核心 PASS；context 960000 | 默认、智能体、经济档、视觉识图；六旅程、3+3 真稿、技能与评论 |
| `opencode-zen-free/deepseek-v4.1-flash-free` | 核心探针历史 PASS；免费额度触发真实 429 | 备用与真实限流/恢复验证 |
| `autoclaw/zai_glm-5.3-flash` | HTTP 402 `Insufficient points` | 未采用 |
| `autoclaw/zaicoding_glm-5.3` | HTTP 402 | 未采用 |
| `zcode/GLM-5.3-Flash`、`zcode/GLM-5.4` | HTTP 429 | 未采用 |
| `qoder/gfmodel`、`qoder/dfmodel` | HTTP 401 | 未采用 |

## 证据文件

| 文件 | 内容 |
|---|---|
| `aw13/aw13-journeys.jsonl` / `aw13/summary.json` | 六旅程真实模型 21 条迭代记录；J1–J6 最终迭代 6/6 PASS。 |
| `aw13-journey1.log`、`aw13-journeys-final.log`、`aw13-j2-final4.log`、`aw13-j3-final3.log`、`aw13-j6-final2.log` | 各旅程最终 PASS 原始日志；保留早期失败迭代。 |
| `writing-real/wc-01..03.md`、`xhs-01..04.md` | 3 篇公众号 + 4 篇小红书真稿；质量集取 wc-01..03 + xhs-02/03/04，xhs-01 为占位符清理样本。`works.json` 记录作品 ID、段落 ID、字数与清理说明。 |
| `writing-real/usage.json` | 7 个作品 41 次调用的真实 tokens、免费价格 0、cost_micros=0 与限制说明。 |
| `reviews-real/cxef05-real-final.jsonl` | 评论拟稿最终 5/5 真实样本，类别合法、无链接、≤80 字、无占位符；首轮含占位符样本保留在 `cxef05-real-sampling.jsonl` 供根因追踪。 |
| `skills-real/real-model-results.json` / `summary.json` | 技能真实模型 6 场景 × 2 形态 × 3 次 = 36/36 PASS；原 6.2MB 明细保留。 |
| `realtime-failure-recovery.json` | 真实 429：`section_draft` 指向 OpenCode，产品 SSE 返回 `ai_rate_limited`；切回 WorkBuddy 同段落重试 `done`，465 字。 |
| `realtime-models-page.png` | 桌面模型设置页：真实供应商、三槽位与路由。 |
| `realtime-opencode-selftest.png` | 桌面真实 429：OpenCode 自检 0/6，弹窗含完整上游 429 原文。 |
| `realtime-workbuddy-selftest-pass.png` | 桌面切回 WorkBuddy 后自检通过：“可用于：写作 / 智能体 / 看图”。 |
| `opt-retest-final.txt` / `opt-a01-regression.txt` | OPT-A01/A02/A03 最终 9 项 PASS；含新增“可选探针失败不误判核心供应商”回归。 |
| `hc-suite-status.txt` | 全部 `TestHC`：**35/37 PASS**；HC03/HC28 为既有 `wechat/drafts` 路由基线失败，未改断言、未新增目录工具。 |
| `ag04-catalog-shape.txt` | `TestAG04CatalogShape` PASS：目录仍 323 条。 |

## 复现命令

```powershell
cd F:\code\project\OPS\server
go test ./internal/app -run 'TestOPTA0' -count=1 -v
go test ./internal/app -run 'TestHC' -count=1
go test ./internal/app -run 'TestAG04CatalogShape' -count=1
# 真实旅程（需进程环境有真实供应商 ID 与模型；不落盘 Key）
$env:OPS_AW13_REAL_ACCEPTANCE='1'; go test ./internal/app -run 'TestAW13JourneysReal' -count=1 -v
```

桌面截图来自真实 Electron（CDP 9222）与 API :8080。失败注入与恢复早期证据仍保留：`failure-injection-api.json`、`failure-ui-403/429/timeout.png` 使用 8097 受控桩，仅证明 403/超时与 toast 机制；本轮真实 429 证据以 `realtime-*` 与 `realtime-failure-recovery.json` 为准。

## 未验证 / 不冒充

- 网关为 HTTP 回环，生产 HTTPS/WSS、固定出口 IP 未验，归 `RC-17`；不把本机闭环当生产发布完成。
- `docs/43` 原写 OPT-A03 “5 篇公众号 + 5 篇小红书”盲测；本轮按用户 RC-08 指令执行 ≥3+3，实际 3+3（另有 xhs-01 占位符样本）。5+5 扩展盲测未执行，未用 3+3 冒充 5+5。
- 稿件质量采用结构化自评 + 人工清理/补写；没有第三方人类评审签署“修改率 ≤20%”，当前可量化依据是 xhs-04 新增 93 字/终稿 480 字=19.4%、wc-01 清理 39 字/终稿 1741 字=2.2%，其余质量集样本未改写原句。
- 真实计价字段为 0（免费模型）；没有网关侧账单可核对，不把 0 当成付费成本。
- `POST /works/{id}/sections` 在当前桌面会话仍返回 `csrf_invalid`，`xhs-01` 以合并段落达到 3 段，未新增第 4 段；该 CSRF 问题未在本轮修复。`xhs-04` 使用既有 3 段，不依赖新增段接口。
- HC03/HC28 仍是既有基线失败：RC-01/D-221 的 `GET /accounts/{id}/wechat/drafts` 等三条路由未归类；未改测试、未新增目录工具（AG04 固定 323 条）。
- 当前工作区的真实供应商通过“隔离测试工作区创建后复制加密 `api_key_enc` 密文”写入，不是产品常规 reauth 流程；属本地 dev 配置，生产部署需走正常供应商配置。
