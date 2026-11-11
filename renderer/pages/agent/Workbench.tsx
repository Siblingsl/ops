import { LoaderCircle, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button, IconButton, Textarea } from '@/components/ui'
import { errorMessage } from '@/lib/api'
import {
  type AgentBootstrap, type AgentConversation, type AgentConversationDetail, type AgentInput, type AgentMessage,
} from '@/lib/agent'
import { ArtifactPanel } from '@/pages/agent/ArtifactPanel'
import { BrowserStatusBlock, useBrowserConnectState } from '@/pages/agent/BrowserStatusBlock'
import { BrowserTabSelector } from '@/pages/agent/BrowserTabSelector'
import { type AgentContextSelection, type AgentSkillSelection } from '@/pages/agent/ContextPickers'
import { DelegationPanel } from '@/pages/agent/DelegationPanel'
import { GoalPanel } from '@/pages/agent/GoalPanel'
import { InBrowsePanel } from '@/pages/agent/InBrowsePanel'
import { SourcePanel } from '@/pages/agent/SourcePanel'

export type WorkbenchTab = 'task' | 'context' | 'artifact' | 'browser'

export function WorkbenchSidePanel({
  tab, setTab, close, width, browserWorkspaceEnabled, conversation, activeRun, busy, pendingActions, actionCount, selectedAccountName, selectedModelName, attachmentCount,
  contextRefs, skillRequests, latestSkillUsage, artifactsEnabled, goalsEnabled, compactEnabled, canManageGoals, models, goal, onCompact, actions, inputs, inputQueuePaused, onUpdateInput, onCancelInput, onRestoreInput, onResumeInputs, onQuoteArtifact,
}: {
  tab: WorkbenchTab; setTab: (tab: WorkbenchTab) => void; close: () => void; width?: number; browserWorkspaceEnabled: boolean
  conversation?: AgentConversation; activeRun?: AgentConversationDetail['active_run']; busy: boolean; pendingActions: number; actionCount: number
  selectedAccountName: string; selectedModelName: string; attachmentCount: number
  contextRefs: AgentContextSelection[]; skillRequests: AgentSkillSelection[]; latestSkillUsage: AgentMessage['skill_usage']; artifactsEnabled: boolean
  goalsEnabled: boolean; compactEnabled: boolean; canManageGoals: boolean; models: AgentBootstrap['models']; goal?: AgentConversationDetail['goal']; onCompact: () => Promise<unknown>
  actions: AgentConversationDetail['actions']
  inputs: AgentInput[]; inputQueuePaused: boolean
  onUpdateInput: (input: AgentInput, text: string) => Promise<void>; onCancelInput: (input: AgentInput) => Promise<void>
  onRestoreInput: (input: AgentInput) => Promise<void>; onResumeInputs: () => Promise<void>
  onQuoteArtifact: (ref: AgentContextSelection, prompt: string) => void
}) {
  const [editingInputID, setEditingInputID] = useState('')
  const [editingInputText, setEditingInputText] = useState('')
  const [inputBusyID, setInputBusyID] = useState('')
  // 深化 4/5：委派结果「查看产物」要落到具体产物，而不是只切页签。
  const [focusArtifactID, setFocusArtifactID] = useState('')
  useEffect(() => setFocusArtifactID(''), [conversation?.id])
  const tabs = [
    { id: 'task' as const, label: '任务' },
    { id: 'context' as const, label: '上下文' },
    ...(artifactsEnabled ? [{ id: 'artifact' as const, label: '产物' }] : []),
    // DEV-AI27-07：浏览器页签始终可见，连接状态由 BrowserStatusBlock 如实表达（不伪造已连接）。
    { id: 'browser' as const, label: '浏览器' },
  ] as const
  const browserConnectState = useBrowserConnectState(browserWorkspaceEnabled)
  const taskStatus = busy ? '正在运行' : pendingActions ? `等待你逐张处理 ${pendingActions} 项` : conversation ? '当前没有运行中的任务' : '发送第一条消息后，这里会显示对话任务状态'
  return <aside className="desktop-agent-side-panel" style={width ? { width, flexBasis: width } : undefined} data-testid="desktop-agent-side-panel" aria-label="工作视图">
    <header className="desktop-agent-side-panel-heading">
      <div><h2>工作视图</h2><IconButton label="关闭工作视图" onClick={close}><X className="size-4" /></IconButton></div>
      <div role="tablist" aria-label="工作视图切换" className="desktop-agent-side-tabs">
        {tabs.map((item) => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} onClick={() => setTab(item.id)}>{item.label}</button>)}
      </div>
    </header>
    <div role="tabpanel" className="desktop-agent-side-content">
      {tab === 'task' && <section aria-labelledby="workbench-task-heading">
        <h3 id="workbench-task-heading">当前任务</h3>
        <p className="desktop-agent-side-status" role="status">{busy && <LoaderCircle className="size-4 animate-spin" />}{taskStatus}</p>
        {activeRun && <p className="desktop-agent-side-detail">运行状态：{activeRun.status === 'queued' ? '排队中' : '执行中'}</p>}
        {/* DEV-AI27-15（W15b UI）：协作任务折叠/展开/单项停止（有委派组时才渲染）。 */}
        {conversation && <DelegationPanel conversationId={conversation.id} onNavigateArtifact={(artifactId) => { setFocusArtifactID(artifactId); setTab('artifact') }} />}
        {conversation && <p className="desktop-agent-side-detail">本对话操作卡片：{actionCount} 项</p>}
        <GoalPanel conversationID={conversation?.id} conversation={conversation} goal={goal} models={models} goalsEnabled={goalsEnabled} compactEnabled={compactEnabled} canManage={canManageGoals} busy={busy} onCompact={onCompact} />
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
        {skillRequests.length > 0 && <section className="mt-4"><h4 className="text-xs font-semibold text-mist-600">已请求技能</h4><ul className="mt-1 space-y-1 text-xs text-mist-600">{skillRequests.map((item) => <li key={`${item.skill_id}:${item.work_id ?? ''}`}>{item.name} · 尚未加载</li>)}</ul></section>}
        {!!latestSkillUsage?.length && <section className="mt-4"><h4 className="text-xs font-semibold text-mist-600">本轮技能状态</h4><ul className="mt-1 space-y-1 text-xs text-mist-600">{latestSkillUsage.map((item) => <li key={item.id}>{item.loaded ? '已加载到模型上下文；实际使用未验证' : '已请求，未加载'} · {item.name}</li>)}</ul></section>}
        <p className="desktop-agent-side-note">选择、启用和加载是不同状态。只有 load_skill 成功回执才显示已加载；当前无法从模型调用回执确认是否遵循了技能指令。</p>
      </section>}
      {tab === 'artifact' && <section aria-labelledby="workbench-artifact-heading" className="flex h-full flex-col">
        <h3 id="workbench-artifact-heading">产物</h3>
        <div className="min-h-0 flex-1 overflow-y-auto"><ArtifactPanel conversationID={conversation?.id} compact focusArtifactID={focusArtifactID} onQuote={onQuoteArtifact} /></div>
        {/* DEV-AI27-09（W09b）：来源子页（证据可回查+批注记录）。 */}
        <div className="max-h-[45%] shrink-0 overflow-y-auto border-t border-mist-200 pt-3">
          {conversation && <SourcePanel conversationId={conversation.id} />}
        </div>
      </section>}
      {tab === 'browser' && <section aria-labelledby="workbench-browser-heading" className="flex h-full flex-col">
        <h3 id="workbench-browser-heading">浏览器</h3>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <BrowserStatusBlock state={browserConnectState} />
          {browserConnectState.kind === 'paired' && <BrowserTabSelector bindings={browserConnectState.bindings} onTabSelected={(selected) => { void selected }} />}
        </div>
        {/* D-172 双路径之二：应用内浏览视图（Codex 同款，WebContentsView 承载）。 */}
        <div className="h-[60%] shrink-0 border-t border-mist-200">
          <InBrowsePanel visible={tab === 'browser'} conversationId={conversation?.id} />
        </div>
      </section>}
    </div>
  </aside>
}
