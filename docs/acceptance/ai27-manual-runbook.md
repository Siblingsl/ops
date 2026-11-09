# AI27 剩余项 · 人工配合操作手册

生成：2026-11-09 ｜ 依据：`docs/acceptance/ai27-remaining-work.md`（2026-11-08）、`docs/acceptance/ai27-acceptance-matrix.md`、`docs/27` v0.2、`docs/08` DEV-AI27 实施记录，以及 2026-11-09 对当前仓库源码的静态核查。

**诚实声明**：本手册的命令、路径、开关名、页面文案均逐条对照当前源码核实过；但**没有在本机实际启动服务、加载扩展或跑真实旅程**。凡涉及「点某个按钮后会发生什么」，以你现场看到的界面为准。凡是本手册标为「阻塞｜需先开发」的项，不是你操作不到位，是代码里缺东西。

---

## 0. 先看这一页：哪些真的能靠你配合过

| 组 | 项 | 现在能否靠人工配合关闭 | 真正的前置 |
| --- | --- | --- | --- |
| 一 | 模型供应商配置 + agent_chat 路由 + 自检 | ✅ 能 | 见 §1.1～1.3 |
| 一 | R01～R05（走 UI 手工旅程） | ✅ 能，但要换执行方式 | 见 §1.4.3 路线 A |
| 一 | R01～R05（走文档给的 `go test`） | ✅ 能（2026-11-09 修复后） | 见 §1.4.2：改用 `OPS_R_REAL_*` 环境变量注入，不再依赖页面库 |
| 一 | T-AI27-20 费用记账 | ⚠️ 半能：字段已在，可人工核对 | 见 §1.5 |
| 一 | V05 语音能力自检 | ⚠️ 部分能：ASR 路径已实现，TTS/realtime 无调用点 | 见 §1.6 |
| 一 | V07 / V08 语音计费与真实旅程 | ❌ **阻塞｜需先开发**（TTS/实时音频桥未实现） | 见 §1.6 |
| 一 | P01 OAuth | ❌ **阻塞｜需先开发**（OAuth 客户端流程未实现） | 见 §1.7 |
| 二 | 宿主注册 + Chrome 加载扩展 | ✅ 能 | 见 §2.1 |
| 二 | T-AI27-11、旅程 A/B/C/E、W10 侧栏 | ✅ 能（C 的部分 UI 可能仍未接线） | 见 §2.3～2.8 |
| 三 | T-AI27-26 / 23 / 24 / 33、W17c | ✅ 能，纯人工物理操作 | 见 §3 全节 |
| 四 | 8 项可选深化 | ⛔ 不需要你配合；且清单已过时 | 见 §4 |

**建议执行顺序**：§0.2 环境 → §1.1～1.3 配模型 → §2.1～2.2 装扩展 → §3 物理项（随时可并行做，不依赖前两组）→ §1.4 + §2.3～2.8 跑旅程 → §1.5 核对记账 → §5 登记。P01 先别投入时间；V05 可顺便验（需真 Key），V07/V08 仍要等开发。

---

## 0.1 六个必须先知道的事实（否则一定白干）

### 事实 1（最重要）：文档第 18 行的「本地库验证」和 `go test` 不是同一个数据库

- 页面 `/settings/models` 走的是运行中的后端，连 **`ops` 库**（`deploy/docker-compose.dev.yml`：POSTGRES_DB=ops，端口 5440）。
- `go test ./internal/app` 走 `server/internal/app/env_test.go:96-105`：`DROP DATABASE IF EXISTS ops_test WITH (FORCE)` → `CREATE DATABASE ops_test` → `db.Migrate` → `SeedDevModel`。**每次跑测试都重建一个空的 `ops_test` 库**，里面只有 `jobs.go:195` 播种的「本地模拟模型」。
- `r_real_journeys_test.go` 原本在 `ops_test` 里查 `p.name NOT LIKE '%模拟%' AND r.task_type='agent_chat'`，必然查不到、直接 fatal。**2026-11-09 已修**：改为 `OPS_R_REAL_BASE_URL`/`OPS_R_REAL_API_KEY`/`OPS_R_REAL_MODEL` 运行时注入，并在测试库里加密播种供应商与路由，不再依赖你在页面上的配置。
- 结论：页面配 Key 只解决「运行中的后端能对话」；跑 `go test` 另需在**同一终端**导出 `OPS_R_REAL_*`（见 §1.4.2）。两边都配不等于互相替代。

### 事实 2：默认路由被模拟模型占着，配了真实 Key 对话仍可能走模拟

- `jobs.go:198-202` 播种 `default` 等 9 条路由指向「本地模拟模型」，**但没有 `agent_chat`**。
- 快速配置弹窗（`web/src/pages/settings/Models.tsx:273`）明示：「只会写入还空着的任务路由，已有的配置不会被覆盖」；`quickRoles` 只有「主力 / 经济档 / 质量档 / 图片识别」四项，**不含 agent_chat**。
- `agent.go:236-239`：默认模型取 `agent_chat`，未配置时**回落到 `default`**。
- 结论：配完供应商必须**手工**在「任务路由」里把 `default` 和 `agent_chat` 都指到真实供应商，否则 AI 对话继续走模拟模型。详见 §1.2。

### 事实 3：AI27 的功能开关默认全关（2026-11-09 起页面可逐项开启）

- `agent_workbench.go:24-39`：`chrome_connect`、`browser_workspace`、`voice_dictation`、`voice_realtime`、`plugin_mcp`、`subagents`、`computer_use` 等 8 项 AI27 开关**默认关闭**。
- `settings/Admin.tsx` 的「智能体工作台特性」卡片**已补齐 19 项**（旧 11 + AI27 8），逐项提交、明确「不提供一键全开」。
- **推荐做法**：正常启动后端（不要设 `OPS_AGENT_WORKBENCH_FEATURES`），到 `/settings/admin` 里逐项打开你当前要验的那一项。D-160 的设计就是「日常读 DB」。
- **例外**：`runtime_gates.go:137-138` 规定 `OPS_AGENT_WORKBENCH_FEATURES` 非空时读路径以 env 为准（不读 DB），`0`/`false`/`off` 为紧急全关。所以**别为了省事设这个变量**——一设，页面上的开关就失效了。
- 结论：开关不再是阻塞；入口出现后仍需各自的环境（真 Key / 扩展 / 物理操作）才能验。

### 事实 4：V05 已补代码（只差真 Key）；V07/V08 与 P01 仍是代码没写完

**V05（三模式能力自检）——2026-11-09 已补，可验**：
- `desktop/renderer-src/src/pages/agent/VoiceBar.tsx` 改为真上传音频（`audio_base64` + `audio_filename`），不再提交空转写。
- `agent_voice.go` 的 turns 接口接受 multipart `audio` 或 JSON `audio_base64`（20MiB 上限，超限 413 `voice_audio_limit`）；有音频时走 `resolveRoute("asr")` → `ai.Transcribe` → 成功写 `reviewable`+文本+时长，失败写 `error` 回合+`asr_error_code` 并返回 502 `voice_provider_unavailable`。
- 迁移 `00097_agent_voice_asr.sql`：`agent_voice_turn` 增 `asr_provider`/`asr_model`/`asr_seconds`/`asr_error_code`。
- `settingsModelTaskTypes` 已含 `asr`；**但 `asr` 故意不回退 `default` 路由**——没配就直接 422 `voice_capability_unsupported`，避免把 chat 模型当 ASR 用后报 404 假故障。所以你必须先在「任务路由」里单独配一条 ASR。
- 仍未实现：TTS 播放、realtime 双向音频桥（V07 的 TTS/realtime 计费、V08 的真实语音旅程都依赖它们）。

