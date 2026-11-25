import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path) => readFileSync(join(root, path), 'utf8')
const agent = ['pages/Agent.tsx', 'pages/agent/AgentMessageStream.tsx', 'pages/agent/AgentComposer.tsx', 'pages/agent/AgentDialogs.tsx', 'pages/agent/useAttachmentQueue.ts'].map(read).join('\n')
const header = read('pages/agent/ConversationHeader.tsx')
const workbench = read('pages/agent/Workbench.tsx')
const tabs = read('pages/agent/PanelTabs.tsx')
const list = read('pages/agent/ConversationList.tsx')
const actions = read('pages/agent/ActionCards.tsx')
const timeline = read('pages/agent/AgentRunTimeline.tsx')
const composer = read('pages/agent/ComposerCandidates.tsx')
const inBrowse = read('pages/agent/InBrowsePanel.tsx')
const browserBar = read('pages/agent/BrowserControlBar.tsx')
const artifact = read('pages/agent/ArtifactPanel.tsx')
const css = read('styles/desktop-agent-v2.css')
const shell = read('layout/Shell.tsx')

test('UI-04：Agent 页面源码不再出现 10/10.5/11px 字号', () => {
  const files = [agent, read('pages/agent/MessageChrome.tsx'), read('pages/agent/PlansQuestions.tsx'), list, header, workbench, actions,
    read('pages/agent/AgentMessageStream.tsx'), read('pages/agent/AgentComposer.tsx'), read('pages/agent/AgentDialogs.tsx')]
  for (const source of files) {
    assert.equal(/text-\[(10|10\.5|11)px\]/.test(source), false)
  }
  const sizes = [...css.matchAll(/font-size:\s*([0-9.]+)px/g)].map((match) => Number(match[1]))
  assert.ok(sizes.length > 0)
  assert.equal(sizes.some((size) => size < 12), false, `字号低于 12px：${sizes.filter((size) => size < 12).join(',')}`)
  const legacy = read('styles/desktop-creative.css').split('\n')
    .filter((line) => line.includes('.desktop-agent') && /font-size:\s*(10|10\.5|11)px/.test(line))
  assert.deepEqual(legacy, [], 'desktop-creative.css 里 Agent 选择器仍有低于 12px 的字号')
})

