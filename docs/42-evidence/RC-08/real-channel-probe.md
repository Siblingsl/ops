# 真实模型通道盘点（2026-11-24，RC-08 收口版）

## 结论

**RC-08 要求的真实模型路由已建立，chat/tools/vision 三项核心探活 PASS。**

用户提供的本地 OpenAI 兼容网关：`http://127.0.0.1:3425/v1`。网关转发到真实外部供应商 WorkBuddy AI 与 OpenCode Zen，不是 OPS 自带 8091 模拟模型。API Key 只在进程环境/加密字段中使用，未写入本文件或仓库。

- **主路由**：`workbuddy-ai/hy4flash-free`，context 960000；对话、工具调用、看图三项真实最小请求均通过。
- **备用路由**：`opencode-zen-free/deepseek-v4.1-flash-free`，context 258624；核心探针历史通过，免费额度会返回真实 429。
- **当前工作区**：`4e2bd06c-210c-4840-9cfa-db2b36101083`；Provider `9bf53a15-005e-4eef-ab9e-e6ad7e9c7f1a`（WorkBuddy）与 `017ee409-0282-4a01-a102-1e911bbbe80f`（OpenCode）。
- **路由**：`default`、`agent_chat`、`tier_economy`、`metric_screenshot` 均指向 WorkBuddy；`default`/`agent_chat` 的 fallback 为 OpenCode。

## 同网关可用性矩阵

| 模型 | HTTP | 结论 |
|---|---|---|
| `workbuddy-ai/hy4flash-free` | 200 | 采用；核心探针通过，六旅程/真稿/技能/评论均走此模型 |
| `opencode-zen-free/deepseek-v4.1-flash-free` | 200 / 429 | 备用；真实免费额度限流已用于失败与恢复验证 |
| `autoclaw/zai_glm-5.3-flash`（用户最初指定） | **402** | `Insufficient points`，不可用 |
| `autoclaw/zaicoding_glm-5.3` | **402** | 同上 |
| `zcode/GLM-5.3-Flash`、`zcode/GLM-5.4` | **429** | 限流/额度，不可用 |
| `qoder/gfmodel`、`qoder/dfmodel` | **401** | 鉴权失败，不可用 |

`/v1/models` 仅返回 10 个模型；不是所有模型都有可用额度。用户指定的 `autoclaw/zai_glm-5.3-flash` 在本轮实测 402，因此采用同网关内可用的 WorkBuddy 免费模型作为验收模型；这一替代是本机 RC-08 的口径，不冒充用户最初指定模型。

## 真实探活与使用证据

- `realtime-workbuddy-selftest-pass.png`：桌面自检后显示“可用于：写作 / 智能体 / 看图”，核心三项 PASS；可选文生图探针失败不误判核心供应商，已修 `selftest.go` 并新增回归测试。
- `realtime-opencode-selftest.png`：桌面真实 429，自检 0/6，弹窗保留上游原文。
- `realtime-failure-recovery.json`：产品 `section_draft` 指向 OpenCode，SSE 返回 `ai_rate_limited` 中文错误；切回 WorkBuddy 后同一段重试 `done`，465 字。
- `aw13/summary.json`：六旅程真实模型 6/6 PASS。
- `writing-real/usage.json`：7 个作品 41 次调用、31 次 ok 带 token、10 次 failed 为 0 token；prompt 23,501 / completion 53,047 / total 76,548。
- `skills-real/summary.json`：技能 36/36 样本 PASS。
- `reviews-real/cxef05-real-final.jsonl`：评论拟稿 5/5 PASS、无占位符。

## 边界与未验证

- 网关监听在本机 HTTP 回环，生产 HTTPS/WSS、固定公网出口未验，归 `RC-17`；本文件只证明 RC-08 的本机真实模型链路。
- WorkBuddy / OpenCode 均为免费额度模型，价格字段为 0；没有网关账单可核对，不把 0 当作付费成本。
- OpenCode 的 429 有冷却窗口；本轮在窗口内取得真实失败证据，后续生产依赖该免费通道需考虑额度与自动切备用。
- 当前工作区的 Provider Key 通过“隔离测试工作区创建后复制加密 `api_key_enc` 密文”写入，不是产品常规 reauth 流程；生产部署应走正常供应商配置。
- 旧 magpie 网关 `https://magpie-api.88813888.xyz/v1` 本轮复核为 401，不再作为 RC-08 通道；早期 403/429 证据保留为历史，不混入本轮真实结论。
