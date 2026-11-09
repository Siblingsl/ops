# AI27 待完成项清单（移交后续单独完成）

生成：2026-11-08 ｜ 前序：35 包提交（e8778035 → b86cfdc5），main 分支未 push
配套文档：[ai27-acceptance-matrix.md](ai27-acceptance-matrix.md)（全系列状态）｜ [docs/08](../08-开发与测试计划.md)（各批实施记录）｜ 当前仓库**没有** `docs/AI_HANDOFF.md`，交接状态以 docs/08 + 验收矩阵 + Git 为准

> **2026-11-09 代码补齐（不改变「需真实环境」的性质）**：
> 1. R 系列执行器改为**运行时环境变量注入真实供应商**（测试库与页面库隔离问题已修），并把「证据可回查」「§9.7 字段」从只记录升级为硬断言；
> 2. 双端 `/settings/admin` 补齐 8 个 AI27 工作台开关（此前只能靠 `OPS_AGENT_WORKBENCH_FEATURES` 环境变量）；
> 3. 语音 ASR 链路实现：`asr` 任务路由 + `/audio/transcriptions` 调用 + `asr_model`/`asr_seconds` 记账 + 失败回合保留。
>
> 以上只把阻塞收敛为「需要真实 Key / Chrome 扩展 / 人工操作」，**不等同验收通过**；TTS、realtime 音频桥、MCP OAuth 仍未实现。详见 docs/08 的「DEV-AI27-16 第四批」「DEV-AI27-R 执行器修复」「DEV-AI27 开关面补齐」三条记录。

本清单覆盖 docs/27 v0.2 中**所有未完成项**，按阻塞源分四组。每组列出：验收 ID、缺什么、已就位的部分、执行步骤、涉及文件与命令。完成一项后请在 docs/08 登记并将验收矩阵对应 ID 状态更新为"通过"。

---

## 第一组：需真实模型 API Key（最先做——解开后可跑 R 系列）

### 准备步骤

1. 打开 OPS 模型配置页（`http://127.0.0.1:5173/settings/models` 或桌面端）
2. 添加真实供应商（如 OpenAI / Anthropic / DeepSeek），填 base_url + API Key
3. 添加支持工具调用的模型（如 `gpt-4o`、`claude-sonnet-4-20250514`、`deepseek-chat`）
4. 点"自检"通过；确认 agent_chat 路由指向它
5. 本地库验证：`docker exec ops-dev-postgres-1 psql -U ops -d ops -t -c "SELECT p.name FROM model_provider p JOIN model_route r ON r.provider_id=p.id WHERE p.status='active' AND p.execution_location='server' AND p.name NOT LIKE '%模拟%' AND r.task_type='agent_chat'"`——应返回供应商名。**注意**：这条只验证运行中的 `ops` 库；`go test` 使用每次重建的 `ops_test` 库，看不到页面配置（见下方 R 系列）。

### R01~R05 运营任务旅程（T-AI27-07/20 + §16.4 R 系列 + §9.7）

**执行命令（2026-11-09 起）**：

```bash
cd server
# go test 使用独立的 ops_test 库（每次 TestMain 重建），模型配置页写入的 ops 库对它不可见。
# 因此真实供应商必须经运行时环境变量注入；密钥只在本机终端设置，不写入代码/日志/证据。
export OPS_R_REAL_BASE_URL='https://api.example.com/v1'
export OPS_R_REAL_API_KEY='<本机终端临时设置，不要粘贴到文档、截图或提交信息>'
export OPS_R_REAL_MODEL='支持工具调用的模型名'
export OPS_R_REAL_ACCEPTANCE=1
export OPS_R_REAL_OUTPUT='output/r-journeys'
go test ./internal/app -run 'TestR0|TestRReal' -v -count=1 -timeout=60m
```

- `TestR0` 是五个真实旅程；`TestRReal` 是**不产生费用**的离线契约测试（验证环境解析、密钥加密、证据/字段硬断言本身有效），建议一起跑。
- 相对路径以 `server/` 为工作目录，证据实际落在 `server/output/r-journeys/r-journeys.jsonl`。
- R02 仍需额外 `export OPS_R_REAL_BACKDROP=1`。
- 现在的断言：assistant 非空 + **至少一条可回查证据**（origin / 脱敏 URL / 读取时间，且未被隔离）+ §9.7 字段关键词齐全。缺任一项直接 fail，不再「只记录不判定」。
- 局限（如实登记）：字段校验仍是文本关键词级，不是结构化报告解析；它能拦住字段缺失的假通过，拦不住「字段齐全但内容编造」——后者靠证据回查与人工审阅。

**覆盖**：