test('UI-04：工作区与消息流走 --ops-canvas，不再保留纯白阅读面', () => {
  // 38 §19 风险表 2026-11-17 用户裁决 A：消息列不做纯白卡面，消息区随工作区走 --ops-canvas。
  assert.equal(/bg-\[#f7f8f6\]/.test(agent), false, 'Agent.tsx 工作区仍硬编码 #f7f8f6')
  assert.match(agent, /bg-\[var\(--ops-canvas\)\]/)
  const creative = read('styles/desktop-creative.css')
  assert.equal(/\.desktop-agent-chat-stream\s*\{[^}]*background:\s*#ffffff/.test(creative), false, '消息流仍硬编码白色')
  assert.match(creative, /\.desktop-agent-chat-stream\s*\{[^}]*background:\s*var\(--ops-canvas\)/, '旧布局消息流应走 --ops-canvas')
  assert.match(creative, /\.desktop-agent-workbench \.desktop-agent-chat-stream\s*\{[^}]*background:\s*var\(--ops-canvas\)/, '工作台消息流应走 --ops-canvas')
  assert.equal(/\.desktop-agent-chat-stream\s*\{[^}]*background:\s*var\(--ops-surface\)/.test(creative), false, '消息流不应再使用白面令牌')
  assert.equal(/\.desktop-agent-workbench \.desktop-agent-message-column\s*\{[^}]*background/.test(creative), false, '消息列不应再叠白色卡面')
})

test('UI-01：会话头 56px、隐私浮层、用量 chip、任务面板 aria', () => {
  assert.match(css, /\.desktop-agent-header\s*\{[^}]*height:\s*56px/)
  assert.match(header, /仅你可见/)
  assert.match(header, /团队成员不能读取消息、附件与产物/)
  assert.match(header, /aria-expanded=\{privacyOpen\}/)
  assert.match(header, /aria-controls="agent-privacy-popover"/)
  assert.match(header, /formatTokens\(state\.usage\.tokens\)/)
  assert.match(header, /aria-controls="agent-workbench-panel"/)
  assert.match(header, /任务面板/)
  assert.match(header, /PanelRight/)
  assert.equal(header.includes('Settings2'), false)
  assert.match(agent, /ConversationHeader state=\{headerState\}/)
})

test('UI-02：空对话不打开面板、Workbench 有关闭按钮', () => {
  assert.match(agent, /shouldAutoOpenPanel/)
  assert.match(workbench, /关闭任务面板/)
  assert.match(workbench, /id="agent-workbench-panel"/)
})

test('UI-03：四个页签、键盘切换、aria-controls、无第五页签', () => {
  const tabIDs = [...workbench.matchAll(/\{ id: '(task|context|artifact|browser)' as const/g)].map((match) => match[1])
  assert.deepEqual(tabIDs.sort(), ['artifact', 'browser', 'context', 'task'])
  assert.equal(/id: 'review'/.test(workbench), false)
  assert.match(tabs, /ArrowRight/)
  assert.match(tabs, /Home/)
  assert.match(tabs, /aria-controls=\{`agent-panel-/)
  assert.match(workbench, /<PanelTabs/)
  assert.match(header, /aria-controls="agent-workbench-panel"/)
})

test('UI-06：三张运营卡只填输入框，摘要一行', () => {
  assert.match(agent, /帮我找选题/)
  assert.match(agent, /改一篇作品/)
  assert.match(agent, /先定发布计划/)
  assert.match(agent, /onPrompt\(card\.prompt\)/)
  assert.match(agent, /今天 \$\{pendingActions \+ pendingQuestions\} 项待处理/)
  assert.match(css, /\.desktop-agent-welcome-card\s*\{[^}]*height:\s*160px/)
})

test('UI-07 / FN-01：会话行 52px、状态词与账号优先、未读点独立', () => {
  assert.match(css, /\.desktop-agent-conv-row\s*\{[^}]*height:\s*52px/)
  assert.match(list, /conversationRowState/)
  assert.match(list, /item\.account_name/)
  assert.match(list, /desktop-agent-conv-unread/)
  assert.match(list, /desktop-agent-conv-row-pending/)
  assert.match(list, /variant=\{desktopPresentation \? 'secondary' : 'primary'\}/)
})

test('UI-10：空/加载/失败/禁用四态统一组件', () => {
  const state = read('pages/agent/StateBlock.tsx')
  for (const tone of ['empty', 'loading', 'error', 'disabled']) assert.match(state, new RegExp(`'${tone}'`))
  assert.match(css, /\.desktop-agent-state-disabled[^}]*opacity:\s*0\.45/)
})

test('FN-03：运行轨迹聚合业务步骤且不展示参数', () => {
  assert.match(timeline, /buildRunTimeline/)
  assert.equal(timeline.includes('result_preview'), false)
  assert.match(timeline, /timeline\.status !== 'done'/)
  assert.match(agent, /<AgentRunTimeline/)
})

test('FN-04：消息卡片只读摘要，审阅抽屉唯一实例', () => {
  assert.match(actions, /ActionSummaryCard/)
  assert.match(actions, /查看修改/)
  const summary = actions.slice(actions.indexOf('function ActionSummaryCard'), actions.indexOf('function ActionCard'))
  assert.equal(summary.includes('gateLabel('), false)
  assert.equal(summary.includes('executeLabel('), false)
  assert.equal(summary.includes('onExecute'), false)
  assert.match(actions, /desktop-agent-review-overlay/)
  assert.match(agent, /reviewActionID=\{reviewActionID\}/)
  // FN-04：草稿存在对话页并按 actionId 保留，关闭抽屉不卸载丢失；切换卡片先问保留/丢弃。
  assert.match(actions, /const \[drafts, setDrafts\]/)
  assert.match(actions, /reviewDraft=\{reviewDraft\}/)
  assert.match(actions, /pendingReviewID/)
  assert.match(actions, /shouldPromptDraftSwitch/)
  assert.match(actions, /保留草稿/)
  assert.match(actions, /丢弃草稿/)
})

test('TL-03：执行只逐卡确认，无批量/全部执行入口，执行回调按单张卡片绑定', () => {
  // 红线（AGENTS.md D-117）：不新增“全部执行/批量执行/全部起草”按钮或接口。
  for (const source of [agent, actions, workbench]) {
    assert.equal(/全部执行|批量执行|全部起草|executeAll|executeBatch|batchExecute/.test(source), false, '出现批量执行入口')
  }
  // 执行入口只在 ActionCard（含审阅形态）内部，每张卡绑定自己的 onExecute；不存在对列表的统一执行函数。
  assert.match(actions, /onExecute=\{\(request\) => decide\(action, request\)\}/)
  assert.match(actions, /onExecute=\{\(request\) => decide\(reviewAction, request\)\}/)
})

test('IX-01/02/03：一个浮层三种触发器，组字中不打开', () => {
  assert.match(composer, /trigger\.kind === 'at'/)
  assert.match(composer, /trigger\.kind === 'slash'/)
  assert.match(composer, /trigger\.kind === 'skill'/)
  assert.match(agent, /detectComposerTrigger/)
  assert.match(agent, /onCompositionStart/)
  assert.match(agent, /addToLimitedList\(contextRefs, item, 12/)
  assert.match(agent, /addToLimitedList\(skillRequests, item, 3/)
})

test('UI-08 / BR-01：应用内与 Chrome 协作分段，不叠加两个视图', () => {
  assert.match(workbench, /desktop-agent-segmented/)
  assert.match(workbench, /应用内/)
  assert.match(workbench, /Chrome 协作/)
  assert.match(workbench, /useState<'inapp' \| 'chrome'>\('inapp'\)/)
  assert.match(workbench, /latestBrowserActivity\(messages\)/)
  assert.match(workbench, /setBrowserMode\('chrome'\)/)
  // D-224（OPT-S02）：浏览器页签随 browser_workspace 软冻结，仅在 showBrowserTab 为真时挂载。
  assert.match(workbench, /const showBrowserTab = browserWorkspaceEnabled/)
  assert.match(workbench, /showBrowserTab \? \[\{ id: 'browser' as const/)
  assert.match(workbench, /tab === 'browser' && showBrowserTab/)
  const browserTab = workbench.slice(workbench.indexOf("tab === 'browser'"), workbench.indexOf('</aside>'))
  assert.equal((browserTab.match(/<InBrowsePanel/g) || []).length, 1)
})

test('BR-03：元素选择入口、结果面板与文本上下文，且只属于应用内', () => {
  assert.match(inBrowse, /data-testid="inbrowse-pick-element"/)
  assert.match(inBrowse, /'inbrowse:pick-element'/)
  assert.match(inBrowse, /data-testid="inbrowse-picked-selector"/)
  assert.match(inBrowse, /data-testid="inbrowse-picked-text"/)
  assert.match(inBrowse, /ops:agent-page-element/)
  assert.match(inBrowse, /pickerErrorLabel/)
  assert.match(inBrowse, /密码框/)
  assert.match(agent, /ops:agent-page-element/)
  // 唯一 InBrowsePanel 挂在应用内分支；Chrome 协作分支只有状态块与标签列表，没有选择入口。
  const browserTab = workbench.slice(workbench.indexOf("tab === 'browser'"), workbench.indexOf('</aside>'))
  assert.equal((browserTab.match(/<InBrowsePanel/g) || []).length, 1)
  assert.match(browserTab, /browserMode === 'chrome' \? <div className="desktop-agent-browser-body">/)
  assert.match(browserTab, /<BrowserStatusBlock/)
  assert.equal(/<InBrowsePanel[^>]*inbrowse-pick-element/.test(browserTab), false)
})

test('BR-11：选中元素 + 一句批注只生成输入台引用，不自动发送', () => {
  assert.match(inBrowse, /ops:agent-page-annotation/)
  assert.match(inBrowse, /width: 280/)
  assert.match(inBrowse, /data-testid="inbrowse-picked-note"/)
  assert.match(inBrowse, /data-testid="inbrowse-picked-annotate-save"/)
  assert.match(agent, /ops:agent-page-annotation/)
  assert.match(agent, /data-testid="agent-page-reference-chip"/)
  assert.match(agent, /pageReferenceText\(pageRefs\)/)
  assert.match(agent, /【页面引用】/)
  // 页面引用不进服务端 context_refs：发送时拼进正文，避免伪造未注册的引用类型。
  assert.doesNotMatch(agent, /type: 'page_element'.*context_refs/)
})

test('FN-08：版本 + 选段反馈引用 + 选区导出，不自动发送', () => {
  assert.match(artifact, /data-testid="artifact-feedback-open"/)
  assert.match(artifact, /data-testid="artifact-feedback-form"/)
  assert.match(artifact, /data-testid="artifact-feedback-submit"/)
  assert.match(artifact, /data-testid="artifact-save-selection"/)
  assert.match(artifact, /【产物反馈/)
  assert.match(artifact, /artifact_id: item\.artifact\.id/)
  assert.match(artifact, /anchor: \{ start, end, quote_hash: hash, quote \}/)
  assert.match(artifact, /onQuote\(ref, '请基于引用的产物选段继续分析。'\)/)
  assert.match(artifact, /onQuote\(feedbackRef, prompt\)/)
})

test('BR-08：浏览器控制条 36 高，停止/接管/交回接真实租约', () => {
  assert.match(browserBar, /h-9/)
  assert.match(browserBar, /data-testid="browser-control-bar"/)
  assert.match(browserBar, /data-testid="browser-control-stop"/)
  assert.match(browserBar, /data-testid="browser-control-takeover"/)
  assert.match(browserBar, /data-testid="browser-control-handback"/)
  assert.match(browserBar, /grantReady/)
  assert.match(browserBar, /data-testid="browser-control-takeover" disabled=\{!grantReady\}/)
  assert.match(workbench, /<BrowserControlBar/)
  assert.match(workbench, /step=\{browserStep\}/)
  assert.match(agent, /agent\/conversations\/\$\{conversationId\}\/browser-handoff/)
  assert.match(agent, /agent\/conversations\/\$\{conversationId\}\/browser-handback/)
  assert.match(agent, /onBrowserTakeOver/)
  assert.match(agent, /onBrowserHandBack/)
})

test('G-01：全局菜单分组与 AI 对话入口保持原样', () => {
  for (const group of ['创作', '资源', '运营']) assert.match(shell, new RegExp(`label: '${group}'`))
  assert.match(shell, /label: 'AI 对话'/)
  assert.match(shell, /label: '工作台'/)
  assert.match(shell, /label: '选题池'/)
  assert.match(shell, /label: '内容日历'/)
  assert.match(shell, /label: '素材库'/)
  assert.match(shell, /label: '图片库'/)
  assert.match(shell, /label: '账号档案'/)
  assert.match(shell, /label: '复盘'/)
})

test('UI-05：新对话样式只新增尺寸变量，不引入紫色或新强调色', () => {
  const variables = [...css.matchAll(/(--[a-z-]+)\s*:/g)].map((match) => match[1])
  assert.ok(variables.length > 0)
  assert.ok(variables.every((name) => name.startsWith('--agent-')), `出现非尺寸变量：${variables.join(',')}`)
  assert.ok(!/purple|violet|magenta/i.test(css), '新样式出现紫色字面量')
  assert.ok(!/--(ops-)?[a-z-]*accent[a-z-]*\s*:/i.test(css), '新样式重复定义强调色变量')
})
