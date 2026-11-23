import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AtSign, Bot, CalendarClock, Check, ChevronDown, FileText, Library, LoaderCircle, Menu, RotateCcw,
  Paperclip, Send, Settings2, Sparkles, Square, Users, X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom' // AG-01: Added useNavigate for navigation to settings pages
import { toast } from 'sonner'
import { confirm, Dialog, Drawer } from '@/components/dialog'
import { Button, IconButton, Input, Notice, Select, Textarea } from '@/components/ui'
import { AddMenu } from './agent/AddMenu'
import { CapabilityList } from './agent/CapabilityList'
import { BrowserTabAuthorizeDialog, type BrowserGrantView } from './agent/BrowserTabAuthorizeDialog'
import { ComputerWindowPicker } from './agent/ComputerWindowPicker'
import { VoiceBar } from './agent/VoiceBar'
import { RealtimeVoiceBar } from './agent/RealtimeVoiceBar'
import { DelegationPanel } from './agent/DelegationPanel'
import { MemoryCandidateCard } from './agent/MemoryCandidateCard'
import { MemoryUsagePanel } from './agent/MemoryUsagePanel'
import { PanelResizer, PANEL_WIDTH_DEFAULT } from './agent/PanelResizer'
import { del, errorMessage, get, patch, post, uploadFormData } from '@/lib/api'
import { isEnterWithoutComposition } from '@/lib/keyboard'
import { fmtCostMicros } from '@/lib/format'
import { useAccounts, useCurrentAccount, useMe } from '@/lib/session'
import { useSavePrefs } from '@/lib/v3'
import { pagePollIntervalMs } from '@/lib/page-poll'
import { usePageVisible } from '@/lib/visibility'
import {
  type AgentAttachment, type AgentBootstrap, type AgentConversation, type AgentConversationDetail, type AgentInput,
  type AgentMessage, type AgentMode, type AgentQuestion, type AgentRole, type WorkflowTemplate,
  useAgentBootstrap,
} from '@/lib/agent'
import { AgentMarkdown } from '@/lib/agent-markdown'
import { trackAgentEvent } from '@/lib/agent-telemetry-client'
import { AgentActionCards } from '@/pages/agent/ActionCards'
import { ComputerControlBar } from '@/pages/agent/ComputerControlBar'
import { ArtifactPanel } from '@/pages/agent/ArtifactPanel'
import { browserStore, clearPartial, type PartialStream, readPartial, savePartial } from '@/pages/agent/partial-stream'
import { ContextPickerDialog, SkillPickerDialog, type AgentContextSelection, type AgentSkillSelection } from '@/pages/agent/ContextPickers'
import { OperationDirectoryDrawer } from '@/pages/agent/OperationDirectoryDrawer'
import { TodayOpsPanel, type TodayOpsView } from '@/pages/agent/TodayOpsPanel'
import { todayOpsWelcomeSummary } from '@/lib/today-ops.js'
import { AgentPlanCard, AgentQuestionCard } from '@/pages/agent/PlansQuestions'
import { GoalPanel } from '@/pages/agent/GoalPanel'
import { WorkflowTemplateDialog } from '@/pages/agent/workflow-dialog'
import { RoutinePanel } from '@/pages/agent/RoutinePanel'
import { AttachmentReceipt } from '@/pages/agent/AttachmentReceipt'
import { AgentConversationList } from '@/pages/agent/ConversationList'
import { ConversationHeader } from '@/pages/agent/ConversationHeader'
import { ComposerCandidates } from '@/pages/agent/ComposerCandidates'
import { AgentRunTimeline } from '@/pages/agent/AgentRunTimeline'
import { StateBlock } from '@/pages/agent/StateBlock'
import { addToLimitedList, COMMANDS, contextRefsPayload, deriveHeaderState, detectComposerTrigger, mapAgentError, modeActionLabel, modelRowMeta, onboardingHint, removeComposerTrigger, shouldAutoOpenPanel, skillRequestsPayload, skillStateLabel } from '@/lib/agent-ui.js'
import type { AgentCommand, ComposerTrigger } from '@/lib/agent-ui.js'
import {
  AgentModeSelect, MessageView, RunOutcomeNotice, RunStatus,
  attachmentVariantURL, groupAssistantRunSegments, groupDesktopAgentMessages, messageTime, modelKey,
  pendingAgentMessageIsPersisted, splitDate,
  type PendingAgentMessage,
} from '@/pages/agent/MessageChrome'
import { useAgentRun } from '@/pages/agent/useAgentRun'
import { WorkbenchSidePanel, type WorkbenchTab } from '@/pages/agent/Workbench'

type DraftAttachment = {
  clientID: string
  file: File
  status: 'waiting' | 'uploading' | 'processing' | 'ready' | 'failed'
  progress?: number
  retryable?: boolean
  attachment?: AgentAttachment
  error?: string
}

// BR-11：页面元素 + 一句批注的本地文本引用；与 IX-04 共用输入台筹码样式，
// 发送时拼进消息正文，不新增服务端引用类型，也不自动发送。
type AgentPageReference = {
  id: string
  name: string
  url: string
  selector: string
  text: string
  note: string
}