| ID | 场景 | 任务内容 | 通过标准（§9.7 报告契约） |
| --- | --- | --- | --- |
| R01 | 竞品研究并整理素材 | 选公开账号读 3 篇→对照主题/结构/表达→素材候选 | 对照表+来源 URL+读取时间+借鉴/不可照搬分列；不自动入库 |
| R02 | 本人后台分析 | 授权后台→读数据→核对图表 | 数字附来源+缺失如实标 missing；不执行发布。**额外要求：先在 Chrome 登录后台并设 `OPS_R_REAL_BACKDROP=1`** |
| R03 | 网页资料改稿 | 读公开网页→区分事实/观点→新版文稿 | 差异对照+逐段理由+来源回链；不执行作品写入 |
| R04 | 热门话题分析 | 榜单/检索→排序与时点 | 线索附来源与时点；"页面可见样本"而非全平台 |
| R05 | 商品内容机会 | 商品页→卖点/价格/人群 | 对照附价格/货币/观测时间；未读取数据如实标缺失 |

每场景 ≥3 次，结果 JSONL 落 `OPS_R_REAL_OUTPUT` 目录。**这不是夹具页测试**——每场景必须产生真实来源引用。

**完成标准**：5 场景 × 3 次全部通过（报告字段契约成立+证据可回查）→ T-AI27-07/20 状态→通过，R01~R05→通过。

### T-AI27-20 费用记账

真实供应商用量进入共享预算账本（W06b 已实现预留/扣减骨架）。执行 R 旅程时观察 `agent_run` 的 prompt_tokens/completion_tokens 是否累计——如未自动累计需接真实供应商用量回执（参考 `internal/app/agent_run.go` 的 rounds/prompt_tokens 字段更新逻辑）。

### V05/V07/V08 语音真实供应商

| ID | 内容 | 执行步骤 |
| --- | --- | --- |
| V05 | ASR/TTS/realtime 分别自检 | **ASR 链路已实现（2026-11-09）**：模型配置页「任务路由」展开后新增「ASR 语音转写」，选供应商 + 转写模型即可；VoiceBar 录音 → 上传 → 服务端调 `/audio/transcriptions` → 可编辑终稿。仍需真实 Key 实测。**TTS / realtime 自检仍无调用点**（未实现）。 |
| V07 | ASR 时长/TTS 量分别记账 | ASR 回执的 `asr_model` / `asr_seconds` 已写入 `agent_voice_turn`（失败时写 `asr_error_code`）；**TTS 生成量、realtime 音频 token 与任务总预算接入仍未实现**。 |
| V08 | 真实语音旅程 | 用麦克风跑完整旅程（录音→转写→编辑→发送→AI 理解正确）；覆盖中英文、数字/否定句、噪声误识别、用户纠正（§11.4.4） |

### P01 OAuth