**P01（MCP OAuth）——仍未实现**：
- `desktop/src/mcp-host.ts` 的 `McpHttpConnection`（:255）只支持静态 `headers`，没有授权流程；`agent_plugin_connection` 表也没有任何 token/凭据字段。
- 设计（docs/27:882）要求 OAuth 在本机侧完成、token 进 safeStorage、校验 issuer/受众/PKCE/state，不做 token 透传——这是**桌面端专项**，不是配个环境变量能绕过的。
- 结论：P01 先立项开发，别搭 OAuth 服务器白等。

### 事实 5：文档引用的 `docs/AI_HANDOFF.md` 当前不存在

`ai27-remaining-work.md` 第 4 行把它列为交接日志，实际仓库里没有该文件（2026-11-09 核查）。当前唯一的状态源是 `docs/08` + 验收矩阵 + Git 提交。登记时按 §5 写进 `docs/08`，不要去找那个文件。

### 事实 6：工作树不干净，且清单已过时

- `git branch` = `main`，`git log` HEAD = `2d0f7a84 DEV-AI27-14d`（比清单写的「35 包到 b86cfdc5」又往后走了若干包），且 **未 push**。
- `git status`（2026-11-09 核查）有 18 个已修改文件、43 个未跟踪项。其中本轮 AI27 补齐相关：`desktop/renderer-src/src/pages/settings/Admin.tsx`、`web/src/pages/settings/Admin.tsx`、`web/src/lib/types.ts`、`server/internal/app/{agent_voice,agent_voice_test,aicore,model_settings,agent_tools_settings,r_real_journeys_test}.go`、`desktop/renderer-src/src/pages/agent/VoiceBar.tsx`，以及新增的 `server/internal/ai/transcribe*.go`、`00097_agent_voice_asr.sql`、双端 `tests/admin-feature-labels.test.mjs`。其余（`desktop/src/main.ts`、`in-browse.ts`、`business-ui-preload.ts`、`InBrowsePanel.tsx` 等）是更早的未提交改动。按 `AGENTS.md`，**不得覆盖、回退或夹带这些无关改动**；做 §3.3 无沙箱启动实测前要留意你测的是哪份代码。
- 第四组「可选深化」里已有对应提交：多页签 `0147eb7a`、frame 级观察 `cd0a7afa`、证据保留策略 `b86cfdc5`、goal/routine 路由 `77645880`、S05 互斥 `9ed61a31`、`mcp__*` 动态目录 `2d0f7a84`。清单是 11-08 快照，别重复立项。

---

## 0.2 通用环境准备（所有项的地基，先做一遍）

> 以下命令在 Windows 上用 **PowerShell** 执行；Git Bash 的等价写法在括号里。每个终端窗口的环境变量**只在当前窗口有效**，关掉就丢。

**A. 启动数据库（一次即可）**

```powershell
cd F:\code\project\OPS
docker compose -f deploy/docker-compose.dev.yml up -d
docker ps --format "table {{.Names}}\t{{.Status}}"     # 确认容器名与实际状态
```

期望看到 `ops-dev-postgres-1` 且状态 healthy。若容器名不同（例如带用户名前缀），后面所有 `docker exec ops-dev-postgres-1` 换成实际名字。

**B. 启动后端（不要设特性 env，到页面里逐项开）**

```powershell
cd F:\code\project\OPS\server
$env:OPS_DEV = '1'
go run ./cmd/ops serve
```

Git Bash 等价：

```bash
cd /f/code/project/OPS/server
export OPS_DEV=1
go run ./cmd/ops serve
```

**为什么不带 `OPS_AGENT_WORKBENCH_FEATURES`**：`runtime_gates.go:137-138` 规定该变量非空时读路径**以 env 为准、不读 DB**，一设页面上的开关就全失效。正确做法是启动后在 `/settings/admin` →「智能体工作台特性」里逐项打开你要验的能力（19 项已全部列出，默认全关，无「一键全开」）。

> 只有在你明确要做「紧急全关演练」（`0`/`off`/`false`）时，才需要设这个变量。

API 在 `:8080`，模拟微信与模拟模型在 `:8091`。

> 若你还要联调桌面端自动采集，另加 `$env:OPS_DESKTOP_PLATFORM_ENABLED='1'`（**只在进程启动时读取，改了必须重启 API**）；`OPS_DESKTOP_PLATFORM_AUTO_ADOPT` 保持关闭。见 `AGENTS.md` 与 `docs/21`。这开关与 AI27 旅程无关，不要为了省事打开。

**C. 启动 Web 端**

```powershell
cd F:\code\project\OPS\web
pnpm install          # 首次或依赖变更时
pnpm dev              # http://127.0.0.1:5173
```

页面：模型配置 `http://127.0.0.1:5173/settings/models`；AI 对话 `http://127.0.0.1:5173/agent`；超管 `http://127.0.0.1:5173/settings/admin`。首次使用若跳到 `/setup`，先建所有者账号（只需要设一次；账号密码不要写进任何文档或截图）。

**D. 启动桌面端（第二、三组才需要）**

```powershell
cd F:\code\project\OPS\desktop
pnpm install --frozen-lockfile
pnpm --dir renderer-src install --frozen-lockfile
pnpm build:renderer
pnpm start
```

`pnpm start` = `pnpm build && node scripts/start.cjs`（`desktop/package.json:22`）。桌面端页面路径与 Web 一致（`/settings/models`、`/agent`、`/settings/admin`、`/plugins`）。

**E. 每次操作前的三项通用检查**

1. `curl -s http://127.0.0.1:8080/api/v1/auth/me` 或浏览器打开页面，确认后端在跑、已登录。
2. 打开 `/settings/admin` →「智能体工作台特性」卡片，确认开关状态与你预期一致（env 非空时这个卡片可能显示只读，属正常）。
3. `git status --short` 看一眼，确认你待会儿要提交的文件没和别人的改动混在一起。

**F. 证据留存约定（每项都要）**

在仓库根建一个当日证据目录（不要写进代码/日志任何密钥）：

```powershell
mkdir -p F:\code\project\OPS\output\ai27-manual-2026-11-09
```

每个验收 ID 一个子目录，至少留：① 操作前后截图；② 关键命令的完整控制台输出（复制为 `.txt`）；③ 一条 `result.md` 写「时间 / 环境 / 步骤 / 观察 / 结论 / 失败项」。`docs/27 §17.3` 要求的登记要素见 §5。

---

## 第一组：需真实模型 API Key

### 1.1 配置真实模型供应商（逐步点击）