function pageReferenceText(refs: AgentPageReference[]): string {
  return refs.map((ref) => [
    `【页面引用】${ref.name}`,
    ref.url,
    `选择器：${ref.selector}`,
    ref.text ? `选段：${ref.text}` : '',
    `批注：${ref.note}`,
  ].filter(Boolean).join('\n')).join('\n\n')
}

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
  const [search, setSearch] = useState('')
  const [mobileListOpen, setMobileListOpen] = useState(false)
  const [workbenchListCollapsed, setWorkbenchListCollapsed] = useState(false)
  const [workbenchPanelOpen, setWorkbenchPanelOpen] = useState(false)
  const [workbenchPanelTab, setWorkbenchPanelTab] = useState<WorkbenchTab>('task')
  const [workbenchPanelWidth, setWorkbenchPanelWidth] = useState(PANEL_WIDTH_DEFAULT)
  const [goalPanelOpen, setGoalPanelOpen] = useState(false)
  const [routinePanelOpen, setRoutinePanelOpen] = useState(false)
  const [todayOpsOpen, setTodayOpsOpen] = useState(false)
  const [capabilitiesOpen, setCapabilitiesOpen] = useState(false)
  const [artifactsOpen, setArtifactsOpen] = useState(false)
  const [workbenchLayoutLoadedKey, setWorkbenchLayoutLoadedKey] = useState('')
  const [subagentsArmed, setSubagentsArmed] = useState(false)
  const [text, setText] = useState('')
  const textDraftVersionRef = useRef(0)
  const [pendingUserMessages, setPendingUserMessages] = useState<PendingAgentMessage[]>([])
  const [files, setFiles] = useState<DraftAttachment[]>([])
  const [restoredAttachments, setRestoredAttachments] = useState<AgentAttachment[]>([])
  const [contextRefs, setContextRefs] = useState<AgentContextSelection[]>([])
  const [pageRefs, setPageRefs] = useState<AgentPageReference[]>([])
  const pageRefsRef = useRef<AgentPageReference[]>([])
  const [skillRequests, setSkillRequests] = useState<AgentSkillSelection[]>([])
  const [contextPickerOpen, setContextPickerOpen] = useState(false)
  const [operationDirectoryOpen, setOperationDirectoryOpen] = useState(false)
  const [skillPickerOpen, setSkillPickerOpen] = useState(false)
  // BR-08：最近一次授权租约与接管状态；没有租约时接管按钮禁用，不伪造控制权。
  const [browserGrant, setBrowserGrant] = useState<BrowserGrantView | null>(null)
  const [browserPaused, setBrowserPaused] = useState(false)
  const [composerTrigger, setComposerTrigger] = useState<ComposerTrigger | null>(null)
  const [compactDialogOpen, setCompactDialogOpen] = useState(false)
  const [reviewActionID, setReviewActionID] = useState<string | null>(null)
  const composingRef = useRef(false)
  const [uploading, setUploading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [inputSubmitting, setInputSubmitting] = useState(false)
  const [selectedMode, setSelectedMode] = useState<AgentMode>('execute')
  const [selectedModel, setSelectedModel] = useState('')
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
  const [historyAccount, setHistoryAccount] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const modelMenuRef = useRef<HTMLDivElement>(null)
  const [runInputMenuOpen, setRunInputMenuOpen] = useState(false)
  const runInputMenuRef = useRef<HTMLDivElement>(null)
  const previousDesktopAccount = useRef<string | undefined>(undefined)
  const [privacyOpen, setPrivacyOpen] = useState(false)
  const [localSearchOpen, setLocalSearchOpen] = useState(false)
  const [localSearchText, setLocalSearchText] = useState('')
  const [localSearchBusy, setLocalSearchBusy] = useState(false)
  const [localSearchResults, setLocalSearchResults] = useState<AgentMessage[]>([])
  const [localSearchError, setLocalSearchError] = useState('')
  const [editMessage, setEditMessage] = useState<AgentMessage | null>(null)
  const [olderMessages, setOlderMessages] = useState<AgentMessage[]>([])
  const [pendingJump, setPendingJump] = useState<{ conversationID: string; seq: number } | null>(null)
  const [manualUnreadSuppressedID, setManualUnreadSuppressedID] = useState('')

  const olderLoadingRef = useRef(false)
  const manualScrollRef = useRef(false)
  const initialConversationRef = useRef(conversationId)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const composerRootRef = useRef<HTMLDivElement>(null)
  const localSearchInputRef = useRef<HTMLInputElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const uploadingRef = useRef(false)
  const uploadGeneration = useRef(0)
  const cancelledUploads = useRef(new Set<string>())
  const uploadControllers = useRef(new Map<string, AbortController>())
  useEffect(() => () => {
    uploadGeneration.current++
    for (const controller of uploadControllers.current.values()) controller.abort()
    uploadControllers.current.clear()
  }, [])

  const messageRequest = useRef<{ key: string; id: string } | null>(null)
  const inputRequest = useRef<{ key: string; id: string } | null>(null)
  const resumeInputRequest = useRef<string | null>(null)
  const conversationRequest = useRef<{ key: string; id: string } | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const dragDepth = useRef(0)
  const [dragging, setDragging] = useState(false)
  const [actionExecuting, setActionExecuting] = useState(false)
  // AG-04：断流/切页后恢复已生成的部分内容（草稿只放 sessionStorage）。
  const [recovered, setRecovered] = useState<PartialStream | null>(null)
  const partialStore = useRef<Storage | null>(null)
  const partialSavedAt = useRef(0)
  const conversationIDRef = useRef(conversationId)
  conversationIDRef.current = conversationId
  const lastConversationIDRef = useRef(conversationId)
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
  useEffect(() => {
    const onManualUnread = (event: Event) => {
      const id = (event as CustomEvent<{ id: string }>).detail?.id
      if (id && id === conversationIDRef.current) setManualUnreadSuppressedID(id)
    }
    window.addEventListener('ops:agent-manual-unread', onManualUnread)
    return () => window.removeEventListener('ops:agent-manual-unread', onManualUnread)
  }, [])
  useEffect(() => {
    if (lastConversationIDRef.current !== conversationId) {
      lastConversationIDRef.current = conversationId
      setManualUnreadSuppressedID('')
    }
  }, [conversationId])
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
    const bridge = (window as unknown as {
      opsDesktopUI?: {
        onSidepanelDraft?: (cb: (draft: { text: string }) => void) => () => void
        onSidepanelStop?: (cb: () => void) => () => void
      }
    }).opsDesktopUI
    if (!bridge?.onSidepanelDraft) return
    const offDraft = bridge.onSidepanelDraft((draft) => {
      if (draft.text) setText((old) => (old ? `${old}
${draft.text}` : draft.text))
      toast.info('侧栏草稿已填入输入框；确认后发送。')
      window.setTimeout(() => inputRef.current?.focus(), 0)
    })
    const offStop = bridge.onSidepanelStop?.(() => {
      void stop()
    }) ?? (() => {})
    return () => { offDraft(); offStop() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desktopPresentation])
  useEffect(() => {
    if (!composerTrigger) return
    const onDown = (event: MouseEvent) => {
      if (!composerRootRef.current?.contains(event.target as Node)) setComposerTrigger(null)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [composerTrigger])
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
  const persistedMessages = useMemo(() => [...olderMessages, ...baseMessages], [olderMessages, baseMessages])
  const messages = useMemo(() => {
    const pending = desktopPresentation
      ? pendingUserMessages.filter((item) => item.conversationID === conversationId && !pendingAgentMessageIsPersisted(item, persistedMessages))
      : []
    return [...persistedMessages, ...pending.map((item) => ({
      ...item.message,
      id: item.messageID ?? item.message.id,
      run_id: item.runID ?? item.message.run_id,
    }))]
  }, [conversationId, desktopPresentation, pendingUserMessages, persistedMessages])
  useEffect(() => {
    if (!desktopPresentation) return
    setPendingUserMessages((current) => {
      const next = current.filter((item) => item.conversationID !== conversationId || !pendingAgentMessageIsPersisted(item, persistedMessages))
      return next.length === current.length ? current : next
    })
  }, [conversationId, desktopPresentation, persistedMessages])
  const displayEntries = useMemo(() => groupDesktopAgentMessages(messages, desktopPresentation), [messages, desktopPresentation])
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
  // DEV-AI27-13b：消息流候选记忆（run 结束后展示，确认后才注入后续对话）
  const [memoryCandidates, setMemoryCandidates] = useState<Array<{ id: string; text: string; state: string; revision: number }>>([])
  useEffect(() => {
    if (busy || !conversationId || !bootstrapData?.features?.personal_memories) {
      setMemoryCandidates([])
      return
    }
    const controller = new AbortController()
    void fetch(`/api/v1/agent/personal-memories?state=candidate&source_conversation_id=${conversationId}`, {
      credentials: 'same-origin', signal: controller.signal,
    }).then((res) => res.ok ? res.json() : null).then((data) => {
      if (data?.memories) setMemoryCandidates(data.memories)
    }).catch(() => {})
    return () => controller.abort()
  }, [busy, conversationId, bootstrapData?.features?.personal_memories])
  const memoryCandidateHandlers = {
    busy,
    onConfirm: (id: string, revision: number) => {
      void fetch(`/api/v1/agent/personal-memories/${id}`, {
        method: 'PATCH', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'confirm', expected_revision: revision }),
      }).then(() => setMemoryCandidates((old) => old.filter((c) => c.id !== id)))
    },
    onEdit: (id: string, text: string, revision: number) => {
      void fetch(`/api/v1/agent/personal-memories/${id}`, {
        method: 'PATCH', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'edit', text, expected_revision: revision }),
      }).then(() => setMemoryCandidates((old) => old.filter((c) => c.id !== id)))
    },
    onIgnore: (id: string, revision: number) => {
      void fetch(`/api/v1/agent/personal-memories/${id}`, {
        method: 'PATCH', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'ignore', expected_revision: revision }),
      }).then(() => setMemoryCandidates((old) => old.filter((c) => c.id !== id)))
    },
  }
  // 有待办澄清问题时，服务端已把这次运行挂起（active_run 为 null），但客户端的事件流可能还没收尾，
  // busy 会一直是真。这种状态下必须允许用户发新消息替代问题，否则只能先回答或先停止。
  // 判据用 active_run + 在途提交，而不是等整轮流收尾：流什么时候关闭取决于服务端挂起策略，
  // 要求 submitting 归零会让发送键白等十几秒。
  const supersedeReady = !!pendingQuestion && !activeRun && !sendInFlight.current
  const composerBusy = busy && !supersedeReady
  const readyFiles = files.filter((file) => file.status === 'ready' && file.attachment)
  const readyAttachmentIDs = [...readyFiles.map((file) => file.attachment!.id), ...restoredAttachments.map((file) => file.id)]
  const failedFiles = files.filter((file) => file.status === 'failed')
  const runInputsEnabled = workbenchUI && bootstrapData?.features?.run_control === true && !accountMismatch

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
        setLocalSearchText('')
        setLocalSearchResults([])
        setLocalSearchError('')
        setLocalSearchOpen(true)
        window.setTimeout(() => localSearchInputRef.current?.focus(), 0)
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
    if (!runInputMenuOpen) return
    const closeOutside = (event: MouseEvent) => { if (!runInputMenuRef.current?.contains(event.target as Node)) setRunInputMenuOpen(false) }
    const closeEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setRunInputMenuOpen(false) }
    document.addEventListener('mousedown', closeOutside)
    document.addEventListener('keydown', closeEscape)
    return () => { document.removeEventListener('mousedown', closeOutside); document.removeEventListener('keydown', closeEscape) }
  }, [runInputMenuOpen])

  useEffect(() => {
    if (!modelMenuOpen) return
    const closeOutside = (event: MouseEvent) => { if (!modelMenuRef.current?.contains(event.target as Node)) setModelMenuOpen(false) }
    const closeEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setModelMenuOpen(false) }
    document.addEventListener('mousedown', closeOutside)
    document.addEventListener('keydown', closeEscape)
    return () => { document.removeEventListener('mousedown', closeOutside); document.removeEventListener('keydown', closeEscape) }
  }, [modelMenuOpen])

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
    setOlderMessages([])
    setLocalSearchResults([])
    setLocalSearchError('')
  }, [conversationId])

  useEffect(() => {
    if (lastDraftConversationID.current === conversationId) return
    lastDraftConversationID.current = conversationId
    if (sendDestinationConversationID.current === conversationId) return
    sendDestinationConversationID.current = ''
    uploadGeneration.current++
    setText('')
    for (const item of files) {
      uploadControllers.current.get(item.clientID)?.abort()
      if (item.attachment) void del(`/agent/attachments/${item.attachment.id}`).catch(() => undefined)
      else cancelledUploads.current.add(item.clientID)
    }
    setFiles([])
    setRestoredAttachments([])
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

  useEffect(() => {
    if (!streaming) return
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [streamText, streaming])

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

  const loadOlder = async () => {
    if (!conversationId || !messages.length || !detail?.has_more || olderLoadingRef.current) return
    olderLoadingRef.current = true
    try {
      const page = await get<AgentConversationDetail>(`/agent/conversations/${conversationId}?before_seq=${messages[0].seq}`)
      setOlderMessages((old) => [...page.messages, ...old])
      qc.setQueryData<AgentConversationDetail>(['agent-conversation', conversationId], (current) => current ? { ...current, has_more: page.has_more } : current)
    } catch (error) { toast.error(errorMessage(error)) }
    finally { olderLoadingRef.current = false }
  }

  useEffect(() => {
    if (!pendingJump || pendingJump.conversationID !== conversationId || detailQuery.isLoading || !detail) return
    const target = messages.find((message) => message.seq === pendingJump.seq)
    if (target) {
      setPendingJump(null)
      window.requestAnimationFrame(() => document.querySelector(`[data-message-seq="${target.seq}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }))
    } else if (detail.has_more && messages.length) {
      void loadOlder()
    } else if (!detail.has_more) {
      setPendingJump(null)
      toast.error('搜索命中的消息已不可用')
    }
  }, [pendingJump, conversationId, detailQuery.isLoading, detail, messages, loadOlder])

  useEffect(() => {
    if (!organizeEnabled || !conversationId || !conversation || !messages.length || !pageVisible || manualUnreadSuppressedID === conversationId) return
    const eventMode = bootstrapData?.features?.event_resume === true
    const readSeq = eventMode ? detail?.read_upto_event_seq ?? 0 : conversation.read_upto_message_seq ?? 0
    const latestSeq = eventMode ? detail?.last_event_seq ?? 0 : messages[messages.length - 1].seq
    const hasUnread = eventMode
      ? detail?.has_unread === true
      : conversation.force_unread || messages.some((message) => message.seq > readSeq && message.role !== 'user')
    if (!hasUnread || latestSeq <= readSeq && !conversation.force_unread || !bottomRef.current) return
    const node = bottomRef.current
    let timer = 0
    const observer = new IntersectionObserver((entries) => {
      window.clearTimeout(timer)
      if (entries.some((entry) => entry.isIntersecting) && document.visibilityState === 'visible') {
        timer = window.setTimeout(() => {
          if (conversationIDRef.current !== conversationId || document.visibilityState !== 'visible') return
          void post<{ read_upto_message_seq: number; read_upto_event_seq?: number; force_unread: boolean; revision: number }>(
            `/agent/conversations/${conversationId}/read`, eventMode ? { upto_event_seq: latestSeq } : { upto_message_seq: latestSeq })
            .then((result) => {
              qc.setQueryData<AgentConversationDetail>(['agent-conversation', conversationId], (current) => current ? {
                ...current,
                conversation: { ...current.conversation, read_upto_message_seq: result.read_upto_message_seq, force_unread: result.force_unread, revision: result.revision },
                ...(eventMode ? { read_upto_event_seq: result.read_upto_event_seq, has_unread: false } : {}),
              } : current)
              return qc.invalidateQueries({ queryKey: ['agent-conversations'] })
            })
            .catch((error) => toast.error(errorMessage(error)))
        }, 1000)
      }
    }, { threshold: 1 })
    observer.observe(node)
    return () => { window.clearTimeout(timer); observer.disconnect() }
  }, [organizeEnabled, conversationId, conversation, messages, pageVisible, qc, manualUnreadSuppressedID,
    bootstrapData?.features?.event_resume, detail?.read_upto_event_seq, detail?.last_event_seq, detail?.has_unread])

  const searchSavedMessages = async () => {
    const query = localSearchText.trim().toLocaleLowerCase()
    if (!conversationId || !query || localSearchBusy) return
    const searchConversationID = conversationId
    setLocalSearchBusy(true)
    setLocalSearchError('')
    try {
      let allMessages = [...messages]
      let cursor = allMessages[0]?.seq ?? 0
      let hasMore = detail?.has_more === true
      while (hasMore && cursor > 0) {
        const page = await get<AgentConversationDetail>(`/agent/conversations/${searchConversationID}?before_seq=${cursor}`)
        if (!page.messages.length || page.messages[0].seq >= cursor) break
        allMessages = [...page.messages, ...allMessages]
        cursor = page.messages[0].seq
        hasMore = page.has_more
      }
      if (conversationIDRef.current !== searchConversationID) return
      setOlderMessages(allMessages.slice(0, Math.max(0, allMessages.length - baseMessages.length)))
      setLocalSearchResults(allMessages.filter((message) => ['user', 'assistant'].includes(message.role) && message.content.toLocaleLowerCase().includes(query)))
    } catch (error) {
      if (conversationIDRef.current === searchConversationID) setLocalSearchError(errorMessage(error))
    } finally {
      if (conversationIDRef.current === searchConversationID) setLocalSearchBusy(false)
    }
  }

  const jumpToSearchResult = (message: AgentMessage) => {
    setLocalSearchOpen(false)
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      document.querySelector(`[data-message-seq="${message.seq}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }))
  }

  const addFiles = async (incoming: FileList | File[]) => {
    if (!canWrite || busy && !runInputsEnabled || uploadingRef.current) return
    const filesToAdd = Array.from(incoming)
    if (!filesToAdd.length) return
    const maxFiles = bootstrapData?.limits.attachments_per_message ?? 6
    const available = Math.max(0, maxFiles - files.length - restoredAttachments.length)
    if (filesToAdd.length > available) toast.error(`一条消息最多添加 ${maxFiles} 个附件`)
    const filesToAccept = filesToAdd.slice(0, available)
    const queue = filesToAccept.map((file): DraftAttachment => {
      const image = /^image\/(jpeg|png|webp|gif)$/i.test(file.type)
      const textFile = /\.(txt|md)$/i.test(file.name)
      const documentFile = !!bootstrapData?.features.document_parse && /\.(pdf|docx|csv)$/i.test(file.name)
      const max = image || documentFile ? (bootstrapData?.limits.document_bytes ?? 20 * 1024 * 1024) : (bootstrapData?.limits.text_bytes ?? 1024 * 1024)
      const error = !image && !textFile && !documentFile ? '文件类型暂不支持，请选择允许的图片、文本或文档' : file.size > max ? '文件超过大小限制' : undefined
      return { clientID: crypto.randomUUID(), file, status: error ? 'failed' : 'waiting', error, retryable: !error }
    })
    setFiles((old) => [...old, ...queue])
    for (const item of queue) if (item.status === 'waiting') await uploadFile(item)
  }

  const uploadFile = async (item: DraftAttachment) => {
    if (uploadingRef.current) return
    if (cancelledUploads.current.delete(item.clientID)) return
    const generation = uploadGeneration.current
    uploadingRef.current = true
    setUploading(true)
    const controller = new AbortController()
    uploadControllers.current.set(item.clientID, controller)
    setFiles((old) => old.map((file) => file.clientID === item.clientID ? { ...file, status: 'uploading', error: undefined } : file))
    try {
      const form = new FormData()
      form.append('file', item.file)
      form.append('request_id', item.clientID)
      if (conversationId) form.append('conversation_id', conversationId)
      const response = await uploadFormData('/agent/attachments', form, (loaded, total, complete) => {
        setFiles((old) => old.map((file) => file.clientID === item.clientID ? { ...file, status: complete ? 'processing' : 'uploading', progress: total ? Math.round(loaded / total * 100) : undefined } : file))
      }, controller.signal)
      const attachment = await response.json() as AgentAttachment
      if (generation !== uploadGeneration.current || cancelledUploads.current.delete(item.clientID)) {
        await del(`/agent/attachments/${attachment.id}`).catch(() => undefined)
        return
      }
      const quarantined = attachment.parse_status === 'quarantined'
      setFiles((old) => old.map((file) => file.clientID === item.clientID ? { ...file, status: quarantined ? 'failed' : 'ready', attachment, retryable: !quarantined, error: quarantined ? '疑似含敏感凭据，已隔离，请移除并重新上传已清理文件' : undefined } : file))
    } catch (error) {
      if (generation === uploadGeneration.current && !cancelledUploads.current.delete(item.clientID)) {
        setFiles((old) => old.map((file) => file.clientID === item.clientID ? { ...file, status: 'failed', error: errorMessage(error), retryable: true } : file))
      }
    } finally {
      uploadingRef.current = false
      uploadControllers.current.delete(item.clientID)
      setUploading(false)
    }
  }

  const retryFile = (item: DraftAttachment) => { void uploadFile(item) }

  const clearDraftAttachments = () => {
    for (const item of files) {
      if (item.status !== 'ready' && item.status !== 'failed') cancelledUploads.current.add(item.clientID)
      uploadControllers.current.get(item.clientID)?.abort()
      if (item.attachment) void del(`/agent/attachments/${item.attachment.id}`).catch(() => undefined)
    }
    setFiles([])
    setRestoredAttachments([])
  }

  const removeFile = async (item: DraftAttachment) => {
    if (item.status !== 'ready' && item.status !== 'failed') cancelledUploads.current.add(item.clientID)
    uploadControllers.current.get(item.clientID)?.abort()
    setFiles((old) => old.filter((file) => file.clientID !== item.clientID))
    if (item.attachment) await del(`/agent/attachments/${item.attachment.id}`).catch(() => undefined)
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
  const renderMessageBlock = (message: AgentMessage, sourceMessages: AgentMessage[], inlineAssistant = false, showFeedback = true) => (
    <>
      <MessageView message={message} lastAssistant={message.id === lastAssistant?.id} canSeeImages={selectedModelOption?.vision === true} desktopPresentation={desktopPresentation} inlineAssistant={inlineAssistant}
        showFeedback={showFeedback} showToolActivity={!workbenchUI}
        forkMessages={sourceMessages.length > 1 ? sourceMessages : undefined}
        skillRequests={messages.find((candidate) => candidate.role === 'user' && candidate.run_id === message.run_id)?.skill_requests ?? []}
        onFork={organizeEnabled && message.role !== 'system' ? () => void forkFromMessage(message) : undefined}
        onForkMessage={organizeEnabled ? (source) => void forkFromMessage(source) : undefined}
        onEdit={message.id === lastUser?.id && !busy && !pendingQuestion && canWrite && pageRefs.length === 0 && !message.attachments.length && !message.context_refs?.length && !message.skill_requests?.length ? () => { setEditMessage(message); setText(message.content); clearDraftAttachments(); setContextRefs([]); setPageRefs([]); setSkillRequests([]); inputRef.current?.focus() } : undefined}
        onRegenerate={message.id === lastAssistant?.id && !busy && canWrite ? regenerate : undefined}
        onQuoteSelection={canWrite ? (ref) => {
          addContextSelection({ id: ref.id, type: 'message', name: '引用', summary: '选段引用', scope: 'turn', account_id: selectedAccount || null, revision: '', updated_at: '', reference_scope: 'turn', anchor: ref.anchor })
        } : undefined} />
      {message.role === 'assistant' && message.run_id && sourceMessages.some((source) => actionMessageByRun[message.run_id!] === source.id) && <div className={desktopPresentation ? 'desktop-agent-action-wrapper' : ''}><AgentActionCards
        actions={actions.filter((action) => action.run_id === message.run_id)}
        running={busy || actionExecuting}
        onRefresh={invalidate}
        onContinue={continueRun}
        onExecutingChange={setActionExecuting}
        desktopPresentation={desktopPresentation}
        reviewActionID={reviewActionID}
        onOpenReview={(id) => { trackAgentEvent('agent_review_open', 'action'); setReviewActionID(id) }}
        onCloseReview={() => setReviewActionID(null)}
      /></div>}
      {message.role === 'assistant' && message.run_id && plans.filter((plan) => plan.source_run_id === message.run_id).map((plan) => <AgentPlanCard key={plan.id} plan={plan} canWrite={canWrite} busy={busy} blocked={!!pendingQuestion} onAccept={(item) => void acceptPlan(item)} />)}
      {message.role === 'assistant' && message.run_id && questions.filter((question) => question.run_id === message.run_id).map((question) => <AgentQuestionCard key={question.id} question={question} canWrite={canWrite} busy={busy} onAnswer={(item, answers) => void answerQuestion(item, answers)} />)}
    </>
  )
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
  const handleRunErrorAction = (action: string) => {
    if (action === 'retry') { regenerate(); return }
    if (action === 'change-model') { setModelMenuOpen(true); return }
    if (action === 'open-models') { navigate('/settings/models'); return }
    if (action === 'reselect-context') { setContextPickerOpen(true); return }
    if (action === 'open-permissions') { navigate('/settings/members'); return }
    if (action === 'verify') { void detailQuery.refetch() }
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
      {toolbarSlot && !desktopPresentation && createPortal(
        <>
          {bootstrapData.features.artifacts === true && conversation && <IconButton label="查看产物" onClick={() => setArtifactsOpen(true)}><FileText className="size-4" /></IconButton>}
          {goalsEnabled && conversation && <IconButton label="任务目标与上下文整理" onClick={openGoalPanel}><Bot className="size-4" /></IconButton>}
          {routinesEnabled && <IconButton label="例行任务" onClick={() => setRoutinePanelOpen(true)}><CalendarClock className="size-4" /></IconButton>}
          <IconButton label="对话设置" onClick={() => setSettingsOpen(true)}><Settings2 className="size-4" /></IconButton>
        </>,
        toolbarSlot,
      )}
      <div className={`relative flex h-full min-h-0 overflow-hidden bg-[var(--ops-canvas)] ${desktopPresentation ? 'desktop-agent-workspace' : ''} ${workbenchUI ? 'desktop-agent-workbench' : ''}`} data-list-collapsed={workbenchListCollapsed} data-panel-open={workbenchPanelOpen}>
      {desktopPresentation && <aside className="desktop-agent-list" aria-label="AI 对话列表" data-testid="desktop-agent-list">
        <AgentConversationList currentID={conversationId} search={search} setSearch={setSearch} onSelect={openConversation} onNew={newConversation} sidebarTitle="AI 对话" desktopPresentation organizeEnabled={organizeEnabled} goalsEnabled={goalsEnabled} />
      </aside>}
      <section className={`flex min-w-0 flex-1 flex-col ${workbenchUI ? 'desktop-agent-workbench-main' : ''}`}>
        {workbenchUI
          ? <ConversationHeader state={headerState} editable={!!conversation && !bootstrapData.read_only} onRename={(title) => void renameConversation(title)}
            onTogglePanel={() => { setMobileListOpen(false); setWorkbenchPanelOpen((value) => !value) }}
            onOpenModels={() => navigate('/settings/models')}
            onPrivacySeen={() => savePrefs.mutate({ agent_privacy_notice_seen: true })}
            leading={<IconButton label={workbenchListCollapsed ? '打开对话列表' : '收起会话列表'} className="desktop-agent-workbench-list-button md:hidden" onClick={() => {
              if (workbenchListCollapsed) setWorkbenchListCollapsed(false)
              else { setWorkbenchPanelOpen(false); setMobileListOpen(true) }
            }}><Menu className="size-4" /></IconButton>}
            sideChat={conversation?.kind === 'side'}
            onOpenMainConversation={conversation?.kind === 'side' && conversation.parent_id ? () => openConversation(conversation.parent_id!) : undefined} />
          : <header className={`flex min-h-14 shrink-0 items-center gap-2 border-b border-mist-200 bg-white px-3 sm:px-5 ${desktopPresentation ? 'desktop-agent-chat-header' : 'lg:hidden'}`}>
            <IconButton label="打开对话列表" className="md:hidden" onClick={() => { setWorkbenchPanelOpen(false); setMobileListOpen(true) }}><Menu className="size-4" /></IconButton>
            <div className={`flex min-w-0 items-center gap-2 ${desktopPresentation ? 'desktop-agent-chat-heading' : 'flex-1'}`}>
              {desktopPresentation ? <>{renderConversationTitle()}<span className="desktop-agent-private-tag">仅本人可见</span></> : renderTitle()}
            </div>
            {desktopPresentation
              ? null
              : <IconButton label="对话设置" onClick={() => setSettingsOpen(true)}><Settings2 className="size-4" /></IconButton>}
          </header>}
        {workbenchUI && runCostSummary && <div className="border-b border-mist-100 bg-white px-4 py-1 text-center text-xs text-mist-500" data-testid="agent-run-cost">{runCostSummary}</div>}
        {bootstrapData.read_only && <div className="border-b border-gamboge-200 bg-gamboge-50 px-4 py-2 text-center text-[12px] text-gamboge-800">当前为观察者：智能体只能查询，不能修改。</div>}
        {accountMismatch && <div className="border-b border-gamboge-200 bg-gamboge-50 px-4 py-2 text-center text-[12px] text-gamboge-800" data-testid="agent-account-switched">此对话属于「{historyAccountName}」，当前账号为「{selectedAccountName}」。<button type="button" className="ml-2 underline" onClick={newConversation}>为当前账号新建对话</button></div>}

        <div className="relative flex min-h-0 flex-1 flex-col">
          {dragging && <div className="absolute inset-3 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-ink-400 bg-white/90 text-ink-700">松开以上传图片或文本</div>}
          <div className={`scrollbar-thin min-h-0 flex-1 overflow-y-auto px-3 py-5 sm:px-6 ${desktopPresentation ? 'desktop-agent-chat-stream' : ''}`} onWheel={() => { manualScrollRef.current = true }} onTouchStart={() => { manualScrollRef.current = true }} onPointerDown={() => { manualScrollRef.current = true }} onKeyDown={(event) => { if (['End', 'PageDown', 'ArrowDown'].includes(event.key)) manualScrollRef.current = true }} onScroll={(event) => {
            if (!manualScrollRef.current || manualUnreadSuppressedID !== conversationId) return
            const node = event.currentTarget
            if (node.scrollHeight - node.scrollTop - node.clientHeight <= 8) {
              manualScrollRef.current = false
              setManualUnreadSuppressedID('')
            }
          }} onDragEnter={(event) => { event.preventDefault(); if (canWrite && (!busy || runInputsEnabled) && !uploading) { dragDepth.current++; setDragging(true) } }} onDragLeave={(event) => { event.preventDefault(); dragDepth.current--; if (dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false) } }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); dragDepth.current = 0; setDragging(false); void addFiles(event.dataTransfer.files) }}>
            {detailQuery.isLoading && conversationId && <div className="mx-auto max-w-3xl py-6"><StateBlock tone="loading" title="正在加载对话…" desc="消息、卡片与任务状态会一起恢复。" /></div>}
            {detailQuery.isError && (() => {
              const mapped = mapAgentError(detailQuery.error)
              return <div className="mx-auto max-w-3xl"><StateBlock tone="error" title={mapped.title} desc={mapped.reason} requestId={mapped.requestId}
                action={<div className="flex items-center gap-2"><Button size="sm" variant="outline" onClick={() => void detailQuery.refetch()}>重试</Button>
                  {mapped.requestId && <Button size="sm" variant="ghost" onClick={() => { void navigator.clipboard.writeText(mapped.requestId); toast('请求 ID 已复制') }}>复制请求 ID</Button>}</div>} /></div>
            })()}
            {!conversationId && !messages.length && <Welcome onPrompt={(value) => setText(value)} noModel={!bootstrapData.can_use} desktopWorkbench={workbenchUI}
              summary={workbenchUI ? (todayOpsEnabled ? (todayOpsSummaryQuery.data ? todayOpsWelcomeSummary(todayOpsSummaryQuery.data) : todayOpsSummaryQuery.isError ? '今日运营需要权限或暂时不可用 · 查看说明' : '正在汇总今日运营…') : `今天 ${pendingActions + pendingQuestions} 项待处理`) : null}
              onOpenTodayOps={todayOpsEnabled ? () => setTodayOpsOpen(true) : undefined} />}
            {detail?.has_more && <div className="mx-auto mb-4 max-w-3xl text-center"><Button size="sm" variant="ghost" onClick={() => void loadOlder()}>加载更早的消息</Button></div>}
            <div className={`mx-auto flex max-w-3xl flex-col gap-4 ${desktopPresentation ? 'desktop-agent-message-column' : ''}`}>
              {displayEntries.map((entry, index) => {
                const entryMessages = entry.kind === 'message' ? [entry.message] : entry.messages
                const firstMessage = entryMessages[0]
                const previousEntry = displayEntries[index - 1]
                const previous = previousEntry ? (previousEntry.kind === 'message' ? previousEntry.message : previousEntry.messages.at(-1)) : undefined
                const startsDay = desktopPresentation && (!previous || splitDate(previous.created_at) !== splitDate(firstMessage.created_at))
                if (entry.kind === 'message') return <div key={entry.message.id} data-message-seq={entry.message.seq} data-message-id={entry.message.id} className="relative">
                  {startsDay && <div className="desktop-agent-day">{splitDate(firstMessage.created_at)} · {messageTime(firstMessage.created_at)}</div>}
                  {renderMessageBlock(entry.message, [entry.message])}
                </div>

                const segments = groupAssistantRunSegments(entry.messages)
                const feedbackSegment = [...segments].reverse().find(({ message }) => message.content.trim() || message.attachments.length > 0)
                let previousSegmentMessage: AgentMessage | undefined
                const showRunActivity = visibleRunID === entry.runId
                const runningToolName = entry.messages.flatMap((message) => message.tool_calls ?? []).find((call) => call.status === 'running')?.name
                return <article key={`run:${entry.runId}`} data-run-id={entry.runId} className="desktop-agent-message assistant desktop-agent-run-message">
                  {startsDay && <div className="desktop-agent-day">{splitDate(firstMessage.created_at)} · {messageTime(firstMessage.created_at)}</div>}
                  <div className="desktop-agent-message-speaker">
                    <span className="desktop-agent-bot-avatar"><Bot /></span><strong>OPS</strong>
                    <small>{activeRun?.id === entry.runId ? (streamStage.startsWith('tool:') ? '处理中' : '运行中') : messageTime(entry.messages.at(-1)!.created_at)}</small>
                  </div>
                  {workbenchUI && <AgentRunTimeline runId={entry.runId}
                    toolCalls={entry.messages.flatMap((message) => message.tool_calls ?? [])}
                    actions={actions.filter((action) => action.run_id === entry.runId)}
                    plan={plans.find((item) => item.source_run_id === entry.runId) ?? null} />}
                  {segments.map((segment) => {
                    const segmentFirst = segment.sourceMessages[0]
                    const segmentLast = segment.sourceMessages.at(-1)!
                    const segmentStartsDay = !!previousSegmentMessage && splitDate(previousSegmentMessage.created_at) !== splitDate(segmentFirst.created_at)
                    previousSegmentMessage = segmentLast
                    return <div key={segmentFirst.id} data-message-seq={segmentFirst.seq} className="desktop-agent-run-segment relative">
                      {segment.sourceMessages.slice(1).map((source) => <span key={source.id} data-message-seq={source.seq} className="absolute left-0 top-0 h-px w-px" aria-hidden="true" />)}
                      {segmentStartsDay && <div className="desktop-agent-day desktop-agent-run-day">{splitDate(segmentFirst.created_at)} · {messageTime(segmentFirst.created_at)}</div>}
                      {renderMessageBlock(segment.message, segment.sourceMessages, true, segment === feedbackSegment)}
                    </div>
                  })}
                  {showRunActivity && <>
                    {streamText && <div className="desktop-agent-run-live"><AgentMarkdown text={streamText} /><p className="desktop-agent-run-live-note">正在生成，内容尚未完成</p></div>}
                    {!streamText && recoveryText && recoveryRunID === entry.runId && <div className="desktop-agent-run-live">
                      <AgentMarkdown text={recoveryText} />
                      <div className="desktop-agent-run-live-note" data-testid="agent-partial-note">
                        {eventResumeEnabled && !activeRun ? '这是服务端保存的未完成内容。你可以发送新消息继续处理。' : busy || activeRun
                          ? '这是上次离开页面时已生成的部分，服务端仍在继续，完成后会补全这条回复。'
                          : '这是上次中断时已生成的部分。这一轮没有正常结束，可以点下方「继续」让智能体接着做。'}
                      </div>
                    </div>}
                    <RunStatus activeRun={activeRun?.id === entry.runId ? activeRun : undefined} streamStage={streamStage} toolName={runningToolName} connection={streamConnection} pendingActions={pendingActions} error={streamError} errors={streamErrors} completedNotice={completedNotice} onErrorAction={handleRunErrorAction} />
                  </>}
                </article>
              })}
              {plans.filter((plan) => !displayEntries.some((entry) => entry.kind === 'assistant-run' && entry.runId === plan.source_run_id)).map((plan) => <AgentPlanCard key={plan.id} plan={plan} canWrite={canWrite} busy={busy} blocked={!!pendingQuestion} onAccept={(item) => void acceptPlan(item)} />)}
              {desktopPresentation && hasRunActivity && visibleRunID && !displayEntries.some((entry) => entry.kind === 'assistant-run' && entry.runId === visibleRunID) && <article data-run-id={visibleRunID} className="desktop-agent-message assistant desktop-agent-run-message">
                <div className="desktop-agent-message-speaker"><span className="desktop-agent-bot-avatar"><Bot /></span><strong>OPS</strong><small>{activeRun || streaming || runID ? '运行中' : '正在恢复'}</small></div>
                {workbenchUI && <AgentRunTimeline runId={visibleRunID}
                  toolCalls={messages.filter((message) => message.run_id === visibleRunID).flatMap((message) => message.tool_calls ?? [])}
                  actions={actions.filter((action) => action.run_id === visibleRunID)} />}
                {streamText && <div className="desktop-agent-run-live"><AgentMarkdown text={streamText} /><p className="desktop-agent-run-live-note">正在生成，内容尚未完成</p></div>}
                {!streamText && recoveryText && <div className="desktop-agent-run-live">
                  <AgentMarkdown text={recoveryText} />
                  <div className="desktop-agent-run-live-note" data-testid="agent-partial-note">
                    {eventResumeEnabled && !activeRun ? '这是服务端保存的未完成内容。你可以发送新消息继续处理。' : busy || activeRun
                      ? '这是上次离开页面时已生成的部分，服务端仍在继续，完成后会补全这条回复。'
                      : '这是上次中断时已生成的部分。这一轮没有正常结束，可以点下方「继续」让智能体接着做。'}
                  </div>
                </div>}
                <RunStatus activeRun={activeRun} streamStage={streamStage} toolName={messages.filter((message) => message.run_id === visibleRunID).flatMap((message) => message.tool_calls ?? []).find((call) => call.status === 'running')?.name} connection={streamConnection} pendingActions={pendingActions} error={streamError} errors={streamErrors} completedNotice={completedNotice} onErrorAction={handleRunErrorAction} />
              </article>}
              {!desktopPresentation && streamText && <div className="flex justify-start"><div className="max-w-[82%] rounded-2xl bg-white px-4 py-3 shadow-card"><AgentMarkdown text={streamText} /><p className="mt-2 text-[12px] text-mist-500">正在生成，内容尚未完成</p></div></div>}
              {/* AG-04：离开页面时没写完的回复。服务端整轮结束后才落库，这里先把已生成的部分显示出来，
                  并说明「服务端仍在继续」，避免用户以为内容丢了而重新发一遍。 */}
              {!desktopPresentation && !streamText && recoveryText && <div className="flex justify-start"><div className="max-w-[82%] rounded-2xl bg-white px-4 py-3 shadow-card">
                <AgentMarkdown text={recoveryText} />
                <div className="mt-2 border-t border-mist-200 pt-2 text-[12px] text-mist-500" data-testid="agent-partial-note">
                  {eventResumeEnabled && !activeRun ? '这是服务端保存的未完成内容。你可以发送新消息继续处理。' : busy || activeRun
                    ? '这是上次离开页面时已生成的部分，服务端仍在继续，完成后会补全这条回复。'
                    : '这是上次中断时已生成的部分。这一轮没有正常结束，可以点下方「继续」让智能体接着做。'}
                </div>
              </div></div>}
            </div>
            <div ref={bottomRef} className="h-px" />
          </div>
          {/* DEV-AI27-13b：消息流末尾候选记忆卡片（确认/修改/忽略逐项操作） */}
          {!busy && memoryCandidates.length > 0 && <MemoryCandidateCard candidates={memoryCandidates} {...memoryCandidateHandlers} />}
          {/* A9：本会话实际注入/省略了哪些记忆；只读服务端记录，不推断。 */}
          {conversation && <MemoryUsagePanel conversationId={conversation.id} enabled={bootstrapData.features.personal_memories === true} />}
          {/* P5-4：电脑租约存在时常驻控制条；接管/停止/返回聊天三个人工入口。 */}
          <ComputerControlBar
            enabled={bootstrapData.features.computer_use === true}
            conversationId={conversationId}
            runId={runID || undefined}
            onReturnChat={() => {
              setComputerPickerOpen(false)
              window.setTimeout(() => inputRef.current?.focus(), 0)
            }}
          />
          {/* A12：模型请求前台时在本机选窗，选定后即时建 30 秒租约（不做发消息前预授权）。 */}
          <ComputerWindowPicker
            open={computerPickerOpen}
            conversationId={conversationId}
            runId={runID || undefined}
            onClose={() => setComputerPickerOpen(false)}
            onAuthorized={(summary) => {
              setText((old) => old ? `${old}\n已选择窗口「${summary}」，请继续。` : `已选择窗口「${summary}」，请继续。`)
              window.setTimeout(() => inputRef.current?.focus(), 0)
            }}
          />
          {/* A30：模型请求浏览器标签时授权；选定后即时建 30 秒标签租约（origins 只含顶层页面源）。 */}
          <BrowserTabAuthorizeDialog
            open={browserPickerOpen}
            conversationId={conversationId}
            runId={runID || undefined}
            onClose={() => setBrowserPickerOpen(false)}
            onAuthorized={(summary, grant) => {
              setBrowserGrant(grant)
              setBrowserPaused(false)
              setText((old) => old ? `${old}\n已选择标签「${summary}」，请继续。` : `已选择标签「${summary}」，请继续。`)
              window.setTimeout(() => inputRef.current?.focus(), 0)
            }}
          />
          {/* DEV-A13：协作任务（子任务进度、单项停止、汇总结果）；按会话取组，父 run 已结束也能汇总。 */}
          {conversation && bootstrapData.features.subagents && <div className="mx-auto max-w-3xl px-3">
            <DelegationPanel conversationId={conversation.id}
              onNavigateArtifact={bootstrapData.features.artifacts === true ? () => setArtifactsOpen(true) : undefined} />
          </div>}

          <div className={`shrink-0 border-t border-mist-200 bg-white px-3 pb-[calc(env(safe-area-inset-bottom)+4.5rem)] pt-3 md:pb-4 ${desktopPresentation ? 'desktop-agent-compose-area' : ''} ${workbenchUI ? 'desktop-agent-workbench-compose-area' : ''}`}>
            {(!desktopPresentation || !visibleRunID && (workbenchUI || !!streamError)) && <RunStatus activeRun={activeRun} streamStage={streamStage} toolName={messages.filter((message) => message.run_id === activeRun?.id).flatMap((message) => message.tool_calls ?? []).find((call) => call.status === 'running')?.name} connection={streamConnection} pendingActions={pendingActions} error={streamError} errors={streamErrors} completedNotice={completedNotice} onErrorAction={handleRunErrorAction} />}
            <RunOutcomeNotice run={detail?.last_run} />
            {!desktopPresentation && bootstrapData.features.plans && runtimeSummary && <p className="mx-auto mb-3 max-w-3xl px-3 text-xs text-mist-500" data-testid="agent-runtime-config">{runtimeSummary}</p>}
            {!desktopPresentation && runCostSummary && <p className="mx-auto mb-3 max-w-3xl px-3 text-xs text-mist-500" data-testid="agent-run-cost">{runCostSummary}</p>}
            {onboarding && !onboardingDismissed && <div className="desktop-agent-onboarding mx-auto mb-2 max-w-3xl" role="status" data-testid="agent-onboarding-hint" data-hint={onboarding.id}>
              <span>{onboarding.text}</span>
              {onboarding.action === '去模型配置' || onboarding.action === '去自检' ? <a href="/settings/models" className="underline">{onboarding.action}</a>
                : onboarding.action === '选择账号' ? <button type="button" className="underline" onClick={() => window.dispatchEvent(new Event('ops-desktop-account-switcher-request'))}>{onboarding.action}</button>
                  : onboarding.action === '查看权限' ? <span className="desktop-agent-onboarding-note">卡片执行按业务权限校验</span> : null}
              <button type="button" className="desktop-agent-onboarding-close" aria-label="关闭这条提示" onClick={() => setOnboardingDismissed(true)}><X aria-hidden="true" /></button>
            </div>}
            {pendingActions > 0 && !desktopPresentation && <div className="mx-auto mb-2 max-w-3xl text-[12px] text-mist-500">等待你逐张处理 {pendingActions} 项后，智能体会继续。卡片操作入口显示在对应消息下方。</div>}
            {detail?.can_continue && !busy && !actionExecuting && pendingActions === 0 && <div className="mx-auto mb-2 max-w-3xl text-right"><Button size="sm" variant="ghost" onClick={continueRun}>继续</Button></div>}
            {activeRun && !desktopPresentation && <div className="mx-auto mb-2 max-w-3xl text-right"><Button size="sm" variant="ghost" icon={<Square className="size-3" />} onClick={() => void stop()}>停止</Button></div>}
            {conversation && !activeRun && detail?.actions.some((action) => action.status === 'executing') && <div className="mx-auto mb-2 max-w-3xl text-[12px] text-mist-500">有操作卡片正在执行，请稍候。</div>}
            {detail?.messages.length === 0 && bootstrapData.default_model_unsupported && <div className="mx-auto mb-2 max-w-3xl text-[12px] text-gamboge-700">默认模型未通过工具调用自检，请先选择其他模型。</div>}
            {editMessage && <div className="mx-auto mb-2 flex max-w-3xl items-center justify-between rounded-lg bg-mist-50 px-3 py-1.5 text-xs text-mist-600"><span>编辑最后一条消息并重新运行</span><button type="button" className="cursor-pointer underline" onClick={() => { setEditMessage(null); setText('') }}>取消</button></div>}
            {!desktopPresentation && renderAttachmentQueue()}
            {(contextRefs.length > 0 || pageRefs.length > 0 || subagentsArmed) && <div className="mx-auto mb-2 flex max-w-3xl flex-wrap gap-2">
              {subagentsArmed && <div data-testid="agent-subagents-chip" className="flex items-center gap-2 rounded-lg border border-ink-200 bg-ink-50 px-2 py-1.5 text-xs text-ink-700">
                <Users className="size-3.5" /><span>并行协作</span><span className="text-mist-500">本次任务允许拆成 2 个只读子任务</span>
                <IconButton label="取消并行协作" className="size-6" onClick={() => setSubagentsArmed(false)}><X className="size-3" /></IconButton>
              </div>}
              {contextRefs.map((ref) => <div key={`${ref.type}:${ref.id}`} data-testid="agent-context-ref-chip" className="flex items-center gap-2 rounded-lg border border-ink-200 bg-ink-50 px-2 py-1.5 text-xs text-ink-700">
                <AtSign className="size-3.5" /><span className="max-w-48 truncate">{ref.name}</span><span className="text-mist-500">{ref.reference_scope === 'conversation' ? '固定引用' : '本轮引用'}</span>
                <IconButton label={`移除引用 ${ref.name}`} className="size-6" onClick={() => setContextRefs((old) => old.filter((item) => item.id !== ref.id || item.type !== ref.type))}><X className="size-3" /></IconButton>
              </div>)}
              {pageRefs.map((ref) => <div key={ref.id} data-testid="agent-page-reference-chip" className="flex items-center gap-2 rounded-lg border border-ink-200 bg-ink-50 px-2 py-1.5 text-xs text-ink-700">
                <AtSign className="size-3.5" /><span className="max-w-48 truncate" title={`${ref.selector}\n${ref.note}`}>{ref.name}</span><span className="text-mist-500">本轮引用</span>
                <IconButton label={`移除页面引用 ${ref.name}`} className="size-6" onClick={() => setPageRefs((old) => old.filter((item) => item.id !== ref.id))}><X className="size-3" /></IconButton>
              </div>)}
            </div>}
            {skillRequests.length > 0 && <div className="mx-auto mb-2 flex max-w-3xl flex-wrap gap-2">
              {skillRequests.map((skill) => <div key={`${skill.skill_id}:${skill.work_id ?? ''}`} className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 text-xs ${skill.unavailable ? 'border-danger/40 bg-danger-50 text-danger' : 'border-ink-200 bg-ink-50 text-ink-700'}`}>
                <Sparkles className="size-3.5" /><span className="max-w-48 truncate">{skill.name}</span><span className={skill.unavailable ? 'text-danger' : 'text-mist-500'}>{skillStateLabel({ requested: true, unavailable: skill.unavailable })}</span>
                <IconButton label={`移除技能请求 ${skill.name}`} className="size-6" onClick={() => setSkillRequests((old) => old.filter((item) => item.skill_id !== skill.skill_id || item.work_id !== skill.work_id))}><X className="size-3" /></IconButton>
              </div>)}
            </div>}
            {bootstrapData.features.document_parse && <p className="mx-auto mb-1 max-w-3xl text-xs text-mist-500">PDF / DOCX / CSV ≤20MB；文档≤100页，CSV≤10000行×100列。DOCX分页不可验证时请转PDF。</p>}
            
            <input ref={fileRef} type="file" multiple accept={'image/jpeg,image/png,image/webp,image/gif,.txt,.md' + (bootstrapData.features.document_parse ? ',.pdf,.docx,.csv' : '')} className="hidden" onChange={(event) => { if (event.target.files) void addFiles(event.target.files); event.target.value = '' }} />
            {desktopPresentation ? <>
              <div className={`desktop-agent-compose ${workbenchUI ? 'desktop-agent-workbench-compose' : ''}`} ref={composerRootRef}>
                {renderAttachmentQueue(true)}
                {/* DEV-AI27-16（W16c）：语音输入完整链路（录音→转写→编辑→插入输入框）。 */}
                {conversationId && <VoiceBar conversationId={conversationId} voiceDictationEnabled={bootstrapData.features.voice_dictation === true} onInsert={(voiceText) => { setText((old) => old ? `${old}${voiceText}` : voiceText); window.setTimeout(() => inputRef.current?.focus(), 0) }} />}
                {conversationId && <RealtimeVoiceBar conversationId={conversationId} enabled={bootstrapData.features.voice_realtime === true} onInsert={(voiceText) => { setText((old) => old ? `${old}${voiceText}` : voiceText); window.setTimeout(() => inputRef.current?.focus(), 0) }} />}
                {workbenchUI && composerTrigger && !inputDisabled && <ComposerCandidates trigger={composerTrigger} accountID={selectedAccount} contextRefs={contextRefs} skillRequests={skillRequests}
                  onAddContext={addContextSelection} onAddSkill={addSkillSelection} onCommand={runComposerCommand}
                  onClose={() => { setComposerTrigger(null); focusComposer() }} />}
                <Textarea ref={inputRef} rows={workbenchUI ? 3 : 1} aria-label={workbenchUI ? '发送消息' : undefined} value={text} disabled={inputDisabled} onChange={(event) => { textDraftVersionRef.current++; setText(event.target.value); event.target.style.height = 'auto'; event.target.style.height = `${Math.min(event.target.scrollHeight, workbenchUI ? 176 : 192)}px`; updateComposerTrigger(event.target.value, event.target.selectionStart ?? 0) }}
                  onSelect={(event) => updateComposerTrigger(event.currentTarget.value, event.currentTarget.selectionStart ?? 0)}
                  onCompositionStart={() => { composingRef.current = true }}
                  onCompositionEnd={(event) => { composingRef.current = false; updateComposerTrigger(event.currentTarget.value, event.currentTarget.selectionStart ?? 0) }}
                  onKeyDown={onInputKeyDown}
                  placeholder={bootstrapData.read_only ? '观察者可以提问，智能体不会修改工作区数据' : !bootstrapData.can_use ? (bootstrapData.reason === 'not_tested' ? '请先完成模型能力自检' : '请先配置支持工具调用的模型') : '说说你想写什么，或继续调整上面的方向…'} className="desktop-agent-compose-input" />
                <div className="desktop-agent-compose-toolbar">
                  {/* DEV-AI27-07：统一添加菜单收敛全部上下文与能力入口（27 §5.5）；
                      已选能力仍以筹码形式显示在输入区上方。 */}
                  <AddMenu
                    disabled={!canWrite || busy && !runInputsEnabled || uploading}
                    attachmentsAtLimit={files.length + restoredAttachments.length >= (bootstrapData.limits.attachments_per_message ?? 6)}
                    computerEnabled={bootstrapData.features.computer_use === true}
                    operationsDirectoryEnabled={bootstrapData.features.operations_directory === true}
                    todayOpsEnabled={todayOpsEnabled}
                    sideChatEnabled={bootstrapData.features.side_chat === true && Boolean(conversation)}
                    pluginsEnabled={bootstrapData.features.plugin_mcp === true}
                    subagentsEnabled={bootstrapData.features.subagents === true}
                    workflowTemplatesEnabled={bootstrapData.features.workflow_templates === true}
                    onAction={(action) => {
                      if (action === 'attachment') fileRef.current?.click()
                      else if (action === 'context_refs') setContextPickerOpen(true)
                      else if (action === 'operations_directory') setOperationDirectoryOpen(true)
                      else if (action === 'today_ops') setTodayOpsOpen(true)
                      else if (action === 'side_chat') void createSideChat()
                      else if (action === 'skill') setSkillPickerOpen(true)
                      else if (action === 'goal') openGoalPanel()
                      else if (action === 'routine') setRoutinePanelOpen(true)
                      else if (action === 'plugins') navigate('/settings/plugins')
                      else if (action === 'subagents') { setSubagentsArmed(true); setWorkbenchPanelTab('task'); setWorkbenchPanelOpen(true) }
                      else if (action === 'capabilities') setCapabilitiesOpen(true)
                      else if (action === 'workflow_templates') setWorkflowPickerOpen(true)
                      else if (action === 'computer') setComputerPickerOpen(true)
                    }}
                  />
                  {bootstrapData.features.plans && workbenchUI && conversation?.kind !== 'side' && <AgentModeSelect value={selectedMode} disabled={!canWrite || busy} readOnly={bootstrapData.read_only} onChange={(mode) => void changeMode(mode)} />}
                  <span className="desktop-agent-compose-spacer" />
                  <div className="desktop-agent-model-picker" ref={modelMenuRef}>
                    <button type="button" className="desktop-agent-compose-choice" aria-label="选择模型" aria-haspopup="menu" aria-expanded={modelMenuOpen} title={!bootstrapData.allow_model_pick ? '管理员已锁定模型，不能切换' : undefined} disabled={!canWrite || !bootstrapData.allow_model_pick || busy} onClick={() => setModelMenuOpen((value) => !value)}>{selectedModelName} <ChevronDown /></button>
                    {modelMenuOpen && <div className="desktop-agent-model-menu" role="menu" aria-label="选择模型">
                      <div className="desktop-agent-model-menu-title">选择模型</div>
                      {bootstrapData.models.length === 0 && <div className="desktop-agent-model-menu-empty">暂无可用模型，请先完成模型能力自检。</div>}
                      {bootstrapData.models.map((model) => {
                        const key = modelKey(model.provider_id, model.model)
                        const unavailable = model.available === false
                        return <button type="button" role="menuitemradio" aria-checked={key === selectedModel} key={key} disabled={unavailable}
                          title={unavailable ? model.reason || '模型当前不可用' : undefined}
                          onClick={() => { setModelMenuOpen(false); void updateSelection('model', key) }}>
                          <span><span>{model.model}</span><small>{modelRowMeta(model)}</small>{unavailable && model.reason && <small className="desktop-agent-model-menu-reason">{model.reason}</small>}</span>
                          {key === selectedModel && <Check aria-hidden="true" />}
                        </button>
                      })}
                      <button type="button" className="desktop-agent-model-menu-settings" onClick={() => { setModelMenuOpen(false); navigate('/settings/models') }}>模型设置</button>
                    </div>}
                  </div>
                  {composerBusy && runInputsEnabled ? <div className="desktop-agent-run-input-actions">
                    <div className="desktop-agent-split-action" ref={runInputMenuRef}>
                      <Button variant="secondary" disabled={!canSendContent || inputSubmitting || uploading || failedFiles.length > 0} onClick={() => void postWorkbenchInput('steer')}>补充当前任务</Button>
                      <button type="button" className="desktop-agent-split-more" aria-label="更多运行中输入动作" aria-haspopup="menu" aria-expanded={runInputMenuOpen} onClick={() => setRunInputMenuOpen((value) => !value)}><ChevronDown aria-hidden="true" /></button>
                      {runInputMenuOpen && <div role="menu" aria-label="运行中输入动作" className="desktop-agent-run-input-menu">
                        <button type="button" role="menuitem" disabled={!canSendContent || inputSubmitting || uploading || failedFiles.length > 0}
                          title={inputSubmitting ? '正在提交上一条输入' : undefined}
                          onClick={() => { setRunInputMenuOpen(false); void postWorkbenchInput('queue') }}>
                          <strong>排到下一条</strong><small>当前任务完成后发送</small>
                        </button>
                      </div>}
                    </div>
                    <Button variant="ghost" className="desktop-agent-stop-button" icon={<Square className="size-4" />} onClick={() => void stop()}>停止</Button>
                  </div> : composerBusy ? <Button variant="ghost" className="desktop-agent-stop-button" icon={<Square className="size-4" />} onClick={() => void stop()}>停止</Button>
                    : <>
                      <Button variant="primary" icon={<Send className="size-4" />} disabled={!canWrite || accountMismatch || !canSendContent || uploading || failedFiles.length > 0 || Array.from(text).length > bootstrapData.limits.message_chars} onClick={() => editMessage ? void sendMessage(editMessage) : void sendMessage()}>{uploading ? '上传中' : modeActionLabel(selectedMode)}</Button>
                      {busy && <Button variant="ghost" className="desktop-agent-stop-button" icon={<Square className="size-4" />} onClick={() => void stop()}>停止</Button>}
                    </>}
                </div>
              </div>
            </> : <>
              {bootstrapData.features.plans && conversation?.kind !== 'side' && <div className="mx-auto mb-2 flex max-w-3xl items-center gap-2 text-xs text-mist-500"><AgentModeSelect value={selectedMode} disabled={!canWrite || busy} readOnly={bootstrapData.read_only} onChange={(mode) => void changeMode(mode)} /><span>{selectedMode === 'execute' ? '写入仍需逐张卡片确认' : '只读取与形成建议'}</span></div>}
              <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-2xl border border-mist-200 bg-white p-2 shadow-card focus-within:border-ink-300">
                <IconButton label="添加附件" disabled={!canWrite || busy || uploading || files.length + restoredAttachments.length >= (bootstrapData.limits.attachments_per_message ?? 6)} onClick={() => fileRef.current?.click()} className="mb-0.5"><Paperclip className="size-4" /></IconButton>
                {bootstrapData.features.context_refs && <IconButton label="引用资料（@）" disabled={!canWrite || busy || contextRefs.length >= 12} onClick={() => setContextPickerOpen(true)} className="mb-0.5"><AtSign className="size-4" /></IconButton>}
                {bootstrapData.features.operations_directory === true && <IconButton label="运营目录" disabled={!canWrite || busy || contextRefs.length >= 12} onClick={() => setOperationDirectoryOpen(true)} className="mb-0.5"><Library className="size-4" /></IconButton>}
                {bootstrapData.features.skill_requests && <IconButton label="请求技能（$）" disabled={!canWrite || busy || skillRequests.length >= 3} onClick={() => setSkillPickerOpen(true)} className="mb-0.5"><Sparkles className="size-4" /></IconButton>}
                {goalsEnabled && conversationId && <IconButton label="任务目标与上下文整理" onClick={openGoalPanel} className="mb-0.5"><Bot className="size-4" /></IconButton>}
                {routinesEnabled && <IconButton label="例行任务" onClick={() => setRoutinePanelOpen(true)} className="mb-0.5"><CalendarClock className="size-4" /></IconButton>}
                <Textarea ref={inputRef} rows={1} value={text} disabled={inputDisabled} onChange={(event) => { textDraftVersionRef.current++; setText(event.target.value); event.target.style.height = 'auto'; event.target.style.height = `${Math.min(event.target.scrollHeight, 192)}px` }} onKeyDown={onInputKeyDown}
                  placeholder={bootstrapData.read_only ? '观察者可以提问，智能体不会修改工作区数据' : !bootstrapData.can_use ? (bootstrapData.reason === 'not_tested' ? '请先完成模型能力自检' : '请先配置支持工具调用的模型') : '发送消息…（Enter 发送，Shift+Enter 换行）'} className="max-h-48 min-h-10 resize-none border-0 bg-transparent px-2 py-2 shadow-none focus:border-transparent focus:ring-0 disabled:bg-transparent" />
                {busy ? <Button variant="ghost" className="mb-0.5 shrink-0" icon={<Square className="size-4" />} onClick={() => void stop()}>停止</Button>
                  : <Button variant="primary" className="mb-0.5 shrink-0" icon={<Send className="size-4" />} disabled={!canWrite || !canSendContent || uploading || failedFiles.length > 0 || Array.from(text).length > bootstrapData.limits.message_chars} onClick={() => editMessage ? void sendMessage(editMessage) : void sendMessage()}>{uploading ? '上传中' : modeActionLabel(selectedMode)}</Button>}
              </div>
              <div className="mx-auto mt-1 flex max-w-3xl justify-between px-2 text-[12px] text-mist-400"><span>{readyAttachmentIDs.length ? `已添加 ${readyAttachmentIDs.length} 个附件` : '附件支持图片、txt 与 md'}</span><span>{Array.from(text).length} / {bootstrapData.limits.message_chars}</span></div>
            </>}
          </div>
        </div>
      </section>

      {workbenchUI && workbenchPanelOpen && <div className="desktop-agent-panel-backdrop" aria-hidden="true" onClick={() => setWorkbenchPanelOpen(false)} />}
      {workbenchUI && workbenchPanelOpen && <PanelResizer width={workbenchPanelWidth} onWidthChange={setWorkbenchPanelWidth} />}
      {workbenchUI && workbenchPanelOpen && <WorkbenchSidePanel
        width={workbenchPanelWidth}
        tab={workbenchPanelTab}
        setTab={setWorkbenchPanelTab}
        close={() => setWorkbenchPanelOpen(false)}
        browserWorkspaceEnabled={bootstrapData.features.browser_workspace === true}
        conversation={conversation}
        activeRun={activeRun}
        busy={busy}
        pendingActions={pendingActions}
        pendingQuestions={pendingQuestions}
        actionCount={actions.length}
        selectedAccountName={selectedAccountName}
        selectedModelName={selectedModelName}
        attachmentCount={attachmentCount}
        contextRefs={[...contextRefs, ...pageContextSelections]}
        skillRequests={skillRequests}
        latestSkillUsage={latestSkillUsage}
        artifactsEnabled={bootstrapData.features.artifacts === true}
        artifactCount={detail?.artifact_count ?? 0}
        goalsEnabled={goalsEnabled}
        compactEnabled={eventResumeEnabled}
        canManageGoals={canManageGoals}
        models={bootstrapData.models}
        goal={detail?.goal}
        onCompact={compactRun}
        actions={actions}
        questions={questions}
        inputs={inputs}
        inputQueuePaused={inputQueuePaused}
        onUpdateInput={updateQueuedInput}
        onCancelInput={cancelQueuedInput}
        onRestoreInput={restoreNeedsReviewInput}
        onResumeInputs={resumeInputQueue}
        onQuoteArtifact={quoteArtifact}
        memoryFeaturesEnabled={bootstrapData.features.personal_memories === true}
        messages={detail?.messages ?? []}
        browserGrant={browserGrant}
        browserPaused={browserPaused}
        onBrowserTakeOver={() => void takeOverBrowser()}
        onBrowserHandBack={() => void handBackBrowser()}
        onStopRun={() => void stop()}
        onEmptyGoal={() => { setWorkbenchPanelTab('task'); openGoalPanel() }}
        onEmptyContext={() => setContextPickerOpen(true)}
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
      <Dialog open={localSearchOpen} onClose={() => setLocalSearchOpen(false)} title="查找当前对话" desc="搜索当前对话中所有已保存的用户与助手消息。">
        <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void searchSavedMessages() }}>
          <div className="flex gap-2">
            <Input ref={localSearchInputRef} aria-label="搜索当前对话" value={localSearchText} onChange={(event) => setLocalSearchText(event.target.value)} placeholder="输入要查找的文字" disabled={localSearchBusy} />
            <Button type="submit" variant="primary" disabled={!localSearchText.trim() || localSearchBusy}>{localSearchBusy ? '搜索中…' : '查找'}</Button>
          </div>
        </form>
        {localSearchBusy && <p role="status" className="mt-3 text-[13px] text-mist-500">正在搜索已保存的消息…</p>}
        {localSearchError && <p role="alert" className="mt-3 text-[13px] text-danger">{localSearchError}</p>}
        {!localSearchBusy && !localSearchError && localSearchText.trim() && <p role="status" className="mt-3 text-[12px] text-mist-500">找到 {localSearchResults.length} 条消息</p>}
        <div className="mt-3 max-h-80 space-y-1 overflow-y-auto">
          {localSearchResults.map((message) => <button key={message.id} type="button" className="block w-full rounded-lg border border-mist-200 p-3 text-left hover:border-ink-300 hover:bg-ink-50 focus-visible:outline-2 focus-visible:outline-ink-500" onClick={() => jumpToSearchResult(message)}>
            <span className="text-[12px] font-medium text-mist-500">{message.role === 'user' ? '你' : '助手'} · 第 {message.seq} 条</span>
            <span className="mt-1 block whitespace-pre-wrap break-words text-[13px] leading-5 text-mist-800">{message.content.slice(0, 220)}</span>
          </button>)}
          {!localSearchText.trim() && <p className="py-5 text-center text-[13px] text-mist-500">输入关键词，搜索此对话的完整历史。</p>}
          {!localSearchBusy && !localSearchError && localSearchText.trim() && !localSearchResults.length && <p className="py-5 text-center text-[13px] text-mist-500">没有匹配的消息</p>}
        </div>
      </Dialog>
      <Dialog open={!desktopPresentation && settingsOpen} onClose={() => setSettingsOpen(false)} title="对话设置" desc="选择本对话使用的模型与操作账号。">
        <div className="space-y-4">
          <label className="block space-y-1.5 text-[13px] font-medium text-mist-700">模型
            <Select aria-label="选择模型" value={selectedModel} disabled={!canWrite || !bootstrapData.allow_model_pick || busy} onChange={(event) => void updateSelection('model', event.target.value)}>
              {!selectedModel && <option value="">选择模型</option>}
              {bootstrapData.default_model_unsupported && <option value="" disabled>默认模型未通过工具调用自检</option>}
              {selectedModel && !bootstrapData.models.some((model) => modelKey(model.provider_id, model.model) === selectedModel) && <option value={selectedModel}>所选模型已不可用</option>}
              {bootstrapData.models.map((model) => <option key={modelKey(model.provider_id, model.model)} value={modelKey(model.provider_id, model.model)}>{model.provider_name} · {model.model}{model.vision ? ' · 看图' : ''}{model.is_default ? ' · 默认' : ''}</option>)}
            </Select>
            {bootstrapData.models.length === 0 && <span className="block text-xs font-normal text-mist-500">暂无可用于智能体的模型，请先到模型配置页完成能力自检。</span>}
          </label>
          <label className="block space-y-1.5 text-[13px] font-medium text-mist-700">操作账号
            <Select aria-label="选择账号" value={selectedAccount} disabled={!canWrite || busy || accounts.isLoading} onChange={(event) => void updateSelection('account', event.target.value)}>
              <option value="">不指定账号</option>
              {accountList.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
            </Select>
          </label>
          {bootstrapData.features.agent_roles && <label className="block space-y-1.5 text-[13px] font-medium text-mist-700">执行角色
            <Select aria-label="选择角色" data-testid="agent-role-select" value={selectedRoleID} disabled={!canWrite || busy || rolesQuery.isLoading} onChange={(event) => setSelectedRoleID(event.target.value)}>
              <option value="">默认（不限定角色）</option>
              {(rolesQuery.data?.roles ?? []).filter((role) => role.status === 'active').map((role) => <option key={role.id} value={role.id}>{role.name}{role.builtin_key ? ' · 内置' : ''}</option>)}
            </Select>
            <span className="block text-xs font-normal text-mist-500">角色限定工具白名单与轮数预算；写入仍逐张卡片确认。</span>
          </label>}
          {bootstrapData.features.plans && desktopPresentation && !workbenchUI && conversation?.kind !== 'side' && <div className="space-y-2"><span className="block text-[13px] font-medium text-mist-700">模式</span><AgentModeSelect value={selectedMode} disabled={!canWrite || busy} readOnly={bootstrapData.read_only} onChange={(mode) => void changeMode(mode)} />{runtimeSummary && <p className="text-xs text-mist-500" data-testid="agent-runtime-config">{runtimeSummary}</p>}{runCostSummary && <p className="text-xs text-mist-500" data-testid="agent-run-cost">{runCostSummary}</p>}</div>}
          {/* AG-03：历史消息按创建时的账号保存，切换账号不会改写已发生的对话。 */}
          {accountSwitched && <div data-testid="agent-account-switched"><Notice tone="gamboge">
            新消息将使用「{selectedAccountName}」，当前对话的历史仍属于「{historyAccountName}」。想从干净的上下文开始，请新建对话。
            <div className="mt-2"><Button type="button" size="sm" variant="outline" onClick={() => { setSettingsOpen(false); newConversation() }}>新建对话</Button></div>
          </Notice></div>}
        </div>
      </Dialog>
      <ContextPickerDialog
        open={contextPickerOpen}
        onClose={() => setContextPickerOpen(false)}
        accountID={selectedAccount}
        conversationID={conversationId}
        selected={contextRefs}
        onAdd={(item) => setContextRefs((old) => old.some((ref) => ref.id === item.id && ref.type === item.type) ? old : [...old, item])}
      />
      <OperationDirectoryDrawer
        open={operationDirectoryOpen}
        onClose={() => setOperationDirectoryOpen(false)}
        accountID={selectedAccount}
        selected={contextRefs}
        onAdd={(item) => setContextRefs((old) => old.some((ref) => ref.id === item.id && ref.type === item.type) ? old : [...old, item])}
      />
      <WorkflowTemplateDialog
        open={workflowPickerOpen}
        onClose={() => setWorkflowPickerOpen(false)}
        templates={(workflowsQuery.data?.templates ?? []).filter((template) => template.status === 'active')}
        accountID={selectedAccount}
        accounts={accountList.map((account) => ({ id: account.id, name: account.name }))}
        onStarted={workflowStarted}
      />
      <SkillPickerDialog
        open={skillPickerOpen}
        onClose={() => setSkillPickerOpen(false)}
        accountID={selectedAccount}
        selected={skillRequests}
        workOptions={selectedWorkOptions}
        onAdd={(item) => setSkillRequests((old) => old.some((skill) => skill.skill_id === item.skill_id && skill.work_id === item.work_id) || old.length >= 3 ? old : [...old, item])}
      />
      <Dialog open={compactDialogOpen} onClose={() => setCompactDialogOpen(false)} title="压缩这段对话？" desc="压缩只影响下一次运行的上下文，不会删除消息。原始消息仍可查看、检索和导出。"
        footer={<><Button variant="ghost" onClick={() => setCompactDialogOpen(false)}>取消</Button><Button variant="primary" loading={busy} onClick={() => { setCompactDialogOpen(false); void compactRun() }}>开始压缩</Button></>}>
        <p className="text-[13px] leading-relaxed text-mist-600">会保留任务目标、约束与已确认结论；未确认的内容不会被当作结论。压缩失败时保留原上下文。</p>
      </Dialog>
      <Dialog open={privacyOpen} onClose={() => { setPrivacyOpen(false); savePrefs.mutate({ agent_privacy_notice_seen: true }) }} title="智能体隐私说明" desc="对话仅你本人可见。工作区所有者和系统管理员也无法查看你的对话；卡片执行会照常写入操作日志，并标记为来自智能体。" footer={<Button variant="primary" onClick={() => { setPrivacyOpen(false); savePrefs.mutate({ agent_privacy_notice_seen: true }) }}>我知道了</Button>}>
        <p className="text-[13px] leading-relaxed text-mist-600">不要在对话或附件中发送 API 密钥、平台密钥、密码或邀请码。智能体读取的信息会按系统规则传给当前选择的模型供应商。</p>
      </Dialog>
      {todayOpsEnabled && todayOpsOpen && <TodayOpsPanel accountID={selectedAccount} onClose={() => setTodayOpsOpen(false)} />}
      </div>
    </>
  )
}

function Welcome({ onPrompt, noModel, desktopWorkbench = false, summary, onOpenTodayOps }: { onPrompt: (value: string) => void; noModel: boolean; desktopWorkbench?: boolean; summary?: string | null; onOpenTodayOps?: () => void }) {
  // UI-06：三张运营卡只填入输入框，不发送、不切模式、不带权限；摘要一行。
  // FN-11：today_ops 开启时摘要可点开只读驾驶舱；关闭时仍是不可点的一行摘要。
  const cards = [
    { title: '帮我找选题', desc: '从评论、指标与复盘中找下一批可写的题。', prompt: '帮我找下一批可写的选题，并说明理由。' },
    { title: '改一篇作品', desc: '按平台规则改标题、摘要和正文，改动先看卡片。', prompt: '帮我改一篇作品，先给我看改动卡片。' },
    { title: '先定发布计划', desc: '给完成稿排时间表，写清账号、形式与检查项。', prompt: '给已完成的作品排一份发布计划，写清账号、形式与检查项。' },
  ]
  return <div className={`mx-auto flex min-h-[50%] max-w-2xl flex-col items-center justify-center py-12 text-center ${desktopWorkbench ? 'desktop-agent-welcome-v2' : ''}`}>
    <div className="desktop-agent-welcome-icon"><Bot aria-hidden="true" /></div>
    <h1 className="desktop-agent-welcome-heading">{desktopWorkbench ? '让智能体接手一件运营工作' : '有什么可以帮你？'}</h1>
    <p className="desktop-agent-welcome-sub">{desktopWorkbench ? '它能读写工作区，但每一次写入都要你逐张卡片确认。' : '可以读取工作区信息并生成建议。任何写入操作都会先列出单张卡片，由你逐张确认执行。'}</p>
    {!noModel && <div className={desktopWorkbench ? 'desktop-agent-welcome-cards' : 'mt-6 flex flex-wrap justify-center gap-2'}>
      {cards.map((card) => <button key={card.title} type="button" aria-label={`填入：${card.title}`} onClick={() => onPrompt(card.prompt)}
        className={desktopWorkbench ? 'desktop-agent-welcome-card' : 'cursor-pointer rounded-full border border-mist-200 bg-white px-3 py-2 text-[12px] text-mist-600 shadow-card hover:border-ink-300 hover:text-ink-700'}>
        {desktopWorkbench
          ? <><span className="desktop-agent-welcome-card-icon"><Sparkles aria-hidden="true" /></span><strong>{card.title}</strong><span>{card.desc}</span></>
          : card.title}
      </button>)}
    </div>}
    {workbenchSummaryLine(summary, onOpenTodayOps)}
  </div>
}

function workbenchSummaryLine(summary?: string | null, onOpenTodayOps?: () => void) {
  if (!summary) return null
  if (onOpenTodayOps) return <button type="button" className="desktop-agent-welcome-summary is-link" data-testid="today-ops-welcome-entry" onClick={onOpenTodayOps}>{summary}</button>
  return <p className="desktop-agent-welcome-summary">{summary}</p>
}

function Unavailable({ bootstrap, navigate }: { bootstrap: AgentBootstrap; navigate: ReturnType<typeof useNavigate> }) {
  // AG-01 & AG-05：智能体不可用时给出「去开启/去配置」出口，按原因和角色分别给按钮直达对应设置页
  const reason = bootstrap.reason
  const isOwner = bootstrap.role === 'owner'
  const goToAgentSettings = () => navigate('/settings/agent')
  const goToModelSettings = () => navigate('/settings/models')

  let title = ''
  let subtitle = ''
  let actionButton = null

  if (reason === 'admin_override') {
    title = '代访问期间不能使用智能体'
    subtitle = '切换回原身份后可正常使用。'
  } else if (reason === 'viewer_disabled') {
    title = '所有者已关闭观察者使用智能体'
    subtitle = isOwner
      ? '作为所有者，你可以到设置页自行开启。'
      : '请联系工作区所有者开启观察者权限。'
    actionButton = isOwner && (
      <button type="button" onClick={goToAgentSettings} className="inline-flex mt-3 cursor-pointer items-center gap-1 rounded-md bg-ink-600 px-3 py-2 text-[13px] text-white shadow hover:bg-ink-700">
        去智能体设置
      </button>
    )
  } else if (reason === 'disabled') {
    title = '所有者已关闭智能体'
    subtitle = isOwner
      ? '作为所有者，你可以到设置页自行开启。'
      : '请联系工作区所有者开启。'
    actionButton = isOwner && (
      <button type="button" onClick={goToAgentSettings} className="inline-flex mt-3 cursor-pointer items-center gap-1 rounded-md bg-ink-600 px-3 py-2 text-[13px] text-white shadow hover:bg-ink-700">
        去智能体设置
      </button>
    )
  } else if (reason === 'no_model') {
    title = '还没有配置可用于对话的模型'
    subtitle = '请先配置支持工具调用的模型。历史对话仍可查看。'
    actionButton = (
      <button type="button" onClick={goToModelSettings} className="inline-flex mt-3 cursor-pointer items-center gap-1 rounded-md bg-ink-600 px-3 py-2 text-[13px] text-white shadow hover:bg-ink-700">
        去模型配置
      </button>
    )
  } else if (reason === 'not_tested') {
    title = '模型已经配置好了，但还没有完成能力自检'
    subtitle = '完成一次自检后就能开始对话。历史对话仍可查看。'
    actionButton = (
      <button type="button" onClick={goToModelSettings} className="inline-flex mt-3 cursor-pointer items-center gap-1 rounded-md bg-ink-600 px-3 py-2 text-[13px] text-white shadow hover:bg-ink-700">
        去模型配置并自检
      </button>
    )
  } else {
    title = '智能体暂时不可用'
    subtitle = '请稍后重试或联系管理员。'
  }

  return <div className="flex h-full items-center justify-center p-6"><div className="max-w-md rounded-2xl border border-mist-200 bg-white p-8 text-center shadow-card"><Bot className="mx-auto size-8 text-mist-300" /><h1 className="mt-3 text-lg font-semibold text-mist-800">{title}</h1><p className="mt-2 text-sm text-mist-500">{subtitle}</p>{actionButton}</div></div>
}

