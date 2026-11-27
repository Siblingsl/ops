# RC-12 真实热点源与联网搜索服务闭环

> 状态：**已闭环（2026-11-27，4/4 通过标准全 PASS；生产 `OPS_CRAWL_MODE=allow` + 服务端 `784bc632` + 打包桌面端 `c0c55bf0`）**

## 环境与前置修复

- 服务端：线上生产 `https://ops-api.88813888.xyz`（`OPS_DEV=0`、`OPS_CRAWL_MODE=allow`、部署提交 `784bc632`，运行镜像摘要前缀 `2c488974eb26`），全部公网采集与搜索请求均直连真实外部目标站点，非 mock。
- 客户端：Windows 打包桌面端 `OPS Desktop`（依次经 `320a50b0`、`784bc632`、`50a93719`、`240971e3`、`c0c55bf0` 打包更新）；工作区 `skyeder 的工作区`，演示用测试账号 `超管789`（公众号长图文）。
- AI 匹配通道：桌面端启用 `此客户端 AI`，经公网 WSS 通道转发至本机 `magpie` 网关执行 `opencode-zen-free/deepseek-v4.1-flash-free`，真实完成 `hot_relevance` 匹配打分（14,714 prompt tokens / 4,094 completion tokens / 44,134 ms）。
- 联调期间发现并修复的前置问题（均已合入 `main`）：
  1. `320a50b0`（D-226）：解冻管理员热点采集设置页 `/settings/crawl`，支持在桌面端开启采集强度与查看来源健康度/最近采集日志；
  2. `784bc632`：修复热点来源 key 含冒号（如 `rss:<uuid>` / `search:<uuid>`）时试采与保存路由 404，并区分「全站未开启 / 无有效方案 / 账号未开启热点」原因；
  3. `50a93719`（D-227）：解冻 `/settings/desktop-ai` 并补齐模型执行位置选择与回环防呆；
  4. `240971e3` & `c0c55bf0`：修复桌面 WSS 通道流式 SSE `Content-Type` 协议校验回归，以及切换桌面 AI 模式重载掉离线页和打包态本机请求跨源被拦的问题。
- 本次归档本身业务源码零改动。

## 通过标准逐项结果

| # | 通过标准 | 实测结果 | 关键证据 |
| --- | --- | --- | --- |
| 1 | 开箱即用真实热点源（预置公开 RSS/热榜源，可追溯时间与原文 URL） | **PASS**：一键启用公开 RSS 模板 **爱范儿**（HTTP `200`、每次 `20` 条、`fail_count=0`）与 **少数派**（HTTP `200`、每次 `10` 条、`fail_count=0`）；`hot_item` 真实落库含标题、`https://sspai.com/post/...` 原文 URL、`rank`、`first_seen_at`、`last_seen_at`；「今日热点」页显示每条首次出现/最近在榜时间与「打开原文」链接 | `02-crawl-health-and-logs.png`、`05-today-hot-matched.png`、`prod-db-verification.json` |
| 2 | 真实联网搜索服务（真实 API 接入、公开出处校验与额度/用量记录） | **PASS**：配置真实 **Tavily** 官方搜索接口（密钥经服务端加密存储，界面仅显示「已保存密钥，留空沿用」，关键词「内容运营」）；完成 3 次真实采集（`03:21:05Z`、`04:28:33Z`、`05:29:29Z`，均 HTTP `200`、`items=10`）；`ai_call` 记录 3 条 `task_type='hot_search'` / `provider='Tavily'` / `model='tavily'` / `status='ok'`（延迟 1281 / 3601 / 2458 ms）；界面展示最近成功时间与 2 次 `100.0%` / `20` 条统计 | `01-settings-hot-sources-tavily.png`、`02-crawl-health-and-logs.png`、`prod-db-verification.json` |
| 3 | 热点转选题并进入创作（参考来源进入作品上下文） | **PASS**：启用「账号启用热点」的运营方案后，真实匹配「今日热点」（`hot_relevance` `ok`，爱范儿第 11 名《A社曝光了一份AI整顿职场魔幻实录…》相关度 82、爱范儿第 5 名《ChatGPT即将到来的大更新，为何让老用户集体破防》相关度 72）；将《ChatGPT即将到来的大更新…》转为选题（`source='hot'`、`has_hot_item=true`）→ 点「采用并开始写」进入创作页（`status='adopted'`、`work_id=5693890b-cdbc-47df-893e-da6fece233ad`），热点切入角度自动带入作品「核心观点」上下文 | `05-today-hot-matched.png`、`06-hot-converted-to-topic.png`、`07-topic-adopted-to-work.png`、`prod-db-verification.json` |
| 4 | 失败平滑退路（源不可达/失败可读提示并引导手动粘贴全文参考，绝不伪造热点） | **PASS**：① 真实预置源 **36氪** 返回 HTTP `200` 但未通过严格 XML 解析器，落库 `error='无效 RSS / Atom'`（`fail_count=2`、`0.0%`、`items=0`），运营页保留顶部异常条，点击弹出「热点来源暂时不可用」弹窗并展示原始错误「无效 RSS / Atom」；② 60 分钟最短间隔内手动试采触发频控保护「达到采集限额或来源正在暂停（请求 ID：HekhH-000592）」同样弹出降级窗；③ 点击主按钮「点击手动粘贴文章全文作为参考」成功直达「对标参考」粘贴引导条并自动聚焦单篇链接输入区 | `02-crawl-health-and-logs.png`、`03-hot-fallback-dialog-36kr.png`、`04-fallback-references-paste.png`、`05-today-hot-matched.png`、`prod-db-verification.json` |

