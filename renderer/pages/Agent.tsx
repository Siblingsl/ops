import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Bot, CalendarClock, FileText, LoaderCircle, Menu, Settings2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom' // AG-01: Added useNavigate for navigation to settings pages
import { toast } from 'sonner'
import { confirm, Dialog, Drawer } from '@/components/dialog'
import { Button, IconButton } from '@/components/ui'
import { AgentComposer, type AgentComposerView } from './agent/AgentComposer'
import { AgentMessageStream, useAgentMessageStream } from './agent/AgentMessageStream'
import { AgentCompactDialog, AgentLocalSearchDialog, AgentSettingsDialog, type AgentPageReference, pageReferenceText, Unavailable } from './agent/AgentDialogs'
import { useAttachmentQueue } from './agent/useAttachmentQueue'
import { CapabilityList } from './agent/CapabilityList'
import { BrowserTabAuthorizeDialog, type BrowserGrantView } from './agent/BrowserTabAuthorizeDialog'
import { ComputerWindowPicker } from './agent/ComputerWindowPicker'
import { DelegationPanel } from './agent/DelegationPanel'
import { PanelResizer, PANEL_WIDTH_DEFAULT } from './agent/PanelResizer'
import { del, errorMessage, get, patch, post } from '@/lib/api'
import { isEnterWithoutComposition } from '@/lib/keyboard'
import { fmtCostMicros } from '@/lib/format'
import { useAccounts, useCurrentAccount, useMe } from '@/lib/session'
import { useSavePrefs } from '@/lib/v3'
import { pagePollIntervalMs } from '@/lib/page-poll'
import { usePageVisible } from '@/lib/visibility'
import {
  type AgentConversation, type AgentConversationDetail, type AgentInput,
  type AgentMessage, type AgentMode, type AgentQuestion, type AgentRole, type WorkflowTemplate,
  useAgentBootstrap,
} from '@/lib/agent'
import { trackAgentEvent } from '@/lib/agent-telemetry-client'
import { hasDesktopBridgeMethod, subscribeDesktopSidepanelDraft, subscribeDesktopSidepanelStop } from '@/lib/platform-bridge'
import { ComputerControlBar } from '@/pages/agent/ComputerControlBar'
import { ArtifactPanel } from '@/pages/agent/ArtifactPanel'
import { browserStore, clearPartial, type PartialStream, readPartial, savePartial } from '@/pages/agent/partial-stream'
import { ContextPickerDialog, SkillPickerDialog, type AgentContextSelection, type AgentSkillSelection } from '@/pages/agent/ContextPickers'
import { OperationDirectoryDrawer } from '@/pages/agent/OperationDirectoryDrawer'
import { TodayOpsPanel, type TodayOpsView } from '@/pages/agent/TodayOpsPanel'
import { GoalPanel } from '@/pages/agent/GoalPanel'
import { WorkflowTemplateDialog } from '@/pages/agent/workflow-dialog'
import { RoutinePanel } from '@/pages/agent/RoutinePanel'
import { AgentConversationList } from '@/pages/agent/ConversationList'
import { ConversationHeader } from '@/pages/agent/ConversationHeader'
import { addToLimitedList, COMMANDS, contextRefsPayload, deriveHeaderState, detectComposerTrigger, onboardingHint, removeComposerTrigger, shouldAutoOpenPanel, skillRequestsPayload } from '@/lib/agent-ui.js'
import type { AgentCommand, ComposerTrigger } from '@/lib/agent-ui.js'
import { modelKey, type PendingAgentMessage } from '@/pages/agent/MessageChrome'
import { useAgentRun } from '@/pages/agent/useAgentRun'
import { WorkbenchSidePanel, type WorkbenchTab } from '@/pages/agent/Workbench'