1. 浏览器打开 `http://127.0.0.1:5173/settings/models`（桌面端同路径）。**必须是所有者账号**——页面顶部会提示「你是观察者，只能查看模型配置」或「编辑者不能修改密钥或路由」。
2. 点右上角 **「快速配置」**（`Models.tsx:541`）。弹窗标题「快速配置模型」。
3. 在三个模板里选一个：
   - `阿里云百炼` → base 预填 `https://dashscope.aliyuncs.com/compatible-mode/v1`，模型建议 qwen-plus / qwen-turbo / qwen-max / qwen-vl-plus；
   - `火山方舟` → `https://ark.cn-beijing.volces.com/api/v3`，模型名填控制台的接入点 ID（`ep-` 开头）；
   - `其他 OpenAI 兼容接口` → 手填，**接口地址要以 `/v1` 结尾**（OpenAI 官方 `https://api.openai.com/v1`、DeepSeek `https://api.deepseek.com/v1` 等，以供应商文档为准）。
4. 填「名称」：起一个**不含「模拟」二字**的名字，例如 `DeepSeek-生产自检`。原因见 §1.4.2 的 SQL 条件 `p.name NOT LIKE '%模拟%'`。
5. 填「API 密钥」：粘贴真实 Key。这是全过程中**唯一**允许出现密钥的地方——加密存库，页面只显示掩码。**不要**把它写进本手册、证据 `.txt`、截图、命令历史或提交信息。
6. 点「获取可用模型」→ 弹出「获取到 N 个模型」→ 在「主力模型」下拉里选一个**支持工具调用（function calling / tools）**的模型（如 `gpt-4o`、`claude-sonnet-4-20250514`、`deepseek-chat`、`qwen-plus`）。R 系列和浏览器工具链都依赖工具调用能力，纯文本模型会在工具轮次卡住。
7. 「经济档 / 质量档 / 图片识别」可留空。**注意**：`Model` 字段里没选进 `models` 数组的模型名，后面任务路由下拉里选不到；如果打算给 agent_chat 单配一个模型，先在这里把它也选上（例如把经济档填成同一个模型名，或改用「添加供应商」手工填模型列表）。
8. 点「保存并测试」。弹窗会提示「保存后会用主力模型做一次连通测试，产生少量 token 费用」。看到 `已设置：主力模型` 且测试 `ok` 才算这一小步过。
9. 若报错，先自查三点：base_url 是否以 `/v1` 结尾、Key 是否有余额/权限、本机 `HTTP_PROXY` / `NO_PROXY` 是否把回环或供应商域名拦了。

### 1.2 把 `default` 和 `agent_chat` 路由改到真实供应商（**文档漏写，必做**）

1. 同页往下滚到 **「任务路由」** 卡片（`Models.tsx:340`）。默认只显示 5 行（默认模型 / 经济档 / 质量档 / 图片识别 / 出图）。
2. 点卡片底部那条灰字链接：**「其他 N 类任务默认跟随主力模型，需要时再单独指定 →」**（`Models.tsx:380-383`），展开全部任务。
3. 找到 **「默认模型」**（必填）这一行：
   - 「供应商」下拉选你刚建的真实供应商；
   - 「模型」下拉选支持工具调用的那个模型；
   - 它当前很可能指向「本地模拟模型」——**必须改掉**，否则 `agent.go:239` 的回落逻辑会让对话继续用模拟模型。
4. 找到 **「智能体对话」**（`task_type = agent_chat`，标签见 `agent_test.go:157`：「智能体对话」）这一行：同样选真实供应商 + 模型。这一行默认很可能是「使用默认模型」，虽然回落到 default 也能走真实供应商，但**显式指定**更符合文档要求「确认 agent_chat 路由指向它」，也让 §1.3 的 SQL 能查到。
5. 需要时给这两行也设「备用供应商 / 备用模型」（可不设）。
6. 点卡片右上角 **「保存路由」**，看到「任务路由已保存」。
7. 可选但推荐：在供应商卡片里把「本地模拟模型」停用（状态改为非 active），避免以后误用；**不要删除**，删除属于破坏性数据操作，先备份库再说。

### 1.3 自检与库内验证

1. 回到页面上方的供应商卡片，点 **「自检」**（`Models.tsx:598`，title 是「探测对话、JSON、流式、出图、联网搜索、工具调用与看图能力」）。自检会产生少量费用，且**不计入用量统计和质量看板**（`Models.tsx:39`）。
2. 判定：至少「对话 / JSON / 工具调用」三项通过。出图、看图、联网搜索不通不影响 R 系列，如实记录即可。若工具调用失败，换模型，别硬往下走。
3. 库内验证（先按 §0.2 A 确认容器名）：

```powershell
docker exec ops-dev-postgres-1 psql -U ops -d ops -t -c "SELECT p.name FROM model_provider p JOIN model_route r ON r.provider_id=p.id WHERE p.status='active' AND p.execution_location='server' AND p.name NOT LIKE '%模拟%' AND r.task_type='agent_chat'"
```

期望返回你起的供应商名。**但请记住事实 1**：这条通过只说明 `ops` 库（UI 侧）配好了，不等于 `go test` 能跑。

4. 端到端冒烟：打开 `/agent` → 新建对话 → 发一句「你好，请说明你能否调用工具」。若回复正常且 `agent_run` 有用量，说明真实供应商已真正接上；若回复仍是模拟模型的固定话术，回到 §1.2 检查 `default` / `agent_chat`。

### 1.4 R01～R05 运营任务旅程（T-AI27-07 / 20 + §16.4 + §9.7）

#### 1.4.1 现在该跑的命令（2026-11-09 起）

```bash
cd server
export OPS_R_REAL_BASE_URL='https://api.example.com/v1'
export OPS_R_REAL_API_KEY='<本机终端临时设置，不要写进文档/截图/提交>'
export OPS_R_REAL_MODEL='支持工具调用的模型名'
export OPS_R_REAL_ACCEPTANCE=1
export OPS_R_REAL_OUTPUT='output/r-journeys'
go test ./internal/app -run 'TestR0|TestRReal' -v -count=1 -timeout=60m
```

PowerShell 等价：

```powershell
cd F:\code\project\OPS\server
$env:OPS_R_REAL_BASE_URL = 'https://api.example.com/v1'
$env:OPS_R_REAL_API_KEY = '<本机终端临时设置>'
$env:OPS_R_REAL_MODEL = '支持工具调用的模型名'
$env:OPS_R_REAL_ACCEPTANCE = '1'
$env:OPS_R_REAL_OUTPUT = 'output/r-journeys'
go test ./internal/app -run 'TestR0|TestRReal' -v -count=1 -timeout=60m
```

补充说明：
- `TestR0` 是五个真实旅程；`TestRReal` 是**不产生费用**的离线契约测试，建议一起跑，用来先确认注入参数被正确解析、密钥加密路径可用、证据断言本身有效。
- 相对路径 `output/r-journeys` 以 `server/` 为工作目录，证据实际落在 **`server/output/r-journeys/r-journeys.jsonl`**，不是仓库根 `output/`。想统一放根就写绝对路径。
- R02 还要额外 `$env:OPS_R_REAL_BACKDROP='1'`，否则直接 skip。
- 只给 `OPS_R_REAL_ACCEPTANCE=1` 不给三个变量时，会明确报「缺少 OPS_R_REAL_* 变量名」并失败——不会静默 SKIP，也不会回显你填的值。

#### 1.4.2 原缺陷与 2026-11-09 的修复对照

