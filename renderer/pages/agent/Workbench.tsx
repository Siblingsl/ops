import { LoaderCircle, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button, IconButton, Textarea } from '@/components/ui'
import { errorMessage } from '@/lib/api'
import { browserModeSummary, latestBrowserActivity, skillStateLabel } from '@/lib/agent-ui.js'
import { trackAgentEvent } from '@/lib/agent-telemetry-client'
import { PanelTabs } from '@/pages/agent/PanelTabs'
import { StatusChip } from '@/pages/agent/StatusChip'
import {
  type AgentBootstrap, type AgentConversation, type AgentConversationDetail, type AgentInput, type AgentMessage,
} from '@/lib/agent'
import { ArtifactPanel } from '@/pages/agent/ArtifactPanel'
import { type BrowserGrantView } from '@/pages/agent/BrowserTabAuthorizeDialog'
import { BrowserControlBar } from '@/pages/agent/BrowserControlBar'
import { PendingList, collectPendingEntries } from '@/pages/agent/PendingList'
import { BrowserStatusBlock, useBrowserConnectState } from '@/pages/agent/BrowserStatusBlock'
import { BrowserTabSelector } from '@/pages/agent/BrowserTabSelector'
import { type AgentContextSelection, type AgentSkillSelection } from '@/pages/agent/ContextPickers'
import { DelegationPanel } from '@/pages/agent/DelegationPanel'
import { GoalPanel } from '@/pages/agent/GoalPanel'
import { InBrowsePanel } from '@/pages/agent/InBrowsePanel'
import { MemoryOverrideSwitch } from '@/pages/agent/MemoryOverrideSwitch'
import { SourcePanel } from '@/pages/agent/SourcePanel'

export type WorkbenchTab = 'task' | 'context' | 'artifact' | 'browser'