真实 OAuth 服务旅程（MCP HTTP 传输 + OAuth 授权）。执行步骤：搭建或使用公开 MCP HTTP 服务器（如 [MCP Inspector](https://github.com/modelcontextprotocol/inspector) 的示例）→ OPS 插件管理页添加 http 连接 → 验证 OAuth 流程 → 双传输 P01 关闭。工具：`desktop/src/mcp-host.ts` 的 `McpHttpConnection` 已实现（单测覆盖传输层）。

---

## 第二组：需 Chrome 扩展加载 + 真实站点

### 准备步骤

```bash
node desktop/src/native-host/register.cjs
```
然后 Chrome → `chrome://extensions` → 开发者模式 → "加载已解压的扩展程序" → 选择 `desktop/chrome-extension/`。扩展 ID 为固定值（register.cjs 输出）。

### T-AI27-11 登录/MFA（§16.2）

1. 在 Chrome 中打开一个有登录/MFA 的站点（如 GitHub）
2. 通过 OPS 发起浏览任务到该站点
3. 验证：MFA 阶段 AI 暂停 DOM/截图（27 §7.6）→ 人工完成登录 → 交回 AI 恢复读取
4. 检查密码/MFA 码没有进入任何模型请求或日志

### 旅程 A/B/C/E 完整版（§16.5）

| 旅程 | 步骤 |
| --- | --- |
| A 公开资料研究 | 两篇真实网页→比较→未授权站点暂停→报告有来源→不入库 |
| B 登录态研究 | 登录站点→MFA 人工→读取→撤销权限→后续读取拒绝 |
| C 页面反馈改文稿 | 选网页段落批注→产物 v2→单作品卡片→逐张执行→API 读回 |
| E 恶意与越权 | 隔离页面放诱导内容→宿主/扩展拒绝→解释受限范围 |

每旅程完成后在 docs/08 登记（含截图/日志）。

### W10 侧栏真实旅程

Chrome 扩展图标点击 → 侧栏打开 → 核对短码/状态 → 输入草稿 → 验证草稿填入 OPS 输入台 → 停止按钮生效。

---

## 第三组：需人工物理操作

### T-AI27-26 视觉与可访问性

| 项 | 步骤 |
| --- | --- |
| DPI 125%/150% | Windows 设置→显示→缩放→切换→打开 OPS 桌面端→验证无溢出/按钮可点 |
| 200% 文本 | 设置→辅助功能→文本大小→200%→验证可读性 |
| 中文 IME | 在输入台/批注表单用中文输入法组字→按 Enter 验证不发送（候选菜单打开时） |
| 读屏器 | 开启 Narrator/NVDA→操作工作视图→验证 aria-live 播报不逐 token 朗读、不抢焦点 |

### T-AI27-23 安装与回退

| 项 | 步骤 |
| --- | --- |
| 打包 | `cd desktop && pnpm make` → `out/make/` 生成安装包 |
| 安装 | 运行安装包→验证桌面快捷方式/卸载入口 |
| 签名 | 当前无代码签名（27 §15.4：如实说明即可，非完成前提） |
| 升级 | 新版本覆盖安装→验证数据保留 |
| 卸载 | 系统卸载→验证 OPS 组件清除但 Chrome/profile 数据保留 |

### T-AI27-24 无沙箱启动

```bash
OPS_DESKTOP_NO_SANDBOX=1 OPS_DESKTOP_BRIDGE_DIAG=1 pnpm start
```
验证：浏览器桥**不启动**（console 输出关闭原因）；恢复正常模式（去掉 NO_SANDBOX）重启后桥恢复。

### T-AI27-33 IME/DPI（WebContentsView 内）

在内置浏览视图打开带表单的网页→中文输入法组字→验证候选窗不被原生视图遮挡→验证焦点在聊天区/浏览区切换正确。

### W17c UIA 真实旅程

在正常桌面会话（非 agent 环境）运行：
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File desktop/scripts/uia-notepad-manual.ps1
```
验证：记事本启动→UIA 读控件树→SetValue 写入→读回匹配。C01（三类应用）/C03（IME/DPI）需额外选 2 个应用重复。

---

## 第四组：可选深化（不阻塞，按需立项）

| 项 | 说明 | 涉及文件 | 2026-11-09 状态 |
| --- | --- | --- | --- |
| 多页签拖拽排序 | 页签条 `inbrowse-tabs` 加 drag-and-drop | `desktop/renderer-src/src/pages/agent/InBrowsePanel.tsx` | 工作树有未提交改动（`reorderTab` + IPC + DnD），未验收 |
| 内置浏览器下载管理 | WebContentsView session 的 will-download 事件→逐文件确认 | `desktop/src/in-browse.ts` | 工作树有未提交改动，未验收；其快照推送方式需复核，勿直接提交 |
| 弹窗处理 | `setWindowOpenHandler` 策略（当前默认拒绝） | 同上 | 未做 |
| 浏览数据管理 | 设置中区分"OPS 证据"与"浏览实例数据"清理 | 同上 + renderer 设置页 | 未做 |
| 委派结果产物跳转 | 任务面板结果→产物页跳转 | `DelegationPanel.tsx` + `ArtifactPanel.tsx` | 工作树有未提交改动，未验收 |
| `mcp__*` 动态目录进 run 工具链 | 插件连接的 MCP 工具动态注册为模型工具 | `agent_tools_ai27.go` + `agent_dispatch.go` | 已提交 `2d0f7a84`（深化 5/5） |
| goal/routine 浏览器 grant 派生租约 | goal 续跑时自动继承/重新签发浏览器租约 | `agent_delegation_dispatch.go` + `agent_browser.go` | 路由已提交 `77645880`；租约派生未做 |
| 扩展 run 工具链 `mcp__*` | Chrome 扩展侧调用 MCP 工具（远期） | `chrome-extension/background.js` | 未做 |
| Chrome 扩展 frame 级 click/type | observe_frames 已做，click/type 的跨 frame 版本待做 | `chrome-extension/background.js` | `observe_frames` 已提交 `cd0a7afa`；click/type 未做 |

---

## 红线提醒（完成任何一项时都适用）

- 不删/跳/放宽 HC-01～31 与 H-01～09
- 逐张执行 D-117 不变
- 真实密钥不进代码/日志/测试数据/文档
- mock 通过不算真实验证
- 完成一项 → docs/08 登记 + 验收矩阵状态更新 + 单任务提交
