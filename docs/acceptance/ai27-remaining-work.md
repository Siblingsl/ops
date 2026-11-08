# AI27 待完成项清单（移交后续单独完成）

生成：2026-11-08 ｜ 前序：35 包提交（e8778035 → b86cfdc5），main 分支未 push
配套文档：[ai27-acceptance-matrix.md](ai27-acceptance-matrix.md)（全系列状态）｜ [docs/08](../08-开发与测试计划.md)（各批实施记录）｜ [docs/AI_HANDOFF.md](../AI_HANDOFF.md)（交接日志）

本清单覆盖 docs/27 v0.2 中**所有未完成项**，按阻塞源分四组。每组列出：验收 ID、缺什么、已就位的部分、执行步骤、涉及文件与命令。完成一项后请在 docs/08 登记并将验收矩阵对应 ID 状态更新为"通过"。

---

## 第一组：需真实模型 API Key（最先做——解开后可跑 R 系列）

### 准备步骤

1. 打开 OPS 模型配置页（`http://127.0.0.1:5173/settings/models` 或桌面端）
2. 添加真实供应商（如 OpenAI / Anthropic / DeepSeek），填 base_url + API Key
3. 添加支持工具调用的模型（如 `gpt-4o`、`claude-sonnet-4-20250514`、`deepseek-chat`）
4. 点"自检"通过；确认 agent_chat 路由指向它
5. 本地库验证：`docker exec ops-dev-postgres-1 psql -U ops -d ops -t -c "SELECT p.name FROM model_provider p JOIN model_route r ON r.provider_id=p.id WHERE p.status='active' AND p.execution_location='server' AND p.name NOT LIKE '%模拟%' AND r.task_type='agent_chat'"`——应返回供应商名

### R01~R05 运营任务旅程（T-AI27-07/20 + §16.4 R 系列 + §9.7）

**执行命令**：
```bash
cd server
OPS_R_REAL_ACCEPTANCE=1 OPS_R_REAL_OUTPUT=output/r-journeys \
  go test ./internal/app -run 'TestR0' -v -count=1 -timeout=60m
```

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
| V05 | ASR/TTS/realtime 分别自检 | 在模型配置页为语音任务类型添加真实 ASR 供应商并自检；验证 `desktop/src/business-ui-preload.ts` 的 VoiceBar 链路从录音→转写→终稿 |
| V07 | ASR 时长/TTS 量分别记账 | 参考 V05；验证 `agent_voice_turn` 关联 run 的用量字段 |
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

| 项 | 说明 | 涉及文件 |
| --- | --- | --- |
| 多页签拖拽排序 | 页签条 `inbrowse-tabs` 加 drag-and-drop | `desktop/renderer-src/src/pages/agent/InBrowsePanel.tsx` |
| 内置浏览器下载管理 | WebContentsView session 的 will-download 事件→逐文件确认 | `desktop/src/in-browse.ts` |
| 弹窗处理 | `setWindowOpenHandler` 策略（当前默认拒绝） | 同上 |
| 浏览数据管理 | 设置中区分"OPS 证据"与"浏览实例数据"清理 | 同上 + renderer 设置页 |
| 委派结果产物跳转 | 任务面板结果→产物页跳转 | `DelegationPanel.tsx` + `ArtifactPanel.tsx` |
| `mcp__*` 动态目录进 run 工具链 | 插件连接的 MCP 工具动态注册为模型工具 | `agent_tools_ai27.go` + `agent_dispatch.go` |
| goal/routine 浏览器 grant 派生租约 | goal 续跑时自动继承/重新签发浏览器租约 | `agent_delegation_dispatch.go` + `agent_browser.go` |
| 扩展 run 工具链 `mcp__*` | Chrome 扩展侧调用 MCP 工具（远期） | `chrome-extension/background.js` |
| Chrome 扩展 frame 级 click/type | observe_frames 已做，click/type 的跨 frame 版本待做 | `chrome-extension/background.js` |

---

## 红线提醒（完成任何一项时都适用）

- 不删/跳/放宽 HC-01～31 与 H-01～09
- 逐张执行 D-117 不变
- 真实密钥不进代码/日志/测试数据/文档
- mock 通过不算真实验证
- 完成一项 → docs/08 登记 + 验收矩阵状态更新 + 单任务提交
