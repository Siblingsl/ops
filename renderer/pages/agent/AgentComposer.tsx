import { useEffect, useRef } from 'react'
import {
  AtSign, Bot, CalendarClock, Check, ChevronDown, FileText, Library, Paperclip, RotateCcw, Send, Sparkles, Square, Users, X,
} from 'lucide-react'
import { Button, IconButton, Textarea } from '@/components/ui'
import { AddMenu } from './AddMenu'
import { AttachmentReceipt } from './AttachmentReceipt'
import { ComposerCandidates } from './ComposerCandidates'
import { RealtimeVoiceBar } from './RealtimeVoiceBar'
import { VoiceBar } from './VoiceBar'
import { attachmentVariantURL, AgentModeSelect, modelKey, RunOutcomeNotice, RunStatus } from './MessageChrome'
import { modelRowMeta, modeActionLabel, skillStateLabel } from '@/lib/agent-ui.js'
import type { AgentCommand, ComposerTrigger } from '@/lib/agent-ui.js'
import type { AgentErrorInput } from '@/lib/agent-ui.js'
import type { AgentActiveRun, AgentBootstrap, AgentConversation, AgentConversationDetail, AgentMessage, AgentMode } from '@/lib/agent'
import type { AgentContextSelection, AgentSkillSelection } from './ContextPickers'
import type { AgentPageReference } from './AgentDialogs'
import type { useAttachmentQueue } from './useAttachmentQueue'

type AgentComposerRun = {
  activeRun?: AgentActiveRun
  streamStage: string
  streamError: AgentErrorInput
  streamErrors: AgentErrorInput[]
  streamConnection: React.ComponentProps<typeof RunStatus>['connection']
  pendingActions: number
  completedNotice: string
  handleRunErrorAction: (action: string) => void
  stop: () => void
  continueRun: () => void
}

export type AgentComposerView = {
  attachments: ReturnType<typeof useAttachmentQueue>
  desktopPresentation: boolean
  workbenchUI: boolean
  bootstrapData: AgentBootstrap
  conversation?: AgentConversation
  conversationId?: string
  visibleRunID: string
  actionExecuting: boolean
  messages: AgentMessage[]
  detail: AgentConversationDetail | undefined
  text: string
  setText: React.Dispatch<React.SetStateAction<string>>
  inputRef: React.RefObject<HTMLTextAreaElement>
  onInputKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement>
  inputDisabled: boolean
  canWrite: boolean
  busy: boolean
  runInputsEnabled: boolean
  composerBusy: boolean
  canSendContent: boolean
  inputSubmitting: boolean
  accountMismatch: boolean
  composerTrigger: ComposerTrigger | null
  composingRef: React.MutableRefObject<boolean>
  textDraftVersionRef: React.MutableRefObject<number>
  updateComposerTrigger: (value: string, cursor: number) => void
  setComposerTrigger: (value: ComposerTrigger | null) => void
  focusComposer: () => void
  selectedAccount: string
  contextRefs: AgentContextSelection[]
  setContextRefs: React.Dispatch<React.SetStateAction<AgentContextSelection[]>>
  pageRefs: AgentPageReference[]
  setPageRefs: React.Dispatch<React.SetStateAction<AgentPageReference[]>>
  subagentsArmed: boolean
  setSubagentsArmed: React.Dispatch<React.SetStateAction<boolean>>
  setWorkbenchPanelTab: React.Dispatch<React.SetStateAction<'task' | 'context' | 'artifact' | 'browser'>>
  setWorkbenchPanelOpen: React.Dispatch<React.SetStateAction<boolean>>
  skillRequests: AgentSkillSelection[]
  setSkillRequests: React.Dispatch<React.SetStateAction<AgentSkillSelection[]>>
  addContextSelection: (item: AgentContextSelection) => boolean
  addSkillSelection: (item: AgentSkillSelection) => boolean
  runComposerCommand: (command: AgentCommand) => void
  setContextPickerOpen: (value: boolean) => void
  setOperationDirectoryOpen: (value: boolean) => void
  setTodayOpsOpen: (value: boolean) => void
  setSkillPickerOpen: (value: boolean) => void
  setCapabilitiesOpen: (value: boolean) => void
  setWorkflowPickerOpen: (value: boolean) => void
  setComputerPickerOpen: (value: boolean) => void
  setRoutinePanelOpen: (value: boolean) => void
  createSideChat: () => Promise<void>
  openGoalPanel: () => void
  navigate: (to: string) => void
  todayOpsEnabled: boolean
  selectedMode: AgentMode
  changeMode: (mode: AgentMode) => void
  selectedModel: string
  selectedModelName: string
  modelMenuOpen: boolean
  setModelMenuOpen: React.Dispatch<React.SetStateAction<boolean>>
  updateSelection: (kind: 'model' | 'account', value: string) => void
  runInputMenuOpen: boolean
  setRunInputMenuOpen: React.Dispatch<React.SetStateAction<boolean>>
  postWorkbenchInput: (kind: 'steer' | 'queue') => Promise<void>
  sendMessage: (edit?: AgentMessage) => Promise<void>
  editMessage: AgentMessage | null
  setEditMessage: React.Dispatch<React.SetStateAction<AgentMessage | null>>
  run: AgentComposerRun
  onboarding: { id: string; text: string; action?: string } | null
  onboardingDismissed: boolean
  setOnboardingDismissed: (value: boolean) => void
  runtimeSummary: string
  runCostSummary: string
  goalsEnabled: boolean
  routinesEnabled: boolean
}