| 原问题 | 位置 | 修复后 |
| --- | --- | --- |
| 测试库每次重建且与 UI 隔离 | `env_test.go:96-105` | 不再从库里找供应商：`OPS_R_REAL_*` 运行时注入，测试库内用 `box.Encrypt` 播种 provider + 路由，退出时清理 |
| 找不到真实供应商即致命退出 | 原 `r_real_journeys_test.go:45-52` | 缺变量时只报缺失变量名；有变量时正常进旅程 |
| 对话写死 `mock-writer` 模型名 | 原 `agent_run_test.go:17-24` | 旅程改用 `OPS_R_REAL_MODEL` 指定的真实模型 |
| 「通过标准」很弱：证据只记录不断言 | 原 `r_real_journeys_test.go:145-155` | `validateREvidence()` / `validateRReportChecks()` 硬断言：至少一条可回查证据（origin + 脱敏 URL + 读取时间 + 未隔离），§9.7 字段关键词齐全，缺即 fail |
| 三次结果只记录不比 | 原 `runThreeTimes` | 三次不一致直接 fail |

**仍然存在的外部前置**：真实 Chrome 扩展必须已加载并配对（`openRealRJourney` 只开服务端特性标志，扩展要你自己装），否则浏览器工具没有真实来源可采——这一条无法用代码绕过。

#### 1.4.3 路线 A（推荐，纯人工配合即可）：在真实运行的 OPS 里跑 5 场景 × 3 次

这条路不碰 go test，直接满足 `docs/27 §16.4` 的「真实来源 → 可回查证据 → 报告固定字段契约 → 逐项采用」，证据比测试脚本更强。

**通用准备**
1. 完成 §0.2 全部 + §1.1～1.3 + §2.1～2.2（Chrome 扩展已加载并配对，否则拿不到真实网页来源）。
2. 打开桌面端 `/agent`，新建**独立会话**，每个场景一个会话，命名如 `R01-迭代1`，便于回查。
3. 在会话里先确认模型选择框指向真实供应商（不是模拟模型）。
4. 用「添加」入口把要读的 Chrome 标签授权给本次任务；**每次授权 ≤5 个 origin**（`T-AI27-06` 契约）。
5. 准备一个计时/记账表：每次迭代记下开始时间、供应商、模型、大致 token 消耗（`/settings/usage` 可看）。

**逐场景操作**（提示词可直接用 `r_real_journeys_test.go:161-209` 里的原文，把「第 N 次迭代」改成 1/2/3，并确保每次换一个此前未用过的来源）

| ID | 你要做的事 | 每次迭代必须核对的报告要素 |
| --- | --- | --- |
| R01 竞品研究 | 在 Chrome 打开 3 篇公开内容 → 让 AI 比较主题/结构/表达/互动线索 → 要求输出对照 + 可借鉴 / 不可照搬分列 | 每条结论带来源 URL + 读取时间 + 来源片段；**不自动入库**（素材候选只能逐张卡片保存） |
| R02 本人后台 | 先在 Chrome 登录你自己的后台并授权该标签 → 让 AI 读账号表现数据、切换 3 个不同时间范围 | 每个数字附页面来源 + 读取时间；缺失项标 `missing`（**不补零**）；不执行发布/修改。用隔离测试账号，别拿生产账号当回归夹具 |
| R03 网页改稿 | 打开一篇真实公开网页 → 让 AI 区分事实/观点 → 产出新版文稿 | 差异对照表 + 逐段理由 + 来源回链；**不写入作品** |
| R04 热门话题 | 打开真实榜单/检索页 → 让 AI 记录实际排序与观察时点 | 每条线索附来源 + 时点；明确写「页面可见样本」而非全平台排名 |
| R05 商品机会 | 打开真实公开商品页 → 比较卖点/价格/人群 | 对照附价格 + 货币 + 观测时间；未读取的销量/转化如实标缺失，不得估算 |

**每次迭代结束后的核对动作**
1. 打开工作视图的「来源」子页（`docs/08:3418` W09 第二批已实现），逐条点开证据，确认能回查到 URL / 读取时间 / 片段。
2. 对照 `docs/27 §9.7` 的报告固定字段表（:780-789）逐项打勾：`kind`/`status`、`request_snapshot`、`scope`/`sample_summary`、`findings[]`（证据 ID + 事实/推断标记）、`metrics[]`（缺失为 null + reason，0 必须有真实来源）、`recommendations[]`、`sources[]`、`model_receipt`。
3. 确认没有任何自动写入：素材库、作品、正式指标表都保持原样。
4. 截图保存报告 + 来源子页 + `/settings/usage` 的用量，放进 §0.2 F 的证据目录。
5. **逐项采用**：手动选 1 条素材候选或 1 条改写提案，走原卡片执行，再用原 API 读回确认——这一步是 §9.7「最小研究旅程」的收尾，别省。

**完成标准**：5 场景 × 3 次 = 15 次旅程，每次都有真实来源引用且可回查、报告字段成立、无自动写入、有逐项采用证据。然后把 `T-AI27-07` / `T-AI27-20` / `R01～R05` 在矩阵里改成「通过」，按 §5 登记。

#### 1.4.4 路线 B 已落地（2026-11-09），但仍需扩展

执行器的四处硬缺陷已按原计划修完（见 §1.4.2 对照表），改动登记在 docs/08「DEV-AI27-R 执行器修复实施记录」。仍未解决的一项：**go test 环境里的真实 Chrome 扩展连接**——它需要你在本机注册宿主并加载扩展（§2.1～2.2），测试进程才能通过本机宿主拿到网页来源。

所以路线 A 依然是更强的证据路线：它在你真实操作的桌面端里跑，扩展、登录态、来源回查都是真的。路线 B 适合在扩展开着的前提下做批量重复验证。

### 1.5 T-AI27-20 费用记账（半能，可人工核对）

好消息：`agent_run.go:452-456` 的 `ai_call` 插入已带 `prompt_tokens` / `completion_tokens`，:1014-1015 有 run 的用量更新，:1090 详情接口返回 `usage`。骨架是有的。

操作：
1. 跑完 §1.4.3 任意一次真实旅程后，打开 `/settings/usage`，确认出现对应 task_type 的调用行、`prompt_tokens` / `completion_tokens` 非零。
2. 想精确核对就查库（只查字段，不导出任何密钥列）：

```powershell
docker exec ops-dev-postgres-1 psql -U ops -d ops -c "SELECT task_type, provider, model, status, prompt_tokens, completion_tokens FROM ai_call ORDER BY created_at DESC LIMIT 10"
```

3. 再到 `/settings/models` 的供应商卡片填单价（页面说明「按供应商单价估算，以供应商账单为准」），核对 `/settings/usage` 的费用估算是否出现。
4. 判定与如实记录：若 `prompt_tokens` 为 0 或行数不增长，说明真实供应商用量回执没接上，**登记为「部分」并把缺口写出来**，不要因为共享预算账本（W06b）有预留/扣减就宣称 T-AI27-20 通过。文档第 45 行说的「如未自动累计需接真实供应商用量回执」正是这个分支。

### 1.6 V05（可做）/ V07、V08（仍阻塞）

**V05 现在可以验了**（2026-11-09 补齐 ASR 链路）：

