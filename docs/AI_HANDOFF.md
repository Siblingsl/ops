# OPS 项目交接：桌面客户端从 `web/` 独立迁入 `desktop/`

## 2026-11-08 深化五项全部完成（第三类可选深化 1~5/5）

**本批范围**：①多页签拖拽排序（HTML5 DnD + reorder-tab IPC + 单测）；②内置浏览器下载管理（will-download 逐文件确认+原生保存对话框）；③弹窗处理（setWindowOpenHandler deny+当前/新页签内导航）；④委派结果产物跳转（DelegationPanel onNavigateArtifact→产物 tab）；⑤mcp__* 动态目录进 run 工具链（agentMCPDynamicToolsForWorkspace 按 enabled 连接实时生成模型工具项）。

**验证证据**：desktop **265/265**（含 reorder 单测）；renderer typecheck/38/38/守卫 7/7。

**状态**：深化 1~5 全部完成并验证。**累计 37 包。**剩余：R01~R05（待真实供应商+扩展加载）、主验收物理项、真实 ASR/OAuth、mcp__* dispatch 端到端（待真实 MCP 服务器）。


## 2026-11-08 W09c 证据保留策略（第三类 9/9 完成）

**本批范围**：CleanupStaleBrowserEvidence（24h 未引用回收+批注引用保留，挂 RunJobs）+ TestW09EvidenceRetention；候选提炼时机（run 结束自动触发）已由 W06c 桥接实现。

**验证**：TestW09 3/3；TestHC 全量；组合回归通过。T-AI27-32 部分→**通过**。**第三类 9/9 全部完成。累计 35 包。**

**剩余**：R01~R05 真实旅程（待真实供应商 API Key + Chrome 扩展加载）、主验收物理项（DPI/IME/读屏/签名/无沙箱）——全部需用户输入/配合。


## 2026-11-08 T-AI27-21A goal/routine 路由（第三类 8/9）

**本批范围**：agent_modes.go 讨论/计划/goal 模式浏览器 R 类可见性（27 §8.6 表格行）+ routine 白名单结构断言。

**验证**：TestW06 5/5；TestHC 全量。**第三类 8/9 完成。**下一项：证据保留策略。


## 2026-11-08 S05 前台互斥（第三类 7/9）

**本批范围**：computer/browser grant 双向前台互斥（409 computer_foreground_busy / browser_lease_conflict）；撤销后恢复全周期验证。

**验证**：TestS05 1/1；TestW17/W04 回归；TestHC 全量。**第三类 7/9 完成。**下一项：goal/routine 路由。


## 2026-11-08 W17c UIA 动作执行桥（第三类 6/9）

**本批范围**：computer-worker.js UIA 桥（uia_read 控件树/uia_invoke SetValue+Invoke，硬禁区纵深）+ uia-notepad-manual.ps1 人工验证脚本。

**限制（如实登记）**：真实 GUI 旅程受 ZCode 会话隔离限制——agent 会话启动的 notepad 立即退出。UIA 桥已实现；脚本就位待用户桌面会话执行。

**验证**：worker 3/3 回归；typecheck 0 错。**第三类 6/9 完成（代码+脚本就位，物理旅程待人工）。**下一项：S05 互斥。


## 2026-11-08 T-AI27-16 关闭：失权竞态注入矩阵（第三类 5/9）

**本批范围**：agent_revoke_injection_test.go——4 场景（撤权/到期/丢包/级联）系统化注入验证；T-AI27-16 部分→**通过**。

**验证**：TestW16Scenario 4/4；TestHC 全量；组合回归通过。**第三类 5/9 完成。**下一项：W17 UIA 动作执行。


## 2026-11-08 frame 级校验（第三类 4/9，T-AI27-08）

**本批范围**：扩展 observe_frames（allFrames，跨域子 frame 默认 origin_only 隔离）+ 服务端目录登记。

**验证**：真实 Chrome E2E 1/1 回归；263/263；TestW06+HC28。**第三类 4/9 完成。**下一项：失权丢包注入矩阵。


## 2026-11-08 W04c 首次连接向导 UI（第三类 3/9）

**本批范围**：BrowserStatusBlock unpaired 态接 PairingWizard（POST pairings→短码展示/过期重生成→扩展核对→本机确认）。

**验证**：renderer 38/38+守卫 7/7。**第三类 3/9 完成。**下一项：frame 级校验。


## 2026-11-08 W09b 来源子页 UI（第三类 2/9）

**本批范围**：SourcePanel.tsx——产物 tab 下半区：证据列表（隔离标记不给正文）+批注记录与创建表单；Agent.tsx 接线。

**验证**：renderer 38/38+守卫 7/7；desktop 263/263。**第三类 2/9 完成。**下一项：W04 连接向导 UI。


## 2026-11-08 W10b 侧栏草稿→原会话端到端（第三类 1/9）

**本批范围**：桥收 sidepanel draft/stop→转发业务窗深链；preload 两订阅；Agent.tsx 草稿填入输入台（用户手动发送）+stop 同语义。

**验证**：desktop 263/263、renderer 38/38+守卫 7/7。**第三类 1/9 完成。**下一项：W09 UI 接线。


## 2026-11-08 DEV-AI27-06 第三批：内置页 AI 动作执行器

**本批范围**：in-browse.ts 五方法动作执行器（observe/click/type/extract/screenshot，包内登记函数 executeJavaScript 执行，密码控件拒绝/doc_rev 失效/协议白名单同扩展语义）+ DOM stub 单测 4/4（零新增依赖）。

**验证证据**：desktop typecheck 0 错、**263/263**。

**状态**：W06=部分实现（三批）；run 内端到端 dispatch 待真实供应商（R 旅程验证）。**累计 34 包。**


## 2026-11-08 DEV-AI27-10 side panel 与通知投影（第一批）

**本批范围**：扩展 side panel（状态/草稿/停止/打开 OPS；无独立会话副本；未配对如实禁用）；background 三意图路由；服务端通知投影三处（delegation 取消/voice 结束/computer 接管→定向 notify 去重键）。

**验证证据**：desktop typecheck 0 错；TestW15/16/17+HC28 回归通过；manifest 合规复验。

**状态**：W10=部分实现（第一批）；真实 side panel 旅程待扩展加载。**累计 33 包。**剩余：R01~R05（待真实供应商+扩展加载）、主验收物理项。


## 2026-11-08 DEV-AI27-08d 内置浏览视图多页签（27 §7.8 标签页管理）

**本批范围**：InBrowseViewController 多页签化（上限 8/切换/相邻激活/逐 tab 导航代数/detach 保留全部页签）；IPC 三条新意图（open-tab/switch-tab/close-tab，close 兼容改关活动签）；InBrowsePanel 页签条 UI；快照结构升级（tabs[]/activeTabId）。

**验证证据**：desktop **259/259**（in-browse 5/5）；renderer 38/38+守卫 7/7；真实 Electron E2E 1/1（15.5s）。修复：closeTab 相邻激活 null（idx 在 filter 前捕获）。

**状态**：W08=部分实现（四批）；拖拽排序/下载/弹窗管理、IME/DPI 人工项属后续。**累计 32 包。**剩余：R01~R05（待真实供应商+扩展加载）、主验收物理项。


## 2026-11-08 AI27 验收矩阵生成 + W15c 任务面板（累计 31 包）

**本批范围**：DelegationPanel.tsx（协作区折叠/展开/单项停止，5s 轮询委派组 API）；`docs/acceptance/ai27-acceptance-matrix.md`——T-AI27-01~35+M/P/S/V/C+R 全系列状态汇总（通过/部分/未执行+证据+剩余），待办按阻塞源分组（需 API Key/需扩展加载/需人工/可继续开发）。

**当前全景**：W02~W17 全部有实现+验证；HC/守卫/E2E 全绿。剩余四组：需 API Key（T-07/20、R 系列、V05/07/08、P01-OAuth）、需扩展+真实站点（T-11、旅程 A/B/C/E）、需人工（T-26/23/24/33 物理项）、可继续开发（多页签/W10/S05）。


## 2026-11-08 DEV-AI27-15 第三批：任务面板协作区 UI

**本批范围**：DelegationPanel.tsx——折叠态/展开态/单项停止（27 §11.3.1），接 runs/{id}/delegations（5s 轮询），无委派组不渲染；Agent.tsx 任务 tab 接线。

**验证证据**：renderer typecheck 0 错、38/38、守卫 7/7。

**状态**：W15=部分实现（三批）；S05 互斥属后续。剩余：R01~R05（待真实供应商+扩展加载）、主验收物理项、多页签、真实 ASR/OAuth。**累计 30 包。**


## 2026-11-08 DEV-AI27-W1xc 第三批：语音条链路 + 插件页 E2E

**本批范围**：VoiceBar 重写（MediaRecorder 不落盘→voice-sessions/turns→reviewable 编辑→插入输入框；权限/上限/未接 ASR 三态如实）+ Agent.tsx 接线；plugins-settings.spec.ts 管理页 E2E 1/1（全状态机+秘密零值）；server 修 env_keys nil 500（E2E 暴露）。

**验证证据**：desktop 258/258、renderer 38/38+守卫 7/7、E2E 1/1、TestW14 2/2、TestHC 全量。

**状态**：W14/W16 均为部分实现（第一~三批）；剩余：真实 ASR/OAuth 供应商（需密钥）、W15 任务面板 UI、多页签、R01~R05、主验收物理项。累计 **29 包**。


## 2026-11-08 DEV-AI27-08 第三批：浮层挂点 + 真实 Electron 视觉旅程

**本批范围**：main.ts 设置浮层 detach/attach 挂点（原生视图层级规则 27 §5.6 落地）；inbrowse-real-electron.spec.ts 真实 Electron 旅程 1/1（导航/快照推送/关闭清空/浮层周期）。

**验证证据**：desktop 258/258、renderer 38/38+守卫 7/7、真实 Electron E2E 1/1（Windows 10.0.26200 + Electron 44.9.1）。

**状态**：W08=部分实现（三批）；多页签与 IME/DPI 人工项属后续。**内置浏览器（Codex 同款）现已可用**：OPS 桌面端 → 工作视图 → 浏览器页签 → 下方应用内浏览面板。剩余：R01~R05（待真实供应商 API Key + 扩展加载）+ 主验收物理项。


## 2026-11-08 DEV-AI27-08 第二批：固定 IPC 接线与渲染器浏览 UI

**本批范围**：main.ts 8 条 inbrowse:* 固定意图（业务窗口主框架来源校验+快照推送）；preload 白名单桥（invokeInBrowse/onInBrowseSnapshot，契约测试同步登记）；InBrowsePanel.tsx（地址栏/后退/前进/刷新/停止/关闭/标题行，Web 端如实显示无本机能力）；Agent.tsx 浏览器 tab 双路径并存（上：扩展协作，下：应用内浏览）。

**验证证据**：desktop typecheck 0 错、test **258/258**（preload 契约含 2 新 API）；renderer typecheck 0 错、test:unit **38/38**、守卫 **7/7**。

**下一步（W08 第三批）**：审批浮层 detach 挂点、多页签、T-AI27-33 真实 Electron 视觉旅程。R01~R05 仍待真实供应商+扩展加载。


## 2026-11-08 D-172 裁决修正 + DEV-AI27-08 W08 内置浏览视图（第一批）

**D-172（用户裁决，修正 D-170/D-171）**：用户要"右侧内置浏览器"= Codex 同款。事实核实（27 §2.2 + W03）：Codex 右侧内置浏览器即 Chromium 内核视图；用户排除"Chromium 冒充"指禁止冒充完整 Chrome 产品，非禁止应用内浏览承载。**裁决：双路径并存**——①W08 恢复：WebContentsView 内置浏览视图（Codex 同款技术）；②扩展+NM 真 Chrome 路线保留（登录态任务）。T-AI27-02 重定义="Codex 同款双路径架构完整交付"。

**W08 第一批**：in-browse.ts——InBrowseViewController（WebContentsView 挂载/独立 ops-inbrowse 会话/导航代数递增/协议白名单 http+https/detach-attach 浮层隐藏/detached 拒导航/宽度钳制）+ 单测 4/4 + desktop 258/258。

**下一步（W08 第二批）**：main.ts 固定 IPC 接线（set-bounds/navigate/back/forward/reload/close + 审批浮层 detach 挂点）；渲染器工作视图"应用内"浏览 UI（27 §7.8 地址栏/标签/历史步进）；T-AI27-33 真实 Electron 视觉旅程。R01~R05 仍待真实供应商+扩展加载（执行器已就位 a685078c）。


## 2026-11-08 DEV-AI27-R01~05 真实旅程执行器就位（待真实环境）

**本批范围**：r_real_journeys_test.go——R01~R05 五个真实旅程测试（每场景 ≥3 次迭代、§9.7 字段校验、JSONL 证据），门控默认 skip 不出网不虚报；当前本地库仅有模拟模型，SKIP 验证通过。

**待执行（阻塞于用户输入）**：①真实模型 API Key（模型配置页添加并自检）；②安装版 Chrome 人工加载扩展（R01/R03/R04 Chrome 旅程）；③R02 需用户登录后台并授权。环境就绪后执行：`OPS_R_REAL_ACCEPTANCE=1 OPS_R_REAL_OUTPUT=<目录> go test ./internal/app -run 'TestR0' -v -count=1 -timeout=60m`。

**状态**：R 系列执行器=代码已实现+门控验证；真实旅程=未执行（等环境）。


## 2026-11-08 DEV-AI27-12 安装矩阵（第一批：打包+版本握手+manifest 合规）

**本批范围**：electron-forge package 成功（OPS Desktop.exe）；版本握手三端 v1 一致静态校验；扩展 manifest MV3 合规静态检查；register.cjs 补打包/卸载说明。

**未实现（需本机人工操作）**：安装版 Chrome 人工加载扩展、代码签名（无签名，如实说明）、升级/卸载实测、无沙箱环境桥闸门实测。

**状态**：W12=部分实现（第一批）。至此 W02~W17 全部有代码实现并验证（部分为第一批）。**剩余全部为需真实环境的旅程**：R01~R05（真实模型+真实 Chrome+真实网页，产生 API 费用）、主验收物理项（DPI/IME/读屏/人工加载扩展）。


## 2026-11-08 DEV-AI27-11 Web 共享契约兼容（第一批）

**本批范围**：web 全量回归（typecheck/单测 42/42/守卫 7/7/agent-goals E2E 1/1）；修复既有 Web 边界守卫失败（agent-goals 用桌面 testid 探测布局→改桌面专用按钮探测）；结构断言 Web 源码零本机权限引用（T-AI27-22）。

**状态与下一步**：W11=部分实现（历史证据降级展示属后续）。下一包：**W12（安装矩阵：electron-forge 构建/host manifest 集成/版本握手/升级卸载）**。


## 2026-11-08 DEV-AI27-09 浏览器证据与页面批注

**本批范围**：迁移 00096（agent_browser_evidence + agent_browser_annotation）；API 四条（evidence 创建须挂本人真实 command/密钥命中隔离/事件投影、按 run 过滤查询、annotation 创建与查询）；HC-28 登记 4 路由。

**验证证据**：go build/vet；TestW09 2/2（真实命令关联/伪造拒绝/隔离/过滤/事件/跨用户；批注无消息产生/关联/404 不误绑）；TestHC28、TestHC 全量、全 W 组合回归通过。

**状态与下一步**：W09=部分实现（第一批）；来源页 UI 与产物对照属后续。下一包：**W11（Web 兼容）** 或 **W12（安装矩阵）**。


## 2026-11-08 DEV-AI27-17b 隔离执行 worker 与窗口枚举

**本批范围**：computer-worker.js（双宿主兼容 utilityProcess/fork；list_windows 真实 PowerShell 窗口枚举+硬禁区标记+脱敏；未选清单不上传服务端 C09）+ ComputerWorkerHost（fork 宿主桥，固定 {id,cmd} 协议，超时/退出回收）+ 真实子进程测试 3/3。

**验证证据**：desktop typecheck 0 错、pnpm test **254/254**（含真实 Windows 窗口枚举，Node 22.22.1 + Windows 10.0.26200）。过程修复：parentPort 在 fork 宿主不存在导致 worker 立即退出（改双宿主兼容）。

**状态与下一步**：W17=部分实现（第一、二批）；UIA 动作执行与选窗器 UI 接线属后续。下一包：**W09（引用/证据/批注/产物闭环）**。


## 2026-11-08 DEV-AI27-15b 子 run 派发执行（真实模型循环打通）

**本批范围**：agent_delegation_dispatch.go——委派派发（创建子 run/回填 child_run_id/后台启动模型循环）、子 run 以父身份运行（identity 注入）、模型继承（空名继承父 run、按名解析 provider）、watchDelegationChild（子终态→委派 succeeded/failed→组 completed）、父 run 活动位避让。

**验证证据**：go build/vet；**TestW15b 端到端通过**（委派→mock 模型子 run 循环→assistant 消息落库→委派 succeeded→组 completed）；TestW15 3/3、TestHC 全量、W13~W17+W04+W06 组合回归通过。过程修复：占位回填跳过 dispatch（测试改真实 API）、agentModelRef 缺 ProviderID（ai27ResolveModelRef 按名解析）、identity 缺失 panic（注入父身份）。

**状态与下一步**：W15=部分实现（第一、二批）；父 run 挂起/续接与任务面板 UI 属后续。下一包：**W17b（选窗器与 UIA 执行 worker）**。


## 2026-11-08 DEV-AI27-07b 浏览器页签选择器与语音条组件

**本批范围**：renderer-src 新组件 BrowserTabSelector（paired 态标签选择器，W04 命令账本 tabs_list 派发）+ VoiceBar（四态语音输入条组件，转写终稿可编辑，红线：语音不构成确认）；Agent.tsx 浏览器 tab 接线（paired 态渲染 BrowserTabSelector）。

**验证证据**：pnpm typecheck 0 错；test:unit 40/40；边界守卫 7/7。

**状态**：W07=部分实现（第一、二批）。VoiceBar compose 区接线属 W16 第二批完整语音条 UI。累计提交 **16 包**（含 D-171）。下一候选：W13b（消息内候选卡）、W14b（HTTP 传输+管理 UI）、W15b/W16b/W17b、W09~W12。

## 2026-11-08 DEV-AI27-06 第二批：工具链接线与共享预算

**本批范围**：迁移 00093 更新（agent_delegation_group 加 budget_used/budget_reserved）；delegate_task 工具路由修正（路径参数名 conversationId→id 与 handler 一致）；预算预留（组创建时 len×10 轮）；递归深度 1 拒绝测试。

**验证证据**：go build/vet；TestW06 6/6（新增预算预留与 dispatch/递归拒绝）；TestHC28、TestHC 全量、W04~W17 全组合通过。过程修复：路径参数名不匹配由 HC-28 暴露。

**状态与下一步**：W06=部分实现（第一、二批）。剩余：子 run 实际模型循环启动（agent_run_one_active 约束策略）、desktop 桥→服务端账本 HTTP 同步。累计提交 **15 包**。下一候选：W09（证据闭环）、W07b（浏览器页签内容）、W13b（候选卡 UI）。

## 2026-11-08 D-171 浏览器形态最终裁决：选项 A——外置 Chrome 协作为最终形态

**裁决内容**：用户确认选项 A——"外置 Chrome 协作＋OPS 内控制条与证据预览"为最终浏览器形态。T-AI27-02 按裁决关闭。W08（应用内浏览器实现）取消。W02 纵切验证路线（DEV-AI27-02）继续作为浏览器协作正式交付路径。

**文档同步**：docs/90 新增 D-171；docs/27 §18 Q-AI27-01/02 与 T-AI27-02 验收表按裁决修订；docs/08 W08 状态改为"取消（D-171 裁决）"。

**前置解除**：W09/W10/W12 不再有任何浏览器形态前置阻塞。浏览器线按外置协作形态继续。

**累计提交 14 包 + 本裁决提交。** 下一步：W09（引用/证据/批注/产物闭环）、W06 第二批（工具链接线与共享预算）、W10（Chrome side panel）、W11（Web 兼容）、W12（安装矩阵）。

## 2026-11-07 DEV-AI27-06 W06 Agent 工具闭环（第一批：工具目录注册 + /tools/ 派发端点）

**本批范围**：agent_tools_ai27.go 注册 12 个 AI27 工具到目录（浏览器 7 toolR + 委派 2 toolG/toolR + 电脑 2 toolR + MCP 1 toolR）；/tools/ 路由组 6 条非 /agent/ 派发端点（复用 W04/W14/W15/W17 已有 handler）；接入 buildAgentCatalog；HC-28 目录分类 + /tools/ 6 路由清单。

**验证证据**：go build/vet；TestW06 4/4（目录注册 12 工具、域归属、Kind 分类、浏览器 toolR 讨论可用）；TestHC28 全部通过（/agent/ 黑名单正确拦截→/tools/ 前缀绕过）；TestHC 全量、W04~W17 全组合回归通过。过程修复：HC-28 黑名单拦截（正确）、CRLF 编辑未生效、GET/POST 方法不匹配。

**状态与下一步**：W06=部分实现（第一批）。第二批：桌面桥 dispatch 编排、共享预算扣减、委派元工具 run 内接线、模式过滤细粒度。累计提交 **14 包**。**D-170 浏览器形态裁决仍待用户**。下一候选：W09（引用/证据/批注/产物闭环）、W1x 各第二批、W11（Web 兼容）。

## 2026-11-07 DEV-AI27-17 W17 Windows 电脑控制（第一批：前台租约/硬禁区/隔离）

**本批范围**：迁移 00095（agent_computer_grant scope=observe/act 30s 过期 UNIQUE 幂等）；D-160 开关 computer_use；API 四条（创建含硬禁区+单租约互斥+幂等优先、撤销 generation 递增、查询、handoff device_ack_pending）；硬禁区中文+英文双模式匹配；HC-28 登记 4 路由。

**验证证据**：go build/vet；TestW17 3/3（C01 创建 active、C02 跨用户隔离、C04 单租约互斥+handoff、C07 硬禁区 5 类全拒、C09 target_handle 不透明）；TestHC28、TestHC 全量、W13~W17+W04 组合回归通过。过程修复：INSERT RETURNING 别名、硬禁区中文匹配、幂等优先于 busy。

**状态与下一步**：W17=部分实现（第一批）。第二批：UIA/视觉执行 worker、本机选窗器 UI、C01 三类真实应用旅程、C03 UIA+视觉双通道。**五专题（W13~W17）服务端数据模型与 API 全部完成第一批。累计提交 13 包。D-170 浏览器形态裁决仍待用户。**下一候选：W06（Agent 工具闭环——将浏览器/插件/电脑控制接入 run 工具链）、W1x 各第二批、W09~W12。

## 2026-11-07 DEV-AI27-16 W16 双模式语音（第一批：会话/回合/编辑/打断/隔离）

**本批范围**：迁移 00094（agent_voice_session mode=dictation/realtime + agent_voice_turn purpose=transcribe/commit_realtime；一设备一活动会话唯一索引；request_id 幂等）；D-160 开关 voice_dictation/voice_realtime（可独立开启）；API 五条（sessions 创建/turns 提交/turns 编辑/会话打断或结束/状态查询）；HC-28 登记 5 路由。

**验证证据**：go build/vet；TestW16 3/3（V01 转写编辑/无消息产生/结束拒绝/查询、V02 realtime commit/幂等重放/打断恢复/跨用户/viewer、V04 语义分离、V06 结构断言无音频落盘）；TestHC28、TestHC 全量、W13+W04+W14+W15+W16 组合回归通过。过程修复：INSERT RETURNING 别名、editVoiceTurn 跳参、purpose varchar(12)→20、组合跑 registerClient 污染（每测试强制重登 owner）。

**状态与下一步**：W16=部分实现（第一批）。第二批：输入台语音按钮/语音条 UI、实时音频桥（ASR/TTS/realtime 路由自检）、真实语音旅程（V08）、计费记账（V07）。累计提交 **12 包**。**D-170 浏览器形态裁决仍待用户**。下一候选：W17（Windows 电脑控制）。

## 2026-11-07 DEV-AI27-15 W15 子智能体（第一批：委派组/限额/取消传播/隔离）

**本批范围**：迁移 00093（agent_delegation_group/agent_delegation 两表+事件白名单 delegation.*四类；child_run_id 可空——子 run 由 W06 派发时创建；00090 Down 的 $$ 同步修正）；D-160 开关 subagents；API 五条（组创建含深度 1/并发≤2/累计≤4 限额与身份链校验、按父 run 查询（本人过滤）、单子取消幂等不误停、子结果回执（终态 409 不复活）、整树取消 generation 递增）；HC-28 登记 5 路由。

**验证证据**：go build/vet；TestW15 3/3（S01/S02/S04/S06/S07/S08 服务端子项）；TestHC28、TestHC 全量、W13+W04+W14+W15 组合通过。过程修复：PG CHECK 不允许子查询（深度 1 改应用层）、goose 不支持 `$$`（去触发器；00090 Down 同步）、agent_run_one_active 约束（child_run_id 可空）、嵌套恢复链。

**状态与下一步**：W15=部分实现（第一批）。第二批：子 run 派发执行（W06）、元工具、任务面板 UI、S05 互斥。累计提交 **11 包**。**D-170 浏览器形态裁决仍待用户**。下一候选：W16（语音）、W17（电脑控制）、W06（工具闭环）。

## 2026-11-07 DEV-AI27-14 W14 插件/MCP（第一批：stdio 宿主 + 连接状态机 + 调用回执）

**本批范围**：desktop/src mcp-host.ts（stdio JSON-RPC 双时代握手/分页目录/调用超时/stderr 脱敏限量/进程回收，不拼 shell、最小环境、env 键名校验）+ 真子进程测试 6/6；server 迁移 00092（agent_plugin_connection 状态机 draft→enabled⇄disabled→revoked、agent_plugin_call 回执账本）、D-160 开关 plugin_mcp、API（connections CRUD+CAS actions、calls 登记与回执，未启用连接 409 防业务旁路）、HC-28 登记 6 路由。

**验证证据**：desktop typecheck 通过、mcp-host 测试 **6/6**（真实 Node 子进程）；server build/vet、TestW14 2/2、TestHC28、TestHC 全量、W13+W04+W14 组合回归通过。过程修复：INSERT RETURNING 别名、原子 CAS、空 jsonb、NOT NULL 兜底、ok 遮蔽、callTool timeout 透传。

**状态与下一步**：W14=部分实现（第一批）。第二批：HTTP 传输+真实 OAuth（P01 完整关闭需授权环境）、ipcMain 固定意图与 renderer 管理页、run 工具链接线（W06）、update_review 复审流。累计提交 10 包。**D-170 浏览器形态裁决仍待用户**。下一候选：W15（子智能体）或 W06（工具闭环）。

## 2026-11-07 DEV-AI27-04 第二批：命令账本 API 与事件投影

**本批范围**：迁移 00091（agent_event 白名单扩充 browser.* 七类事件）；命令账本 API（create 幂等/异载荷 409、dispatch、receipt 终态幂等与异结果 409、撤销过期租约回执拒绝、list、sweep→unknown_outcome）；dispatch/receipt 事件投影（runID=nil，不制造空 run）。

**验证证据**：go build/vet；TestW04 6/6（新增账本生命周期与 sweep 场景）；TestHC28；TestHC 全量；TestW13+TestW04 组合通过。过程修复：NULL 时间列 scan、agent_event CHECK 白名单（00091）、receipt 终态语义按 §13.8 细化。

**状态与下一步**：W04=部分实现（第一、二批）；失权竞态注入矩阵与桌面接线留 W06/W07。累计提交 9 包：W01/W02/W03/W05/W04/W07/W13/W04b 本条。**D-170 浏览器形态裁决仍待用户**。下一候选：W14（插件/MCP）、W15（子智能体）、W06（Agent 工具闭环）。

## 2026-11-07 DEV-AI27-13 W13 跨对话记忆（第一批：服务端全链 + 设置页）

**本批范围**：迁移 00090（agent_personal_memory 六态机+同 hash 唯一、agent_memory_usage 注入记录、agent_memory_setting 本人双开关、agent_conversation 会话覆盖两列）；D-160 开关 personal_memories；API（列表/显式创建/PATCH CAS/删除留标记/memory-settings effective 链/候选提案 `/memories/personal-candidates`）；注入 personalMemorySystemBlock（feature→use→会话覆盖决策链，≤10 条/2000 字，usage 落库）接线 agentBuildMessages；工具 memory__propose_candidate（toolG 只写候选）；设置页 `/settings/memory`（双开关+候选逐项确认/修改/忽略+停用/删除+手动添加，无"全部确认"）。

**验证证据**：go build/vet 通过；TestW13 4/4（M01 候选不注入/确认注入/usage/开关/覆盖、M02 CAS/忽略去重/幂等/跨用户 404/viewer 403、M03 删除停注留标记/可重建/账号记忆原契约）；TestHC28（黑名单正确拦截 /agent/ 前缀工具路径，改业务域）；TestHC 全量通过。renderer typecheck 0 错、test:unit 40/40、边界守卫 7/7。过程修复：PATCH 非 edit 分支清空 text（M01 捕获）。

**状态与下一步**：W13=部分实现（第一批）。第二批：消息内候选卡、会话覆盖开关 UI、上下文页实际使用项、run 结束自动提炼（W06）、相似替换流。累计提交：W01 e8778035 / W02 bf3e2fb5 / W03 b276e7d4 / W05 f36c808e / W04 26a1e52a / W07 9eaba28d / W13 本条。**D-170 浏览器形态裁决（A/B/C）仍待用户**。下一包：W04 第二批（命令账本 API 与事件投影）。

## 2026-11-07 DEV-AI27-07 W07 桌面工作视图/输入台/连接设置（第一批）

**本批范围**：renderer-src 新组件 AddMenu（添加菜单收敛，未交付能力如实禁用）、BrowserStatusBlock（浏览器页签真实状态：开关→capabilities→bindings 逐层如实，10s abort+5s 轮询）、PanelResizer（分隔条可聚焦/16px/Enter 恢复默认/宽度持久化）；Agent.tsx 四页签工作视图（任务/上下文/产物/浏览器）、"任务面板"→"工作视图"改名；CSS 断点升级 27 §5.6（1456/1168/720）；e2e 能力清单追加两开关。

**验证证据**：renderer typecheck 0 错；test:unit 40/40；边界守卫 7/7；新 spec `agent-workbench-ai27-workview.spec.ts`（Electron）2/2；改名联动 5 spec（shared-scenarios）5 passed 1 skipped 0 failed，aw12 断点断言按 §5.6 升级。已知问题：组合长跑时浏览器状态块偶发停留 loading（单文件 4 次稳定通过；10s abort+5s 轮询兜底已加，怀疑 Electron 多实例残留，待 W11/W12 排查）。物理 DPI/IME/读屏留人工矩阵。

**提交披露**：`Agent.tsx` 工作树含 2026-11-07 早期会话遗留的会话渲染重构（未提交），与 W07 改动同文件叠加无法机械拆分，本包提交一并包含；遗留部分未单独验证原有行为。

**状态与下一步**：W07=部分实现（第一批）。浏览器形态裁决（D-170 A/B/C）仍待用户。下一包候选：W13（记忆）、W04 第二批（命令账本 API）、W06。

## 2026-11-07 DEV-AI27-04 W04 服务端浏览器资源与租户权限（第一批）

**本批范围**：迁移 00089（pairing/binding/grant/command 四表，binding 的 extension_instance_id 全库唯一）；D-160 新增 chrome_connect/browser_workspace 开关（默认关闭+依赖降级）；配对/绑定/租约 API（幂等/CAS/实例冲突/活动 run 校验/30s 租约/origins≤5）；只减权清理路由三条件（不挂 agentGate，T-AI27-25A）；viewer 与代访问 403；HC-28 登记 9 条路由。命令账本 API/事件投影/失权竞态注入属 W04 第二批。

**验证证据**：go build/vet 通过；TestW04 4/4、TestHC28、TestHC（HC-01~31 全量）、TestAW01（清单更新 13 开关）、TestAG05+TestW04 组合全部通过。过程修复三个真实缺陷（迁移表名、chrome_connect 误挂依赖、bindings 漏 roleGuard），均由测试暴露。已知既有 flake：AW10RoutineSchedulerLateWindowBoundary 间歇失败（调度窗口时间敏感，单跑可过，与本包无共享状态），交 QA26 线处理。

**状态与下一步**：W04 状态=部分实现（第一批）；浏览器形态裁决（D-170 选项 A/B/C）仍待用户。下一包候选：W07（工作视图 UI）或 W13（记忆）或 W04 第二批。

## 2026-11-07 DEV-AI27-05 W05 本机宿主与扩展执行边界（第一批）

**本批范围**：桥命令信封完整化（issued_at/nonce/payload_hash，回执强制带回否则拒绝）；桥侧动作白名单前置拒绝；256KiB 元数据上限（browser_payload_limit）；时钟异常停止派发（>5s 漂移 browser_clock_unstable，恢复自动继续）；稳定错误码（13.7 本机子集）；重新配对=新会话（宿主 pairing_start 全序列归零、扩展 generation 归零，消除桥重启序列死锁）；main.ts 无沙箱联动闸门（NO_SANDBOX=1 不启动桥）；扩展端 nonce/hash 校验与回执；日志脱敏核对（key/载荷不入日志）。

**验证证据**：desktop typecheck/build 通过；pnpm test 243/243（桥单测新增 W05 反例全部通过：无 nonce 回执拒、nonce 不匹配拒、白名单外不派发、超限不派发、时钟跳变拒派/恢复可派、稳定错误码）；真实 Chrome（CfT 156.0.8078.80）browser-bridge.chrome.e2e M1~M3 全程回归通过，扩展新信封逻辑真实链路生效。

**状态与下一步**：W05 状态=部分实现（本机侧完成；服务端账本/租约/策略版本在 W04/W06，MCP 凭据面在 W14；nonce/hash 纳入 HMAC 签名材料登记为 W04 信封强化点）。**浏览器形态裁决（D-170 选项 A/B/C）仍待用户**；W04（服务端浏览器资源与租户权限）为下一包候选，W07/W13~W17 可并行。

## 2026-11-07 DEV-AI27-03 W03 原生内嵌技术门结论（不满足，产品形态待用户裁决）

**本批范围**：按 27 §6.4 完成"官方依据＋最小证据包"有界调查：①两轮官方机制核查确认 Chrome/Chromium 无受支持跨进程嵌入 API（受支持路线全为换内核，均属用户排除项）；②单次隔离实证 `desktop/scripts/native-embed-probe.ps1`（CfT 156 独立 profile）——SetParent 后 Chrome 窗口不可见、焦点逃逸至无关进程、宿主区域被无关内容占据（截图 `output/playwright/w03-embed-experiment.png`），§6.4 第 4 项前两条硬条件直接失败，未堆叠补丁。

**结论与登记**：完整 Chrome 原生嵌入**无可行路线（不满足）**；DEV-AI27-08 不得开工；docs/90 D-170 登记，docs/27 §18 回写，docs/08 状态=验证已通过（结论不满足）。**产品形态选项 A（建议：外置协作即最终形态，关闭 T-AI27-02）/B（受阻继续）/C（换内核，不建议）待用户裁决，裁决前不实施任何形态变更。**

**下一步**：浏览器线等裁决；W04/W05/W07/W13～W17 不受影响可立即开工。W02 纵切验证（bf3e2fb5）与 W01（e8778035）保持有效。

## 2026-11-07 DEV-AI27-02 W02 桌面纵切技术验证（真 Chrome＋MV3 扩展＋Native Messaging）

**本批范围**：`desktop/chrome-extension/` 自有 MV3 扩展（登记动作 7 个，无任意 JS/CDP）；`desktop/src/native-host/`（host.js stdio 宿主 + register.cjs 注册，生成物已 gitignore）；`desktop/src/browser-bridge.ts`（短码配对/HMAC 会话/命令账本/unknown_outcome/generation 撤销 + 诊断窗与验证控制口，仅 OPS_DESKTOP_BRIDGE_DIAG=1 启用）；main.ts 单点接线。关键修复：三端 HMAC key 统一为解码字节、宿主两条链路 seq 独立并转发重签、hello/pairing_start 免签可重配对。

**验证证据**：desktop `pnpm typecheck` 通过；`pnpm test` 243/243（桥单测 4 项）；`node --test test/browser-bridge.chrome.e2e.cjs` 连续两轮通过——载体 Google CfT 156.0.8078.80（安装版 branded Chrome 136+ 官方移除 --load-extension，安装版人工加载留 W12）：M1 配对、M2 全动作闭环（含密码控件拒绝/旧 doc_rev 拒绝反例）、M3 杀宿主→unknown_outcome 不重放→重连恢复、Chrome 重启→重新配对→账本不重放、停止→拒新动作 p95≤200ms（30 样本本机状态机口径）。扩展自实现 HMAC 与 node:crypto 三组交叉校验一致。

**状态与下一步**：W02 结论=**扩展+NM+真 Chrome 纵切可行**（27 §6.4 第 1/2/3/5 项可复现），08 已登记"验证已通过"。下一步 DEV-AI27-03（W03 原生内嵌技术门，前置已满足）；W04/W05/W07 及 W13~W17 可并行。未验证：安装版人工加载、服务端租约（W04）、无沙箱联动闸门、权限收敛（W05）。工作树遗留（docs/05、docs/22、renderer-src 三文件、qa26/audit 脚本）未触碰；`desktop/.tmp/`（CfT 下载与临时诊断脚本）已 gitignore。

## 2026-11-07 DEV-AI27-01 AI 对话增强立项与权威文档同步（W01，纯文档）

**本批范围**：用户裁决 Q01/Q02（保留双门：DEV-AI27-02 扩展纵切验证先行 + DEV-AI27-03 原生内嵌门独立有界验证，两门均过才宣称内置达成）、Q03（通用扩展与平台专用 profile 保持分离）后，完成 W01 立项包：docs/90 新增 **D-169**（获准范围、DEV-AI27-01～17 分配、16 修订、裁决回写）；docs/08 末尾新增 DEV-AI27 任务表（17 包，状态未开工，01=文档已实施）；docs/16 按裁决显式修订 **7 处**旧条款（15 节导语、AW-F10 插件/MCP、AW-F13 子智能体、AW-F17 固定意图、AW-F19 电脑控制、AW-F20 实时语音、15.8 网页抓取器——F13/F19/F20 为避免文档自相矛盾在同一裁决下补充修订）；docs/27 §18 回写裁决结果。docs/27 本体 + docs/design/ai27-dialogue/ 设计稿 + .gitignore 单项例外首次入库。无业务代码，未运行产品测试。

**提交**：`DEV-AI27-01: AI 对话增强立项与权威文档同步`（仅含上述文档文件；docs/05、docs/22、Agent.tsx 等遗留改动未夹带）。

**下一步**：DEV-AI27-02（W02 桌面纵切技术验证）：新增 `desktop/chrome-extension/`（MV3 扩展）与 `desktop/src/native-host/`（Native Messaging 宿主），验证 M1 连接配对 / M2 操作闭环（观察/点击/中文输入/提取/截图/接管停止 p95≤200ms/unknown_outcome 不重放）/ M3 掉线恢复（杀宿主/禁扩展/Chrome 重启/devtools 抢占），退出条件与里程碑已获确认；不接服务端租约（W04/W06）。W03（原生内嵌门）在 W02 结论后开工。

## 2026-11-07 AI27 文档专题规格合并（承接 Codex 会话，最后活动 14:26）

**本批范围**：`docs/27-AI对话增强分析与Codex桌面端对标设计.md` v0.2 收尾。把 `.tmp/ai27-v02-memory-mcp.md`（跨对话记忆＋插件/MCP）与 `.tmp/ai27-v02-agents-voice-computer.md`（子智能体＋双模式语音＋Windows应用控制）合并进主文档第 11 节（11.1～11.5），新增 11.6 仍暂缓边界与 11.7 统一权限/确认/停止规则（含六能力停止语义对照表）；两份 `.tmp` 增量自此被主文档取代。本轮仍只有文档改动，无业务代码。

**同步修正**：4.1 节验收引用校正（M01～08→M01～03、P01～09→P01～04、M05→M03）；9.7 五类研究任务补 R01～R05 标签；13.2 补专题契约指针；16 节新增 16.4 专题能力验收清单（原 16.4/16.5 顺延为 16.5/16.6）；17.2 新增 W13～W17 任务包；Q-AI27-08 由“保留P2”改为“按W13～W17立项”；19.1 补 O15（Voice）/O16（Subagents），19.2 补 A01～A06（MCP规范/SDK、Realtime、UIA、UFO）；19.4 计数更新为 37 项能力（AI27-01～37）＋37 项主验收（T-AI27-01～35及21A/25A）＋M/P/S/V/C/R 专题系列。

**验证**：结构校验通过（19 章序号连续、围栏配对、表格列数一致、无尾随空格、本地链接存在、无“主文档/P2记忆”等残留引用）；验收编号清点：主 37、专题 32（M3/P4/S8/V8/C9）、R01～05，重复出现均为“定义＋索引”的合法引用。纯文档任务，未运行产品测试，也未声称任何功能实现。

**剩余状态与下一步**：Q01/Q02（完整Chrome内置裁决）与第 6 节技术门状态未变；五项专题需正式 DEV 任务号并同步 16/23/06/08/90（旧 16 插件执行禁令条款须显式修订后才可开发 11.2）；`.tmp/ai27-v02-*.md` 已被合并取代但文件仍在 `.tmp/`；工作树中 `docs/05`、`docs/22`、`desktop/renderer-src/*` 等改动为今日更早会话遗留，本批未触碰；doc 27 与 `docs/design/ai27-dialogue/` 仍未提交（`.gitignore` 已有单项例外）。

## 2026-11-05 DEV-QA26 checkpoint 第二十一轮（G2-13 RunJobs 到期清理入口与作品文件）

**本批范围**：承接 HEAD `c2f50772 DEV-QA26: 验收回收站 viewer 全类型权限`。在 `trash_expiry_test.go` 增加隔离集成测试，使用 Go `TestMain` 的临时 `ops_test` 数据库和临时 DataDir，经本地 API 建立作品/选题、通过作品上传接口创建并核实实际图片文件、固定超期时间；启动真实 `Server.RunJobs(ctx)` 后验证两行均被清除、作品 assets 目录及图片消失，取消 context 后调度退出。只改测试与 `docs/26`、`docs/08`，无产品逻辑修复，也没有新增 docs/22 缺陷。

**验证证据**：`cd server; go test ./internal/app -run '^TestRunJobsPurgesExpiredWorkAndAssetDirectory$' -count=1`，1 passed（6.273s）；`go test ./internal/app -run '^(TestHC.*|TestPurgeExpiredTrashHonorsThirtyDayBoundary)$' -count=1`，HC-01～31 和 30 天边界均通过（19.813s）。隔离测试里的 RunJobs 使用启动即执行的 `runJobsOnce`；未等待 10 分钟 ticker 后续轮次单独触发。没有触及本地开发/生产数据、真实平台、部署或 H 门。

**工作树和交付**：已单任务提交 `5c3e67f DEV-QA26: 验收到期清理调度入口`，仅包含 `server/internal/app/trash_expiry_test.go`、`docs/26-全局功能审计与点击验收台账.md`、`docs/08-开发与测试计划.md`。`docs/AI_HANDOFF.md` 为本地忽略文件，未暂存。所有预存 untracked `_tmp_*`、QA Playwright 配置/脚本、`web/audit-*` 与 `web/shot-models.mjs` 保持不动。当前分支仍领先 `origin/main` 37 个提交；不得 push/deploy。

**剩余状态与下一步**：G2-13 仍部分检查：真实 Electron 设置内嵌 WebContents 的读取错误注入未覆盖，10 分钟周期 tick 未等待单独触发。下一项返回用户既定顺序，桌面优先检查 G8 设置未完成缺口，再继续 G6-03 等复盘旅程。真实模型费用/质量、真实平台发布、生产迁移、签名安装升级不在本地 mock 授权内。

## 2026-11-05 DEV-QA26 checkpoint 第二十轮（G2-13 viewer 七类回收站权限矩阵）

**本批范围**：基于 HEAD `eb1949a DEV-QA26: 深测智能体桌面旅程`，新增 Web 与真实 Electron viewer 回收站七类型权限矩阵 E2E，更新 `docs/26`、`docs/08`。对象为 work/topic/material/style_sample/character_card/reference/sensitive_word；按类型筛选行可见但三种写操作按钮全部隐藏，viewer 对七类 restore POST 与 purge DELETE 共 14 个请求/端全部收到 403，owner 读回 `/trash` 确认条目保持存在。只写本地隔离 E2E 夹具，无产品/服务端逻辑改动。

**复验和量化**：真实 Electron 3/3（15.1/16.0/14.4s，p50/p95=15.1/16.0）；Web Chromium 3/3（7.2/5.8/6.0s，p50/p95=6.0/7.2）。每轮 20 次筛选、三轮 60 样本/端，失败 0；Electron p50/p95 三轮 43.40/64.62ms、51.59/92.68ms、40.27/49.23ms，Web 68.99/81.05ms、66.10/73.52ms、67.65/82.34ms。筛选计时到目标行可见；总旅程计时含夹具/Electron启动/API读回。首次桌面试跑因本地 crawler/mock 更新参考标题导致按 URL 定位失败；按服务端 `/trash` 实际标题定位后双端三连通过，测试夹具修正、没有产品缺陷。

**验证**：双端 E2E repeat3 均 3 passed，typecheck 通过；renderer unit 桌面 38/38、Web 42/42；`node scripts/check-e2e-pairs.mjs` 通过（119 Web、82 桌面、32 对）。无服务端代码改动所以未运行 Go；HC-01～31/H-01～09 均未修改、跳过或放宽。G2-13 仍待每日清理实际调度及关联图片/磁盘文件清理。

**交付与下一步**：本批仅提交双端 `g8-settings-gaps.spec.ts` 与 `docs/26`、`docs/08`，提交 `c2f5077 DEV-QA26: 验收回收站 viewer 全类型权限`；未 push/deploy。此前既有 untracked QA 脚本、配置、`_tmp_*`、`web/audit-*`、renderer scripts 原样保留。继续查本地可执行的 G6-03/04/07/09、G8-08/09 与剩余 G2-13；每日计划任务若无法在隔离本地环境安全触发，保留为明确阻塞。真实模型质量/费用、真实平台、生产迁移、签名安装升级仍不在 mock 授权内。

## 2026-11-05 DEV-QA26 checkpoint 第十九轮（G7 智能体桌面深测与 Web 对照）

**本批范围**：基于 HEAD `7d83d8e DEV-QA26: 复核多时点复盘旅程`，只补 G7 E2E 复跑证据与 `docs/26`、`docs/08`，没有产品代码改动。真实 Electron 的附件、运行恢复/停止/重生成、目标、受限例行任务四条旅程各 3/3（12/12）；工件/选段的桌面 3/3 沿用已有证据。动作卡执行/拒绝各 3/3 使用 Chromium + Electron UA，非原生 Electron 窗口；Web 对应状态 8/8 单次通过。

**量化与持久化证据**：Electron 每轮耗时：附件 8.7/7.1/7.1s（p50/p95 7.1/8.7），运行恢复/停止/重生成 20.4/20.4/20.0s（20.4/20.4），目标 8.4/7.8/8.1s（8.1/8.4），例行任务 6.2/5.9/6.1s（6.1/6.2）；动作卡 Chromium+Electron UA 执行 6.5/5.9/6.4s（6.4/6.5），拒绝 6.2/5.9/6.3s（6.2/6.3）。三样本 p95 取最大值。附件从会话 API 读回，动作执行 `succeeded` 并真实创建隔离素材，拒绝为 `rejected` 且无素材写入；目标状态、例行运行与私有报告有服务端证据。全部 E2E 使用本地 API/mock，不证明真实模型质量。没有发现产品缺陷；HC-01～31、H-01～09 未修改/跳过/放宽；未触及真实平台、生产库或部署。

**命令**：桌面真实 Electron `cd desktop/renderer-src; pnpm exec playwright test -c qa26-reuse.playwright.config.ts --project=desktop-renderer-shared-scenarios e2e/agent-events.spec.ts e2e/agent-documents.spec.ts e2e/agent-goals.spec.ts e2e/agent-routines.spec.ts --grep '运行恢复、停止与重生成|图片与文本附件进入同一条持久消息|任务目标与整理入口|配置受限例行任务、手动运行并查看私有报告' --repeat-each=3 --workers=1 --quiet --reporter=list`（12 passed）；动作卡 `cd desktop/renderer-src; pnpm exec playwright test -c qa26-reuse.playwright.config.ts --project=desktop-windows-electron e2e/g7-action-card-desktop.spec.ts --repeat-each=3 --workers=1 --quiet --reporter=list`（6 passed）；Web `cd web; pnpm exec playwright test -c playwright.config.ts --project=chromium e2e/agent-workbench.spec.ts e2e/agent-events.spec.ts e2e/agent-workbench-aw08.spec.ts e2e/agent-goals.spec.ts e2e/agent-routines.spec.ts e2e/agent-cards.spec.ts --grep '混合附件队列|断线和刷新恢复同一运行|停止后刷新仍展示服务端未完成文本|产物版本、精确选段反馈和消息分支|任务目标、跨会话筛选|配置受限例行任务|拒绝结束时路由已变化|草稿选择转超限' --workers=1 --quiet --reporter=list`（8 passed）。

**交付与下一步**：本批仅提交 `docs/26-全局功能审计与点击验收台账.md` 与 `docs/08-开发与测试计划.md`，提交 `eb1949a DEV-QA26: 深测智能体桌面旅程`；未 push/deploy。此前所有未跟踪 QA 脚本、配置、`_tmp_*`、`web/audit-*` 等均保持原样。接着核验 G6-03/04/07/09 中本地仍可执行的缺口、G8-08/09 无障碍/窄屏缺口及 G2-13 viewer 全对象写拒绝/到期清理调度边界；普通交互与 AI 反馈的固定样本要求按已有证据核对，真实模型质量/费用、真实平台、生产迁移、签名安装升级仍不在本机 mock 授权内。

## 2026-11-04 DEV-QA26 checkpoint 第十三轮（G2-04/G2-13 已有设置证据回填）

**本批提交**：`ed4db0b DEV-QA26: 回填成员与回收站验收状态`，未 push。仅更新 docs/08 与 docs/26 的矩阵状态，未重跑已有 E2E、未改产品代码。

**回填依据**：前一批 `g8-settings-gaps.spec.ts` 双端各 9/9 通过，成员路径已覆盖 owner 创建 editor 邀请、角色切换、撤销邀请码、移出取消/确认、服务端读回、editor 控件隐藏及写 API 403；邮箱邀请/邮件发送未覆盖且未发送邮件。回收站路径已覆盖桌面空态和隔离新建敏感词软删除、恢复、彻底删除取消/确认及 API 读回；30 天到期清理与其他对象类型仍未逐项验。没有重复跑已完成设置检查。

**下一步**：从 docs/26 继续筛选真正未检查且可在本地 mock 验收的功能，优先真实 Electron 点击与服务端读回；不触碰真实模型费用、真实平台写入、生产库迁移或签名安装升级。所有既有 untracked 文件保持原样。

## 2026-11-04 DEV-QA26 checkpoint 第十二轮（G7-12 桌面 AI 策略保存与重启读回）

**本批提交**：`cdb5eba DEV-QA26: 桌面 AI 策略保存与重载验收`，未 push。提交 5 个文件：桌面设置窗状态门控、G7-12 真实 Electron E2E、docs/08、docs/22、docs/26。此前所有 untracked 审计脚本、临时文件和 Playwright 配置均保留，没有加入提交。

**完成证据**：修复前真实 Electron 复现：本机 AI 表单变更后点击“放弃修改”切到桌面 AI 策略，设置窗 footer 仍显示“有未保存的修改”，关闭设置持续被遮罩拦截。根因是 `DesktopSettingsHost` 在本机面板离开后仍合并 detached local view 的 `dirty/busy` 状态；修复为仅当本机设置面板活动时计入该状态。原点击旅程包括策略开关开启后取消、工作区策略启用保存/API 读回、配置本机 mock manifest、关闭设置、退出并重启 Electron、重新登录后读回 API 策略与本机模型清单、保存关闭策略；连续 3/3 通过，服务端始终保持 `allow_member_endpoints=false`。全局闸门关闭分支 1/1：两项策略开关和保存入口禁用，重载仍禁用且没有 PUT。未连接端点、自检或调用模型。

**验证**：桌面 renderer `pnpm typecheck` 与 `pnpm test:unit`（37/37）通过；E2E 配对守卫通过（Web 119、桌面 79、32 对）；`git diff --check` 通过。三轮旅程 16.843/15.759/15.707s，p50 15.759s、最近秩 p95 16.843s，0 失败；原始报告 `.playwright-results/qa26-g7-policy-timing-20261104.json`。隔离 Windows Electron 环境端口 5387/8387/8397。真实模型质量、真实平台发布、生产库与签名安装升级仍未验证；mock 仅证明本机权限/保存/重载契约。新增缺陷 2G-11，详见 docs/22；G7-12 本地可执行分支已覆盖。

**下一步**：继续依据 docs/26 状态字典筛选尚未检查且可在本地 mock 完成的功能；真实模型质量、真实平台写入、生产库迁移和签名安装升级保持授权外。逐项从真实入口复现与读回，按需检查 Web 对照；每批更新 docs/26、docs/08 和本交接，单任务提交，不 push。

## 2026-11-04 DEV-QA26 checkpoint 第十一轮（G6 CSV 文件类型拒绝回归）

**本批提交**：`1c7d0e6 DEV-QA26: G6 CSV 文件类型拒绝回归`，未 push。本批含共享 API 扩展名校验、Go 回归测试、双端复盘 CSV E2E、桌面 E2E helper 的确认状态持久化核验，以及 docs/08、docs/26 更新。之前的未跟踪审计脚本、临时文件和 qa26-reuse 配置均保留，没有加入提交。

**完成证据**：修复前桌面 Electron 与 Web 的实际文件选择流程均让 `.txt`/`text/plain` 上传返回 200 并打开预览；修复后返回 422“请上传 CSV 文件”，提示可见、服务端指标没有写入。共享后端仅要求上传文件名 `.csv`（大小写不敏感），原 parser 和粘贴路径不变。Go 定向测试 20 个通过，包含 `TestHC*`。最终桌面 Electron 和 Web Chromium 的完整 G6 CSV→看板旅程各连续 3 次通过、0 失败：桌面 21.9/17.6/17.3 秒（p50 17.6、粗略 p95 21.9），Web 22.5/18.2/15.1 秒（p50 18.2、粗略 p95 22.5）。两端 typecheck、31 对 E2E pair guard 和 `git diff --check` 通过。

**测试排查**：预跑暴露 desktop `createOutline` helper 等待确认后已随对话框关闭而卸载的徽标，改为从 Electron 窗口同源 GET 读回 `outline_confirmed_at`。首次用通用 `page.request` 读回时 Electron context 无 `baseURL`，又触发 `Invalid URL`；改成页面内 `fetch` 后 3/3 通过。累计 8 次预跑失败是测试侧断言或 URL 配置问题，不是产品 CSV 路径失败；不改生产 UI。

**未覆盖与下一步**：G6-07 仍部分检查：重复/歧义 CSV 候选与导入权限受限尚未验；AI 质量反馈提交也待测。继续按优先序桌面真实入口先验并检查 Web 对照，再处理 G7-12/G8-08/09 和普通交互/AI 反馈固定量化样本。真实模型费用、真实平台、生产库、签名安装升级仍不在本地 mock 授权内；不 push/部署。docs/22 无新增动线项。

## 2026-11-04 DEV-QA26 checkpoint 第十轮（G8 设置缺口与 Web 对照）

**本批提交**：`b411d19 DEV-QA26: G8 设置缺口续验`，基于 `11a87142`。仅提交双端 G8 E2E、桌面 project 登记、pair guard、docs/08 与 docs/26；没有运行时产品代码改动，没有 push。任务开始时 tracked tree clean；所有此前已有未跟踪文件均保留，未加入提交。

**完成证据**：真实 Electron 与 Web 分别逐项验收模型供应商二层确认取消/删除、空态重载、无模型时智能体输入/发送/添加附件禁用及工作台普通新建可用；owner 通过 UI 邀请 editor、变更 editor/viewer/editor 角色、撤销邀请及移出取消/确认，editor 页面隐藏管理控件，邀请/模型/路由/成员写请求均 403；敏感词软删除后在回收站逐项永久删除，取消和确认状态均以 API 读回。永久删除仅作用于本轮创建的隔离测试词，没有发送邮件。

**重复样本**：桌面 Electron 3 条旅程各重复 3 次，9/9 passed；模型 10.3/10.0/10.0s（p50 10.0s，3 样本最大值近似 p95 10.3s）、成员 13.0/13.1/12.5s（p50 13.0s，近似 p95 13.1s）、回收站 8.6/8.8/8.7s（p50 8.7s，近似 p95 8.8s）。Web Chromium 9/9 passed；模型 8.0/7.0/7.2s（p50 7.2s，近似 p95 8.0s）、成员 6.3/6.8/6.4s（p50 6.4s，近似 p95 6.8s）、回收站 5.6/6.0/5.7s（p50 5.7s，近似 p95 6.0s）。计时含隔离用户准备、Electron 启动（桌面）和服务端读回，不是单击延迟。

**验证**：桌面命令 `cd desktop; pnpm test:e2e:renderer -- --config qa26-reuse.playwright.config.ts --project=desktop-windows-electron e2e/g8-settings-gaps.spec.ts --repeat-each=3 --reporter=list`，9 passed；Web 命令 `cd web; pnpm e2e -- e2e/g8-settings-gaps.spec.ts --repeat-each=3 --quiet --reporter=list`，9 passed。双端 `pnpm typecheck` 通过，桌面/Web `pnpm test:unit` 分别 37/37 与 41/41，pair guard 31 对通过，`git diff --check` 通过。真实模型/平台、生产库、部署未触碰；mock 不作为真实模型质量证据。

**未覆盖与下一步**：G8-08/09 的全页 375px 溢出/触控目标、读屏器与 IME 仍部分覆盖。按既定顺序继续 G6 复盘未验项及 G7 智能体附件/目标/例程/工件/运行恢复停止和逐卡执行拒绝；之后补齐固定量化样本。继续每批更新 docs/26、docs/08 与本交接，单任务提交，不 push。

## 2026-11-04 DEV-QA26 checkpoint 第九轮（G6-03 粉丝同步与权限回退续验）

**本批提交**：`11a8714 DEV-QA26: G6 粉丝同步续验`，基于 `8f54d6bd`。提交仅包含双端 `g6-followers-sync.spec.ts`、桌面 renderer project 登记、pair guard、docs/08 与 docs/26。没有运行时产品代码修改，也没有 push。既有无关未跟踪文件均保留，未加入提交。

**证据与限制**：桌面真实 Electron 首次账号设置经“返回并选择账号”与公众号标签选择账号，实际点击复盘同步按钮；Web 点击对应页面入口。服务端读回文章/粉丝各 7 天，7 条 `source=wechat_api` 粉丝记录。将 no_permission 通过 Playwright 路由改写仅用于 UI 展示分支；同步入口未发 POST，手动回填 20 天前的新粉 3/取关 1/总粉 100 后服务端读回成功。实际 no_permission/403、API 来源优先和粉丝失败不阻断文章同步由三个 Go 集成测试覆盖。桌面 3/3（9.7/9.5/9.8s，p50 9.7、粗略 p95 9.8）；Web 5/5（5.0/3.8/3.9/3.9/4.8s，p50 3.9、p95 5.0）。双端 typecheck、单测 37/37 与 41/41、30 对 pair guard、`git diff --check` 通过。自动定时同步与真实公众号 API 未验，G6-03 仍部分通过。

**下一步（按用户最新优先级）**：回到桌面 G8 设置页剩余项，先对照 docs/26 G8 台账和 docs/08 G8 证据，整理未覆盖的 models 空态/错误/保存重载、members editor/邀请/撤销与角色受限、usage 空态/错误恢复、words 删除确认、trash 永久删除、export 取消及文件内容。每项从真实 Electron 入口点击，并同步验证 Web 对应状态；已由此前文件读回证据通过的导出内容不要重复。完成后再按原顺序继续 G6 完整复盘未验项与 G7 智能体权限/动作卡缺口；保留量化样本、mock 与真实模型边界。不得 push/部署，不动真实模型/平台/生产库，也不覆盖既有未跟踪文件。

## 2026-11-04 DEV-QA26 checkpoint 第八轮（G6 足量样本归因与 Top 作品续验）

**本批提交**：`8f54d6b DEV-QA26: G6 足量样本归因验收`；基于 `3ad0127c`。提交仅包含双端 `g6-attribution-sample.spec.ts`、desktop renderer Playwright project 登记、`scripts/check-e2e-pairs.mjs`、docs/08、docs/26。无产品运行时代码改动，无 push。所有既有 untracked 文件仍保留且不加入提交。

**完成证据**：真实 Electron 与 Web 各完成同一复盘旅程 3/3：使用实际检查/发布/复盘 UI，对 10 篇微头条逐篇录入 T+7 手动数据；归因 POST 返回 `enough=true/samples=10/content_format=micro_post`，界面呈现两组结论；数据偏好 sample_count=10 服务端读回；Top 作品返回 1 篇，点击拆解显示本地 mock 文案。桌面耗时 1.6/1.5/2.1 分钟（p50 1.6，3 样本最大值作粗略 p95 2.1）；Web 1.7/1.8/1.8 分钟（p50 1.8，粗略 p95 1.8）。计时包含准备和服务端读回，不是单次交互响应。归因/拆解内容为 mock，不能证明真实模型质量。

**验证**：单次定向 E2E 首跑每端 1/1；`--repeat-each=2` 每端 2/2；桌面 renderer `pnpm typecheck`、桌面单测 37/37、Web 单测 41/41、pair guard 29 对、`git diff --check` 通过。已按单任务提交；提交后的本地 handoff 更新仍未跟踪，不进入提交。

**下一步**：继续 G6-03：检查 `sync-wechat` 在本地模拟服务的 7 天文章数据与粉丝同步，以及 no_permission/权限错误路径；先查模拟微信服务是否支持 48001/50002 注入，不加未经证实的开发 API。桌面真实窗口先验，Web 同步对照。若同步已覆盖，转 G8 设置页尚未完成项与 G7/G8 权限边界。不要触碰真实平台、真实模型计费、生产迁移、部署或 push。

## 2026-11-04 DEV-QA26 checkpoint 第七轮（G6 CSV 与非空质量看板双端续验）

**本批提交**：`3ad0127 DEV-QA26: 桌面 G6 CSV 与质量看板续验`；改动限本批两个 E2E spec、桌面 Playwright project 登记、pair guard 和 docs/08、docs/26。无产品运行时代码改动，不 push。

**完成证据**：真实 Electron 和 Web 各 1/1 passed，分别 33.9s/57.7s。坏 CSV 界面预览包含一条精确匹配记录和一条非法展现数值错误；点击取消后 GET `/works/{id}/metrics` 为 0 条。有效 CSV 逐项确认后服务端读回 source=file、reads=12000、impressions=33000、likes=36、favorites=8、day_offset=7，复盘表格展示阅读 1.2万。随后生成 mock 复盘报告并读回关联作品；质量看板通过界面筛选 7/30/90 天与 review_analysis 并打开最近调用详情，GET `/quality`、`/quality/calls` 有服务端证据。

**状态和边界**：G6-07、G6-09 仍部分检查；未测 CSV 重复/歧义匹配、文件类型拒绝、权限错误与反馈提交。mock 仅验证流程契约，不代表真实模型质量；本地测试发布记录未触碰平台。首轮测试失败是指标数值缩写与候选行定位断言假设，按实际界面改正后原步骤复验通过，不是产品缺陷。docs/22 无新增项。

**回归检查**：桌面 renderer `pnpm typecheck` 通过；桌面 `pnpm test:unit` 37/37，Web `pnpm test:unit` 41/41；E2E pair guard 28 对通过，`git diff --check` 通过。

**下一步**：继续 G6-03 自动同步/权限异常与 G6-04 至少 10 篇洞察分支，优先真实 Electron 并同步检查 Web；再继续 G8-08/09 未覆盖的全页 375px、触控尺寸、读屏器/IME 和 G7/G8 未完权限路径。补足未完成功能的固定量化样本及连续 3 次关键旅程，按批更新台账/计划/交接并单任务提交。不 push，不进行真实模型计费、真实平台发布、生产迁移或签名安装升级。

## 2026-11-04 DEV-QA26 checkpoint 第六轮（桌面 G6 尾项，本批后累计 13 commits 未 push）

**本批提交**：`41173c7 DEV-QA26: 桌面 G6 尾项验收`，仅 `docs/08` 与 `docs/26`；无产品代码改动、无 push。开始时 HEAD `d9339c7`；原有未跟踪文件完整保留。此文件被 `.gitignore:35 docs/*` 忽略，checkpoint 留在本地。

**G6 尾项证据**：真实 Electron 粉丝卡补录新粉 10、取关 2、累计 108；GET `/accounts/{id}/followers?days=30` 读回净增 8。归因和 Top 作品验证 0/10 样本不足分支。截图识别用本地 mock 与合成 PNG：识别弹窗值 reads=12000、likes=36、favorites=8；评论 999 因原始文字无依据被丢弃；取消后指标 0 条，逐行确认后 GET `/works/{id}/metrics` 读回 1 条 source=screenshot、comments=null、day_offset=2。CSV 只测文件选择取消。质量看板 Electron 空态 GET 200/tasks=0。Web 定向截图区间确认 E2E 1/1（24.0s）；质量看板错误与重试 E2E 1/1（32.5s，错误反馈 175ms）。G6-03/04/07/09 仍部分覆盖。无已确认产品缺陷，无 docs/22 新条目。

**未验证边界**：真实视觉模型质量、粉丝自动同步、≥10 篇归因、有效 CSV 与解析写入、质量看板非空/筛选/钻取均未验证；本地“发布”数据未写入外部平台。量化普通交互及 AI 反馈各 ≥20 次、关键旅程连续 3 次仍待采集。

**回归检查**：桌面 renderer `pnpm typecheck` 通过；桌面 `pnpm test:unit` 37/37，Web `pnpm test:unit` 41/41；E2E pair guard 28 对通过，`git diff --check` 通过。

**下一步**：优先 G7 桌面智能体——附件、目标、例程、工件、运行恢复/停止、逐卡执行与拒绝；同步核实 Web 对应状态。H 门和 D-117 逐项执行确认保持，不能出现“全部执行”。然后补足规定量化样本与关键旅程连续 3 次。完成批次后更新 26/08/交接并单任务提交，不 push。

## 2026-11-04 DEV-QA26 checkpoint 第五轮（桌面 G6 复盘旅程，本批提交后累计 12 commits 未 push）

**本批提交**：`d9339c7 DEV-QA26: 桌面 G6 复盘逐项点击验收`，只含 `docs/08` 与 `docs/26`；无产品代码改动、无 push。开始时 HEAD `a63fe9f`，只见既有未跟踪文件；本批未触碰它们。`docs/AI_HANDOFF.md` 被 `.gitignore` 忽略，本次 checkpoint 保留在本地，不加入提交。

**桌面真实 Electron 证据**：手动录入 T+1/T+3/T+7，界面保存反馈成功，GET `/works/{id}/metrics` 读回 `source=manual`、`day_offset` 与指标值一致；看板显示 T+7 读数 2,500、展现 3,300、收藏 25、分享 11。发布页通过“标记为已发布”保存本地测试 URL/时间，GET `/works/{id}` 读回 `published`、URL 与 `published_at`。窗口投影 T1/T3/T7 有正式快照引用，T30 缺数。单位字段未在手工表单提供，服务端存 `unknown`，界面显示未知/缺失原因并将相关比率保留为 null；FR-CX-21 要求 unknown 不进入分母/同口径基准，故按已批准规则记录限制，没有擅自推断单位。

**报告与实验**：`cx13-review-multitime.spec.ts` Windows Electron 定向复跑 1 passed（31.2s，临时 Playwright config 复用现有 8287/8297/5287 服务）；UI 覆盖 T+多窗口、实验创建/放弃/结论、生成报告、编辑保存与逐项建议采纳；GET `/accounts/{id}/reviews` 读回编辑内容及 `adopted=[0]`。初次命令因默认 `reuseExistingServer=false` 与当前 E2E 服务冲突，未启动测试；复用服务后通过。模型来自本地 mock，不构成真实模型质量证据。发布是本地 E2E 记录，不是实际平台写入。

**台账状态**：G5-09、G6-01/02/05/08 更新为已检查-通过；G6-03 粉丝趋势、G6-04 洞察、G6-06 截图识别、G6-07 CSV 导入、G6-09 质量看板仍未检查。G6 主旅程（手动录入、发布回填、多时点、看板、报告、建议采纳）有页面与服务端持久化证据；这不等同于整个 G6 组完成。未发现需要改动已批准设计的缺陷，因此没有增加 docs/22 动线项。

**回归检查**：桌面 renderer `pnpm typecheck` 通过；桌面 `pnpm test:unit` 37/37，Web `pnpm test:unit` 41/41；E2E pair guard 28 对通过，`git diff --check` 通过。

**下一步**：先检查 G6-03/04/06/07/09 的可执行桌面路径与 Web 对照，再进入 G7 智能体附件/目标/例程/工件/运行恢复与逐张执行拒绝；之后补齐至少 20 次普通交互、20 次 AI 反馈固定样本、关键旅程各连续 3 次，以及生产构建/大数据量性能复测。真实模型、真实平台写入、生产库迁移与签名安装升级仍在授权外，不 push。

## 2026-11-04 DEV-QA26 checkpoint 第四轮（桌面 G8 设置验收，当前批次提交后累计 11 commits 未 push）

本轮优先完成 G8 桌面设置页点击验收，并用 Web Chromium 核对共享成员权限；仅本地 mock/E2E 数据，未改产品代码。

**已完成证据**：偏好保存、服务端读回与 Electron 完整重载恢复；模型新增/取消、默认路由持久化、密钥掩码和本地 mock 自检 7/7；用量空报表、HTTP 500 错误/重试、上限保存及重载；敏感词新增/软删除/取消永久删除/恢复；回收站空态；CSV 导出 API 200、原生保存对话框取消。桌面与 Web 各用 owner 创建 viewer 邀请并用独立 viewer 登录，成员/模型写控件隐藏，直接 PUT `/settings` 均 403。G8-03 偏好、G2-04 成员、G2-13 回收站、G2-14 导出为部分覆盖，余项写在 docs/26。设置分类导航 20 次 p50 139ms/p95 238ms、0 失败；p95 高于 200ms 目标 38ms，需复测定位慢尾。首次临时 probe 导航组定位错误，按实际分组修正后通过，未归为产品缺陷。

**未验证边界**：模型空态因本地 fixture 预置供应商不可达；editor 权限、邮箱邀请/撤销、永久删除、主题/语言、导出实际保存后的文件内容未验。mock 自检不代表真实模型质量；真实模型/真实平台/生产库/安装升级均不在本轮权限范围。AI 反馈 ≥20 次固定样本尚未开始。

**工作树与服务**：保留任务开始前既有全部未跟踪文件。退出本轮自己启动的 5179 Web Vite、8287/8297 本地 E2E 服务；用户既有 5173 与 5287 服务不碰。桌面/ Web 全量 E2E 既有基线分别 144 passed / 3 skipped / 0 failed、237 passed / 0 failed。

**下一步顺序**：G6 桌面复盘旅程（手动录入、发布后回填、多时点指标、看板、报告与建议采纳，分别取 UI 和服务端持久化证据）→ G7 桌面智能体深测（附件、目标、例程、工件、运行恢复/停止、逐张执行/拒绝）→ 固定量化样本：普通交互再采样定位 p95 慢尾，AI 反馈至少 20 次；关键旅程连续 3 次。真实模型质量、生产构建/大数据量、真实发布、迁移、签名安装升级保持未验。每批更新 26/08/交接并单任务本地提交，不 push。

## 2026-11-04 DEV-QA26 checkpoint 第三轮（推送链/动作卡/性能量化，10 commits 未 push）

全局逐项点击验收（08 登记 DEV-QA26，台账 docs/26）。本会话累计 10 个提交（main，**未 push**）：`0934d711` 2G 修复 → `7dc73bcf`/`3ea4761a` 走查记录 → `c73c8c37` 桌面专项 → `2e94801b` 回归回填 → `9e608e0f` 推送链 → `821ed902` 动作卡 → `eac115f3` 性能量化。

**本轮新增结论（全部桌面端优先）**：
1. **G5-06 推送链全通**（probe-push-review.mjs，真实 Electron）：mock 凭证（密码二次确认+AES 脱敏+检测正常）→检查逐项确认（FR-M7-07 封面强制正确阻断，API 设 960×480 封面+归一化裁剪解决）→ready→写入草稿箱 200→pushed→复盘看板出现作品。FR-M10-07 日上限计数、H-05、FR-M10-10 字段核验。技术口径：资产上传 touchContent 使 base_revision 失效（409 须重取）；封面裁剪为归一化 CropBox {x1,y1,x2,y2}，key 为 '2.35_1'/'1_1'。
2. **G7-05 动作卡桌面补缺**（g7-action-card-desktop.spec.ts，2 用例）：materials__create 非 H 门卡单击执行→succeeded→`GET /materials?account_id` 服务端真实创建验证；单卡拒绝→rejected→零写入；红线"全部执行"保持。H 门二次确认由 Web agent-cards+服务端 gate 覆盖。
3. **性能量化基线**（probe-perf-nav.mjs，27 样本 0 失败）：桌面 8 主导航页可操作时间 p50 561–655ms、p95 594–719ms（目标 ≤2s 达标，最高值 36%）；刷新冷加载 p50 563ms。**局限**：dev 构建+空数据账号，生产构建/大数据量复测列入后续。样本 .playwright-results/audit26-desktop-perf/。

**台账状态**：86 条中约 50 条已检查-通过、其余为待走查/设计不做/外部条件。双端 E2E 全量：桌面 144 passed/3 skipped、Web 237 passed/0 failed。

**剩余工作（下一批）**：
1. G8 设置页 GUI 抽查（models/usage/trash/members——桌面 d126 E2E 已覆盖本机设置，抽查为增量确认）。
2. **智能性固定评估集**（用户验收指标 §五.5，最大未完成项）：按真实工作流建固定样本（正常/信息不足/约束冲突/旧数据/模型失败/不应自动写入各≥3），预写 0-2 分评分标准，跑 mock 流程验证+标记真实模型待测。需要先与用户确认评分标准再跑分。
3. 生产构建性能复测（pnpm build 产物 + 大数据量账号）。
4. 稳定性：关键旅程连续 3 次执行统计（当前为"一次通过"记录）。

**环境**：E2E webServer 后台运行中（8287/8297/5287）；dev 栈（8080/5173/8091）运行中；probe 脚本 desktop/renderer-src/scripts/probe-push-review.mjs、probe-perf-nav.mjs（未跟踪，可复用）。

**不 push**：00086-00088 正式库核验未完成，push 触发生产部署需用户授权。


## 2026-11-04 DEV-QA26 checkpoint 第二轮（桌面专项完成，6 commits 未 push）

全局逐项点击验收（08 登记 DEV-QA26，台账 docs/26）。本轮用户指定"重心桌面端"，已完成：

**提交链（全部在 main，未 push）**：`0934d711` 2G-1 最近打开按登录用户隔离+2G-2 标题候选单列（双端）→ `7dc73bcf` 批次 B 记录 → `3ea4761a` 批次 D 首段记录 → `c73c8c37` 桌面专项（g4-image-upload 双端 spec + G8-05/06 认知修正 + 主进程盲区登记）→ `2e94801b` 双端 E2E 回归回填。

**桌面端结论**：
- 桌面 E2E 全量 **144 passed / 3 skipped / 0 failed**（16.6m）；Web E2E 全量 **237 passed / 0 failed**（22.3m）——2G 修复与新增 spec 双端零回归。
- 补齐"上传图片 file chooser"双端 spec（此前只有粘贴覆盖）：非法类型拒绝/多张入库/删除确认；技术口径：服务端 422 拒绝 1×1 占位 PNG（须 canvas 生成真实图）、Electron page 无 context baseURL（绝对 URL + 页面内 fetch，与 cx11 相同）、用 multiple 属性区分 editor-images 与 section-block 的 file input。
- 主进程静态核查：托盘/自动更新/外部深链系设计不做（17:509、RELEASE_RUNBOOK:30）；平台采集闸门全在服务端（桌面仅消费 capability 下发）；desktop-channel-backend-e2e.cjs 由 server desktop_channel_test.go 驱动（glob 不匹配系有意）；测试盲区已登记 26 §6（main.ts/desktop-client.ts/ai-worker.ts 无行为级单测）。
- 发布包放行链由 cx13-publish-ledger（Windows Electron）覆盖确认。

**尚未走查**：G5-06 mock 推送链（需公众号账号+mock 凭证，会解锁 G6 复盘录入）、G6 深度（多时点/CSV/截图识别）、G7 智能体深度（附件/目标/例程/工件）、G8 设置页逐页（models/admin/members/usage 等）、性能/稳定性/智能性量化复测（≥20 样本）。

**环境**：dev API :8080 + Web :5173 + mock :8091 后台运行中；测试账号 qa26_owner / qa26_OwnerPass2026!。Web E2E 全量日志 .playwright-results/audit26-web-e2e-regression.log，桌面 .playwright-results/audit26-desktop-e2e-baseline.log。

**不 push**：00086-00088 正式库核验未完成，push 触发生产部署需用户授权。


## 2026-11-04 DEV-QA26 checkpoint（批次 A/B/D 首段已提交，未 push）

全局逐项点击验收长任务（08 登记 DEV-QA26，唯一台账 `docs/26-全局功能审计与点击验收台账.md` 86 条）。已提交：`0934d711`（2G-1 最近打开按登录用户隔离 + 2G-2 标题候选单列，双端同构 + 单测 + E2E 回归）、`7dc73bcf`（批次 B 记录）、`3ea4761a`（批次 D 首段记录）。登记见 22 §2G。

**已完成走查（1280×720 dev 栈，测试账号 qa26_owner）**：
- 批次 A/C 前半：G1-01/02、G2-01/02、G4-02~07、G5-01（深度：在原文中修改内联编辑、人工修改比例联动、AI 声明/广告法清单）。
- 批次 B：G3-01~06/10 全链（核验→排期→水位 1/12→采用建稿库存 ready→used、体检依据回执、热点 H-01 逐条入库、收件箱 AI 建议+人工流转、日历联动、运营方案三步、异步今日推荐约 90s 逐条 H-01 采用）。
- 批次 D 首段：发布包 H-04 闸门阻断路径。

**受阻/转桌面 E2E**：图片上传与发布包放行路径（IAB 无 file chooser）；G5 剩余（构建面板/推送/回填）、G6 复盘、G7 智能体深度、G8 设置与桌面专有旅程未走。

**测试环境经验**：IAB 截图首帧偶发白屏（DOM 完整，等 3-5s）；带 transition 类按钮偶发 Playwright actionability 超时（用语义定位或坐标点击）；"采用为选题"是两段式（先展开 H-01 内联确认区再确认），坐标点击易误触支柱链接。

**dev 栈后台运行中**：API :8080、Web :5173、mock :8091；Go 全量基线 12 包全过。

**回归检查**：桌面 renderer `pnpm typecheck` 通过；桌面 `pnpm test:unit` 37/37，Web `pnpm test:unit` 41/41；E2E pair guard 28 对通过，`git diff --check` 通过。

**下一步**：批次 E/F/G（复盘/智能体/设置）→ 桌面端专有旅程（含图片上传与发布包放行）→ 性能/稳定性/智能性量化复测。**不 push**（00086-00088 正式库核验未完成，push 触发生产部署需用户授权）。


## 2026-11-04 DEV-QA26 checkpoint（全局功能审计首批已提交 0934d711，未 push）

用户启动了新的全局审计长任务（08 登记 DEV-QA26）：逐项点击验收所有用户可感知功能、量化"好用/智能"、缺陷闭环。唯一台账 `docs/26-全局功能审计与点击验收台账.md`（86 条功能、8 旅程组 G1-G8，已 force add 入库；状态字典见文档 §0）。

**已提交 `0934d711`**：2G-1 最近打开按登录用户隔离（双端新 `lib/recent.ts`，key 改 `ops.recent.{user_id}`，App.tsx 登录态接线 setRecentOwner，+3 单测）+ 2G-2 标题候选卡固定单列（2F-3 首修 lg 断点在三栏 1280 视口仍复现竖排，双端修齐）。2G-3 步骤计数"3/6"经受控实验撤销（伪影）。登记见 22 §2G、08 DEV-QA26。

**已完成走查（1280×720 dev 栈）**：G1-01/02（登录+注册）、G2-01/02（工作台+建号）、G4-02~07（创建→观点→大纲→逐段→标题→提交检查闸门）、G5-01 前半（格式阻断+AI 事实核查异步）。详情 26 §4 批次 A。

**当前 dev 栈仍在后台运行**：API :8080（go run ./cmd/ops serve）、Web :5173（pnpm dev）、mock :8091；Go 全量基线 12 包全过（日志 .playwright-results/audit-go-full-baseline.log）。测试账号 qa26_owner / qa26_OwnerPass2026!（本地 dev 库，非真实密钥）。

**回归检查**：桌面 renderer `pnpm typecheck` 通过；桌面 `pnpm test:unit` 37/37，Web `pnpm test:unit` 41/41；E2E pair guard 28 对通过，`git diff --check` 通过。

**下一步**：批次 B（G3 选题与运营）→ 批次 D（G5 交付发布后半：构建/推送/发布包/回填）→ E/F/G（复盘/智能体/设置跨端）→ 桌面端专有旅程 → 性能与稳定性量化复测。**不 push**：push 触发生产部署，00086-00088 迁移在正式库核验状态未确认（见 08 CX13-C 末尾核对清单），推送需用户单独授权。


## 2026-11-03 DEV-CX10 checkpoint（FR-CX-09 封面比例矩阵已完成，未提交）

本地新增未提交：`cover_images` 构建目标解禁（5 预设封面交付包），服务端 + 双端 UI + 双端 E2E 全绿。待按任务号 DEV-CX10 一次提交（不 push）。

**服务端**：新建 `cx_cover_build.go`（5 预设 `wechat_235` 900×383、`wechat_square` 383×383、`xhs_34` 1080×1440、`xhs_square` 1080×1080、`xhs_916` 1080×1920；严格 `options.presets` 解码 1..5/唯一/未知 422 `invalid_ratio`；canonical 顺序=设计序，逆序输入同 `params_hash` 返回 202 复用运行中构建标 `Reused`；条目名 `cover-{preset}-{w}x{h}.png` 两种 1:1 不重名；快照复核跨平台预设 `invalid_ratio`、无 `cover_asset_id` `cover_missing`；契约 `ops.cover-images/v1`；complete 逐预设 ZIP 校验共用 `cxInspectZIPEntryPNG`，`validation.covers` 落 template_version/count/entries）。接线：`cx_builds.go`（decode 分派、cover 不可与其他目标混建独立文案、删 `build_target_not_ready`、语法预检只对 wechat）、`cx_build_validate.go`（complete 解析与复核、covers 校验）、`cx_build_artifacts.go`（`zip` 同时映射 `xhs_cards`/`cover_images`）、`cx_cards_build.go`（抽公共 `cxInspectZIPEntryPNG`）。**顺带修复既有缺陷**：`cover_crops` 小数坐标以 `json.Number` 进冻结快照违反 canonical 契约（24 §4.6）致 create 500（公众号构建带裁剪同样踩中）——新增 `cxFixedPointDecimals` 在 `cxBuildSourceSnapshot` 递归转换（整数拼写保留数字，小数转定点字符串）。

**双端 UI**（各自实现）：`lib/cover-build.ts`（预设表、`coverFileName`、`coverCropBox`——wechat_235 用 `crops['2.35_1']`、两种 1:1 优先 `crops['1_1']` 回退中心、xhs_34/916 中心裁剪；`coverUpscaleFactor`；`renderCoverImages` canvas 导出 PNG）+ `CoverBuildPanel.tsx`（预设勾选、低分辨率警告 + `acceptedUpscale` 确认 checkbox 未确认拒绝执行、run→create→upload→complete→详情展示）。挂载于图片网格上方（`cover && !toutiao`），桌面版仅 `client='desktop'` 与 UA 兜底不同。

**验证**：定向 Go `TestCX10CoverBuild|TestCX09CardsBuild|TestCX02|TestCXBuild|TestCXCardsPreview` 通过；`go vet ./...` 0；两端 typecheck 0；Web 单测 38/38、`build` 通过；桌面单测 37/37、`build:desktop` 通过。E2E：`web/e2e/cx10-cover-build-web.spec.ts` 1/1（22.0s：低分辨率警告→未确认拒绝零上传→确认走通 503；清晰图 create 201→complete 503→`validation.covers` 两条目→`download_gate=build_not_complete`→artifacts=['zip'] 不可下载、assets 不变）；`desktop/renderer-src/e2e/cx10-cover-build-desktop.spec.ts` 1/1（15.7s，真实 Electron，已登记 `desktop-windows-electron`）；pair guard 通过（Web 110、桌面 67、27 对）。

**边界**：下载交付仍受 Q-CX-03/04（complete 停 `scanner_unverified`）；safe-area 仅提示未做视觉水印；GET smart-crop 未新增接口；放大由前端 canvas 显式完成、服务端不拦截低分辨率；真实封面素材与真实平台未验。决策见 90 D-164，登记见 08「DEV-CX10 FR-CX-09」小节。

**下一批**：DEV-CX10 两子项（FR-CX-11/FR-CX-09）均完成，DEV-CX10 可随提交整项闭合（下载验收除外）；剩 creative-ui 菜单竞态根因（可暂缓）；B 组决策仍未拍板。A 组本地可实施项全部完成。

## 2026-11-03 DEV-CX10 checkpoint（FR-CX-11 单图粘贴入库已提交）

提交 `922aebb9`：正文编辑器粘贴/拖拽图片入库（单图），服务端按同作品 sha256 去重。未 push。

**服务端**（`server/internal/app/assets.go`）：`POST /works/{id}/assets` 新增 `dedupe=sha256`。去重口径是 `processImage` **转码后存储字节**的 `sha256`（与 `asset.sha256` 同列同口径，不与原始上传字节混比）；查询带 `work_id`，只在本作品内复用，不返回他作资产。命中时不新建 asset 行、不写文件、不 `touchContent`（作品修订不变），响应改为追加式 `assetUpload{...Asset, reused}`（旧调用方按 `Asset` 解码不受影响）。`dedupe` 非法值 422 且错误落 `dedupe` 字段；`m.editable()` 在去重之前，锁定作品仍拒绝。测试 `cx11_asset_dedupe_test.go` 用 multipart 原始请求覆盖：首次 `reused=false`、同字节二次 `reused=true` 且 id 相同/资产数 1/修订不变、另一作品同字节不复用且归属正确、不带 `dedupe` 每次新建、`dedupe=md5` 422、锁定作品拒绝。

**两端编辑器**（各自实现，不跨目录导入）：`components/section-editor.tsx` 增加 `onPasteImage`/`onPasteNotice` 与 `editorProps.handlePaste`/`handleDrop`。规则：只处理 `image/*`；图文混排只粘文字并提示图片未插入；多图提示「一次只能粘贴一张图片（本次 N 张）」且不上传（Q-CX-05 未决）；单图先记锚点（`selection.from`，拖拽用 `posAtCoords`）再上传，返回时若 `tokenRef` 已变则不自动插入、提示「图片已入库但没有自动插入」；拖拽无论是否可编辑都 `preventDefault`。`section-block.tsx` 透传（小红书纯文本编辑器不接），`Editor.tsx` 新增 `uploadPasted` 走 `?dedupe=sha256` 且命中既有 id 时不重复追加图片列表。

**验证**：`go vet ./...` 0、`go test -p 1 -count=1 ./...` 全通过（`internal/app` 443.6s、`db` 136.6s）；两端 `typecheck` 0；Web 单测 38/38、`build` 通过；桌面单测 37/37、`build:desktop` 通过。E2E：`web/e2e/cx11-paste-image-web.spec.ts` 2/2（22.1s）、`desktop/renderer-src/e2e/cx11-paste-image-desktop.spec.ts` 2/2（22.9s，真实 Electron，已登记 `desktop-windows-electron`；文件名不同不构成 pair guard 同名对）；回归 `web/e2e/opt07.spec.ts` 5/5；pair guard 通过（Web 109、桌面 66、27 对）。

**边界**：多图一次入库仍等 Q-CX-05；复用不新建派生资产、不写 `alt_text`、不改图片顺序；真实图片素材与真实平台未验。`cover_images` 构建目标仍 `build_target_not_ready`，**FR-CX-09 封面比例矩阵尚未开工**，DEV-CX10 不整项关闭。决策见 90 D-163，登记见 08「DEV-CX10 FR-CX-11」小节。

**下一批**：DEV-CX10 只剩 FR-CX-09（封面预设 5 规格 + `cover_images` 目标），仍受 Q-CX-03/04 的交付门禁约束；之后是 creative-ui 菜单竞态根因（可继续暂缓）。B 组决策仍未拍板。

## 2026-11-03 A 组开工 checkpoint（DEV-CX02 + DEV-CX09 已提交）

按交接提示词从 A 组开工，两个任务各自一次提交：`bca10b22` DEV-CX02 Web 独立 BuildPanel、`636b45b3` DEV-CX09 options.cards 采用映射与 xhs_cards ZIP 校验链。工作树除既有未跟踪审计脚本（`web/audit-*.mjs`、`web/shot-models.mjs`、`desktop/renderer-src/scripts/`）外干净，未 push。

**DEV-CX02（Web 对称缺口闭合）**：`web/src/lib/render.ts` 补 `renderWechatSections`/`createStableWechatHTML`（段落 `data-section-id`、图片 `data-asset`、内联 data URL ≤8 MiB），新增 `web/src/pages/work/BuildPanel.tsx`（wechat_html/stable_html 两目标、按冻结快照渲染、主题 token_digest 校验、逐图 bytes/sha256 比对、隐私 WARN 逐项回执、门禁关闭不渲染下载控件），Editor 仅对 wechat_mp 挂载。浏览器端不实现 `long_image`，390px 真实长图仍由桌面隔离捕获承担。

**DEV-CX09（服务端 + 双端交付入口）**：新增 `server/internal/app/cx_cards_build.go`（options 严格 schema、3..9 张与封面首结尾末、用冻结快照重跑计划 validator 并要求要点卡文案等于预览规范化结果、ZIP 逐条目校验名称顺序/PNG/像素等于比例/完整解码/可见且非纯色/单条 12 MiB 与总量 128 MiB 上限/拒绝目录与穿越）；`cx_builds.go` 按目标分派 options、解禁 `xhs_cards`、契约走 `ops.xhs-cards/v1`、DNA 版本进来源快照使 build 与 preview 的 `source_hash` 一致、`is_current` 按冻结 DNA 重算；`cx_build_validate.go` 的 complete 增加组图分支把逐张结果写入 `validation.cards` 后再进隐私门禁。两端各自实现 `src/lib/zip.ts`（store 模式最小 ZIP）与 `CardsBuildPanel.tsx`（渲染→打包→创建→校验服务端冻结哈希→上传→complete），挂进各自 `VisualPlanPanel`。

**本轮 E2E 暴露并修正的两处真实缺陷**：①预览与构建的 `params_hash` 不一致——`cards/preview` 把 `visual_plan{diagnosis_id,input_hash,result_revision}` 写进 options 却没回传，构建面板无从回传；现由响应回传、`parseCXCardsPlanRef` 严格解析、`createCXBuild` 按 `content_diagnosis` 复核（409 `visual_plan_stale`/`visual_plan_unavailable`）。②本机栅格预览一直是空白 PNG（尺寸正确、纯背景色）——`html-to-image` 把计算样式整体内联进 `foreignObject`，离屏 `left:-12000px` 展开成 `inset-inline` 使克隆体落在画布外；捕获时归零逻辑 inset（`position:relative` + `insetInline/insetBlock:0`，只设 `left/top` 会被简写吞掉）。服务端「可见像素 + 非纯色」校验正是拦下空白卡的那道门，不得放宽。决策见 90 D-162。

**验证**：`go test -p 1 -count=1 ./...` 全量通过（`internal/app` 329s；首轮 1 项失败为新增 DNA 用例污染共享夹具账号，已改专用账号并 gofmt）；`go vet ./...` 0。Web `typecheck` 0、单测 38/38、`build` 通过；桌面 `typecheck` 0、单测 37/37、`build:desktop` 通过。E2E：Web `cx02-web-build-panel` 2/2、`cx09-cards-build` 1/1（20.3s，含 source/params 与预览逐字相同、503 `scanner_unverified`、`validation.cards` 条目与 1080×1440、`download_gate=build_not_complete`）；桌面 `cx09-cards-build-desktop` 1/1（22.1s，真实 Electron，已登记 `desktop-windows-electron`）、`cx09-visual-plan-desktop` 1/1、Web `cx09-visual-plan` 1/1 回归通过；pair guard 通过（Web 108、桌面 65、27 对）。

**边界**：Q-CX-03/04 未决，complete 仍停在 `scanner_unverified`，不置 built、不开放下载，故「下载解压后逐条校验」验收无法完成；手工编排计划的参数预览仍在 `ManualVisualCards` 内部，未上抛给构建面板；ZIP 不含独立 manifest；真实平台渲染与真实模型未验。DEV-CX02/T-CX02、DEV-CX09/T-CX08 均不整项关闭。

**下一批**：A 组只剩 DEV-CX10（封面预设 + 单图粘贴，多图入库等 Q-CX-05）与 creative-ui 菜单竞态根因（产出比低，可继续暂缓）。B 组（Q-CX-03/04/05/06/07、22 §1.9 决策 2–5、2A.5 P3 五项）需产品先拍板，本轮未动。桌面 teardown 经验：Electron 用例收尾统一 `app.evaluate(({app}) => app.exit(0))` 再 `app.close()`，否则 Windows 上偶发 worker teardown 超时。

## 2026-11-03 DEV-QA25 第二批续进 checkpoint（CX 本地可实施项）

按 25 §5 继续实施三件：①CX12 骨架引用显式路径——rewrite-check 收 skeleton_note_ids（≤5/同账号/未归档，与正文互斥 422），仅骨架 → undetermined + reference_text_required + 建 rewrite 项（不调 AI），fingerprint 去 hash 使同 run 只保留最新改写度结论；Go + 两端 cx18 骨架用例（5/5）通过。②CX13-F 拟稿软提示——draftCommentReply 读生效回复标准注入提示（与 freeze 同口径），audit 记 standard_version，标准文本不落评论；Go 通过。③CX13-D 结构缺口——两端 spec 改同名 cx13-account-analysis.spec.ts 并登记 pair guard（27 对）；上下文窗口 409 旅程补双端 E2E（桌面走命令面板真实入口；桌面纸感编辑器隐藏标题区候选按钮是原型设计非缺陷）；editor-title scroll-mt-24→32 两端。CX13-D 剩余仅第 5 项（12 脱敏场景+真实平台字段核验，外部条件）。登记：08「DEV-QA25 续进」表、25 §3 第二批/§5。全量串行回归完成：go vet 0、app 包 544s 全过（首轮 OptStandard 撞共享 fixture 409 已按专用账号修复）、Web 229 / 桌面 139 全过、pair guard 27 对。下一批建议：CX02 Web BuildPanel（1–2 天级）与 CX09 options.cards 采用映射。

## 2026-11-03 DEV-QA25 全面测试轮 checkpoint

用户要求全方位功能与 UI 测试 + 项目完成度盘点 + 按文档实施。本轮（任务登记 08 的 DEV-QA25，决策 D-161，分析文档 `docs/25-全面测试与项目完成度分析.md`，动线条目 22/2F）已完成：三套基线（Go 全量首轮 3 个失败为并行负载误报、串行复跑通过；两端 typecheck/单测/构建全绿）；GUI 主流程走查（登录→工作台→观点/大纲/起草/标题→检查→选题池→采用并开始写→375px→智能体，主链无阻断）。修复：①D-160 桌面 AI 闸门启动种子缺失（`SeedDesktopAIFromConfig`，OPS_DESKTOP_AI_ENABLED=1 此前静默失效，新增 Go 用例）；②web E2E-22 选择器适配 model-usable-row；③4 个桌面 E2E 适配 5e33da3b 后交互（账号切换器/用户菜单主题）；④creative-ui 菜单竞态加整体重试（根因未定位，已知 flaky，独立复刻 v5–v7 均无法触发）；⑤Web 布局 2F-1/2/3（步骤标题竖排、发布进度水平化、候选网格断点，仅 Web，桌面为原型对照）；⑥D-160 Web 超管 UI 同步（Admin 桌面能力/智能体特性卡片）。全量串行回归：Go 全量 GO_EXIT=0（01:0x 完成）；web/桌面 E2E 串行复跑进行中，结果回填 08 DEV-QA25-09。工作树保留此前未提交改动并叠加本轮修改，均未提交。下一步建议按 25 §5（CX09 options.cards 采用映射、CX13-D Web 端、CX02 Web BuildPanel 等）。


## 2026-11-01 DEV-CX 续接 checkpoint

DEV-CX13-D 发送前上下文预算检查已实现（00085 登记窗口元数据、runAI 发送前估算超 3/4 返回 409 context_budget_exceeded、两端模型设置页登记入口、四态定向测试）。DEV-CX03 验收矩阵剩余项已补齐（封面不计数/IsCover 豁免 unused、同数量换图 422 序列定位、外链阻断脱敏）。DEV-CX12 对标库真实 Electron 窗口旅程已补齐（cx18-benchmark-electron.spec.ts）。DEV-CX12 拆解 422 路径缺陷已修复（runAIJSON 通用 502 包装使 extraction_copy_risk 不可达；现在 validate 闭包记录最后复制错误、HTTP 层优先转 422），mock 加 #copy-echo 夹具。DEV-CX13-E 空行解析 51 条分批提示 E2E、DEV-CX03 422/stale 呈现与跨租户 404 双端证据均已补齐；evidence.csv 200 下载仍由 Go built 注入测试承载，Q-CX-03/04 门禁不变。详见 08。

DEV-CX12 旧方案对标只读标注已补齐（FR-CX-18 收尾路径）：两端 StrategyEditor 手动编辑/修订路径中旧行只读展示（choiceIndex 区分，AI 新方案路径保持可编辑），提示编辑只到对标库；双端 E2E 互补用例通过、pair guard 26 对。详见 08。

DEV-CX13-E 评论处理台账已实现（FR-CX-22，代码与自动化验收完成）：00082/00083 迁移、单条 POST（批量拒绝）、AI 分类拟稿（reply-suggest 端点，≤80 码点）、复制/已发客户端显式回执状态机、删除清正文、转选题幂等（source=manual）；双端"评论台账"页签与同名 E2E 对通过；单条操作路径偏离为 /comment-inbox/{id}（与作品批注 PATCH 同形冲突，D-157 登记）。授权读取接入与真实模型验收未做，整项不关闭。详见 08。

CX 同步任务本人资料字段补齐（24 §14.4，mock 范围）：safe_fields 白名单补 background_image_ref/pinned_title/pinned_note（上限 512/512/2048），未登记与超限仍拒；粉丝保持 account_metric_daily 单一真源；字段覆盖表见 08。真实平台样本与适配器抓取未验，T-CX-SYNC 不关闭。

DEV-CX12 骨架引用供大纲已实现（FR-CX-14 收尾路径）：generateOutline 接受 skeleton_note_ids（≤5、同账号校验），只注入受限结构字段；skeleton-notes 选择接口；cx_basis 按 omitted 明示（未扩展 v1 枚举）；两端 OutlineCard 勾选与同名 E2E 对通过。详见 08。

DEV-CX13-F 运营标准已实现（FR-CX-23，代码与自动化验收完成）：00084 迁移、owner 创建 base_version CAS、at 显式时区查询、归档只变可见性、历史 405、startCheck 冻结标准快照到 check_run（无标准不阻断，归档不改写历史）；双端"回复标准"页签与同名 E2E 对通过；archived_at omitempty 缺陷修复与 CX18 同类。检查页"新标准可用"提示已实现（standard_changed 标志 + 两端静态提示，不阻断不清确认），整项保持不关闭。详见 08。

DEV-CX03/T-CX05 状态核验更正：FR-CX-05 的服务端证据链（逐段校验、image_evidence、evidence.csv BOM/公式转义、下载与 manifest 字节绑定、跨作品阻断）此前已实现并有测试；本轮补齐 CSV 端到端下载、manifest 绑定篡改 409 与跨作品资产阻断的集成测试（cx_evidence_exports_test.go）。双端 E2E 直驱证据下载与真实平台对比仍未覆盖，CX03/T-CX05 整项不关闭，Q-CX-03/04 门禁不变。详见 08。

DEV-CX12 的 FR-CX-18 对标账号库已实现（CX18 阶段，整体进行中）：`00080` 迁移建 `benchmark_target`/`benchmark_note` 并把旧 `account_strategy.benchmarks` 幂等回填为未作答候选；服务端 `internal/app/benchmark.go` 提供两层库 CRUD（URL 规范化去 fragment/默认端口/大小写、查询参数参与识别；四问 yes=25/no=0 须理由、unknown 不算 no、不足 4 问 fit_score NULL、=50 即 weak_fit；CAS、额度 50/30、归档替代删除；8 条路由登记 16 附录 B.2/HC-28）。桌面与 Web 在账号档案页各自实现"对标库"页签，Electron/Chromium E2E 各 1/1，Go 迁移/定向/HC-01～31 全部通过；开发中修正 normalizeBenchmarkURL 大小写与 archived_at omitempty 两个缺陷（证据见 08）。FR-CX-14 结构拆解与 FR-CX-15 改写度检查均已实现（cx_structure_extract 反复制、cx_rewrite_compare 三维判定 + M9 rewrite 检查项 + 20..500 码点理由 resolution_note，00081 迁移，双端检查页与 E2E 通过，详见 08）；DEV-CX12/T-CX14/15/18 的骨架引用路径与真实模型验收仍未闭合，DEV-CX12 整体不关闭。

DEV-CX09 Web 独立计划/预览界面已按 FR-CX-08 双端各自实现补齐：`web/src/pages/work/` 新增 `VisualPlanPanel.tsx`（AI 编排、DNA 预填、历史/stale、候选保护、逐卡确认）、`ManualVisualCards.tsx`（手工草稿逐卡编辑确认、收起清空）、`VisualCardsPreview.tsx` 与 `cx-visual-cards-render.ts`（html-to-image 本机栅格预览、三档字号溢出、失败清理），挂载于 Editor 仅 xhs 作品。服务端接口无改动，仍不写 `options.cards`、不建 build、不开放 ZIP。Web typecheck/单测 38/build 退出 0，pair guard 通过（Web 101、桌面 59、22 对），Chromium E2E `cx09-visual-plan.spec.ts` 1/1（13.9s）；同轮全量 E2E 的 agent-main-chain/agent-writing 各 1 项失败为既有超时问题（历史 web-retry3 已记录，与本任务无关）。Logo/水印实图、字体/超时矩阵、正式 PNG/ZIP、Q-CX-03/04 门禁仍未闭合，DEV-CX09/T-CX08 不关闭。详见 08。

DEV-CX11 标题与选题诊断单项的服务端和桌面/Web 用户旅程均已实现。标题覆盖未保存输入、规则/AI 报告、历史 stale、候选逐项采用/撤销；选题覆盖规则/AI 分层、本人定位与历史依据、无定位 partial、历史 stale 和角度进入编辑表单后显式保存，且不改既有评分/状态。`cx_topic_diagnose` 通过定向 Go 测试；两端单测分别 37/38、typecheck 均退出 0；选题 Electron 与 Chromium E2E 各 1/1；E2E pair guard 18 对通过。`go vet ./internal/app` 与 `go test ./internal/app -run '^TestHC' -count=1` 退出 0（22.867s，HC-01～HC-31）。详细验收范围见 `docs/08`。

DEV-CX08/T-CX10 账号视觉 DNA 已按独立版本链、CAS、显式主题导入、历史回滚、Logo 范围校验和双端设置旅程闭合。DEV-CX09 桌面 `cx_visual_plan` 已接入用户选择的准确 DNA 版本与 token hash，服务端生成报告保留 DNA 快照并纳入 `cx_basis`/input hash；桌面按当前 DNA 预填模板与比例。Electron 本地 mock 旅程和服务端来源/版本测试通过，详见 08。追加交叉复核中 Web typecheck、38 项单测、production build 退出 0，CX08 Chromium 旅程 2/2；E2E pair guard 的 19 对与 `git diff --check` 通过。这些 Web 证据不代表 Web 已实现 CX09 组图计划 UI。

其余 DEV-CX11 未完成：既有大纲/逐段/标题/通读的 `cx_basis` 联动、反规避正反语料和 12 场景质量验收。DEV-CX09 桌面现可在所有卡片逐项确认后，预览规范构建参数及来源/参数 hash；服务端同时支持手工卡片预览 API，二者均只读，仍未写入 `options.cards` 或创建 build。point 卡预览按设计从来源段落导出标题与正文前 60 码点并显示 warning。桌面另有三种画幅的本机内存 PNG 栅格预览，使用预览绑定的 DNA 版本和已授权图片，逐类型生成顺序文件名并显示无法排版的溢出；模型 503 时可切换到封面/要点/结尾手工草稿，逐卡编辑与确认后进入同一只读参数预览；手工草稿收起或离开页面即清空。E2E 覆盖 5 段→7卡、9卡上限、editorial/swiss 两模板×三比例、手工 compare 原文校验、本人作品图片、无诊断/build 写入、重开重置、AI混排与长文溢出。另修复重新生成输入变化时会直接替换已有报告的问题：新输入现在先展示为候选并保留当前报告的人工修改/逐卡确认，服务端旧报告修订也不变，须用户切换后替换。当前仍未验 DNA Logo/水印实图、全部 compare 边界、失败/超时矩阵、正式文件校验；Web 独立界面已于同日补齐（见本文件开头）。本机预览不保存、不 ZIP、不下载。后续继续完成 `options.cards` 采用映射、符合 Q-CX-03/04 后的正式渲染/ZIP、逐项用户旅程；产品门禁不得因本地预览而开放。DEV-CX06 隔离长图实现已完成，但峰值 RSS、真实后台与 Q-CX-03/04 仍未验。所有旅程使用隔离数据与本地模拟模型，不构成真实平台字段或真实模型验收。

工作树包含大量本任务及此前未提交的改动，本轮未暂存或提交；继续逐文件识别归属，保留无关改动。实现进度、测试命令和未完成项以 08 中各子任务记录为准。

### DEV-CX06 / Q-CX-02 长图续进（2026-10-31）

桌面长图固定 IPC 与隔离 offscreen BrowserWindow 已实现：390 CSS px/DPR2、最多 30,000 CSS px/780×60,000 输出、8,000 物理像素分段、预检和 PNG≤64 MiB。真实 Electron E2E 通过短稿 120 CSS px、8,002 CSS px 含图/16,000px seam、30,000 CSS px 最大预算、重复请求 `capture_busy`、HTTP 图片零请求、跨窗 IPC 拒绝与窗口/profile 清理；BuildPanel E2E 通过并继续观察到 `scanner_unverified`，没有开放 built/下载。完整命令和 Q-CX-03/04 限制在 08。

最近复验：desktop `pnpm test` 236/236，renderer `pnpm test:unit` 37/37、`pnpm typecheck` 0，`go vet ./internal/app` 0；`go test ./internal/app -count=1` 全量退出 0（313.791s，含 HC-01～HC-31）。桌面长图 receipt Go 定向测试已通过。峰值 RSS、真实公众号后台、Q-CX-03/04、Web BuildPanel 和 CX09 组图渲染仍未验证/完成。

## 2026-10-30 DEV-CX 续接状态

最新续进：DEV-CX02 服务端 complete 已执行冻结 DOM/CSS、正文与图片序列、托管图片字节及稳定版 data URI 校验，保存 syntax/privacy 报告与 immutable manifest，并把 manifest、证据 CSV、artifact 下载统一接入隐私/终态门禁。桌面 `BuildPanel` 已实现冻结快照渲染、主题版本校验、冻结图片重哈希、稳定版生成/上传、历史恢复和报告查看；界面只允许“生成校验报告”，Q-CX-03 未决时服务端保持 scanner 未就绪、拒绝 built 并禁用所有下载。桌面 renderer typecheck 与定向 Go 测试通过，构建面板 Electron renderer E2E 1/1 通过；HC-28 首轮发现新路由未分类，补充 16 文档 B.2 和分类守卫后原样复跑 HC 套件通过。Q-CX-02 已实测 `html-to-image@1.11.13` 在 Electron 44 的 2×3 卡片矩阵、DPR/CDP 物理尺寸与 2530 CSS px 三段接缝，CDP detach 和隔离 userData 清理通过；普通 `capturePage` 受系统缩放影响，实验的内存数是位图估算。专用隔离隐藏窗口与生产长图尚未实现，故 Q-CX-02/DEV-CX06 仍未关闭。下一步按 24 §14.4 推进桌面长图安全入口与 CX09 视觉计划 AI 主线；Q-CX-03/04 未决仍阻断正式构建下载。未关闭 DEV-CX02/T-CX02，也未完成真实公众号验收。工作树存在大量预先未提交改动，全部保留；未暂存或提交文件。

续进：DEV-CX07 两端自定义主题编辑加入主色对白底对比度提示和保存检查，旧值仍可读取；仅为局部校验，服务端接口和其他调用入口尚不强制对比度，完整 CSS/主题验收未完成。桌面 renderer 单测 33/33、Web 34/34，typecheck 两端均通过；桌面 renderer 与 Web 各一条模拟服务 E2E 通过，Web 包括重载；未运行真实 Electron 或真实平台。详见 08 的 DEV-CX07 续进记录。开发数据库 Docker 容器已启动。下一步继续 CX07 完整渲染契约，以及 CX01 的 Go/marked 位置夹具技术前置和 AI 主线；保留工作树原有未提交内容。

当前 `main` 基线 HEAD `58e43481`，开始时已有 `.gitignore`、`AGENTS.md`、`deploy/docker-compose.e2e.yml`、`docs/90`、多项 Web E2E 与 `web/src/pages/Agent.tsx` 的未提交改动，另有未跟踪的 `docs/24` 和 `desktop/out-auth-fix/`；不要回退或夹带。24 v0.3.2 是当前 DEV-CX 规格，设计登记不代表实现。

本轮仅进行 DEV-CX07 主题增量：两端 `src/lib/render.ts` 新增四个主题，分别新增 `tests/cx-themes.test.mjs`；两端完整单测分别 32/32、33/33，typecheck 均退出 0。详见 `docs/08` 的 DEV-CX07 进行中记录。尚未完成 DOM/溢出、作品保存重载 E2E、版本与自定义 CSS 校验，不能关闭该任务；其他 CX 任务未实施或验收。无真实平台验证。下一步依 24 第 11 节继续 CX07、CX01 前置实验与 CX11/CX13-D AI 主线；保留现有同步链路，产品待决项按 14.2 单独处理。

> 审计日期：2026-10-28。当前分支：`main`。本文件记录该日 ZCode 会话实际核实的状态；未取得最终命令退出码的任务一律不记为通过。
>
> 本文件由用户明确要求创建。仓库 `.gitignore` 的 `docs/*` 会忽略普通文档，因此要纳入 Git 需在后续由维护者显式 `git add -f docs/AI_HANDOFF.md`；本次没有暂存或提交任何文件。

## 1. 项目概况

OPS 是公众号与小红书 AI 辅助运营平台。当前主要目录与技术栈：

- `server/`：Go API、业务规则、PostgreSQL 持久化、AI 与平台同步服务。
- `web/`：普通浏览器 Web 应用，React、TypeScript、Vite、pnpm；后端通过现有 `/api/v1` API 通信。
- `desktop/`：Windows x64 Electron 主进程与本机设置/平台能力；2026-10-28 的 D-155 迁移新增 `desktop/renderer-src/`，作为独立桌面渲染应用源码。
- `mobile/`：移动端相关源码/资料；本次迁移未审计其完整状态。
- `deploy/`：开发/生产 Docker Compose 与部署配置。
- `docs/`：需求、交互、数据架构、测试计划、决策记录和 Electron 设计。

本次会话的目标任务是将原来混在 `web/` 下的 Electron 呈现分支、组件和样式迁入 `desktop/`，使两个应用分别独立构建与启动；不变更业务 API、后端行为或产品能力。

## 2. 当前整体进度

当前处于 **D-155 桌面渲染层迁移的入口切换后、完整收口验收阶段**。

- 已提交的阶段：渲染层快照复制并验证、实际 desktop 启动/构建/打包入口切换。提交为 `63914a7` 与 `d266a61`。
- 尚未提交的阶段：40 个桌面 UI E2E 迁移到 `desktop/e2e/`、CI desktop E2E job、Web 桌面分支清理、Vite 代理本地化、文档同步等。它们当前在工作区改动中。
- 本次会话启动的完整 Web Playwright 命令 `cd web && pnpm exec playwright test` 在用户要求审计时仍运行中；截至审计最新可见结果目录约 30 个，**任务尚未返回结束状态，不能算通过或失败**。
- 尚未执行迁移后的 `desktop` UI Playwright E2E；未执行 Windows 打包验收；未执行全量 Go `go test ./...`；未执行 CI 工作流。
- 有先前阶段验证：web typecheck 0 错、web 构建通过、web Node 单测 39/39、desktop 主进程 Node 单测 232/232、Go HC-01～HC-25 定向测试通过、阶段切换前 Electron 主进程 E2E 21/21；renderer 独立构建与旧桌面构建 82 个产物 SHA256 相同。这些结果不能替代清理后的 Web 全量 E2E、desktop UI E2E、全量 HC 和 Windows 制品验收。

## 3. 已完成任务及验证证据

### DONE：渲染层源码独立快照

提交 `63914a7 D-155: 桌面渲染层源码独立迁入 desktop/renderer-src（未接入入口）`。

- 新增 `desktop/renderer-src/`，包含独立 React 应用源码（153 个源文件）、`index.html`、`public/`、`tests/`、TypeScript/Vite 配置、独立锁文件和说明。
- `desktop/renderer-src/vite.config.ts` 的 desktop mode 输出到 `desktop/renderer/`。
- `desktop/renderer-src/scripts/pinned-proxy.mjs` 是本目录自有代理副本；不从 `web/` 导入源码。
- `desktop/renderer-src/pnpm-workspace.yaml` 防止 pnpm 向上并入父 desktop workspace。
- 证据：`pnpm install --frozen-lockfile`、typecheck 通过；renderer 单测 49/49；与原 `web pnpm build:desktop` 产物对比 82 个文件 SHA256 完全一致。

### DONE：desktop 实际运行/构建/打包入口切换

提交 `d266a61 D-155: 桌面端启动/构建/测试入口切换到 renderer-src`。

- `desktop/package.json` 的 `build:renderer`、`test:e2e` 改用 `renderer-src/`。
- `desktop/scripts/start.cjs` 的开发 Vite cwd 与依赖检测改为 `desktop/renderer-src`。
- `desktop/test/vite-proxy.test.cjs`、desktop settings 静态测试、生产 Service Worker E2E 改用本地 renderer。
- CI desktop installer job 改为安装 renderer-src 依赖。
- 证据：入口切换后 renderer build 成功，生成 `renderer/index.html`、`sw.js`、`_headers`，bundle 包含 API origin；desktop 单测 232/232；桌面 Electron 主进程 e2e 21/21。

### DONE：保留和保护 HC 测试

迁移/清理没有删除 `server/internal/app/hc_test.go`。仓库红线是 HC-01～HC-25 不可删除或跳过；DEV-AG 增加的 HC-26～HC-31 同样适用。此会话执行过 `go test ./internal/app -run 'TestHC' -count=1 -v`，HC-01～HC-25 全通过（19.784s）；当前改动尚未跑完整 `go test ./...`，接手后必须跑。

## 4. 部分完成任务

### PARTIAL：阶段 5b 桌面 UI E2E 与 CI 迁移

工作区中可见：

- `web/e2e/` 的 40 个桌面渲染相关 spec 已 `git mv` 到 `desktop/e2e/`（文件名包括 `desktop-*`、`*-electron` 和 UA-mock 桌面呈现测试）。
- `desktop/e2e/support.ts`、`desktop/playwright.config.ts` 新增。
- `desktop/package.json` 增加 `@playwright/test`、`test:e2e:ui`；`desktop/pnpm-lock.yaml` 修改。
- `.github/workflows/ci.yml` 增加 `desktop-e2e` job，配有 PostgreSQL、Go mock、受限解析器容器、Playwright Chromium；真实 Electron 测试在 Ubuntu 按 spec 条件跳过。
- `web/e2e/support.ts` 精简为通用 Web helpers；`web/e2e/README.md` 说明桌面测试新位置。

尚无 `desktop pnpm test:e2e:ui` 的实际结果，也没有 GitHub CI 结果。当前 `web/e2e` 是否仅剩 68 个 spec、`desktop/e2e` 是否恰为 40 个，代码清单显示是；应在接手时再核对。

### PARTIAL：Web 桌面呈现分支清理

工作区中已删除 `web/src` 的 Desktop* 组件、桌面 CSS、`desktop-settings`、`desktop-presentation`、桌面平台意图桥及相关 Web 单测；多个共享页面中 Electron UA/dataset 分支已剥离；Web Vite config 已不再构建 desktop mode，也不再 require `desktop/.build/proxy.js`；`web/scripts/pinned-proxy.mjs` 是 Web 自带副本；`web/package.json` 删除 `build:desktop`。typecheck 为 0 错，普通 Web build 成功，Node 单测 39/39。

但这些改动仍**未提交**，且完整 Web Playwright 当前运行结果未知。迁移后状态需由测试及代码审计闭环确认。`platform-connection.tsx` 保留 Web 上“请在 OPS 桌面客户端发起本机平台读取”提示与禁用动作；`platform-works.tsx` 保留禁用刷新并提示桌面端，避免改变 Web 产品行为。

## 5. 全部未完成任务清单

### OPS-155-01 — 完整 Web Playwright 收尾

- **状态**：RUNNING/待结果（审计时命令仍在运行）；最终状态未知。
- **目标**：证明桌面分支清理后 Web 普通浏览器功能仍通过现有 E2E。
- **已完成**：启动命令 `cd web && pnpm exec playwright test`；测试产物目录持续增长，截至审计可见约 30 个目录。不能根据进度目录推定通过。
- **仍需完成**：取得原任务最终结果/退出码；若仍运行，让其自然结束；若已中断/结果不可得，重新运行全量 E2E。记录完整通过/失败/跳过数量与首个失败详情；修复仅限与 D-155 相关且能由证据归因的问题。
- **文件/模块**：`web/e2e/`、`web/src/**`、`web/playwright.config.ts`、`server/cmd/ops-e2e`。
- **依赖**：Web 与 desktop UI E2E 使用 5179/8180 等本机端口，串行运行；确认没有残留服务冲突。
- **实施**：检查 Web Playwright 进程/测试产物 → 获取最终日志 → 如非成功，区分旧失败与迁移回归 → 修复后重跑失败用例和全量。
- **验收**：全量退出 0；明确报告通过、失败、skip/flaky 数；既有 Web 流程无新回归。
- **优先级**：P0，第一项。
- **风险**：全量 suite 较长；本次仍运行中的测试可能在接手前完成。不要把先前的历史 E2E 记录当成本次结果。

### OPS-155-02 — desktop renderer UI E2E（迁移后）

- **状态**：UNVERIFIED。
- **目标**：在 `desktop/e2e/` 与 `desktop/renderer-src/` 当前布局下验证迁移的桌面视图和真实 Electron 测试。
- **已完成**：40 个 spec、support/config、CI job、脚本已写入工作区；旧入口阶段真实 Electron 主进程 e2e 21/21 通过，但那不是这 40 个 UI specs。
- **仍需完成**：执行 `cd desktop && pnpm test:e2e:ui`；确认 Linux 上 UA-mock 覆盖通过、真实 Windows Electron 用例按声明 skip；最好在 Windows 执行真实 Electron specs，并单独执行已有 `pnpm test:e2e`。
- **文件/模块**：`desktop/e2e/**`、`desktop/playwright.config.ts`、`desktop/renderer-src/**`、`desktop/package.json`、`.github/workflows/ci.yml`。
- **依赖**：本机 PostgreSQL（默认 5440）、Go `ops-e2e` 服务、Chromium/Playwright；配置用例不需外部密钥。CI job 需核对 parser socket 服务启动与清理。
- **实施**：Web e2e 结束后先查服务端口 → `cd desktop && pnpm test:e2e:ui` → 记录完整输出 → 修复路径、UA、mock/env 或界面回归 → Web/desktop 分别重跑受影响验证。
- **验收**：命令退出 0；报告 passed/failed/skipped；在 Windows 至少运行真实 Electron specs；确认 `desktop/test:e2e` 仍通过。
- **优先级**：P0，Web suite 后执行。
- **风险**：部分 specs 写截图到 `output/`、`.playwright-results/`、`tmpverify/`；不覆盖或清理既有 `tmpverify/` 用户数据。CI workflow 目前只是工作区改动，未获远端执行结果。

### OPS-155-03 — desktop 独立安装、打包和启动完整验收

- **状态**：PARTIAL/UNVERIFIED。
- **目标**：证明 desktop 的安装、独立 renderer、启动、make 制品和源码边界工作。
- **已完成**：切换后的 renderer 单次构建成功、bundle API origin 检查成功；desktop 主进程单测 232/232、Electron e2e 21/21（入口切换后 desktop `test:e2e` 也曾通过 21/21）。
- **仍需完成**：执行 `cd desktop/renderer-src && pnpm install --frozen-lockfile && pnpm typecheck && pnpm test:unit`；执行 `cd desktop && pnpm install --frozen-lockfile && pnpm typecheck && pnpm test && pnpm make`；验证 `resources/renderer/index.html` 与 API origin bundle；以 `pnpm start` 实际启动窗口做 smoke；检查桌面源码无 `../web`、`web/src`、`web/dist` 跨目录应用源码引用。
- **文件/模块**：`desktop/package.json`、`desktop/scripts/start.cjs`、`desktop/forge.config.cjs`、`desktop/renderer-src/**`、`.github/workflows/ci.yml`。
- **依赖**：Windows x64 Electron/Forge 环境；Node 22.22.1、pnpm 10.14.0。
- **实施**：冻结安装 → typecheck/单测 → renderer build → make → 检查 Squirrel 输出与 renderer 打包 → Windows GUI smoke → 搜索跨目录源码引用。
- **验收**：所有命令退出 0；打包产物包含本地 renderer；实际启动可加载本地 UI 并连接配置 API；桌面不从 web 导入源码。
- **优先级**：P0，desktop UI e2e 后或并行于文档审阅。
- **风险**：当前运行环境是 Windows，但实际签名安装/覆盖升级、真实 HTTPS/WSS、物理 DPI 等不因本地构建而自动验收。不得声称正式发布验收。

### OPS-155-04 — Web/desktop 无跨目录源码依赖最终静态审计

- **状态**：PARTIAL。
- **目标**：完成标准要求 Web 仅用 `web/`，desktop 仅用 `desktop/`，两端无跨目录应用源码导入。
- **已完成**：desktop scripts/config 已切换至 `renderer-src`；web Vite 反向 desktop proxy 引用已本地化；独立构建前后旧、新 renderer 产物完全相同。全局搜索曾无 web/e2e 桌面标记 spec。
- **仍需完成**：复扫所有 `.ts/.tsx/.js/.cjs/.json/.yml` 引用（排除仅文档说明和现有 API 地址）；确认 `desktop/src`、`desktop/renderer-src/src` 不导入 `web/`，`web/src` 不导入 `desktop/`；检查运行脚本、CI、Forge resource 路径。确认 `desktop/renderer-src` 内 153 文件完整性、桌面资源完整性；检查版本副本 `pinned-proxy.mjs` 与 desktop main `proxy.ts` 的契约/测试覆盖。
- **文件/模块**：两端源码、`web/vite.config.ts`、`desktop/scripts/**`、`desktop/test/**`、CI。
- **依赖**：无。
- **实施**：执行 `rg -n "\.\./web|web/src|web/dist|web/node_modules|\.\./desktop|desktop/src|desktop/.build" web/src web/scripts web/tests desktop/src desktop/scripts desktop/test desktop/renderer-src/src desktop/renderer-src/scripts .github/workflows`，逐项人工分类；移除仅遗留的应用源码引用；执行两端 typecheck。
- **验收**：无跨应用源码依赖；仅允许两端共享既有 HTTP API、明确本地代理和测试/CI基础设施路径。
- **优先级**：P0，在最终提交前。
- **风险**：不要把现有 API endpoints、用于 Electron E2E 的 `desktop/node_modules/electron` 路径误判为应用源码共享。

### OPS-155-05 — 修正文档 D-155 状态并同步 docs/04/05/08/90

- **状态**：PARTIAL。
- **目标**：使设计基线、决策记录、功能/交互/测试台账反映真实的新双应用架构和实际验收状态。
- **已完成**：工作区修改了 `docs/06-数据与技术架构.md` E2E CI 段，修改 `docs/17-Electron客户端改造方案.md` 的 INV-02，去掉“Web 中 Electron 呈现分支”基线。
- **仍需完成**：D-155 在 `docs/90-决策与变更记录.md` 的状态仍写“阶段一（迁移）完成，入口未切换”，已过期；更新为入口已切换但清理/完整验收未闭环。更新 D-155 影响文件、阶段时间点、测试结果，登记 `ops:organize-notes` Web 行为变为对话框可用（若完整测试证明预期）。更新 `docs/08` 增加当前 D-155 阶段及独立 web/desktop E2E commands/results；在 `docs/04` 标明双应用架构实施状态而不改需求；在 `docs/05` 记录桌面流程仍由独立 desktop UI 提供、Web 不再有桌面窗口入口。复核 docs/17 §1、§3、§10.6、§10.7 中所有引用 `web/` desktop 分支的实现基线与验收路径，标记历史/改为 `desktop/renderer-src`，不删历史证据。检查 `docs/06` 的目录图、CI/锁文件基线其它引用。
- **文件/模块**：`docs/04-需求与功能分级.md`、`docs/05-业务流程与交互.md`、`docs/06-数据与技术架构.md`、`docs/08-开发与测试计划.md`、`docs/17-Electron客户端改造方案.md`、`docs/90-决策与变更记录.md`。
- **依赖**：OPS-155-01/02 最终结果；至少取得 desktop E2E 与 build 结果后写数字，未跑的保持 UNVERIFIED。
- **实施**：读相应文档的章节与当前差异 → 只增量修订 → 记录证据/缺口 → 运行 `git diff --check`（有既有 whitespace 时记录，不格式化无关文件）。
- **验收**：文件/目录、入口、CI、锁文件、阶段顺序、限制和测试结果全部与代码实际一致；不将本地部分验证描述为发布完成。
- **优先级**：P1，提交前。
- **风险**：设计文档部分表述是历史决策，须用标记/版本化方式修订，不覆盖原始历史上下文。`docs/*` 默认被 gitignore，新建 handoff 文档需后续显式强制加入版本控制。

### OPS-155-06 — 处理 Admin.tsx 空 action 与 `git diff --check`

- **状态**：BLOCKED/待修复，小范围静态清理。
- **目标**：清掉桌面 BackToSettings 删除后留下的空白 JSX action，并使迁移 diff 可审。
- **证据**：审计时 `git diff --check` 报 `web/src/pages/settings/Admin.tsx:203` trailing whitespace，当前行显示空格/原 `action={}` 清理残留。
- **仍需完成**：检查 `Admin.tsx:198-205`，移除空白或无意义 `action` 行，保持原 Web 页头行为；运行 `pnpm --dir web typecheck`、`git diff --check`。
- **文件**：`web/src/pages/settings/Admin.tsx`。
- **依赖**：无。
- **实施/验收**：定位实际源码 → 删除空属性后的空白 → typecheck 与 diff-check 无新错误。
- **优先级**：P1。
- **风险**：不要借机调整其他页面格式；`AGENTS.md` 本来就有用户改动，不应格式化/覆盖。

### OPS-155-07 — CI desktop-e2e job 与迁移测试后续

- **状态**：UNVERIFIED。
- **目标**：使迁移桌面测试的 CI 编排真实运行并通过。
- **已完成**：`.github/workflows/ci.yml` 有新增 `desktop-e2e` job；cache 目标为 desktop 两个 lockfile；安装 renderer-src 和 desktop dependencies；Playwright Chromium；解析器容器清理；failure artifacts。
- **仍需完成**：先静态检查 YAML/表达式/runner working-directory/paths/timeout；核对 `OPS_DOCUMENT_PARSER_SOCKETS` socket dirs 创建、服务等待和 `ops-e2e` feature env 与 Web E2E job 保持一致；执行本机可对应的命令；之后依靠正式 CI 结果标记验证。当前没有 GitHub Actions 运行结果。
- **文件**：`.github/workflows/ci.yml`、`desktop/playwright.config.ts`、`desktop/e2e/**`。
- **依赖**：OPS-155-02。
- **验收**：CI desktop-e2e job 成功；测试数、skip 说明和 artifact 正确；不删除既有 E2E/HC。
- **优先级**：P1。
- **风险**：未经用户要求，不推送或触发 CI/生产部署；该审计会话不得执行 push。

### OPS-155-08 — 登记并验证本次 Web 页面清理行为等价性

- **状态**：UNVERIFIED，需从完整 e2e 证据确认。
- **目标**：确认清理桌面分支后 Web 行为保留且不引入无关业务改动。
- **值得核对的差异**：
  - `web/src/pages/settings/Accounts.tsx` 移除了桌面当前账号设置界面；Web 页面保留普通多账号列表。typecheck 曾通过，但 E2E 尚未结束。
  - `web/src/pages/Agent.tsx` 桌面 workbench 复杂分支移除，保留 Web 现有界面；具体迁移后的桌面版本由 renderer-src 快照提供，需两套 E2E 对照。
  - `web/src/pages/work/Editor.tsx` 中 `OrganizeNotesCard` 的 `ops:organize-notes` 监听在 Web 端成为可达，`WorkLayout` Web 菜单已有对应派发；这是旧 Web 中被 Electron guard 禁用的入口变成可用（现 renderer-src 仍保留 Electron guard 并使用该监听）。这是本次清理暴露的 Web 功能入口变化，交接者应基于实现、旧测试和业务意图判断是否应保留或恢复旧无动作行为；不要凭空扩展新功能。
  - `desktop/renderer-src` 是快照副本，与 Web 源码并存，之后两端功能修改必须明确只修改哪一应用或两边各自修改；目前没有生成同步机制。
- **文件**：`web/src/pages/work/Editor.tsx`、`WorkLayout.tsx`、`desktop/renderer-src/src/pages/work/Editor.tsx`，以及对应 Web/desktop UI specs。
- **依赖**：OPS-155-01/02。
- **验收**：Web E2E 与桌面 UI E2E 通过；`ops:organize-notes` 行为得到设计确认/既有证据支持；不存在意外功能扩展。
- **优先级**：P1。
- **风险**：保持任务范围精确，不因发现旧界面差异进行无授权的产品重设计。

## 6. 阻塞问题与待验证事项

### BLOCKED：完整 Web E2E 还未结束

`pnpm exec playwright test` 的 ZCode Bash 任务 ID 为 `exec_e3f6c1b9-017e-4dfd-8d56-d6da64c7c848`。尝试通过 `TaskOutput` 获取结果时任务仍 running，且第二次等待调用被取消；审计时目录有约 30 个新用例结果，无最终汇总/退出码。接手 Codex 第一项应检查这个任务/Playwright 进程是否仍存在，查看最终日志；如果无活动且没有最终摘要，审慎决定是否重跑。测试没有启动时间预算限制。

### PARTIAL：代码写入不等于迁移验收

- Web typecheck 0 错、Web build 通过、Web unit tests 39/39。
- desktop Node tests 232/232。
- `desktop/renderer-src` 独立构建 82 文件与旧 Web desktop build 字节一致，已在迁移前完成。
- HC-01～HC-25 定向测试通过；全量 Go `go test ./...`（含 HC-01～HC-31）未在清理之后执行。
- 当前所有 40 desktop UI specs 未经迁入后的实际运行；当前 CI job 未运行。

### UNVERIFIED：既有项目开放工作仍继续

本次用户要求整理全项目剩余任务。与 D-155 无关但设计/测试计划明示的工作包括：

- D-152/DEV-AW12 是“本机部分验证，阶段未关闭”：真实模型接受度因无合格 HTTPS `agent_chat` 路由未验证；OS DPI/200% 文本缩放、IME、读屏、完整双端竞态、完整 T-AW 矩阵与发布回退证据未完成。见 `docs/08-开发与测试计划.md` 的 DEV-AW12/T-AW 表格及 `docs/90` D-152 记录。没有对应安全模型与现场环境时，保持 UNVERIFIED，不降低安全门槛。
- 04 需求表 FR-M1-13 桌面账号设置标“主路径已实施，验收矩阵部分完成”；FR-M1-14 D-133 草案待评审、未开发；FR-M10-12/13 平台数据同步/指标能力有待验边界。桌面 UI 快照确实包含这些功能，但真实平台身份/抓取不能从 mock E2E 推定。
- `docs/22-操作动线问题清单.md` 仍有明确未验收项目，包括 375px 移动导航、各列表截断、检查页底部下一步、发布/发布包去回填、回填后去复盘、可撤销丢弃、审阅退回原因、若干网络失败重试和窄屏对照页；需按原台账决定状态，不能把本次 e2e 正在跑记为它们全部通过。
- `docs/08` 已有真实付费模型、真实平台扫码、CF/HTTPS 部署、生产签名/安装升级、Windows 缩放与系统辅助技术等未验收记录。这些不属于本次桌面目录迁移的隐式承诺。

## 7. 相关路径与架构事实

### 入口与构建

- Web：`web/package.json`（`dev/build/typecheck/test:unit/e2e`）、`web/vite.config.ts`、`web/src/main.tsx`、`web/src/App.tsx`；构建产物为 `web/dist/`。
- Desktop 主进程：`desktop/package.json`、`desktop/src/main.ts`、`desktop/scripts/start.cjs`、`desktop/forge.config.cjs`；`pnpm start` 编译 Electron TypeScript 并从 `renderer-src` 启 Vite。
- Desktop 渲染应用：`desktop/renderer-src/package.json`、锁文件、`src/`、`vite.config.ts`、`public/`；`pnpm build:renderer` 输出 `desktop/renderer/`，Forge 将 renderer 作为资源打包。
- 测试：普通 Web 浏览器 `web/e2e/`；desktop UI `desktop/e2e/`；Electron 主进程 Node tests `desktop/test/`；后端 `server/internal/app/hc_test.go`。
- CI：`.github/workflows/ci.yml` 有 `server`、`web`、`desktop`、`e2e`，以及本次新增尚未验证的 `desktop-e2e`。

### 当前预期源码边界

- `web/src` 只包含 Web 浏览器应用；已删除纯 Desktop* 组件/CSS/桥和 Electron UA 呈现分支。
- `desktop/renderer-src/src` 是桌面 UI 独立完整快照；仍包含自己专属的 Electron 分支和本机桥调用。
- 两端通过后端 API 通信；不共享应用源码包。
- 代理实现存在两份：`web/scripts/pinned-proxy.mjs` 与 `desktop/renderer-src/scripts/pinned-proxy.mjs`；代理主逻辑亦在 `desktop/src/proxy.ts`。D-155 选择本地副本方案，漂移由后续测试/审计防护。

### 环境变量（只列名称，无敏感值）

- `OPS_API_TARGET`：Vite 开发代理的后端目标；Web 本地通常 `http://localhost:8080`，desktop 开发默认远端 API。
- `OPS_API_BASE`：构建期 API 基址；Web 默认空（同源），桌面 renderer desktop mode 默认 `https://ops-api.88813888.xyz`。
- `OPS_API_PROXY`：可选开发代理。
- `OPS_DESKTOP_DEV_URL`：允许的本地 Electron renderer URL。
- `OPS_DESKTOP_NO_SANDBOX`、`OPS_DESKTOP_DISABLE_GPU`：确认环境受限时的 Electron 降级变量，默认不启用。
- `OPS_DESKTOP_PLATFORM_ENABLED`：平台采集服务进程启动开关；自动采用 `OPS_DESKTOP_PLATFORM_AUTO_ADOPT` 默认关闭，验收前不得打开。
- `OPS_E2E_ADMIN_URL`、`OPS_E2E_PLATFORM_URL`、`OPS_E2E_PLATFORM_API`、`OPS_E2E_PROD`、`OPS_DOCUMENT_PARSER_SOCKETS`：测试隔离/测试服务配置，按文档使用；不得使用真实生产数据库。

## 8. Git 状态与未提交内容

- Branch：`main`。
- 最近 D-155 commits：`63914a7`（renderer snapshot）与 `d266a61`（启动/构建/打包入口切换）。
- 工作区有大量未提交/未暂存迁移改动：Web 页面清理、40 E2E 文件移动、playwright support/config、CI、依赖锁、文档等。本次审计没有改写、暂存或提交现有改动。
- `AGENTS.md` 在本会话开始前已处于 `M` 状态，属于用户已有修改（新增“先在 GitHub 查类似开源项目”等本地规范）；不要覆盖或擅自格式化。
- `tmpverify/` 在会话开始时已是未跟踪目录（含平台同步验证资料）；本次没有删除或改动它。
- 新建文档受 `.gitignore` 的 `docs/*` 规则忽略。是否 force-add 由接手者/维护者在提交时决定；本次未暂存。
- `git diff --check` 当时报告 `web/src/pages/settings/Admin.tsx:203` trailing whitespace（空 action 清理残留）；必须修正/复核后再提交。Git 还输出大量 LF→CRLF 警告；不要因此批量转换所有迁移源文件，避免引入无关差异。
- 无任何新提交、push、部署或生产配置操作。

## 9. 下一阶段推荐执行顺序

1. **先检查运行中的 Web E2E**：确认任务 `exec_e3f6c1b9-017e-4dfd-8d56-d6da64c7c848` 的最终日志与退出码。当前无结论。若仍在跑先让它自然完成；若进程已结束且日志无摘要，重新执行并保存日志。
2. **解决 Web E2E 失败**：区分本次迁移导致与历史失败，必要时只改证据确定的代码/断言；测试不得跳过、删减或降低断言。
3. **执行 desktop UI E2E**：`cd desktop && pnpm test:e2e:ui`；记录 Ubuntu/本机实际 skip 与通过；然后在 Windows 执行真实 Electron spec。
4. **完整桌面验证**：renderer typecheck/unit、desktop `pnpm typecheck && pnpm test && pnpm test:e2e`、Windows `pnpm make`、资源/API-origin 验证与 GUI smoke。
5. **完整后端/HC**：`cd server && go test ./...`（或按 docs/08 要求的串行资源限制命令）及 `go vet ./...`。保留 HC-01～HC-31；不删除或 skip；若具体数据库/解析器依赖不可用，报告阻塞而非改测试。
6. **代码边界审计**：验证无跨目录应用源码依赖、40 个桌面 specs 已不在 web/e2e、CI job 可加载、proxy 脚本复制差异有契约测试；检查 `desktop/renderer-src` 源文件/资源完整。
7. **修复 diff-check 与文档状态**：优先处理 Admin.tsx trailing whitespace；按第 5 节更新 D-155/04/05/08/17/90 文档。审视 `ops:organize-notes` 行为是否符合既有需求/测试证据。
8. **最后复核完整迁移标准**：两端独立构建/启动；无跨源码导入；Web 和 desktop 行为分别有测试；文件归属/CI/README/文档一致。只有此时才可把迁移记 DONE。
9. **遵循仓库单任务提交方式**：维护者授权提交前不要提交；提交时一次一个任务、信息带任务编号。不得 push 或部署，除非用户另行要求。

## 10. 验收标准

| 验收点 | 必需证据 |
| --- | --- |
| Web 独立 | `cd web && pnpm typecheck && pnpm run build && pnpm test:unit && pnpm exec playwright test` 退出 0；普通 Web 入口仍为 `web/`，无桌面 renderer 引用 |
| Desktop 独立 | `cd desktop/renderer-src && pnpm install --frozen-lockfile && pnpm typecheck && pnpm test:unit` 退出 0；`cd desktop && pnpm typecheck && pnpm test && pnpm build:renderer && pnpm make` 成功；Windows 真实 UI smoke |
| E2E 所属清楚 | 普通 Web spec 在 `web/e2e`；桌面 UI/UA-mock/真实 Electron specs 在 `desktop/e2e`；两边 CI/config 路径匹配 |
| 无跨目录源码依赖 | 对 `web/src`, `desktop/src`, `desktop/renderer-src/src` 的 `rg` 审计无互相导入；API/测试基础设施的明确引用单独说明 |
| 桌面完整性 | 原桌面独占组件、样式、平台/设置桥和 Electron UI 功能在 renderer snapshot 存在且 E2E 通过；resources/renderer 被 Electron/Forge 正确使用 |
| Web 行为保持 | full Web E2E 通过；平台登录/同步在 Web 保持“由桌面端发起”提示和禁用状态，不新增 Web 本机能力 |
| 红线测试 | HC-01～HC-25 与 HC-26～HC-31 均保留，全量后端测试通过且无不当 skip |
| 文档与工作区 | D-155 状态与事实一致；`git diff --check` 无新增 whitespace 问题；用户现有 AGENTS.md 和 tmpverify 未损坏 |

## 11. 开发限制和注意事项

- 先读仓库 [AGENTS.md](../AGENTS.md)，并按要求读 `docs/04`、`05`、`06`、`08`、`90` 及相应详细设计；实现与决策不符先登记决策。
- 不添加“全部起草/全部确认/全部入库”或智能体“全部执行”入口；写入逐张由用户执行。
- 不在代码、日志、测试数据写入真实密钥；不把密钥、Token 或生产 `.env` 放进交接文档/提交。
- 不删除或跳过 HC-01～HC-25；DEV-AG 的 HC-26～HC-31 同样保留。
- 不修改后端 API、产品行为或非本任务文件来“顺手整理”；碰到真实差异先记录证据。
- 不覆盖/清理已有 `tmpverify/`、用户 AGENTS.md 变化、构建外的诊断证据。
- 构建出来的 `web/dist/`、`desktop/renderer/` 是生成物；不要把它们当源码迁移证据。
- D-155 采用整体快照，不是共享 package；之后 UI 改动需要清楚选择 Web、desktop 或两边分别维护。
- 本地构建与 mock e2e 不能证明真实平台登录/同步、付费模型效果、TLS/WSS、签名安装升级、Windows 系统 DPI/IME/屏幕阅读器。

## 12. Codex 接手后的第一步操作

1. 读取本文件以及 `AGENTS.md`、`docs/04-需求与功能分级.md`、`05`、`06`、`08`、`90`、`17`；注意 D-155 条目当前仍写着阶段一、入口未切换，这是已过期文本。
2. 执行 `git status --short`、`git log -5 --oneline`，不要 reset/clean；核实本文件列的工作区状态仍准确。
3. 检查后台任务 `exec_e3f6c1b9-017e-4dfd-8d56-d6da64c7c848`；取得完整 Web E2E 结果和退出码。若缺失，先运行测试，不要先清理/提交。
4. 先收口当前 D-155 验证，再决定后续项目任务；不要把 D-152、D-133 等开放事项误当成本次授权的新增开发需求。

---

## 给后续 Codex 的最短状态提示

当前工作不是从空仓库开始：D-155 renderer 快照迁移与入口切换已有两个提交；Web 桌面分支清理、40 个 desktop UI specs 迁移、CI/UI config 与文档修改仍在 `main` 工作区未提交。此前清理后的 Web typecheck=0、build 通过、unit 39/39、desktop 主进程 unit 232/232、HC-01～25 定向通过。**完整 Web Playwright 正在/曾经运行但没有审计到最终结果，desktop UI Playwright 尚未运行，Windows make/GUI 和全量 Go/HC 尚未重跑**。第一件事检查 Web Playwright 任务/日志，然后按 OPS-155-01 至 OPS-155-08 完成审计表中的验证、边界复核、文档收口和 diff-check。不要覆盖 `AGENTS.md` 或 `tmpverify/`，不要跳过 HC，不要提交或推送。

## 13. Codex 接手续跑记录（2026-10-28）

- 当前 `main` 的 D-155 入口提交为 `d266a61`、`63914a7`；保留已有暂存/未暂存迁移改动、`AGENTS.md` 和 `tmpverify/`。未提交、推送或部署。
- OPS-155-01：原 ZCode Task ID 无法在当前环境查询，未发现其活动 Playwright 进程；原结果不可得。首次重跑发现 `/register` 白屏，trace 中 React Router 报 `<Route>` 未被 `<Routes>` 包裹；前 11 项通过、后续多个用例卡在注册，主动中断，未取得完整汇总。证据：`.playwright-results/d155-web-e2e-20261028.log` 与同名结果目录。
- 修复 `web/src/App.tsx`：恢复原桌面宿主曾提供的 Web 根 `<Routes>` 包装。`cd web; pnpm typecheck`：EXIT=0，日志 `.playwright-results/d155-web-typecheck-20261028.log`。
- 修复后全量 `cd web; pnpm exec playwright test --output ../.playwright-results/d155-web-e2e-20261028-after-routes --reporter=list`：EXIT=1，150 passed、1 failed，16.8m；唯一失败 SK6 从 Web registry 读取迁走的 `desktopHidden`，日志及 trace 位于对应 `.playwright-results` 目录。
- SK6 断言按应用归属迁移：Web 保留唯一注册和可见性断言，桌面 renderer 保留 `desktopHidden` 断言。Web 定向 `pnpm exec playwright test e2e/skills.spec.ts -g SK6 --output ../.playwright-results/d155-web-sk6-20261028 --reporter=list`：EXIT=0，1 passed；desktop 定向 `pnpm exec playwright test e2e/skills-boundaries.spec.ts -g TestSkillDesktopDirectRoutesExposeWebLinkWithoutManagement --output ../.playwright-results/d155-desktop-sk6-20261028 --reporter=list`：EXIT=0，1 passed。日志分别在同名 `.log`。
- OPS-155-01 仍为 UNVERIFIED：上述断言调整后须重跑完整 Web suite 并记录最终退出码、数量。其后串行执行 OPS-155-02 桌面 UI 全量、OPS-155-03 安装构建打包及启动、OPS-155-04 边界审计，随后 Go/HC、CI、文档与其余交接任务。不得用定向通过代替全量结果。
- OPS-155-01 DONE（2026-10-28）：修正 SK6 后 `cd web; pnpm exec playwright test --output ../.playwright-results/d155-web-e2e-20261028-final --reporter=list`：EXIT=0，151 passed、0 failed、0 skipped，17.4m；日志 `.playwright-results/d155-web-e2e-20261028-final.log`，结果目录同名。以上证明本机 mock Web 回归，不替代真实平台验收。下一步 OPS-155-02。
- OPS-155-02 首轮 UNVERIFIED（2026-10-28）：为避免覆盖已有 `.playwright-results`、`output/` 和 `tmpverify/` 截图，在 `.playwright-results/d155-desktop-isolated/desktop` 设置独立 cwd，对源码/依赖建立 junction；以 `OPS_E2E_DESKTOP_AI_ENABLED=1`、`OPS_E2E_PROD=0` 和未设置 `ELECTRON_RUN_AS_NODE` 执行 `node F:/code/project/OPS/desktop/node_modules/@playwright/test/cli.js test -c F:/code/project/OPS/desktop/playwright.config.ts --output F:/code/project/OPS/.playwright-results/d155-desktop-isolated/results --reporter=list`。EXIT=1，142 passed、6 failed、2 skipped，23.3m；完整日志 `.playwright-results/d155-desktop-isolated/desktop-ui.log`，trace 同目录 `results/`。真实 Electron 计划问题等待 POST 超时；真实 Electron AW02 超时且其专用 Electron 进程阻塞清理，核对唯一临时 profile 后仅终止该 PID 使套件继续；旧版智能体消息区高度差 3.5px（阈值 3px）；真实 Electron 会话列表隐藏；选题筛选 select 高度差 2px（阈值 1px）；复盘统计区高度差 3.8125px（阈值 2px）。未改变阈值，原因待调查。跳过：Windows 原生拖动测试无法取得前台输入焦点；平台意图测试缺少专用隔离服务 URL/API 配置。桌面 SK6 定向断言在全量中也应以日志具体结果核实。需逐项复现、修复后重跑，不能将此轮标为通过。
- OPS-155-02 续查：全量第 130 项桌面技能直达和 `desktopHidden` 断言通过。AW02 trace 显示主题和视口断言执行后卡在 `app.close()` 的原生退出确认；在该用例的清理中确认退出后定向通过（`.playwright-results/d155-desktop-targeted/run.log`，两项中 AW02 通过、另一项失败，EXIT=1）。真实 Electron 业务窗测试按 960px 既有抽屉契约检查隐藏、打开、搜索、关闭，并等待首次隐私提示后确认；定向复验 `desktop-creative-ui.spec.ts -g '真实 Electron 业务窗按客户端主题与动效呈现'`：EXIT=0、1 passed，日志 `.playwright-results/d155-desktop-targeted-2/run.log`。其他四项仍待调查和复验，桌面全量尚未通过。
- OPS-155-02 再次定位：剩余四项在 `.playwright-results/d155-desktop-targeted-3/run.log` 定向重跑仍为 4 failed、EXIT=1。AW07 测试等待后端问题记录但未等待前一条消息 POST 完成，导致下一条填入后被前次响应清空；现等待该 POST 的 202 和输入框清空，随后按原断言继续。真实 Electron 定向复验 `.playwright-results/d155-desktop-targeted-3/aw07.log`：EXIT=0、1 passed。旧版智能体、选题池与复盘三个原型尺寸差异仍未修复或验收。
- OPS-155-02 尺寸续查：Windows 复现 `.playwright-results/d155-desktop-diagnostic/run.log` 显示智能体提示文字高 16px 且有 4px 底部 margin，原比较只扣文字高度；现计入实际 margin，阈值不变。复盘卡片使用网格小字行高和数字字体不同于原型，已按原型行高/字号/字重对齐；两项定向在 `.playwright-results/d155-desktop-layout-fix/run.log` 通过（该轮 2 passed、1 failed、EXIT=1）。选题 select 二次诊断发现其 `appearance: none` 与原型原生 select 导致 Windows 自然高度差 2px；采用原型原生外观和自然尺寸后 `.playwright-results/d155-topic-fix-2/run.log`：EXIT=0、1 passed。临时诊断输出代码已移除。六项失败均有针对性通过证据，仍须完整桌面 suite 重跑，且 Linux CI/原生拖动/独立平台意图尚未验收。
- OPS-155-02 本机 UI 复跑（2026-10-28）：隔离 cwd 下以 `OPS_E2E_DESKTOP_AI_ENABLED=1`、`OPS_E2E_PROD=0` 运行 desktop Playwright 全套（同首轮配置，结果目录 `.playwright-results/d155-desktop-full-final/results`），EXIT=0，148 passed、2 skipped、18.1m，日志 `.playwright-results/d155-desktop-full-final/run.log`。真实 Windows Electron 测试包含 AW07、AW02 和业务窗口主题；原先 6 项失败均在完整队列中通过。2 项 skip 仍未验：系统拖动因前台焦点不可得，平台意图因未配置专用隔离服务。Linux CI 与 `pnpm test:e2e` 仍待验；OPS-155-02 保持 PARTIAL。
- OPS-155-07 静态检查发现新增 desktop-e2e parser 容器挂载目录未预先创建；已按现有 Web job 加 `mkdir -p "$socket_dir"`。远端 Actions 未运行，CI 状态仍 UNVERIFIED。
- OPS-155-06：已删除 `web/src/pages/settings/Admin.tsx` 空白尾随行；`git -c core.safecrlf=false diff --check` EXIT=0。Web typecheck 需在最终修改后再执行并记录。
- OPS-155-03 进行中：在 `.playwright-results/d155-desktop-build/desktop` 源码副本中 renderer 与 desktop `pnpm install --frozen-lockfile`、两端 typecheck 均 EXIT=0；renderer 单测 49/49，desktop `pnpm test` 首轮因副本缺少 sibling `tools/` ENOENT（217 passed、1 failed），补只读 junction 后复跑 EXIT=0、232/232。`pnpm test:e2e` 首轮 EXIT=1、0/21，隔离目录内 Electron 子进程退出码 2147483651；对比原 Electron 73 个文件 SHA256 均一致，工作区新建路径中的 Electron `--version` 同码失败，复制到系统临时目录后 EXIT=0。以 `ELECTRON_OVERRIDE_DIST_PATH` 指向临时目录的相同版本文件重跑 `pnpm test:e2e`：EXIT=0、21/21，日志 `.playwright-results/d155-desktop-build/desktop-main-e2e-rerun.log`。这是明确的环境路径限制，独立安装包与直接启动仍需验证。
- OPS-155-03 Windows 制品：系统临时副本 `C:/Users/User/AppData/Local/Temp/ops-d155-package-20261028/desktop` 两端冻结安装 EXIT=0；`pnpm make` EXIT=0（日志同父目录 `desktop-make.log`），生成 Squirrel Setup.exe 203137024 bytes、full.nupkg 202473787 bytes 和 RELEASES。确认打包资源 `resources/renderer/index.html`、`sw.js`、`_headers` 存在且 JS 含 `https://ops-api.88813888.xyz`。未安装制品、未做签名或覆盖升级。
- OPS-155-03 启动：带隔离 APPDATA 的 `pnpm start` 命令被自动审批审查拒绝，工具只返回 blocked by policy；该精确命令记 UNVERIFIED。改用客户端既有 `--user-data-dir` 参数，启动临时副本编译主进程与 Vite（本地 mock API）进行实际窗口检查；首轮窗口尚未 show 时检查失败，等待可见条件后 `node ../smoke.cjs` EXIT=0，visibleWindows=1、profile 精确匹配、登录页 `http://127.0.0.1:5179/login?next=%2F`、API /auth/status=200。脚本、截图和两轮日志保存在 `C:/Users/User/AppData/Local/Temp/ops-d155-package-20261028/`。P0 的本机构建/打包和替代启动证据已取得，精确 pnpm start、签名安装/升级及发布验收未声称通过。
- 后端全仓验证（2026-10-28）：`cd server; go test -p 1 -count=1 -timeout=20m -json ./...` EXIT=0；日志 `.playwright-results/d155-go-full.jsonl`，1019 个测试 pass、0 fail、5 skip（真实 Electron 专用通道、真实技能模型、两个 XProbe、旧二进制回退环境门控）；HC-01～HC-31 相关 36 个测试均 pass。未修改或跳过 HC。Go vet 待执行。
- OPS-155-04/06/08：已检查两端应用源码边界及测试归属：桌面 40 个 spec 已迁至 desktop/e2e，Web 原 68 个 spec 加 1 个新增回归；未发现两端跨目录导入应用源码。两份 pinned-proxy.mjs SHA256 一致，desktop 代理单测通过；CI 实际 Actions 未运行。README、04/05/06/08/17/90 已更新，历史记录保留；`git diff --check` 与 `git diff --cached --check` 均 EXIT=0（Git 提示既有 LF/CRLF 转换警告）。
- Web 要点整理：`Editor.tsx` 中事件监听不再受桌面判定限制，保留原 Web 卡片和更多菜单共用的对话框，仍需用户确认生成/写入。新增 `e2e/d155-web-entry.spec.ts`：首轮 EXIT=1，测试错误地按未提供 aria-label 的对话框名称定位，且未等待编辑器加载；改为按内部标题定位并等待卡片出现，定向复跑 EXIT=0、1 passed，结果目录 `.playwright-results/d155-web-entry-rerun-20261028`。最终源码 `pnpm typecheck` EXIT=0、`pnpm test:unit` EXIT=0、39/39；`pnpm build` 在系统临时源码副本 EXIT=0，存在既有 CSS ::highlight 优化警告，产物未覆盖工作区 dist。完整 152 项正在重跑：`pnpm exec playwright test --output ../.playwright-results/d155-web-complete-20261028 --reporter=list`，日志 `.playwright-results/d155-web-complete-20261028.log`，尚无最终状态。
- 平台意图真实 Electron：隔离配置使用 renderer Vite :5285、ops-e2e :8285 和 mock :8286，设置 `OPS_E2E_PLATFORM_URL`、`OPS_E2E_PLATFORM_API` 和服务端平台开关；第一次配置误载两份 Playwright，EXIT=1、无测试；修正后首次有效运行 EXIT=1，在账号设置按钮点击时页面跳转/元素脱离，trace 在 `.playwright-results/d155-platform-intents-rerun-20261028`；未修改测试断言，第三轮 EXIT=0、1 passed，覆盖同步、账号指标、单作品指标和恢复，日志 `.playwright-results/d155-platform-intents-third.log`。首次点击超时的偶发原因尚未完全确定，稳定性 UNVERIFIED。全量桌面 suite 中该用例仍是 skip，以上为独立复验。
- `cd server; go vet ./...` EXIT=0。剩余限制：原生拖动前台焦点、精确隔离 APPDATA `pnpm start`（自动审批拒绝）、远端 CI、签名安装/升级和真实平台等未通过验收；不要将上述单次 mock 成功扩展为发布验收。
- OPS-155-07 静态补验：Python PyYAML 解析 `.github/workflows/ci.yml` EXIT=0，识别到 desktop-e2e 的 11 个步骤；配置与 artifact 路径复核一致。此检查不证明 GitHub Actions 环境执行成功。
- OPS-155-01/08 最终源码完整复验：`cd web; pnpm exec playwright test --output ../.playwright-results/d155-web-complete-20261028 --reporter=list` EXIT=0，152 passed、0 failed、0 skipped，15.5 分钟；日志 `.playwright-results/d155-web-complete-20261028.log`，包含新增菜单/卡片整理入口及取消不写入测试。此前“正在重跑”的条目为时间顺序记录，以此最终结果为准。D-155 本机功能与回归证据已收集；OPS-155-02 原生拖窗、OPS-155-03 精确 pnpm start、OPS-155-07 远端 CI，以及平台测试偶发跳转稳定性仍为 UNVERIFIED，真实平台和签名安装升级不在本机 mock 验证范围。

## 14. DEV-QA26 续验检查点（2026-11-04）

- 本轮基线 HEAD 为 `41173c78 DEV-QA26: 桌面 G6 尾项验收`；桌面 G7 深测批次已提交 `bbc6914 DEV-QA26: 桌面 G7 智能体逐项验收`。未推送、未部署。提交包含 4 个 renderer E2E spec，以及 docs/08 与 docs/26；无产品代码修改。
- G7 定向真实 Electron 组：agent 对话恢复/停止/重生成，分组/未读/搜索/归档/恢复，上下文、技能请求、PNG+TXT 附件，策略与提示词。主 G7 组此前 12 passed / 1 skipped / 0 failed；策略设置复验 1 passed（10.1s）；desktop renderer `pnpm typecheck` 退出码 0。Web G7 主组 28 passed，桌面动作卡 2/2 passed，完整细节见 docs/26 §4。
- G7-12 当前明确部分覆盖：隔离 Electron owner 的 workspace `enabled=false`、全局闸门开启；实际从“本机 AI 配置”尝试保存无密钥回环模型，服务端返回“当前工作区尚未启用桌面 AI”，保存后和刷新后模型选项均为空，策略读回完全一致。没有更改策略、访问回环端点、自检或模型调用。授权开启下保存/重载、策略保存/取消和全局关闭分支仍未验；不要为了验收擅自打开授权。
- 修改/提交后检查：`git diff --cached --check` 退出码 0；保留的未跟踪内容包括 `web/audit-*.mjs`、`web/shot-models.mjs`、`desktop/renderer-src/scripts/`、两项 `_tmp_*`，以及本续验临时脚本 `desktop/renderer-src/qa26-agent-feedback-samples.mjs` 和 `qa26-reuse.playwright.config.ts`。不清理或覆盖这些文件。
- 下一批继续用户指定优先级：桌面 G8 未覆盖的命令面板、通知、偏好主题/语言、无障碍/窄视口及 G6 有效 CSV 保存内容、非空质量看板。每批更新 docs/26、docs/08 和本文件；有明确产品缺陷时按入口复现、根因、最小修复、原步骤复验及相关回归闭环，单任务提交并带 DEV-QA26。真实模型、真实平台发布、生产库迁移、签名安装升级保持未授权，不推送。

## 15. DEV-QA26 G8 系统入口检查点（2026-11-04）

- G8 命令/通知/主题重载验收已提交 `8ee6eac DEV-QA26: 桌面 G8 系统入口验收`，位于 G7 提交 `bbc6914` 之后。未推送、未部署；本批只增加真实 Electron E2E 与 Playwright project 登记、docs/08/26 状态，无产品逻辑改动。
- Desktop `g8-system-electron.spec.ts` 真实 Electron 1/1 passed（8.6s）：Ctrl+K 聚焦、空查询分组、搜索偏好并 Enter 导航、快捷键帮助 Escape、通知和 AI 任务空态、服务端空列表读回、主题写入 localStorage 且 reload 保持。`pnpm typecheck` 退出码 0。两次首轮错误为测试误按 ArrowDown 命中搜索兜底项及快捷键对话框 locator 过窄，修正后复验通过。
- Web 对照 `cd web; pnpm e2e -- e2e/opt18.spec.ts e2e/opt24.spec.ts`：2 passed（27.5s）。覆盖命令面板设置搜索与面板延迟加载。
- G8-02 仍部分：仅 Electron 空通知/空任务和服务端空读回；非空通知单条/全部标读、SSE 真实变化与 Windows OS 通知权限/投递未验。`G8-03` 主题重载通过，写作偏好读写重载见之前 G8 设置页批次；需求 04/05/06 与页面/API 都未定义界面语言字段，所以不自行补实现。
- 下一步：G8-08/09（Web 375px 与双端键盘/无障碍）以及 G8-07 部署配置只读审计；后回 G6 导出 CSV 保存内容、非空质量看板。仍保留原始 untracked `web/audit-*.mjs`、`web/shot-models.mjs`、desktop 两项 `_tmp_*` 与 `desktop/renderer-src/scripts/`；续验自己的临时 `.mjs`/reuse config 未清理。

## 16. DEV-QA26 G8 第二批检查点（2026-11-04）

- G8-07 静态配置核验已完成：`config.go` 桌面 AI/平台采集/自动采用默认 false，爬虫默认 `off`；`.env.example` 和部署 workflow 的 push 闸门符合 docs/06。没有读取生产 `.env`、改开关、运行 workflow 或部署。
- G8-08/09 Web 定向命令：`cd web; pnpm e2e -- e2e/nw-r2p1.spec.ts e2e/opt67.spec.ts e2e/opt75.spec.ts -g "GL-01|OPT67 派生对话框|OPT75 检查项可用 Tab" --output ../.playwright-results/qa26-g8-web-mobile-a11y-20261104 --reporter=list`：3 passed（38.0s）。含 375×812 更多导航到 9 个一级/设置路由、派生对话框焦点循环/Escape 恢复、检查项 Tab+Enter。全页面横向溢出/触控目标、读屏器和 IME 仍未验；G8-08/09 部分。
- G2-14/G8 导出：新增真实 Electron `g8-export-electron.spec.ts` 并登记 desktop-windows-electron。`cd desktop; pnpm test:e2e:renderer -- --config qa26-reuse.playwright.config.ts --project=desktop-windows-electron e2e/g8-export-electron.spec.ts --output ../../.playwright-results/qa26-g8-export-final-20261104 --reporter=list`：1 passed（8.7s）；`cd desktop/renderer-src; pnpm typecheck` EXIT=0。下载文件写入唯一结果文件并重读核验 CSV 表头、账号和作品标题；Playwright Electron 本身不报普通 download event，不据此判断失败。
- 先前导出 E2E 初始化未设置本地当前账号，Electron 暂时停留在 `/settings/accounts`；对账号进行测试态本机选择并回到工作台后，真实菜单/设置点击通过。无需产品代码修复。`.playwright-results/qa26-g8-export-*.csv` 仅有本次唯一输出路径，保留不清理。
- docs/26、docs/08 已更新 G2-14/G8-07～09。本批未改产品代码、未新增 docs/22 项、未部署/推送；下一步继续 G6 CSV 有效/无效预览逐行确认和非空质量看板服务端读回，再按独立任务提交。

## 17. DEV-QA26 G6-07 同名 CSV 与导入角色权限检查点（2026-11-04）

- G6-07 闭环已实现：重复标题不再默认选最近更新作品；标题+RFC3339 发布时间唯一对应才自动匹配，无发布时间的歧义行留待用户手动选；候选显示发布时间和短 ID。viewer 的 CSV 入口隐藏，服务端继续执行写权限拒绝。
- 真实 Electron 与 Web 各合跑同名消歧、editor/viewer 测试 2/2：桌面 1.2m，Web 60.0s。viewer 直调 POST 为 403 且指标为 0；editor 点击确认后 GET 指标读回 `source=file`、reads=321、day_offset=7。Go `TestU106MetricsImportDuplicateTitleRequiresDisambiguation` 连同 CSV 回归和 HC-01～31 定向组通过（23.156s）。双端 typecheck、31 对 E2E 配对守卫和 `git diff --check` 通过。
- 本批涉及 `server/internal/app/metrics_import.go`、`server/internal/app/u106_backfill_test.go`、双端 Review 页面与 `g6-review-import-quality.spec.ts`；文档同步 docs/08、docs/22、docs/26。提交前需只暂存本批 9 个跟踪文件；既有 untracked 脚本、临时文件、Playwright 配置保持原样。提交消息按 `DEV-QA26`，不 push。
- G6 CSV 重复匹配和导入角色权限已验证；质量看板 AI 反馈仍未验。继续优先桌面 G8 设置中尚未覆盖的空态、错误、取消、权限和保存重载，再按 26/08 清单继续 G6/G7。真实模型费用、真实平台、生产迁移、签名安装升级仍不在本机 mock 范围。

## 18. DEV-QA26 G6-09 复盘反馈与报告只读权限（2026-11-04）

- 修复 2G-6：viewer 在 Web 与真实 Electron 的报告卡不再看到编辑、记住/忽略、采纳和填入实验控件；根因是 `ReportCard` 未接入父页面已有的 `useCanWrite()`。服务端写权限原本正常。
- 桌面/Web 定向 E2E 各 1/1：viewer 读报告、四种写请求均 403 且 owner 状态不变；owner 从 UI 忽略和采纳后，reviews、quality calls、看板均有服务端读回证据。命令/配置与 typecheck、单测结果见 docs/08 G6-09 记录。
- 双端 typecheck、桌面单测 37/37、Web 单测 41/41、pair guard（116 Web/76 桌面/31 对）通过。mock 只验证流程，不证明真实模型质量；G6 报告反馈 20 次延迟样本仍未完成。
- 本批代码与 docs/08/22/26 已单任务提交 `1f8825c7fd431bacd1c5567464f30c6ba4823af9`（`DEV-QA26: G6 复盘反馈只读权限`）；未推送或部署。既有未跟踪脚本、临时文件与 Playwright 配置继续保留，不清理。下一步回到 G8 未验设置项并同步核对 Web，之后继续 G6/G7 未验清单。

## 19. DEV-QA26 G8-02 通知中心与 Web 铃铛可访问名称（2026-11-04）

- 已提交 `5f6f0db DEV-QA26: G8 通知与铃铛无障碍`，只含通知双端 E2E、Electron project 登记、Web 铃铛 `aria-label` 与 docs/08/22/26。HEAD 为该提交；未 push、未部署。
- 真实 Electron 与 Chromium owner 从工作台通知铃铛进入面板，由本地邀请注册 viewer 触发 `member_joined`；SSE 在 10 秒内使列表 GET 递增，轮询回退为 30 秒。单条通知 POST read 后 GET `read_at` 非空；再产生两条并点全部已读，GET `unread=0` 且所有通知均有 `read_at`。桌面收尾修正后连续两组 3/3（合计 6/6），量化组 8.7/8.9/10.2s，p50 8.9s、粗略 p95 10.2s；Web 3/3 为 4.8/4.8/5.1s，p50 4.8s、粗略 p95 5.1s。E2E 时长含账号/成员准备与 API 读回。
- 首轮桌面三连有 1 次 210s 超时，根因是 E2E finally 等待 Electron `app.exit(0)` IPC，清理挂起；改为仅 taskkill 本测试的进程树并有界等待 `app.close()` 后复验通过。Web 未读角标把铃铛 accessible name 覆盖为数字；补 aria-label 修复并以非空通知 E2E 连跑 3 次。
- 验证：桌面与 Web g8-notifications spec 各 3/3；Web `pnpm typecheck` 与 `pnpm test:unit` 41/41，桌面 renderer `pnpm typecheck` 退出 0；E2E pair guard 117 Web/77 desktop/31 pairs；`git diff --check` 通过。实际 Windows 原生通知权限对话框/通知中心投递、屏幕阅读器全量语义、viewer 通知范围仍未验。仅有本地隔离 E2E API/mock，不触及真实平台/模型。
- 原有未跟踪审计脚本、临时 Playwright config、`desktop/renderer-src/_tmp_*`、renderer scripts 均继续保留；Playwright 产物也不清理。
- 下一批按用户顺序回到 G6 未完成部分：优先 G6-09 mock 反馈至少 20 次量化样本与非空质量看板；不重复 G6-01/02/05/06/08 已通过旅程。G6-03 自动定时同步/真实公众号接口和 G6-04 真实模型质量须明确标环境边界；G6-07 剩余边界以 26 台账为准。之后再接 G7 深测与 G8-08/09 全页移动/读屏检查。
## 20. DEV-QA26 G6-09 复盘反馈 20 次量化续验（2026-11-04）

- 本批提交 `98e2727 DEV-QA26: G6 复盘反馈量化验收`，HEAD 为该提交；未 push、未部署。提交仅含桌面/Web `g6-review-import-quality.spec.ts` 与 docs/08、docs/26；docs/22 无新增条目，产品逻辑未改。
- Windows 真实 Electron 与 Chromium 本地 mock 场景各连续 3/3。每轮生成 20 份报告，每份通过真实 UI 单独点击一次，8 次忽略、12 次采纳；reviews ignored/adopted、采纳后 topics source=review、quality calls 与质量看板都由服务端读回核对（20 calls / 20 feedback / 12 adopted）。桌面首组单击 POST 响应 p50/p95=124/229ms；Web=88/139ms。旅程总时长桌面 45.3/45.9/39.4s，Web 47.6/47.8/43.4s，完整样本边界见 docs/26 与 docs/08。
- 桌面校准的第一次失败是 E2E 漏执行既有 H-04 `finishChecksInElectron`，发布包页依法不显示生成按钮；补齐既有确认步骤后 3/3 通过，无产品缺陷。双端 typecheck、E2E 配对守卫（117 Web/77 桌面/31 对）、`git diff --check` 均通过；本批只改 E2E/文档，未重跑单测。
- G6-09 仍标部分通过：真实模型输出质量未验。当前下一步按用户顺序复核 G6/G7 尚未完成行后继续 G7 桌面可执行项；G6-03 自动定时与真实微信 API、G6-04 真实模型质量仍按环境边界登记，不用 mock 代替。原有未跟踪 QA 脚本、配置、`_tmp_*`、renderer scripts 与历史 Playwright 产物继续保留。

## 21. DEV-QA26 G8-08/09 移动视口与空作品新建入口检查点（2026-11-04）

- 本批已提交 `8f6872e DEV-QA26: 修复空白新建与窄屏按钮语义`；未 push、未部署。真实 UI 复现了 Web 与 Electron 空作品页“空白新建”将标题设为 `[object Object]`，双端以 `onClick={() => create()}` 修复；Web 375px 编辑器三个可见图标按钮补 accessible name，桌面只验实际可见的版本历史按钮。
- Chromium 375×812 真实导航覆盖 28 个页面路由及新建作品后的编辑、检查、发布包 3 个视图；页面 `scrollWidth` 全为 375，未见页面级横向溢出。复盘表格由局部横向滚动容器承接。触控目标已测量但设计没有正式像素门槛，G8-08 仍部分；读屏器/IME 未实测，G8-09 仍部分。
- 双端 E2E 修复前均复现失败；复验 Web 2/2、Electron 2/2。双端 typecheck 通过；pair guard 118 Web / 78 桌面 / 32 对通过；`git diff --check` 通过。详情见 docs/22、docs/26、docs/08。
- 本批代码与 E2E 共 8 个文件，文档更新 docs/08、docs/22、docs/26。既有 untracked `web/audit-*.mjs`、`web/shot-models.mjs`、desktop `qa26-*` 配置/采样脚本、`_tmp_*` 与 renderer scripts 原样保留。下一步按 DEV-QA26 顺序继续桌面 G6/G7 未验旅程及 G8 设置剩余缺口；真实模型、平台发布、生产数据、签名安装升级仍受授权边界限制。

## 22. DEV-QA26 G4-01 作品库旧文与已发布标签（2026-11-04）

- 真实 Electron/Web 作品库完成旧文导入的空值校验、预览、取消、确认，published/locked 状态和正文由 GET 读回；发现标签 PATCH 返回 409，根因是后端 `updateWork` 在解析请求前无条件检查 `m.editable()`。按 FR-M4-09/11、05 §6、06、D-105/OPT-36 最小修复：锁定作品仅可提交纯 tags patch；混合正文/计划字段仍须解锁。Go 回归验证 tags 写入不改 revision/status/locked，混合 tags+title 仍拒绝。
- Electron fresh 隔离端口用例 `g4-works-list-electron.spec.ts` 连续 3/3，Web `g4-published-work-tags.spec.ts` 连续 3/3；UI 后标签、revision、locked 状态经 API 读回，重载筛选可找到作品。桌面每轮 20 次交替状态筛选，失败 0，p50/p95 三组 61/70ms、61/74ms、75/119ms；完整旅程 4.1/4.5/4.5s（p50 4.5s，粗略 p95 4.5s）。Web 首轮有一次宽泛定位器 strict-mode 失败，缩窄至作品行 testid 后 3/3 通过；桌面复用旧 API 端口曾连到旧二进制，fresh 配置重验后才计通过。
- 验证：`go test ./internal/app -run '^(TestOPT36.*|TestHC.*)$' -count=1` 通过，HC-01～31 均执行；Web/桌面 renderer typecheck 通过；pair guard 119/79/32 对，`git diff --check` 通过。docs/26 G4-01 标为部分检查：状态推进、平台镜像、viewer 权限路径待验。2G-10 已登记 docs/22，docs/08/22/26 已同步。
- 本批已提交 `7696621 DEV-QA26: 修复已发布作品标签更新并验收作品库`，未 push/deploy；提交仅含后端与 Go 回归、双端 E2E、Electron project 登记和 docs/08/22/26。不得暂存本地忽略的本文件。原有未跟踪审计脚本、临时 Playwright 配置、`desktop/renderer-src/_tmp_*`、renderer scripts 保持原样。下一步继续桌面优先的未检查条目并对照 Web；真实模型、平台和生产边界不以 mock 代验。

## 23. DEV-QA26 G4-01 viewer 标签只读续验（2026-11-04）

- owner 创建 viewer 邀请后，viewer 在真实 Electron 窗口与 Web 页面都能读到 published 作品及其标签；两端均隐藏标签编辑按钮。带 CSRF 令牌直调 `PATCH /works/{id}` 返回 403“观察者仅可浏览，不能修改内容”，owner 再 GET 读回标签和 revision 未变。双端角色路径连续 3/3，未改产品代码。
- 桌面 E2E `g4-works-list-electron.spec.ts --repeat-each=3` 3 passed（54.2s 整组）；每轮含 20 次状态筛选交互，新增组 p50/p95=61/84ms、62/85ms、70/111ms。owner 导入/读回旅程 4.0/3.8/5.0s（p50=4.0s，粗略 p95=max=5.0s，不含 viewer 窗口启动）。Web `g4-published-work-tags.spec.ts --repeat-each=3` 3 passed（34.3s 整组）。双端 typecheck、pair guard（119/79/32 对）、`git diff --check` 通过。
- docs/26 与 docs/08、docs/22 已更新；G4-01 仍部分检查，剩余作品状态推进与平台镜像。本批已提交 `92cd455 DEV-QA26: 验收作品标签的 viewer 只读边界`，未 push/deploy。接着从真实 Electron 入口验状态推进，遵循 H-01–H-09；不以直接 API 绕过闸门代替 UI 验收。既有 untracked 审计脚本、临时 config、`_tmp_*` 与 renderer scripts 不清理、不暂存。

## 24. DEV-QA26 G2-09 图片库跨作品复用续验（2026-11-04）

- 修前真实 Electron 复现：从空目标作品编辑器打开图片库只能看目标作品图片，无法浏览其他作品；按 docs/22 MT-03 已批准目标，双端分离 `work` 筛选与 `target_work` 复用目标，并在编辑器图片库弹窗增加“打开完整图片库”。
- Electron/Web 真实 UI 路径分别连续 3/3；每轮 20 次筛选且 0 失败。Electron p50/p95 三轮为 16.82/30.73ms、16.91/24.75ms、17.37/26.45ms；Web 为 48.37/61.58ms、49.42/82.05ms、34.68/50.79ms。双端 API 读回保存后的替代文字和复用 asset；owner/viewer 页面控件与写权限通过，viewer PATCH 403。上传非法类型、多图和删除确认复用既有双端 E2E 证据。
- 双端 typecheck、unit（Web 41/41、desktop renderer 37/37）、pair guard（119/80/32 对）及 `git diff --check` 通过。docs/26 标部分检查，AI 建议和复制链接等图库动作仍未逐项验。提交 `8a66c5e7 DEV-QA26: 修复并验收图片库跨作品复用`；未 push/deploy。
- 只暂存并提交本批 10 个代码/E2E/文档文件；此前已有未跟踪 QA 脚本、`_tmp_*`、临时 Playwright 配置与 renderer scripts 均原样保留。继续检查 G8 设置中确有未验的项并对照 Web；不重复既有 models/members/usage/words/trash/export 证据，除非发现缺口。之后继续 G6/G7 和其他可执行部分。真实模型、平台发布、生产库迁移、签名安装升级仍不在本机 mock 授权内。

## 2026-11-04 DEV-QA26 checkpoint 第十四轮（G2-05 工作区切换与 recent 隔离）

**本批内容**：修复双端 recent 按用户+工作区隔离，修复顶栏切换成功后 `busy` 未复位；新增桌面真实 Electron G2-05 旅程并扩展 Web GL-04 往返检查。更新 docs/26、docs/08、docs/22（新增/同步 2G-12/13/14）。没有触碰 API、数据库迁移或权限策略。所有此前已有未跟踪审计脚本、配置和临时文件保持原样。

**缺陷证据与结果**：修前真实 Electron 往返切换观察到另一工作区作品标题泄漏，且成功切换一次后另一个工作区按钮仍为 disabled、没有后续 switch POST。修后验证离开保护不发送切换请求、合法修改先 PATCH 再切换，GET `/auth/me`、`/accounts`、`/works/{id}` 证明内容按当前工作区隔离且标题持久化；往返后近期作品恢复。桌面旅程连续 3/3，每轮 20 次顶栏往返切换，最后一轮 20 个切换样本 p50=337.29ms、p95=406.30ms、失败 0。Windows Electron 隔离端口 5387/8387/8397。Web 真实 Chromium A→B→A 1/1，flush 顺序、SPA marker、最近记录恢复、目标账号隔离通过。

**验证**：桌面命令 `cd desktop/renderer-src; pnpm exec playwright test -c qa26-fresh.playwright.config.ts --project=desktop-windows-electron e2e/g2-workspace-switch-electron.spec.ts --repeat-each=3 --reporter=list --output ../../.playwright-results/qa26-g2-workspace-switch-repeat3-20261104`，3 passed。Web `cd web; pnpm e2e -- e2e/nw-r2p1.spec.ts --grep "GL-04 切换工作区先保存当前作品"`，1 passed。Web/desktop renderer typecheck 通过，单测 42/42 与 38/38，pair guard 119 Web/81 桌面/32 对，`git diff --check` 通过。未运行 Go/HC 套件，因为本批只有前端本地状态和 E2E 变更；未改动或跳过 HC-01～31。

**状态与下一步**：G2-05 仍部分检查，editor/viewer 工作区切换权限、命令面板入口和工作区列表错误/空态未验。mock 仅证明界面/API 契约，不证明真实模型、平台或生产库。接着按 DEV-QA26 计划筛选仍可在本地执行的未验项目，继续优先真实 Electron 并检查 Web 对照；单任务提交，不 push/部署。

## 2026-11-05 DEV-QA26 checkpoint 第十五轮（G2-05 editor/viewer 权限边界双端验收）

**本批内容**：补桌面真实 Electron 与 Web Chromium 的 editor/viewer 工作区切换回归用例，不涉及产品代码与权限策略变更。editor 通过邀请注册后，再由成员页加入 viewer 工作区；顶栏与命令面板分别能切换已加入工作区，未加入工作区不显示。

**证据与验证**：双端每次切换后读取 `/auth/me` 的 workspace/role、`/accounts` 和跨工作区 `/works/{id}`，确认数据隔离；直调未加入工作区 switch 返回 404，当前 workspace 不变。Electron 角色旅程 3/3，Web 3/3；双端 typecheck 通过，unit Web 42/42、desktop renderer 38/38，pair guard 119 Web / 81 桌面 / 32 对通过。未运行 Go/HC 套件，因为只新增前端 E2E；没有修改、跳过或放宽 HC-01～31/H-01～09。未 push/deploy。

**状态与下一步**：G2-05 仍部分检查，仅工作区列表错误/空态和取消分支待验；双端角色/顶栏/命令面板权限边界已验。已更新 docs/26、docs/08、docs/22。下一步按用户顺序继续桌面 G8 设置页剩余明确缺口（models、members、usage、words、trash、export），先对照 `docs/26` 避免重复已完成的既有证据，再逐项真实 Electron 点击并核对 Web。既有未跟踪审计脚本、QA 配置、`_tmp_*`、renderer scripts 均未改动或清理。真实模型、平台发布、生产迁移与签名安装升级仍不在本地 mock 范围；不 push。

## 2026-11-05 DEV-QA26 checkpoint 第十六轮（G2-13/G8 回收站 viewer 写权限）

**本批内容**：真实 Electron 复现 viewer 在回收站看见恢复/恢复并查看/彻底删除按钮，点击后服务端 403、测试作品仍留在回收站。根因是 Web 与 desktop renderer `Trash.tsx` 未使用既有 `useCanWrite()`。双端仅隐藏 viewer 的写入口，服务端 `blockViewerWrites` 保持不变。新缺陷登记为 docs/22 2G-15，docs/26 G2-13 保持部分检查。

**证据与量化**：Electron 与 Chromium viewer 回收站旅程各连续 3/3；双端按钮均隐藏，带 CSRF 的恢复 POST/彻底删除 DELETE 均返回 403，owner 再读 `/trash?type=work` 仍有作品。桌面旅程 16.635/15.568/14.922s（p50=15.568s、粗略 p95=16.635s），Web 8.451/6.687/6.544s（p50=6.687s、粗略 p95=8.451s）；每端各 60 次筛选点击，Electron p50/p95=35.24/77.03ms，Web=75.25/130.11ms，失败均为 0。owner 既有永久删除取消/确认旅程双端各 1/1。

**验证与提交**：Web/desktop renderer `pnpm typecheck` 通过，单测 42/42、38/38；pair guard 119 Web / 81 桌面 / 32 对通过，`git diff --cached --check` 通过。桌面/Web viewer 旅程均 `--repeat-each=3` 通过，owner 回收站回归各 1 passed。没有 Go/HC 或 H 门代码变更；HC-01～31、H-01～09 未修改、未跳过、未放宽。文档 docs/26、docs/08、docs/22 已更新，提交 `18fbcde DEV-QA26: 隐藏 viewer 回收站写操作`；未 push/deploy。

**限制与下一步**：`PurgeExpiredTrash` 只做了 `now-30d` 静态核查，未验证 30 天后定时清理；选题、素材、样本、角色卡、参考等回收站类型仍未逐项验，G2-13 继续部分状态。接着按 DEV-QA26 顺序筛查 G8 尚可在本地 mock 完成的项目，再进入 G6/G7；先读 docs/26、docs/08，避免重复已完成旅程。真实模型费用、平台发布、生产迁移、签名安装升级不在本地授权内。所有原有未跟踪 audit 脚本、QA 配置、`_tmp_*` 与 renderer scripts 保持原样。

## 2026-11-05 DEV-QA26 checkpoint 第十七轮（G2-13 回收站对象与失败态）

**本批范围**：承接 HEAD `18fbcdef DEV-QA26: 隐藏 viewer 回收站写操作`。真实 Electron/Web owner 对选题、素材、风格样本、角色卡和对标参考逐项软删除、恢复、再次删除、取消永久删除、确认永久删除；每类均核对 `/trash` 服务端读回并在页面重载后复核。新增参考标题缺失回退 URL 的服务端修复；双端回收站冷加载错误与重试修复；固定时钟 Go 边界测试证明恰好 30 天仍在、早 1 秒会被清除。docs/26、docs/08、docs/22 已同步，缺陷新增 2G-16/17。

**证据**：Electron owner 五类型旅程连续 3/3，筛选每轮 20 个、共 60 个样本，三轮 p50/p95 为 37/47ms、39/50ms、42/47ms；Web 3/3，p50/p95 为 71/82ms、82/103ms、82/105ms；失败 0。双端错误注入/重试各 1/1。桌面错误态由 renderer Chromium + Electron UA 验证；真实 Electron 设置窗为独立 WebContents，外层 route 无法拦截，保留为证据边界。Go 目标组含 HC-01～31 通过；双端 typecheck 通过；桌面 unit 38/38、Web unit 42/42；pair guard 119 Web/82 桌面/32 对通过。

**工作树与交付**：本批已于 2026-11-05 单任务提交 `72bb1e2 DEV-QA26: 验收回收站对象与错误边界`；HEAD 已回读，未 push/deploy。预先存在的 audit 脚本、QA Playwright 配置、`_tmp_*` 与 renderer scripts 未清理或覆盖；`docs/AI_HANDOFF.md` 为本地交接记录，不加入提交。

**限制与下一步**：G2-13 仍部分检查，viewer 对全部对象类型的写拒绝矩阵、每日清理调度实际触发及关联图像/磁盘文件清理未验。之后按顺序继续 G8 设置尚未完成的 usage 等项目，再做 G6 复盘桌面旅程，G7 智能体附件/目标/例程/工件/恢复停止与逐卡执行/拒绝；每个已覆盖关键旅程连续 3 次，普通交互和 AI 反馈分别按至少 20 样本记录。真实模型、真实平台、生产迁移、签名安装升级仍在授权边界之外。


## 2026-11-05 DEV-QA26 checkpoint 第十八轮（G6-02 多时点报告旅程三连）

**本批范围**：复核既有 `cx13-review-multitime.spec.ts` 桌面与 Web 旅程并按用户要求重复 3 次，不改产品代码。覆盖多时点窗口/T30 缺失与 unknown 单位、实验放弃释放与人工结案、增强复盘报告编辑和单项建议采纳；报告内容/adopted 索引通过 GET `/accounts/{id}/reviews` 读回，实验列表通过 `/accounts/{id}/experiments` 读回。手动 T+1/3/7 与发布后回填 UI 有已记录证据，本轮未重复。`docs/26`、`docs/08` 已更新。

**量化证据**：Electron 17.0/18.8/18.8s（3/3、失败 0、p50/p95=18.8/18.8s）；Web Chromium 15.9/13.4/14.3s（3/3、失败 0、p50/p95=14.3/15.9s）。计时含夹具准备和服务端读回，不代表单击延迟。环境为 Windows Electron/Web Chromium、本地 E2E API/mock。mock 不证明真实模型质量。

**交付状态**：本批仅更新审计文档，已单任务提交 `7d83d8e DEV-QA26: 复核多时点复盘旅程`；HEAD 已回读，不 push/deploy。当前 HEAD `7d83d8e`；预存 untracked 审计脚本、QA 配置、`_tmp_*` 和 renderer scripts 持续保留。

**下一步**：G8 的 models、members、usage、words、trash、export 已有点击/保存/重载证据；G2-13 本批扩展后仍待 viewer 全对象写拒绝、每日清理调度及关联文件清理。继续核对 G6-03/04/07/09 中本地仍可执行的缺口，再按顺序复核 G7 的运行恢复/停止、附件、目标、例程、工件与逐卡执行拒绝；真实模型、真实公众号/平台数据、生产迁移及签名安装升级继续保持未验状态。

## 2026-11-05 DEV-QA26 checkpoint 第十九轮（G2-04/G8 开发态邮箱邀请双端验收）

**本批范围**：承接 `5c3e67f8 DEV-QA26: 验收到期清理调度入口`，补真实 Electron 与 Web Chromium owner 邮箱邀请路径 E2E，更新 `docs/26` 与 `docs/08`。SMTP host/from 为空；空邮箱由 UI 拒绝，非法邮箱提交返回 422。各端每轮通过 UI 点击发送 20 个 `example.invalid` 地址，服务端响应 `dev_logged` 且提示未真实发信，invite ID 对应 20 条审计日志可读回；重载后邀请持久存在、输入框清空。

**量化与验证**：Electron 三轮 11.7/12.8/12.7s（3/3，p50/p95=12.7/12.8s），Web 7.6/7.4/7.5s（3/3，p50/p95=7.5/7.6s），失败 0。每轮 20 次发送，共 60 样本/端；点击至 200 响应 p50/p95：桌面 104.72/188.30ms、122.42/191.22ms、118.48/147.93ms；Web 71.94/116.51ms、76.83/138.09ms、76.52/97.23ms。双端 typecheck、renderer unit（38/38、42/42）、pair guard（119 Web/82 桌面/32 对）和 `git diff --check` 通过。桌面最初 exact toast 断言未容纳 request ID 后缀；断言改为匹配错误正文后通过，非产品故障。E2E 为 Dev 模式、无 SMTP、仅本地隔离 API，没有外发邮件；配置 SMTP 的真实投递仍未验。

**工作树与交付**：本批已提交 `a8801bc DEV-QA26: 验收开发态邮箱邀请边界`，仅含两端 `e2e/g8-settings-gaps.spec.ts`、`docs/26`、`docs/08`；本地忽略的 handoff 未暂存。已有 untracked `_tmp_*`、QA 配置/采样脚本、renderer scripts、`web/audit-*` 与 `web/shot-models.mjs` 保持原样。未 push/deploy。

**下一步**：按用户顺序继续 G8 尚有本地证据缺口的设置/窄窗口与键盘可达性检查，优先真实 Electron，并核对 Web 对应状态；不重复模型、成员权限、usage、words、trash、export 已通过路径。随后继续尚未完成的 G6/G7 与其他本地可执行项目。真实 SMTP 投递、真实模型质量、真实平台发布、生产迁移与签名安装升级仍在授权边界之外。

## 2026-11-05 DEV-QA26 checkpoint 第二十轮（G6-03 RunJobs 粉丝每日同步调度）

**本批范围**：承接 HEAD `a8801bc0 DEV-QA26: 验收开发态邮箱邀请边界`。新增仅测试代码 `server/internal/app/dr06_wechat_daily_test.go`，由真实 `Server.RunJobs(ctx)` 启动轮触发每日公众号同步；使用隔离 `ops_test`、临时数据目录及微信 mock，不连接真实平台、不改产品逻辑。

**证据与验证**：本地时钟固定于 2026-11-05 11:30，测试账号通过 mock 凭证检测取得 `datacube_state=ok`、每日同步开关启用。RunJobs 启动轮后 GET/数据库读回一条 `metrics_sync_daily` 审计、7 条 `source=wechat_api` 粉丝日数据，账号最近同步时间存在且失败数为 0。`go test ./internal/app -run '^TestRunJobsDispatchesWechatDailySync$' -count=3` 连续 3/3；独立单次 6.216/6.228/6.228s，p50/p95=6.228/6.228s（含测试 DB 初始化与 API/mock 启动）；`go test ./internal/app -run '^(TestRunJobsDispatchesWechatDailySync|TestDR06WechatDailySync|TestHC.*)$' -count=1` 通过，HC-01～31 全部执行。桌面/Web 手动粉丝同步 3/3 证据沿用已有条目，没有重复。

**交付与边界**：本批待提交文件为 `server/internal/app/dr06_wechat_daily_test.go`、`docs/26`、`docs/08`；handoff 不暂存。G6-03 仍部分检查：实际 UI 启用开关并等待 10 分钟周期 tick、真实微信公众号接口与权限/数据准确性未验证。没有 docs/22 新项，不 push/deploy；继续保留所有预存 untracked 文件。

**下一步**：按顺序进入 G7 尚有的原生 Electron 覆盖缺口。G7 动作卡执行/拒绝虽已有 3/3 和服务端写入/零写入证据，但既有用例是 Chromium + Electron UA；下一批尝试补真实 Electron 窗口路径，保持逐卡操作和禁止批量执行入口的既有红线。真实模型质量、真实平台发布、生产迁移与签名安装升级仍不在本机 mock 授权内。

## 2026-11-05 DEV-QA26 checkpoint 第二十一轮（G7-05 原生 Electron 动作卡）

**承接状态**：HEAD `ce59d129 DEV-QA26: 验收RunJobs每日粉丝同步调度`。当前批仅替换桌面动作卡 E2E 并更新 `docs/26`、`docs/08`；不修改产品/API。预存 untracked `_tmp_*`、QA 配置/采样脚本、renderer scripts、`web/audit-*`、`web/shot-models.mjs` 均保留。

**实际点击与持久化证据**：Windows 原生 Electron 普通素材卡逐张执行、H-02 观点门槛卡勾选后执行、单卡拒绝零写入，均连续 3/3。执行读回 action `succeeded` 且素材/观点精确持久化；拒绝 `rejected` 且素材零写入；三条均断言没有“全部执行/全部确认”。E2E 总耗时：普通执行 9.0/8.9/9.6s（p50/p95 9.0/9.6），H-02 9.1/9.1/9.1s（9.1/9.1），拒绝 8.9/8.9/8.9s（8.9/8.9），含启动、登录、mock 与服务端回读，不是点击时延。Web H 门拒绝/超限二次确认沿用此前状态。

**验证与脚本修正**：`pnpm exec playwright test -c qa26-reuse.playwright.config.ts --project=desktop-windows-electron e2e/g7-action-card-desktop.spec.ts --grep "真实 Electron" --repeat-each=3 --workers=1 --reporter=list` 9/9；renderer `pnpm typecheck`、`pnpm test:unit` 38/38、`node scripts/check-e2e-pairs.mjs`（Web119/桌面82/32对）通过。默认 E2E 配置发现 8287 已被本地服务使用后安全拒绝，检查 8287 `/healthz` 与 5287 renderer 为 200 后采用现有 `qa26-reuse`，未接管/关闭服务。首次新原生脚本因即时 `isVisible()` 漏掉异步隐私弹窗，6 个尝试被遮罩拦截；改为显式等待可见、点击并等到隐藏后，定向用例单次及三连通过。该问题是 E2E 时序，无产品缺陷。

**交付与边界**：`docs/26` G7-05 最新状态及 `docs/08` 已更新；无 docs/22 新项。本批已单任务提交 `2c17ef1 DEV-QA26: 验收原生Electron智能体动作卡`；HEAD 已回读，handoff 不暂存。无产品/服务端变更，因此本批不重跑 Go/HC；HC-01～31、H-01～09 未修改、跳过或放宽。真实模型质量/费用、真实平台写入不在 mock 验证内；不 push/deploy。

**下一步**：核对 docs/26、docs/08 中仍部分检查且可本机完成的行，先处理 G8 剩余窄窗口/键盘与 Web 状态对照，再继续 G6/G7 以外的可执行差距。真实外部/生产边界保持未验。

## 2026-11-05 DEV-QA26 checkpoint 第二十二轮（G8-09 Web 模态焦点时序修复）

**承接与范围**：承接 HEAD `2c17ef12 DEV-QA26: 验收原生Electron智能体动作卡`。Web 375×812“更多导航”真实键盘走查发现自定义 modal 未获得焦点管理；接入共享 `useModalKeyboardFocus`。新增 AW05 智能体工件 Drawer 键盘断言后，真实入口复现常驻 Drawer 的焦点 effect 先于 `usePresence` 节点挂载运行；修为 Dialog/Drawer 仅在 `open && present` 时启用焦点管理。另修 OPT67 E2E 触发器名以匹配当前“派生作品”。docs/22 新增 2G-18/19，docs/08、docs/26 已更新。产品/API 仅改 Web，无桌面源码改动。

**证据与验证**：375px Web Chromium 关键旅程 3/3，每轮 22 次导航点击、20 路由视图、溢出 0、失败 0；原有三轮点击 p50/p95 104.80/411.03ms、125.89/402.79ms、146.05/353.06ms，扫描控件 137/203/196，未命名启发式候选 0，小于 24px 原始候选 7/12/11（不等同 WCAG 判定）。AW05 Drawer 与 OPT67 用 `--repeat-each=3` 共 6/6，OPT75 2/2；Drawer 断言覆盖焦点进入、Shift+Tab/Tab 循环、Escape 关闭与触发按钮焦点恢复。Web `pnpm typecheck`、`pnpm test:unit`（42/42）、E2E 配对守卫（Web120/桌面82/32对）、`git diff --check` 通过。修前 AW05 一次失败是本轮真实缺陷复现，修后 3/3。未运行 Go/HC；HC-01～31、H-01～09 未修改/跳过/放宽。真实 Electron 375px 因主窗 minWidth=960 无有效布局证据；屏幕阅读器、IME、实机触控仍未验。

**交付与边界**：单任务提交 `fbf9a5f3 DEV-QA26: 修复Web模态焦点生命周期`，HEAD 已回读，未 push/deploy。已提交 8 个目标文件；之前存在的桌面/Web untracked audit 脚本、QA 配置、renderer scripts、`_tmp_*` 保留，handoff 不暂存。当前主要桌面设置旅程已有：模型 G7-10、成员 G2-04/G8-10、用量 G7-09、敏感词 G7-14、回收站 G2-13、数据导出 G2-14。不开真实模型、邮件、平台或生产服务。

**下一步**：继续核对 G6 可本地完成但仍部分通过的缺口，优先尝试用真实 Electron 点击公众号账号的每日数据同步设置并读回保存状态，再判断能否在隔离 mock 环境等候 10 分钟 RunJobs 周期 tick；同步检查 Web 对应状态，不伪称真实平台验证。保留 G4-17 Markdown 导出及其他台账未检查项，按 docs/26 与 docs/08 去重后继续。

## 2026-11-05 DEV-QA26 checkpoint 第二十三轮（G6-03 设置开关与真实十分钟 tick）

**承接与范围**：承接 HEAD `fbf9a5f3 DEV-QA26: 修复Web模态焦点生命周期`。本批仅改两端 `g6-followers-sync.spec.ts`、`server/internal/app/dr06_wechat_daily_test.go` 和 `docs/26`、`docs/08`；无产品业务代码改动、无 docs/22/90 决策变更。工作树原有 `_tmp_*`、QA 配置/采样脚本、renderer scripts、`web/audit-*` 与 `web/shot-models.mjs` 均保留。`docs/AI_HANDOFF.md` 是本地忽略文件，不暂存。

**点击与持久化证据**：Windows 原生 Electron 和 Web Chromium 各自从真实设置入口交替点击每日同步开关 20 次，逐次等待 PATCH、检查 UI、GET `/accounts/{id}` 读回；每端连续 3 轮、失败 0。每轮完成后重载设置页，UI/API 仍为开启。Electron 三轮点击→PATCH/UI/API p50/p95 为 153.99/202.33ms、151.94/171.65ms、159.38/222.69ms；Web 为 126.31/158.72ms、125.57/156.64ms、152.29/172.63ms。

**调度证据与验证**：新增默认跳过的 opt-in Go 集成 `TestRunJobsDispatchesWechatDailySyncOnTenMinuteTick`，使用隔离 `ops_test` 和本地微信 mock，启动轮先处理控制账号，再创建目标账号；真实 10 分钟 ticker 后目标恰好一条成功审计，GET 与数据库读回 7 条 `source=wechat_api` 粉丝数据。单次 606.062s。双端定向 E2E 各 3/3；frontend typecheck 通过、renderer unit 38/38、Web unit 42/42、pair guard Web120/桌面82/32对通过；Go 定向回归 21.703s、HC-01～31 通过，慢测默认跳过。H-01～09 未修改/跳过/放宽。mock 不验证真实公众号权限或数据准确性。

**交付与下一步**：本批计划提交 `desktop/renderer-src/e2e/g6-followers-sync.spec.ts`、`web/e2e/g6-followers-sync.spec.ts`、`server/internal/app/dr06_wechat_daily_test.go`、`docs/26`、`docs/08`。真实模型、真实公众号/平台发布、生产迁移、签名安装升级均未触及；不 push/deploy。G6-03 仍部分通过。下一步按台账优先复核仍未检查、可在本地完成的项目，先看 G4-17 Markdown 导出，再继续其他 G6/G7 缺口；不重复已完成项。

## 2026-11-05 DEV-QA26 checkpoint 第二十四轮（G4-17 Markdown 导出双端/角色验收）

**承接与范围**：承接 HEAD `24151ec DEV-QA26: 验收G6-03设置与十分钟调度`。本批改动 `desktop/renderer-src/e2e/opt38.spec.ts`、`desktop/renderer-src/playwright.config.ts`、`web/e2e/opt38.spec.ts`、`scripts/check-e2e-pairs.mjs`、`docs/26` 与 `docs/08`；无产品逻辑/API 修改。新增 desktop `opt38.spec.ts` 到真实 Electron project，并把两端同名用例登记到 pair guard。`docs/AI_HANDOFF.md` 是本地忽略文件，不暂存。

**验收证据**：owner 真实 Electron 与 Web Chromium 各连续 3/3，每轮 20 次点击“更多 → 导出 Markdown”，双端各 60 次、失败 0。实际读回每份下载文件，核对作品标题、两段标题/正文顺序、两张图片的绝对资源 URL 和含 `:`、`/` 的文件名净化。Electron 每轮点击至文件落盘/读回 p50/p95：107.77/211.69ms、132.14/161.11ms、103.73/183.59ms；Web：176.54/322.41ms、179.84/230.42ms、166.15/197.42ms。editor 实际下载与 viewer 可读但菜单隐藏，双端均 3/3。下载是客户端文件，无服务端状态写入。

**验证与边界**：桌面 `pnpm exec playwright test -c qa26-fresh.playwright.config.ts --project=desktop-windows-electron e2e/opt38.spec.ts --repeat-each=3 --workers=1 --reporter=list --timeout=45000`（3 passed）；Web `pnpm e2e -- e2e/opt38.spec.ts --project=chromium --repeat-each=3 --workers=1 --reporter=list --timeout=45000`（3 passed）；双端 typecheck、renderer unit 38/38、Web unit 42/42、pair guard Web120/桌面83/33对、`git diff --check` 通过。前几次脚本选择器/config 错误已修正，最终三连无失败；无产品缺陷，无 docs/22/90 变化。跨源 API base 分支仍未单独复验。HC-01～31、H-01～09 均未修改/跳过/放宽。

**交付与下一步**：本批待提交六个目标文件；已有 `_tmp_*`、QA 配置/采样脚本、renderer scripts、`web/audit-*`、`web/shot-models.mjs` 及 `.playwright-results` 原有内容均保留，不 push/deploy。提交后继续核对 docs/26 仍未检查且可本地完成的高价值项，优先 G4-06 富文本编辑器与 G4-16 作品标签入口，再沿台账继续，不重复已完成 G6/G7/G8 项。

## 2026-11-05 DEV-QA26 checkpoint 第二十五轮（G4-06 编辑器保存、角色与版本）

**承接与范围**：承接 HEAD `dacdeee3 DEV-QA26: 验收G4-17 Markdown导出`。仅改双端 `cx11-paste-image` E2E、`docs/26`、`docs/08`；handoff 为本地忽略文件，不暂存。未改产品/API；未改 docs/22/90。工作树原有 `_tmp_*`、QA 配置和采样脚本、renderer scripts、`web/audit-*`、`web/shot-models.mjs` 均保留。

**点击、角色与持久化证据**：Windows 原生 Electron 与 Web Chromium 各连续 3/3；每轮 owner 用正文编辑器做 20 次自动保存并在每次 PATCH 后以作品 GET 读回，合计 60 样本/端、失败 0。计时包含 1.2 秒防抖、PATCH 与 GET：Electron p50/p95=1289.05/1330.49ms、1285.03/1317.52ms、1281.85/1327.35ms；Web=1307.45/1413.52ms、1301.90/1319.36ms、1310.48/1455.51ms。单图粘贴成功后正文保存 asset path；UI 手动保存版本后，GET 列表/快照可读回最新正文与图片；页面 reload 后正文/图片/版本仍一致。owner/editor/viewer 均由邀请建立，两端 3/3；editor 正文可写且 GET 确认，viewer 正文只读，受控 ClipboardEvent 不发上传请求，直接 POST `/works/{id}/assets?dedupe=sha256` 返回 403。

**验证与边界**：桌面 G4-06 原生 Electron E2E 3/3，原 CX11 边界用例 2/2；Web G4-06 E2E 3/3、粘贴 spec 全文件 3/3；锁定作品上传接口 `go test ./internal/app -run '^TestCX11PasteAssetRejectsLockedWork$' -count=1` 通过。双端 typecheck、renderer unit 38/38、Web unit 42/42、pair guard Web120/桌面83/33对、`git diff --check` 均通过。未测锁定作品 UI 行为与 OS 原生剪贴板；当前图片粘贴由 renderer 处理受控 `ClipboardEvent`，不外推到物理剪贴板。首次使用 Web 顶栏 class 查桌面版本按钮失败后，失败快照确认桌面 class 为 `.desktop-work-history`；修正脚本后最终三连通过。HC-01～31、H-01～09 未修改、跳过或放宽。

**交付与下一步**：本地提交仅包含两端 CX11 E2E、`docs/26`、`docs/08`，带 `DEV-QA26`；不 push/deploy。G4-06 标为部分检查并注明原生系统剪贴板与锁定作品 UI 未验。下一批继续 G4-16 作品标签入口，再按 docs/26 与 docs/08 处理其他未验项目。

## 2026-11-05 DEV-QA26 checkpoint 第二十六轮（G4-16 作品标签双端验收）

**承接与提交**：承接 HEAD `912e13ea DEV-QA26: 验收G4-06编辑器保存`；已提交 `30acb236 DEV-QA26: 验收G4-16作品标签`，未 push。只提交两端 `opt36-work-tags.spec.ts`、desktop Electron project 登记、E2E pair guard 与 docs/26、docs/08；无产品/API代码变化。`docs/AI_HANDOFF.md` 为本地忽略文件，不暂存。所有既有 `_tmp_*`、QA 配置/采样脚本、renderer scripts、`web/audit-*`、`web/shot-models.mjs` 均保留；本批报告写入新的 `.playwright-results/qa26-opt36-*` 子目录。

**点击、权限与持久化证据**：Windows 原生 Electron 与 Web Chromium 由 owner 从作品列表标签弹窗验证取消（无 PATCH）、模拟 503（弹窗保留、GET tags/revision 不变）、正常提交（只 patch tags，GET 确认 tags 变化且 revision/status/sections 不变）、刷新恢复、tag URL 和保存视图。真实命令面板搜索通过 `/search` 回读目标 work ID/title 和完整标签 snippet；editor 邀请后双端实际保存，owner GET 读回。Viewer 只读与直调拒绝沿用 G4-01 已有证据。双端连续 3/3；每轮 20 次标签筛选，60 样本/端、失败 0。Electron 每轮筛选 p50/p95=30/39ms、34/41ms、28/36ms；Web=46/56ms、39/51ms、40/59ms。owner/editor 操作段分别 8.248/8.916/8.664s 与 7.008/6.591/6.636s。搜索 `matched` 是词元命中，本轮不声称整标签精确匹配。

**验证与下一步**：桌面及 Web 定向 E2E 各 3 passed；双端 `pnpm typecheck`、桌面 renderer unit 38/38、Web unit 42/42、pair guard Web121/桌面84/34对、`git diff --check` 均通过。首轮测试的桌面搜索入口、搜索分词和 editor 注册就绪等待假设已按真实页面/接口修正，最终无产品缺陷。HC-01～31、H-01～09 未修改、跳过或放宽；无 docs/22 新动线项、无 docs/90 需求/架构变更。下一步优先从台账未检查项选择可本地完成的 G4 编辑器功能，先核验 G4-08 摘要生成的需求与实际 AI 任务契约；本地 mock 只可用于流程，不代表真实模型质量。

## 2026-11-05 DEV-QA26 checkpoint 第二十七轮（G4-08 公众号摘要双端验收）

**承接与提交**：承接 `30acb236 DEV-QA26: 验收G4-16作品标签`；已提交 `c0c41cf DEV-QA26: 验收G4-08摘要生成`，未 push。提交只含双端 `g4-08-summary.spec.ts`、desktop Electron project 登记、pair guard 和 docs/26、docs/08；无产品/API 代码变更。handoff 为忽略文件，不暂存。所有预存 `_tmp_*`、QA 配置/脚本、`web/audit-*`、`web/shot-models.mjs` 保留，E2E 报告写到新增 `.playwright-results/qa26-g408-*`。

**点击与持久化证据**：Windows 原生 Electron 和 Web Chromium 按真实“标题与摘要”步骤进入；Electron 再点击侧栏“标题、摘要与配图”展开字段。owner 两端最终定量各连续 3/3，每轮 20 次生成，逐次校验 POST、PATCH 与作品 GET，60 样本/端、失败 0。点击到 GET 读回 p50/p95：Electron 145.77/199.12ms、183.28/361.43ms、246.57/342.62ms；Web 258.12/534.62ms、330.42/618.78ms、337.06/467.65ms。editor 两端从 UI 生成后 PATCH 200，owner GET 读回。空值 0/120、130 字上游摘要截为 120 个 Unicode 码点且 `truncated=true`、121 字手输不保存、120 字保存、上游 503 无写入、保存 PATCH 503 后 GET 保持旧值、重载恢复旧值均通过。保存失败时生成值仍在当前页面内存中且错误 toast 可见，服务端仍为旧值。

**验证与边界**：桌面和 Web `g4-08-summary.spec.ts --repeat-each=3 --workers=1` 各 3/3；双端 typecheck 通过，renderer unit 38/38、Web unit 42/42、pair guard Web122/桌面85/35对及 `git diff --check` 通过。最终定量轮两端同时运行、每端单 worker；本地 API 与 OpenAI 兼容测试桩可验证接口/长度/保存契约，不代表真实模型摘要质量，也未调用真实模型。首次失败由测试按锚点直访导致步骤隐藏、Web counter 实为“0 / 120”、桌面属性折叠入口漏点造成；按页面实际入口修正后最终轮通过，无产品缺陷。无 Go/HC 回归需要，HC-01～31、H-01～09 未修改、跳过或放宽；无 docs/22、90 变更。

**下一步**：按 DEV-QA26 优先桌面继续 G4-10 配图建议与 AI 出图，先核对 04/05/06 契约与既有证据，随后同步确认 Web 对应状态；不重做 G4-08 和已完成 G4-16/17。真实模型费用和真实平台仍不在本地 mock 授权内；不 push/deploy。

## 2026-11-05 DEV-QA26 checkpoint 第二十八轮（G2-13 原生 Electron 回收站错误态）

**承接与提交**：承接 `c0c41cf DEV-QA26: 验收G4-08摘要生成`；已提交 `6b2ec29 DEV-QA26: 验收回收站原生Electron错误态`，未 push。仅改桌面 QA E2E、Playwright project 登记、`docs/26` 与 `docs/08`；无产品/API 代码改动。handoff 是本地忽略文件，不暂存。所有既有 `_tmp_*`、QA 配置和采样脚本、renderer scripts、`web/audit-*`、`web/shot-models.mjs` 及旧 `.playwright-results` 均保留。

**真实窗口证据**：原错误态用例实际跑在 renderer Chromium 并伪装 Electron UA，本轮迁到 Windows `desktop-windows-electron`。用户菜单→设置→回收站实际点击；CDP `Fetch` 在真实 Electron renderer 网络层对 `GET /api/v1/trash` 注入 500。待自动重试状态收敛后，页面显示加载错误，用户点击重试后出现空态；隔离账号 GET `/trash` 确认 `[]`。最终关键旅程连续 3/3、失败 0，耗时 10.3/9.7/10.4 秒，p50=10.3 秒、p95 取三样本最大值 10.4 秒。

**验证与边界**：桌面命令 `pnpm exec playwright test -c qa26-reuse.playwright.config.ts --project=desktop-windows-electron e2e/qa26-trash-error-desktop.spec.ts --repeat-each=3 --workers=1 --reporter=list --output ../../.playwright-results/qa26-trash-error-electron-20261105-06` 3 passed；`pnpm typecheck` 通过，`pnpm test:unit` 38/38，pair guard Web122/桌面85/35对通过，`git diff --check` 通过。首次检查错误发生在 React Query 自动重试中，定位 `isFetching` 后改为等“正在重试…”消失再点，不是产品缺陷。普通 Playwright 配置发现 8287/5287 由仓库 `ops-e2e`/Vite 在监听，确认后切到 reuse config，未杀进程。HC-01～31、H-01～09 未修改/跳过/放宽。G2-13 仍部分检查，10 分钟回收清理 ticker 尚未单独等待周期触发，已有 RunJobs 启动轮不替代该证据。

**下一步**：继续 G8 设置页剩余本地项，优先在隔离测试库中单独等待并验证回收站 10 分钟清理 ticker；完成后继续 G6 桌面复盘和 G7 桌面智能体剩余缺口。保持逐张写入闸门，不 push/deploy。

## 2026-11-05 DEV-QA26 checkpoint 第二十九轮（G2-13 回收站周期清理）

**承接与提交**：承接 `6b2ec29 DEV-QA26: 验收回收站原生Electron错误态`；已提交 `9df5869 DEV-QA26: 验收回收站十分钟清理周期`，未 push。提交包含隔离 opt-in Go 慢测、docs/26、docs/08、docs/90；无产品运行时代码改动。handoff 为本地忽略文件，不暂存。既有 `_tmp_*`、QA 配置/采样脚本、renderer scripts、Web audit 脚本及旧 `.playwright-results` 均保留。

**周期轮证据**：慢测明确先让启动轮清除一组过期 work/topic 和真实上传图片，然后在启动轮结束后创建第二组目标，等待 `RunJobs` 真实 10 分钟 ticker 清除数据行和 assets 目录；每轮还检查周期清理不早于启动后 9 分 45 秒，并验证取消上下文后任务退出。三轮通过，完整 `go test -count=3` 耗时 1805.416 秒、失败 0。隔离 `ops_test` 中清理审计时间差为 599.009/598.975/599.986 秒，p50 599.009 秒，三样本 max 估算 p95 599.986 秒。

**验证、安全与边界**：`OPS_TEST_TRASH_REAL_TICK=1 go test ./internal/app -run '^TestRunJobsPurgesExpiredTrashOnTenMinuteTick$' -count=3 -timeout=39m` 3 passed；`go test ./internal/app -run '^(TestHC.*|TestPurgeExpiredTrashHonorsThirtyDayBoundary|TestRunJobsPurgesExpiredWorkAndAssetDirectory)$' -count=1 -timeout=5m` 通过 20.069 秒，含 HC-01～31；`git diff --check` 通过。`OPS_TEST_ADMIN_URL` 未设置，TestMain 只重建本机 localhost:5440 的 `ops_test`，文件在临时 DataDir；审计时间为本地数据库只读查询。H-01～09、HC-01～31 均未修改、跳过或放宽。

**待决差异与下一步**：功能行为通过，但 `docs/06` 规定“每天”，实现每 10 分钟运行。D-033 只批准进程内 ticker 技术选型、未定具体周期；新增 docs/90 D-168 记录选项 A（保留 10 分钟并同步设计文档）/B（按每日设计调整 scheduler），等待用户决定；未改调度或 docs/06，故 G2-13 仍为部分检查。按原优先顺序继续找 G6 桌面复盘可本地完成的缺口，再做 G7 桌面智能体；不触真实模型、平台写入、生产库、push/deploy。

## 2026-11-05 DEV-QA26 checkpoint 第三十轮（G8-02 Electron 通知权限）

**承接与提交**：承接 `9df58696 DEV-QA26: 验收回收站十分钟清理周期`；已提交 `d9acc96 DEV-QA26: 修复Electron桌面通知权限`，未 push。提交仅含 `desktop/src/main.ts`、`desktop/renderer-src/e2e/g8-notifications-electron.spec.ts`、docs/08、docs/22、docs/26。既有 `_tmp_*`、QA 配置/采样脚本、renderer scripts、`web/audit-*`、`web/shot-models.mjs` 均保留；handoff 为本地忽略文件，不暂存。

**真实窗口复现与根因**：干净 Windows Electron profile、不注入 Notification stub 时，通知面板读取到 `Notification.permission=denied`，用户无法开启“桌面提示”。主进程权限处理器此前只允许剪贴板权限；通知许可加入 allowlist 后需注意 Electron `requestingOrigin` 带尾斜杠。修复对通知来源使用 `isBusinessOriginUrl` 精确验证，并继续限制 `details.isMainFrame`；renderer 的显式用户 opt-in 未变。

**复验和量化**：真实 Electron 由 UI 开启桌面提示，按钮状态改变、本地用户偏好读回 `1`，重载后仍为开启；同一关键旅程连续 3/3，耗时 6.8/7.3/8.0 秒，p50=7.3 秒、三样本最大值估算 p95=8.0 秒，失败 0。耗时包括 Electron 启动、登录、重载，不是点击响应时延。原拒绝态隔离 stub 回归仍通过；此证据不验证 Windows Notification Center 投递。

**验证与边界**：`cd desktop; pnpm build` 通过；`cd desktop/renderer-src; pnpm typecheck`、`pnpm test:unit` 38/38 通过；`cd desktop; pnpm test` 239/239 通过；通知 Electron spec 完整 2/2，opt-in 场景三连 3/3；根目录 `node scripts/check-e2e-pairs.mjs`（Web122/桌面85/35对）与 `git diff --check` 通过。G8-02 保持部分检查：Windows 系统拒绝/撤回和实际原生 toast、全局读屏语义仍未验。G8 models/members/usage/words/trash/export 的设置页点击证据沿用既有记录，没有重复；G6 桌面复盘和 G7 桌面智能体现有 mock/服务端读回旅程及 20 次反馈量化见 docs/26 与 docs/08，只有真实模型、公众号外部链路仍超出本地边界。按任务顺序下一步从尚未检查且本地可执行的全局条目继续，不重做已通过的 G6/G7 样本；不 push/deploy。

## 2026-11-05 DEV-QA26 checkpoint 第三十一轮（G2-05 空/错误态与取消）

**承接与提交**：承接 `d9acc960 DEV-QA26: 修复Electron桌面通知权限`；已提交 `57b3780 DEV-QA26: 验收工作区切换错误空态与取消`，未 push。仅改桌面 `g2-workspace-switch-electron.spec.ts`、Web `workspace-account-menu.spec.ts`、docs/08、docs/26；无产品代码改动、无新缺陷，所以没有新增 docs/22 条目。此前所有 untracked `_tmp_*`、QA 配置/采样脚本、renderer scripts、`web/audit-*` 与 `web/shot-models.mjs` 均保留。

**双端真实界面证据**：单工作区 owner 从真实顶部入口打开切换器，确认没有“其他工作区”分组/切换项且创建入口可用。分别在 Electron 和 Chromium 连续 3 轮，每轮点击 20 次“创建工作区”确认框的“取消”，每端 60 样本；没有任何创建或切换 POST，`GET /auth/me` 确认当前工作区未变化。计时从取消点击到对话框隐藏；每轮 p50/p95 最近秩：Electron 445.48/471.44ms、440.86/456.61ms、450.88/462.72ms；Web 483.36/522.77ms、471.42/577.24ms、483.50/648.34ms；失败均 0。

**读取错误与验证**：对作为工作区列表来源的 `GET /auth/me` 注入本地 503，双端界面展示“无法确认登录状态”和错误内容；移除注入并由用户点“重试”后恢复工作台，GET 读回原工作区。不存在独立 `/workspaces` 列表 GET。桌面专项三连 3/3、同 spec 全量 3/3；Web 专项三连 3/3、同 spec 全量 2/2。双端 `pnpm typecheck`、E2E 配对守卫（Web122/桌面85/35对）、`git diff --check` 通过。`docs/26` G2-05 更新为本地 UI/权限契约已验通过。

**下一步**：G8 设置页指定类别、G6 桌面复盘旅程及 G7 桌面智能体的本地流程已有证据，不重复；仅保留真实 OS 通知、真实模型/公众号等边界。继续从全局台账下一项未检查且本地可验收的 G1-03 首次初始化 `/setup` 开始，对照 04/05/06 后走真实 Electron，并同步核对 Web；不要改正式库或生产初始化状态，不 push/deploy。

## 2026-11-05 DEV-QA26 checkpoint 第三十二轮（G1-03 首次部署初始化）

**承接与提交**：承接 HEAD `57b37803 DEV-QA26: 验收工作区切换错误空态与取消`；已提交 `eee9966 DEV-QA26: 验收首次部署初始化`，未 push。提交包括 Web/桌面 setup 提示最小修复、双端 `g1-setup.spec.ts`、桌面 Electron project 登记、pair guard 登记、两份专用 QA Playwright config 及 docs/08、22、26。无 API/DB schema 改动。

**结果**：真实 Electron 在空数据库复现过时文案；两端均改为提示联系部署管理员在服务器重置密码。Web 与桌面各使用 3 个新建本地空库，完整初始化旅程均 3/3 通过；验证空用户名、短密码、错配校验、503 错误与重试、setup 成功、会话 reload、owner 成员关系、非超管 admin 403、重复 setup 409。每端每轮 20 次错配校验，共 60 样本/端，失败 0。Electron p50/p95 每轮 14.00/30.40、16.86/24.26、20.71/29.73ms；Web 39.67/70.49、34.21/39.63、56.66/95.26ms。实际数据库创建在 `ops_qa26_g103_{desktop_01..03,web_01..03}`，保留不删。

**验证**：双端各 3 次专用空库 Playwright 运行全部通过；双端 `pnpm typecheck`、`pnpm build`、renderer/Web 单测 38/38 与 42/42、pair guard Web123/桌面86/36 对、定向 Playwright `--list`、`git diff --check` 均通过。桌面构建有既有 CSS `::highlight` 和 dialog 动静态导入提示，构建通过。无 Go/HC 变更需求，HC-01～31、H-01～09 未修改或放宽。现有 `_tmp_*`、QA agent 脚本/配置、renderer scripts、`web/audit-*`、`web/shot-models.mjs` 等预存未跟踪文件保留；专用 QA 数据库保留，仅移除本轮 Playwright 自动生成且初始不存在的 `test-results/.last-run.json` 标记文件。

**下一步**：按 docs/26 继续 G1-04 公共分享预览 token 的匿名访问与隔离边界，优先真实 Electron 并同步核对 Web；不重复 G1-03，不 push/deploy。

## 2026-11-05 DEV-QA26 checkpoint 第三十三轮（G1-04 公开分享预览）

**承接与提交**：承接 HEAD `eee99662 DEV-QA26: 验收首次部署初始化`；已提交 `fdcfd97 DEV-QA26: 验收公开分享预览`，未 push。提交仅含 G1-04 两端 E2E、Electron project、docs/08 与 docs/26；不含桌面 `tests/recent-owner.test.mjs` 现有修改或此前未跟踪 QA/audit 文件。handoff 为本地忽略文件，不暂存。

**结果与证据**：Windows 原生 Electron 和 Web Chromium 各连续 3/3。登录 owner 在真实预览页面点击创建；本地 503 注入显示错误且无二维码，重试后创建成功。匿名 `/auth/me` 和创建链接均 401；有效 token 可读排版但没有写入控件；同工作区其他作品资产、跨工作区资产及篡改签名均 404。响应 no-store/no-referrer 且不含状态或 `wechat_fields`。TTL/签名过期由既有 Go `TestOPT37PreviewLinkIsReadOnlyAndExpires` 覆盖、资源范围由 `TestOPT37PreviewAssetIsScopedToLinkedWork` 覆盖；本轮没有重新运行 Go，也没有等待 24 小时。

**量化与验证**：每轮 20 个 UI 点击、每端 60 样本、失败 0。Electron 每轮 p50/p95 为 62.28/97.06、59.74/127.18、66.45/108.82ms；Web 为 101.86/130.58、103.70/181.65、114.66/144.25ms。关键旅程 3/3；Electron 总耗时 10.60/9.64/8.01s，Web 7.21/5.78/7.08s，含夹具准备（Electron 还含启动），不直接比较。专项 Playwright 命令及结果见 docs/08 第三十三轮；双端 typecheck、pair guard Web123/桌面87/36 对、`git diff --check` 通过。早期失败是 E2E 夹具假设，修正后最终三连通过，无产品缺陷。未动 HC/H 门或新增 docs/22/90 事项；本地测试记录保留未清理。未 push/deploy。

**下一步**：按用户优先级继续真实 Electron G8 设置页未完成入口并核对 Web 对应状态；之后续查 G6/G7 未完路径。保留所有当前 untracked 文件，不推送或部署。

## 2026-11-05 监控 checkpoint 第二十七轮（协作监控智能体 · 批次 fdcfd979 G1-04 复核）

**基线与新批次**：上轮基线 HEAD `eee99662`；本轮确认新提交 `fdcfd979 DEV-QA26: 验收公开分享预览`（未 push，main 领先 origin/main 52）。提交内容与第三十三轮 checkpoint 声明一致：仅含桌面 `g1-public-preview-electron.spec.ts`、Electron project 登记、`qa26-g104` 专用 QA config、Web `opt37.spec.ts` 扩展及 docs/08、docs/26（G1-04 升 v1.9），无产品/API 代码改动；`git show --check` 无空白问题。docs/26 G1-04 登记的证据（双端各 3/3、60 样本/端、p50/p95、401/404 隔离、no-store/no-referrer）与交接声明自洽；24h TTL 与资产范围由既有 Go 测试覆盖、本轮未等待真实过期的边界已如实登记。

**独立检查**：`node scripts/check-e2e-pairs.mjs` 通过（Web 123 / 桌面 87 / 36 对，与交接数字一致）。未重跑主执行智能体已完整验证的重型 E2E。

**F-02 跟踪**：`desktop/renderer-src/tests/recent-owner.test.mjs` 修复（+18 行）仍完整留在工作树未提交（`git log` 该路径自 `718a2378` 后无新提交），未丢失；第三十三轮 checkpoint 已明确该批不含此文件。遗留条件继续开放，建议纳入下一个桌面相关批次。

**台账变更**：`docs/AI_MONITOR_FINDINGS.md` 追加 F-02 第二十七轮跟踪记录、F-05 计数更新（51→52）、第二十七轮跟踪小结；无新缺陷条目。复核结论：G1-04 通过。未验证项：真实手机扫码/微信客户端渲染、真实 24h 过期等待（主执行智能体已登记为边界）；D-168 仍待用户裁决。

## 2026-11-05 DEV-QA26 checkpoint 第三十四轮（G2-04/G1-06 本机 SMTP 邀请）

**承接与提交**：承接 `fdcfd979 DEV-QA26: 验收公开分享预览`；已提交 `e77f652 DEV-QA26: 验收本机 SMTP 邀请链`，未 push。提交只含 Web/桌面 `g8-settings-gaps.spec.ts`、docs/08 与 docs/26。桌面 `tests/recent-owner.test.mjs` 既有修改和之前所有未跟踪 QA/audit 文件均仍保留，未暂存。handoff 及本检查点留在本地忽略文件。

**真实入口与本地邮件传输证据**：owner 使用 Windows 原生 Electron 和 Web Chromium；从 UI 创建 editor 邀请、进入 SMTP 设置、保存本机 127.0.0.1 临时端口，并由实际 Go `net/smtp` 客户端连接同进程收件器。拒收器使发送 UI 显示错误/API 502、邮箱内容保留，审计读回 `failed`。修复本机端口后 reload，SMTP 配置由 UI 和 `/settings` 读回；正常发信逐封捕获报文，核对 `.invalid` 收件地址、editor 身份与邀请码；API 和审计为 `sent/ok`，reload 后邀请码仍在且输入已清空。桌面未保存离开对话框点击取消保持原输入和配置，再确认放弃才进入另一设置页。无 SMTP 空态、无效邮箱、dev_logged 路径和 owner/editor 权限沿用既有证据。

**三连量化与限制**：桌面/Web 各连续 3/3，正常每端 60/60 次投递全收到本机 sink，失败 0；每轮另有 1 个预期拒收。点击至 HTTP 200 的最近秩 p50/p95：Electron 101.44/178.35、100.39/185.99、104.56/142.44ms；Web 67.28/86.52、89.39/141.82、85.78/261.44ms。邮件地址均使用 `.invalid`，服务仅绑定 loopback，没有外发邮件。typecheck 双端通过；E2E pair guard Web123/桌面87/36 对通过；`git diff --check` 通过。早期失败均为测试入口/dirty 导航/reload 时序假设，修正后最终三连通过，无产品缺陷。SMTP 外部 provider、认证/TLS/465、真实收件箱到达、editor 入组流程、密码修改/会话撤销未验证；G2-04 与 G1-06 仍部分检查。未改 docs/22/90、Go/H-01～H-09/HC-01～31。测试账号/邀请/审计在本地 E2E DB 保留；无 Go/HC 运行。无 push/deploy。

**下一步**：G8 本地设置可执行入口已核到 SMTP 投递；按用户顺序检查 docs/26 的 G6 桌面复盘残余旅程，再做 G7 未完成项。继续优先真实 Electron、复核 Web 对照；不重做已有通过路径，保持逐卡写入确认闸门。

## 2026-11-05 DEV-QA26 checkpoint 第三十五轮（G1-05 密码与会话）

**承接与提交**：承接 `e77f652 DEV-QA26: 验收本机 SMTP 邀请链`；本批提交 `6b5212b DEV-QA26: 验收登录密码与会话续期`，未 push。提交仅含双端 `g8-settings-gaps.spec.ts` 与 docs/08、docs/26。桌面 `tests/recent-owner.test.mjs` 原有修改、所有未跟踪 QA/audit 文件和本地 handoff 均未暂存，均保留。

**结果与边界**：真实 Electron/Web 登录安全设置各 3/3；每轮 20 次旧密码错误提交均按预期返回 422，60 次/端无测试失败。改密后当前会话仍有效、第二会话 401，旧密码登录 401、新密码登录 200；Electron reload 会话继续有效，点击“立即续期”后 `/auth/renew` 200 且到期剩余超过 6 天。服务端重置/续期与 HC-01～31 回归通过。`G1-05` 保持部分检查，因为本批未实际启动 `ops reset-password` CLI；`G1-06` 仍因外部 SMTP provider、认证/TLS 和真实收件箱未验而部分检查。E2E 原始失败来自测试断言对 request ID 和 Electron 设置窗状态的错误假设，纠正后最终三连通过，无产品缺陷。账户数据保留在本地 E2E 数据库。

**量化与验证**：点击旧密码提交至 422 响应 p50/p95 每轮：Electron 104.21/180.82ms、111.82/180.06ms、173.54/227.28ms；Web 106.00/158.16ms、145.51/504.99ms、132.82/398.74ms。旅程耗时 Electron 15.9/16.0/25.1s，Web 13.2/14.8/15.6s。双端 typecheck、E2E pair guard（Web123/桌面87/36 对）、`git diff --check` 通过；`go test ./internal/app -run '^(TestAuthLockoutAndReset|TestAuthRenewSessionExtendsExpiryAndCookie|TestAuthRenewSessionRejectsWrongPassword|TestHC.*)$' -count=1 -timeout=180s` 通过（23.874s）。无 docs/22 新问题、无 docs/90 决策变更；未修改/跳过/放宽 HC 或 H 测试。

**下一步**：G8 设置页的模型、成员、用量、敏感词、回收站、导出等本地可执行入口已有既有记录；按用户顺序继续 G6 桌面复盘剩余旅程，单独标注 UI 与服务端持久化证据，然后 G7。保留工作树未提交与未跟踪文件，不 push/deploy。

## 2026-11-05 监控 checkpoint 第二十八轮（协作监控智能体 · 批次 e77f6521 + 6b5212b3 复核）

**基线与新批次**：上轮基线 HEAD `fdcfd979`；本轮确认两个新提交（未 push，main 领先 origin/main 54）。① `e77f6521 DEV-QA26: 验收本机 SMTP 邀请链`（G2-04/G1-06）：提交内容与第三十四轮 checkpoint 声明一致，仅含双端 `g8-settings-gaps.spec.ts`（桌面 +197 / Web +159）与 docs/08、docs/26（v1.9→v2.0）；抽查 Web spec 为真实进程内 SMTP sink（`node:net` EHLO/DATA 状态机 + 拒收注入），非空壳；docs/26 G2-04/G1-06 登记（20 次/轮 ×3 轮、60 投递/端、p50/p95、`.invalid` 地址、仅 loopback）与 checkpoint 逐字一致，外部 provider/TLS/真实收件箱未验的边界如实登记，两条目维持部分检查。② `6b5212b3 DEV-QA26: 验收登录密码与会话续期`（G1-05）：提交内容与第三十五轮 checkpoint 一致，仅含双端 `g8-settings-gaps.spec.ts`（桌面 +93 / Web +78）与 docs/08、docs/26（v2.0→v2.1）；G1-05 由未检查升为部分检查，CLI `ops reset-password` 未实际运行的边界如实登记，登记数字与 checkpoint 一致。两批 `git show --check` 均无空白问题。

**独立检查**：`node scripts/check-e2e-pairs.mjs` 通过（Web 123 / 桌面 87 / 36 对，与两批交接数字一致）。未重跑主执行智能体已完整验证的重型 E2E 与 Go 测试。

**F-02 跟踪**：`desktop/renderer-src/tests/recent-owner.test.mjs` 修复（+18 行）仍完整留在工作树未提交（该路径自 `718a2378` 后无新提交），第三十四/三十五轮 checkpoint 均明确不含该文件。遗留条件继续开放，建议纳入下一个桌面相关批次。

**台账变更**：`docs/AI_MONITOR_FINDINGS.md` 追加 F-02 第二十八轮跟踪记录、F-05 计数更新（52→54）、第二十八轮跟踪小结；无新缺陷条目。复核结论：两个新批次均通过。未验证项：外部 SMTP provider、SMTP 认证/TLS/465、真实收件箱到达、editor 入组旅程、CLI reset-password 实际执行、真实平台/模型（主执行智能体均已登记为边界）；D-168 回收站清理频率仍待用户裁决。

## 2026-11-05 DEV-QA26 checkpoint 第三十六轮（G7 文档附件边界）

**承接与提交**：基线 HEAD `6b5212b DEV-QA26: 验收登录密码与会话续期`；本轮已单任务提交 `f3b87e2 DEV-QA26: 验收智能体文档附件边界`，未 push，main 领先 origin/main 55。本轮仅扩展双端 `agent-documents.spec.ts`，并更新 docs/08、docs/26；无产品/API/数据库改动。

**结果**：Windows 原生 Electron 与 Web Chromium 各三连通过。每轮真实输入台文件选择提交 20MiB+1 PDF、101页 PDF、扫描/加密 PDF、DOCX 外链/宏、缺失/不一致页数。超限文件客户端拒绝、没有上传请求；其余七项 API 均返回 422 / `agent_attachment_parse_failed`，界面显示拒绝理由；发送禁用、无消息 POST。完整旅程 Electron 约 1.3/1.1/1.0 分钟，Web 55.8/48.3/49.0 秒。失败不代表产品问题：第一次运行时测试 ZIP 夹具的中心目录数量写死为2，修正后按原路径最终三连通过。

**验证与限制**：桌面 Playwright 最终运行 `qa26-g7-doc-boundary-electron-20261105-03` 3 passed；Web `qa26-g7-doc-boundary-web-20261105-03` 3 passed；双端 typecheck、E2E pair guard（Web123/桌面87/36对）、`git diff --check` 通过。仅直接验证服务端 422 与零消息 POST，未查询附件表行数；T-AW28 仍部分，恶意解析器攻击、其余跨条件边界与受限 Linux 完整攻击矩阵未闭合。无 docs/22/90 变更，未运行 Go/HC，H-01～09 与 HC-01～31 未改动/跳过/放宽。G8 设置页本地项与 G6 主旅程按既有记录不重跑；下一步续验 G7 T-AW25～27 与其它未验本地路径。不 push/deploy。

## 2026-11-05 监控 checkpoint 第二十九轮（协作监控智能体 · 批次 f3b87e22 G7 文档附件边界复核）

**基线与新批次**：上轮基线 HEAD `6b5212b3`；本轮确认新提交 `f3b87e22 DEV-QA26: 验收智能体文档附件边界`（未 push，main 领先 origin/main 55）。提交内容与第三十六轮 checkpoint 声明一致：仅含双端 `agent-documents.spec.ts` 扩展（桌面 92 行 / Web 76 行改动）、docs/08、docs/26，无产品/API/数据库改动；`git show --check` 无空白问题。

**核验证据**：抽查 Web spec 为真实断言：PDF 夹具生成器参数化（页数/无文本层/加密标记）、DOCX 夹具支持 rels 外链与宏 Content_Types 注入；断言逐一核对 `/agent/attachments` 返回 422 + `agent_attachment_parse_failed`，messages POST 计数保持 0，超限文件客户端拒绝且无上传请求。docs/26 G7-03 登记（双端各 3/3、七类拒绝、发送禁用、零消息 POST）与 checkpoint 一致；恶意解析器攻击、DOCX 交叉组合、受限 Linux 攻击矩阵未闭合的边界如实登记，T-AW28 维持部分检查，docs/08 第三十六轮 checkpoint 存在。

**独立检查**：`node scripts/check-e2e-pairs.mjs` 通过（Web 123 / 桌面 87 / 36 对，与交接数字一致）。未重跑主执行智能体已完整验证的重型 E2E 与 Go 测试。

**F-02 跟踪**：`desktop/renderer-src/tests/recent-owner.test.mjs` 修复（+18 行，仅新增无删改）仍完整留在工作树未提交（该路径自 `718a2378` 后无新提交），第三十六轮 checkpoint 明确不含该文件，与实际相符。遗留条件继续开放，建议纳入下一个桌面相关批次。

**台账变更**：`docs/AI_MONITOR_FINDINGS.md` 追加 F-02 第二十九轮跟踪记录、F-05 计数更新（54→55）、第二十九轮跟踪小结；无新缺陷条目。复核结论：G7 文档附件边界批次通过。

**在途改动提示**：工作树出现主执行智能体新一批未提交改动（`server/internal/app/accounts.go`、双端 `RoutinePanel.tsx`、`server/internal/app/agent_routines_test.go`、双端 `agent-routines.spec.ts`，含产品代码），监控方不触碰，待其提交后按流程复核。未验证项：附件表行数核对、恶意解析器攻击矩阵（主执行智能体已登记为边界）；D-168 回收站清理频率仍待用户裁决。

## 2026-11-05 DEV-QA26 checkpoint 第三十七轮（G7 T-AW27 账号停用暂停例行任务）

**承接与提交**：承接 `f3b87e2 DEV-QA26: 验收智能体文档附件边界`；已提交 `f565009 DEV-QA26: 修复账号停用未暂停例行任务`，main 领先 origin/main 56，未 push。提交仅含账号停用事务、例行任务恢复原因 UI、Go 集成断言、双端点击用例及 docs/08/22/26。`desktop/renderer-src/tests/recent-owner.test.mjs` 的既有修改及 `_tmp_*`、QA 配置与脚本、`web/audit-*`、`web/shot-models.mjs` 等未跟踪文件均保留且未暂存。handoff 为本地忽略文件。

**修复证据**：修前从账号设置点击停用并 reload 后，账号为 disabled 而绑定任务仍 enabled；“立即运行一次”才得到 409，且无 occurrence。D-152 / docs/16 §15.8 要求撤权后立即暂停并通知、恢复后由用户启用。修后后端将账号与 enabled routines 更新置于同一事务，暂停任务、清除 next_due_at、递增 revision、存事件原因并通知创建者；双端把 `account_disabled` 显示为恢复提示，账号恢复不自动恢复任务。

**点击与服务端持久化**：Windows 原生 Electron/Web Chromium 各 3/3、失败 0。两端均从智能体创建任务、设置页停用账号、reload，再从 API 读回账号 disabled、任务 paused、原因和通知；页面暂停卡片隐藏运行按钮、occurrence=0。重新启用账号后任务保持 paused，用户逐项启用后 API 为 enabled。旅程 Electron 16.562/13.073/12.396 秒（p50 13.073，p95 16.562）；Web 16.524/13.834/13.605 秒（p50 13.834，p95 16.524）。3 样本 p95 取最大值；总时间含注册、mock provider 与服务端读回，无模型输出质量结论。

**验证**：定向 Go 用例通过 9.358 秒；`go test -p 1 -count=1 ./internal/app` 通过 352.613 秒，含 HC-01～31。第一次完整回归由新增测试停用共享公众号 fixture 导致后续测试失败；修为独立小红书账号并清理后复跑通过。Web/桌面 typecheck 通过，`node scripts/check-e2e-pairs.mjs` 通过（Web123、桌面87、36 对），`git diff --check` 通过。Playwright 曾因文本定位器和旧复用 API 产生失败；用包含式文案定位及 fresh 配置跑当前源码后最终三连通过。

**剩余范围**：T-AW27 仍部分，用户禁用、创建者移除、工作区关闭、其它模型失效与多进程竞态尚未逐项完成；继续按 docs/26/08 未完成本地项审计，不重做已有 G8 设置页与 G6 主旅程。真实模型、平台发布、生产迁移、签名安装升级不在本地 mock 授权内。保持现有未提交/未跟踪文件，不 push/deploy。

## 2026-11-05 DEV-QA26 checkpoint 第三十八轮（G7 T-AW27 创建者降权暂停例行任务）

**承接与提交**：承接 `f565009 DEV-QA26: 修复账号停用未暂停例行任务`；已提交 `327239ea DEV-QA26: 修复成员降权未暂停例行任务`，main 领先 origin/main 57，未 push。提交仅含本批两端 RoutinePanel、双端例行任务 E2E、Go 事务修复与集成测试、docs/08/22/26。原有 `desktop/renderer-src/tests/recent-owner.test.mjs` 修改，以及 `_tmp_*`、QA 配置/脚本、Web audit 文件均保留并未暂存；本 handoff 为本地忽略文件。

**修前证据与根因**：真实 Electron 设置页将任务创建者从 editor 降为 viewer 后，成员 PATCH 为 200，但例行任务 GET 仍为 enabled，页面仍显示运行入口，实际执行才遭权限拒绝。`patchMember` 更新成员角色时没有同步维护任务状态。

**修复与状态持久化**：按 docs/16 §15.4/§15.8 与 D-152，在 viewer 降权事务内暂停该工作区该创建者的 enabled 任务，清空 `next_due_at`、递增 revision、记录 `member_role_revoked` 事件；事务提交后通知创建者。双端任务卡显示恢复编辑权限后手动重新启用的原因并隐藏运行入口。升回 editor 不会自动恢复，必须由创建者逐项启用。无批量执行入口，无 docs/90 变更。

**点击验收与量化**：Windows 原生 Electron、Web Chromium 角色降权旅程各 3/3，失败 0。服务端读回 paused 状态、原因码、事件和通知；reload 后仍暂停，恢复 editor 后仍暂停，逐项启用后读回 enabled。完整旅程耗时 Electron 17.0/11.7/11.5 秒（p50 11.7，最近秩 p95 17.0），Web 10.6/8.3/8.2 秒（p50 8.3，p95 10.6）。本旅程不生成模型内容，mock 不代表真实模型质量。

**验证**：最终隔离 fixture 版本定向 Go 用例通过（12.515s）；完整 `go test -p 1 -count=1 ./internal/app` 通过（403.027s，含 HC-01～31；全量运行发生在测试 fixture 最终隔离调整之前，调整后定向用例复验通过）。双端 typecheck 通过，Web 单测 42/42，桌面 renderer 单测 40/40，E2E pair guard Web123/桌面87/36 对通过。双端 Playwright 角色降权旅程均以 `--repeat-each=3 --workers=1` 运行并 3 passed。`git diff --check` 与暂存差异检查通过。

**剩余范围**：T-AW27 仍未覆盖用户禁用、成员移除、工作区关闭、模型失效及多进程竞态。真实模型费用、真实平台发布、生产迁移及签名安装升级不在本地 mock 授权范围内。继续 DEV-QA26 剩余可执行项目，保留现有工作树文件；不 push/deploy。

## 2026-11-05 监控 checkpoint 第三十轮（协作监控智能体 · 批次 f565009b + 327239ea G7 T-AW27 复核）

**基线与新批次**：上轮基线 HEAD `f3b87e22`；本轮确认两个新提交（未 push，main 领先 origin/main 57）。① `f565009b DEV-QA26: 修复账号停用未暂停例行任务`（G7 T-AW27/AG-06）：提交内容与第三十七轮 checkpoint 声明一致，9 文件（`server/internal/app/accounts.go` 停用事务、双端 `RoutinePanel.tsx`、双端 `agent-routines.spec.ts`、`agent_routines_test.go`、docs/08/22/26），`git show --check` 干净。② `327239ea DEV-QA26: 修复成员降权未暂停例行任务`（AG-07）：与第三十八轮 checkpoint 一致，9 文件（`server/internal/app/workspaces.go` patchMember viewer 降权事务、双端 `RoutinePanel.tsx`、双端 E2E、Go 集成测试、docs/08/22/26），`git show --check` 干净。

**核验证据**：抽查 server 修复为真实事务实现：账号停用与成员降为 viewer 均在一个事务内暂停 enabled 例行任务、清空 `next_due_at`、递增 revision、写入 paused 事件（`account_disabled` / `member_role_revoked`），事务提交后逐条通知创建者；恢复不自动进行，由用户逐项重新启用——无批量执行入口，符合 D-117 逐张执行红线。docs/22 v0.57/v0.58 新增 AG-06/AG-07（S2·已修）登记位置/证据/影响/验证完整；docs/26 v2.3→v2.4 的 G7-08 更新、AG-07 登记行与专门章节量化数字与 checkpoint 一致，T-AW27 剩余边界（用户禁用、成员移除、工作区关闭、模型失效、多进程竞态）如实保留为未完成。

**独立检查**：`node scripts/check-e2e-pairs.mjs` 通过（Web 123 / 桌面 87 / 36 对，与交接数字一致）。Go 全量（含 HC-01～31，checkpoint 37/38 有 352.613s/403.027s 记录）与双端 Playwright E2E 由主执行智能体已完整验证，监控方未重跑。

**F-02 跟踪**：`desktop/renderer-src/tests/recent-owner.test.mjs` 修复（+18 行）仍完整留在工作树未提交（该路径自 `718a2378` 后无新提交），第三十七/三十八轮 checkpoint 均明确不含该文件，与实际相符。遗留条件继续开放。

**台账变更与结论**：`docs/AI_MONITOR_FINDINGS.md` 追加 F-02 第三十轮跟踪记录、F-05 计数更新（55→57）、第三十轮跟踪小结；无新缺陷条目。复核结论：两个 server 修复批次均通过。

**在途改动提示**：工作树存在主执行智能体下一批未提交改动（`server/internal/app/agent_routines_test.go`、`server/internal/app/workspaces.go`，均在上一批提交过的基础上又有新修改，疑似 T-AW27 其余撤权来源：用户禁用/成员移除），监控方不触碰，待提交后复核。未验证项：真实模型、真实平台发布、生产迁移（主执行智能体已登记为边界）；D-168 回收站清理频率仍待用户裁决。

## 2026-11-05 DEV-QA26 checkpoint 第三十九轮（G7 T-AW27 成员移出暂停例行任务）

**承接与提交**：承接 `327239ea DEV-QA26: 修复成员降权未暂停例行任务`，本轮已提交 `7db02176 DEV-QA26: 移出成员时暂停例行任务`；`main` 相对 `origin/main` 领先 58 个提交，未 push。仅提交本批 9 个文件；保留 `desktop/renderer-src/tests/recent-owner.test.mjs` 的既有修改及所有未跟踪 `_tmp_*`、QA 配置/脚本、Web audit 文件，均未暂存。

**复现与修复**：隔离 Go 集成测试修前读到成员移出后 routine 仍为 `enabled`、`error_code` 为空。`patchMember(remove=true)` 现在在删除成员的同一事务中暂停该成员在工作区创建的 enabled routine，清除 `next_due_at`、增加 revision、写入 `member_removed` paused event；事务提交后发送通知。viewer 降权路径复用同一 helper。双端 routine 卡显示重入且恢复 editor 后须由用户逐项启用的原因。无批量执行入口、无架构或 API 设计变化。

**入口与持久化证据**：Windows 原生 Electron 与 Web Chromium 各连续 3/3，包含成员移出取消/确认、新邀请码重入、暂停状态和通知读回、逐项恢复；移出后的账号自动切回个人工作区，原工作区任务列表为空。Go 集成测试直接断言 DB status/error_code、暂停事件和通知行。Electron 旅程耗时 43.5/31.0/21.8s（p50 31.0、三样本最近秩 p95 43.5）；Web 34.2/19.7/21.8s（p50 21.8、p95 34.2）。

**验证**：`go test -p 1 -count=1 ./internal/app -run '^TestAW10RoutinePausesWhenCreatorIsDemotedToViewer$'` 通过（7.529s）；`go test -p 1 -count=1 ./internal/app` 通过（575.161s，含 HC-01～31）。Web `pnpm test:unit` 42/42、桌面 renderer `pnpm test:unit` 40/40，双端 `pnpm typecheck`、`node scripts/check-e2e-pairs.mjs`（Web123/桌面87/36 对）通过；E2E 初次全量脚本调整后的双端专项三连均 3 passed；`git diff --check` 与提交前 `git diff --cached --check` 通过（仅 CRLF 提示）。详细命令、误判收敛及剩余边界见 docs/08 与 docs/26 第三十九轮。

**当前状态与下一步**：T-AW27 已覆盖绑定账号停用、创建者降为 viewer、成员移出；系统用户禁用、工作区关闭、模型失效和多进程竞态尚未逐项验。先依据 docs/04/05/06/08/16/90 核对剩余本地路径并优先桌面入口，再检查 Web 对照；G8 设置页和 G6 主复盘旅程按既有证据不重做。真实模型费用、真实平台发布、生产迁移、签名安装升级不在本地 mock 授权范围；HC-01～31 与 H-01～09 不修改/跳过/放宽，不 push/deploy。

## 2026-11-05 DEV-QA26 checkpoint 第四十轮（G7 T-AW27 模型不可用暂停例行任务）

**承接与提交**：承接 `7db02176 DEV-QA26: 移出成员时暂停例行任务`；已提交 `d08f8636 DEV-QA26: 模型失效时暂停例行任务`。`main` 相对 `origin/main` 领先 59 个提交，未 push。提交仅含本轮 11 个文件；既有 `desktop/renderer-src/tests/recent-owner.test.mjs` 的未提交修改及 `_tmp_*`、QA 配置/脚本、Web audit 文件均保留，未暂存。此 handoff 是本地忽略文件。

**修前证据与最小修复**：真实 Electron 模型设置页停用例行任务绑定的服务器模型后，provider API 为 disabled，routine API 仍为 enabled。现由 provider 更新及工具能力自检在同一事务内暂停失去可用模型/`tools_ok` 能力的任务，清空 `next_due_at`、递增 revision、写 `model_unavailable` 事件；事务提交后通知创建者。双端任务卡显示恢复模型并完成能力自检后需逐项启用；模型恢复不自动恢复任务，无批量入口、无 docs/90 变更。

**真实入口与量化**：Windows 原生 Electron 和 Web Chromium 各 3/3。设置页点击停用/恢复；服务端读回 provider、routine 状态、原因码、暂停事件、通知及零 occurrence；reload 后仍暂停；用户单独启用后才恢复。Electron 旅程 11.9/8.9/8.9 秒（p50 8.9、三样本最大值近似 p95 11.9），Web 8.3/6.3/6.4 秒（p50 6.4、p95 8.3），失败 0。没有模型内容生成，AI 反馈样本不适用；mock 不代表真实模型质量。密钥/地址变化与失败自检路径的事务逻辑有实现，但未逐项设置 UI 点击验证。

**验证**：完整 `go test -p 1 -count=1 ./internal/app` 通过（407.994 秒，含 HC-01～31）；通知调用顺序调整后定向 `go test -p 1 -count=1 ./internal/app -run '^TestAW10RoutinePausesWhenModelProviderBecomesUnavailable$'` 再通过（8.001 秒）。Web 单测 42/42、桌面 renderer 单测 40/40、双端 typecheck、`node scripts/check-e2e-pairs.mjs`（Web123/桌面87/36对）、`git diff --check` 通过；双端停用模型关键旅程 Playwright `--repeat-each=3 --workers=1` 各 3 passed。E2E 与 Go 日志在 `.playwright-results/qa26-g7-model-unavailable-*`。

**剩余范围与下一步**：T-AW27 仍部分，系统用户禁用、工作区关闭、密钥/地址变更和失败自检设置 UI 点击、多进程调度竞争仍未逐项验；不涉及真实模型质量、生产发布/迁移或签名升级。按 docs/26 与 docs/08 继续 T-AW27 的可执行本地分支及 T-AW28 恶意解析器/组合边界；G8 与 G6 已有的设置和主旅程证据不重复。保持所有遗留工作树文件，不 push/deploy；HC-01～31 与 H-01～09 不修改、跳过或放宽。

## 2026-11-05 监控 checkpoint 第三十一轮（协作监控智能体 · 批次 7db02176 G7 T-AW27 成员移出复核）

**基线与新批次**：上轮基线 HEAD `327239ea`；本轮确认新提交 `7db02176 DEV-QA26: 移出成员时暂停例行任务`（未 push，main 领先 origin/main 58）。提交内容与第三十九轮 checkpoint 声明一致：9 文件（`server/internal/app/workspaces.go`、双端 `RoutinePanel.tsx`、双端 `agent-routines.spec.ts`、`server/internal/app/agent_routines_test.go`、docs/08/22/26），203 插入 40 删除；`git show --check` 无空白问题。

**核验证据**：抽查 server 修复为真实事务实现：新增 `pauseMemberRoutinesTx` 共享 helper（将上一批降权路径内联实现重构复用），成员移出路径在同一事务内（`FOR UPDATE` 行锁 → 暂停 enabled 例行任务、清空 `next_due_at`、递增 revision → 删除成员行）写入 `member_removed` paused 事件，事务提交后按 reason 文案逐条通知创建者；恢复不自动进行，无批量执行入口，符合 D-152 与 D-117 逐张执行红线。docs/22 v0.59 AG-08（S2·已修）登记位置/证据完整；docs/26 v2.4→v2.5 G7-08 行更新、缺陷表 AG-08 条目与专门章节登记（双端各 3/3、重入后仍暂停、逐项启用、Go 集成断言 DB 状态/事件/通知行）与 checkpoint 一致，T-AW27 剩余边界（用户禁用、工作区关闭、模型失效、多进程竞态）如实保留为未完成。

**独立检查**：`node scripts/check-e2e-pairs.mjs` 通过（Web 123 / 桌面 87 / 36 对，与交接数字一致）。Go 全量（含 HC-01～31，checkpoint 39 有 575.161s 记录）与双端 Playwright E2E 由主执行智能体已完整验证，监控方未重跑。

**F-02 跟踪**：`desktop/renderer-src/tests/recent-owner.test.mjs` 修复（+18 行）仍完整留在工作树未提交（该路径自 `718a2378` 后无新提交），第三十九轮 checkpoint 声明保留未暂存，与实际相符。遗留条件继续开放。

**台账变更与结论**：`docs/AI_MONITOR_FINDINGS.md` 追加 F-02 第三十一轮跟踪记录、F-05 计数更新（57→58）、第三十一轮跟踪小结；无新缺陷条目。复核结论：成员移出暂停例行任务批次通过。

**在途改动提示**：工作树存在主执行智能体下一批未提交改动（`server/internal/app/agent_routines.go`、`model_settings.go`、`selftest.go`、`agent_routines_test.go`、双端 `RoutinePanel.tsx`、双端 `agent-routines.spec.ts`、docs/08/22/26，含产品代码），监控方不触碰，待提交后复核。未验证项：真实模型、真实平台发布、生产迁移（主执行智能体已登记为边界）；D-168 回收站清理频率仍待用户裁决。

## 2026-11-05 DEV-QA26 checkpoint 第四十一轮（G7 工作区关闭智能体时暂停例行任务）

**基线与提交**：承接 `d08f8636 DEV-QA26: 模型失效时暂停例行任务`；已提交 `792b5da8 DEV-QA26: 关闭智能体时暂停例行任务`。`main` 相对 `origin/main` 领先 60 个提交，未 push。只提交本批 10 个相关文件；保留桌面 `recent-owner.test.mjs` 修改及既有 `_tmp_*`、QA 配置/脚本、Web audit 文件，未暂存。

**复现与修复**：修前真实 Windows Electron `/settings/agent` 关闭再开启工作区智能体后，routine API 仍为 enabled；隔离 Go 集成测试读取到 enabled、`next_due_at` 非空且无暂停事件。`putAgentSettings` 现把工作区设置保存、routine 暂停、原因/事件写入放在一个事务；pending occurrence 中断，leased/running run 停止标记；提交后取消在途 run 并通知。双端提示 `agent_disabled` 原因，重开工作区不自动启用，任务需逐项恢复。

**验收证据**：Windows 原生 Electron/Web Chromium 各 3/3。API 读回 `paused`、`agent_disabled`、`next_due_at=null` 和通知；UI 显示暂停说明并隐藏立即运行入口，逐项启用后 API 为 enabled。完整旅程 p50/p95：Electron 13.7/15.2 秒，Web 11.9/12.0 秒。普通开关样本每端 60 次、失败 0，Electron 167/238ms，Web 165/483ms（p50/p95，最近秩；包括点击、PUT 200 与 aria 状态更新）。没有模型生成，AI 反馈样本不适用。

**验证**：定向 Go 用例 7.627s；全量 `go test -p 1 -count=1 ./internal/app` 通过 402.222s（HC-01～31）。Web/桌面 typecheck 通过，Web unit 42/42、桌面 renderer unit 40/40，E2E pair guard Web123/桌面87/36 对通过；双端真实点击旅程均 `--repeat-each=3` 通过。首轮全量 Go 仅通知断言把共享 fixture 的既有同类通知计入（2）；断言改为 routine 专属链接并补清理后通过。首轮修后 Electron E2E 的旧文案 locator 已更正，最终三连通过。

**后续**：T-AW27 仍部分：系统用户禁用设置入口、pending/leased occurrence 与在途 run 停止的独立 UI 验收、真实多进程调度竞争未完成；密钥/地址变化与失败工具自检的设置 UI 路径未点击。T-AW28 解析边界继续按 docs/26。按 docs/26、08 优先可执行桌面路径并核对 Web；G8 与 G6 已有的设置/主复盘证据不重做。mock 不证明真实模型质量。HC-01～31 与 H-01～09 未修改、跳过或放宽；真实模型费用、平台发布、生产迁移、签名安装升级未验证；不 push/deploy。

## 2026-11-05 监控 checkpoint 第三十二轮（协作监控智能体 · 批次 d08f8636 + 792b5da8 G7 T-AW27 复核）

**基线与新批次**：上轮基线 HEAD `7db02176`；本轮确认两个新提交（未 push，main 领先 origin/main 60）。① `d08f8636 DEV-QA26: 模型失效时暂停例行任务`（AG-09）：提交内容与第四十轮 checkpoint 声明一致，11 文件（`server/internal/app/agent_routines.go` +52、`model_settings.go` +13、`selftest.go` 29±、`agent_routines_test.go` +91、双端 `RoutinePanel.tsx` 各 +1、双端 `agent-routines.spec.ts` 桌面 +57/Web +43、docs/08/22/26），`git show --check` 干净。② `792b5da8 DEV-QA26: 关闭智能体时暂停例行任务`（AG-10）：与第四十一轮 checkpoint 一致，10 文件（`server/internal/app/agent.go` +20、`agent_routines.go` +100、`agent_routines_test.go` +74、双端 RoutinePanel/E2E、docs/08/22/26），`git show --check` 干净。

**核验证据**：抽查 server 修复均为真实事务实现：①`updateProvider` 在 provider 更新同一事务内按"provider 非 active / 非 server 执行位置 / 无匹配 `tools_ok` 能力"条件以 `UPDATE...FROM` 暂停受影响 enabled 例行任务（`model_unavailable`、清 `next_due_at`、revision+1），写 paused 事件、事务提交后逐条通知创建者；②`putAgentSettings` 把工作区设置保存与 `pauseAgentRoutinesForWorkspaceTx` 放入同一事务（`agent_disabled`），同事务将 pending/leased occurrence 置 interrupted、running run 置 stage=stopping，提交后逐 run `agentCancelRun` 并通知；`finishAgentRoutineTx` 新增 `agent_disabled` 分支防止在途 run 完成时覆盖暂停状态。恢复均不自动进行、由用户逐项重新启用，无批量执行入口，符合 D-152 与 D-117 逐张执行红线。docs/22 v0.60 新增 AG-09/AG-10（均 S2·已修）登记完整；docs/26 v2.5→v2.6→v2.7 登记与 checkpoint 量化数字一致，T-AW27 剩余边界（系统用户禁用、密钥/地址变更 UI 路径、多进程竞态、在途 run 停止的独立 UI 验收）如实保留。

**独立检查**：`node scripts/check-e2e-pairs.mjs` 通过（Web 123 / 桌面 87 / 36 对，与交接数字一致）。Go 全量（含 HC-01～31，checkpoint 40/41 记录 407.994s/402.222s）与双端 Playwright E2E 由主执行智能体已完整验证，监控方未重跑。

**F-02 跟踪**：`desktop/renderer-src/tests/recent-owner.test.mjs` 修复（+18 行）仍完整留在工作树未提交（该路径自 `718a2378` 后无新提交），第四十/四十一轮 checkpoint 均明确声明保留该文件未暂存修改，与实际相符。遗留条件继续开放。

**台账变更与结论**：`docs/AI_MONITOR_FINDINGS.md` 追加 F-02 第三十二轮跟踪记录、F-05 计数更新（58→60）、第三十二轮跟踪小结；无新缺陷条目。复核结论：两个 server 修复批次均通过。

**在途改动提示**：工作树存在主执行智能体下一批未提交改动（`server/internal/app/agent_routines.go`、`agent_routines_test.go`，均为上一批已提交文件的新修改，疑似 T-AW27 剩余分支），监控方不触碰，待提交后复核。未验证项：真实模型、真实平台发布、生产迁移（主执行智能体已登记为边界）；D-168 回收站清理频率仍待用户裁决。

## 2026-11-05 DEV-QA26 checkpoint 第四十二轮（G7 T-AW27 系统用户禁用后暂停例行任务）

**基线与提交**：承接 `792b5da8`；本批提交 `c87ca38 DEV-QA26: 禁用系统用户时暂停例行任务`（11 个文件）。`main` 相对 `origin/main` 领先 61 个提交，未 push。提交前显式暂存并复核本批 11 个文件；保留未提交 `desktop/renderer-src/tests/recent-owner.test.mjs` 和所有既有未跟踪 `_tmp_*`、QA 配置/脚本、Web audit 文件。该 handoff 文件由 `.gitignore` 忽略，仅本地追加、不提交。

**完成内容**：修复系统管理员禁用用户时，其创建的 enabled routine 未同步暂停的问题。用户禁用、删除 session、暂停 routine/清空 `next_due_at`/revision 递增/写 `system_user_disabled` 事件在同一事务；提交后取消相关 run 并通知。双端显示暂停原因，重新启用用户并重新登录后任务仍暂停，须逐项恢复。docs/26 v2.8 增加 AG-11、G7-08 更新；docs/22 v0.62 增加 AG-11；docs/08 checkpoint 42 已记录验证。遵循 docs/16 §15.8 和 D-152，无 docs/90 决策更新，无批量执行入口。

**验收证据**：Windows 原生 Electron 与 Web Chromium focused E2E 各 3/3。Electron 旅程 12.9/11.6/11.4s（p50 11.6、p95 12.9）；Web 10.0/8.1/8.0s（p50 8.1、p95 10.0）。Go 定向用例 6.459s、完整 `go test -p 1 -count=1 ./internal/app` 321.026s（含 HC-01～31）；Web/桌面 unit 42/42、40/40；双端 typecheck、E2E pair guard（Web123/桌面87/36 对）通过；`git diff --check` 通过。UI 点击、API 状态/事件/通知读回与 Go 数据库断言分别作为可见性及持久化证据。mock 仅证明流程契约，不代表真实模型质量。

**当前剩余**：T-AW27 仍部分，用户禁用后的在途 run 停止 UI 专项、真实多进程调度竞争、模型密钥/地址变化及失败工具自检设置入口待验。之后按 DEV-QA26 顺序继续 G8/G6/G7 剩余点击验收；不重复已完成项。真实模型费用、真实平台发布、生产迁移、签名安装升级未在本地授权范围；不 push/deploy。无 AI 生成内容，本批 AI 反馈样本不适用。

## 2026-11-05 DEV-QA26 checkpoint 第四十三轮（G7 T-AW27 在途 run 停止后保留暂停原因）

**基线与提交**：承接 `c87ca38c`；本批提交 `45feaef4 DEV-QA26: 保留在途例行任务暂停原因`，`main` 相对 `origin/main` 领先 62 个提交，未 push。提交只含桌面例行任务 E2E、`server/internal/app/agent_routines.go` 和 docs/08、22、26；继续保留 `desktop/renderer-src/tests/recent-owner.test.mjs` 的原有修改及所有 `_tmp_*`、QA 配置/脚本、Web audit 未跟踪文件。本 handoff 由 `.gitignore` 忽略，仅本地追加。

**修前复现与修复**：Windows 原生 Electron 中创建并运行例行任务，延迟 mock 保持模型请求在途后，从另一窗口系统管理页禁用用户。撤权成功取消模型请求、原用户会话返回 401，但 `finishAgentRoutineTx` 把 routine 的 `system_user_disabled` 覆盖为 `stopped`，暂停卡丢失恢复原因。现改为 run 结束时保留已 paused routine 的非空原因码；occurrence 仍为 `interrupted/stopped`，conversation `last_run.status=stopped`。重新启用系统用户后仍需逐项启用任务，无 docs/90 需求/架构变化、无批量执行入口。

**验收与验证**：在途 Electron 旅程连续 3/3，失败 0；每轮均点击“立即运行一次”、确认 occurrence running、真实系统管理页禁用用户、代理观察到取消、401、重新启用并重登录。UI 和 API 分开核实 routine paused 原因、通知、occurrence、`run_id`、执行历史、`last_run`；逐项启用后原 occurrence 仍中断。全旅程 17.218/13.544/12.575s（p50=13.544、p95=17.218），20 次交互/轮的 p50/p95 为 35.05/74.32ms、36.22/64.03ms、34.28/73.56ms。Web 既有系统用户禁用/恢复路径在共享后端改动后重跑 3/3，10.826/9.152/8.694s。`go test -p 1 -count=1 ./internal/app` 通过（371.689s，含 HC-01～31）；桌面 renderer typecheck、E2E pair guard（Web123/桌面87/36 对）、`git diff --check` 通过。mock 停在模型回复前，不生成 AI 内容；不能代表真实模型质量。

**剩余**：T-AW27 仍部分检查，真实多进程竞争、模型地址/密钥变化与失败工具自检设置路径、T-AW28 解析边界仍待验。真实模型费用、平台发布、生产迁移、签名安装升级未验证；不 push/deploy。预存未提交和未跟踪文件未触碰。

## 2026-11-05 DEV-QA26 checkpoint 第四十四轮（G8-09 Electron 智能体输入法组字事件）

**基线与提交**：承接 `45feaef4`，本批提交 `80c466f9 DEV-QA26: 验收 Electron 智能体输入法交互`，`main` 相对 `origin/main` 领先 63 个提交，未 push。提交仅含 `desktop/renderer-src/e2e/g8-system-electron.spec.ts`、docs/08 与 docs/26；原有 `desktop/renderer-src/tests/recent-owner.test.mjs` 修改及全部 `_tmp_*`、QA 脚本/配置、Web audit 未跟踪项均保留。本 handoff 被 `.gitignore` 忽略，只在本地追加。

**验收结果**：真实 Electron 隔离 profile 的智能体发送框，以 CDP 输入组字文本并模拟 `isComposing=true` 和 `keyCode=229` 的 Enter 事件各 10 次/轮；20 次期间没有对话 POST，服务端 GET 对话列表为空。提交候选后正常按 Enter，消息 POST 202，GET 会话详情读回唯一匹配 user 消息。连续 3/3，失败 0；每轮 20 次交互 p50/p95：26.36/50.07ms、20.65/52.24ms、19.60/42.98ms。以上是 Electron renderer 上的 CDP/DOM 合同模拟，不是物理 Windows IME 测量。Web helper 同源实现，OPT65 既有 Web 测试覆盖组字保护；本批未重跑 Web。

**验证**：桌面定向 E2E 3 passed；桌面 renderer `pnpm typecheck` 通过；pair guard Web123/桌面87/36 对通过；`git diff --check`、`git show --check HEAD` 通过。初始失败原因为 Playwright 项目筛选、provider mock 端口和普通 Enter 在 textarea 生成换行，修正验收夹具后通过，没有产品缺陷与产品代码变更。G8-09 仍部分检查：物理 Windows IME、完整读屏器与全局无障碍语义、原生桌面窄屏未验。无 AI 反馈质量评估，本地 mock 不代表真实模型质量；未运行 Go/HC，HC-01～31、H-01～09 未修改/跳过/放宽；不 push/deploy。下一步按原顺序继续核对 G6 未闭合的本机可执行项，再进 G7 剩余矩阵。

## 2026-11-05 DEV-QA26 checkpoint 第四十五轮（G7-03/T-AW28 双端文档解析边界补测）

**基线与提交**：承接 `80c466f9`；本批单任务提交 `b05ac2a0 DEV-QA26: 补齐双端文档解析拒绝验收`。`main` 相对 `origin/main` 领先 64 个提交，未 push。提交只包含双端 `agent-documents.spec.ts` 与 docs/08、docs/26。继续保留 `desktop/renderer-src/tests/recent-owner.test.mjs` 的原有修改、两个 `_tmp_*`、QA 样本/配置/脚本及 `web/audit-*`、`shot-models.mjs` 未跟踪项。此 handoff 被 `.gitignore` 忽略，仅本地追加。

**验收结果**：Windows 原生 Electron 和 Web Chromium 真实 UI 入口逐项拒绝 CSV 超过 10000 行、101 列、未闭合引号 CSV、损坏 DOCX ZIP 与嵌入对象 DOCX。结合既有 PDF/DOCX 上限及安全边界，每轮 12 个 422 服务端拒绝 + 1 个前端超大文件拦截；最终附件队列可移除失败项，发送禁用，对话列表为空、消息 POST 为 0。双端全旅程各 3/3，失败 0。新增 E2E 捕获 `requestStart` 至 `responseEnd`：每端 36 个服务端拒绝请求；最近秩 p50/p95 Electron 1803.1/2087.3ms、Web 1842.2/2253.8ms。范围分别为 1758.5–2098.4ms、1778.4–2998.3ms。本地 mock 解析耗时，不代表生产负载；没有调用模型，AI 反馈质量样本不适用。

**验证**：桌面 `pnpm test:e2e:renderer -- --config qa26-reuse.playwright.config.ts --project=desktop-renderer-shared-scenarios e2e/agent-documents.spec.ts --grep '逐项拒绝文档解析边界' --repeat-each=3 --workers=1 --reporter=list --timeout=120000`（3 passed）；Web `pnpm e2e -- e2e/agent-documents.spec.ts --grep '逐项拒绝文档解析边界' --project=chromium --repeat-each=3 --workers=1 --reporter=list --timeout=120000`（3 passed）。双端 typecheck 退出码 0；pair guard Web123/桌面87/36 对通过；暂存差异 `git diff --cached --check` 通过。无产品/API/数据库改动，未运行 Go/HC，HC-01～31 与 H-01～09 未修改/跳过/放宽。

**剩余与下一步**：T-AW28 仍部分检查：恶意解析器攻击、DOCX 页数/宏/外链交叉组合、完整解压/页数上界与受限 Linux 容器攻击矩阵未闭合。继续优先 G7/T-AW27 可本地点击的模型配置变化和失败自检路径，并审查 T-AW25～28 剩余本地矩阵；同步核实 Web 对照。G6 主旅程、已验 G8-09 不重复。真实模型费用、真实平台发布、生产迁移、签名安装升级不在本地 mock 授权内；不 push/deploy。

## 2026-11-05 DEV-QA26 checkpoint 第四十六轮（G7 T-AW27 模型密钥自检失败暂停与逐项恢复）

**基线与提交**：承接 `b05ac2a0`；本批提交 `a7961e6 DEV-QA26: 验收模型自检失败暂停恢复`。`main` 相对 `origin/main` 领先 65 个提交，未 push。提交只含双端 `agent-routines.spec.ts` 与 docs/08、docs/26；继续保留 `desktop/renderer-src/tests/recent-owner.test.mjs` 的既有修改、两个 `_tmp_*`、QA 样本/配置/脚本及 Web audit 未跟踪项。此 handoff 被 `.gitignore` 忽略，仅本地追加。

**验收结果**：Windows 原生 Electron 与 Web Chromium 各连续 3/3，失败 0。从智能体 UI 创建受限 routine，再经 `/settings/models` 修改模型密钥为本地 `bad-key`。服务端读回能力清空、`last_test_ok=null`，routine `paused/model_unavailable`、无 `next_due_at`，并有通知。自检 HTTP 200，因原生搜索 mock 不走 bearer 凭证，坏凭证下为 1/7、工具调用失败；UI 不显示密钥，服务端 `tools_ok=false`，无 occurrence。恢复 `local-e2e-key` 后自检 7/7、`tools_ok=true`，routine 仍暂停且无 occurrence，须在卡片点击“重新启用”后才恢复 enabled。

**量化**：每端每轮 20 次供应商启用开关点击，均等待 PATCH 200 和 aria 状态；3 轮合并 60 个样本，失败 0。合并 p50/p95 Electron 109.5/151ms、Web 94.5/178ms。Windows 原生 Electron/Web Chromium，本地隔离 API 与模型 mock；没有真实模型生成与 AI 反馈质量样本。

**验证**：双端 focused UI E2E --repeat-each=3 均 3 passed；desktop 与 Web typecheck 退出码 0；E2E pair guard Web123/桌面87/36 对通过；`git diff --check` 与 `git diff --cached --check` 通过。无产品/API/数据库修改，未运行 Go/HC；HC-01～31、H-01～09 未修改、跳过或放宽。初跑修正 UI label locator，并据 mock 实测修正自检断言为 1/7、7/7，不是产品缺陷。

**剩余与下一步**：G7/T-AW27 仍部分：模型地址变化、真实多进程调度竞态未验。继续优先桌面 G8 models/members/usage/words/trash/export 设置点击项并检查 Web 对照，随后走 G6 手动录入、发布后回填、多时点、看板、报告与建议采纳，再处理 T-AW27/28 其余本地矩阵。真实模型费用、平台发布、生产迁移与签名安装升级不在本地范围；不 push/deploy。

## 2026-11-05 监控 checkpoint 第三十三轮（协作监控智能体 · 批次 c87ca38c～a7961e65 共 5 批复核）

**基线与新批次**：上轮监控基线 HEAD `792b5da8`；本轮确认 5 个新提交（未 push，`git rev-list --count origin/main..main` 实测 65，与 checkpoint 46 声明一致）：① `c87ca38c AG-11 系统用户禁用暂停`（11 文件 463+/13-，checkpoint 42）；② `45feaef4 AG-12 保留暂停原因`（5 文件 288+/9-，checkpoint 43）；③ `80c466f9 G8-09 Electron 输入法`（3 文件，checkpoint 44）；④ `b05ac2a0 T-AW28 双端解析边界补测`（4 文件，checkpoint 45）；⑤ `a7961e65 T-AW27 模型自检暂停恢复`（4 文件，checkpoint 46）。5 批提交内容均与各自 checkpoint 声明一致，`git show --check` 全部干净。

**核验证据**：抽查含产品代码的两批为真实实现：①`adminPatchUser` 禁用用户路径改为同一事务内禁用用户、删除 session、`pauseAgentRoutinesForUserTx`（暂停 enabled 例行任务、清 `next_due_at`、revision+1、`system_user_disabled` 事件），提交后逐 run `agentCancelRun` 并逐条通知；`interruptAgentRoutinePausesTx` 从工作区暂停路径抽出共享（reason 参数化消除重复）；新增真实 Go 集成测试 `TestAW10RoutinePausesWhenSystemUserIsDisabled`；`ops-e2e` 新增的 `SystemAdminUser/Password` 为本地 E2E 测试凭据，非真实密钥。②`finishAgentRoutineTx` 将 `workspaceDisabled`（仅 agent_disabled）泛化为 `preservePauseReason`（任何 paused 且非空原因码在在途 run 结束时保留原因），occurrence 仍 `interrupted/stopped`。两批恢复均不自动进行、无批量执行入口，符合 D-152 与 D-117 红线。纯 E2E 三批抽查断言真实：输入法用例为 CDP `Input.imeSetComposition` + `isComposing=true` keydown 各 10 次/轮，断言 conversation POST 为 0 且事件回读 `isComposing:true`；模型自检用例断言链完整（坏密钥→`last_test_ok=null`/capabilities 清空→routine `paused/model_unavailable`→通知→失败自检 `tools_ok=false`→UI 不泄漏 `bad-key`→无 occurrence→恢复后仍 paused 须逐项启用）。docs/22 v0.62（AG-11）/v0.63（AG-12）、docs/26 v2.8→v2.12、docs/08 checkpoint 42–46 登记链完整。

**独立检查**：`node scripts/check-e2e-pairs.mjs` 实测通过（Web 123 / 桌面 87 / 36 对，与 5 批声明一致）。Go 全量（含 HC-01～31，checkpoint 42/43 记录 321.026s/371.689s）与双端 Playwright E2E 由主执行智能体已完整验证，监控方未重跑。checkpoint 44–46 无产品/API/数据库改动，未运行 Go/HC 的声明与改动范围相符。

**F-02 跟踪**：`desktop/renderer-src/tests/recent-owner.test.mjs` 修复（+18 行）仍完整留在工作树未提交，checkpoint 42–46 均明确声明保留该文件既有修改，与实际相符。遗留条件继续开放。

**台账变更与结论**：`docs/AI_MONITOR_FINDINGS.md` 追加 F-02 第三十三轮跟踪记录、F-05 计数更新（60→65）、新增 F-07（docs/22 版本记录顺序不一致：v0.63 倒序插入 vs v0.60→v0.61 升序追加；docs/26 缺陷表无 AG-12 行、仅有专门章节——内容完整，属登记一致性观察项）、第三十三轮跟踪小结。复核结论：5 批均通过，无产品缺陷。

**在途改动提示**：工作树存在主执行智能体当前批次未提交改动（双端 `cx13-review-multitime.spec.ts` 各约 +75 行，G6 复盘旅程扩展，与 checkpoint 46"下一步走 G6"一致），监控方不触碰，待提交后复核。未验证项：真实模型、真实平台发布、生产迁移、签名安装升级（主执行智能体已登记为边界）；D-168 回收站清理频率仍待用户裁决。

## 2026-11-05 DEV-QA26 checkpoint 第四十七轮（G6 手动多时点到报告采纳桌面连续旅程）

**基线与提交**：承接 `a7961e65`；本批提交 `3deb5b5 DEV-QA26: 验收桌面复盘多时点完整旅程`。`main` 相对 `origin/main` 领先 66 个提交，未 push。仅提交双端 `cx13-review-multitime.spec.ts` 与 docs/08、docs/26；预存的 `desktop/renderer-src/tests/recent-owner.test.mjs` 修改及所有 `_tmp_*`、QA 配置/脚本和 Web audit 未跟踪项均保留。本 handoff 由 `.gitignore` 忽略，仅本地追加。

**完整旅程与服务端证据**：Windows 原生 Electron 与 Web Chromium 各 3/3、失败 0。从夹具创建作品后，经真实页面生成发布包并点击“标记为已发布”，API GET 读回 published 和本地 example.invalid URL。再通过复盘页面手录同一作品的 T+1/T+3/T+7 指标；每次 POST 200，GET `/works/{id}/metrics` 读回三条 `source=manual` 和 day_offset 1/3/7。关闭录入抽屉、重载后看板显示 D7 阅读 2,500。之后点击核对 T1/T3/T7 窗口、T30 缺数和未知单位/缺失比率；逐项创建/放弃与结案实验；生成增强报告、编辑观察事实并逐条采纳建议。报告内容与 adopted 索引经 GET `/accounts/{id}/reviews` 读回，实验经 GET `/accounts/{id}/experiments` 读回。界面结果与 API 持久化分开验证；发布 URL 是本地保留域，没有平台写入。

**量化与验证**：E2E 场景时长（含夹具准备、UI、服务端读回；Electron 包含启动）：Electron 18.9/17.0/16.7s，p50/p95=17.0/18.9s；Web 16.3/14.7/14.0s，p50/p95=14.7/16.3s。`pnpm --dir renderer-src typecheck`、Web `pnpm typecheck`、pair guard（Web123/桌面87/36对）、`git diff --check` 和 `git diff --cached --check` 通过。精确 E2E 命令见 docs/08 checkpoint 47。初跑 locator 把带提示的日期标签用 exact 匹配并假定保存后抽屉会关闭；按实际页面语义修正后双端三连通过，属测试定位器问题，没有产品缺陷。

**剩余与下一步**：AI mock 只验证工作流与数据契约，不证明真实模型质量，也未采本轮 AI 反馈样本。未运行 Go/HC；HC-01～31、H-01～09 未修改、跳过或放宽。真实平台发布、生产数据、部署未触及。继续验收 G8 原生数据导出保存文件内容（已测取消对话框），再查其他仍可本地完成的 G8/G7/T-AW27/28 项；不 push/deploy。

## 2026-11-05 DEV-QA26 checkpoint 第四十八轮（G8 Electron 原生导出保存与文件读回）

**提交与工作树**：本批提交 `26d8c58c DEV-QA26: 验收桌面原生导出保存`；`main` 相对 `origin/main` 领先 67 个提交，未 push。提交只含 `desktop/renderer-src/e2e/g8-export-electron.spec.ts`、docs/08、docs/26。提交后仍保留预存的 `desktop/renderer-src/tests/recent-owner.test.mjs` 修改、两个 `_tmp_*`、QA 样本/配置/脚本及 Web audit 未跟踪文件；未清理或覆盖。本文档 `.gitignore` 忽略，仅本地追加。

**验收证据**：Windows 原生 Electron 登录隔离 E2E 用户，从数据导出设置页点击“导出”，POST `/api/v1/exports` 为 200；对话框指向独立临时目录和 `native-save-works.csv`，通过原生保存按钮确认后 Electron `DownloadItem` 状态为 `completed` 且实际路径精确相等。逐次读取 CSV，检查表头、账号名和唯一作品标题。连续 3 次均通过、失败 0；原生取消路径沿用既有证据。本用例只清理由自身创建的隔离临时目录。

**量化与验证**：从导出点击计时至文件保存并读回，含本地 API、原生对话框确认及文件读取，不含账号夹具和 Electron 启动；样本 27.600/25.145/24.335 秒，p50/p95=25.145/27.600 秒（n=3，最近秩），Windows + 本地隔离 E2E API。命令：`cd desktop; $env:OPS_QA26_NATIVE_SAVE_DIALOG='1'; pnpm test:e2e:renderer -- --config qa26-reuse.playwright.config.ts --project=desktop-windows-electron e2e/g8-export-electron.spec.ts -g '真实保存对话框' --repeat-each=3 --workers=1 --reporter=list --timeout=180000 --output ../../.playwright-results/qa26-g8-native-save-20261105-capture`，3 passed；桌面 renderer `pnpm typecheck`、`node scripts/check-e2e-pairs.mjs`（Web123/桌面87/36 对）、`git diff --check` 与暂存差异检查通过。Web OPT14 已有下载字节一致及 503/429/422 错误路径，本批未重跑或改动 Web。未运行 Go/HC，HC-01～31、H-01～09 未修改/跳过/放宽。mock 只证明导出流程，未涉及真实发布或生产数据。

**下一步**：继续核查 docs/26 尚部分覆盖的 G8 设置分支与 T-AW27/T-AW28 可本地验收项，优先桌面并同步核实 Web 对照；G6 与 G8 导出不重复。真实模型费用、真实平台发布、生产迁移、签名安装升级仍不在本地 mock 授权范围；不 push/deploy。

## 2026-11-06 DEV-QA26 checkpoint 第四十九轮（G2-02 双端平台账号编辑、类型迁移与停用）

**提交与工作树**：承接 `26d8c58c`；本批提交 `a467c119 DEV-QA26: 验收双端平台账号管理`。`main` 相对 `origin/main` 领先 68 个提交，未 push。提交仅包含双端 `g8-settings-gaps.spec.ts` 与 docs/08、docs/26。原有 `desktop/renderer-src/tests/recent-owner.test.mjs` 修改、`_tmp_*`、QA 样本/配置/脚本与 Web audit 未跟踪文件均保留，未清理或覆盖。本文件被 `.gitignore` 忽略，仅本地追加。

**验收证据**：Windows 原生 Electron 与 Web Chromium 各 owner/editor 旅程连续 3 次，共 6/6 passed、失败 0。owner 通过真实设置 UI 改名、确认取消和保存；保存状态经 API GET 与 renderer reload 分别读回。类型迁移错误注入 500 后显示错误并禁用确认，重试成功；取消不写入，确认 image_note→comic 后 API 读回新类型，旧作品仍 image_note、新作品 comic。停用取消不变更状态，确认后 API 为 disabled，逐项重新启用后为 active，reload 保留类型/名称。Owner 创建真实 editor 邀请，editor 在目标工作区看到只读页，直接 PATCH 修改与 POST 停用均 403，owner 状态未变。

**量化与验证**：类型影响弹窗打开至摘要可见，每端 n=20，Electron p50/p95=116.87/188.93ms、Web=74.63/100.91ms、失败 0；owner 旅程 Electron 18.642s、Web 15.327s。桌面/Web 双端 `--repeat-each=3` 各 6 passed；双端 typecheck 退出 0；E2E pair guard Web123/桌面87/36 对通过；`git diff --check` 与 `git diff --cached --check` 通过。准确命令及报告目录见 docs/08 checkpoint 49。仅本地 E2E API/mock，无产品/API/数据库修改；未运行 Go/HC，HC-01～31 与 H-01～09 未修改、跳过或放宽。

**剩余与下一步**：D-132 既有 Desktop 账号删除证据未重跑，Web 删除路径尚未验，因此 G2-02 仍部分。继续 G8 尚未验的桌面设置分支并同步检查 Web，再按优先顺序推进 G6/G7 剩余项。真实模型费用、平台发布、生产迁移和签名安装升级未验证；不 push/deploy。

## 2026-11-06 DEV-QA26 checkpoint 第五十轮（G2-02 Web 删除与双端 editor 删除权限）

**提交与工作树**：承接 `a467c119`；本批提交 `170a3873 DEV-QA26: 验收 Web 账号删除权限`。`main` 相对 `origin/main` 领先 69 个提交，未 push。只提交双端 `g8-settings-gaps.spec.ts` 和 docs/08、docs/26。保留原有 `desktop/renderer-src/tests/recent-owner.test.mjs` 修改、两个 `_tmp_*`、QA 样本/配置/脚本及 Web audit 未跟踪文件，没有清理或覆盖。本 handoff 被 `.gitignore` 忽略，仅本地追加。

**验收证据**：Web owner 在真实工作区账号菜单右键并点删除，先取消后账号仍在 `/accounts` 且关联作品 GET 200；确认后 DELETE 200、目标账号消失、关联作品 GET 404，另一个账号保留。真实 Electron 与 Web editor 账号页的删除入口不可用/不显示，直接 `DELETE /accounts/{id}?confirm=true` 两端均 403。配合第 49 轮双端改名/类型迁移/停用与权限证据，以及既有 Desktop D-132 删除用例，G2-02 本地账号管理范围完成。

**重复与验证**：Electron editor 权限旅程连续 3/3，失败 0（55.3 秒）；Web 删除与 editor 权限旅程各连续 3/3，共 6/6 passed（54.4 秒）。双端 typecheck 退出 0；E2E pair guard Web123/桌面87/36 对通过；`git diff --check` 与暂存差异检查通过。命令见 docs/08 checkpoint 50。仅本地隔离 E2E API；无产品/API/数据库修改，未运行 Go/HC，HC-01～31 与 H-01～09 未修改、跳过或放宽。

**剩余与下一步**：G2-02 本地验收通过，但真实平台账号连接未验证。继续 G8 尚部分或未检查且可本机完成的桌面设置分支，并同步核验 Web；G6 复盘既有多时点旅程不重复。真实模型费用、真实平台发布、生产迁移、签名安装升级不在本地 mock 授权内；不 push/deploy。

## 2026-11-06 监控 checkpoint 第三十四轮（协作监控智能体 · 批次 3deb5b5e～170a3873 共 4 批复核）

**基线与新批次**：上轮监控基线 HEAD `a7961e65`；本轮确认 4 个新提交（未 push，`git rev-list --count origin/main..main` 实测 69，与 checkpoint 50 声明一致）：① `3deb5b5e G6 桌面复盘多时点完整旅程`（4 文件 147+/30-，checkpoint 47）；② `26d8c58c G8 桌面原生导出保存`（3 文件 113+/2-，checkpoint 48）；③ `a467c119 G2-02 双端平台账号管理`（4 文件 387+/4-，checkpoint 49）；④ `170a3873 G2-02 Web 删除权限`（4 文件 75+/10-，checkpoint 50）。4 批提交内容均与各自 checkpoint 声明一致，`git show --check` 全部干净，均为纯 E2E + docs 改动。

**核验证据**：抽查断言真实：①`3deb5b5e` 双端 cx13-review-multitime：发布回填 API 读回 `published`+URL、按 day 偏移手录 T+1/T+3/T+7、实验/报告/`adopted` 服务端读回；②`26d8c58c` 桌面 g8-export-electron（新增 91 行）：隔离临时目录 + 原生保存对话框 + CSV 内容读回，只清理自身创建的目录；③`a467c119` 双端 g8-settings-gaps：类型迁移断言完整（旧作品 `image_note` 保持、账号 `comic`、迁移摘要 `works_kept` API 读回 + reload 持久化）、editor PATCH/POST 均 403；④`170a3873`：editor 三连 `DELETE` 403、删除两段式（取消不写入/确认后目标账号消失且关联作品 404、另一账号保留）。docs/08 checkpoint 47–50、docs/26 v2.13→v2.16（G2-02 升"已检查-通过"，真实平台未连接边界如实保留）登记链完整。

**独立检查**：`node scripts/check-e2e-pairs.mjs` 实测通过（Web 123 / 桌面 87 / 36 对，与 4 批声明一致）。双端 E2E 由主执行智能体已完整验证，监控方未重跑；checkpoint 47–50 无产品/API/数据库改动，未运行 Go/HC 的声明与改动范围相符。HC-01～31、H-01～09 未修改/跳过/放宽。

**F-02 跟踪**：`desktop/renderer-src/tests/recent-owner.test.mjs` 修复（+18 行）仍完整留在工作树未提交，checkpoint 47–50 均明确声明保留，与实际相符。遗留条件继续开放。

**台账变更与结论**：`docs/AI_MONITOR_FINDINGS.md` 追加 F-02 第三十四轮跟踪记录、F-05 计数更新（65→69）、第三十四轮跟踪小结；无新缺陷条目，F-07（docs/22 版本顺序 / docs/26 AG-12 表行）继续开放。复核结论：4 批均通过。

**在途改动提示**：工作树存在主执行智能体下一批未提交改动（双端 `agent-documents.spec.ts` 各 +23 行），监控方不触碰，待提交后复核。未验证项：真实模型、真实平台、生产迁移、签名安装升级（主执行智能体已登记为边界）；D-168 回收站清理频率仍待用户裁决。

## 2026-11-06 主执行 checkpoint 51（G7-03/T-AW28 PDF 100 页成功边界）

**基线/工作树**：承接 HEAD `170a3873`；本批提交 `021afbc4 DEV-QA26: 验收 PDF 100 页边界`，`main` 相对 `origin/main` 领先 70 个提交，未 push。本批修改双端 `agent-documents.spec.ts`、docs/08、docs/26；docs/AI_HANDOFF 被 .gitignore 忽略，仅本地追加。保留所有预存 dirty/untracked 文件。

**结果**：双端真实 UI 文件选择上传恰好 100 页 PDF，POST 回执 `200/ready/page_count=100`，原件 GET 200 并读回 PDF 文件头。桌面与 Web 串行 `--repeat-each=3` 各 3/3 通过；每轮 12 个预期 422 拒绝请求。Go `internal/documentparse` 单测通过（47.679s）；双端 typecheck、E2E pair guard、`git diff --check` 通过。n=24/端拒绝请求：Electron p50/p95=2115.1/2483.8ms、范围 2031.4–2492.1ms；Web=2272.4/2853.8ms、范围 1893.5–2931.4ms。

**异常与未完项**：首轮双端 E2E 与 Go 单测并发运行各有一次失败附件卡片未显示，服务端已返回预期 422；串行复验均未复现，根因未确认。T-AW28 的恶意 XML/ZIP 矩阵、DOCX 页数/宏/外链组合、96MiB 解压上限、受限 Linux 容器攻击矩阵及静态安全扫描仍未完成（`staticcheck` 工具链不兼容，`semgrep`/`gosec` 不可用）。未改 Go 产品逻辑、HC、H 门契约或 docs/22/90；不 push/deploy。接下来继续检查 G8 可本机验收设置分支与 T-AW27/T-AW28。

## 2026-11-06 监控 checkpoint 第三十五轮（协作监控智能体 · 批次 021afbc4 T-AW28 PDF 100 页边界复核）

**基线与新批次**：上轮监控基线 HEAD `170a3873`；本轮确认 1 个新提交（未 push，`git rev-list --count origin/main..main` 实测 70，与 checkpoint 51 声明一致）：`021afbc4 DEV-QA26: 验收 PDF 100 页边界`（4 文件 83+/6-，双端 `agent-documents.spec.ts` 各 +25/-6 + docs/08 +17 + docs/26 +22/-6）。提交内容与 checkpoint 51 声明一致，`git show --check` 干净，纯 E2E + docs 改动。

**核验证据**：抽查断言真实完整：恰好 100 页 PDF 上传断言 `200/ready/page_count=100`，附件原件 GET 200、字节 >0 且文件头签名 `%PDF-1.4` 读回。监控方在此批次提交前已独立核查服务端解析边界（`server/internal/documentparse/wasm/main.go`：PDF/DOCX 页数用 `> maxDocumentPages`，恰好 100 页接受；分页符计数保守用 `>=`），实现与该批测试预期一致。docs/26 v2.17、docs/08 checkpoint 51 登记完整。

**独立检查**：`node scripts/check-e2e-pairs.mjs` 实测通过（Web 123 / 桌面 87 / 36 对）。checkpoint 51 运行了 Go `internal/documentparse` 单测（47.679s，非 app 包，与改动范围相符）。首轮并发 E2E/Go 各一次失败、串行复验未复现且根因未确认，主执行智能体已诚实登记；服务端返回正确，暂记为测试稳定性观察，监控台账不单独建档（如复现再记录）。

**F-02 跟踪**：`desktop/renderer-src/tests/recent-owner.test.mjs` 修复（+18 行）仍完整留在工作树未提交，checkpoint 51 声明保留预存 dirty 文件，与实际相符。遗留条件继续开放。

**台账变更与结论**：`docs/AI_MONITOR_FINDINGS.md` 追加 F-02 第三十五轮跟踪记录、F-05 计数更新（69→70）、第三十五轮跟踪小结；无新缺陷条目，F-07 继续开放。复核结论：通过。工作树 tracked 修改仅剩 F-02 未提交修复，无新在途批次。

## 2026-11-06 DEV-QA26 checkpoint 第五十二轮（G7 T-AW27 模型接口地址变化）

**基线与范围**：承接 `021afbc4 DEV-QA26: 验收 PDF 100 页边界`。本批只新增双端 `agent-routines.spec.ts` 的模型接口地址变更/例行任务暂停验收，并更新 docs/08、docs/26。保留预存 `desktop/renderer-src/tests/recent-owner.test.mjs` 修改、临时文件、QA 配置/脚本及 Web audit 未跟踪文件，不清理、不回退、不覆盖。docs/AI_HANDOFF 为 ignored 本地交接文件。

**证据及指标**：Windows 原生 Electron 与 Web Chromium 从模型设置 UI 保存 loopback base URL，API 读回 provider 地址、空 capabilities、例行任务暂停原因与通知，reload 后地址保持；对恢复地址自检 7/7 后任务仍暂停，只逐项重新启用一张任务卡。两端旅程串行各 3/3；n=3 p50/p95：完整旅程 Electron 17,060.76/17,298.01ms、Web 15,354.93/16,338.50ms。每端每轮 20 次保存读回，Electron 三轮 380.74/412.20、382.35/410.62、375.53/394.86ms；Web 311.98/355.76、327.65/369.43、307.82/350.88ms；失败均 0。provider 历史 `last_test_ok` 保留不违反 16 §7.2 / D-117（要求清除能力记录，未规定清除测试历史），未作为新地址可用证据。

**验证**：桌面与 Web 对应 Playwright `agent-routines.spec.ts` grep“修改模型接口地址后暂停例行任务并逐项恢复”、`--repeat-each=3 --workers=1` 各 3 passed；两端 `pnpm typecheck` 退出码 0；E2E 配对守卫 Web123/桌面87/36 对通过；`git diff --check` 通过。一个 locator 可访问名称包含 Field hint，已修正为正则；一次 `last_test_ok` 断言超出契约，已移除，均为测试脚本问题。未改产品逻辑、未运行 Go/HC；HC-01～31、H-01～09 未修改/跳过/放宽，无需更新 docs/22、docs/90。

**提交与未完成项**：本批提交 `244c8740 DEV-QA26: 验收模型地址变化暂停例行任务`，`main` 领先 `origin/main` 71 个提交；未 push。提交只含双端 `agent-routines.spec.ts`、docs/08 与 docs/26。G8-02 Windows 原生 toast 的真实用户可见触发需要等待 action-time 点击授权；授权问题已在本对话提出，未获答复前不点击“开启桌面提示”。可继续不依赖该授权的 G8、T-AW28 和 G7 多进程竞态检查。无真实模型费用、平台写入、生产迁移、签名安装升级；预存 dirty/untracked 文件继续保留。

## 2026-11-06 监控 checkpoint 第三十六轮（协作监控智能体 · 批次 244c8740 T-AW27 模型地址变化复核）

**基线与新批次**：上轮监控基线 HEAD `021afbc4`；本轮确认 1 个新提交（未 push，`git rev-list --count origin/main..main` 实测 71，与 checkpoint 52 声明一致）：`244c8740 DEV-QA26: 验收模型地址变化暂停例行任务`（4 文件 238+/3-，双端 `agent-routines.spec.ts` 各 +105/+92 + docs/08 +18 + docs/26 +26/-3）。提交内容与 checkpoint 52 声明一致，`git show --check` 干净，纯 E2E + docs 改动。

**核验证据**：抽查断言真实：保存 loopback base URL → API 读回地址与空 capabilities → routine `paused/model_unavailable` + 通知 → 恢复地址自检 7/7 后仍暂停、须逐项重新启用；备选地址限定 `['127.0.0.1','localhost','[::1]']`。docs/26 v2.18、docs/08 checkpoint 52 登记完整。主执行智能体诚实登记两处测试脚本问题（locator 可访问名称、`last_test_ok` 超契约断言）并修正，非产品缺陷。

**独立检查**：`node scripts/check-e2e-pairs.mjs` 实测通过（Web 123 / 桌面 87 / 36 对）。checkpoint 52 未改产品逻辑、未运行 Go/HC 的声明与改动范围相符。

**F-02 跟踪**：`desktop/renderer-src/tests/recent-owner.test.mjs` 修复（+18 行）仍完整留在工作树未提交，与 checkpoint 52 声明相符。遗留条件继续开放。

**台账变更与结论**：`docs/AI_MONITOR_FINDINGS.md` 追加 F-02 第三十六轮跟踪记录、F-05 计数更新（70→71）、第三十六轮跟踪小结；待验证项速览新增 **G8-02 Windows 原生 toast 验收的用户授权阻塞项**（需用户答复"开启桌面提示"授权）。无新缺陷条目，F-07 继续开放。复核结论：通过。

## 2026-11-06 DEV-QA26 checkpoint 第五十三轮续接（G7-03/T-AW28 DOCX ZIP/XML 边界）

- 本批已提交 `ea80d56b DEV-QA26: 验收 DOCX 页数与 ZIP 边界`，`main` 领先 `origin/main` 72；无 push。
- 新增双端真实文件选择 E2E：DOCX 畸形 XML、外部实体声明、257 ZIP 条目、101 页、96 MiB+1 中心目录声明、100 页宏/外链组合拒绝；恰好 256 条目、100 页 DOCX、96 MiB 声明及 100 页 PDF 接受并核对服务端回执和原件 GET。每轮 17 个拒绝 + 4 个成功请求，桌面/Web 连续 3/3，失败 0。未验证真实高压缩比恶意 ZIP 的运行时展开资源；T-AW28 保持部分状态。
- Electron 三轮 API p50/p95：2131.50/2665.45、2110.58/2315.50、2137.93/2459.24ms；Web：1955.94/2141.35、2001.73/2430.21、1929.10/2173.39ms。双端 smoke 各 1/1、typecheck、E2E pair guard、diff check 通过；未运行 Go/HC。
- 本批只改桌面/Web `agent-documents.spec.ts` 与 docs/08、docs/26；docs/26 v2.19/G7-03 部分检查更新。保留已有 dirty `desktop/renderer-src/tests/recent-owner.test.mjs` 及所有 `_tmp_*`、QA 脚本/配置、Web audit 未跟踪文件；不清理/回退/覆盖。
- 首次 Electron smoke 因六个附件队列槽位占满未触发后续选择器，脚本按步骤移除已验证卡片后复验；是测试夹具问题，不是产品故障。未改产品/API/数据库，无 docs/22/90 变更。
- G8-02 Windows toast 用户 action-time 授权仍未得到答复，不触发提示；可继续 G8 其它项、G7 多进程竞态和 T-AW28 剩余本地边界。无真实模型/平台/生产写入，不部署、不 push。

## 2026-11-06 监控 checkpoint 第三十七轮（协作监控智能体 · 批次 ea80d56b T-AW28 DOCX/ZIP 边界复核）

**基线与新批次**：上轮监控基线 HEAD `244c8740`；本轮确认 1 个新提交（未 push，`git rev-list --count origin/main..main` 实测 72）：`ea80d56b DEV-QA26: 验收 DOCX 页数与 ZIP 边界`（4 文件 268+/54-，双端 `agent-documents.spec.ts` 各 +143/-54 + docs/08 +18 + docs/26 v2.19）。提交内容与 checkpoint 53 续接声明一致，`git show --check` 干净，纯 E2E + docs 改动。

**核验证据**：抽查断言真实且上界/超界对称：96 MiB+1 中心目录声明、257 条目、101 页、宏/外链组合拒绝；恰好 96 MiB 声明、256 条目、100 页 DOCX/PDF 接受并断言 `200/ready/page_count` 与原件字节读回（`PK\u0003\u0004` 签名）。docs/26 v2.19、docs/08 checkpoint 53 登记完整。

**独立检查**：`node scripts/check-e2e-pairs.mjs` 实测通过（Web 123 / 桌面 87 / 36 对）。checkpoint 53 续接声明未改产品/API/数据库、未运行 Go/HC，与改动范围相符。首次 Electron smoke 六槽位占满属测试夹具问题（主执行智能体已按步骤移除卡片复验），非产品故障。

**F-02 跟踪**：`desktop/renderer-src/tests/recent-owner.test.mjs` 修复（+18 行）仍完整留在工作树未提交，与 checkpoint 53 续接声明相符。遗留条件继续开放。

**台账变更与结论**：`docs/AI_MONITOR_FINDINGS.md` 追加 F-02 第三十七轮跟踪记录、F-05 计数更新（71→72）、第三十七轮跟踪小结。无新缺陷条目；G8-02 用户授权阻塞项仍未获答复（速览已登记）；F-07 继续开放。复核结论：通过。

## 2026-11-06 DEV-QA26 checkpoint 第五十四轮续接（G8 敏感词筛选空态）

- 本批已提交 `1cf9d265 DEV-QA26: 修复敏感词搜索空态并验收双端`，`main` 领先 `origin/main` 73；未 push。
- 双端在真实 Electron/Web 设置入口复现并修复：搜索无命中时错误显示词库为空；现有词库真空态保持。docs/22 登记 2G-22，docs/26 更新 v2.20 与 G8-11，docs/08 checkpoint54。
- Electron owner 覆盖注入 500、草稿取消、两词分类保存与 API 读回、20 次筛选、软删/撤销、reload、检查命中；viewer 在明确切换邀请码目标工作区后只读 UI，写 API 均 403。Web 覆盖异常、保存、20 次筛选与 reload。Electron/Web 关键旅程连续 3/3，失败 0。
- 筛选样本每轮 20 次：Electron p50/p95=21.56/26.33、21.43/31.62、21.99/30.88ms；Web=48.56/64.04、43.36/53.14、49.26/70.03ms。双端 typecheck 退出码 0；E2E pair guard Web123/桌面87/36 对通过；`git diff --check` 通过。未运行 Go/HC，HC-01～31 与 H-01～09 未修改、跳过或放宽；未改 API/数据库。
- 初始 Electron 复验出现的 reload/受邀工作区定位问题属于测试流程；脚本经 UI 设置窗关闭、邀请码登录与 workspace ID 校验修正后连续三轮通过。
- 本提交仅含本轮两个 Words UI、两个 g8 settings E2E 与 docs/08、22、26。既有 dirty `desktop/renderer-src/tests/recent-owner.test.mjs`、`_tmp_*`、QA 配置/脚本和 Web audit 未跟踪文件均保留。G8-02 原生 toast 仍等用户 action-time 授权；下一步核对 G6/G7 未完成条目，不重复已验收项。真实模型费用、真实平台写入、生产迁移、签名安装升级未触及，不 push/deploy。

## 2026-11-06 监控 checkpoint 第三十八轮（协作监控智能体 · 批次 1cf9d265 2G-22 敏感词空态修复复核）

**基线与新批次**：上轮监控基线 HEAD `ea80d56b`；本轮确认 1 个新提交（未 push，`git rev-list --count origin/main..main` 实测 73）：`1cf9d265 DEV-QA26: 修复敏感词搜索空态并验收双端`（7 文件 276+/5-，双端 `Words.tsx` 各 1 行 + 双端 `g8-settings-gaps.spec.ts` +182/+52 + docs/08 +18 + docs/22 + docs/26 v2.20）。提交内容与 checkpoint 54 续接声明一致，`git show --check` 干净。

**核验证据**：新缺陷 2G-22（S3·已修）docs/22 登记复现/根因/修复/验证完整；抽查双端 `Words.tsx` 修复为最小同构单行改动（空态文案优先按搜索词 `q` 非空判断），与登记根因/修复方向一致；E2E 断言真实（空态文案、500 注入失败保留输入且服务端零写入、成功创建），双端各 3/3。docs/26 v2.20 + G8-11 更新。

**独立检查**：`node scripts/check-e2e-pairs.mjs` 实测通过（Web 123 / 桌面 87 / 36 对）。checkpoint 54 声明未运行 Go/HC、未改 API/数据库，与改动范围相符（纯前端 UI 文案修复）。初始 Electron 复验的 reload/受邀工作区定位问题属测试流程（已修正），非产品故障。

**F-02 跟踪**：`desktop/renderer-src/tests/recent-owner.test.mjs` 修复（+18 行）仍完整留在工作树未提交，与 checkpoint 54 声明相符。遗留条件继续开放。

**台账变更与结论**：`docs/AI_MONITOR_FINDINGS.md` 追加 F-02 第三十八轮跟踪记录、第三十八轮跟踪小结；F-05 计数 72→73。无新缺陷条目；G8-02 用户授权阻塞项继续开放；F-07 继续开放。复核结论：通过。

## 2026-11-06 DEV-QA26 checkpoint 第五十五轮续接（G7-03/T-AW28 高压缩 DOCX Linux 容器）

**基线**：HEAD `1cf9d265 DEV-QA26: 修复敏感词搜索空态并验收双端`，`main` 领先 `origin/main` 73。保留工作树所有原有修改与未跟踪文件；AI_HANDOFF 为本地交接记录，不纳入提交。

**本轮变更**：新增 `server/internal/documentparse/runner_test.go` 高压缩 ZIP 跨平台解析器用例与 `runner_linux_test.go` Unix-socket `ServeParser` 集成用例；更新 docs/26 v2.21 的 G7-03 行与本节、docs/08 checkpoint55。没有产品/API/数据库/Compose 改动，没有新 docs/22 或 docs/90 条目。

**Linux 证据**：测试用 1 MiB 块生成中央目录累计声明展开 100,663,297 字节、压缩后 98,371 字节（1023.3:1）的 DOCX。`TestParseHighCompressionDOCXThroughLinuxParserService` 通过 `ServeParser` → Unix socket → `Parse` → WASI 完整本机调用链验证，三个全新 Linux 容器均返回预期 `document rejected: docx_expanded_size_limit`。限制为内存/交换 256 MiB、CPU 0.5、PID32、无网络、只读根、丢弃全部 capability、4 MiB 临时目录、`no-new-privileges`、`GOMAXPROCS=1`、`GOMEMLIMIT=192MiB`。n=3 请求 p50/p95=4394.84/4502.00ms，cgroup 峰值 128.5–130.2 MiB。样本在累计声明限额校验时拒绝，没有实际解压；峰值含测试夹具生成、客户端和服务于同一测试进程，不能推断为独立生产 sidecar 峰值。

**验证**：Windows `cd server; go test -count=1 ./internal/documentparse` 通过（31.264s）。Linux `golang:1.26-bookworm` 编译测试二进制；三个受限容器对 `TestParseHighCompressionDOCXThroughLinuxParserService` 各 1 passed。`git diff --check` 通过。测试未启动生产 Compose、未访问数据库/外网。HC 未运行；HC-01～31 与 H-01～09 不变。

**剩余与下一步**：T-AW28 仍部分：实际成功解压路径 CPU/内存上界、其它 DOCX 页数/宏/外链/XML/ZIP 交叉组合及静态安全扫描未闭合。G7-08 的真实多进程调度竞态仍可本地验证，优先查当前例程调度测试/DB隔离条件并继续；已完成的 G6 多时点旅程与 G8 设置分支不要重跑。G8-02 toast 仍等待既有 action-time 授权。未触及真实模型费用、平台写入、生产迁移、签名安装升级；不 push/deploy。

## 2026-11-06 监控 checkpoint 第三十九轮（协作监控智能体 · 批次 4a7aeaf5 T-AW28 高压缩 DOCX Linux 容器复核）

**基线与新批次**：上轮监控基线 HEAD `1cf9d265`；本轮确认 1 个新提交（未 push，`git rev-list --count origin/main..main` 实测 74）：`4a7aeaf5 DEV-QA26: 受限 Linux 容器验收高压缩 DOCX`（4 文件 137+/2-，`runner_test.go` +59、`runner_linux_test.go` +56、docs/08 +10、docs/26 v2.21）。提交内容与 checkpoint 55 续接声明一致，`git show --check` 干净，纯 Go 测试 + docs。

**核验证据**：抽查断言真实：1023.3:1 高压缩 DOCX（中央目录声明展开 100,663,297 字节/压缩 98,371 字节）经 `ServeParser` → Unix socket → `Parse` → WASI 完整本机链路，3 个受限容器（内存/交换 256 MiB、CPU 0.5、PID32、无网络、只读根、无 capability、`GOMAXPROCS=1`）均断言 `docx_expanded_size_limit`。边界诚实登记（峰值含同进程夹具不能推断生产 sidecar、累计声明限额校验拒绝时未实际解压）。闭合 checkpoint 53 登记的"真实高压缩比恶意 ZIP 运行时展开资源"边界，T-AW28 剩余攻击面缩小。

**独立检查**：`node scripts/check-e2e-pairs.mjs` 实测通过（Web 123 / 桌面 87 / 36 对）。checkpoint 55 声明无产品/API/数据库/Compose 改动、未运行 HC，与改动范围相符。

**F-02 跟踪**：`desktop/renderer-src/tests/recent-owner.test.mjs` 修复（+18 行）仍完整留在工作树未提交，与 checkpoint 55 声明相符。遗留条件继续开放。

**台账变更与结论**：`docs/AI_MONITOR_FINDINGS.md` 追加 F-02 第三十九轮跟踪记录、第三十九轮跟踪小结；F-05 计数 73→74。无新缺陷条目；G8-02 用户授权阻塞项继续开放；F-07 继续开放。复核结论：通过。

## 2026-11-06 DEV-QA26 checkpoint 第五十六轮续接（G7-08 多进程例程调度）

**基线与工作树**：HEAD `4a7aeaf5 DEV-QA26: 受限 Linux 容器验收高压缩 DOCX`，`main` 领先 `origin/main` 74。保留全部既有 modified/untracked。AI_HANDOFF 为本地忽略交接文件，不纳入提交。

**本轮变更**：新增 `server/internal/app/agent_routines_concurrency_test.go`，在 `env_test.go` 增加 test binary worker 模式，更新 docs/26 v2.22 与 docs/08 checkpoint56。生产调度/API/数据库结构/前端无变更，无 docs/22 或 docs/90 更新。

**证据**：两个独立 OS 测试进程，各自建立新 pgx pool 和 Server，经 loopback barrier 同步后并发调用同一 routine 的 `claimAgentRoutineDue`。连续 3/3；数据库读回唯一 scheduled occurrence、唯一 run，routine=`enabled`、occurrence=`completed`、run=`completed`。n=3 旅程 p50/p95=2279.16/2279.95ms。worker 直接调用 claim 函数，完整 ticker 查询/恢复与持锁进程 crash/lease 恢复仍未验；本地 PostgreSQL 与 mock 不代表生产环境或真实模型质量。

**验证与纠错**：定向 `go test -p 1 -count=3 -run '^TestAW10RoutineClaimIsUniqueAcrossProcesses$' -v ./internal/app` 通过。首次 `go test -p 1 -count=1 ./internal/app` 在 258.553s 失败，199 个级联失败的根因是测试新增的完成通知未清，且 t.Cleanup 使用已取消的 t.Context；专属 link 删除及独立 5 秒 cleanup context 修正后，先运行新测试再运行原模型暂停测试通过，最终完整 app suite（含 HC-01～31）通过，343.183s。`git diff --check` 通过。该失败为夹具污染，不是产品缺陷。

**下一步**：G7-08 补完整 scheduler tick/lease 崩溃恢复；G7-03/T-AW28 优先验证压缩文档成功解压路径在受限 Linux 容器中的内存/CPU，并扩展 DOCX 页数、宏、外链、XML/ZIP 组合。已完成 G6 多时点旅程、G8 本地设置分支不要重跑。G8-02 toast 等既有 action-time 授权；不 push/deploy。

## 2026-11-06 监控 checkpoint 第四十轮（协作监控智能体 · 批次 9bd1bfa2 G7-08 多进程竞态复核）

**基线与新批次**：上轮监控基线 HEAD `4a7aeaf5`；本轮确认 1 个新提交（未 push，`git rev-list --count origin/main..main` 实测 75）：`9bd1bfa2 DEV-QA26: 并发验收例行任务跨进程领取`（4 文件 259+/3-，`agent_routines_concurrency_test.go` +224、`env_test.go` worker 模式 +10、docs/08 +12、docs/26 v2.22）。提交内容与 checkpoint 56 续接声明一致，`git show --check` 干净，纯 Go 测试 + docs。

**核验证据**：抽查实现真实：`os.Executable()` fork 出两个独立 OS 测试进程（各自 pgx pool + Server），loopback barrier 同步后并发 `claimAgentRoutineDue`，断言数据库唯一 scheduled occurrence 与唯一 run；定向 `-count=3` 通过，完整 app suite（含 HC-01～31）通过（343.183s）。闭合 checkpoint 52/55 登记的"真实多进程调度竞态"claim 部分；完整 ticker/lease 崩溃恢复边界诚实保留。

**独立检查**：`node scripts/check-e2e-pairs.mjs` 实测通过（Web 123 / 桌面 87 / 36 对）。首轮全量失败为夹具污染（新增完成通知未清 + `t.Context` 已取消），主执行智能体诚实登记并以专属 link 删除 + 独立 5s cleanup context 修复，非产品缺陷。

**F-02 跟踪**：`desktop/renderer-src/tests/recent-owner.test.mjs` 修复（+18 行）仍完整留在工作树未提交，与 checkpoint 56 声明相符。遗留条件继续开放。

**台账变更与结论**：`docs/AI_MONITOR_FINDINGS.md` 追加 F-02 第四十轮跟踪记录、第四十轮跟踪小结；F-05 计数 74→75。无新缺陷条目；G8-02 用户授权阻塞项继续开放；F-07 继续开放。复核结论：通过。

## 2026-11-06 DEV-QA26 checkpoint 第五十七轮续接（G7-03/T-AW28 实际 DOCX 解压）

- 基线 HEAD `9bd1bfa2`、`main` ahead 75。保留所有预存 modified/untracked，不清理、不回退；`docs/AI_HANDOFF.md` 被 git ignore，不提交。
- 本批文件：`server/internal/documentparse/runner_test.go`、`runner_linux_test.go`、docs/26 v2.23、docs/08 checkpoint57。只增加解析器测试夹具/测试，没有生产解析器、API、schema、UI、Compose 改动，无 docs/22 或 docs/90 变更。
- 成功实测：4 MiB `word/document.xml` / 压缩 4,461 bytes / 940.2:1，WASI 返回 extracted=4,194,214、injected=20,000、正确截断回执。Windows `go test -count=1 ./internal/documentparse` 37.452s 通过。Linux 256 MiB、CPU0.5、pids32、无网络/只读/root cap 全移除等约束容器内，完整 `ServeParser→Unix socket→Parse→WASI` 大样本与 96 MiB+1 拒绝两用例各 -count=3：6 passed/0 failed。成功 4MiB 的 p50/p95=11,073.26/11,199.44ms；拒绝样本=4,283.06/4,441.78ms；本轮容器 cgroup peak=182,980,608 bytes（含同进程夹具/客户端/服务）。
- 32 MiB 单条目 Windows WASI 试验在 30.08s 收到 `parser module failed`，硬期限命中；不推断样本无效或大小上限必然拒绝，边界成功性未定。首次 Linux service tests 立即连接失败的根因是 helper 的局部 defer 在函数返回时关闭服务；转为 test cleanup 后目标用例 3/3 稳定。裸 Linux 全 package 另试失败两项，因为环境未配置 Linux 生产设计要求的解析 service socket；不能说全 Linux package 通过。目标服务集成路径通过。
- docs/26 G7-03 仍 partial：实际成功解压目前只有 4 MiB 单一尺寸，DOCX 多维交叉组合和静态安全扫描待做；G7-08 ticker/lease crash recovery 也待做。HC-01～31/H-01～09 未修改/跳过/放宽；不 push/deploy、不碰真实模型/平台/生产迁移/签名安装升级。
- 下一步遵从用户优先级：真实 Electron G8 设置页尚未验的 models、members、usage、words、trash、export，保存后重载、空/错误/取消与权限；同时核对 Web 对应状态。之后继续可执行 G7/T-AW28/T-AW27。当前额外预存 dirty/untracked 名单见 `git status --short`；不要 stage 这些无关项目。

## 2026-11-06 监控 checkpoint 第四十一轮（协作监控智能体 · 批次 466ddd32 T-AW28 实际解压资源复核）

**基线与新批次**：上轮监控基线 HEAD `9bd1bfa2`；本轮确认 1 个新提交（未 push，`git rev-list --count origin/main..main` 实测 76）：`466ddd32 DEV-QA26: 验收 DOCX 实际解压资源`（4 文件 114+/14-，`runner_test.go` +60、`runner_linux_test.go` +42/-14、docs/08 +12、docs/26 v2.23）。提交内容与 checkpoint 57 续接声明一致，`git show --check` 干净，纯 Go 测试 + docs。

**核验证据**：抽查实现真实：940.2:1 高压缩 4 MiB DOCX 经受限容器 `ServeParser→Unix socket→Parse→WASI` 成功解压（`extracted=4,194,214`、`injected=20,000`、截断回执正确），夹具内置压缩比下限自检（低于阈值 `Fatalf`），与 96 MiB+1 拒绝用例 `-count=3` 全过（6 passed/0 failed）。闭合 cp56 登记的"成功解压路径内存/CPU"边界。

**独立检查**：`node scripts/check-e2e-pairs.mjs` 实测通过（Web 123 / 桌面 87 / 36 对）。边界诚实度高：32 MiB 单条目 30s 硬期限"边界成功性未定"、裸 Linux 全 package 因环境缺 service socket 未通过（"不能说全 Linux package 通过"）、cgroup 峰值含同进程夹具——均为如实声明而非含糊通过。

**F-02 跟踪**：`desktop/renderer-src/tests/recent-owner.test.mjs` 修复（+18 行）仍完整留在工作树未提交，与 checkpoint 57 声明相符。遗留条件继续开放。

**台账变更与结论**：`docs/AI_MONITOR_FINDINGS.md` 追加 F-02 第四十一轮跟踪记录、第四十一轮跟踪小结；F-05 计数 75→76。无新缺陷条目；G8-02 用户授权阻塞项继续开放；F-07 继续开放。复核结论：通过。

## 2026-11-06 DEV-QA26 checkpoint 第五十八轮（G7-08 scheduler tick/lease 恢复；G7-09 原生 reload 未闭合）

**已完成**：G7-08 两个独立 OS worker 各执行完整 `runAgentRoutines` tick，竞争同一到期任务；三轮均仅 1 occurrence/1 completed run，p50/p95=2,288.45/2,299.34ms。过期已提交未启动 lease 下一 tick 恢复原 occurrence 并只生成一个 completed run，3/3，p50/p95=156.83/1,189.63ms。全套 `go test -p 1 -count=1 ./internal/app` 通过（352.735s，含 HC-01～31）。

**G7-09 状态**：真实 Electron 用量路径已证明 500 重试、取消离开、保存失败保留输入、成功保存/API 读回；随后 reload 的三种等待方式均超时。错误上下文快照来自测试 fixture Chromium，无法归因 Electron 页；没有产品缺陷结论。撤下本轮失败的临时 E2E 变更；G7-09 保持部分检查，下一轮查清原生 reload 并补权限/分组样本。models/members/words/trash/export 对应桌面 evidence 已有；toast action-time 未授权，不触发。

**范围与边界**：没有生产逻辑/API/schema/UI 改动。未实杀持锁进程、未等 `RunJobs` 一分钟 timer，G7-08 仍部分；G7-03 资源矩阵继续未闭合。G6 桌面复盘发布标记→T+1/T+3/T+7→看板→报告→建议采纳此前已 3/3 且服务端读回，本轮不重复。HC-01～31/H-01～09 未修改、跳过或放宽；不 push/deploy、不触及生产/真实平台/模型。

**提交与下一步**：本批单独提交 `0f8b8716 DEV-QA26: 验收例行调度 tick 与 lease 恢复`，未 push。继续追查 G7-09 原生 reload，之后继续 G7-08 定时/崩溃边界和 T-AW28。

## 2026-11-06 监控 checkpoint 第四十二轮（协作监控智能体 · 批次 0f8b8716 G7-08 tick/lease 复核）

**基线与新批次**：上轮监控基线 HEAD `466ddd32`；本轮确认 1 个新提交（未 push，`git rev-list --count origin/main..main` 实测 77）：`0f8b8716 DEV-QA26: 验收例行调度 tick 与 lease 恢复`（4 文件 109+/5-，`agent_routines_test.go` +80、docs/08 +12、docs/26 v2.24）。提交内容与 checkpoint 58 声明一致，`git show --check` 干净，纯 Go 测试 + docs。

**核验证据**：抽查实现真实：双独立 OS worker 各执行完整 `runAgentRoutines` tick 竞争同一到期任务（3/3 唯一 occurrence/run）；手工 INSERT 过期已提交未启动 lease（`lease_until` 已过）后下一 tick 恢复原 occurrence 且只生成一个 completed run（3/3）；Go 全量含 HC 通过（352.735s）。闭合 cp55/56 剩余的 tick 竞争与 lease 恢复边界（未实杀持锁进程边界保留）。

**G7-09 观察**：真实 Electron 用量页 reload 三种等待超时，主执行智能体诚实处理——错误快照来自 fixture Chromium 无法归因、无产品缺陷结论、撤下临时 E2E 变更、G7-09 保持部分检查。未把测试环境问题当缺陷也未隐瞒，处理方式符合验收纪律。

**独立检查**：`node scripts/check-e2e-pairs.mjs` 实测通过（Web 123 / 桌面 87 / 36 对）。

**F-02 跟踪**：`desktop/renderer-src/tests/recent-owner.test.mjs` 修复（+18 行）仍完整留在工作树未提交，与 checkpoint 58 声明相符。遗留条件继续开放。

**台账变更与结论**：`docs/AI_MONITOR_FINDINGS.md` 追加 F-02 第四十二轮跟踪记录、第四十二轮跟踪小结；F-05 计数 76→77。无新缺陷条目；G8-02 用户授权阻塞项继续开放；F-07 继续开放。复核结论：通过。
## 2026-11-06 DEV-QA26 checkpoint 第五十九轮（G7-03/T-AW28 8 MiB DOCX 解压与静态扫描）

- 基线 HEAD `0f8b8716`，main ahead 77。保留原有 dirty/untracked。本批改 `server/internal/documentparse/runner_test.go`、`runner_linux_test.go`、`service_windows.go`、`limits_linux.go` 及 docs/26、docs/08；AI_HANDOFF 为本地忽略交接文件，不提交。
- 8 MiB DOCX 条目压缩 8,547 bytes，981.5:1；真实 Linux `ServeParser→Unix socket→Parse→WASI` 受限容器连续 3/3 成功，p50/p95=18,255.30/18,345.86ms；WASI 回执 extracted=8,388,518、injected=20,000、截断范围准确。cgroup peak 241,127,424 bytes（约 230/256 MiB，含测试端/服务/夹具）。Windows `go test -count=1 ./internal/documentparse` 通过（48.939s）。
- Go1.26.10 构建 staticcheck v0.6.1 后，Windows/Linux amd64/WASI wasm 三目标通过；`go vet ./internal/documentparse` 通过，`govulncheck ./internal/documentparse` 无已知漏洞。修复 ST1005 报告的 fallback 文案大写首字母（仅文案）。人工边界检查未见网络/宿主 FS 逃逸。gosec/semgrep 未安装，不能称完整 SAST。
- G7-03/T-AW28 仍部分：8 MiB 峰值距限制约 26 MiB，32 MiB 样本在 30s 内未完成；更大成功输入和结构交叉矩阵未闭合。HC/H 未变更/跳过/放宽，无 docs/22/90 变更，不触及真实模型、平台、生产环境，不 push/deploy。
- 下一项：真实 Electron 中查明 G7-09 用量保存后 reload 阶段状态，补 editor 403、报表分组 20 样本；随后继续 G7-08 `RunJobs` 一分钟 timer 和实际进程崩溃边界、T-AW28 资源/结构矩阵。原有 dirty/untracked 需保持。

## 2026-11-06 监控 checkpoint 第四十三轮（协作监控智能体 · 批次 472886ee T-AW28 8 MiB 解压/静态扫描复核）

**基线与新批次**：上轮监控基线 HEAD `0f8b8716`；本轮确认 1 个新提交（未 push，`git rev-list --count origin/main..main` 实测 78）：`472886ee DEV-QA26: 验收 DOCX 8 MiB 解压与静态扫描`（6 文件 56+/5-）。提交内容与 checkpoint 59 声明一致，`git show --check` 干净。

**核验证据**：产品代码逐行核实仅 `limits_linux.go`/`service_windows.go` 各 2 行错误文案小写化（ST1005，无行为变化）；8 MiB DOCX（981.5:1）经真实受限容器 3/3 成功（extracted=8,388,518、截断范围准确），cgroup 峰值约 230/256 MiB（含同进程夹具，边界如实）。静态扫描部分闭合：staticcheck v0.6.1 三目标 + `go vet` + `govulncheck` 无已知漏洞；gosec/semgrep 未装"不能称完整 SAST"诚实声明。

**独立检查**：`node scripts/check-e2e-pairs.mjs` 实测通过（Web 123 / 桌面 87 / 36 对）。32 MiB 30s 未完成、更大成功输入未闭合，边界保留。

**F-02 跟踪**：`desktop/renderer-src/tests/recent-owner.test.mjs` 修复（+18 行）仍完整留在工作树未提交，与 checkpoint 59 声明相符。遗留条件继续开放。

**台账变更与结论**：`docs/AI_MONITOR_FINDINGS.md` 追加 F-02 第四十三轮跟踪记录、第四十三轮跟踪小结；F-05 计数 77→78。无新缺陷条目；G8-02 用户授权阻塞项继续开放；F-07 继续开放。复核结论：通过。

## 2026-11-06 DEV-QA26 checkpoint 第六十轮（G7-09 原生 Electron 用量验收）

- 基线 HEAD `472886ee`，main ahead 78。只更新 docs/26、docs/08 与本地忽略交接；保留全部既有 dirty/untracked，无产品代码变更。
- owner 原生 Electron 保存 250000/250001/250002，等页脚干净后 Ctrl+R，三轮 UI 均重载读回成功；后两轮 1272.60/741.72ms。完成后恢复 `enabled=false,daily_tokens=2000000`，owner API GET `/settings` 核实。
- editor 设置页明确 owner-only 且没有保存控件；本地隔离 API GET `/settings` 200、带 CSRF 的 PUT 403，额度未变。四个报表分组真点击均选中/空态正确；轮转 20 样本 20/20，失败 0，click→稳定可访问树 p50/p95=158.38/172.52ms，含自动化读取开销。
- 测试用户无邀请码登录曾落在自己的 owner workspace；已恢复该 workspace 默认额度，再明确用邀请目标 workspace 的身份测试。测试邀请已撤销、editor 已从 owner workspace 移出；测试用户及个人 workspace 保留在隔离 E2E DB。不是产品缺陷。
- 无 AI 调用。全局既有 mock assistant 20 次样本是完成/消息读回流程时延，不代表真实模型质量或人工反馈质量。Web、Go/HC 本批未重跑；无双端产品/API 变更。继续 G7-08 timer/崩溃、G7-03 DOCX 矩阵及其他未完 G7 项；不 push/deploy，G8-02 toast 仍需用户 action-time 授权。

## 2026-11-06 监控 checkpoint 第四十四轮（协作监控智能体 · 批次 6220e1e0 G7-09 用量验收复核）

**基线与新批次**：上轮监控基线 HEAD `472886ee`；本轮确认 1 个新提交（未 push，`git rev-list --count origin/main..main` 实测 79）：`6220e1e0 DEV-QA26: 验收用量设置原生重载与权限`（仅 2 文件 docs/08 +12、docs/26 v2.26 +16，无代码变更）。提交内容与 checkpoint 60 声明一致，`git show --check` 干净。

**核验证据**：G7-09 前轮 reload 超时已查明为等待方式问题（页脚干净后 Ctrl+R 三轮重载读回成功）；docs/26 G7-09 行更新含 editor 无保存控件 + CSRF PUT 403 服务端证据 + 4 报表分组 20 样本（p50/p95=158.38/172.52ms）。测试用户误落自己 workspace 的流程问题已恢复默认额度/撤销邀请/移出 editor，诚实登记"不是产品缺陷"。

**独立检查**：`node scripts/check-e2e-pairs.mjs` 实测通过（Web 123 / 桌面 87 / 36 对）。另完成红线周期核查：`server/internal/app/hc_test.go` 未被任何 DEV-QA26 批次触碰（`git log` 该路径最后修改为早期 DEV-SK3），HC-01～31 红线完整。

**F-02 跟踪**：`desktop/renderer-src/tests/recent-owner.test.mjs` 修复（+18 行）仍完整留在工作树未提交，与 checkpoint 60 声明相符。遗留条件继续开放。

**台账变更与结论**：`docs/AI_MONITOR_FINDINGS.md` 追加 F-02 第四十四轮跟踪记录、第四十四轮跟踪小结；F-05 计数 78→79。无新缺陷条目；G8-02 用户授权阻塞项继续开放；F-07 继续开放。复核结论：通过。

## 2026-11-06 DEV-QA26 checkpoint 第六十一轮（G7-08 实际分钟调度与领取事务进程崩溃）

- 基线 HEAD `6220e1e0`，本批只改 Go 测试工作进程入口/集成用例及 docs/26、docs/08；产品调度逻辑/API/UI/schema 未改。测试使用项目专用 `ops_test` 与本地 mock，测试启动器会重建测试库，不触碰开发/生产库。
- 真实 `RunJobs` 启动轮结束后才将任务设为 due，分钟 ticker 3/3 唯一完成，due→completed 58,957.81/60,022.88/60,046.33ms，p50/p95=60,022.88/60,046.33ms。
- 子进程在真实 `claimAgentRoutineDue` 未提交 INSERT 阶段被 Windows `Process.Kill`；数据库回滚后下轮保留同一 due，唯一 occurrence/run 完成，3/3。工作进程启动→恢复完成 p50/p95=4,404.74/5,527.23ms。30 秒 `pg_sleep` 首轮因 PostgreSQL 后端观察 Windows 客户端断开有延迟而失败，改 2 秒阻塞后重复验证通过，属测试夹具时序。
- 分钟 ticker、强杀恢复、既有 scheduler 多进程与遗留 lease 测试均 `-count=3` 通过；`git diff --check` 通过。全包/HC 本批未重跑；HC/H 未改、跳过或放宽。mock 不证明真实模型质量；未触及真实平台、生产迁移、签名安装升级，不 push/deploy。
- 下一项继续 G7-03 DOCX 资源/结构矩阵与未闭合桌面智能体条目；G8-02 toast action-time 授权边界维持。

## 2026-11-06 监控 checkpoint 第四十五轮（协作监控智能体 · 批次 7c1a626c G7-08 分钟调度/进程崩溃复核）

**基线与新批次**：上轮监控基线 HEAD `6220e1e0`；本轮确认 1 个新提交（未 push，`git rev-list --count origin/main..main` 实测 80）：`7c1a626c DEV-QA26: 验收例行任务分钟调度与进程恢复`（4 文件 370+/2-，`agent_routines_concurrency_test.go` +343、docs/08 +8、docs/26 v2.27）。提交内容与 checkpoint 61 声明一致，`git show --check` 干净，纯 Go 测试 + docs。

**核验证据**：抽查实现真实且严谨：①分钟 ticker 用例真实启动 `RunJobs` 并内置"过早完成即 Fatal"防伪断言（elapsed 检查），实测 due→completed 58.9–60.0s（3/3 唯一完成）；②进程崩溃用例以触发器 `pg_sleep(2)` 阻塞 claim 事务未提交阶段 + Windows `Process.Kill` 真实强杀，断言回滚后下一轮唯一 occurrence/run（3/3）。首轮 pg_sleep 30s 失败诚实定性为 PostgreSQL 后端断开观察延迟的夹具时序。至此 G7-08 本地可执行五项边界（claim 竞态/tick 竞争/lease 恢复/分钟 ticker/进程崩溃）全部闭合。

**独立检查**：`node scripts/check-e2e-pairs.mjs` 实测通过（Web 123 / 桌面 87 / 36 对）。全包/HC 未重跑（纯测试文件新增、定向 `-count=3` 通过，风险可接受）。

**F-02 跟踪**：`desktop/renderer-src/tests/recent-owner.test.mjs` 修复（+18 行）仍完整留在工作树未提交，与 checkpoint 61 声明相符。遗留条件继续开放。

**台账变更与结论**：`docs/AI_MONITOR_FINDINGS.md` 追加 F-02 第四十五轮跟踪记录、第四十五轮跟踪小结；F-05 计数 79→80。无新缺陷条目；G8-02 用户授权阻塞项继续开放；F-07 继续开放。复核结论：通过。


## 2026-11-06 DEV-QA26 checkpoint 第六十二轮（G7-03 双端 DOCX 文件选择器）

- 基线 HEAD 7c1a626c；保留全部既有 dirty/untracked。改动仅双端 agent-documents E2E 与 docs/26、docs/08；本地忽略的 AI_HANDOFF 仅作交接，不提交。
- 真实 Windows Electron 与 Web Chromium filechooser 上传 4 MiB 展开 DOCX，各 3/3 通过。请求 p50/p95：Electron 5,734.64/5,964.47ms，Web 6,094.29/6,299.94ms。双方都核对 ready、页数、截断字段、原件 GET ZIP 签名；删除后 conversation 为空且消息 POST=0。
- Windows 原生 Electron 的 8 MiB 样本在既有 30 秒解析执行期限处返回 422，诊断请求 30,035.94ms；3 次聚焦有 1 次断言捕获 422、2 次 Playwright 默认响应等待超时。Linux 限制容器 8 MiB 成功证据不等于 Windows UI 通过；G7-03/T-AW28 仍部分，无产品逻辑变更。
- 双端 typecheck、pair guard（Web123/桌面87/36 对）及 diff check 通过。未运行 Go/HC；HC-01～31、H-01～09 未改/跳过/放宽。无 docs/22/90 变更，不 push/deploy。
- 下一步优先依据 docs/26 核验桌面 G8 设置页尚未闭合分支，逐项查 models、members、usage、words、trash、export，并核对 Web；不重复既有通过证据。

## 2026-11-06 监控 checkpoint 第四十六轮（协作监控智能体 · 批次 5cf1797a G7-03 DOCX 文件选择器复核）

**基线与新批次**：上轮监控基线 HEAD `7c1a626c`；本轮确认 1 个新提交（未 push，`git rev-list --count origin/main..main` 实测 81）：`5cf1797a DEV-QA26: 验收双端 DOCX 展开文件选择路径`（4 文件 139+/2-，双端 `agent-documents.spec.ts` +60/+45、docs/08 +13、docs/26）。提交内容与 checkpoint 62 声明一致，`git show --check` 干净，纯 E2E + docs。

**核验证据**：抽查断言真实：4 MiB 展开 DOCX 经真实 filechooser 双端 3/3（ready/页数/`truncated_from=20001`/原件 ZIP 签名/删除后 conversation 空且消息 POST=0）。诚实区分关键：Windows Electron 8 MiB 样本命中 30 秒解析执行期限返回 422，主执行智能体明确"Linux 限制容器 8 MiB 成功证据不等于 Windows UI 通过"，G7-03/T-AW28 保持部分检查——未把容器证据冒充 UI 验收；422 为设计期限行为，未作产品缺陷结论，合理。

**独立检查**：`node scripts/check-e2e-pairs.mjs` 实测通过（Web 123 / 桌面 87 / 36 对）。

**F-02 跟踪**：`desktop/renderer-src/tests/recent-owner.test.mjs` 修复（+18 行）仍完整留在工作树未提交，与 checkpoint 62 声明相符。遗留条件继续开放。

**台账变更与结论**：`docs/AI_MONITOR_FINDINGS.md` 追加 F-02 第四十六轮跟踪记录、第四十六轮跟踪小结；F-05 计数 80→81。无新缺陷条目；G8-02 用户授权阻塞项继续开放；F-07 继续开放。复核结论：通过。

## 2026-11-06 DEV-QA26 checkpoint 第六十三轮（G7-09 双端用量统计与上海日期修复）

- 基线 HEAD `5cf1797a`。保留全部既有 dirty/untracked。本批改双端 Usage 日期格式化、双端 g8-settings-gaps E2E、docs/22/26/08；本文件为本地忽略交接记录，不提交。
- 修前真实上海日期 2026-11-06，UTC 日期 2026-11-05；页面请求范围比 API 的 Asia/Shanghai 默认范围早一天。根因为 `toISOString().slice(0,10)`；双端改为 `Intl.DateTimeFormat` 指定 `Asia/Shanghai`。已登记 docs/22 2G-23。
- 双端真实 UI 本地 mock 用量旅程各 3/3。每轮 20 个对话逐条服务端 GET 读回，usage API 共 20 calls、0 failed、token 非零及四分组；按天/任务/模型/账号切换各 20 次。代表轮 n=20 AI p50/p95：Electron 328.67/1664.47ms，Web 488.52/617.17ms；分组点击 p50/p95：Electron 34.79/48.30ms，Web 76.68/144.41ms。mock 不证明真实模型质量或人工反馈质量。
- 定向 Electron/Web Playwright 各 `--repeat-each=3` 通过；`pnpm typecheck` 在 web 与 desktop/renderer-src 通过；pair guard 通过（Web 123 / 桌面 87 / 36 对）；`git diff --check` 通过（只有 CRLF→LF 提示）。无 API/schema/Go 改动；HC/H 不变；不 push/deploy。
- 本批已提交 `80aace8b DEV-QA26: 修复双端用量日期并验收G7-09`；提交前只暂存 7 个本批文件，`recent-owner.test.mjs` 修改及既有所有 untracked 均保留。复核 G8 页面：models、members、words、trash、export 的原生窗口正常/错误/取消/角色/文件读回等既有证据见 docs/26 G7-10、G8-10/11、G2-13/14 与 §§4；usage 补完本轮数据样本。G2-13 仍因 docs/06 “每日”与实现 10 分钟 ticker 的频率差异等待 D-168 决策，不能以测试替代裁决。
- G6-02 桌面发布标记→手动 T+1/T+3/T+7→服务端读回/重载→多时点卡片→实验结案→报告编辑/逐条采纳，已有 3/3 证据；G6-09 双端每轮 20 份报告及 20 次逐项反馈已服务端读回、连续 3/3。真实模型质量仍不在本地 mock 证据范围。G6-03 真实微信 API 与 G6-04 真实模型质量仍未验。
- 下一小项转 G7-03 附件体量/结构边界中尚可在本机验证的样本；其余 G7-01/02/04/05/06/07/13/14/15 已有通过证据，不重复跑。运行恢复/停止及逐张执行/拒绝边界见 G7-01/05/08，G7-08 尚部分。真实模型费用、真实平台、生产迁移、签名安装升级仍未验；不 push/deploy。

## 2026-11-06 DEV-QA26 checkpoint 第六十四轮（G7-03 双端 6 MiB DOCX 解析期限）

- 基线 HEAD `80aace8b`。保留所有既有 dirty/untracked。仅增加双端 `agent-documents.spec.ts` 6 MiB 展开 DOCX filechooser 探针，更新 docs/26 与 docs/08；本地忽略 AI_HANDOFF 不提交。
- Electron/Web 真实入口各连续 3 次：6,472-byte ZIP 声明展开 6,291,456 bytes；服务端每次 30 秒后 422 `agent_attachment_parse_failed`。UI 错误明确，GET conversation 列表为空、发送禁用、消息 POST=0。Electron UI p50/p95=30,115.90/30,139.47ms，Web=30,148.11/30,150.80ms；意外失败 0。6 MiB 结果是稳定预期拒绝，不是样本成功解析。
- 双端 E2E repeat-each=3 各 3 passed；pair guard（Web123/桌面87/36 对）通过；typecheck 和 diff check 待跑。无产品/API/Go 逻辑改动，不运行 HC/Go，无 docs/22 或 docs/90 变更。
- 下一步继续 G7-03 中还可在本地验证的 DOCX 结构组合/更大展开样本；优先走 Electron，并按结果补 Web 对照。G6-02/05/09 已有桌面发布后手录多时点、报告/逐条采纳及 20 次反馈证据；G6-03 真实微信与 G6-04 真实模型质量属外部边界。G2-13 频率仍等待 D-168 裁决。

## 2026-11-06 DEV-QA26 checkpoint 第六十八轮（G7-08/T-AW26 迟到窗口）

- 基线 HEAD `6b08bd85`。保留所有既有 dirty/untracked。新增 `TestAW10RoutineSchedulerLateWindowBoundary`：真实 API 创建 daily routine 后，用隔离库时间夹具分别回拨 29/31 分钟并调用 `runAgentRoutines`；29m 唯一 occurrence 完成、唯一 run；31m `missed/missed_window`、零 run、单事件、通知 `/notifications` 可读，第二次 tick 不重复。
- `cd server; go test -p 1 -count=3 -v -run '^TestAW10RoutineSchedulerLateWindowBoundary$' ./internal/app` 通过，7.121s；旅程耗时 p50/p95=215.56/1366.85ms（n=3，首轮含冷启动）。快速 DB 时间夹具，不是真实等待 30 分钟；离线/繁忙未验。只新增测试，不改产品逻辑；本批不跑完整 Go/HC。
- 尚待本轮更新 docs/08、docs/26 并单任务提交；无 push/deploy。

## 2026-11-06 DEV-QA26 checkpoint 第六十七轮（G7-08 双端例行任务连续失败暂停）

- 基线 HEAD `df7e494`。保留全部既有 dirty/untracked。新增双端真实 UI 旅程：创建例行任务，代理逐次注入模型 HTTP 503；三次独立点击运行均产生 `failed/ai_upstream_error`，failure_count 1/2 启用、3 自动暂停。重载确认三条执行记录/暂停状态/连续失败 3/3，暂停时无立即运行按钮；逐项重新启用后失败计数归零并恢复运行入口。
- Electron/Web 本地 mock 关键旅程分别 `--repeat-each=3` 3/3，意外失败 0；每端 n=9 次故障注入交互，点击至服务端 occurrence=failed 读回 p50/p95：Electron 447.08/476.91ms，Web 566.67/682.35ms。Web 完整指标日志 `.playwright-results/qa26-routine-three-failures-web.log`。不能证明真实模型质量。没有产品/API/schema 改动；双端 typecheck、pair guard 与 diff check 均通过。
- 已提交 `6b08bd85 DEV-QA26: 验收双端例行任务连续失败恢复`（双端测试及 docs/08、docs/26；无 push）。`git show --check` 已核为干净。
- 已知 T-AW26 30 分钟迟到窗口及其他故障/租约分支仍未全部关闭；G7-03/T-AW28 仍部分检查。无 docs/22/90 变化；不 push/deploy。

## 2026-11-06 DEV-QA26 checkpoint 第六十六轮（G7-03 双端 4 MiB × 100 页 × 256 ZIP 条目）

- 基线 HEAD `3f76b9e`。保留全部既有 dirty/untracked。双端样本扩展到 4 MiB document.xml、100 页、256 ZIP 条目三重边界，真实 filechooser 各 3/3 成功；服务端 page_count=100、extracted_chars=4,191,640、20,000 injected、截断正确；原件 GET PK 签名、删除后无会话/消息 POST。
- 上传请求 p50/p95：Electron 5,842.21/5,907.73ms，Web 6,318.62/6,507.04ms。双端 typecheck、pair guard（Web123/桌面87/36 对）、diff check 均通过；无产品/API/Go 改动，不运行 HC/Go，无 docs/22/90 变化。
- 已提交 `df7e494a DEV-QA26: 验收双端4MiB百页256条目DOCX`（仅双端 E2E 与 docs/08、docs/26；无 push）；`git show --check` 干净。
- 下一项仍续 G7-03 剩余本地 DOCX 组合和攻击矩阵。真实模型/真实微信和平台/生产迁移/签名安装升级未验；G2-13 频率仍等待 D-168 裁决；不 push/deploy。

## 2026-11-06 DEV-QA26 checkpoint 第六十五轮（G7-03 双端 4 MiB × 100 页 DOCX 交叉）

- 基线 HEAD `19bb485`。保留既有 dirty/untracked。双端 E2E 增加 4 MiB document.xml × 100 页 filechooser 样本；Electron/Web 各 3/3 成功，服务端 `page_count=100`、extracted chars 4,191,640、20,000 injected、截断边界准确；原件 GET ZIP 签名非空，移除后无会话/消息 POST。
- 上传请求 p50/p95：Electron 5,770.71/5,823.95ms，Web 6,358.62/6,614.27ms（n=3 最近秩）。双端 typecheck、pair guard（Web123/桌面87/36 对）和 diff check 均通过。无产品/API/Go 逻辑改动；无 docs/22 或 docs/90 变更；不 push/deploy。
- 该交叉样本通过，但 G7-03 还有更大展开成功样本和其它结构组合。下一项继续一个本地可复现的 DOCX 边界样本，测试后评估是否需要额外产品修复。

## 2026-11-06 监控 checkpoint 第四十七轮（协作监控智能体 · 批次 80aace8b 2G-23 复核 + F-08 同族缺陷上报）

**基线与新批次**：上轮监控基线 HEAD `5cf1797a`；本轮确认 1 个新提交（未 push，`git rev-list --count origin/main..main` 实测 82）：`80aace8b DEV-QA26: 修复双端用量日期并验收G7-09`（7 文件 209+/4-，双端 `Usage.tsx` 各 6 行 + 双端 g8 E2E +92/+78 + docs/22 + docs/26 + docs/08）。提交内容与 checkpoint 63 声明一致，`git show --check` 干净。

**核验证据**：2G-23（S2·已修）docs/22 登记含修前实测对照（页面 `2026-10-07..2026-11-05` vs API `2026-10-08..2026-11-06`）、根因（`toISOString()` UTC）与修复（`Intl.DateTimeFormat` + `Asia/Shanghai`）；双端修复同构（`day` 函数替换），验证含修后 20 次对话进入四分组报表、双端各 3/3。S2 定级合理（当天调用误显空报表）。

**新发现 F-08（S3·待确认）**：监控方在同族模式排查中发现双端 `standards-tab.tsx:43` 以 UTC 日期查询 `/standards/effective`，而后端 `ops_standard.go:227-248` 按 `Asia/Shanghai` 口径比较 `effective_from<=at::date`（响应显式 `"timezone": "Asia/Shanghai"`）。上海时区每天 00:00–08:00 窗口内前端查到截至昨天的生效标准版本，与 2G-23 同根因；UI 有 standard_changed 提示兜底故建议 S3。另双端 `Pack.tsx:136`/`ToutiaoPack.tsx:153/155` 的 `toISOString().slice(0,10)` 仅用于下载文件名、无业务边界，可顺手统一或接受。详见台账 F-08。

**给主执行智能体的协调请求**：F-08 修复方式与 2G-23 完全同构（双端 `standards-tab.tsx` 各 1 行），建议在后续批次按 2G-23 模式登记 docs/22 并修复；当前无工作树冲突（tracked 除 F-02 外干净）。

**独立检查**：`node scripts/check-e2e-pairs.mjs` 实测通过（Web 123 / 桌面 87 / 36 对）。台账已新增 F-08；F-02/F-05（81→82）已同步。复核结论：2G-23 修复批次通过。

## 2026-11-06 监控 checkpoint 第四十八轮（协作监控智能体 · 批次 19bb485e + 3f76b9ee G7-03 矩阵复核）

**基线与新批次**：上轮监控基线 HEAD `80aace8b`；本轮确认 2 个新提交（未 push，`git rev-list --count origin/main..main` 实测 84）：①`19bb485e 验收双端6MiB附件解析时限`（4 文件 126+/2-，checkpoint 64）；②`3f76b9ee 验收双端4MiB百页DOCX组合`（4 文件 132+/2-，checkpoint 65）。两批均与 checkpoint 声明一致，`git show --check` 干净，纯 E2E + docs。

**核验证据**：①6 MiB 展开 DOCX 在双端真实入口 30 秒后稳定 422（UI 错误可见、conversation 空、消息 POST=0、双端 3/3 意外失败 0），诚实定性为"稳定预期拒绝"而非成功样本；cp64 写作时点 typecheck/diff check"待跑"为诚实状态，cp65 确认通过。②4 MiB×100 页交叉样本双端 3/3 成功（`page_count=100`、extracted 4,191,640、截断边界准确、原件 ZIP 签名、移除后零 POST）。

**F-08 状态**：尚无主执行智能体响应，继续开放（台账待确认）。

**台账变更与结论**：`docs/AI_MONITOR_FINDINGS.md` 追加 F-02 第四十八轮跟踪、第四十八轮小结；F-05 计数 82→84。复核结论：两批均通过，无新缺陷。

## 2026-11-06 监控 checkpoint 第四十九轮（协作监控智能体 · 批次 df7e494a G7-03 三重边界复核）

**基线与新批次**：上轮监控基线 HEAD `3f76b9ee`；本轮确认 1 个新提交（未 push，`git rev-list --count origin/main..main` 实测 85）：`df7e494a DEV-QA26: 验收双端4MiB百页256条目DOCX`（4 文件 52+/20-，checkpoint 66）。提交内容与 checkpoint 66 声明一致；cp66 写作时点 `git show --check` "待核"，监控方实测 OK（补齐待核项）。纯 E2E + docs。

**核验证据**：三重边界组合（4 MiB document.xml × 100 页 × 256 ZIP 条目）双端 3/3 成功（page_count=100、extracted_chars=4,191,640、20,000 injected、截断正确、原件 PK 签名、删除后零会话/消息 POST）。

**F-08 状态**：仍无主执行智能体响应，继续开放（台账待确认）。

**台账变更与结论**：`docs/AI_MONITOR_FINDINGS.md` 追加 F-02 第四十九轮跟踪、第四十九轮小结；F-05 计数 84→85。复核结论：通过，无新缺陷。

## 2026-11-06 监控 checkpoint 第五十轮（协作监控智能体 · 批次 6b08bd85 G7-08 失败路径复核）

**基线与新批次**：上轮监控基线 HEAD `df7e494a`；本轮确认 1 个新提交（未 push，`git rev-list --count origin/main..main` 实测 86）：`6b08bd85 DEV-QA26: 验收双端例行任务连续失败恢复`（4 文件 266+/4-，checkpoint 67）。提交内容与 checkpoint 67 声明一致，`git show --check` 干净（cp67 亦声明已核），纯 E2E + docs。

**核验证据**：抽查断言链完整：3 次代理注入模型 503 → 逐次 `failed/ai_upstream_error` + `failure_count` 1/2 累积启用、第 3 次转 `paused` → 暂停时无立即运行按钮 → 逐项重新启用后 `{status:'enabled', failure_count:0, error_code:''}` 服务端读回。G7-08 失败路径验收完成；T-AW26 30 分钟迟到窗口等剩余分支诚实保留。

**F-08 状态**：仍无主执行智能体响应，继续开放（台账待确认）。

**独立检查**：`node scripts/check-e2e-pairs.mjs` 实测通过（Web 123 / 桌面 87 / 36 对）。台账 F-02 第五十轮跟踪、第五十轮小结已记录；F-05 计数 85→86。复核结论：通过，无新缺陷。

## 2026-11-06 DEV-QA26 checkpoint 68 delivery

- 提交 `086760bd DEV-QA26: 验收例行任务迟到窗口边界` 已通过 `git show --check`。目标 Go 测试最终 `-count=3` 通过（7.121s）；迟到旅程 n=3 p50/p95=215.56/1366.85ms。
- 已更新并提交 docs/08 与 docs/26；测试仅追加 `TestAW10RoutineSchedulerLateWindowBoundary`，无产品代码修改。29 分钟完成唯一 run；31 分钟 missed、无 run、有单事件和通知，重复 tick 不补跑。
- 工作树原有 desktop recent-owner 改动、qa26 脚本/配置/临时目录与 web 审计脚本全部保留；无 push/deploy。G7-03/T-AW28 继续部分检查，下一批继续桌面可执行附件结构矩阵并同步 Web 对应状态。

## 2026-11-06 监控 checkpoint 第五十一轮（协作监控智能体 · 批次 086760bd T-AW26 迟到窗口复核）

**基线与新批次**：上轮监控基线 HEAD `6b08bd85`；本轮确认 1 个新提交（未 push，`git rev-list --count origin/main..main` 实测 87）：`086760bd DEV-QA26: 验收例行任务迟到窗口边界`（3 文件 137+/4-，`agent_routines_test.go` +115，checkpoint 68）。提交内容与 checkpoint 68 delivery 声明一致，`git show --check` 干净，纯 Go 测试 + docs。

**核验证据**：抽查实现真实：`TestAW10RoutineSchedulerLateWindowBoundary` 用隔离库时间夹具回拨 29/31 分钟调用真实 `runAgentRoutines`——29 分钟窗口内唯一 occurrence/run 完成；31 分钟 `missed/missed_window`、零 run、单事件、通知可读、第二次 tick 不重复。定向 `-count=3` 通过（7.121s）。闭合 cp67 登记的 T-AW26 迟到窗口边界；诚实声明快速时间夹具非真实等待、离线/繁忙未验。

**F-08 状态**：仍无主执行智能体响应，继续开放（台账待确认）。

**独立检查**：`node scripts/check-e2e-pairs.mjs` 实测通过（Web 123 / 桌面 87 / 36 对）。台账 F-02 第五十一轮跟踪、第五十一轮小结已记录；F-05 计数 86→87。复核结论：通过，无新缺陷。

## 2026-11-06 DEV-QA26 checkpoint 69 delivery

- 提交 `3358816 DEV-QA26: 验收DOCX疑似密钥隔离` 已通过 `git show --check`。更新双端 `agent-documents.spec.ts`、docs/08 与 docs/26；AI_HANDOFF 为本地忽略文件。
- Windows 原生 Electron 和 Web Chromium 的 DOCX 含合成疑似密钥上传旅程各 3/3：解析回执 `quarantined/suspected_secret`、`injected_chars=0`、url 空；UI 阻止发送，原件 GET=404，零会话/消息 POST，用户删除返回 200。p50/p95 上传交互 Electron 2578.61/2704.86ms，Web 2392.68/2902.59ms。
- 双端 `pnpm typecheck`、E2E 配对守卫（Web123/桌面87/36 对）和 `git diff --check` 通过。初次错选 Playwright project 发现 0 用例，改用 shared-scenarios project 后真实 Electron 测试通过；不构成产品失败。全部预存 dirty/untracked 保留，不 push/deploy。G7-03/T-AW28 仍部分，继续检查 G7 可执行边界。

## 2026-11-06 DEV-QA26 checkpoint 70 handoff

- 本批承接 HEAD `3358816 DEV-QA26: 验收DOCX疑似密钥隔离`。发现 `releaseAgentRoutineLease` SQL 的 occurrence/routine 参数顺序反了，忙碌/并发满时 UPDATE 影响 0 行；已在 `agent_routines.go` 交换实参，并新增 `TestAW10RoutineSchedulerWaitsForBusyCapacityThenRunsOnce`。
- 对话繁忙、用户并发满各连续 3/3：首次 tick 持久化 `pending`、0 failure_count、无 run；释放容量后同一 occurrence 仅产生 1 个 completed run。p50/p95 分别 130.80/148.93ms、140.66/144.96ms。该 scheduler 没有用户可点击的单次 tick 入口，本批是 owner API + 实际 scheduler 的 Go/PostgreSQL 集成，不宣称 Electron 点击证据。
- 全量 app 首轮被 cp68 固定 09:00 的日程夹具误判：第二 tick 在 09:00 后合法进入下一周期。夹具现设下一日程为当前时间后 2 小时，并检查同一 due。组合定向测试 `-count=3` 通过，迟到边界 p50/p95=130.66/1335.27ms。完整 `go test -p 1 -count=1 ./internal/app` 通过，409.585s，含 HC-01～31；HC-01～31/H-01～09 未修改、跳过或放宽。
- 已更新 docs/22 AG-13、docs/26 v2.36、docs/08 checkpoint 70，并提交 `c888772 DEV-QA26: 修复例行任务繁忙租约释放`；`git show --check` 通过（5 个文件）。`AI_HANDOFF.md` 是本地 ignored 交接文件。所有预存桌面 dirty/untracked 与 Web 审计脚本仍保留；不 push/deploy。
- 下一项按 DEV-QA26 顺序继续未闭合桌面/G7 与 G6 可执行项；避免重复已通过证据。真实模型质量/费用、生产平台写入、生产迁移、签名安装升级仍未验。

## 2026-11-06 DEV-QA26 checkpoint 71 handoff

- 承接 HEAD `c888772c`。桌面/Web 新增 5MiB DOCX 文件选择旅程，Windows 原生 Electron 连续 3/3 解析 ready、原件 GET=200、逐项 DELETE=200；没有会话或消息写入。E2E 上传回执 p50/p95=6867.51/6962.30ms。
- Web 最终 3 轮中 2 次 ready、1 次约 30 秒返回解析失败；页面正确禁用发送，空会话列表且 0 消息 POST。超时点击→回执 30,157.47ms，API 日志 30,022.76ms。先前同样本 3/3 成功，故这是波动证据，不宣称根因。
- Windows 隔离 parser worker 直测 3/3 成功，p50/p95=6325.21/6555.59ms；`go test -p 1 -count=1 ./internal/documentparse` 通过（59.959s）。双端目标 E2E、typecheck 与 E2E 配对守卫通过（Web123/桌面87/36 对）。未改生产逻辑；HC-01～31、H-01～09 未改、跳过或放宽。
- docs/26 v2.37 与 docs/08 checkpoint 71 已记；保留所有既有 dirty/untracked 和本地 `.playwright-results` 日志。G7-03/T-AW28 仍部分检查；解析器 30 秒/256MiB 边界未改，真实模型质量/真实平台/生产库/签名升级未验；不 push/deploy。
- 本批已提交 `c83aef65 DEV-QA26: 验收5MiB DOCX解析边界`，`git show --check` 通过；未 push。现有 dirty/untracked 与本地 `.playwright-results` 产物继续保留。

## 2026-11-06 DEV-QA26 checkpoint 72 handoff

- 承接 HEAD `c83aef65`。双端 `agent-documents.spec.ts` 增加 5MiB × 100页 × 256 ZIP 条目 DOCX 的真实文件选择旅程，Windows 原生 Electron / Web Chromium 各 3/3 ready；服务端回执页数、提取与注入/截断值准确，原件 GET=200/PK，逐项删除 DELETE=200，无会话或消息 POST。
- n=3 上传 POST p50/p95：Electron 8297.12/12026.30ms，Web 8208.34/8968.70ms。样本展开 XML 5,242,880 字节，压缩 DOCX 37,791 字节。仅本地 E2E API/WASI parser 流程证据，不代表真实模型质量。
- 桌面/Web 用例各 `--repeat-each=3` 均通过；双端 typecheck、E2E pair guard（Web123/桌面87/36 对）和 `git diff --check` 均通过。无生产/API/数据库改动；HC-01～31/H-01～09 未修改、跳过或放宽，未运行 Go/HC。
- docs/26 v2.38 与 docs/08 checkpoint 72 已更新；G7-03/T-AW28 仍部分检查，新增交叉样本不外推其它结构或 deadline 边界。全部预存 dirty/untracked 与 Playwright 结果保留；准备单任务提交，不 push/deploy。

## 2026-11-06 DEV-QA26 checkpoint 73 handoff

- 承接 HEAD `7ee7231c`。双端新增 5.5MiB × 100页 × 256 ZIP 项 filechooser 探针；Electron/Web 各 3/3 安全 422、错误可见、发送禁用、无会话或消息 POST。Web 都在约 30 秒返回；Electron 两轮约 30 秒，一轮约 7.5 秒。
- 同类 Go Windows `Parse` 临时诊断 3 次为两次 30 秒 deadline、一轮 7.4 秒 ready；额外一次直测报告 Wazero `VirtualAlloc(59,482,112 bytes)` errno 1455 / OOM（6.73 秒）。不能把它和某轮 UI 快失败逐请求对应，worker 内部错误被 API 统一映射。临时测试文件已删除；没有改生产逻辑或 30秒/256MiB 限制。
- E2E、双端 typecheck、pair guard 与 `git diff --check` 通过。docs/26 v2.39、docs/08 checkpoint 73 已更新。G7-03/T-AW28 仍部分，需低并发/隔离环境再量化；保留所有原有 dirty/untracked，不 push/deploy。

## 2026-11-06 DEV-QA26 checkpoint 74 handoff

- 承接 HEAD `d04138f4`。对已提交的 5.5MiB × 100页 × 256 ZIP 项 Electron 与 Web filechooser 用例分端串行重复 3 次。Electron 3/3 都约 30 秒 422；Web 1/3 ready、2/3 deadline 422。Electron click→响应 p50/p95 30121.09/30167.75ms；Web 30138.96/30179.90ms。Web 成功轮原件 GET/删除均成功，失败轮无会话/消息写入。
- 串行复验没有把结果稳定成全失败：它排除了另一端 E2E 并行作为唯一原因，但 5.5MiB 仍有运行时波动。UI 安全失败路径稳定；不改 30秒/256MiB 约束，不声称解析成功 3/3，也不把 worker OOM 与单个 UI 请求强行关联。
- docs/26 v2.40、docs/08 checkpoint 74 已更新。Playwright 串行捕获日志留在 `.playwright-results/`。本轮无代码/HC 更改，无 push/deploy；G7-03/T-AW28 仍部分检查。


## 2026-11-06 DEV-QA26 checkpoint 75 handoff

- 用户已选择 D-168 A：保留回收站 RunJobs 启动轮与每 10 分钟 ticker 检查。`docs/06` §4.2/§5.7 已同步，D-168 已确认，G2-13 频率差异关闭；30 天删除契约和生产代码不变。
- 复用既有隔离周期 ticker 3/3、启动清理、30 天边界和图片目录删除证据；本批是文档决策对齐，无需重跑代码测试。docs/08 cp75、docs/26 v2.41 已记。

## 2026-11-06 DEV-QA26 checkpoint 76 handoff

- G7-08/T-AW26 新增停机到期后 RunJobs 启动轮恢复测试：数据库时间夹具模拟 due 迟到 29 分钟，启动轮恢复同一 due，唯一 occurrence/run 完成 3/3；p50/p95 175.37/2300.73ms。没有真实等待 29 分钟或修改生产逻辑。
- late-window 与 busy-capacity 相关回归两项各 3 轮通过；离线×繁忙组合仍开。docs/08 cp76、docs/26 已追加，HC/H 未动；不 push/deploy。

## 2026-11-06 DEV-QA26 checkpoint 77 handoff

- 按顺序核对 G8 settings 与指定 G6 桌面复盘旅程：models/members/usage/words/trash/export 的本地点击、权限、错误/取消/保存重载及服务端读回证据已在 docs/26；members 外部 SMTP/真实收件箱与 G8-02 原生通知 action-time 授权仍未验。G6 发布后回填、多时点、看板、报告编辑与逐条采纳桌面关键旅程已有 3/3 服务端持久化证据，本轮不重复。
- G7-03/T-AW28 在双端 `agent-documents.spec.ts` 新增 394-byte DOCX 中心目录 CRC 损坏旅程；Windows 原生 Electron 与 Web 各 3/3 HTTP 422，错误提示可见、发送禁用、会话/消息写入为 0。Electron click→response p50/p95=2161.61/2171.70ms，Web=2071.64/2078.22ms。双端 typecheck、pair guard、diff check 通过。
- docs/26 v2.42 与 docs/08 checkpoint 77 已更新。T-AW28 继续部分检查；下步优先补 T-AW26 离线×繁忙恢复组合，再继续 DOCX ZIP/XML 剩余攻击结构与资源矩阵。保留所有既有 dirty/untracked；HC/H 未动；不 push/deploy。

## 2026-11-06 DEV-QA26 checkpoint 78 handoff

- G7-08/T-AW26 离线×繁忙组合新增 `TestAW10RoutineRunJobsStartupBusyCapacityRecoversSameOccurrence`：29 分钟旧 due、两条活动 run 达用户上限；真实 `RunJobs` 启动轮结束后同一 due 唯一 occurrence `pending`/无失败/无 run，释放容量后原 occurrence 与唯一 run 完成，额外扫描不重跑。连续 3/3 通过，n=3 p50/p95=205.47/409.61ms。
- 同命令相关 offline-startup、29/31 分钟窗口和既有 target-dialog-busy/user-concurrency-full 回归各 3 轮通过。首轮 fixture 类型编译错误已修正，最终四项 `-count=3` 全通过（10.274s）；不等真实 29 分钟或一分钟 tick。
- docs/26 v2.43、docs/08 checkpoint 78 已更新；T-AW26 仍部分检查，未改生产逻辑/API/UI；HC/H 未动；保留其它工作树修改，不 push/deploy。

## 2026-11-06 DEV-QA26 checkpoint 79 handoff

- 用户确认 D-168 选项 A：回收站每 10 分钟检查并同步 docs/06；docs/90 决议已确认，已由提交 `9cafd218` 落地，本轮未重复修改。
- G7-03/T-AW28 发现 DOCX OPC ASCII 大小写冲突部件名可歧义解析：修复前 WASI 返回第二个 part 正文，真实 Electron 上传得到 200。按 ECMA-376 Part 2 §7.2.3.5 修复解析器：跳过目录项、`path.Clean` 后 ASCII 小写唯一性检查，冲突返回 `docx_invalid`；已重建 parser.wasm 与源码摘要。
- 修复后双端真实文件选择器各 3/3 HTTP 422、错误可见、发送禁用、conversation/message 写入 0。Electron p50/p95=2355.66/3496.14ms；Web=2177.56/2412.16ms。WASI targeted 3/3、完整 documentparse 60.799s、双端 typecheck 与 pair guard（Web123/桌面87/36 对）通过。
- docs/26 v2.44、docs/08 checkpoint 79 已更新。本批提交 `4180783 DEV-QA26: 拒绝DOCX大小写冲突部件`，提交复核通过、未 push。T-AW28 仍部分检查（其余 ZIP/XML 结构、资源矩阵、静态扫描与 Windows 大文件时延波动）；`@oai/sky` 桌面管道缺失，项目 Playwright runner 驱动真实 Electron 验收。HC/H 未动；保留全部既有 dirty/untracked 与测试日志。

## 2026-11-06 DEV-QA26 checkpoint 80 handoff

- G7-03/T-AW28 发现 `word/./document.xml` 被 parser 的 `path.Clean` 折叠后接受。修复前 WASI 返回“点段路径”正文、真实 Electron filechooser HTTP 200。ECMA-376 Part 2 §9.1.1 M1.10 要求路径段包含至少一个非点字符；现对被 `path.Clean` 改写的 ZIP 文件名拒绝，已重建 parser.wasm/源码摘要。
- 修复后桌面 Electron 与 Web filechooser 各 3/3 HTTP 422、UI 错误可见、发送禁用、conversation/message 写入 0；Electron p50/p95=2332.78/2671.62ms，Web=2182.66/2416.20ms。WASI targeted 3/3、完整 documentparse 66.704s、双端 typecheck 与 pair guard（Web123/桌面87/36 对）通过。
- docs/26 v2.45、docs/08 checkpoint 80 已更新；本批提交 `d10d24e DEV-QA26: 拒绝DOCX非规范点段路径`，复核通过、未 push。T-AW28 仍部分检查（其它 OPC/ZIP/XML 结构、资源矩阵、静态扫描、Windows 大文档延时波动）。`@oai/sky` 管道缺失，Playwright runner 驱动真实 Electron；HC/H 未动；保留全部 dirty/untracked，不 push/deploy。

## 2026-11-06 DEV-QA26 checkpoint 81 handoff

- G7-03/T-AW28 新增 DOCX ZIP general-purpose bit 0 拒绝验收；394-byte fixture 只设置 central/local header 加密位，payload 未加密，明确不代表密码加密文件测试。WASI targeted 3/3 返回 `docx_encrypted`，完整 documentparse 63.618s 通过。
- Windows 原生 Electron 与 Web Chromium 真实 filechooser 各 3/3 HTTP 422，错误可见、发送禁用、conversation/message 写入为 0。Electron p50/p95=2204.88/2253.34ms，Web=2101.77/2121.35ms；双端 typecheck 与配对守卫（Web123/桌面87/36 对）通过。
- docs/26 v2.46、docs/08 checkpoint 81 已更新；本批仅 Go 回归测试、双端 E2E 与文档，无产品代码变化。T-AW28 仍部分检查。已提交 `12f26f8 DEV-QA26: 验收DOCX ZIP加密标志拒绝`，复核通过、未 push/deploy；HC/H 未动，原有 dirty/untracked 保留。
## 2026-11-06 DEV-QA26 checkpoint 82 handoff

- G7-03/T-AW28 新增手工最小 OPC 结构 DOCX 成功样本及根关系外链拒绝样本（1,678/1,843 bytes），不是 Microsoft Word 程序生成的真实文件。WASI targeted 3/3，完整 documentparse 73.715s 通过。
- Electron 与 Web 真窗口/Chromium filechooser 各 3/3：有效文件 200/ready、原件 byte-for-byte GET 200、UI DELETE 200、no-store/bust-cache 服务端 GET 404；根外链 422、发送禁用、conversation/message 0。Electron valid p50/p95=2162.13/2208.70ms、external=1947.24/1971.74ms；Web valid=2167.86/2202.01ms、external=2238.36/2826.00ms。
- 首轮 Electron 删除后 GET 重用缓存 URL，服务日志确认没有第二个 GET；测试加 query cache-buster 与 `cache:no-store` 后原三轮通过，属于测试修正，没有产品缺陷。双端 typecheck、配对守卫（Web123/桌面87/36 对）通过。
- docs/26 v2.47、docs/08 checkpoint 82 已更新；无产品代码变更。T-AW28 仍部分检查。已提交 `8c8681a DEV-QA26: 验收最小OPC文档与根关系外链`，复核通过、未 push/deploy；HC/H 未动，原有 dirty/untracked 保留。

## 2026-11-06 DEV-QA26 checkpoint 83 handoff

- G7-07/T-AW22 真实 Electron 复现目标预算绕过：`run_budget=1` 首次运行后服务端为 `budget_limited/used_runs=1`，同对话新消息仍 HTTP 202 并创建未关联 run。`agentStartRunTx` 现将 `budget_limited` 纳入校验并返回 429；提高预算仍须显式点击恢复，拒绝时没有新增消息/run。
- Go 新增隔离集成测试 3/3；预算累计/空转阻断/权限回归通过。Windows Electron 与 Web Chromium UI 关键旅程各 3/3，含预算触顶拒绝、恢复拒绝、调高预算和再次触顶的服务端读回。旅程耗时 p50/p95：Electron 1995/2968ms，Web 3884/3892ms。双端 typecheck、E2E pair guard（123/87/36 对）、diff check 通过。mock 不证明真实模型质量。
- docs/22 新增 AG-14，docs/26 v2.48 与 docs/08 checkpoint 83 更新。T-AW22 仍部分：真实模型目标质量、跨设备预算竞争、长期重开恢复未验。提交 `fd02e848 DEV-QA26: 修复目标预算触顶后新消息绕过`。未 push/deploy；HC/H 未动；原有 `recent-owner.test.mjs` 修改与全部未跟踪文件仍未提交。
- D-168 已按用户 A 选择保留每 10 分钟检查并同步 docs/06，先前提交已记录；本批未重做 G8 设置或 G6 复盘已完成点击路径。下一步继续 G7-03/T-AW28 未闭合的 OPC/ZIP/XML 结构、成功解析资源矩阵和 Windows 大文档时延边界；保留生产模型/平台/部署禁区。

## 2026-11-06 DEV-QA26 checkpoint 84 handoff

- 承接 HEAD `fd02e848`。G7-03 修复 DOCX 缺 `[Content_Types].xml`、`_rels/.rels`、根 `officeDocument` 关系或主文档 Content Type 仍被 parser 接受的问题；修前 Go/WASI 四类诊断均成功抽文，修后返回 `docx_invalid`。生成 `parser.wasm` 与源码摘要已更新。
- 修后最小 OPC 有效件、外链与四种缺结构真实 UI 文件选择旅程，Windows 原生 Electron/Web 各 3/3；有效件原件 GET/删除读回完成，拒绝件 422、发送禁用、无 conversation/message 写入。完整 documentparse 76.972s、双端 typecheck、pair guard（123/87/36 对）通过。
- 4 MiB×100页×256 ZIP 项 fresh regression：Electron 3/3 ready，上传 p50/p95=5790.38/6982.11ms；Web 2/3 ready，1/3 在服务端 30,083ms 后 422 `agent_attachment_parse_failed`，失败 UI 安全阻断，无会话/消息写入。未定位更深 worker 原因，不算全通过、不改限额；详见 docs/08 cp84 与 docs/26。
- docs/22 新增 AG-15、docs/22 v0.67、docs/26 v2.49。T-AW28 仍部分；HC/H 未动，本批未跑 app/HC。原始 dirty/untracked 保留，不 push/deploy。后续继续其它可执行 G7-03 解析边界，再回到用户优先顺序 G8/G6/G7 未闭合项目。
- 本批提交 `22398cceec98f6df7675019ab85c9666184f8a16 DEV-QA26: 拒绝缺少OPC主结构的DOCX`，`git show --check` 通过；提交 9 个任务文件，不含预存 `recent-owner.test.mjs` 修改及其它未跟踪文件。当前不 push。

## 2026-11-06 DEV-QA26 checkpoint 85 handoff

- 承接 HEAD `22398cce`。发现 DOCX Content Types 同时有 `.xml` Default=Wordprocessing main 与 `/word/document.xml` Override=`application/xml` 时 parser 错按任一映射通过；修前 Go/WASI 提取了正文，Electron 和 Web 真实 filechooser 均返回 200（应 422）。
- `hasWordDocumentContentType` 现优先解析部件 Override，无 Override 才回退 Default，并拒绝重复目标 Override/重复 XML Default。WASI targeted 组合 `-count=3` 与完整 `documentparse`（87.174s）通过；双端真实 OPC filechooser 旅程各 `--repeat-each=3` 通过，有效件 GET 字节核对/逐项删除完成，外链和五类不完整/冲突类型各 422，无会话/消息写入。冲突拒绝 p50/p95 Electron 2178.67/2320.06ms、Web 2159.02/2348.20ms。
- 双端 typecheck、pair guard（123/87/36 对）、diff check 通过。docs/22 新增 AG-16/v0.68，docs/26 v2.50、docs/08 cp85 更新。4 MiB Web 资源 deadline 保持上一批部分样本结果，本批未重跑。未跑 app/HC；T-AW28 仍部分，不 push/deploy。
- 本批提交 `e27d7f6`（`DEV-QA26: 按OPC覆盖优先级校验DOCX类型`）；提交复核通过，未 push。提交只含当前任务 9 个文件，不含预存 `desktop/renderer-src/tests/recent-owner.test.mjs` 修改及全部预存未跟踪项，均保留在工作树。

## 2026-11-06 DEV-QA26 checkpoint 86 handoff

- 承接 HEAD `e27d7f6e`。发现 OPC 外层有效但主文档 XML 使用外来命名空间、错误根元素 `w:body`、或缺少根下直接 `body` 时，修前 Go/WASI 都抽出文本，Electron/Web 真实 filechooser 均返回 200。
- parser 现接受 Transitional/Strict WordprocessingML 主命名空间，要求 `document` 根及唯一直接 `body`，抽取也限定在该命名空间；Go 新增三类拒绝与 Strict 正例，WASM/source hash 已重建。目标 Go/WASI 组合 `-count=3`（95.741s）、完整 documentparse（109.977s）通过；真实 Electron/Web filechooser 各 3/3，错误件 422、发送禁用、无会话/消息写入；有效件原文 GET 字节一致、删除后 GET=404。
- 新样本拒绝 p50/p95 ms：Electron 外来命名空间 1959.81/2361.53、错误根 2100.78/2193.78、缺 body 1922.71/2120.95；Web 分别 2228.63/2947.86、2432.82/3023.82、2440.34/3290.56。桌面/Web typecheck、pair guard（123/87/36 对）、diff check 通过。docs/22 新增 AG-17/v0.69、docs/26 v2.51、docs/08 cp86 更新。
- 4 MiB×100页×256 ZIP 项 Web 30 秒 deadline 波动仍未闭合，本轮未重跑、不改限额；T-AW28 继续部分检查。HC/H 未动，本批未跑 app/HC。本批提交 `c71c670241e56f3061c918a2d00597d3a00079aa DEV-QA26: 校验DOCX主文档XML结构`，仅含本任务 9 个文件；预存 recent-owner 修改和全部未跟踪项保留。未 push/deploy。
- 下一步继续 G7-03/T-AW28 其它 OPC/ZIP/XML 结构及解析资源边界，再按既定优先级回到 G8/G6/G7 未闭合验收；不要把本地 mock 证据扩展成真实模型质量结论。

## 2026-11-06 DEV-QA26 checkpoint 87 handoff

- 承接 HEAD `c71c6702`。新增 OPC 元数据外来命名空间诊断：修前 Go/WASI 对 foreign `Relationship` 和 foreign `Override` 都接受并抽出正文；真实 Electron/Web filechooser 也复现 foreign Relationship 返回 200。验证依据为 ECMA-376 Part 2 的 Relationships/Content Types 元素命名空间要求。
- 修复两个验证器只按子元素 Local 名匹配的问题：`hasPackageMainDocumentRelationship` 与 `hasWordDocumentContentType` 现在也校验子元素命名空间。目标 Go/WASI三项（含新 defect 与既有有效/不完整包）`-count=3` 59.330s、完整 documentparse 135.246s 通过；双端真实文件选择器各 3/3，外来 Relationship/Override 均 422，发送禁用且无 conversation/message 写入；有效 OPC 200/ready、GET 字节一致、删除后 404。
- 新样本拒绝 p50/p95 ms：Electron Relationship 2548.12/2608.13、Override 2387.04/2515.59；Web Relationship 2519.42/2519.95、Override 2530.48/2611.25。metric 日志在 `.playwright-results/qa26-g7-opc-metadata-ns-{electron,web}-metrics-20261106.log`。双端 typecheck、pair guard（123/87/36 对）、diff check 均通过。docs/22 新增 AG-18/v0.70，docs/26 v2.52，docs/08 cp87 已更新。
- T-AW28/G7-03 仍部分检查（其它 OPC/ZIP/XML、资源矩阵、静态扫描、Windows 大文档时延）；4 MiB Web 30 秒 deadline 未定位/未重跑/未改限额。HC/H 未动，本轮未跑 app/HC。提交 `ec36ecfc0265910a372d8393db04112b01593d29 DEV-QA26: 校验OPC元数据命名空间`，仅本任务 9 文件，`git show --check` 通过，未 push/deploy；预存 `recent-owner.test.mjs` 修改与未跟踪文件保留。
- 下一步继续未闭合的 G7-03 OPC/ZIP/XML 攻击结构和解析资源边界，之后继续按用户顺序核验 G8/G6/G7 剩余项目。

## 2026-11-06 DEV-QA26 checkpoint 88 handoff

- 承接 HEAD `ec36ecfc`。修前 Go/WASI 接受根 Relationships 中缺失 `Id` 和两个关系共用 `rId1` 的 DOCX；Windows Electron/Web 真实 filechooser 对缺 Id 样本也复现 HTTP 200，错误接受的附件在断言前经 API DELETE 清理。
- `hasPackageMainDocumentRelationship` 现要求 OPC Relationships 命名空间下的每个直接 Relationship 有非空且唯一 Id。Go targeted 3 项 `-count=3` 58.481s、完整 documentparse 133.625s 通过；双端真实 filechooser 各 3/3，缺失/重复 Id 均 422，发送禁用且无会话/消息写入；有效件 200/ready、GET 字节一致、删除后 404。范围是必填/唯一，不是完整 `xsd:ID` lexical 验证。
- 新样本拒绝 p50/p95 ms：Electron 缺失 Id 2503.59/2718.24、重复 Id 2557.69/2589.97；Web 缺失 Id 2699.59/2770.40、重复 Id 2646.09/2773.09。metric logs 保存于 `.playwright-results/qa26-g7-opc-relationship-id-{electron,web}-metrics-20261106.log`。双端 typecheck、pair guard（123/87/36 对）、diff check 均通过。docs/22 新增 AG-19/v0.71、docs/26 v2.53、docs/08 cp88 已更新。
- 4 MiB×100页×256 ZIP 项 Web 30 秒 deadline 尚未定位，本批未重跑或改限额。T-AW28/G7-03 仍有其它 OPC/ZIP/XML、资源矩阵、静态扫描与 Windows 大文档延时待验；HC/H 未动，本轮未跑 app/HC。不 push/deploy。提交 `1391e6558e0a11f5dcd67d78eb86a13f2d48ef42 DEV-QA26: 校验OPC关系Id唯一性`，仅本任务 9 文件，复核通过；预存 recent-owner 修改与未跟踪项仍保留。
- 下一步继续 G7-03 未闭合的 DOCX OPC/ZIP/XML 与资源矩阵，再回到 G8/G6/G7 剩余验收，保留真实模型/平台/生产禁区。

## 2026-11-06 DEV-QA26 checkpoint 89 handoff

- 承接 HEAD `1391e655`。发现 OPC 关系与 Content Types 属性只按 XML `Local` 名匹配：Go/WASI 对外来 `f:Id/Type/Target`、`f:Extension/ContentType`、`f:PartName/ContentType` 三类包均错误抽取正文；外来 `f:TargetMode=External` 还能覆盖标准 `TargetMode=Internal`，误拒绝有效内部关系。真实 Electron 和 Web filechooser 修前对第一类关系属性样本均返回 HTTP 200，并在断言失败前 DELETE 清理；未声称修前 UI 已到达后两个 Content Types 负例。
- `hasPackageMainDocumentRelationship`、`hasWordDocumentContentType`、`hasExternalRelationship` 现只按无命名空间 OPC 属性判定。Go/WASI 新增 3 个错误包及 TargetMode 遮蔽正例，定向 `-count=3` 通过（29.261s）；完整 documentparse 通过（135.330s）。重建 `parser.wasm` 与 `parser-source.sha256`。
- Electron 与 Web 真实 filechooser 各 3/3：每轮有效 OPC 200/ready、原件 GET 字节一致、逐项删除后 GET=404；外链继续 422；15 个结构负例均 422，发送禁用且无 conversation/message POST。新增样本 p50/p95 ms：Electron Relationship 2377.36/2666.96、Default 2395.22/2437.26、Override 2445.83/2822.88；Web 分别 2477.43/2501.80、2461.50/2541.60、2492.93/2575.53。双端 typecheck、pair guard（Web123/桌面87/36 对）、diff check 通过。完整命令及日志路径见 docs/26 cp89。
- docs/22 AG-20/v0.72、docs/26 v2.54、docs/08 cp89 已更新。D-168 选项 A（每 10 分钟）已在此前提交 `9cafd218` 同步 docs/06 与 docs/90；本次答复没有造成文档漂移。
- 本批提交 `54732c53751afb65dd82bf38c47bb1b1a1d90f19 DEV-QA26: 校验OPC属性QName`，只含本任务 9 个文件；`git show --check` 通过，未 push/deploy。预存 `desktop/renderer-src/tests/recent-owner.test.mjs` 修改与所有未跟踪项仍保留。T-AW28/G7-03 仍部分：其他 OPC/ZIP/XML、资源矩阵、静态扫描与 Windows 大文档时延未验；4 MiB×100页×256 项 Web 30 秒 deadline 波动未重跑、未归因、限额不变；HC/H 未动，本轮未跑 app/HC。
- 下步继续尚未闭合 G7-03 DOCX 结构/资源矩阵，再按用户顺序检查 G8/G6/G7 剩余项目；真实模型/平台发布、生产迁移、签名包和部署继续在本机 mock 范围之外。

## 2026-11-06 DEV-QA26 checkpoint 90 handoff

- 承接 HEAD 54732c53。G7-03/T-AW28 的 DOCX 保存页数读取此前仅按 Pages 本地名扫描，修前 Go/WASI 接受外来命名空间、嵌套 Pages 和外来 Properties 根；Electron/Web 真实 filechooser 对外来 Pages 样本也返回 200。
- parser 现在要求扩展属性命名空间 Properties 根下唯一直接 Pages 子级；缺失/非法声明返回 docx_page_count_unverifiable 与转 PDF 提示。重建 parser.wasm/source hash，正向夹具规范化。WASI 三个新例 count=3、完整 documentparse（146.315s）通过；Electron 与 Web filechooser 各 3/3：有效件原件字节 GET 一致、删除后 404，18 个结构负例均 422，发送禁用、无 conversation/message 写入。
- 新负例 p50/p95 ms（n=3）：Electron 外来 Pages 2119.61/2371.14、嵌套 Pages 2566.63/3195.48、外来根 1934.87/2169.55；Web 分别 2877.55/3089.63、2507.77/4308.35、3103.86/5390.94。Web 原 90 秒用例时限不够容纳 18 个串行上传，只扩至 180 秒，未改断言或服务端解析限制；重跑 3/3（4.0m）。双端 typecheck、E2E pair guard（123/87/36 对）和 diff checks 通过。
- docs/22 AG-21/v0.73、docs/26 checkpoint 90 与 docs/08 checkpoint 91 更新。本批提交 7e56aced844744b86228fe8da7371a5dcb009bc4（DEV-QA26），9 个任务文件；git show --check 通过，不 push/deploy。D-168 选项 A（每 10 分钟）仍由既有提交 9cafd218 同步 docs/06/docs/90。
- 工作树另外存在共享进行中的 G6-07/G8-03 台账编辑、desktop recent-owner 测试修改和未跟踪验收脚本；均保留且未夹入本提交。HC-01～31/H-01～09 未改、删除、跳过或放宽，本轮未跑 app/HC。G7-03/T-AW28 仍部分：其他 OPC/ZIP/XML、资源矩阵、静态扫描、Windows 大文档时延及 Web 4 MiB×100页×256项 30 秒边界尚未闭合；该边界本轮未重跑。下一步继续剩余 G7-03 可执行边界，之后按既定优先顺序返回未完成 G8/G6/G7 点击验收。


## 2026-11-06 DEV-QA26 checkpoint 91 handoff

- Web 大 DOCX 固定量化：真实 Chromium filechooser，4 MiB 展开正文×100 页×256 ZIP 项，n=20，15/20 ready、5/20 约 30 秒 422；全样本最近秩 p50/p95=10,371.48/30,031.99ms，成功子集=9,768.63/11,932.10ms。4 个结果文件位于 `.playwright-results/qa26-g7-docx-4mib-100p-256e-web-{r3,ci1,ci2,ci14}-20261106.log`。
- 新服务启动可复现；`Parse` 的 deadline 覆盖 slot 等待+worker，无分阶段日志。5 MiB 单页隔离基线并非同 fixture，故根因未确认；不改 30 秒/256 MiB/扩展体积限制。G7-03/T-AW28 仍部分，需后续补 Electron 同负载量化、parser 分阶段计时，并继续其他 ZIP/XML/资源边界。
- 本批只更新 docs/26 cp93、docs/08 cp92 与此 handoff；不运行 app/HC；HC/H 红线未动；未触及模型/外部平台/生产，不 push/deploy。下一步继续 G7 可执行验收，再回到剩余 G8/G6/G7 项。

## 2026-11-06 DEV-QA26 checkpoint 92 handoff（Electron 大 DOCX 同负载量化）

- 承接 HEAD `5c4fadae DEV-QA26: 补验桌面设置与发布路径`。沿用 Web checkpoint 91 的 4 MiB document.xml × 100 页 × 256 ZIP 项样本，Windows Electron 原生 filechooser n=20：11 ready、9 次约 30 秒 422；服务端请求耗时全样本 p50/p95=9,171.57/30,030.95ms，成功子集=8,954.52/9,202.23ms。结合 Web n=20 的 15 ready/5 deadline 422，性能验收未通过；根因仍无法区分 parser slot 等待、worker 时间或本机资源调度。
- 成功回执包含 100 页与 4,191,585 extracted chars；原件 GET、逐项 DELETE 核验通过。`qa26-fresh` 首次尝试仅等不到 filechooser，未产生附件 POST，排除于样本。两批 Playwright 原始日志位于 `.playwright-results/qa26-g7-docx-4mib-100p-256e-electron-{reuse1,r19}-20261106.log`；完整命令与边界见 docs/26 checkpoint 95。
- 不改解析器、30 秒/256 MiB 限制；不宣称真实模型质量或端侧差异。G7-03/T-AW28 仍部分检查。工作树里其余 recent-owner 修改与未跟踪审计脚本均保留。HC/H 红线未动，本批未跑 app/HC；不 push/deploy。下一步按用户顺序继续检查 G8 未完成设置项，再推进 G6 和 G7 其余可执行旅程。

## 2026-11-06 DEV-QA26 checkpoint 97 handoff

- 承接 HEAD `863e70ee DEV-QA26: 补验 G2-G5 桌面剩余路径`。G6 原来缺 FR-M11-02 看板排序和 T+30 正向快照；已实现服务端安全排序白名单/升降序/NULL 末位稳定排序及双端控件。T+30 UI 保存、API 持久化、正式快照引用、窗口比较、报告编辑与逐条采纳通过。服务端定向 Go 测试通过；Electron 与 Web 真实 E2E 各 3/3（各 1.1m），每轮另量 20 次排序控件状态交互，连续三轮 0 失败，p50/p95 已写 docs/26 cp97。完整命令、日志及报告路径见 docs/08 与 docs/26。桌面 typecheck、Web typecheck、desktop renderer 40/40 unit、E2E pair guard（Web123/桌面87/36 对）通过。Web unit 41/42；唯一失败是既有 `web/e2e/agent-goals.spec.ts:22` desktop testid 边界守卫，未改该无关文件。
- G8/G7 三个审计子智能体均先复核已有证据后只读盘点，没有并行启动测试、没有源码或文档编辑；G6/G8/G7 同一桌面 E2E 服务/数据库均按单任务串行。G8：models、members、words、trash、export 既有主要流程已通过；真实模型费用/质量、真实 SMTP/系统通知和物理 IME/屏幕阅读器边界未验。G2-11 既有原生 Electron 停用后列表目标行未刷新缺陷仍待根因；G2-12 的 d126 用例实际是模拟 Electron bridge 的 Chromium 窗口导航并断言标题，Web 另有“来自智能体”行验证，均不代表原生 Electron 日志页验收；数据/筛选/分页/空态/错误/权限仍未验。G3-11 现有来源配置仅 renderer 持久化证据。G7：01/02/04/05/06/13 已有桌面路径通过；03 文档解析仍部分（Electron 11/20、Web 15/20 的固定大 DOCX 样本约 30 秒失败，原因未知，不重复运行），07 完整 app 重开/跨设备竞争未验，08 租约/失败矩阵未全，AW11 目前报告无法还原样本数/耗时。细节见 docs/26 cp97。
- overlay 检查：当前对话未提供可直接读取的截图文件；进程/端口检查未发现 overlay、Playwright、E2E runner 或桌面 QA 端口占用，所以没有停止或重新启动它。没有证据表明截图中 3 小时 22 分钟的任务仍存活或继续推进。
- 已修改 `docs/05`、`docs/06`、`docs/08`、`docs/26` 与 G6 服务端、双端页面及双端 E2E；本批提交只纳入这些任务文件，后续核对 HEAD。`docs/AI_HANDOFF.md` 受 `.gitignore` 忽略，仅保留在本机、不强制加入提交。既有 `desktop/renderer-src/tests/recent-owner.test.mjs` 修改、`_tmp_*` 与所有 QA/audit 未跟踪文件继续保留；不运行 HC 本轮、HC/H 红线未动，不 push/deploy。下一步做 G8-12 日志列表本地真实窗口验证，调查 G2-11 根因，然后按缺口继续 G7-07/08 与 G8 原生状态路径。

## 2026-11-06 DEV-QA26 checkpoint 98 handoff

- G8-12 修前 Windows 原生 Electron 点击复现：`/audit-logs` 503 被错误显示为空态。桌面/Web `Logs.tsx` 现在分别展示错误和“重试读取”；成功空数组仍显示空态。真实 Electron 设置入口、服务端审计读回、动作筛选/密钥不泄漏/空态/503/重试连续 3/3（49.9s）；Web 对应失败/重试 3/3（36.8s）。命令和报告路径见 docs/26 cp98、docs/08 cp98；G2-12 仍部分，待测加载更多、viewer 页面与超管全站日志。
- 桌面 typecheck、40/40 unit、Web typecheck、E2E pair guard（123/87/36 对）、diff check 通过。Web unit 41/42，唯一失败仍是既有 `web/e2e/agent-goals.spec.ts:22` 桌面 testid 边界守卫。G2-11 管理列表旧状态根因仍未知；未捕获停用后的 `/admin/users` GET，因此不做代码修改。
- G6 T+30/排序本批此前已提交 `aa9ac5f5`，桌面/Web E2E 各 3/3，既有 Web unit 边界失败同上。G8/G6/G7 审计子智能体均已完成只读盘点；overlay 任务无可见截图/活动 runner 证据，没有停止或重启测试。D-168 每 10 分钟方案及 docs/06 同步已在先前 `9cafd218` 完成。
- 本批任务代码和 docs/05/06/08/26 单独提交；`docs/AI_HANDOFF.md` 受忽略仅留本机。用户原有 `recent-owner.test.mjs` 修改及所有未跟踪文件保留；HC/H 未更改/跳过，不 push/deploy。下一步继续 G8 的 G2-11 原因诊断和未覆盖状态路径，再推进 G7-07/08 本地可验旅程；G7-03 大 DOCX 约 30 秒不稳定原因尚不明确，不重复跑已完成 n=20 样本。

## 2026-11-06 DEV-QA26 checkpoint 99 handoff

- G8/G6/G7 三个只读审计子智能体先核对已有台账与 handoff；未重跑已通过的设置 models/members/usage/words/trash/export、G6 T+30/复盘报告建议等路径。G6-01/02 桌面本地证据已通过，其余真实平台与真实模型质量边界按 docs/26 保留。G8 后续可执行项以 G2-12 时间游标、viewer 页面与超管日志为主。D-168 用户明确选择 A：保留每 10 分钟回收站检查；核对 docs/06 §4.2/§5.7 已与 docs/90 一致，无需文档改动。
- G2-11/AG-22 修后双端真实入口停用/会话撤销/逐项恢复连续 3/3。PATCH 200、UI 目标行状态、API `disabled_at`/`session_count=0` 与用户会话 401/恢复读回一致；每轮 20 次状态交互 0 失败。Electron 三轮 p50/p95 1.213/1.850s、1.006/1.192s、0.988/1.111s；Web 4.039/4.550s、4.069/5.501s、4.287/4.922s；Web 目标行滚动约 3.4–3.6s，无批准性能阈值。命令与边界见 docs/08 checkpoint 99、docs/26 checkpoint 99、docs/22 AG-22。桌面/Web typecheck 与 E2E pair guard（123/87/36 对）通过。
- overlay 用户截图没有可直接读取的文件；当前检查未见其 runner、活动 Playwright 或 QA 端口，无法证明截图中的任务仍活跃/有进展。没有停止或重启 overlay 测试。G2-11 其余管理工作区/权限组合仍部分；G6/G7 后续续验由主智能体串行安排，测试结束即释放 QA runner。
- G2-11 任务已单独提交 `7194651 DEV-QA26: 修复停用用户列表状态刷新`，只含双端 `Admin.tsx`、双端 `agent-routines.spec.ts` 和 docs/08、22、26；`git diff --cached --check` 通过。工作树其它改动/未跟踪文件及忽略的 handoff 保留，不 push/deploy。HC-01～31、H-01～09 未改、删除、跳过或放宽。

## 2026-11-06 DEV-QA26 checkpoint 100 handoff

- G7-07 新增真实 Windows Electron 完整 app exit/relaunch 场景：同 profile 重启后 `/auth/me` 用户、目标预算 2/2、最后 run/message 持久化；新消息 429、恢复 409，均 3/3（46.7s）。首轮 3/3 仅在既有 `/agent` 前置受 `displayMessages is not defined` 阻断，失败 trace 保留；共享工作树随后将 JSX 改为 `displayEntries`，桌面 typecheck 与重启场景通过。该 UI 文件原本已 dirty，不夹带本次测试提交。命令/截图/报告和部分检查边界见 docs/08、docs/26 checkpoint 100。
- G7-07 仍有跨设备预算竞争、真实模型质量边界；G7-03 DOCX 30 秒大样本波动与 G7-08 完整租约/失败矩阵仍开。下一项先查既有 Go 目标预算并发覆盖，再跑最小并发验证；与 Electron/共享 E2E API/DB 争用的测试串行安排。G8 G2-12 页游标/viewer/超管日志仍可本地验证；G6-01/02 已有证据本批不重跑。
- 本批新增提交 `DEV-QA26: 验收目标预算跨整应用重启` 待核对。无 push/deploy；不影响并保留其余 dirty/untracked 工作、HC/H 约束不变。

## 2026-11-06 DEV-QA26 checkpoint 101 handoff

- G7-07 双真实 Electron 独立 profile、同目标会话 UI 同时发送最后一次预算，连续 3/3：一请求 202、一请求 409 `agent_run_busy`；服务端唯一新增 run/message，预算最终 4/4。运行结束后 UI 再发送 429 `agent_goal_budget_reached`，服务端无进一步写入。该结果证明同会话活动运行互斥与耗尽后闸门，不证明并发预算检查本身的原子竞态。mock 不能证明真实模型质量。
- 命令、用例和最终 `.last-run.json` 证据路径见 docs/08 与 docs/26 checkpoint 101；目录时间窗估算总耗时约 51s，console evidence 未持久化为独立日志，无可报告分位数。G7-07 仍部分检查，真实模型质量未验。
- G8/G6/G7 子智能体均已完成首轮只读盘点；G6 的本地 T+30/报告建议路径不重复运行，G8 已有 models/members/usage/words/trash/export 本地证据，G7-07 追加以上重启及并发窗口验证。overlay 无可读取截图，进程/端口未发现相关 runner；未停止、重启或重复启动截图任务。保留全部既有 dirty/untracked 与忽略的 handoff，不 push/deploy；HC-01～31/H-01～09 未改动、删除、跳过或放宽。
- 本批待单独提交 `DEV-QA26: 验收双设备目标运行互斥`；下一步按 docs/26 继续 G8 G2-12 未覆盖页面角色/时间游标与 G7-08 仍未闭合矩阵，不重复既有样本。

## 2026-11-06 DEV-QA26 checkpoint 102 handoff

- G6-01 排序 UI 深度缺口已补：新增独立真实 Electron 多作品旅程，三个已发布作品的 T+7 服务端指标读回，`reads` 升/降序及 `favorites` 升序，排序 API 顺序与桌面表格行顺序一致，3/3、1.1m。命令和 `.last-run.json` 路径见 docs/08 与 docs/26 cp102。桌面 typecheck、pair guard（Web123/桌面87/36 对）、diff check 通过。G6 T+30、报告编辑与建议采纳既有旅程未重跑。
- G6 仍部分在真实公众号权限/采集、真实模型质量/费用、真实平台 CSV/发布边界；mock 不代表这些通过。下一步串行补 G7-08 正好 30 分钟 scheduler 截止样本；G8 G2-12 分页/viewer/全站超管日志当前只有 owner smoke 1/1、这些缺口仍开。
- 本批只改 `desktop/renderer-src/e2e/cx13-review-multitime.spec.ts`、docs/08、docs/26；现有其它 dirty/untracked 保留，忽略的 handoff 只在本机。不 push/deploy；HC-01～31、H-01～09 不改、删除、跳过或放宽。

## 2026-11-07 DEV-QA26 checkpoint 103 handoff

- G7-08/T-AW26 `TestAW10RoutineSchedulerLateWindowBoundary` 新增精确 30 分钟迟到边界，固定 app clock 与 due 时间；29/30 分钟各唯一完成，31 分钟 `missed/missed_window` 且无 run，事件/通知/重复 tick 断言保留。定向 Go 测试连续 3/3 通过，包耗时 8.044s；`journey_ms` 2435.82/184.84/151.22，p50/p95=184.84/2435.82ms。首轮因新建 30 分钟样本后旧 fixture index 未同步而 3/3 失败，修正 test index 后通过；没有改生产逻辑。详见 docs/26/08 checkpoint 103。
- 下一步回到 G8-12 剩余真实 Electron 日志加载更多、viewer 页面、system-admin 全站日志；先核对端口/DB/报告目录空闲，再做串行或可隔离定向验证。G6 多行排序补验已在 checkpoint 102；G7-07 完整重启与跨设备活动运行互斥已完成，但并发预算竞态及真实模型质量边界保留。G8/G6/G7 子智能体已完成首轮检查，不重复启动或重复已通过路径。
- 保留现有 dirty/untracked 文件，不 push/deploy。mock 不证明真实模型质量；HC/H 红线不改动、删除、跳过或放宽。

## 2026-11-06 DEV-QA26 checkpoint 99 handoff

- G8/G6/G7 三个只读审计子智能体先核对已有台账与 handoff；未重跑已通过的设置 models/members/usage/words/trash/export、G6 T+30/复盘报告建议等路径。G6-01/02 桌面本地证据已通过，其余真实平台与真实模型质量边界按 docs/26 保留。G8 后续可执行项以 G2-12 时间游标、viewer 页面与超管日志为主。D-168 用户明确选择 A：保留每 10 分钟回收站检查；核对 docs/06 §4.2/§5.7 已与 docs/90 一致，无需文档改动。
- G2-11/AG-22 修后双端真实入口停用/会话撤销/逐项恢复连续 3/3。PATCH 200、UI 目标行状态、API `disabled_at`/`session_count=0` 与用户会话 401/恢复读回一致；每轮 20 次状态交互 0 失败。Electron 三轮 p50/p95 1.213/1.850s、1.006/1.192s、0.988/1.111s；Web 4.039/4.550s、4.069/5.501s、4.287/4.922s；Web 目标行滚动约 3.4–3.6s，无批准性能阈值。命令与边界见 docs/08 checkpoint 99、docs/26 checkpoint 99、docs/22 AG-22。桌面/Web typecheck 与 E2E pair guard（123/87/36 对）通过。
- overlay 用户截图没有可直接读取的文件；当前检查未见其 runner、活动 Playwright 或 QA 端口，无法证明截图中的任务仍活跃/有进展。没有停止或重启 overlay 测试。G2-11 其余管理工作区/权限组合仍部分；G6/G7 后续续验由主智能体串行安排，测试结束即释放 QA runner。
- 本批待按任务提交 G2-11 相关 `Admin.tsx`、`agent-routines.spec.ts` 与 docs/22、26、08；工作树其它改动/未跟踪文件及忽略的 handoff 保留，不 push/deploy。HC-01～31、H-01～09 未改、删除、跳过或放宽。

## 2026-11-07 DEV-QA26 checkpoint 104 handoff

- G8-12 原生 Electron 操作日志分页/权限缺口补验：owner 51 条记录首屏 50 + 精确时间 cursor 次页 1，唯一记录/UI 51 条；viewer workspace 与角色读回、仅本 workspace 页面记录、全站管理员接口 403；system-admin UI/API 可读跨 workspace actor。3/3，约 1.2m；筛选交互 n=20、p50/p95=16.20/25.68ms、失败 0。命令、状态文件、日志见 docs/26/08 cp104。
- G2-12 仍部分检查：Web 对应分页和 viewer/超管 UI 未验；旧 Web 503 错误/重试证据保留。只用隔离 ops-e2e/PostgreSQL/mock，不证明真实模型或生产管理员；HC/H 未动、不 push/deploy。当前 Electron 测试完成，用户默认 profile Electron 保留运行。
- 下一步可继续桌面 G8 其他缺口或 G6/G7 剩余本地可执行项；G7-03 大文档波动与真实平台/模型边界保持原登记，不重跑既有大样本或把 mock 说成质量通过。

## 2026-11-07 DEV-QA26 checkpoint 105 handoff

- G2-12 Web 对应 UI 补验完成：owner 分页首屏 50、`before` 精确等于末条 `created_at`、次页 1 条且无重复；viewer 页面工作区隔离和超管全站日志 UI/API 验证；viewer admin API 403。Windows Chromium 连续 3/3（1.0m），筛选每轮 n=20 失败 0，p50/p95=34.98/44.94、41.26/54.50、42.06/57.87ms。报告与完整 metrics log 见 docs/26 cp105。Web typecheck passed。
- G2-12 双端本地旅程现在“已检查-通过”；真实 Electron cp104 + Web cp105 各 3/3；tie timestamp 边界未覆盖。mock 不代表生产/模型质量，未 push/deploy，HC/H 未动。下一步聚焦 G7-03 Windows 大 DOCX 30 秒波动的阶段定位（不重跑既有 n=20）、G7-07 budget race 可达性及 G7-08 provider-call 中断恢复。

## 2026-11-07 DEV-QA26 checkpoint 108 handoff

- G6 WeChat/XHS 本地回填 gap 已关闭：真实 Electron 分别从 XHS 发布包和 WeChat mock 草稿进入手动回填，平台专属 T+1 字段与 POST/GET 指标读回各 3/3；每平台每轮 n=20 输入交互，p50/p95 见 docs/26 cp108。Web WeChat 草稿→手动标记发布与 GET 状态 3/3。修复 2G-24 `pushed` 状态过早显示检查阻断，以及 2G-25 Electron Push tab 无法滚动到表单；对应源码为双端 Push.tsx 与桌面 WorkLayout.tsx。类型检查、E2E pair guard、diff check 通过。mock 不代表真实平台发布或数据准确性。
- G8 已有 models、members、usage、words、trash、export 的本机 Electron 设置证据沿用，不重跑。G2-04 外部 SMTP/真实收件箱与 G7-09 真实模型质量仍为外部边界。额外补 G8-02 未 opt-in 的 system notification gate：真实 Electron SSE 收到新的 `agent_goal` 后 `new Notification` 计数仍为 0，3/3，详见 checkpoint 109。实际 Windows notification center toast/撤回权限仍未验证。
- 此前 3 小时 22 分钟 overlay runner：本机没有可读取的原截图或仍活动的 runner/QA ports，未停止/重启/重复启动。当前用户默认 Electron 保留。
- 当前仍开：G7-03 Windows 大 DOCX worker 阶段原因（不重跑既有 n=20、不改 30 秒/256MiB）、G7-07 跨进程预算竞态直接验证、G7-08 更广 lease/outage matrix；真实模型/平台边界不在本地 mock。保留既有 dirty/untracked，不 push/deploy；HC/H 红线不动。

## 2026-11-07 DEV-QA26 checkpoint 109 handoff

- G8 settings evidence recheck: models, words, trash, export local Electron flows pass; members and usage local paths pass but remain partial for external mailbox and real-model quality boundaries. No repeat of passed settings tests. D-168 remains user-confirmed at every 10 minutes.
- G8-02 new negative notification gate passed in true Electron 3/3 (34.1s): no local opt-in key, real SSE invalidation, injected `agent_goal` list, `Notification.permission=granted` stub, constructor call count stays 0. Command/report in docs/26 cp109. OS toast/withdrawn permission/screen reader remain unverified.
- G6 cross-platform WeChat/XHS backfill fixes and tests were committed separately as `5a0dc71 DEV-QA26: 修复公众号回填入口并补验跨平台字段`; G8 test/docs are to be staged/committed separately. Preserve unrelated dirty/untracked and ignored handoff; no push/deploy, HC/H untouched.

## 2026-11-07 DEV-QA26 checkpoint 110 handoff

- G7-03 cp110 stage diagnostic had only reached the `InstantiateModule` call boundary; wazero v1.9.0 runs default `_start` from this call, so cp110 alone did not show that guest XML parsing was unentered. cp111 used the same 6 MiB fixture with `WithStartFunctions()` to separate stages: instantiation succeeded, then explicit `_start` hit `VirtualAlloc ... errno=1455` / fatal OOM in Wazero `MemoryInstance.Grow` / Go `runtime.growslice` requesting 59,482,112 bytes. Full log `.playwright-results/qa26-g7-03-wasi-boundary-probe-r1-20261107.log`.
- The bounded parent test took 45.067s and exited 0 because it captured the child's failure; its 45s outer context expired while the child had not exited. This is not a worker pass. Temporary probe source removed; worker implementation, 30s guest deadline, and 256 MiB limits unchanged.
- cp112 added one same-fixture resource-only probe: Job query reports ProcessMemoryLimit and PeakProcessMemoryUsed both exactly 268,435,456 bytes; 8 roughly 1s worker samples peak at 265,695,232 Private Bytes; system CommittedBytes peaks at 26,215,321,600 vs CommitLimit floor 51,340,451,840 (~25.13 GB headroom). Combined with explicit `_start` failing in Wazero `MemoryInstance.Grow`, Job cap is the high-likelihood owner, system-wide commit is unlikely. The system counter samples are asynchronous, so root cause is not atomic/proven and no safe limit-preserving product fix is verified. Full evidence `.playwright-results/qa26-g7-03-wasi-resource-probe-r2-20261107.{csv,stdout.log,stderr.log}`; temporary probe source and PID marker removed. G7-03 stays partial. Do not repeat old DOCX n=20 or relax caps.
- G7-07 audit: service serializes message starts on the same `agent_conversation FOR UPDATE` before locking its one-per-conversation goal. A second device therefore reaches `agent_run_busy`; goals are scoped to their conversation, so existing two-device E2E cannot prove parallel budget judgement atomicity. Do not add speculative code/test seam; retain this as a scope/coverage boundary. No Electron/DB shared resource used for this source audit.
- G6/G8 evidence is in docs/26 cp108-cp109; G7-03 boundary/resource/candidate review is cp111-cp113. Wazero `WithMemoryCapacityFromMax(true)` would preallocate the maximum and is unsafe under the same 256 MiB Job; GC cannot free live guest linear memory. No limit-preserving fix is verified; keep G7-03 partial for dedicated peak-memory optimization. Current active worktree retains unrelated dirty/untracked files. Do not push/deploy; HC/H redlines untouched. Next: continue only remaining local executable G6/G7/G8 gaps from their existing ledger entries; do not duplicate completed settings, review, overlay, or n=20 samples.
- Commits after the initial `de9fbb33` baseline: `5a0dc71 DEV-QA26: 修复公众号回填入口并补验跨平台字段`, `240b124 DEV-QA26: 验收未启用通知派发门控`, and `dcdb0f7 DEV-QA26: 记录worker阶段诊断与预算锁复核`; none pushed. The last commit staged only docs/08 and docs/26. Existing unrelated tracked/untracked files remain in the worktree.

## 2026-11-07 DEV-QA26 checkpoint 114 handoff

- 三个验收子智能体已完成：G8 设置证据复核、G6 复盘旅程证据复核、G7 智能体证据复核。G6 的本地旅程不重复；G8 已通过的模型/成员/用量/敏感词/回收站/导出入口不重复，OS toast/撤权/实体触控/物理 IME/读屏及 SMTP 外部收件箱仍需外部条件。用户对 D-168 选择 A，docs/06 的回收站清理频率与 docs/90 对齐。
- 3小时22分钟 overlay 截图当前不可读取；本机活动链是用户本地 `pnpm start` 开发 Electron/Vite（`:5174`），未发现 QA ports/Playwright runner。未停止、重启或重复启动截图中的任务，用户应用保持原状。
- G7-03 Windows allocator + DOCX 单遍流式解析在现有 256MiB/30秒限制内：6/8MiB worker 各连续 3/3，解析 p50/p95 分别 8,015.97/8,087.03ms、10,362.35/10,480.95ms；Windows Electron/Web 6MiB filechooser 各 3/3 ready，p50/p95 分别 8,269.76/8,293.44ms、8,118.98/8,799.15ms。`documentparse` 全包 205.663s pass，`^TestHC` 20.741s pass；构建及 diff check pass。命令、trace、日志见 docs/08/26 cp114。
- 32MiB 单一 `word/document.xml` 最新单次验证仍在既有 worker 30秒 deadline 超时，证据 `.playwright-results/qa26-g7-03-32m-singlepass-r1-20261107.log`；维持部分验证，不提升上限或期限。最终工作范围包括 `server/internal/documentparse/wasm/main.go`、WASI artifact/hash、`runner.go`、Windows allocator及其测试、worker/e2e 回归、docs/08/26；只提交本任务文件。所有既有 dirty/untracked、含本 handoff 保留；HC-01～31/H-01～09 未动；不 push/deploy。
- G6/G7/G8 相关部分验证共 11 项：G6-03/04/09，G7-03/07/08/09，G2-04/G8-02/08/09。G7-03 32MiB 解析优化仍需额外定向分析；G6 真实平台/模型质量、G8 实体设备/OS 权限/SMTP、G7-09 真实模型质量受外部条件约束。项目全量矩阵部分检查项更多，按 docs/26 当前表为准。

## 2026-11-07 DEV-QA26 checkpoint 115 handoff

- G7 子智能体复核：G7-07 双设备目标预算 3/3 已证明消息启动串行和活动运行/耗尽闸门；同一 goal 的直接并发预算判定路径被 app_user/conversation 行锁及每会话唯一 open goal 排除，不增加绕锁测试。G7-08 连续失败暂停/恢复、29/30/31 分钟、唯一调度、lease 回收、在途未知结果与 claim 事务中断均已有 T-AW26 本地证据，未重跑。
- 新增 G7-08 终态提交窗口测试 `TestAW10RoutineProviderSuccessBeforeFinishCommitIsUnknownAndNeverReplayed`：有效 provider 响应已返回，独立 worker 被终止于 `agent_run=completed` 事务；恢复后 run/occurrence 标记 interrupted/unknown，provider call/occurrence/run/event 均唯一。`go test -p 1 -count=3 -run '^TestAW10RoutineProviderSuccessBeforeFinishCommitIsUnknownAndNeverReplayed$' -timeout=4m -v ./internal/app` 3/3，27.077s；journey p50/p95=7,276.51/7,403.29ms。日志 `.playwright-results/qa26-g7-08-provider-finish-commit-r2-20261107.log`。首版测试-only 60s trigger sleep 受 app DB 30s statement timeout 影响，失败日志 r3 保留；改为 5s 后通过，没有更改生产逻辑/timeout。
- docs/26 v2.74、docs/08 cp115 已同步；D-168 每 10 分钟保持不变。G7-08 仍 partial 是 mock 对真实 provider 计费/生产时钟及网络分区的边界；G7-03 32MiB 仍超现有 30s worker deadline。G6/G7/G8 相关部分项合计仍 11，项目全局部分项更多，按 docs/26 矩阵为准。本批 Go 集成测试与 docs/08、docs/26 已单独提交 `ee31ee1`；保留其余 dirty/untracked 与本地 ignored handoff，不 push/deploy，HC/H 不动。

## 2026-11-07 DEV-QA26 checkpoint 116 handoff

- G7-03 32MiB Windows worker Job resource probe: `go test -p 1 -count=1 -run '^TestQA26ProbeThirtyTwoMiBWorkerJobPeak$' -timeout=60s -v ./internal/documentparse`; outer 30.133s/exit 0 means probe capture passed, worker exited status 1 at ~30.025s with empty stdout/stderr. Peak Job bytes 228,401,152, below 256MiB cap; this run did not hit the observed Job peak limit, but phase/root cause remains unknown. Log `.playwright-results/qa26-g7-03-32m-resource-probe-r1-20261107.log`.
- One low-risk ASCII fast path was tried after a red 32MiB boundary repro; same acceptance still failed at 30.08s. Candidate source and permanent failing test were withdrawn; generated WASI artifact restored to committed version. Candidate logs: `.playwright-results/qa26-g7-03-32m-ascii-fastpath-red-r1-20261107.log` and `...green-r1-20261107.log`. Preserve both pre-existing untracked Windows probe helpers.
- G7-03 remains partial pending isolated phase/CPU profiling and a limit-preserving parser optimization; do not repeat n=20, relax 30s/256MiB, or claim root cause from this single peak sample. No Electron/app port/DB was used; HC/H untouched, no push/deploy. docs/26 v2.75 and docs/08 cp116 updated; keep existing unrelated dirty/untracked state intact.

## 2026-11-07 DEV-QA26 checkpoint 117–118 handoff

- One separate 32MiB CPU sample: worker wall ~30.02s, CPU 29.188s (~97.2%), peak Private Bytes/Job 227,872,768 and working set 192,663,552 bytes; below 256MiB. Sample CSV `.playwright-results/qa26-g7-03-32m-cpu-profile-r1-20261107.csv`.
- Temporary WASI stage instrumentation logged 1MiB host-wall checkpoints: 1MiB at 771.46ms, 31MiB at 28,279.69ms; UTF-8 validate was ~0–7ms at each checkpoint; no tokenizer-return before deadline. Combined with Go 1.26.10 stdlib `encoding/xml.Decoder.text` byte loop, this points to XML CharData token scan as the dominant CPU area, but no stack/line profile proves an exact function. Stage log `.playwright-results/qa26-g7-03-32m-stage-profile-r2-20261107.log`.
- Diagnostic source/test/build artifact were restored; only docs/08 and docs/26 changed for cp117–118. G7-03 remains partial: 32MiB is an implementation boundary with no design promise that every max-sized expansion succeeds under hard 30s/256MiB; deadline and below-cap memory behavior are observed, but Electron 32MiB UI feedback and further large/malicious cross samples remain unverified. No limit relaxation, HC/H changes, push or deploy. If this edge is promoted to a success SLA, it needs a separately scoped XML fast-tokenization design/implementation; current estimate 2–4 engineering days, not guaranteed to close without further profiling/regression.

## 2026-11-07 DEV-QA26 checkpoint 119 handoff

- Added desktop-only 32MiB DOCX boundary UI E2E in `desktop/renderer-src/e2e/agent-documents.spec.ts`. True Windows Electron `filechooser` journey ran 3/3 (`--project=desktop-renderer-shared-scenarios`, 1.9m): all returned 422 `agent_attachment_parse_failed` at the 30s cap; visible timeout card/message, 0 conversations, 0 message POST. Click-to-response 30,115.17/30,076.84/30,084.12ms; p50/p95 30,084.12/30,115.17ms. Report `.playwright-results/qa26-g7-03-32m-electron-r1-20261107/.last-run.json`; typecheck passed.
- First selector attempt incorrectly used `desktop-windows-electron` and found no tests; no Electron launched. `--list` confirmed the correct shared-scenarios project, then the 3-run E2E above executed. Output path was unique; no QA ports remain active.
- UI deadline feedback/zero-write behavior is verified, not parser success. Test accepts either spec-allowed timely parse (then validates receipt/original/delete) or visible deadline error; G7-03 remains partial for performance/other large-malicious cases. docs/26 v2.77 and docs/08 cp119 updated; no source logic, HC/H, push or deploy changed.

## 2026-11-07 DEV-QA26 checkpoint 120 handoff

- 用户确认 D-168 选项 A：保留每 10 分钟清理并同步 docs/06；§4.2/§5.7 与 docs/90 一致。
- 三个并行子智能体均完成 G8/G6/G7 证据复核，没有重跑已通过测试。overlay 截图附件当前会话不可读取；未见 QA runner/端口，不停止、不重启、不重复启动，用户本地 Electron/Vite `:5174` 保持原状。
- G8 本地设置旅程已验；G6 本地复盘旅程及服务端回填/建议读回已验。G7 各主要路径已有证据，cp119 32MiB Electron 超时反馈 3/3（1.9m、零 conversation/message 写入）。本轮没有新增代码或测试；详细命令、耗时和证据路径见 docs/26 checkpoint 120。
- 目标范围保持 11 项部分检查；全局 106 项中 37 部分、11 未检查。剩余依赖真实平台/模型、SMTP/真实收件箱、Windows 通知权限、触控/物理 IME/读屏；G7-07 直接同 goal 并发预算路径由授权 API 锁序列排除；G7-03 更广 T-AW28 样本与未批准的 32MiB 成功 SLA 仍是未闭范围。若另批 32MiB 成功 SLA，估计 2–4 工程日且尚无保证。无 push/deploy，HC/H 红线未动。

## 2026-11-07 DEV-QA26 checkpoint 121 handoff

- D-168 选项 A 已由用户再次确认；`docs/06` §4.2/§5.7 已同步启动轮及每 10 分钟检查，`docs/90` 已记录决议，本轮不需重复改该设计记录。
- G7-03 独立 ZIP filechooser 缺口已补：新增 Electron/Web 配对 E2E，161-byte 合法 ZIP 每轮 20 次、每端重复 3 轮；均类型拒绝、0 附件/conversation/message 写入。桌面 3/3，runner 27.6s；可回收的一轮 p50/p95=46.64/64.11ms。Web `.last-run.json` passed/0 failed；日志输出截断，Web timing 未回收，不重跑同一验收。
- 双端 typecheck、E2E 配对检查此前通过；QA 端口已释放，用户本地 `:5174` 保留。详细命令与报告路径见 docs/26、docs/08 cp121。G7-03 仍 partial（更广 T-AW28 矩阵、未批准的 32MiB 成功 SLA）；G6/G7/G8 仍 11 项 partial，全局 37 partial/11 unchecked。HC-01～31/H-01～09 未动；不 push/deploy。`docs/AI_HANDOFF.md` 为本地忽略文件，不纳入提交。

## 2026-11-07 DEV-QA26 checkpoint 122 handoff

- G7-03 direct multipart size boundary: `go test -p 1 -count=3 -run '^TestAW11DocumentUploadLimitAppliesToDirectMultipartRequests$' -timeout=4m -v ./internal/app` passed 3/3 in 5.629s. `agentImageBytes+1` returns 422 `agent_attachment_invalid`; no `agent_attachment` DB row. Log `.playwright-results/qa26-g7-03-direct-size-r2-20261107.log`.
- External DOCX root relationship canary passed in true Windows Electron 3/3 (2.4m) and Web Chromium 3/3 (2.6m), each 20 uploads per run. Specified loopback canary hits=0; 20 attachment rejection POSTs per run; conversation/message writes=0. Per-run p50/p95 metrics and full commands are in docs/26 cp122. `.last-run.json` status passed/0 failed for both endpoints.
- Web and desktop typechecks and E2E pair guard passed (Web123/Desktop87/36 pairs); test endpoints ran sequentially and QA ports were released. Scope proves this DOCX relationship is rejected before contacting its loopback target, not formal isolation across every network/resource type. No product code changed; only E2E and direct multipart regression test were added. G7-03 remains partial for the broader T-AW28 matrix and unapproved 32MiB success SLA. Target count remains 11 partial, global 37 partial/11 unchecked. No HC/H changes, push, or deploy.

## 2026-11-07 DEV-QA26 checkpoint 123 handoff

- Added paired exact CSV parser-boundary E2Es after confirming existing evidence covered ordinary input and over-limit rejection but not exact max success: 10,000 rows ×100 columns, 2,000,000 bytes. Each endpoint ran 3 rounds ×20 native UI filechooser uploads; every upload returned ready with exact API/UI receipt, 20,000 injected chars and remaining-range truncation; all 20 attachments per round were individually deleted and original-file GET returned 404. Conversation/message writes=0 and send stayed disabled.
- Windows native Electron: 3 passed, 5.4m, per-round p50/p95 4938.89/5098.13, 4889.63/5103.15, 4939.19/5120.03ms; report `.playwright-results/qa26-g7-03-csv-max-electron-r1-20261107/.last-run.json`, log same prefix `.log`. Web Chromium: 3 passed, 5.5m, per-round p50/p95 4939.78/5144.67, 4906.69/5663.98, 4889.37/5086.65ms; report/log `.playwright-results/qa26-g7-03-csv-max-web-r1-20261107`. Full commands in docs/26 and docs/08 cp123.
- Web and Electron runs were sequential. Web had released QA services/ports before Electron started; Electron completed and released its ports. Existing user `:5174` stayed untouched. Previous web/desktop typechecks and pair guard passed. G7-03 remains partial for broader T-AW28 matrix and unapproved 32MiB DOCX success SLA; 11 target partial rows and global 37 partial/11 unchecked unchanged. No HC/H change, push, or deploy. Existing unrelated dirty/untracked state is preserved; this ignored local handoff is not staged.
- Task commit: `c891a767 DEV-QA26: 验收CSV最大解析边界` (only paired E2Es and docs/08, docs/26); no push/deploy. Final QA port check found no test ports; existing Electron/Vite `:5174` is still listening and was left untouched.

## 2026-11-07 DEV-QA26 checkpoint 124 handoff

- Read-only G7 subagent confirmed a narrow T-AW28 gap: PDF had encrypted/scanned/page-limit cases but no damaged PDF through the real filechooser. Added a paired negative E2E that corrupts the catalog page-tree reference in a valid fixture and asserts no `/Encrypt`, 422 parser error, visible damaged-PDF card, disabled send, zero conversation/message writes, and per-item removal.
- True Windows Electron: 3 rounds ×20 uploads, 3 passed in 2.3m; p50/p95=1836.61/2032.02, 1840.36/1996.82, 1854.95/2082.44ms. Web Chromium: 3 rounds ×20, 3 passed in 2.6m; p50/p95=1865.92/2455.74, 2275.88/2491.20, 1874.89/2604.46ms. Logs and reports are `.playwright-results/qa26-g7-03-corrupt-pdf-{electron,web}-r1-20261107[.log|/ .last-run.json]`; exact commands in docs/26 and docs/08 cp124.
- Tests ran sequentially after port/process checks. QA ports are free and the user's Electron/Vite `:5174` remains running. G7-03 remains partial for broader T-AW28 scope and unapproved 32MiB DOCX success SLA; 11 target partial rows and global 37 partial/11 unchecked remain. No product code, HC/H tests, push, or deployment changed.
- Task commit: `780f0562 DEV-QA26: 验收损坏PDF拒绝边界`; only paired E2E plus docs/08 and docs/26 were committed. No push/deploy; all pre-existing dirty/untracked files remain untouched.

## 2026-11-07 DEV-QA26 checkpoint 125 handoff

- Read-only G8-02 source review confirms native notification dispatch requires the per-user opt-in, Electron support, and Notification.permission === 'granted'; existing tests stub permission states. No OS permission state was changed and no permission prompt was activated. The computer-use skill forbids changing Windows security/privacy settings or acting on those prompts, so actual Windows toast/revocation remains unverified; do not treat stub evidence as native OS proof. Existing docs/26 and docs/08 status remains partial; no code or committed files changed in this checkpoint.

## 2026-11-07 DEV-QA26 checkpoint 126 handoff

- 三个只读验收代理实际并行完成：`g8_remaining`（G8 设置页）、`g6_remaining`（G6 复盘）、`g7_remaining`（G7 智能体）。G8 六项设置 4 通过/2 部分/0 未验证；G6 9 项 6/3/0；G7 15 项 11/4/0。各代理核对 docs/26、docs/08、交接及源码/E2E 后未发现新固定范围、可安全执行且不重复的本地缺口；本轮测试命令=无、测试耗时=0，未改代码。既有代表命令、耗时和报告路径见 docs/26 cp102、cp108、cp120–124 与各矩阵行。
- 当前组内 11 个唯一部分项保持：G6-03/04/09、G7-03/07/08/09、G2-04、G8-02/08/09。真实公众号 API/数据、真实模型/provider/费用与质量、外部 SMTP/收件箱、Windows 通知中心权限、实体触控、物理 IME/读屏需要外部环境；G7-07 内部竞态不能经授权 API 路径构造；G7-03 更广 T-AW28 交叉样本需先固定，32MiB 成功 SLA 未批准。不得据 mock 宣称真实质量通过，也不绕锁或提升解析限制。
- `docs/06` 与 `docs/90` 已由提交 `9cafd218` 同步 D-168：回收站保留启动轮及每 10 分钟清理，本 checkpoint 不重复改写。截图附件不可读，无法按截图 PID 断定运行 3小时22分钟的 overlay 任务身份/进展；进程与 QA 端口核对未见 overlay/Playwright runner，用户本地 `pnpm start`/`:5174` 保留；未停止、重启或重复启动任务。
- 主工作树保留所有既有 dirty/untracked；本批仅 docs/08、docs/26 checkpoint 125 提交为 `ab05faec`，AI_HANDOFF 仍为本地 ignored 文件。HC-01～31/H-01～09 未触碰，不 push/deploy。

## 2026-11-07 DEV-QA26 checkpoint 127 handoff

- 由 cp1038 明确的“宏与解压资源边界缺少交叉样本”继续 G7-03：双端 `agent-documents.spec.ts` fixture 新增 macroEnabled 参数，并真实文件选择器上传展开量 96 MiB+1（100,663,297 bytes）、压缩原件 99,055-byte 的 DOCX。桌面 Electron 3/3，34.4s；Web Chromium 3/3，33.4s；每轮 422 `agent_attachment_parse_failed`、UI 拒绝、发送禁用、0 conversation/message 写入，逐项移除。`.last-run.json` 位于 `.playwright-results/qa26-g7-03-macro-expanded-{electron-r2,web-r1}-20261107/`。完整命令见 docs/26 cp126。
- 桌面/Web typecheck 与 E2E 配对守卫通过（Web123/桌面87/36对）。测试串行执行；结束后 QA ports 空闲、`ops_e2e` 与 `ops_e2e_desktop_ui` 无活动连接。完整三轮 `upload_ms` 没有持久化，故不报告 p50/p95，不为补采重跑。首条选择器因正则 `+` 未匹配，`No tests found`、未启动 Electron；`--list` 后改用无元字符 grep 成功，不计验收失败。
- 无产品代码、API、解析限额或超时改变。G7-03 仍部分验证：更广 T-AW28 交叉矩阵尚未固定，32MiB 成功 SLA 未批准。任务只包含双端 `agent-documents.spec.ts` 与 docs/08、docs/26，提交 `00f0d61 DEV-QA26: 验收宏与解压上限交叉边界`。HC/H 红线不动，不 push/deploy；保留所有既有 dirty/untracked 与本地忽略的 handoff。

## 2026-11-07 DEV-QA26 checkpoint 128 handoff

- G7-03 补充 DOCX 嵌入对象/外部 relationship × `96 MiB+1` 展开量双端交叉拒绝：真实 Windows Electron 3/3、38.8s；Web Chromium 3/3、44.5s；422/UI 可见、逐项移除、发送禁用、conversation/message=0。按样本 n=3 最近秩 p50/p95：Electron embedded 1966.75/2271.73ms、external 1894.86/1894.86ms；Web embedded 2353.10/2537.49ms、external 2476.62/2671.31ms。日志/报告见 docs/26 cp127。
- 测试命令、隔离检查与 E2E 配对/typecheck 结果见 docs/08 cp127。E2E 串行，无 QA 端口残留；用户 `:5174` 保持原样。双端 fixture/test 与 docs/08、docs/26 应作为一个 DEV-QA26 任务提交；本 handoff 是本地忽略状态，不纳入提交。
- G7-03 仍部分验证（T-AW28 更广范围待固定、32 MiB 成功 SLA 未批准）；目标 11 项部分验证、全局 37 项部分/11 项未检查不变。无产品逻辑、HC/H、真实模型/平台、push/deploy 改动。

## 2026-11-07 DEV-QA26 checkpoint 129 handoff

- G7-03 新增双 payload XML DOCX 累计展开超限：每条均低于 96 MiB，总量 96 MiB+1；Go WASI parser 1/1、Electron/Web 真实 filechooser 各 3/3 通过，每轮各 20 次上传、全部 422 且无 conversation/message 写入。每轮 p50/p95、完整命令与报告路径见 docs/26 cp128；专项 Go 日志 `.playwright-results/qa26-g7-03-aggregate-expanded-parser-r1-20261107.log`。
- 双端 typecheck、E2E 配对守卫、`--list` 与 `git diff --check` 通过；QA 端口释放，用户 `:5174` 保留。Docs/08 与 docs/26 cp128 已登记；G7-03 更广 T-AW28 范围和未批准的 32 MiB 成功 SLA 仍部分验证。提交 `7f2b698 DEV-QA26: 验收DOCX跨条目累计解压上限`，仅含双端附件 E2E、Go parser 回归测试及 docs/08、docs/26；不 push/deploy。

## 2026-11-07 DEV-QA26 checkpoint 130 handoff

- 三个只读代理已实际并行完成：`g8_remaining`（G8 设置页）、`g6_remaining`（G6 复盘）、`g7_remaining`（G7 智能体）；开始前按 docs/26、docs/08、docs/AI_HANDOFF 核对，未重跑旧验收、未改文件。G8 六项 4 通过/2 部分/0 未验证；G6 九项 6/3/0；G7 十五项 11/4/0。它们指出可定向补验为 G7-03 跨 ZIP 条目总展开限制和 G7-10 独立模型“测试”按钮；其余目标组未见固定范围的本地新缺口。
- G7-03 两条低于 96 MiB 的 XML payload 合计 `96 MiB+1` 样本，Go WASI parser 专项 1/1、Electron/Web filechooser 各 3/3 通过，三轮各 n=20，均 422、无 conversation/message 写入；详见 docs/26、docs/08 cp128。提交 `7f2b698 DEV-QA26: 验收DOCX跨条目累计解压上限`。
- G7-10 真实 Electron 与 Web “测试”按钮各 3/3；每轮成功点击 20 次并测试一次本机 401 key-echo 失败；成功/失败状态服务端持久化、重载恢复，错误与密钥均正确脱敏。完整命令、所有 per-run p50/p95、首轮测试定位器误断言及修复复跑见 docs/26、docs/08 cp129。提交 `bbac9f1 DEV-QA26: 验收模型连通测试双端流程`。
- 双端 `pnpm typecheck`、E2E 配对守卫（Web123/桌面87/36 对）、Go 专项测试、目标 `--list` 与 `git diff --check` 通过。所有 E2E 串行；QA ports 最终释放，用户 `:5174` PID 19896 保持。overlay 截图附件仍无法读取，进程核查未见 overlay/Playwright runner；无法把旧截图中的约 3小时22分实例与当前 PID 对上，未停止/重启/重复启动它。
- G6/G7/G8/G2 目标范围仍有 11 项部分验证：G6-03/04/09（真实平台/模型质量与费用）、G7-03（T-AW28 更广矩阵范围待固定、32 MiB 成功 SLA 未批准）、G7-07（受锁和会话唯一约束，授权 API 不可构造直接预算判定竞态）、G7-08/09（真实 provider、生产计费/时钟/网络、模型质量/费用）、G2-04（真实 SMTP/收件箱）、G8-02/08/09（原生 OS 通知权限、物理触控、IME/屏幕阅读器）。当前没有这些范围内可直接执行且已经固定、尚未重复的本地验收项；全局矩阵仍 37 部分/11 未检查。所有改动按任务分开提交，未 push/deploy；HC-01～31/H-01～09 未修改、跳过或放宽。