export default function Agent() {
  const { conversationId } = useParams()
  const desktopPresentation = document.documentElement.dataset.presentation === 'ops-creative-desktop'
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const qc = useQueryClient()
  const bootstrap = useAgentBootstrap()
  const accounts = useAccounts()
  const currentAccount = useCurrentAccount()
  const me = useMe()
  const savePrefs = useSavePrefs()
  const pageVisible = usePageVisible()
  const [search, setSearch] = useState(''); const [mobileListOpen, setMobileListOpen] = useState(false)
  const [workbenchListCollapsed, setWorkbenchListCollapsed] = useState(false); const [workbenchPanelOpen, setWorkbenchPanelOpen] = useState(false)
  const [workbenchPanelTab, setWorkbenchPanelTab] = useState<WorkbenchTab>('task'); const [workbenchPanelWidth, setWorkbenchPanelWidth] = useState(PANEL_WIDTH_DEFAULT)
  const [goalPanelOpen, setGoalPanelOpen] = useState(false); const [routinePanelOpen, setRoutinePanelOpen] = useState(false)
  const [todayOpsOpen, setTodayOpsOpen] = useState(false); const [capabilitiesOpen, setCapabilitiesOpen] = useState(false)
  const [artifactsOpen, setArtifactsOpen] = useState(false); const [workbenchLayoutLoadedKey, setWorkbenchLayoutLoadedKey] = useState('')
  const [subagentsArmed, setSubagentsArmed] = useState(false); const [text, setText] = useState('')
  const textDraftVersionRef = useRef(0); const [pendingUserMessages, setPendingUserMessages] = useState<PendingAgentMessage[]>([])
  const [contextRefs, setContextRefs] = useState<AgentContextSelection[]>([]); const [pageRefs, setPageRefs] = useState<AgentPageReference[]>([])
  const pageRefsRef = useRef<AgentPageReference[]>([]); const [skillRequests, setSkillRequests] = useState<AgentSkillSelection[]>([])
  const [contextPickerOpen, setContextPickerOpen] = useState(false); const [operationDirectoryOpen, setOperationDirectoryOpen] = useState(false)
  const [skillPickerOpen, setSkillPickerOpen] = useState(false)
  // BR-08：最近一次授权租约与接管状态；没有租约时接管按钮禁用，不伪造控制权。
  const [browserGrant, setBrowserGrant] = useState<BrowserGrantView | null>(null); const [browserPaused, setBrowserPaused] = useState(false)
  const [composerTrigger, setComposerTrigger] = useState<ComposerTrigger | null>(null); const [compactDialogOpen, setCompactDialogOpen] = useState(false)
  const [reviewActionID, setReviewActionID] = useState<string | null>(null); const composingRef = useRef(false)
  const [submitting, setSubmitting] = useState(false); const [inputSubmitting, setInputSubmitting] = useState(false)
  const [selectedMode, setSelectedMode] = useState<AgentMode>('execute'); const [selectedModel, setSelectedModel] = useState('')
  const [conversationAccount, setSelectedAccount] = useState('')
  // REF41 A7：工作流模板选择（启动只建 conversation+run+plan，不执行工具）。
  const [workflowPickerOpen, setWorkflowPickerOpen] = useState(false)
  const workflowStarted = (result: { conversation_id: string }, template: WorkflowTemplate) => {
    toast.success(`工作流「${template.name}」已生成计划（${template.steps.length} 步）；打开新对话逐步确认执行。`)
    if (result.conversation_id) navigate(`/agent/c/${result.conversation_id}`)
  }
  // REF41 A6：角色 bot 选择（空=默认无角色；agent_roles feature 开时显示）。
  const [selectedRoleID, setSelectedRoleID] = useState('')
  const selectedAccount = desktopPresentation ? currentAccount?.id ?? '' : conversationAccount
  // AG-03：对话创建时绑定的账号。切换后历史仍属于原账号，必须明确提示，不能默默换上下文。
  const [historyAccount, setHistoryAccount] = useState(''); const [settingsOpen, setSettingsOpen] = useState(false)
  const [modelMenuOpen, setModelMenuOpen] = useState(false); const [runInputMenuOpen, setRunInputMenuOpen] = useState(false)
  const previousDesktopAccount = useRef<string | undefined>(undefined); const [privacyOpen, setPrivacyOpen] = useState(false)
  const [editMessage, setEditMessage] = useState<AgentMessage | null>(null)
  const initialConversationRef = useRef(conversationId)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const messageRequest = useRef<{ key: string; id: string } | null>(null)
  const inputRequest = useRef<{ key: string; id: string } | null>(null)
  const resumeInputRequest = useRef<string | null>(null)
  const conversationRequest = useRef<{ key: string; id: string } | null>(null)
  const [actionExecuting, setActionExecuting] = useState(false)
  // AG-04：断流/切页后恢复已生成的部分内容（草稿只放 sessionStorage）。
  const [recovered, setRecovered] = useState<PartialStream | null>(null)
  const partialStore = useRef<Storage | null>(null)
  const partialSavedAt = useRef(0)
  const conversationIDRef = useRef(conversationId)
  conversationIDRef.current = conversationId
  const lastDraftConversationID = useRef(conversationId)
  const sendDestinationConversationID = useRef('')
  const bootstrapData = bootstrap.data
  const rolesQuery = useQuery({
    queryKey: ['agent-roles'],
    queryFn: () => get<{ roles: AgentRole[] }>('/agent-roles'),
    enabled: !!bootstrapData?.features.agent_roles,
  })
  const workflowsQuery = useQuery({
    queryKey: ['workflow-templates'],
    queryFn: () => get<{ templates: WorkflowTemplate[] }>('/workflows'),
    enabled: !!bootstrapData?.features.workflow_templates,
  })
  // IX-11：不打扰的一行引导——四态按优先级只显示一条；关闭后本次会话（页面生命周期）不再显示。
  const [onboardingDismissed, setOnboardingDismissed] = useState(false)
  const onboarding = useMemo(() => bootstrapData ? onboardingHint({ readOnly: bootstrapData.read_only, canUse: bootstrapData.can_use, reason: bootstrapData.reason, hasAccount: !!selectedAccount }) : null, [bootstrapData, selectedAccount])
  const workbenchUI = desktopPresentation && bootstrapData?.features?.workbench_ui === true
  const organizeEnabled = bootstrapData?.features?.conversation_organize === true
  const goalsEnabled = bootstrapData?.features?.goals === true
  const routinesEnabled = bootstrapData?.features?.routines === true
  const todayOpsEnabled = workbenchUI && bootstrapData?.features?.today_ops === true
  const todayOpsSummaryQuery = useQuery({
    queryKey: ['agent-today-ops', selectedAccount],
    queryFn: () => get<TodayOpsView>(`/agent/today-ops?account_id=${encodeURIComponent(selectedAccount)}`),
    enabled: todayOpsEnabled && !conversationId && !!selectedAccount,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  })
  const canManageGoals = !!bootstrapData && bootstrapData.role !== 'viewer' && bootstrapData.reason !== 'admin_override'
  const canManageRoutines = canManageGoals
  const eventResumeEnabled = bootstrapData?.features?.event_resume === true
  // 例行摘要条目的“更多/跳转”复用既有 /agent 路由：?panel=routine 只负责打开现有抽屉，不新增一级导航。
  useEffect(() => {
    if (!routinesEnabled || searchParams.get('panel') !== 'routine') return
    setRoutinePanelOpen(true)
    const next = new URLSearchParams(searchParams)
    next.delete('panel')
    setSearchParams(next, { replace: true })
  }, [routinesEnabled, searchParams, setSearchParams])
  const layoutPreferenceKey = me.data?.user_id && me.data.workspace.id
    ? `ops.agent-workbench-layout.v1:${me.data.user_id}:${me.data.workspace.id}`
    : ''
  const canRead = !!bootstrapData && (bootstrapData.can_use || bootstrapData.reason === 'no_model' || bootstrapData.reason === 'not_tested')
  const canWrite = bootstrapData?.can_use === true
  const detailQuery = useQuery({
    queryKey: ['agent-conversation', conversationId],
    queryFn: () => get<AgentConversationDetail>(`/agent/conversations/${conversationId}`),
    enabled: !!conversationId && canRead,
    refetchInterval: (query) => {
      if (eventResumeEnabled || !query.state.data?.active_run) return false
      return pagePollIntervalMs(pageVisible, 2000, query.state.fetchFailureCount)
    },
    refetchIntervalInBackground: false,
  })
  const detail = detailQuery.data
  const conversation = detail?.conversation
  const accountMismatch = desktopPresentation && !!conversation?.account_id && conversation.account_id !== selectedAccount
  const activeRun = detail?.active_run
  const actions = detail?.actions ?? []
  const inputs = detail?.inputs ?? []
  const inputQueuePaused = detail?.input_queue_paused === true
  const plans = detail?.plans ?? []
  const questions = detail?.questions ?? []
  const pendingQuestion = questions.find((question) => question.status === 'pending' && Date.now() < new Date(question.expires_at).getTime())
  const pendingActions = actions.filter((action) => ['pending', 'needs_input'].includes(action.status)).length
  const baseMessages = detail?.messages ?? []
  const {
    streaming, streamText, streamStage, streamError, streamErrors, setStreamError,
    streamConnection, runID, completedNotice, setCompletedNotice,
    sendInFlight, consumeRun, continueRun, compactRun,
    acceptPlan, answerQuestion, regenerate, stop,
    computerPickerOpen, setComputerPickerOpen,
    browserPickerOpen, setBrowserPickerOpen,
  } = useAgentRun({
    conversationId, detail, eventResumeEnabled, submitting, setSubmitting, baseMessages, desktopPresentation,
  })
  // DEV-AI27-10（W10b）：Chrome 侧栏草稿填入输入台待用户发送；停止与主界面同语义。
  useEffect(() => {
    if (!desktopPresentation) return
    if (!hasDesktopBridgeMethod('onSidepanelDraft')) return
    const offDraft = subscribeDesktopSidepanelDraft((draft) => {
      if (draft.text) setText((old) => (old ? `${old}
${draft.text}` : draft.text))
      toast.info('侧栏草稿已填入输入框；确认后发送。')
      window.setTimeout(() => inputRef.current?.focus(), 0)
    })
    const offStop = subscribeDesktopSidepanelStop(() => {
      void stop()
    })
    return () => { offDraft(); offStop() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desktopPresentation])
  useEffect(() => { setReviewActionID(null); setSubagentsArmed(false) }, [conversationId])
  useEffect(() => { setBrowserGrant(null); setBrowserPaused(false) }, [conversationId])
  useEffect(() => {
    if (!workbenchPanelOpen || reviewActionID || composerTrigger) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      const target = event.target as HTMLElement | null
      if (target?.closest('textarea, [contenteditable="true"], .agent-composer-candidates, [role="dialog"]')) return
      setWorkbenchPanelOpen(false)
      window.requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.desktop-agent-panel-button')?.focus())
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [workbenchPanelOpen, reviewActionID, composerTrigger])
  useEffect(() => {
    if (!reviewActionID) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setReviewActionID(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [reviewActionID])
  // OT-04：面板打开/页签切换只记录事件名与页签名，不记录对话正文。
  useEffect(() => {
    if (workbenchUI && workbenchPanelOpen) trackAgentEvent('agent_panel_open', 'panel')
  }, [workbenchUI, workbenchPanelOpen])
  useEffect(() => {
    if (workbenchUI && workbenchPanelOpen) trackAgentEvent('agent_panel_tab', workbenchPanelTab)
  }, [workbenchUI, workbenchPanelOpen, workbenchPanelTab])
  const persistedPartial = eventResumeEnabled && detail?.partial_output && !baseMessages.some((message) => message.message_key === detail.partial_output?.message_key) ? detail.partial_output : null
  const recoveryText = eventResumeEnabled ? persistedPartial?.text : recovered?.text
  const messageStream = useAgentMessageStream({
    conversationId, baseMessages, detail, detailLoading: detailQuery.isLoading, pendingUserMessages, setPendingUserMessages,
    desktopPresentation, conversation, organizeEnabled, pageVisible, eventResumeEnabled, qc,
  })
  const {
    messages, setManualUnreadSuppressedID,
    setPendingJump, localSearchOpen, setLocalSearchOpen, localSearchText, setLocalSearchText, localSearchBusy,
    localSearchResults, localSearchError, localSearchInputRef, openLocalSearch, searchSavedMessages, jumpToSearchResult,
  } = messageStream
  useEffect(() => {
    const onManualUnread = (event: Event) => {
      const id = (event as CustomEvent<{ id: string }>).detail?.id
      if (id && id === conversationIDRef.current) setManualUnreadSuppressedID(id)
    }
    window.addEventListener('ops:agent-manual-unread', onManualUnread)
    return () => window.removeEventListener('ops:agent-manual-unread', onManualUnread)
  }, [])
  const recoveryRunID = recovered?.runId || persistedPartial?.run_id || detail?.last_run?.id || ''
  const hasRunActivity = !!(activeRun || streaming || runID || streamText || recoveryText || streamError || completedNotice || pendingActions > 0)
  const visibleRunID = activeRun?.id || runID || (recoveryText ? recoveryRunID : '')
    || (hasRunActivity ? detail?.last_run?.id || '__current__' : '')
  const lastUser = [...messages].reverse().find((message) => message.role === 'user')
  const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant')
  const selectedModelOption = bootstrapData?.models.find((model) => modelKey(model.provider_id, model.model) === selectedModel)
  const actionRunIDs = useMemo(() => new Set(actions.map((action) => action.run_id)), [actions])
  const actionMessageByRun = useMemo(() => {
    const latest: Record<string, string> = {}
    for (const message of messages) if (message.role === 'assistant' && message.run_id && actionRunIDs.has(message.run_id)) latest[message.run_id] = message.id
    return latest
  }, [messages, actionRunIDs])
  const busy = submitting || streaming || !!activeRun
  // 有待办澄清问题时，服务端已把这次运行挂起（active_run 为 null），但客户端的事件流可能还没收尾，
  // busy 会一直是真。这种状态下必须允许用户发新消息替代问题，否则只能先回答或先停止。
  // 判据用 active_run + 在途提交，而不是等整轮流收尾：流什么时候关闭取决于服务端挂起策略，
  // 要求 submitting 归零会让发送键白等十几秒。
  const supersedeReady = !!pendingQuestion && !activeRun && !sendInFlight.current
  const composerBusy = busy && !supersedeReady
  const runInputsEnabled = workbenchUI && bootstrapData?.features?.run_control === true && !accountMismatch
  const attachments = useAttachmentQueue({ canWrite, busy, runInputsEnabled, bootstrapData, conversationId })
  const {
    files, setFiles, restoredAttachments, setRestoredAttachments, uploading, dragging, readyFiles, readyAttachmentIDs, failedFiles,
    clearDraftAttachments, resetDraftAttachments, dragHandlers,
  } = attachments
  useEffect(() => {
    if (!workbenchUI || !layoutPreferenceKey) return
    setWorkbenchLayoutLoadedKey('')
    try {
      const saved = JSON.parse(window.localStorage.getItem(layoutPreferenceKey) || '{}') as { listCollapsed?: boolean; panelOpen?: boolean }
      setWorkbenchListCollapsed(saved.listCollapsed === true)
      // UI-02：空对话不恢复“打开任务面板”的偏好，也不据此改写偏好。
      setWorkbenchPanelOpen(shouldAutoOpenPanel({ savedOpen: saved.panelOpen === true, conversationId: initialConversationRef.current }))
    } catch {
      setWorkbenchListCollapsed(false)
      setWorkbenchPanelOpen(false)
    } finally {
      setWorkbenchLayoutLoadedKey(layoutPreferenceKey)
    }
  }, [workbenchUI, layoutPreferenceKey])
  useEffect(() => {
    if (!workbenchUI) return
    const onShortcut = (event: Event) => {
      const action = (event as CustomEvent<string>).detail
      if (action === 'new') newConversation()
      if (action === 'toggle-list') setWorkbenchListCollapsed((value) => !value)
      if (action === 'toggle-panel') {
        setMobileListOpen(false)
        setWorkbenchPanelOpen((value) => !value)
      }
      if (action === 'search-conversations') {
        setWorkbenchListCollapsed(false)
        const containerWidth = document.querySelector('.desktop-agent-workbench')?.clientWidth ?? 0
        if (containerWidth < 1456) setMobileListOpen(true)
        window.setTimeout(() => document.querySelector<HTMLInputElement>('[aria-label="搜索对话"]')?.focus(), 50)
      }
      if (action === 'find-message') {
        openLocalSearch()
      }
    }
    window.addEventListener('ops:agent-workbench-shortcut', onShortcut)
    return () => window.removeEventListener('ops:agent-workbench-shortcut', onShortcut)
  }, [workbenchUI])
  useEffect(() => {
    if (!workbenchUI || !layoutPreferenceKey || workbenchLayoutLoadedKey !== layoutPreferenceKey) return
    window.localStorage.setItem(layoutPreferenceKey, JSON.stringify({ listCollapsed: workbenchListCollapsed, panelOpen: workbenchPanelOpen, panelWidth: workbenchPanelWidth }))
  }, [workbenchUI, layoutPreferenceKey, workbenchLayoutLoadedKey, workbenchListCollapsed, workbenchPanelOpen])
  useEffect(() => {
    if (!desktopPresentation || !currentAccount?.id) return
    if (previousDesktopAccount.current && previousDesktopAccount.current !== currentAccount.id) {
      setContextRefs((refs) => refs.filter((ref) => ref.account_id === null))
      setSkillRequests([])
    }
    previousDesktopAccount.current = currentAccount.id
  }, [desktopPresentation, currentAccount?.id])
  useEffect(() => {
    if (!conversation) {
      if (bootstrapData?.read_only) setSelectedMode('discuss')
      setSelectedModel((old) => old || modelKey(bootstrapData?.default_model?.provider_id, bootstrapData?.default_model?.model))
      setSelectedAccount((old) => old || currentAccount?.id || '')
      return
    }
    setSelectedModel(modelKey(conversation.model_provider_id, conversation.model))
    if (!desktopPresentation) setSelectedAccount(conversation.account_id ?? '')
    setHistoryAccount(conversation.account_id ?? '')
    setSelectedMode(bootstrapData?.read_only ? 'discuss' : conversation.mode ?? 'execute')
  }, [conversation?.id, conversation?.model_provider_id, conversation?.model, conversation?.account_id, conversation?.mode, bootstrapData?.read_only, bootstrapData?.default_model?.provider_id, bootstrapData?.default_model?.model, currentAccount?.id])
  useEffect(() => {
    if (!bootstrapData || bootstrap.isLoading || bootstrapData.privacy_notice_seen || savePrefs.isPending) return
    setPrivacyOpen(true)
  }, [bootstrapData?.privacy_notice_seen, bootstrap.isLoading])
  useEffect(() => {
    if (lastDraftConversationID.current === conversationId) return
    lastDraftConversationID.current = conversationId
    if (sendDestinationConversationID.current === conversationId) return
    sendDestinationConversationID.current = ''
    resetDraftAttachments()
    setText('')
    setContextRefs([])
    setPageRefs([])
    setSkillRequests([])
    setEditMessage(null)
  }, [conversationId, files])
  // AG-04：进入对话时先看本地有没有中断前的草稿；服务端整轮结束才落库，
  // 没有这份草稿，用户切回来只能看到空白等整轮跑完。
  useEffect(() => {
    if (partialStore.current === null) partialStore.current = browserStore()
    if (!conversationId || eventResumeEnabled) { setRecovered(null); return }
    setRecovered(readPartial(partialStore.current, conversationId))
  }, [conversationId, eventResumeEnabled])
  // AG-04：把正在生成的片段写进 sessionStorage；节流到 1 秒，避免每个 delta 都序列化。
  useEffect(() => {
    if (!conversationId || !streamText || eventResumeEnabled) return
    const now = Date.now()
    if (now - partialSavedAt.current < 1000) return
    partialSavedAt.current = now
    savePartial(partialStore.current, { conversationId, runId: runID, text: streamText, stage: streamStage, updatedAt: now })
  }, [conversationId, streamText, streamStage, runID, eventResumeEnabled])
  // 服务端已落库出这条助手消息，草稿就不再需要；否则恢复的气泡会与正式消息重复。
  useEffect(() => {
    if (!recovered) return
    const done = baseMessages.some((message) => message.role === 'assistant' && message.run_id && message.run_id === recovered.runId)
    if (!done && activeRun) return
    clearPartial(partialStore.current, recovered.conversationId)
    setRecovered(null)
  }, [recovered, baseMessages, activeRun])
  const invalidate = useCallback(async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['agent-conversations'] }),
      conversationId ? qc.invalidateQueries({ queryKey: ['agent-conversation', conversationId] }) : Promise.resolve(),
    ])
  }, [qc, conversationId])
  const openConversation = (id: string, matchedSeq?: number) => {
    setPendingJump(matchedSeq ? { conversationID: id, seq: matchedSeq } : null)
    navigate(`/agent/c/${id}`)
  }
  const newConversation = async () => {
    if (text.trim() || files.length > 0 || restoredAttachments.length > 0 || contextRefs.length > 0 || pageRefs.length > 0 || skillRequests.length > 0) {
      const discard = await confirm({
        title: '当前输入还没有发送', desc: '点“保留草稿”留在当前对话；继续会丢弃输入、引用和待发送附件，并新建对话。',
        confirmText: '丢弃草稿并新建', cancelText: '保留草稿',
      })
      if (!discard) return
    }
    conversationRequest.current = null
    setSelectedMode(bootstrapData?.read_only ? 'discuss' : 'execute')
    setText('')
    clearDraftAttachments()
    setContextRefs([])
    setPageRefs([])
    setSkillRequests([])
    setStreamError('')
    setCompletedNotice('')
    setMobileListOpen(false)
    navigate('/agent')
  }
  const createSideChat = async () => {
    if (!conversation) return
    if (text.trim() || files.length > 0 || restoredAttachments.length > 0 || contextRefs.length > 0 || pageRefs.length > 0 || skillRequests.length > 0) {
      const discard = await confirm({
        title: '当前输入还没有发送', desc: '旁问会在新会话打开；当前输入、引用和待发送附件不会带过去。',
        confirmText: '清除并打开旁问', cancelText: '留在这里',
      })
      if (!discard) return
    }
    try {
      const side = await post<AgentConversation>('/agent/conversations', {
        kind: 'side',
        parent_id: conversation.id,
        request_id: crypto.randomUUID(),
      })
      setSelectedMode('discuss')
      setText('')
      clearDraftAttachments()
      setContextRefs([])
      setPageRefs([])
      setSkillRequests([])
      setStreamError('')
      setCompletedNotice('')
      setMobileListOpen(false)
      await qc.invalidateQueries({ queryKey: ['agent-conversations'] })
      navigate(`/agent/c/${side.id}`)
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }

  const modelRef = selectedModelOption ? { provider_id: selectedModelOption.provider_id, model: selectedModelOption.model } : undefined
  const actualModel = detail?.last_run?.config_snapshot?.actual_model
  const runtimeSummary = actualModel ? `最近运行：${detail?.last_run?.mode === 'discuss' ? '讨论' : detail?.last_run?.mode === 'plan' ? '计划' : '执行'} · ${actualModel.channel === 'desktop' ? '客户端模型通道' : '服务器模型通道'} · ${actualModel.provider_name ?? ''} / ${actualModel.model}` : ''
  const runCostSummary = detail?.last_run
    ? `本轮 token：输入 ${(detail.last_run.prompt_tokens ?? 0).toLocaleString('zh-CN')} · 输出 ${(detail.last_run.completion_tokens ?? 0).toLocaleString('zh-CN')} · ${detail.last_run.cost_micros == null ? '未配置价格' : `费用 ${fmtCostMicros(detail.last_run.cost_micros, detail.last_run.cost_currency)}`}`
    : ''
  const createConversation = async () => {
    const body = { ...(selectedAccount ? { account_id: selectedAccount } : {}), ...(modelRef ? { model: modelRef } : {}) }
    const key = JSON.stringify(body)
    if (conversationRequest.current?.key !== key) conversationRequest.current = { key, id: crypto.randomUUID() }
    return post<AgentConversation>('/agent/conversations', { ...body, request_id: conversationRequest.current.id })
  }

  const validateSkillSelections = async () => {
    if (skillRequests.length === 0 || !selectedAccount) return true
    const missing: AgentSkillSelection[] = []
    try {
      for (const skill of skillRequests) {
        const page = await get<{ items: Array<{ id: string }> }>(`/skills?view=effective&account_id=${selectedAccount}&q=${encodeURIComponent(skill.name)}&limit=12`)
        if (!page.items.some((item) => item.id === skill.skill_id)) missing.push(skill)
      }
    } catch (error) {
      toast.error(errorMessage(error))
      return false
    }
    if (missing.length === 0) return true
    const missingKeys = new Set(missing.map((skill) => `${skill.skill_id}:${skill.work_id ?? ''}`))
    setSkillRequests((current) => current.map((skill) => missingKeys.has(`${skill.skill_id}:${skill.work_id ?? ''}`) ? { ...skill, unavailable: true } : skill))
    toast.error('有技能已被撤权或下架，已标为不可用；请移除后再发送。')
    return false
  }

  const sendMessage = async (edit?: AgentMessage) => {
    const draft = text.trim()
    const value = [pageReferenceText(pageRefs), draft].filter(Boolean).join('\n\n')
    if ((!value && readyAttachmentIDs.length === 0 && contextRefs.length === 0 && skillRequests.length === 0) || !canWrite || accountMismatch || composerBusy || sendInFlight.current || uploading || failedFiles.length > 0) return
    sendInFlight.current = true
    setSubmitting(true)
    setStreamError('')
    setCompletedNotice('')
    let optimisticRequestID = ''
    let messageAccepted = false
    try {
      let conv = conversation
      if (!conv) {
        conv = await createConversation()
        sendDestinationConversationID.current = conv.id
        navigate(`/agent/c/${conv.id}`, { replace: true })
      }
      let replacedQuestion: AgentQuestion | undefined
      if (!edit && pendingQuestion) {
        const replace = await confirm({
          title: '用这条消息替代待办问题？',
          desc: '当前澄清问题将标记为已替代，这条消息会作为新的用户请求启动运行。',
          confirmText: '替代问题并发送',
        })
        if (!replace) return
        replacedQuestion = pendingQuestion
      }
      if (edit && pendingQuestion) {
        toast.error('请先回答待办问题，或发送新消息并明确替代它。')
        return
      }
      if (!edit && !(await validateSkillSelections())) return
      const messageKey = JSON.stringify({
        edit_message_id: edit?.id ?? '',
        mode: bootstrapData?.features.plans ? selectedMode : undefined,
        conversation_id: conv.id, text: value, attachment_ids: edit ? [] : readyAttachmentIDs,
        page_refs: edit ? '' : pageReferenceText(pageRefs),
        context_refs: edit ? [] : contextRefsPayload(contextRefs),
        skill_requests: edit ? [] : skillRequestsPayload(skillRequests),
        account_id: selectedAccount || '', model: modelRef || null,
        allow_subagents: edit ? false : subagentsArmed,
      })
      const requestID = messageRequest.current?.key === messageKey
        ? messageRequest.current.id
        : crypto.randomUUID()
      if (requestID) messageRequest.current = { key: messageKey, id: requestID }
      if (!edit && desktopPresentation) {
        optimisticRequestID = requestID
        const latestSeq = messages.reduce((maximum, message) => Math.max(maximum, message.seq), 0)
        setPendingUserMessages((current) => [...current, {
          conversationID: conv.id,
          requestID,
          message: {
            id: `pending:${requestID}`,
            seq: latestSeq + 1,
            role: 'user',
            content: value,
            tool_calls: [],
            attachments: [...readyFiles.map((file) => file.attachment!), ...restoredAttachments],
            context_refs: contextRefs.map(({ type, id, artifact_id, revision, reference_scope, anchor, name }) => ({
              type, id, ...(artifact_id ? { artifact_id } : {}), revision, scope: reference_scope, name, ...(anchor ? { anchor } : {}),
            })),
            skill_requests: skillRequests.map(({ skill_id, work_id, name }) => ({ skill_id, ...(work_id ? { work_id } : {}), name })),
            run_id: null,
            created_at: new Date().toISOString(),
          },
        }])
      }
      const payload = {
        text: value,
        ...(!edit && bootstrapData?.features.plans ? { mode: selectedMode } : {}),
        attachment_ids: edit ? [] : readyAttachmentIDs,
        ...(!edit && contextRefs.length ? { context_refs: contextRefs.map(({ type, id, revision, reference_scope, anchor }) => ({ type, id, revision, scope: reference_scope, ...(anchor ? { anchor } : {}) })) } : {}),
        ...(!edit && skillRequests.length ? { skill_requests: skillRequests.map(({ skill_id, work_id }) => ({ skill_id, ...(work_id ? { work_id } : {}) })) } : {}),
        ...(selectedAccount ? { account_id: selectedAccount } : { account_id: '' }),
        ...(modelRef ? { model: modelRef } : {}),
        ...(requestID ? { request_id: requestID } : {}),
        ...(replacedQuestion ? { supersede_question_id: replacedQuestion.id } : {}),
        ...(!edit && subagentsArmed ? { allow_subagents: true } : {}),
        ...(!edit && bootstrapData?.features.agent_roles && selectedRoleID ? { role_id: selectedRoleID } : {}),
      }
      const acceptedDraftVersion = textDraftVersionRef.current
      const accepted = await consumeRun(conv.id, edit
        ? `/agent/conversations/${conv.id}/messages/${edit.id}/edit`
        : `/agent/conversations/${conv.id}/messages`, payload, (acceptance) => {
        messageAccepted = true
        if (desktopPresentation) {
          setPendingUserMessages((current) => current.map((item) => item.requestID === requestID
            ? { ...item, messageID: acceptance?.message_id, runID: acceptance?.run_id }
            : item))
        }
        if (conversationIDRef.current === conv.id) {
          setText((current) => textDraftVersionRef.current === acceptedDraftVersion && current === text ? '' : current)
        }
      })
      if (!accepted || conversationIDRef.current !== conv.id) {
        if (!messageAccepted && optimisticRequestID) setPendingUserMessages((current) => current.filter((item) => item.requestID !== optimisticRequestID))
        return
      }
      setFiles((current) => (current === files ? [] : current))
      setRestoredAttachments((current) => (current === restoredAttachments ? [] : current))
      sendDestinationConversationID.current = ''
      messageRequest.current = null
      if (!edit) {
        setContextRefs((current) => (current === contextRefs ? [] : current))
        setPageRefs((current) => (current === pageRefs ? [] : current))
        setSkillRequests((current) => (current === skillRequests ? [] : current))
        setSubagentsArmed(false)
      }
      setEditMessage(null)
    } catch (error) {
      if (!messageAccepted && optimisticRequestID) setPendingUserMessages((current) => current.filter((item) => item.requestID !== optimisticRequestID))
      toast.error(errorMessage(error))
    }
    finally { sendInFlight.current = false; setSubmitting(false) }
  }

  const postWorkbenchInput = async (kind: 'steer' | 'queue') => {
    if (!runInputsEnabled || !conversationId || !conversation || !canWrite || inputSubmitting || uploading || failedFiles.length > 0) return
    const value = [pageReferenceText(pageRefs), text.trim()].filter(Boolean).join('\n\n')
    if ((!value && readyAttachmentIDs.length === 0 && contextRefs.length === 0 && skillRequests.length === 0) || Array.from(value).length > bootstrapData.limits.message_chars) return
    const targetRunID = activeRun?.id || runID
    if (kind === 'steer' && !targetRunID) return
    const payload = {
      kind,
      ...(targetRunID ? { run_id: targetRunID } : {}),
      text: value,
      attachment_ids: readyAttachmentIDs,
      context_refs: contextRefs.map(({ type, id, revision, reference_scope, anchor }) => ({ type, id, revision, scope: reference_scope, ...(anchor ? { anchor } : {}) })),
      skill_requests: skillRequests.map(({ skill_id, work_id }) => ({ skill_id, ...(work_id ? { work_id } : {}) })),
    }
    const key = JSON.stringify({ conversation_id: conversation.id, ...payload })
    const requestID = inputRequest.current?.key === key ? inputRequest.current.id : crypto.randomUUID()
    inputRequest.current = { key, id: requestID }
    setInputSubmitting(true)
    setStreamError('')
    try {
      const accepted = await post<AgentInput>(`/agent/conversations/${conversation.id}/inputs`, { ...payload, request_id: requestID })
      if (conversationIDRef.current !== conversation.id) return
      setText('')
      setFiles([])
      setRestoredAttachments([])
      setContextRefs([])
      setPageRefs([])
      setSkillRequests([])
      setEditMessage(null)
      inputRequest.current = null
      await invalidate()
      toast.success(accepted.status === 'consumed' ? '补充已接收并开始处理' : kind === 'steer' ? '补充已保存，将在安全边界接收' : '已排到下一条')
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setInputSubmitting(false)
    }
  }

  const updateQueuedInput = async (input: AgentInput, value: string) => {
    await patch(`/agent/inputs/${input.id}`, { expected_revision: input.revision, text: value })
    await invalidate()
  }

  const cancelQueuedInput = async (input: AgentInput) => {
    await del(`/agent/inputs/${input.id}`, { expected_revision: input.revision })
    await invalidate()
  }

  const restoreNeedsReviewInput = async (input: AgentInput) => {
    if (input.attachments.length !== input.attachment_ids.length) {
      toast.error('输入中的附件已失效或不可访问；原输入仍保留，请先刷新后再处理。')
      await detailQuery.refetch()
      return
    }
    if (readyAttachmentIDs.length + input.attachments.length > (bootstrapData?.limits.attachments_per_message ?? 6)
      || contextRefs.length + input.context_refs.length > 12 || skillRequests.length + input.skill_requests.length > 3) {
      toast.error('当前草稿与待复核输入合并后会超过附件、引用或技能配额；请先整理当前草稿。')
      return
    }
    try {
      await cancelQueuedInput(input)
      setText((old) => old ? `${old}\n${input.text}` : input.text)
      setRestoredAttachments((old) => [...old, ...input.attachments.filter((item) => !old.some((existing) => existing.id === item.id))])
      setContextRefs((old) => {
        const restored = input.context_refs.map((ref): AgentContextSelection => ({
          id: ref.id, type: ref.type, name: ref.name || ref.type, summary: '', scope: ref.scope,
          account_id: null, revision: ref.revision || '', updated_at: '', reference_scope: ref.scope === 'conversation' ? 'conversation' : 'turn',
          ...(ref.anchor ? { anchor: ref.anchor } : {}),
        }))
        return [...old, ...restored.filter((ref) => !old.some((item) => item.id === ref.id && item.type === ref.type))].slice(0, 12)
      })
      setSkillRequests((old) => [...old, ...input.skill_requests.map((item): AgentSkillSelection => ({
        skill_id: item.skill_id, work_id: item.work_id, name: item.name || item.skill_id, hint: '', scope: '',
      })).filter((item) => !old.some((existing) => existing.skill_id === item.skill_id && existing.work_id === item.work_id))].slice(0, 3))
      setWorkbenchPanelOpen(false)
      window.setTimeout(() => inputRef.current?.focus(), 0)
      toast.success('已移回输入框；确认内容后再发送')
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }

  const resumeInputQueue = async () => {
    if (!conversationId || !inputQueuePaused) return
    const requestID = resumeInputRequest.current || crypto.randomUUID()
    resumeInputRequest.current = requestID
    try {
      await post(`/agent/conversations/${conversationId}/inputs/resume`, { request_id: requestID })
      resumeInputRequest.current = null
      await invalidate()
    } catch (error) { toast.error(errorMessage(error)) }
  }

  const forkFromMessage = async (message: AgentMessage) => {
    if (!conversationId || !organizeEnabled) return
    try {
      const result = await post<{ conversation: AgentConversation; actual_through_seq: number; replayed?: boolean }>(
        `/agent/conversations/${conversationId}/fork`,
        { through_message_id: message.id, request_id: crypto.randomUUID() },
      )
      if (result.actual_through_seq < message.seq) toast.message(`截点位于工具调用组内，分支已规范到第 ${result.actual_through_seq} 条消息之后`)
      navigate(`/agent/c/${result.conversation.id}`)
    } catch (error) { toast.error(errorMessage(error)) }
  }

  // BR-08：接管 = 撤销当前会话的活动租约（服务端只记录，本机同步停控）。
  // 不依赖渲染端是否持有 grant 句柄：派生租约/续签可能没有句柄，但仍必须能接管。
  const takeOverBrowser = async () => {
    if (!conversationId) {
      toast.error('无法接管', { description: '当前没有进行中的会话任务。' })
      return
    }
    try {
      await post(`/agent/conversations/${conversationId}/browser-handoff`, {})
      setBrowserPaused(true)
      toast.success('已接管', { description: 'Agent 已暂停；你完成后点控制条上的“交回 Agent”。' })
    } catch (error) { toast.error(errorMessage(error)) }
  }
  const handBackBrowser = async () => {
    if (!conversationId) return
    const activeRunID = browserGrant?.run_id || runID
    if (!activeRunID) {
      toast.error('无法交回', { description: '当前任务已结束；重新发送任务后再交回控制权。' })
      return
    }
    try {
      const grant = await post<BrowserGrantView>(`/agent/conversations/${conversationId}/browser-handback`, {
        run_id: activeRunID,
      })
      setBrowserGrant(grant)
      setBrowserPaused(false)
      toast.success('已交回 Agent', { description: '新的 30 秒租约已生效；Agent 下一步操作会重新校验该租约。' })
    } catch (error) { toast.error(errorMessage(error)) }
  }
  const quoteArtifact = (reference: AgentContextSelection, prompt: string) => {    setContextRefs((old) => old.some((item) => item.type === reference.type && item.id === reference.id)
      ? old : old.length < 12 ? [...old, reference] : old)
    setText((old) => old ? `${old}\n${prompt}` : prompt)
    setEditMessage(null)
    setWorkbenchPanelTab('context')
    setArtifactsOpen(false)
    window.setTimeout(() => inputRef.current?.focus(), 0)
  }

  const openGoalPanel = () => {
    if (workbenchUI) {
      setWorkbenchPanelTab('task')
      setWorkbenchPanelOpen(true)
    } else setGoalPanelOpen(true)
  }
  const changeMode = async (mode: AgentMode) => {
    if (busy || bootstrapData?.read_only) return
    if (conversation?.kind === 'side' && mode !== 'discuss') {
      toast.error('旁问是只读会话，不能切到计划或执行模式')
      return
    }
    const previous = selectedMode
    setSelectedMode(mode)
    if (!conversationId) return
    try {
      await patch(`/agent/conversations/${conversationId}`, { expected_revision: conversation?.revision, mode })
      await invalidate()
    } catch (error) { setSelectedMode(previous); toast.error(errorMessage(error)); void detailQuery.refetch() }
  }
  // IX-01/02/03：输入触发器只负责打开候选；选中后删掉触发词，正文不出现 @/$。
  const updateComposerTrigger = (value: string, caret: number) => {
    if (!workbenchUI) return
    setComposerTrigger(detectComposerTrigger(value, caret, composingRef.current))
  }
  const focusComposer = (caret?: number) => window.setTimeout(() => {
    inputRef.current?.focus()
    if (typeof caret === 'number') inputRef.current?.setSelectionRange(caret, caret)
  }, 0)
  const clearTriggerToken = () => {
    const next = removeComposerTrigger(text, composerTrigger)
    setText(next.text)
    setComposerTrigger(null)
    focusComposer(next.caret)
  }
  const addContextSelection = (item: AgentContextSelection) => {
    const result = addToLimitedList(contextRefs, item, 12, (ref) => `${ref.type}:${ref.id}`)
    if (!result.ok) return false
    setContextRefs(result.list)
    clearTriggerToken()
    return true
  }
  const addSkillSelection = (item: AgentSkillSelection) => {
    const result = addToLimitedList(skillRequests, item, 3, (skill) => `${skill.skill_id}:${skill.work_id ?? ''}`)
    if (!result.ok) return false
    setSkillRequests(result.list)
    clearTriggerToken()
    return true
  }
  const runComposerCommand = (command: AgentCommand) => {
    trackAgentEvent('agent_command_run', command.name)
    clearTriggerToken()
    if (command.name === 'new') { newConversation(); return }
    if (command.name === 'plan' || command.name === 'execute' || command.name === 'discuss') {
      if (command.name === 'discuss' && bootstrapData?.read_only) return
      void changeMode(command.name)
      return
    }
    if (command.name === 'model') { setModelMenuOpen(true); return }
    if (command.name === 'context') { setWorkbenchPanelTab('context'); setWorkbenchPanelOpen(true); return }
    if (command.name === 'skills') {
      if (!selectedAccount) { toast.info('先选择运营账号，再请求技能。'); return }
      setSkillPickerOpen(true); return
    }
    if (command.name === 'compact') {
      if (bootstrapData?.features.compact !== true) { toast.info('当前工作区未开启压缩。'); return }      setCompactDialogOpen(true); return
    }
    if (command.name === 'goal') { openGoalPanel(); return }
    if (command.name === 'archive') {
      if (!conversation) { toast.info('当前没有可归档的对话。'); return }
      void (async () => {
        if (!(await confirm({ title: '归档这段对话？', desc: '消息与卡片仍会保留，可在“已归档”中恢复。', confirmText: '归档' }))) return
        try {
          await patch(`/agent/conversations/${conversation.id}`, { expected_revision: conversation.revision, archived: true, ...(pendingActions > 0 ? { confirm_pending_actions: true } : {}) })
          await invalidate()
        } catch (error) { toast.error(errorMessage(error)) }
      })()
    }
  }
  // BR-03：应用内浏览选中元素后，作为文本上下文插入输入框（P1 不新增服务端引用类型）。
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ title?: string; selector?: string; text?: string; tag?: string }>).detail
      if (!detail?.selector) return
      const block = `【页面元素】${detail.tag ?? ''} ${detail.title ?? ''}\n${detail.selector}${detail.text ? `\n${detail.text}` : ''}`
      setText((old) => old ? `${old}\n\n${block}` : block)
      setEditMessage(null)
      window.setTimeout(() => inputRef.current?.focus(), 0)
    }
    window.addEventListener('ops:agent-page-element', handler)
    return () => window.removeEventListener('ops:agent-page-element', handler)
  }, [])
  // BR-11：页面元素 + 一句批注 → 输入台引用筹码；只入草稿，不自动发送。
  useEffect(() => { pageRefsRef.current = pageRefs }, [pageRefs])
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ title?: string; url?: string; selector?: string; text?: string; note?: string }>).detail
      const selector = detail?.selector
      const note = detail?.note?.trim()
      if (!selector || !note) return
      if (pageRefsRef.current.length >= 12) {
        toast.error('每轮最多引用 12 项页面元素，请先移除一项。')
        return
      }
      const name = `页面元素 · ${(detail.title || selector).slice(0, 80)}`
      setPageRefs((current) => current.length >= 12 ? current : [...current, {
        id: crypto.randomUUID(), name, url: detail.url ?? '', selector,
        text: (detail.text ?? '').slice(0, 2000), note: note.slice(0, 160),
      }])
      setEditMessage(null)
      window.setTimeout(() => inputRef.current?.focus(), 0)
    }
    window.addEventListener('ops:agent-page-annotation', handler)
    return () => window.removeEventListener('ops:agent-page-annotation', handler)
  }, [])
  useEffect(() => {
    const focus = () => inputRef.current?.focus()
    window.addEventListener('ops:agent-focus-composer', focus)
    return () => window.removeEventListener('ops:agent-focus-composer', focus)
  }, [])
  // IX-09：命令面板本页命令组与 / 命令同源——面板经 agentCmd 事件分发到同一执行器。
  useEffect(() => {
    const handler = (event: Event) => {
      const name = (event as CustomEvent<{ name: string }>).detail?.name
      if (!name || name === 'new') return
      const command = COMMANDS.find((item) => item.name === name)
      if (command) runComposerCommand(command)
    }
    window.addEventListener('ops:agent-cmd', handler)
    return () => window.removeEventListener('ops:agent-cmd', handler)
  })
  const updateSelection = async (kind: 'model' | 'account', value: string) => {    if (kind === 'model') setSelectedModel(value)
    else {
      if (value !== selectedAccount && (skillRequests.length > 0 || contextRefs.some((ref) => ref.account_id !== null))) {
        const affected = [
          ...contextRefs.filter((ref) => ref.account_id !== null).map((ref) => ref.name),
          ...skillRequests.map((request) => request.name),
        ]
        if (!(await confirm({ title: '切换操作账号？', desc: `待发送内容中的账号专属引用和技能请求会被清除：${affected.join('、')}`, confirmText: '清除并切换' }))) return
        setContextRefs((refs) => refs.filter((ref) => ref.account_id === null))
        setSkillRequests([])
      }
      setSelectedAccount(value)
    }
    if (!conversationId) return
    try {
      const payload = kind === 'model'
        ? { expected_revision: conversation?.revision, model: value ? { provider_id: value.split('::')[0], model: value.slice(value.indexOf('::') + 2) } : null }
        : { expected_revision: conversation?.revision, account_id: value }
      await patch(`/agent/conversations/${conversationId}`, payload)
      await qc.invalidateQueries({ queryKey: ['agent-conversation', conversationId] })
      await qc.invalidateQueries({ queryKey: ['agent-conversations'] })
    } catch (error) { toast.error(errorMessage(error)); void detailQuery.refetch() }
  }

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isEnterWithoutComposition(event.nativeEvent) && !event.shiftKey) {
      event.preventDefault()
      if (editMessage) void sendMessage(editMessage)
      else if (composerBusy && runInputsEnabled) void postWorkbenchInput('steer')
      else void sendMessage()
    }
  }

  const inputDisabled = !canWrite || accountMismatch || composerBusy && !runInputsEnabled || uploading || inputSubmitting
  const accountList = (accounts.data ?? []).filter((account) => account.status === 'active')
  const selectedAccountName = accountList.find((account) => account.id === selectedAccount)?.name || '不指定账号'
  const selectedModelName = selectedModelOption?.model || '选择模型'
  // AG-03：选了别的账号而历史仍属于原账号时，界面必须说清楚，否则用户以为上下文也跟着换了。
  const accountSwitched = !!conversationId && !!historyAccount && selectedAccount !== historyAccount
  const historyAccountName = accountList.find((account) => account.id === historyAccount)?.name || '原账号'
  const attachmentCount = messages.reduce((total, message) => total + message.attachments.length, 0)
  const canSendContent = !!text.trim() || pageRefs.length > 0 || readyAttachmentIDs.length > 0 || contextRefs.length > 0 || skillRequests.length > 0
  const pageContextSelections: AgentContextSelection[] = pageRefs.map((ref) => ({
    id: ref.id, type: 'page_element', name: ref.name, summary: ref.note, scope: 'turn',
    account_id: selectedAccount || null, revision: '', updated_at: '', reference_scope: 'turn',
  }))
  const selectedWorkOptions = contextRefs.filter((ref) => ref.type === 'work').map((ref) => ({ id: ref.id, name: ref.name }))
  const latestSkillUsage = lastAssistant && lastUser && lastAssistant.run_id === lastUser.run_id
    ? (lastUser.skill_requests ?? []).map((request) => lastAssistant.skill_usage?.find((skill) => skill.id === request.skill_id)
      ?? { id: request.skill_id, name: request.name || request.skill_id.slice(0, 8), scope: '', loaded: false })
    : []

  if (bootstrap.isLoading) return <div className="flex h-full items-center justify-center text-sm text-mist-400"><LoaderCircle className="mr-2 size-4 animate-spin" />正在准备智能体…</div>
  if (bootstrap.isError || !bootstrapData) return <div className="m-auto max-w-xl p-6 text-center"><p className="text-sm text-danger">{errorMessage(bootstrap.error)}</p><Button className="mt-3" onClick={() => void bootstrap.refetch()}>重试</Button></div>
  // AG-01: Navigate for unavailability page
  if (!bootstrapData.can_use && bootstrapData.reason !== 'no_model' && bootstrapData.reason !== 'not_tested') return <Unavailable bootstrap={bootstrapData} navigate={navigate} />

  // UI-01：会话头只读汇总；状态优先级见 docs/38 §7.1 与 §20.2。
  const pendingQuestions = questions.filter((question) => question.status === 'pending').length
  const headerState = deriveHeaderState({
    title: conversation?.title || 'AI 对话',
    hasConversation: !!conversationId,
    accountName: selectedAccountName,
    mode: conversation?.mode || selectedMode,
    activeRun,
    connection: streamConnection,
    pendingActions,
    pendingQuestions,
    goalStatus: detail?.goal?.status,
    usage: detail?.usage,
    panelOpen: workbenchPanelOpen,
    pendingCount: pendingActions + pendingQuestions,
    readOnly: bootstrapData.read_only,
    canUse: bootstrapData.can_use,
    reason: bootstrapData.reason,
    modelName: selectedModelName,
  })

  const sidebarSlot = document.getElementById('agent-sidebar-slot')
  const titleSlot = document.getElementById('agent-title-slot')
  const toolbarSlot = document.getElementById('agent-toolbar-slot')
  const renameConversation = async (title: string) => {
    if (!conversation) return
    try {
      await patch(`/agent/conversations/${conversation.id}`, { expected_revision: conversation.revision, title })
      await invalidate()
    } catch (error) { toast.error(errorMessage(error)) }
  }
  const renderConversationTitle = () => (
    <>
      {conversation
        ? <input key={`${conversation.id}:${conversation.title}`} defaultValue={conversation.title} aria-label="对话标题" maxLength={60}
            style={{ width: `${Math.min(440, Math.max(42, Array.from(conversation.title).length * 12))}px` }}
            onBlur={(event) => {
              const title = event.target.value.trim()
              if (title && title !== conversation.title) void renameConversation(title)
            }} className="min-w-0 max-w-[320px] truncate border-0 bg-transparent text-[13px] font-semibold text-mist-800 outline-none" />
        : <span className="text-[13px] font-semibold text-mist-800">AI 对话</span>}
      {conversation && !desktopPresentation && <span className="hidden text-[12px] text-mist-400 xl:inline">本对话 {detail?.usage.prompt_tokens ?? 0} 输入 / {detail?.usage.completion_tokens ?? 0} 输出 token</span>}
    </>
  )
  const renderTitle = () => desktopPresentation
    ? <span className="text-[13px] font-semibold text-mist-800">AI 对话</span>
    : renderConversationTitle()
  const handleRunErrorAction = (action: string) => {
    if (action === 'retry') { regenerate(); return }
    if (action === 'change-model') { setModelMenuOpen(true); return }
    if (action === 'open-models') { navigate('/settings/models'); return }
    if (action === 'reselect-context') { setContextPickerOpen(true); return }
    if (action === 'open-permissions') { navigate('/settings/members'); return }
    if (action === 'verify') { void detailQuery.refetch() }
  }
  const composerView: AgentComposerView = {
    attachments, desktopPresentation, workbenchUI, bootstrapData, conversation, conversationId, visibleRunID, actionExecuting, messages, detail,
    text, setText, inputRef, onInputKeyDown, inputDisabled, canWrite, busy, runInputsEnabled, composerBusy,
    canSendContent, inputSubmitting, accountMismatch, composerTrigger, composingRef, textDraftVersionRef,
    updateComposerTrigger, setComposerTrigger, focusComposer, selectedAccount, contextRefs, setContextRefs,
    pageRefs, setPageRefs, subagentsArmed, setSubagentsArmed, setWorkbenchPanelTab, setWorkbenchPanelOpen,
    skillRequests, setSkillRequests, addContextSelection, addSkillSelection, runComposerCommand,
    setContextPickerOpen, setOperationDirectoryOpen, setTodayOpsOpen, setSkillPickerOpen,
    setCapabilitiesOpen, setWorkflowPickerOpen, setComputerPickerOpen, setRoutinePanelOpen,
    createSideChat, openGoalPanel, navigate, todayOpsEnabled, selectedMode, changeMode,
    selectedModel, selectedModelName, modelMenuOpen, setModelMenuOpen, updateSelection,
    runInputMenuOpen, setRunInputMenuOpen, postWorkbenchInput, sendMessage, editMessage, setEditMessage,
    run: { activeRun: activeRun ?? undefined, streamStage, streamError, streamErrors, streamConnection, pendingActions, completedNotice, handleRunErrorAction, stop, continueRun },
    onboarding, onboardingDismissed, setOnboardingDismissed, runtimeSummary, runCostSummary, goalsEnabled, routinesEnabled,
  }
  return (
    <>
      {sidebarSlot && !desktopPresentation && createPortal(
        <div className="absolute inset-0 flex min-h-0 flex-col">
          <AgentConversationList currentID={conversationId} search={search} setSearch={setSearch} onSelect={openConversation} onNew={newConversation} sidebarTitle={conversation?.title || '对话'} organizeEnabled={organizeEnabled} goalsEnabled={goalsEnabled} />
        </div>,
        sidebarSlot,
      )}
      {titleSlot && createPortal(<div className="flex min-w-0 items-center gap-2">{renderTitle()}</div>, titleSlot)}
      {toolbarSlot && !desktopPresentation && createPortal(<>
        {bootstrapData.features.artifacts === true && conversation && <IconButton label="查看产物" onClick={() => setArtifactsOpen(true)}><FileText className="size-4" /></IconButton>}
        {goalsEnabled && conversation && <IconButton label="任务目标与上下文整理" onClick={openGoalPanel}><Bot className="size-4" /></IconButton>}
        {routinesEnabled && <IconButton label="例行任务" onClick={() => setRoutinePanelOpen(true)}><CalendarClock className="size-4" /></IconButton>}
        <IconButton label="对话设置" onClick={() => setSettingsOpen(true)}><Settings2 className="size-4" /></IconButton>
      </>, toolbarSlot)}
      <div className={`relative flex h-full min-h-0 overflow-hidden bg-[var(--ops-canvas)] ${desktopPresentation ? 'desktop-agent-workspace' : ''} ${workbenchUI ? 'desktop-agent-workbench' : ''}`} data-list-collapsed={workbenchListCollapsed} data-panel-open={workbenchPanelOpen}>
      {desktopPresentation && <aside className="desktop-agent-list" aria-label="AI 对话列表" data-testid="desktop-agent-list">
        <AgentConversationList currentID={conversationId} search={search} setSearch={setSearch} onSelect={openConversation} onNew={newConversation} sidebarTitle="AI 对话" desktopPresentation organizeEnabled={organizeEnabled} goalsEnabled={goalsEnabled} />
      </aside>}
      <section className={`flex min-w-0 flex-1 flex-col ${workbenchUI ? 'desktop-agent-workbench-main' : ''}`}>
        {workbenchUI
          ? <ConversationHeader state={headerState} editable={!!conversation && !bootstrapData.read_only} onRename={(title) => void renameConversation(title)}
            onTogglePanel={() => { setMobileListOpen(false); setWorkbenchPanelOpen((value) => !value) }} onOpenModels={() => navigate('/settings/models')}
            onPrivacySeen={() => savePrefs.mutate({ agent_privacy_notice_seen: true })}
            leading={<IconButton label={workbenchListCollapsed ? '打开对话列表' : '收起会话列表'} className="desktop-agent-workbench-list-button md:hidden" onClick={() => {
              if (workbenchListCollapsed) setWorkbenchListCollapsed(false); else { setWorkbenchPanelOpen(false); setMobileListOpen(true) }
            }}><Menu className="size-4" /></IconButton>}
            sideChat={conversation?.kind === 'side'} onOpenMainConversation={conversation?.kind === 'side' && conversation.parent_id ? () => openConversation(conversation.parent_id!) : undefined} />
          : <header className={`flex min-h-14 shrink-0 items-center gap-2 border-b border-mist-200 bg-white px-3 sm:px-5 ${desktopPresentation ? 'desktop-agent-chat-header' : 'lg:hidden'}`}>
            <IconButton label="打开对话列表" className="md:hidden" onClick={() => { setWorkbenchPanelOpen(false); setMobileListOpen(true) }}><Menu className="size-4" /></IconButton>
            <div className={`flex min-w-0 items-center gap-2 ${desktopPresentation ? 'desktop-agent-chat-heading' : 'flex-1'}`}>
              {desktopPresentation ? <>{renderConversationTitle()}<span className="desktop-agent-private-tag">仅本人可见</span></> : renderTitle()}
            </div>
            {desktopPresentation ? null : <IconButton label="对话设置" onClick={() => setSettingsOpen(true)}><Settings2 className="size-4" /></IconButton>}
          </header>}
        {workbenchUI && runCostSummary && <div className="border-b border-mist-100 bg-white px-4 py-1 text-center text-xs text-mist-500" data-testid="agent-run-cost">{runCostSummary}</div>}
        {bootstrapData.read_only && <div className="border-b border-gamboge-200 bg-gamboge-50 px-4 py-2 text-center text-[12px] text-gamboge-800">当前为观察者：智能体只能查询，不能修改。</div>}
        {accountMismatch && <div className="border-b border-gamboge-200 bg-gamboge-50 px-4 py-2 text-center text-[12px] text-gamboge-800" data-testid="agent-account-switched">此对话属于「{historyAccountName}」，当前账号为「{selectedAccountName}」。<button type="button" className="ml-2 underline" onClick={newConversation}>为当前账号新建对话</button></div>}

      <AgentMessageStream
        stream={messageStream} desktopPresentation={desktopPresentation} workbenchUI={workbenchUI} conversationId={conversationId} conversation={conversation}
        detailLoading={detailQuery.isLoading} detailError={detailQuery.error} detailErrorIsError={detailQuery.isError} detailHasMore={detail?.has_more === true} onRefetchDetail={() => void detailQuery.refetch()}
        lastAssistant={lastAssistant} lastUser={lastUser} selectedModelOption={selectedModelOption} actions={actions} plans={plans} questions={questions} pendingQuestion={pendingQuestion}
        actionMessageByRun={actionMessageByRun} actionExecuting={actionExecuting} reviewActionID={reviewActionID} setReviewActionID={setReviewActionID} organizeEnabled={organizeEnabled} busy={busy} personalMemoriesEnabled={bootstrapData.features.personal_memories === true}
        canWrite={canWrite} pageRefs={pageRefs} selectedAccount={selectedAccount} clearDraftAttachments={clearDraftAttachments} setEditMessage={setEditMessage} setText={setText} setContextRefs={setContextRefs} setPageRefs={setPageRefs}
        setSkillRequests={setSkillRequests} inputRef={inputRef} addContextSelection={addContextSelection} regenerate={regenerate} setActionExecuting={setActionExecuting} invalidate={invalidate} continueRun={continueRun} acceptPlan={acceptPlan}
        answerQuestion={answerQuestion} forkFromMessage={(message) => void forkFromMessage(message)} visibleRunID={visibleRunID} streamText={streamText} recoveryText={recoveryText} recoveryRunID={recoveryRunID} eventResumeEnabled={eventResumeEnabled} activeRun={activeRun ?? undefined}
        streamStage={streamStage} streaming={streaming} runID={runID} streamConnection={streamConnection} pendingActions={pendingActions} streamError={streamError} streamErrors={streamErrors} completedNotice={completedNotice}
        handleRunErrorAction={handleRunErrorAction} hasRunActivity={hasRunActivity} dragging={dragging} dragHandlers={dragHandlers} noModel={!bootstrapData.can_use} todayOpsEnabled={todayOpsEnabled} todayOpsSummaryData={todayOpsSummaryQuery.data} todayOpsSummaryIsError={todayOpsSummaryQuery.isError}
        pendingQuestions={pendingQuestions} onOpenTodayOps={() => setTodayOpsOpen(true)}
        aux={<>
          {/* P5-4：电脑租约存在时常驻控制条；D-224 软冻结：computer_use 关闭时彻底不挂载（不留灰条占位）。 */}
          {bootstrapData.features.computer_use === true && <ComputerControlBar enabled conversationId={conversationId} runId={runID || undefined}
            onReturnChat={() => { setComputerPickerOpen(false); window.setTimeout(() => inputRef.current?.focus(), 0) }} />}
          {/* A12：模型请求前台时在本机选窗，选定后即时建 30 秒租约（不做发消息前预授权）；D-224 随 computer_use 门控。 */}
          {bootstrapData.features.computer_use === true && <ComputerWindowPicker open={computerPickerOpen} conversationId={conversationId} runId={runID || undefined}
            onClose={() => setComputerPickerOpen(false)}
            onAuthorized={(summary) => { setText((old) => old ? `${old}\n已选择窗口「${summary}」，请继续。` : `已选择窗口「${summary}」，请继续。`); window.setTimeout(() => inputRef.current?.focus(), 0) }} />}
          {/* A30：模型请求浏览器标签时授权；D-224 软冻结：chrome_connect / browser_workspace 均关闭时不挂载。 */}
          {(bootstrapData.features.chrome_connect === true || bootstrapData.features.browser_workspace === true) && <BrowserTabAuthorizeDialog open={browserPickerOpen} conversationId={conversationId} runId={runID || undefined}
            onClose={() => setBrowserPickerOpen(false)}
            onAuthorized={(summary, grant) => { setBrowserGrant(grant); setBrowserPaused(false); setText((old) => old ? `${old}\n已选择标签「${summary}」，请继续。` : `已选择标签「${summary}」，请继续。`); window.setTimeout(() => inputRef.current?.focus(), 0) }} />}
          {/* DEV-A13：协作任务（子任务进度、单项停止、汇总结果）；D-224 软冻结：subagents 关闭时彻底不挂载。 */}
          {conversation && bootstrapData.features.subagents === true && <div className="mx-auto max-w-3xl px-3">
            <DelegationPanel conversationId={conversation.id} onNavigateArtifact={bootstrapData.features.artifacts === true ? () => setArtifactsOpen(true) : undefined} />
          </div>}
        </>}
        composer={<AgentComposer view={composerView} />}
      />
      </section>

      {workbenchUI && workbenchPanelOpen && <div className="desktop-agent-panel-backdrop" aria-hidden="true" onClick={() => setWorkbenchPanelOpen(false)} />}
      {workbenchUI && workbenchPanelOpen && <PanelResizer width={workbenchPanelWidth} onWidthChange={setWorkbenchPanelWidth} />}
      {workbenchUI && workbenchPanelOpen && <WorkbenchSidePanel
        width={workbenchPanelWidth} tab={workbenchPanelTab} setTab={setWorkbenchPanelTab} close={() => setWorkbenchPanelOpen(false)} browserWorkspaceEnabled={bootstrapData.features.browser_workspace === true}
        subagentsEnabled={bootstrapData.features.subagents === true} conversation={conversation} activeRun={activeRun ?? undefined} busy={busy} pendingActions={pendingActions} pendingQuestions={pendingQuestions}
        actionCount={actions.length} selectedAccountName={selectedAccountName} selectedModelName={selectedModelName} attachmentCount={attachmentCount} contextRefs={[...contextRefs, ...pageContextSelections]}
        skillRequests={skillRequests} latestSkillUsage={latestSkillUsage} artifactsEnabled={bootstrapData.features.artifacts === true} artifactCount={detail?.artifact_count ?? 0} goalsEnabled={goalsEnabled}
        compactEnabled={eventResumeEnabled} canManageGoals={canManageGoals} models={bootstrapData.models} goal={detail?.goal} onCompact={compactRun} actions={actions} questions={questions} inputs={inputs}
        inputQueuePaused={inputQueuePaused} onUpdateInput={updateQueuedInput} onCancelInput={cancelQueuedInput} onRestoreInput={restoreNeedsReviewInput} onResumeInputs={resumeInputQueue}
        onQuoteArtifact={quoteArtifact} memoryFeaturesEnabled={bootstrapData.features.personal_memories === true} messages={detail?.messages ?? []} browserGrant={browserGrant} browserPaused={browserPaused}
        onBrowserTakeOver={() => void takeOverBrowser()} onBrowserHandBack={() => void handBackBrowser()} onStopRun={() => void stop()}
        onEmptyGoal={() => { setWorkbenchPanelTab('task'); openGoalPanel() }} onEmptyContext={() => setContextPickerOpen(true)}
        onOpenEvidence={(ref) => {
          if (ref.kind === 'artifact_version') { setArtifactsOpen(true); return }
          if (ref.kind === 'action') {
            const card = document.getElementById(`agent-action-${ref.id}`)
            card?.scrollIntoView({ behavior: 'smooth', block: 'center' })
            card?.focus({ preventScroll: true })
            card?.setAttribute('data-highlight', '1.5s')
            window.setTimeout(() => card?.removeAttribute('data-highlight'), 1_500)
            return
          }
          document.querySelector(`[data-message-id="${ref.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        }}
      />}

      {!workbenchUI && <Dialog open={goalPanelOpen} onClose={() => setGoalPanelOpen(false)} title="任务目标与上下文整理" desc="目标推进仍受账号权限、运行预算和逐张操作卡片确认约束。" width="max-w-2xl">
        <GoalPanel conversationID={conversation?.id} conversation={conversation} goal={detail?.goal} models={bootstrapData.models} goalsEnabled={goalsEnabled} compactEnabled={eventResumeEnabled} canManage={canManageGoals} busy={busy} onCompact={compactRun}
          onOpenEvidence={(ref) => {
            if (ref.kind === 'artifact_version') { setArtifactsOpen(true); return }
            if (ref.kind === 'action') {
              const card = document.getElementById(`agent-action-${ref.id}`)
              card?.scrollIntoView({ behavior: 'smooth', block: 'center' })
              card?.focus({ preventScroll: true })
              card?.setAttribute('data-highlight', '1.5s')
              window.setTimeout(() => card?.removeAttribute('data-highlight'), 1_500)
              return
            }
            // read_result：证据 ID 即 tool 消息 ID；goal 面板可能在 Dialog 内，关掉后定位。
            document.querySelector(`[data-message-id="${ref.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
          }} />
      </Dialog>}

      {capabilitiesOpen && <Dialog open onClose={() => setCapabilitiesOpen(false)} title="智能体能力" desc="按业务域列出这个智能体能做什么、需要什么权限、当前是否可用。" width="max-w-3xl">
        <CapabilityList />
      </Dialog>}
      {routinesEnabled && <Dialog open={routinePanelOpen} onClose={() => setRoutinePanelOpen(false)} title="受限例行任务" desc="按计划只读查询运营数据，逐次生成私有报告；权限在执行时重新检查。" width="max-w-3xl">
        <RoutinePanel open={routinePanelOpen} canManage={canManageRoutines} models={bootstrapData.models} conversation={conversation} />
      </Dialog>}

      {bootstrapData.features.artifacts === true && !desktopPresentation && <Drawer open={artifactsOpen} onClose={() => setArtifactsOpen(false)} title="本对话产物" width="w-[min(92vw,920px)]">
        <ArtifactPanel conversationID={conversation?.id} onQuote={quoteArtifact} />
      </Drawer>}

      <Drawer open={mobileListOpen} onClose={() => setMobileListOpen(false)} title="对话" width="w-[min(88vw,360px)]">
        <AgentConversationList currentID={conversationId} search={search} setSearch={setSearch} onSelect={openConversation} onNew={newConversation} onClose={() => setMobileListOpen(false)} organizeEnabled={organizeEnabled} goalsEnabled={goalsEnabled} />
      </Drawer>
      <AgentLocalSearchDialog open={localSearchOpen} onClose={() => setLocalSearchOpen(false)}
        inputRef={localSearchInputRef} text={localSearchText} setText={setLocalSearchText} busy={localSearchBusy}
        error={localSearchError} results={localSearchResults} onSearch={() => void searchSavedMessages()} onJump={jumpToSearchResult} />
      <AgentSettingsDialog open={!desktopPresentation && settingsOpen} onClose={() => setSettingsOpen(false)}
        selectedModel={selectedModel} canWrite={canWrite} allowModelPick={bootstrapData.allow_model_pick} busy={busy} bootstrapData={bootstrapData}
        selectedAccount={selectedAccount} accountsLoading={accounts.isLoading} accountList={accountList} selectedRoleID={selectedRoleID} setSelectedRoleID={setSelectedRoleID} roles={rolesQuery.data?.roles ?? []} rolesLoading={rolesQuery.isLoading}
        desktopPresentation={desktopPresentation} workbenchUI={workbenchUI} conversationKind={conversation?.kind} selectedMode={selectedMode} changeMode={changeMode}
        runtimeSummary={runtimeSummary} runCostSummary={runCostSummary} accountSwitched={accountSwitched} selectedAccountName={selectedAccountName} historyAccountName={historyAccountName}
        newConversation={newConversation} updateSelection={updateSelection} />
      <ContextPickerDialog open={contextPickerOpen} onClose={() => setContextPickerOpen(false)} accountID={selectedAccount} conversationID={conversationId}
        selected={contextRefs} onAdd={(item) => setContextRefs((old) => old.some((ref) => ref.id === item.id && ref.type === item.type) ? old : [...old, item])} />
      {bootstrapData.features.operations_directory === true && <OperationDirectoryDrawer open={operationDirectoryOpen} onClose={() => setOperationDirectoryOpen(false)} accountID={selectedAccount}
        selected={contextRefs} onAdd={(item) => setContextRefs((old) => old.some((ref) => ref.id === item.id && ref.type === item.type) ? old : [...old, item])} />}
      <WorkflowTemplateDialog open={workflowPickerOpen} onClose={() => setWorkflowPickerOpen(false)}
        templates={(workflowsQuery.data?.templates ?? []).filter((template) => template.status === 'active')} accountID={selectedAccount}
        accounts={accountList.map((account) => ({ id: account.id, name: account.name }))} onStarted={workflowStarted} />
      <SkillPickerDialog open={skillPickerOpen} onClose={() => setSkillPickerOpen(false)} accountID={selectedAccount} selected={skillRequests} workOptions={selectedWorkOptions}
        onAdd={(item) => setSkillRequests((old) => old.some((skill) => skill.skill_id === item.skill_id && skill.work_id === item.work_id) || old.length >= 3 ? old : [...old, item])} />
      <AgentCompactDialog open={compactDialogOpen} onClose={() => setCompactDialogOpen(false)} busy={busy} onCompact={compactRun} />
      <Dialog open={privacyOpen} onClose={() => { setPrivacyOpen(false); savePrefs.mutate({ agent_privacy_notice_seen: true }) }} title="智能体隐私说明" desc="对话仅你本人可见。工作区所有者和系统管理员也无法查看你的对话；卡片执行会照常写入操作日志，并标记为来自智能体。" footer={<Button variant="primary" onClick={() => { setPrivacyOpen(false); savePrefs.mutate({ agent_privacy_notice_seen: true }) }}>我知道了</Button>}>
        <p className="text-[13px] leading-relaxed text-mist-600">不要在对话或附件中发送 API 密钥、平台密钥、密码或邀请码。智能体读取的信息会按系统规则传给当前选择的模型供应商。</p>
      </Dialog>
      {todayOpsEnabled && todayOpsOpen && <TodayOpsPanel accountID={selectedAccount} onClose={() => setTodayOpsOpen(false)} />}
      </div>
    </>
  )
}