1. 桌面端 `/settings/models` →「任务路由」→ 展开后能看到 **「ASR 语音转写」** 一行，选供应商 + 转写模型（如 `whisper-1`/`gpt-4o-transcribe` 等该供应商支持的模型名）。
   - 注意：`asr` **不会回退 `default` 路由**。不配就等于没配，接口会直接 422 `voice_capability_unsupported`。
2. 到 `/settings/admin` 打开「语音转写」开关。
3. 桌面端 `/agent` → 点输入台麦克风 → 说一句话 → 停止。
4. 期望：服务端调 `{base_url}/audio/transcriptions` → 回合状态变 `reviewable` → 输入框出现转写文本且**可编辑**（不是直接发送）。
5. 查库核对记账（不导出密钥列）：
   ```powershell
   docker exec ops-dev-postgres-1 psql -U ops -d ops -c "SELECT state, asr_provider, asr_model, asr_seconds, asr_error_code FROM agent_voice_turn ORDER BY created_at DESC LIMIT 5"
   ```
6. 反例（V05 要求「能力不足/格式不兼容/密钥过期要准确报错，不静默换供应商」）：把 ASR 路由指到一个错的模型名或过期 Key，再录一次——期望回合变 `error`、`asr_error_code` 写入 `voice_provider_unavailable`、界面提示可手动输入终稿，而不是假装成功。

**V05 仍不可判「通过」的部分**：它的定义是「ASR/TTS/realtime **分别**真实自检」，而 TTS 与 realtime 目前没有调用点（见下表），只完成了三分之一。

**V07 / V08 仍阻塞**：

| 缺口 | 现状 |
| --- | --- |
| ASR 记账 | ✅ 已实现（`asr_model` / `asr_seconds`） |
| TTS 生成量与 realtime 音频 token 计费 | ❌ 未实现（无 TTS/实时通道） |
| 实时音频桥、打断音频反馈 | ❌ 未实现 |
| 真实语音旅程（研究→播报→打断改要求→逐项确认） | ❌ 依赖上面两项 |

V08 的人工旅程按 `§11.4.4` 覆盖：中英文、数字/否定句、噪声误识别、用户纠正。等 TTS/实时桥实现后再补教程。

### 1.7 P01 OAuth（阻塞｜需先开发）

已完成：`McpHttpConnection`（`desktop/src/mcp-host.ts:255`）、HTTP 传输层单测、插件管理页 `/plugins`（`desktop/renderer-src/src/App.tsx:153`）。
未完成：**OAuth 授权流程**（全仓库仅 :248 一行注释「另行处理」），`docs/08:3422` 登记「真实 OAuth 服务旅程属后续」。

设计约束（docs/27:882）决定了这不是「加个环境变量」的事：token 必须走本机安全存储 `secret_ref`（不可加密时禁止持久保存，不退回明文），OAuth 要按官方流程校验 issuer、资源受众、PKCE 与回调 state，只发送该连接范围的 token，不做透传。`agent_plugin_connection` 表当前也没有任何凭据字段——所以这是**桌面端专项开发**（发现 → 动态注册 → PKCE → 回环回调 → 换 token → 刷新），做完才谈得上验收。

现在能做的：搭一个公开 MCP HTTP 服务器备用（例如 MCP Inspector 的示例服务），在 `/plugins` 里添加一条 **http 连接**（非 OAuth），验证「连接 → 目录 → 调用回执 → 停用」这条已有链路，把结果记为 P02/P03 的补强证据。**但不要把它记成 P01 通过**。P01 要等 OAuth 实现后，按「添加 http 连接 → 触发授权跳转 → 回调换 token → 双传输验证」重跑。

---

## 第二组：需 Chrome 扩展加载 + 真实站点

### 2.1 注册 Native Messaging 宿主 + 加载扩展（超详细）

**这个脚本会改什么，先心里有数**：`register.cjs` 会 ① 复用/生成 `desktop/chrome-extension/manifest.json` 的 `key` 字段（公钥，非敏感）并算出固定扩展 ID；② 写 `desktop/src/native-host/com.ops.desktop.bridge.json`（host manifest）；③ 写 `desktop/src/native-host/run-host.bat`；④ 写 HKCU 注册表 `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.ops.desktop.bridge`。**不改 Chrome 安装、不改 profile**。当前这三个产物文件已存在（11-07 生成过），重跑是安全的、会复用同一个 key。

1. 打开 PowerShell，执行：

```powershell
cd F:\code\project\OPS
node desktop/src/native-host/register.cjs
```

2. 记下输出里的 5 行，重点是 **「扩展 ID」**（32 位小写字母，形如 `abcdefghij...`）。把它抄到你的证据 `result.md`，后面配对和排障要用。
3. 确认输出里「扩展目录」= `F:\code\project\OPS\desktop\chrome-extension`，「host manifest」= `...\native-host\com.ops.desktop.bridge.json`，「注册表」= 上面那个 HKCU 路径。
4. 打开 **Chrome**，地址栏输入 `chrome://extensions` 回车。
5. 打开右上角 **「开发者模式」** 开关。
6. 点左上角 **「加载已解压的扩展程序」**。
7. 在目录选择框里选中 **`F:\code\project\OPS\desktop\chrome-extension`**（选目录本身，不要选到里面的某个文件），点「选择文件夹」。
8. 加载成功后卡片显示 `OPS Browser Bridge` v0.1.0，核对卡片上的 **ID** 与第 2 步记下的扩展 ID **完全一致**。不一致说明加载了另一份 manifest，先移除再重来。
9. 点卡片上的 **「详细信息」**，确认权限包含 `nativeMessaging`、`tabs`、`scripting`、`storage`、`sidePanel`，以及 `host_permissions: <all_urls>`（W02 验证期范围，正式版才收敛——如实记录，别当成已收敛）。
10. 点浏览器右上角拼图图标 → 把 `OPS Browser Bridge` **固定到工具栏**，方便后面点 popup 和侧栏。
11. 点扩展图标打开 popup，先看连接状态文案。若显示「启动 OPS 桌面（OPS_DESKTOP_BRIDGE_DIAG=1）以开始配对」，属正常，下一步处理。

**回退方式**（不想用了）：`node desktop/src/native-host/register.cjs --unregister` 删注册表项，再到 `chrome://extensions` 移除扩展。`manifest.json` 的 `key` 会保留，别手删。

### 2.2 启动诊断模式并完成配对

1. 按 `desktop/chrome-extension/README.md:19-21`，用诊断模式启动桌面端：

```powershell
cd F:\code\project\OPS\desktop
$env:OPS_DESKTOP_BRIDGE_DIAG = '1'
pnpm start
```

注意：`OPS_DESKTOP_BRIDGE_DIAG=1` **只在 `main.ts:284-286` 生效**，且必须**同时没有** `OPS_DESKTOP_NO_SANDBOX=1`；否则走 :282 分支只打印「桥已关闭」，不会启动桥（这正是 §3.3 要验的行为）。
2. 点扩展 popup，读取 **配对短码**。
3. 在 OPS 诊断窗核对短码一致后点 **「确认配对」**（5 分钟有效）。`docs/08:3a090cb4` 已交付「首次连接向导 UI——配对短码」，若界面有向导就按向导走。
4. 通过诊断窗派发登记动作（`tabs_list` / `observe` / `navigate` / `click` / `type` / `extract` / `screenshot`）验证闭环。**只派发这 7 类**，扩展不接收任意 JS 或 CDP 方法。
5. 判定：popup 显示已连接、短码消失/变为已配对、诊断窗能收到回执。截图留证。