export function AgentComposer({ view }: { view: AgentComposerView }) {
  const v = view
  const { attachments, run } = v
  const { bootstrapData, navigate, setSubagentsArmed, setWorkbenchPanelTab, setWorkbenchPanelOpen } = v
  const {
    files, restoredAttachments, setRestoredAttachments, uploading, retryFile, removeFile, addFiles, readyAttachmentIDs, failedFiles,
  } = attachments
  const fileRef = useRef<HTMLInputElement>(null)
  const composerRootRef = useRef<HTMLDivElement>(null)
  const modelMenuRef = useRef<HTMLDivElement>(null)
  const runInputMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!v.composerTrigger) return
    const onDown = (event: MouseEvent) => {
      if (!composerRootRef.current?.contains(event.target as Node)) v.setComposerTrigger(null)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [v.composerTrigger])
  useEffect(() => {
    if (!v.runInputMenuOpen) return
    const closeOutside = (event: MouseEvent) => { if (!runInputMenuRef.current?.contains(event.target as Node)) v.setRunInputMenuOpen(false) }
    const closeEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') v.setRunInputMenuOpen(false) }
    document.addEventListener('mousedown', closeOutside)
    document.addEventListener('keydown', closeEscape)
    return () => { document.removeEventListener('mousedown', closeOutside); document.removeEventListener('keydown', closeEscape) }
  }, [v.runInputMenuOpen])
  useEffect(() => {
    if (!v.modelMenuOpen) return
    const closeOutside = (event: MouseEvent) => { if (!modelMenuRef.current?.contains(event.target as Node)) v.setModelMenuOpen(false) }
    const closeEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') v.setModelMenuOpen(false) }
    document.addEventListener('mousedown', closeOutside)
    document.addEventListener('keydown', closeEscape)
    return () => { document.removeEventListener('mousedown', closeOutside); document.removeEventListener('keydown', closeEscape) }
  }, [v.modelMenuOpen])

  const renderAttachmentQueue = (insideComposer = false) => {
    if (files.length === 0 && restoredAttachments.length === 0) return null
    return (
      <div className={insideComposer ? 'desktop-agent-compose-attachments' : 'mx-auto mb-2 max-w-3xl'}>
        <div
          className={insideComposer ? 'desktop-agent-attachment-list scrollbar-thin' : 'flex flex-wrap gap-2'}
          role={insideComposer ? 'region' : undefined}
          aria-label={insideComposer ? '已添加附件' : undefined}
          tabIndex={insideComposer ? 0 : undefined}
        >
          {files.map((file) => <div key={file.clientID} aria-label={`${file.file.name} ${file.status}`} className={`flex items-center gap-2 rounded-lg border p-1.5 text-xs ${file.status === 'failed' ? 'border-danger/30 bg-danger/5 text-danger' : 'border-mist-200 bg-mist-50 text-mist-600'}`}>
            {file.attachment?.kind === 'image' ? <img src={attachmentVariantURL(file.attachment.url, 'thumb')} alt={file.file.name} className="size-10 rounded object-cover" /> : <FileText className="ml-1 size-4" />}
            <div><span className="block max-w-52 truncate">{file.file.name}</span>{file.attachment && file.status === 'ready' && <AttachmentReceipt attachment={file.attachment} />}{file.status === 'failed' && <p className="mt-1 max-w-72 whitespace-normal">{file.error}</p>}</div>
            {file.status === 'waiting' && <span role="status">等待上传</span>}
            {file.status === 'uploading' && <span role="status">上传中{file.progress === undefined ? '' : ' ' + file.progress + '%'}</span>}
            {file.status === 'processing' && <span role="status">处理中</span>}
            {file.status === 'ready' && <span>已就绪</span>}
            {file.status === 'failed' && <><span>上传失败</span>{file.retryable && <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3" />} onClick={() => retryFile(file)}>重试</Button>}</>}
            <IconButton label={`移除 ${file.file.name}`} className="size-6" onClick={() => void removeFile(file)}><X className="size-3" /></IconButton>
          </div>)}
          {restoredAttachments.map((attachment) => <div key={attachment.id} className="flex items-center gap-2 rounded-lg border border-mist-200 bg-mist-50 p-1.5 text-xs text-mist-600">
            {attachment.kind === 'image' ? <img src={attachmentVariantURL(attachment.url, 'thumb')} alt={attachment.name} className="size-10 rounded object-cover" /> : <FileText className="ml-1 size-4" />}
            <div><span className="block max-w-40 truncate">{attachment.name}</span><AttachmentReceipt attachment={attachment} /></div><span>从待复核输入恢复</span>
            <IconButton label={`移除 ${attachment.name}`} className="size-6" onClick={() => setRestoredAttachments((old) => old.filter((item) => item.id !== attachment.id))}><X className="size-3" /></IconButton>
          </div>)}
        </div>
        {failedFiles.length > 0 && <p className="mt-1 text-xs text-danger" role="alert">有 {failedFiles.length} 个附件未就绪，请处理失败项或移除后再发送。</p>}
      </div>
    )
  }

  return (
    <div className={`shrink-0 border-t border-mist-200 bg-white px-3 pb-[calc(env(safe-area-inset-bottom)+4.5rem)] pt-3 md:pb-4 ${v.desktopPresentation ? 'desktop-agent-compose-area' : ''} ${v.workbenchUI ? 'desktop-agent-workbench-compose-area' : ''}`}>
      {(!v.desktopPresentation || !v.visibleRunID && (v.workbenchUI || !!run.streamError)) && <RunStatus activeRun={run.activeRun} streamStage={run.streamStage} toolName={v.messages.filter((message) => message.run_id === run.activeRun?.id).flatMap((message) => message.tool_calls ?? []).find((call) => call.status === 'running')?.name} connection={run.streamConnection} pendingActions={run.pendingActions} error={run.streamError} errors={run.streamErrors} completedNotice={run.completedNotice} onErrorAction={run.handleRunErrorAction} />}
      <RunOutcomeNotice run={v.detail?.last_run} />
      {!v.desktopPresentation && v.bootstrapData.features.plans && v.runtimeSummary && <p className="mx-auto mb-3 max-w-3xl px-3 text-xs text-mist-500" data-testid="agent-runtime-config">{v.runtimeSummary}</p>}
      {!v.desktopPresentation && v.runCostSummary && <p className="mx-auto mb-3 max-w-3xl px-3 text-xs text-mist-500" data-testid="agent-run-cost">{v.runCostSummary}</p>}
      {v.onboarding && !v.onboardingDismissed && <div className="desktop-agent-onboarding mx-auto mb-2 max-w-3xl" role="status" data-testid="agent-onboarding-hint" data-hint={v.onboarding.id}>
        <span>{v.onboarding.text}</span>
        {v.onboarding.action === '去模型配置' || v.onboarding.action === '去自检' ? <a href="/settings/models" className="underline">{v.onboarding.action}</a>
          : v.onboarding.action === '选择账号' ? <button type="button" className="underline" onClick={() => window.dispatchEvent(new Event('ops-desktop-account-switcher-request'))}>{v.onboarding.action}</button>
            : v.onboarding.action === '查看权限' ? <span className="desktop-agent-onboarding-note">卡片执行按业务权限校验</span> : null}
        <button type="button" className="desktop-agent-onboarding-close" aria-label="关闭这条提示" onClick={() => v.setOnboardingDismissed(true)}><X aria-hidden="true" /></button>
      </div>}
      {run.pendingActions > 0 && !v.desktopPresentation && <div className="mx-auto mb-2 max-w-3xl text-[12px] text-mist-500">等待你逐张处理 {run.pendingActions} 项后，智能体会继续。卡片操作入口显示在对应消息下方。</div>}
      {v.detail?.can_continue && !v.busy && !v.actionExecuting && run.pendingActions === 0 && <div className="mx-auto mb-2 max-w-3xl text-right"><Button size="sm" variant="ghost" onClick={run.continueRun}>继续</Button></div>}
      {run.activeRun && !v.desktopPresentation && <div className="mx-auto mb-2 max-w-3xl text-right"><Button size="sm" variant="ghost" icon={<Square className="size-3" />} onClick={() => void run.stop()}>停止</Button></div>}
      {v.conversation && !run.activeRun && v.detail?.actions.some((action) => action.status === 'executing') && <div className="mx-auto mb-2 max-w-3xl text-[12px] text-mist-500">有操作卡片正在执行，请稍候。</div>}
      {v.detail?.messages.length === 0 && v.bootstrapData.default_model_unsupported && <div className="mx-auto mb-2 max-w-3xl text-[12px] text-gamboge-700">默认模型未通过工具调用自检，请先选择其他模型。</div>}
      {v.editMessage && <div className="mx-auto mb-2 flex max-w-3xl items-center justify-between rounded-lg bg-mist-50 px-3 py-1.5 text-xs text-mist-600"><span>编辑最后一条消息并重新运行</span><button type="button" className="cursor-pointer underline" onClick={() => { v.setEditMessage(null); v.setText('') }}>取消</button></div>}
      {!v.desktopPresentation && renderAttachmentQueue()}
      {(v.contextRefs.length > 0 || v.pageRefs.length > 0 || v.subagentsArmed) && <div className="mx-auto mb-2 flex max-w-3xl flex-wrap gap-2">
        {v.subagentsArmed && <div data-testid="agent-subagents-chip" className="flex items-center gap-2 rounded-lg border border-ink-200 bg-ink-50 px-2 py-1.5 text-xs text-ink-700">
          <Users className="size-3.5" /><span>并行协作</span><span className="text-mist-500">本次任务允许拆成 2 个只读子任务</span>
          <IconButton label="取消并行协作" className="size-6" onClick={() => v.setSubagentsArmed(false)}><X className="size-3" /></IconButton>
        </div>}
        {v.contextRefs.map((ref) => <div key={`${ref.type}:${ref.id}`} data-testid="agent-context-ref-chip" className="flex items-center gap-2 rounded-lg border border-ink-200 bg-ink-50 px-2 py-1.5 text-xs text-ink-700">
          <AtSign className="size-3.5" /><span className="max-w-48 truncate">{ref.name}</span><span className="text-mist-500">{ref.reference_scope === 'conversation' ? '固定引用' : '本轮引用'}</span>
          <IconButton label={`移除引用 ${ref.name}`} className="size-6" onClick={() => v.setContextRefs((old) => old.filter((item) => item.id !== ref.id || item.type !== ref.type))}><X className="size-3" /></IconButton>
        </div>)}
        {v.pageRefs.map((ref) => <div key={ref.id} data-testid="agent-page-reference-chip" className="flex items-center gap-2 rounded-lg border border-ink-200 bg-ink-50 px-2 py-1.5 text-xs text-ink-700">
          <AtSign className="size-3.5" /><span className="max-w-48 truncate" title={`${ref.selector}\n${ref.note}`}>{ref.name}</span><span className="text-mist-500">本轮引用</span>
          <IconButton label={`移除页面引用 ${ref.name}`} className="size-6" onClick={() => v.setPageRefs((old) => old.filter((item) => item.id !== ref.id))}><X className="size-3" /></IconButton>
        </div>)}
      </div>}
      {v.skillRequests.length > 0 && <div className="mx-auto mb-2 flex max-w-3xl flex-wrap gap-2">
        {v.skillRequests.map((skill) => <div key={`${skill.skill_id}:${skill.work_id ?? ''}`} className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 text-xs ${skill.unavailable ? 'border-danger/40 bg-danger-50 text-danger' : 'border-ink-200 bg-ink-50 text-ink-700'}`}>
          <Sparkles className="size-3.5" /><span className="max-w-48 truncate">{skill.name}</span><span className={skill.unavailable ? 'text-danger' : 'text-mist-500'}>{skillStateLabel({ requested: true, unavailable: skill.unavailable })}</span>
          <IconButton label={`移除技能请求 ${skill.name}`} className="size-6" onClick={() => v.setSkillRequests((old) => old.filter((item) => item.skill_id !== skill.skill_id || item.work_id !== skill.work_id))}><X className="size-3" /></IconButton>
        </div>)}
      </div>}
      {v.bootstrapData.features.document_parse && <p className="mx-auto mb-1 max-w-3xl text-xs text-mist-500">PDF / DOCX / CSV ≤20MB；文档≤100页，CSV≤10000行×100列。DOCX分页不可验证时请转PDF。</p>}

      <input ref={fileRef} type="file" multiple accept={'image/jpeg,image/png,image/webp,image/gif,.txt,.md' + (v.bootstrapData.features.document_parse ? ',.pdf,.docx,.csv' : '')} className="hidden" onChange={(event) => { if (event.target.files) void addFiles(event.target.files); event.target.value = '' }} />
      {v.desktopPresentation ? <>
        <div className={`desktop-agent-compose ${v.workbenchUI ? 'desktop-agent-workbench-compose' : ''}`} ref={composerRootRef}>
          {renderAttachmentQueue(true)}
          {/* DEV-AI27-16（W16c）：语音输入完整链路；D-224 软冻结：voice_dictation 关闭时不挂载。 */}
          {v.conversationId && v.bootstrapData.features.voice_dictation === true && <VoiceBar conversationId={v.conversationId} voiceDictationEnabled onInsert={(voiceText) => { v.setText((old) => old ? `${old}${voiceText}` : voiceText); window.setTimeout(() => v.inputRef.current?.focus(), 0) }} />}
          {v.conversationId && v.bootstrapData.features.voice_realtime === true && <RealtimeVoiceBar conversationId={v.conversationId} enabled onInsert={(voiceText) => { v.setText((old) => old ? `${old}${voiceText}` : voiceText); window.setTimeout(() => v.inputRef.current?.focus(), 0) }} />}
          {v.workbenchUI && v.composerTrigger && !v.inputDisabled && <ComposerCandidates trigger={v.composerTrigger} accountID={v.selectedAccount} contextRefs={v.contextRefs} skillRequests={v.skillRequests}
            onAddContext={v.addContextSelection} onAddSkill={v.addSkillSelection} onCommand={v.runComposerCommand}
            onClose={() => { v.setComposerTrigger(null); v.focusComposer() }} />}
          <Textarea ref={v.inputRef} rows={v.workbenchUI ? 3 : 1} aria-label={v.workbenchUI ? '发送消息' : undefined} value={v.text} disabled={v.inputDisabled} onChange={(event) => { v.textDraftVersionRef.current++; v.setText(event.target.value); event.target.style.height = 'auto'; event.target.style.height = `${Math.min(event.target.scrollHeight, v.workbenchUI ? 176 : 192)}px`; v.updateComposerTrigger(event.target.value, event.target.selectionStart ?? 0) }}
            onSelect={(event) => v.updateComposerTrigger(event.currentTarget.value, event.currentTarget.selectionStart ?? 0)}
            onCompositionStart={() => { v.composingRef.current = true }}
            onCompositionEnd={(event) => { v.composingRef.current = false; v.updateComposerTrigger(event.currentTarget.value, event.currentTarget.selectionStart ?? 0) }}
            onKeyDown={v.onInputKeyDown}
            placeholder={v.bootstrapData.read_only ? '观察者可以提问，智能体不会修改工作区数据' : !v.bootstrapData.can_use ? (v.bootstrapData.reason === 'not_tested' ? '请先完成模型能力自检' : '请先配置支持工具调用的模型') : '说说你想写什么，或继续调整上面的方向…'} className="desktop-agent-compose-input" />
          <div className="desktop-agent-compose-toolbar">
            {/* DEV-AI27-07：统一添加菜单收敛全部上下文与能力入口（27 §5.5）；
                已选能力仍以筹码形式显示在输入区上方。 */}
            <AddMenu
              disabled={!v.canWrite || v.busy && !v.runInputsEnabled || uploading}
              attachmentsAtLimit={files.length + restoredAttachments.length >= (v.bootstrapData.limits.attachments_per_message ?? 6)}
              computerEnabled={v.bootstrapData.features.computer_use === true}
              operationsDirectoryEnabled={v.bootstrapData.features.operations_directory === true}
              todayOpsEnabled={v.todayOpsEnabled}
              sideChatEnabled={v.bootstrapData.features.side_chat === true && Boolean(v.conversation)}
              pluginsEnabled={bootstrapData.features.plugin_mcp === true}
              subagentsEnabled={v.bootstrapData.features.subagents === true}
              workflowTemplatesEnabled={v.bootstrapData.features.workflow_templates === true}
              onAction={(action) => {
                if (action === 'attachment') fileRef.current?.click()
                else if (action === 'context_refs') v.setContextPickerOpen(true)
                else if (action === 'operations_directory') v.setOperationDirectoryOpen(true)
                else if (action === 'today_ops') v.setTodayOpsOpen(true)
                else if (action === 'side_chat') void v.createSideChat()
                else if (action === 'skill') v.setSkillPickerOpen(true)
                else if (action === 'goal') v.openGoalPanel()
                else if (action === 'routine') v.setRoutinePanelOpen(true)
                else if (action === 'plugins') navigate('/settings/plugins')
                else if (action === 'subagents') { setSubagentsArmed(true); setWorkbenchPanelTab('task'); setWorkbenchPanelOpen(true) }
                else if (action === 'capabilities') v.setCapabilitiesOpen(true)
                else if (action === 'workflow_templates') v.setWorkflowPickerOpen(true)
                else if (action === 'computer') v.setComputerPickerOpen(true)
              }}
            />
            {v.bootstrapData.features.plans && v.workbenchUI && v.conversation?.kind !== 'side' && <AgentModeSelect value={v.selectedMode} disabled={!v.canWrite || v.busy} readOnly={v.bootstrapData.read_only} onChange={(mode) => void v.changeMode(mode)} />}
            <span className="desktop-agent-compose-spacer" />
            <div className="desktop-agent-model-picker" ref={modelMenuRef}>
              <button type="button" className="desktop-agent-compose-choice" aria-label="选择模型" aria-haspopup="menu" aria-expanded={v.modelMenuOpen} title={!v.bootstrapData.allow_model_pick ? '管理员已锁定模型，不能切换' : undefined} disabled={!v.canWrite || !v.bootstrapData.allow_model_pick || v.busy} onClick={() => v.setModelMenuOpen((value) => !value)}>{v.selectedModelName} <ChevronDown /></button>
              {v.modelMenuOpen && <div className="desktop-agent-model-menu" role="menu" aria-label="选择模型">
                <div className="desktop-agent-model-menu-title">选择模型</div>
                {v.bootstrapData.models.length === 0 && <div className="desktop-agent-model-menu-empty">暂无可用模型，请先完成模型能力自检。</div>}
                {v.bootstrapData.models.map((model) => {
                  const key = modelKey(model.provider_id, model.model)
                  const unavailable = model.available === false
                  return <button type="button" role="menuitemradio" aria-checked={key === v.selectedModel} key={key} disabled={unavailable}
                    title={unavailable ? model.reason || '模型当前不可用' : undefined}
                    onClick={() => { v.setModelMenuOpen(false); void v.updateSelection('model', key) }}>
                    <span><span>{model.model}</span><small>{modelRowMeta(model)}</small>{unavailable && model.reason && <small className="desktop-agent-model-menu-reason">{model.reason}</small>}</span>
                    {key === v.selectedModel && <Check aria-hidden="true" />}
                  </button>
                })}
                <button type="button" className="desktop-agent-model-menu-settings" onClick={() => { v.setModelMenuOpen(false); v.navigate('/settings/models') }}>模型设置</button>
              </div>}
            </div>
            {v.composerBusy && v.runInputsEnabled ? <div className="desktop-agent-run-input-actions">
              <div className="desktop-agent-split-action" ref={runInputMenuRef}>
                <Button variant="secondary" disabled={!v.canSendContent || v.inputSubmitting || uploading || failedFiles.length > 0} onClick={() => void v.postWorkbenchInput('steer')}>补充当前任务</Button>
                <button type="button" className="desktop-agent-split-more" aria-label="更多运行中输入动作" aria-haspopup="menu" aria-expanded={v.runInputMenuOpen} onClick={() => v.setRunInputMenuOpen((value) => !value)}><ChevronDown aria-hidden="true" /></button>
                {v.runInputMenuOpen && <div role="menu" aria-label="运行中输入动作" className="desktop-agent-run-input-menu">
                  <button type="button" role="menuitem" disabled={!v.canSendContent || v.inputSubmitting || uploading || failedFiles.length > 0}
                    title={v.inputSubmitting ? '正在提交上一条输入' : undefined}
                    onClick={() => { v.setRunInputMenuOpen(false); void v.postWorkbenchInput('queue') }}>
                    <strong>排到下一条</strong><small>当前任务完成后发送</small>
                  </button>
                </div>}
              </div>
              <Button variant="ghost" className="desktop-agent-stop-button" icon={<Square className="size-4" />} onClick={() => void run.stop()}>停止</Button>
            </div> : v.composerBusy ? <Button variant="ghost" className="desktop-agent-stop-button" icon={<Square className="size-4" />} onClick={() => void run.stop()}>停止</Button>
              : <>
                <Button variant="primary" icon={<Send className="size-4" />} disabled={!v.canWrite || v.accountMismatch || !v.canSendContent || uploading || failedFiles.length > 0 || Array.from(v.text).length > v.bootstrapData.limits.message_chars} onClick={() => v.editMessage ? void v.sendMessage(v.editMessage) : void v.sendMessage()}>{uploading ? '上传中' : modeActionLabel(v.selectedMode)}</Button>
                {v.busy && <Button variant="ghost" className="desktop-agent-stop-button" icon={<Square className="size-4" />} onClick={() => void run.stop()}>停止</Button>}
              </>}
          </div>
        </div>
      </> : <>
        {v.bootstrapData.features.plans && v.conversation?.kind !== 'side' && <div className="mx-auto mb-2 flex max-w-3xl items-center gap-2 text-xs text-mist-500"><AgentModeSelect value={v.selectedMode} disabled={!v.canWrite || v.busy} readOnly={v.bootstrapData.read_only} onChange={(mode) => void v.changeMode(mode)} /><span>{v.selectedMode === 'execute' ? '写入仍需逐张卡片确认' : '只读取与形成建议'}</span></div>}
        <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-2xl border border-mist-200 bg-white p-2 shadow-card focus-within:border-ink-300">
          <IconButton label="添加附件" disabled={!v.canWrite || v.busy || uploading || files.length + restoredAttachments.length >= (v.bootstrapData.limits.attachments_per_message ?? 6)} onClick={() => fileRef.current?.click()} className="mb-0.5"><Paperclip className="size-4" /></IconButton>
          {v.bootstrapData.features.context_refs && <IconButton label="引用资料（@）" disabled={!v.canWrite || v.busy || v.contextRefs.length >= 12} onClick={() => v.setContextPickerOpen(true)} className="mb-0.5"><AtSign className="size-4" /></IconButton>}
          {v.bootstrapData.features.operations_directory === true && <IconButton label="运营目录" disabled={!v.canWrite || v.busy || v.contextRefs.length >= 12} onClick={() => v.setOperationDirectoryOpen(true)} className="mb-0.5"><Library className="size-4" /></IconButton>}
          {v.bootstrapData.features.skill_requests && <IconButton label="请求技能（$）" disabled={!v.canWrite || v.busy || v.skillRequests.length >= 3} onClick={() => v.setSkillPickerOpen(true)} className="mb-0.5"><Sparkles className="size-4" /></IconButton>}
          {v.goalsEnabled && v.conversationId && <IconButton label="任务目标与上下文整理" onClick={v.openGoalPanel} className="mb-0.5"><Bot className="size-4" /></IconButton>}
          {v.routinesEnabled && <IconButton label="例行任务" onClick={() => v.setRoutinePanelOpen(true)} className="mb-0.5"><CalendarClock className="size-4" /></IconButton>}
          <Textarea ref={v.inputRef} rows={1} value={v.text} disabled={v.inputDisabled} onChange={(event) => { v.textDraftVersionRef.current++; v.setText(event.target.value); event.target.style.height = 'auto'; event.target.style.height = `${Math.min(event.target.scrollHeight, 192)}px` }} onKeyDown={v.onInputKeyDown}
            placeholder={v.bootstrapData.read_only ? '观察者可以提问，智能体不会修改工作区数据' : !v.bootstrapData.can_use ? (v.bootstrapData.reason === 'not_tested' ? '请先完成模型能力自检' : '请先配置支持工具调用的模型') : '发送消息…（Enter 发送，Shift+Enter 换行）'} className="max-h-48 min-h-10 resize-none border-0 bg-transparent px-2 py-2 shadow-none focus:border-transparent focus:ring-0 disabled:bg-transparent" />
          {v.busy ? <Button variant="ghost" className="mb-0.5 shrink-0" icon={<Square className="size-4" />} onClick={() => void run.stop()}>停止</Button>
            : <Button variant="primary" className="mb-0.5 shrink-0" icon={<Send className="size-4" />} disabled={!v.canWrite || !v.canSendContent || uploading || failedFiles.length > 0 || Array.from(v.text).length > v.bootstrapData.limits.message_chars} onClick={() => v.editMessage ? void v.sendMessage(v.editMessage) : void v.sendMessage()}>{uploading ? '上传中' : modeActionLabel(v.selectedMode)}</Button>}
        </div>
        <div className="mx-auto mt-1 flex max-w-3xl justify-between px-2 text-[12px] text-mist-400"><span>{readyAttachmentIDs.length ? `已添加 ${readyAttachmentIDs.length} 个附件` : '附件支持图片、txt 与 md'}</span><span>{Array.from(v.text).length} / {v.bootstrapData.limits.message_chars}</span></div>
      </>}
    </div>
  )
}