## 证据清单

| 文件 | 说明 | 字节 | 尺寸 / SHA-256 前缀 |
| --- | --- | --- | --- |
| `01-settings-hot-sources-tavily.png` | 设置 → 热点来源：Tavily 官方接口提示、已保存密钥留空沿用、关键词「内容运营」与保存成功提示 | 255,324 | 1801x1019；`659d480f` |
| `02-crawl-health-and-logs.png` | 设置 → 热点采集与日志：爱范儿/少数派/Tavily 100% 成功统计、36氪 0% 异常与最近采集日志明细 | 170,795 | 1801x1019；`33d948b4` |
| `03-hot-fallback-dialog-36kr.png` | 账号运营 → 热点参考：「热点来源暂时不可用」弹窗（36氪 `无效 RSS / Atom`）与「点击手动粘贴文章全文作为参考」按钮 | 287,844 | 1801x1019；`d41f0ba8` |
| `04-fallback-references-paste.png` | 点击降级主按钮直达「对标参考」粘贴引导条与单篇链接输入区 | 138,561 | 1801x1019；`c344747a` |
| `05-today-hot-matched.png` | 今日热点匹配结果（2026/11/27 14:13:32）：爱范儿真实热点卡片、相关度、首次出现/最近在榜时间、切入角度与 36氪顶部异常提示条 | 251,784 | 1801x1019；`1418f874` |
| `06-hot-converted-to-topic.png` | 选题池：热点转入的《ChatGPT即将到来的大更新，为何让老用户集体破防》选题与「采用并开始写」入口 | 172,613 | 1801x1019；`a2a52910` |
| `07-topic-adopted-to-work.png` | 创作页：采纳热点选题生成作品，核心观点已自动带入热点切入角度 | 229,369 | 1801x1019；`f0e3ce3b` |
| `prod-db-verification.json` | 生产库 5 条只读 SQL 脱敏结构化输出（`crawl_source` / `crawl_run` / `hot_item` / `ai_call` / `topic`+`work`） | — | 合法 JSON |

## 边界与如实披露

1. **联网搜索入口口径**：OPS 现行设计（V434 + OPT-A04）将 Tavily / 博查 / SearXNG 接入「工作区热点来源采集 → `hot_item` → 账号热点匹配 → 转选题入创作」链路，不包含在编辑器或对话流中由模型任意外呼的独立搜索 tool。
2. **Tavily 用量与 `hot_item` 抽样说明**：Tavily 外部搜索 API 不返回模型 token，`ai_call` 遥测记录 `prompt_tokens=0` / `completion_tokens=0`、请求耗时及 `status='ok'`，并按请求次数受全站每日采集请求限额与工作区 AI 用量限额约束，不虚构计费金额；生产 SQL 中 `hot_item ... ORDER BY last_seen_at DESC LIMIT 10` 被更晚执行的少数派 RSSRun（`05:35:30Z`，10 条）占满，Tavily 条目经服务端 `ValidateLink` 严格校验公开 URL 并由 `crawl_run`（3 次均 `http_status=200`、`items=10`）、`crawl_health`（2 次共 `20` 条）及 `ai_call` 实证入库。
3. **失败降级实测边界**：线上真实覆盖了外部源解析失败（36氪 `无效 RSS / Atom`）与频控冷却拦截（`达到采集限额或来源正在暂停`），未人工耗尽真实 Tavily 付费额度触发 402/429；Tavily/外部搜索 402/403/429 熔断分类与弹窗链路已有 `TestOPTA04*` 后端测试与统一降级弹窗路径覆盖。
4. **密钥轮换提示**：联调期间用户在对话中提供过 Tavily 测试 API Key；已全部加密写入线上数据库密文列，严禁进入任何源码、文档、日志或 Git 提交；建议验收后在 Tavily 控制台轮换（rotate）该 Key。

## 脱敏核验

- 所有截图均已逐张查验画面，不含 API Key、数据库密码、`MASTER_KEY`、服务器公网 IPv4、服务器主机名、真实邮箱或本机路径。
- `prod-db-verification.json` 与本报告已校验零命中真实 API Key（`<tavily-api-key>`）、公网 IPv4、主机名或本机文件系统路径；JSON 通过结构化解析校验，文本保持纯 LF 与单结尾换行。

## 最终判定

**RC-12 四条通过标准全部 PASS，正式闭环（2026-11-27）。**