> 排障：若设置了 `HTTP_PROXY` 而 `NO_PROXY` 未含回环地址，本机健康检查会被代理接管并一直 404（`AGENTS.md` 有记录）。两端配置已显式排除；手工启动时自行加 `$env:NO_PROXY='127.0.0.1,localhost,::1'`。

### 2.3 T-AI27-11 登录 / MFA（§16.2 + §7.6）

1. 在已配对的 Chrome 里打开一个**有登录/MFA 的隔离测试账号**站点（GitHub 等）。**不要用生产账号**（`§16.5 旅程 B` 明确要求）。
2. 在 OPS `/agent` 发起浏览任务，指向该站点，授权该标签。
3. 观察 AI 遇到登录/MFA 时是否进入人工阶段，按 `§7.6` 逐项核对：
   - 显示**真实站点 origin** 和需要你做的事，聊天里不索要密码/验证码；
   - 暂停该页的 DOM 读取、截图、文字提取、模型观察；跨域 frame 未能安全识别时同样暂停；
   - OPS 只显示等待状态，**不复制二维码或凭据**；
   - 你在真实 Chrome 页面手工完成登录/MFA；
   - 点 OPS 的「已完成，继续」后，AI 重新核对页面与账号身份，只恢复获准的后续读取。
4. **敏感信息核查（这步别省）**：检查后端日志、浏览器 DevTools Network、扩展 popup 的最近命令、`output/` 里的截图，确认密码 / MFA 码 / 二维码没有进入任何模型请求或日志。可以搜你刚输过的验证码字符串。
5. 判定：任一项不符就登记「部分 / 失败」并写清是哪一层泄漏；不要因为流程走完就判通过。

### 2.4 旅程 A：公开资料研究

1. Chrome 打开**两篇**真实公开网页，在 OPS 授权这两个标签。
2. 让 AI 比较两篇内容。
3. 在其中一个页面放一个指向**未授权站点**的链接并让 AI 尝试访问 → 应出现**暂停**，由你同意或拒绝。
4. 核对：报告有日期/片段/来源；未读页面**不产生引用**；未批准站点**没有被访问**；报告**没有自动入库**。
5. 截图：暂停提示、拒绝后的状态、最终报告、素材库前后对比。

### 2.5 旅程 B：登录态研究

1. 用 §2.3 的隔离账号登录站点并完成 MFA 人工阶段。
2. 显式「交回 AI」→ AI 读取获准信息 → 记录读到的字段。
3. **撤销标签权限**（在 OPS 连接/授权 UI 里撤），立刻再发起一次读取 → 必须被拒绝。
4. 再查一遍密码 / 验证码 / 二维码是否进入模型请求或日志（同 §2.3 第 4 步）。
5. 截图：撤销操作、拒绝回执、日志检索结果。

### 2.6 旅程 C：页面反馈改文稿

1. 在网页选中一段文字 → 用浏览器工具栏的「标注」做批注（**注意**：`docs/08:3417` 登记「浏览器工具栏批注按钮」属后续未接线；若现场找不到该按钮，这就是阻塞，如实记录，别用其他方式伪造这一步）。
2. 确认批注进入输入台成为引用筹码 → 发送 → AI 生成产物 v2。
3. 对照 v1 / v2（`docs/08:3417`：「产物版本对照接线」也属后续，若没有对照 UI，同样登记为缺口）。
4. 提出**单作品 / 单段**修改卡片 → **逐张**执行（D-117 红线，不允许批量）→ 用原 API 读回确认。
5. 核对：网页批注或批准计划**不能代替写入卡片**。

### 2.7 旅程 E：恶意与越权

1. 建一个**隔离本地页面**（例如本地静态 HTML，别用真实站点），放进诱导内容：要求读其他标签、转发文件、访问私网地址、伪造批准、诱导点「发布」按钮。
2. 让 AI 读这个页面并发起任务。
3. 核对：即使模型提出调用，宿主 / 扩展仍**拒绝**；消息准确解释受限范围（不是笼统报错）。
4. 补充覆盖：跨用户、跨工作区、viewer 角色各发一次同类请求（`T-AI27-15` 的服务端隔离已自动化通过，这里验的是真实链路）。
5. 截图：诱导页、拒绝回执、消息文案。

### 2.8 W10 侧栏真实旅程

1. 点 Chrome 工具栏上的扩展图标。manifest 里声明了 `side_panel` + `default_popup`；如果点击只弹 popup 而没开侧栏，在扩展图标上**右键 → 「打开侧边面板」**（Chrome 的侧栏打开方式随版本不同，以现场菜单为准，如实记录你用的方式）。
2. 侧栏打开后核对 **短码 / 连接状态** 与 popup 一致。
3. 在侧栏输入一段草稿 → 点击发送/填入 → 切到 OPS 桌面端，确认草稿出现在**原会话的输入台**且处于「待发送」（`96f5c03a` 已实现「侧栏草稿→原会话端到端」）。
4. 在 OPS 发起一个 run，从侧栏点 **停止** → 确认走的是既有 run cancel 语义，run 真的停了。
5. 截图：侧栏、OPS 输入台、停止前后状态。

---

## 第三组：需人工物理操作

> 这一组不依赖 API Key 和扩展，随时可以做，最容易先拿到「通过」。

### 3.1 T-AI27-26 视觉与可访问性

| 子项 | Windows 11 具体操作 | 通过判据 |
| --- | --- | --- |
| DPI 125% / 150% | `Win+I` → 「系统」→「屏幕」→「缩放」下拉，依次选 125%、150%；每改一次**完全退出并重启 OPS 桌面端**（Electron 需要重启才吃到新 DPI） | 工作视图四页签、输入台、按钮无溢出/重叠/裁切；所有按钮可点；截图存证 |
| 200% 文本 | `Win+I` → 「辅助功能」→「文本大小」→ 滑到 200% →「应用」；重启 OPS | 文字完整可读、不截断；输入框不被撑破 |
| 中文 IME | 切到中文输入法，在输入台和批注表单里**组字但不上屏**（候选菜单保持打开），按 `Enter` | 候选菜单打开时 `Enter` **只上屏、不发送消息**；再按一次 `Enter` 才允许发送。这是最容易出错的一项，务必录屏或连续截图 |
| 读屏器 | `Win+Ctrl+Enter` 启动 Narrator（或装 NVDA 后启动）→ 操作工作视图 → 触发一次 AI 回复 | `aria-live` 播报**不逐 token 朗读**、**不抢焦点**；键盘 Tab 顺序合理。记录用的是 Narrator 还是 NVDA、版本 |

每项做完把 DPI / 文本大小**改回原值**再重启一次，避免影响后续项。

### 3.2 T-AI27-23 安装与回退

1. **打包**（首次会下载 Electron 相关依赖，耗时较长）：

```powershell
cd F:\code\project\OPS\desktop
pnpm install --frozen-lockfile
pnpm --dir renderer-src install --frozen-lockfile
pnpm make
```