export function WorkbenchSidePanel({
  tab, setTab, close, width, browserWorkspaceEnabled, subagentsEnabled, conversation, activeRun, busy, pendingActions, pendingQuestions, actionCount, artifactCount, selectedAccountName, selectedModelName, attachmentCount,
  contextRefs, skillRequests, latestSkillUsage, artifactsEnabled, goalsEnabled, compactEnabled, canManageGoals, models, goal, onCompact, actions, questions, inputs, inputQueuePaused, onUpdateInput, onCancelInput, onRestoreInput, onResumeInputs, onQuoteArtifact, memoryFeaturesEnabled, onEmptyGoal, onEmptyContext, onOpenEvidence, messages,
  browserGrant, browserPaused, onBrowserTakeOver, onBrowserHandBack, onStopRun,
}: {
  tab: WorkbenchTab; setTab: (tab: WorkbenchTab) => void; close: () => void; width?: number; browserWorkspaceEnabled: boolean; subagentsEnabled?: boolean
  conversation?: AgentConversation; activeRun?: AgentConversationDetail['active_run']; busy: boolean; pendingActions: number; pendingQuestions: number; actionCount: number
  artifactCount: number
  selectedAccountName: string; selectedModelName: string; attachmentCount: number
  contextRefs: AgentContextSelection[]; skillRequests: AgentSkillSelection[]; latestSkillUsage: AgentMessage['skill_usage']; artifactsEnabled: boolean
  goalsEnabled: boolean; compactEnabled: boolean; canManageGoals: boolean; models: AgentBootstrap['models']; goal?: AgentConversationDetail['goal']; onCompact: () => Promise<unknown>
  actions: AgentConversationDetail['actions']
  questions: AgentConversationDetail['questions']
  inputs: AgentInput[]; inputQueuePaused: boolean
  onUpdateInput: (input: AgentInput, text: string) => Promise<void>; onCancelInput: (input: AgentInput) => Promise<void>
  onRestoreInput: (input: AgentInput) => Promise<void>; onResumeInputs: () => Promise<void>
  onQuoteArtifact: (ref: AgentContextSelection, prompt: string) => void
  memoryFeaturesEnabled: boolean
  onEmptyGoal: () => void
  onEmptyContext: () => void
  // FN-05：目标证据定位回调（可选）。
  onOpenEvidence?: (ref: { kind: string; id: string }) => void
  messages: AgentMessage[]
  // BR-08：浏览器控制条（接管/交回依赖真实 30 秒租约句柄）。
  browserGrant?: BrowserGrantView | null
  browserPaused?: boolean
  onBrowserTakeOver?: () => void
  onBrowserHandBack?: () => void
  onStopRun?: () => void
}) {
  const [editingInputID, setEditingInputID] = useState('')
  const [editingInputText, setEditingInputText] = useState('')
  const [inputBusyID, setInputBusyID] = useState('')
  const [browserMode, setBrowserMode] = useState<'inapp' | 'chrome'>('inapp')
  const [inappTabs, setInappTabs] = useState(0)
  // OT-04：浏览器模式只记录 inapp/chrome，不记录地址、页面标题或内容。
  useEffect(() => { trackAgentEvent('agent_browser_mode', browserMode) }, [browserMode])
  const browserActivity = latestBrowserActivity(messages)
  // BR-08：当前这一轮已发生的 browser_* 步数（不跨用户消息累计，不编造总步数）。
  const browserStep = (() => {
    let step = 0
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message.role === 'user') break
      for (const call of message.tool_calls ?? []) {
        if (typeof call.name === 'string' && call.name.startsWith('browser_') && call.name !== 'browser_request_tab') step += 1
      }
    }
    return step
  })()
  const lastBrowserActivityID = useRef('')
  // BR-01：Agent 开始新的 browser_* 操作时自动切到 Chrome 分段；用户随后手动切回
  // 应用内不会被立刻抢回，直到下一次操作开始。
  useEffect(() => {
    if (!browserActivity || browserActivity.id === lastBrowserActivityID.current) return
    lastBrowserActivityID.current = browserActivity.id
    setBrowserMode('chrome')
  }, [browserActivity])
  // 深化 4/5：委派结果「查看产物」要落到具体产物，而不是只切页签。
  const [focusArtifactID, setFocusArtifactID] = useState('')
  useEffect(() => setFocusArtifactID(''), [conversation?.id])
  const browserConnectState = useBrowserConnectState(browserWorkspaceEnabled)
  // D-224（OPT-S02）：浏览器工作视图随 browser_workspace 开关软冻结；默认关闭时不出现页签。
  const showBrowserTab = browserWorkspaceEnabled
  useEffect(() => {
    if (!showBrowserTab && tab === 'browser') setTab('task')
  }, [showBrowserTab, tab, setTab])
  const browserSummary = browserModeSummary(browserMode, {
    paired: browserConnectState.kind === 'paired' ? browserConnectState.bindings.length : 0,
    authorizing: false,
  })
  const tabs = [
    { id: 'task' as const, label: '任务', count: pendingActions + pendingQuestions },
    { id: 'context' as const, label: '上下文', count: contextRefs.length + skillRequests.length },
    ...(artifactsEnabled ? [{ id: 'artifact' as const, label: '产物', count: artifactCount }] : []),
    // D-224（OPT-S02）：浏览器页签仅在 browser_workspace 开启时出现；连接状态仍由 BrowserStatusBlock 如实表达（不伪造已连接）。
    ...(showBrowserTab ? [{ id: 'browser' as const, label: '浏览器', count: browserMode === 'chrome' && browserConnectState.kind === 'paired' ? browserConnectState.bindings.length : inappTabs }] : []),
  ] as const
  const taskStatus = busy ? '正在运行' : pendingActions ? `等待你逐张处理 ${pendingActions} 项` : conversation ? '当前没有运行中的任务' : '发送第一条消息后，这里会显示对话任务状态'
  return <aside id="agent-workbench-panel" className="desktop-agent-side-panel" style={width ? { width, flexBasis: width } : undefined} data-testid="desktop-agent-side-panel" aria-label="任务面板">
    <header className="desktop-agent-side-panel-heading">
      <div className="desktop-agent-side-heading-row"><h2>任务面板</h2><IconButton label="关闭任务面板" onClick={close}><X className="size-4" /></IconButton></div>
      <PanelTabs tabs={[...tabs]} tab={tab} setTab={(value) => setTab(value as WorkbenchTab)} />
    </header>
    <div role="tabpanel" id={`agent-panel-${tab}`} aria-labelledby={`agent-panel-tab-${tab}`} className="desktop-agent-side-content">
      {tab === 'task' && <section aria-labelledby="workbench-task-heading">
        {!conversation && <div className="desktop-agent-panel-empty" role="group" aria-label="任务面板空态">
          <p>{showBrowserTab ? '这个对话还没有任务。先定一个目标、引用资料，或查看浏览器说明。' : '这个对话还没有任务。先定一个目标或引用资料。'}</p>
          <div>
            <Button type="button" size="sm" variant="secondary" onClick={() => { setTab('task'); onEmptyGoal() }}>设一个目标</Button>
            <Button type="button" size="sm" variant="secondary" onClick={onEmptyContext}>引用资料</Button>
            {showBrowserTab && <Button type="button" size="sm" variant="secondary" onClick={() => setTab('browser')}>打开浏览器说明</Button>}
          </div>
        </div>}
        <h3 id="workbench-task-heading">当前任务</h3>
        {/* FN-02：待你处理中心——卡片/问题统一列表，可定位到消息；空时不渲染。 */}
        <PendingList entries={collectPendingEntries(actions, questions ?? [])} />
        <p className="desktop-agent-side-status" role="status">{busy && <LoaderCircle className="size-4 animate-spin" />}{taskStatus}</p>
        {activeRun && <p className="desktop-agent-side-detail">运行状态：{activeRun.status === 'queued' ? '排队中' : '执行中'}</p>}
        {/* DEV-AI27-15（W15b UI）：协作任务折叠/展开/单项停止（D-224 软冻结：subagents 关闭时不挂载，也不轮询已冻结接口）。 */}
        {conversation && subagentsEnabled && <DelegationPanel conversationId={conversation.id} onNavigateArtifact={(artifactId) => { setFocusArtifactID(artifactId); setTab('artifact') }} />}
        {conversation && <p className="desktop-agent-side-detail">本对话操作卡片：{actionCount} 项</p>}
        <GoalPanel conversationID={conversation?.id} conversation={conversation} goal={goal} models={models} goalsEnabled={goalsEnabled} compactEnabled={compactEnabled} canManage={canManageGoals} busy={busy} onCompact={onCompact} onOpenEvidence={onOpenEvidence} />
        {pendingActions > 0 && <p className="desktop-agent-side-note">请在对应消息下逐张审阅操作卡片。</p>}
        {(inputs.some((input) => ['pending', 'needs_review'].includes(input.status)) || inputQueuePaused) && <section className="mt-4 space-y-2" aria-labelledby="workbench-inputs-heading">
          <div className="flex items-center justify-between gap-2"><h4 id="workbench-inputs-heading" className="text-xs font-semibold text-mist-700">补充与排队</h4>{inputQueuePaused && <Button type="button" size="sm" variant="outline" onClick={() => void onResumeInputs()}>恢复队列</Button>}</div>
          {inputQueuePaused && <p className="text-xs text-gamboge-700" role="status">队列已暂停。恢复后仍会逐条检查权限与待审阅卡片。</p>}
          <ul className="space-y-2">
            {inputs.filter((input) => ['pending', 'needs_review'].includes(input.status)).map((input) => <li key={input.id} className="rounded-lg border border-mist-200 bg-white p-2.5 text-xs" aria-busy={inputBusyID === input.id}>
              <div className="flex items-start justify-between gap-2"><div><strong className="text-mist-700">{input.status === 'needs_review' ? '本次已结束，待你复核' : input.kind === 'steer' ? '补充当前任务' : '排到下一条'}</strong><p className="mt-0.5 text-mist-500">修订 {input.revision}{input.error_code ? ` · ${input.error_code}` : ''}</p></div>
                {input.status === 'pending' && editingInputID !== input.id && <Button type="button" size="sm" variant="ghost" onClick={() => { setEditingInputID(input.id); setEditingInputText(input.text) }}>编辑</Button>}</div>
              {editingInputID === input.id
                ? <div className="mt-2 space-y-2"><Textarea aria-label="编辑排队输入" rows={3} value={editingInputText} onChange={(event) => setEditingInputText(event.target.value)} />
                    <div className="flex justify-end gap-2"><Button type="button" size="sm" variant="ghost" onClick={() => setEditingInputID('')}>取消</Button><Button type="button" size="sm" loading={inputBusyID === input.id} onClick={() => { setInputBusyID(input.id); void onUpdateInput(input, editingInputText).then(() => setEditingInputID('')).catch((error) => toast.error(errorMessage(error))).finally(() => setInputBusyID('')) }}>保存修改</Button></div></div>
                : <p className="mt-2 whitespace-pre-wrap break-words text-mist-700">{input.text || '仅包含附件或引用'}</p>}
              {(input.attachments.length > 0 || input.context_refs.length > 0 || input.skill_requests.length > 0) && <p className="mt-1 text-mist-500">{input.attachments.length ? `附件 ${input.attachments.map((item) => item.name).join('、')}` : ''}{input.context_refs.length ? ` · 引用 ${input.context_refs.length} 项` : ''}{input.skill_requests.length ? ` · 技能请求 ${input.skill_requests.length} 项` : ''}</p>}
              {input.status === 'needs_review' && <div className="mt-2 flex flex-wrap gap-2"><Button type="button" size="sm" onClick={() => { setInputBusyID(input.id); void onRestoreInput(input).finally(() => setInputBusyID('')) }}>移回输入框</Button><Button type="button" size="sm" variant="outline" disabled={inputBusyID === input.id} onClick={() => { setInputBusyID(input.id); void onCancelInput(input).catch((error) => toast.error(errorMessage(error))).finally(() => setInputBusyID('')) }}>丢弃</Button></div>}
              {input.status === 'pending' && editingInputID !== input.id && <div className="mt-2 flex justify-end"><Button type="button" size="sm" variant="ghost" disabled={inputBusyID === input.id} onClick={() => { setInputBusyID(input.id); void onCancelInput(input).catch((error) => toast.error(errorMessage(error))).finally(() => setInputBusyID('')) }}>撤回</Button></div>}
            </li>)}
          </ul>
        </section>}
        {actions.length > 0 && <div className="mt-3"><Button type="button" size="sm" variant="secondary" onClick={() => {
          const card = document.getElementById(`agent-action-${actions[0].id}`)
          card?.scrollIntoView({ behavior: 'smooth', block: 'center' })
          card?.focus({ preventScroll: true })
        }}>定位操作卡片</Button><p className="mt-2 text-xs text-mist-500">审阅和执行入口仅在消息中的这张卡片出现。</p></div>}
      </section>}
      {tab === 'context' && <section aria-labelledby="workbench-context-heading">
        <h3 id="workbench-context-heading">本对话设置</h3>
        <dl className="desktop-agent-context-list">
          <div><dt>操作账号</dt><dd>{selectedAccountName}</dd></div>
          <div><dt>模型</dt><dd>{selectedModelName}</dd></div>
          <div><dt>已发送附件</dt><dd>{attachmentCount} 个</dd></div>
          <div><dt>待发送引用</dt><dd>{contextRefs.length} 项</dd></div>
        </dl>
        {contextRefs.length > 0 && <ul className="mt-3 space-y-1 text-xs text-mist-600">{contextRefs.map((item) => <li key={`${item.type}:${item.id}`}>{item.name} · {item.reference_scope === 'conversation' ? '固定到对话' : '本轮引用'}</li>)}</ul>}
        {skillRequests.length > 0 && <section className="mt-4"><h4 className="text-xs font-semibold text-mist-600">已请求技能</h4><ul className="mt-1 space-y-1 text-xs text-mist-600">{skillRequests.map((item) => <li key={`${item.skill_id}:${item.work_id ?? ''}`} className={item.unavailable ? 'text-danger' : undefined}>{item.name} · {skillStateLabel({ requested: true, unavailable: item.unavailable })}</li>)}</ul></section>}
        {!!latestSkillUsage?.length && <section className="mt-4"><h4 className="text-xs font-semibold text-mist-600">本轮技能状态</h4><ul className="mt-1 space-y-1 text-xs text-mist-600">{latestSkillUsage.map((item) => <li key={item.id}>{skillStateLabel({ requested: true, loaded: item.loaded })} · {item.name}</li>)}</ul></section>}
        <p className="desktop-agent-side-note">选择、启用和加载是不同状态。只有 load_skill 成功回执才显示已加载；当前无法从模型调用回执确认是否遵循了技能指令。</p>
        {/* CF-P2-MEM-01（27 §11.1.1）：本会话记忆覆盖开关；全局关不能被会话越过。 */}
        {conversation && <MemoryOverrideSwitch conversationId={conversation.id} enabled={memoryFeaturesEnabled} />}
      </section>}
      {tab === 'artifact' && <section aria-labelledby="workbench-artifact-heading" className="flex h-full flex-col">
        <h3 id="workbench-artifact-heading">产物</h3>
        <div className="min-h-0 flex-1 overflow-y-auto"><ArtifactPanel conversationID={conversation?.id} compact focusArtifactID={focusArtifactID} onQuote={onQuoteArtifact} /></div>
        {/* DEV-AI27-09（W09b）：来源子页（证据可回查+批注记录）。 */}
        <div className="max-h-[45%] shrink-0 overflow-y-auto border-t border-mist-200 pt-3">
          {conversation && <SourcePanel conversationId={conversation.id} />}
        </div>
      </section>}
      {tab === 'browser' && showBrowserTab && <section aria-labelledby="workbench-browser-heading" className="desktop-agent-browser-pane">
        <div className="desktop-agent-browser-head">
          <div role="group" aria-label="浏览方式" className="desktop-agent-segmented">
            <button type="button" aria-pressed={browserMode === 'inapp'} onClick={() => setBrowserMode('inapp')}>应用内</button>
            <button type="button" aria-pressed={browserMode === 'chrome'} onClick={() => setBrowserMode('chrome')}>Chrome 协作</button>
          </div>
          <StatusChip tone={browserSummary.tone} label={browserMode === 'inapp' ? `本地标签 ${inappTabs}` : browserSummary.label} />
        </div>
        <h3 id="workbench-browser-heading" className="sr-only">浏览器</h3>
        {browserMode === 'chrome' && browserActivity && <BrowserControlBar
          activity={browserActivity}
          step={browserStep}
          paused={Boolean(browserPaused)}
          grantReady={Boolean(browserGrant) || Boolean(browserActivity)}
          busy={Boolean(busy)}
          conversationId={conversation?.id}
          onStop={() => onStopRun?.()}
          onTakeOver={() => onBrowserTakeOver?.()}
          onHandBack={() => onBrowserHandBack?.()}
        />}
        <p className="desktop-agent-browser-note">{browserSummary.note}</p>
        {browserMode === 'chrome' ? <div className="desktop-agent-browser-body">
          <BrowserStatusBlock state={browserConnectState} />
          {browserConnectState.kind === 'paired' && <BrowserTabSelector bindings={browserConnectState.bindings} onTabSelected={(selected) => { void selected }} />}
        </div> : <div className="desktop-agent-browser-body desktop-agent-browser-inapp">
          <InBrowsePanel visible={tab === 'browser'} conversationId={conversation?.id} onTabsChange={setInappTabs} />
        </div>}
      </section>}
    </div>
  </aside>
}