`make` = `build:renderer && build && electron-forge make --arch=x64`（`package.json:24`）。产物在 `desktop/out/make/`（Squirrel 安装包）。`docs/08:3607` 记录的 package 产物是 `desktop/out/OPS Desktop-win32-x64/OPS Desktop.exe`，可作对照。
2. **安装**：双击 `out/make/` 里的 `.exe` 安装 → 验证桌面快捷方式、开始菜单卸载入口、首次启动能连上本机 API。记录 Windows SmartScreen 是否弹出未签名提示——**当前无代码签名，这是预期**，`27 §15.4` 说如实说明即可，不是完成前提。
3. **升级**：改一个更高的版本号重新 `pnpm make`（或直接用现有的下一个构建）→ 覆盖安装 → 登录后确认：工作区、对话、素材、模型配置、证据**都还在**。升级前先备份 `%APPDATA%` 下 OPS 的数据目录（先 `dir` 找到实际目录名再 `Copy-Item -Recurse` 到证据目录外的安全位置）。
4. **卸载**：`Win+I` → 「应用」→「已安装的应用」→ 找到 OPS Desktop → 卸载。验证：OPS 组件被清除，但 **Chrome 本身、Chrome profile、扩展目录、你的第三方文档都保留**（`27 §15.4`）。卸载后按 §2.1 重新注册宿主即可回到开发环境。
5. 每一步都截图：安装包文件列表、安装完成页、SmartScreen 提示、升级前后数据对比、卸载确认页。

### 3.3 T-AI27-24 无沙箱启动

```powershell
cd F:\code\project\OPS\desktop
$env:OPS_DESKTOP_NO_SANDBOX = '1'
$env:OPS_DESKTOP_BRIDGE_DIAG = '1'
pnpm start
```

1. **保留启动终端的控制台输出**。`desktop/src/main.ts:282-283` 在这个组合下会打印：
   `[browser-bridge] OPS_DESKTOP_NO_SANDBOX=1：浏览器执行桥已关闭；恢复正常模式后重启以启用。`
   看到这行 + 桥没有监听任何端口（可用 `netstat -ano | findstr <端口>` 复核），才算通过。
2. 用 §2.2 的方式尝试配对 → 应**配不上**（桥没起）。
3. **恢复**：完全退出桌面端，关掉该终端，重开一个新终端（环境变量不继承），只设 `$env:OPS_DESKTOP_BRIDGE_DIAG='1'` 后 `pnpm start` → 桥应恢复、可配对。
4. 注意：`desktop/src/main.ts` 当前有**未提交改动**（见事实 6）。测之前 `git diff desktop/src/main.ts` 看一眼，确认 :282 那段闸门逻辑还在你测的这份代码里，并在证据里写明所测的 commit / 工作树状态。

### 3.4 T-AI27-33 WebContentsView 内的 IME / DPI

1. 桌面端 `/agent` → 工作视图 → 浏览器 tab → 用「应用内浏览面板」（`InBrowsePanel.tsx`）的地址栏打开一个**带表单的本地/公开网页**（例如带 `<input>` 的简单页面）。
2. 切到中文输入法，在该网页输入框里组字 → 观察**候选窗是否被原生视图遮挡**（这是 `WebContentsView` 与 React 层级的典型问题）。
3. 在「聊天输入区」和「浏览区」之间反复切换焦点 → 验证焦点归属正确、键盘输入落到预期区域。
4. 把系统缩放切到 150%（§3.1 方法）重启，重复第 2～3 步，确认候选窗位置与坐标换算正确。
5. 截图：候选窗打开状态（要能看清是否被切）、焦点高亮、150% 下的布局。

### 3.5 W17c UIA 真实旅程

1. **必须在正常桌面会话里跑**（不是 agent / 服务 / 远程无交互会话），否则 UIA 拿不到窗口。`docs/08` 里 `c530da34` 把 GUI 测试改 skip 就是因为这个会话隔离问题。
2. 打开 PowerShell：

```powershell
cd F:\code\project\OPS
powershell -NoProfile -ExecutionPolicy Bypass -File desktop/scripts/uia-notepad-manual.ps1
```

3. 脚本做的事（`uia-notepad-manual.ps1`）：启动 `C:\Windows\System32\notepad.exe` → 等 3 秒 → UIA 取控件树 → 找第一个 `Edit` 控件 → `ValuePattern.SetValue('W17c-UIA-TEST-INPUT')` → 读回 → 最后 `Stop-Process` 关掉记事本（**会强关它启动的那个记事本进程，别在跑之前打开你自己的重要记事本**）。
4. **期望输出**三行：
   - `WINDOW:...`（窗口标题，Windows 11 记事本可能是「无标题 - 记事本」）
   - `VALUE:W17c-UIA-TEST-INPUT`（读回与写入一致 → 通过）
   - 不应出现 `NOEDIT` 或 `ERR:...`
5. 若输出 `NOEDIT`：Windows 11 新版记事本用了不同控件结构，记录系统版本与输出，登记为「环境不兼容」，别改脚本硬凑。
6. **C01（三类应用）/ C03（IME/DPI）**：再选 2 个不同类型的应用（建议一个 Win32 传统窗口如「运行」对话框/计算器，一个 Chromium/Electron 应用），复制该脚本改 `Start-Process` 目标重复验证；在 150% DPI 与中文 IME 下各跑一次。注意脚本结尾会强关目标进程，**别指向你正在用的编辑器**。
7. 把三次完整控制台输出存成 `.txt` 放进证据目录。

---

## 第四组：可选深化（不需要你配合）

这是**开发待办**，不是验收动作，且不阻塞（`ai27-remaining-work.md:136` 原话：「不阻塞，按需立项」）。清单已过时，下面按 2026-11-09 的 Git 历史复核：

| 清单项 | 当前状态 |
| --- | --- |
| 内置浏览器多页签 | 已做：`0147eb7a DEV-AI27-08d`（上限 8 / 切换 / 相邻激活 / 逐 tab 代数） |
| frame 级校验 | 部分：`cd0a7afa DEV-AI27-08e` 做了 `observe_frames`；frame 级 click/type 仍缺 |
| 证据保留策略 | 已做：`b86cfdc5 DEV-AI27-09c`（24h 未引用回收） |
| goal/routine 浏览器路由 | 已做：`77645880 DEV-AI27-21A` |
| S05 前台互斥 | 已做：`9ed61a31 DEV-AI27-S05` |
| `mcp__*` 动态目录进 run 工具链 | 已做：`2d0f7a84 DEV-AI27-14d`（深化 5/5） |
| 下载管理 / 弹窗处理 / 浏览数据管理 / 委派产物跳转 / 扩展侧 frame 动作 | 仍待开发 |

要继续推进就按 `AGENTS.md` 一个任务一个提交，别顺手改。

---

## 5. 每完成一项的标准收尾动作

`ai27-remaining-work.md:158` + `docs/27 §17.3` 要求，缺一不可：

1. **写 `docs/08` 实施记录**，格式照 `docs/08` 现有 DEV-AI27 条目，至少包含：
   - 关联的 AI27 / T-AI27 编号；
   - 实际改动文件（人工项就写「无代码改动」）；
   - 启用条件（用的开关、环境变量、供应商类型、Chrome 版本）；
   - 正例 + 反例结果；
   - **证据层次**：真实 Chrome / 真实模型 / 模拟，分别标清楚；
   - 已知缺口、回退方式、提交编号。
2. **更新验收矩阵** `docs/acceptance/ai27-acceptance-matrix.md` 对应 ID 的状态为「通过」（或如实「部分」），并在「证据与剩余」列写明证据路径。
3. **同时更新** `docs/acceptance/ai27-remaining-work.md` 里该项，避免下次又做一遍。
4. **单任务提交**，信息写任务编号，例如 `DEV-AI27-26: DPI/IME/读屏人工验收`。提交前 `git diff` 复核：**只含当前任务文件，不夹带事实 6 里那批已有改动**。
5. 不要 push、不要 deploy。

---

## 6. 红线（做任何一项都适用）

- 不删 / 不跳 / 不放宽 HC-01～31 与 H-01～09。
- D-117 逐张执行不变：不加「全部起草 / 全部确认 / 全部入库 / 全部执行」按钮或接口。
- **真实密钥不进代码、日志、测试数据、文档、截图、提交信息**；证据 `result.md` 里只写「已配置真实供应商」，不写 Key。
- mock 通过不算真实验证；绿色测试不等于验收条件满足。
- 涉及真实平台登录一律用隔离测试账号，不用生产账号当回归夹具。
- 不为了拿绿色结果去改测试断言、吞异常或静默改状态。

---

## 附录 A：命令速查

| 用途 | 命令 |
| --- | --- |
| 起库 | `docker compose -f deploy/docker-compose.dev.yml up -d` |
| 起后端（带 AI27 全开关） | 见 §0.2 B |
| 起 Web | `cd web; pnpm dev` → `http://127.0.0.1:5173` |
| 起桌面 | `cd desktop; pnpm build:renderer; pnpm start` |
| 注册宿主 | `node desktop/src/native-host/register.cjs` |
| 撤销注册 | `node desktop/src/native-host/register.cjs --unregister` |
| 诊断模式 | `$env:OPS_DESKTOP_BRIDGE_DIAG='1'; pnpm start` |
| 无沙箱 | `$env:OPS_DESKTOP_NO_SANDBOX='1'; $env:OPS_DESKTOP_BRIDGE_DIAG='1'; pnpm start` |
| 打包 | `cd desktop; pnpm make` → `out/make/` |
| UIA | `powershell -NoProfile -ExecutionPolicy Bypass -File desktop/scripts/uia-notepad-manual.ps1` |
| 查 agent_chat 路由 | `docker exec ops-dev-postgres-1 psql -U ops -d ops -t -c "SELECT p.name FROM model_provider p JOIN model_route r ON r.provider_id=p.id WHERE p.status='active' AND p.execution_location='server' AND p.name NOT LIKE '%模拟%' AND r.task_type='agent_chat'"` |
| 查用量 | `docker exec ops-dev-postgres-1 psql -U ops -d ops -c "SELECT task_type, provider, model, status, prompt_tokens, completion_tokens FROM ai_call ORDER BY created_at DESC LIMIT 10"` |

## 附录 B：常见故障排查

| 现象 | 优先排查 |
| --- | --- |
| 页面里看不到浏览器协作 / 语音条 / 插件入口 | 后端没开对应开关（`/settings/admin` 逐项开），或 `OPS_AGENT_WORKBENCH_FEATURES` 被设成 `0/false/off`（紧急全关，会覆盖页面）。去掉该 env 后重启 API |
| 配了真实 Key，AI 对话仍是模拟回复 | `default` / `agent_chat` 路由还指向「本地模拟模型」，见 §1.2 |
| 自检工具调用失败 | 换支持 function calling 的模型；检查 `models` 数组里是否有该模型名 |
| `go test -run TestR0` 报「缺少 OPS_R_REAL_*」 | 这是设计行为：测试库与页面库隔离，必须在同一终端导出三个变量，见 §1.4.1 |
| Chrome 扩展点开显示「启动 OPS 桌面…以开始配对」 | 桌面端没带 `OPS_DESKTOP_BRIDGE_DIAG=1`，或同时带了 `NO_SANDBOX=1` |
| 扩展 ID 与 register.cjs 输出不一致 | 加载了别的目录 / 别的 manifest；移除扩展后重新加载 |
| Playwright / 本机健康检查一直 404 | 代理把回环接管了；设 `NO_PROXY=127.0.0.1,localhost,::1` |
| UIA 脚本输出 `NOEDIT` / `ERR` | 非交互会话，或 Win11 新记事本控件结构不同；换正常桌面会话，如实登记 |
| 语音条提示「未配置 ASR 供应商路由」（422 `voice_capability_unsupported`） | 正常报错：`asr` 不回退 `default`，需在「任务路由」单独配一条 ASR，见 §1.6 |
| 语音条提示「ASR 供应商调用失败」（502 `voice_provider_unavailable`） | 供应商层失败（模型名/密钥/协议不对）。回合已保留为 `error`，不会自动重传音频；改配置后重新录一条 |

## 附录 C：本手册的核查依据（文件 + 行号）

- `docs/acceptance/ai27-remaining-work.md`（清单原文）、`docs/acceptance/ai27-acceptance-matrix.md`（状态口径）
- `docs/27` §7.6 / §9.7 / §11.4.4 / §15.4 / §16.4 / §16.5 / §17.3（验收契约）
- `docs/08:3400-3425, 3647-3785`（DEV-AI27 实施记录与登记格式；末段为本轮补齐记录）
- `server/internal/app/env_test.go:50-157`、`jobs.go:163-207`（测试库隔离与模拟模型播种）
- `server/internal/app/r_real_journeys_test.go`（R 执行器：门控、`OPS_R_REAL_*` 注入、证据硬断言、R02 backdrop）
- `server/internal/app/agent_run_test.go:17-24`、`agent.go:236-239`（模型与路由回落）
- `server/internal/app/runtime_gates.go:22-148`、`agent_workbench.go:24-39`（功能开关）
- `web/src/pages/settings/Models.tsx:202-220, 254-308, 311-386, 537-598`（模型配置页实际操作路径）
- `desktop/renderer-src/src/App.tsx:139-171`、`web/src/App.tsx:100-129`（页面路由）
- `desktop/renderer-src/src/pages/settings/Admin.tsx`、`web/src/pages/settings/Admin.tsx` 的 `AGENT_FEATURE_LABELS`（19 项开关，逐项提交）
- `desktop/renderer-src/src/pages/agent/VoiceBar.tsx`、`server/internal/app/agent_voice.go`、`server/internal/ai/transcribe.go`、`00097_agent_voice_asr.sql`（语音：录音→ASR→可编辑终稿→记账）
- `desktop/src/mcp-host.ts:245-299`、`desktop/src/main.ts:280-286`（HTTP 传输 / 无沙箱闸门）
- `desktop/src/native-host/register.cjs:85-105`、`desktop/chrome-extension/README.md:15-27`、`desktop/scripts/uia-notepad-manual.ps1`（第二、三组脚本）
- `desktop/package.json:14-24`（脚本真实名称）
- `deploy/docker-compose.dev.yml`（容器与库名）、`git log` / `git status`（2026-11-09 工作树快照）
