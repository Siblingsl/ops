import { useEffect, useMemo, useRef, useState } from 'react'
import type { QueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Bot, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui'
import { get, post, errorMessage } from '@/lib/api'
import { AgentMarkdown } from '@/lib/agent-markdown'
import { trackAgentEvent } from '@/lib/agent-telemetry-client'
import { todayOpsWelcomeSummary } from '@/lib/today-ops.js'
import { mapAgentError, type AgentErrorInput } from '@/lib/agent-ui.js'
import type { AgentAction, AgentActiveRun, AgentMessage, AgentModel, AgentPlan, AgentQuestion } from '@/lib/agent'
import type { AgentConversation, AgentConversationDetail } from '@/lib/agent'
import type { AgentContextSelection, AgentSkillSelection } from './ContextPickers'
import type { AgentPageReference } from './AgentDialogs'
import { AgentActionCards } from './ActionCards'
import { AgentRunTimeline } from './AgentRunTimeline'
import { groupAssistantRunSegments, messageTime, MessageView, RunStatus, splitDate } from './MessageChrome'
import { AgentPlanCard, AgentQuestionCard } from './PlansQuestions'
import { StateBlock } from './StateBlock'
import { MemoryCandidateCard } from './MemoryCandidateCard'
import { MemoryUsagePanel } from './MemoryUsagePanel'
import type { TodayOpsView } from './TodayOpsPanel'
import { groupDesktopAgentMessages, pendingAgentMessageIsPersisted, type PendingAgentMessage } from './MessageChrome'

type AgentMessageStreamOptions = {
  conversationId: string | undefined
  baseMessages: AgentMessage[]
  detail: AgentConversationDetail | undefined
  detailLoading: boolean
  pendingUserMessages: PendingAgentMessage[]
  setPendingUserMessages: React.Dispatch<React.SetStateAction<PendingAgentMessage[]>>
  desktopPresentation: boolean
  conversation: AgentConversation | undefined
  organizeEnabled: boolean
  pageVisible: boolean
  eventResumeEnabled: boolean
  qc: QueryClient
}

export function useAgentMessageStream({
  conversationId, baseMessages, detail, detailLoading, pendingUserMessages, setPendingUserMessages,
  desktopPresentation, conversation, organizeEnabled, pageVisible, eventResumeEnabled, qc,
}: AgentMessageStreamOptions) {
  const [olderMessages, setOlderMessages] = useState<AgentMessage[]>([])
  const [pendingJump, setPendingJump] = useState<{ conversationID: string; seq: number } | null>(null)
  const [manualUnreadSuppressedID, setManualUnreadSuppressedID] = useState('')
  const olderLoadingRef = useRef(false)
  const manualScrollRef = useRef(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const lastConversationIDRef = useRef(conversationId)
  const conversationIDRef = useRef(conversationId)
  conversationIDRef.current = conversationId
  const [localSearchOpen, setLocalSearchOpen] = useState(false)
  const [localSearchText, setLocalSearchText] = useState('')
  const [localSearchBusy, setLocalSearchBusy] = useState(false)
  const [localSearchResults, setLocalSearchResults] = useState<AgentMessage[]>([])
  const [localSearchError, setLocalSearchError] = useState('')
  const localSearchInputRef = useRef<HTMLInputElement>(null)

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

  useEffect(() => {
    if (lastConversationIDRef.current !== conversationId) {
      lastConversationIDRef.current = conversationId
      setManualUnreadSuppressedID('')
    }
  }, [conversationId])

  useEffect(() => {
    setOlderMessages([])
    setLocalSearchResults([])
    setLocalSearchError('')
  }, [conversationId])

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
    if (!pendingJump || pendingJump.conversationID !== conversationId || detailLoading || !detail) return
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
  }, [pendingJump, conversationId, detailLoading, detail, messages, loadOlder])

  useEffect(() => {
    if (!organizeEnabled || !conversationId || !conversation || !messages.length || !pageVisible || manualUnreadSuppressedID === conversationId) return
    const eventMode = eventResumeEnabled === true
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
    eventResumeEnabled, detail?.read_upto_event_seq, detail?.last_event_seq, detail?.has_unread])

  const openLocalSearch = () => {
    setLocalSearchText('')
    setLocalSearchResults([])
    setLocalSearchError('')
    setLocalSearchOpen(true)
    window.setTimeout(() => localSearchInputRef.current?.focus(), 0)
  }

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

  return {
    messages, displayEntries, loadOlder, bottomRef, manualScrollRef, manualUnreadSuppressedID, setManualUnreadSuppressedID,
    pendingJump, setPendingJump, olderMessages,
    localSearchOpen, setLocalSearchOpen, localSearchText, setLocalSearchText, localSearchBusy,
    localSearchResults, localSearchError, localSearchInputRef, openLocalSearch, searchSavedMessages, jumpToSearchResult,
  }
}

type RunStatusProps = React.ComponentProps<typeof RunStatus>
type QuestionCardProps = React.ComponentProps<typeof AgentQuestionCard>

type AgentMessageStreamProps = {
  stream: ReturnType<typeof useAgentMessageStream>
  desktopPresentation: boolean
  workbenchUI: boolean
  conversationId: string | undefined
  conversation?: AgentConversation
  detailLoading: boolean
  detailError: unknown
  detailErrorIsError: boolean
  detailHasMore: boolean
  onRefetchDetail: () => void
  lastAssistant?: AgentMessage
  lastUser?: AgentMessage
  selectedModelOption?: AgentModel
  actions: AgentAction[]
  plans: AgentPlan[]
  questions: AgentQuestion[]
  pendingQuestion?: AgentQuestion
  actionMessageByRun: Record<string, string>
  actionExecuting: boolean
  reviewActionID: string | null
  setReviewActionID: (id: string | null) => void
  organizeEnabled: boolean
  busy: boolean
  personalMemoriesEnabled: boolean
  canWrite: boolean
  pageRefs: AgentPageReference[]
  selectedAccount: string
  clearDraftAttachments: () => void
  setEditMessage: React.Dispatch<React.SetStateAction<AgentMessage | null>>
  setText: React.Dispatch<React.SetStateAction<string>>
  setContextRefs: React.Dispatch<React.SetStateAction<AgentContextSelection[]>>
  setPageRefs: React.Dispatch<React.SetStateAction<AgentPageReference[]>>
  setSkillRequests: React.Dispatch<React.SetStateAction<AgentSkillSelection[]>>
  inputRef: React.RefObject<HTMLTextAreaElement | null>
  addContextSelection: (item: AgentContextSelection) => boolean
  regenerate: () => void
  setActionExecuting: (value: boolean) => void
  invalidate: () => Promise<void>
  continueRun: () => void
  acceptPlan: (plan: AgentPlan) => void
  answerQuestion: QuestionCardProps['onAnswer']
  forkFromMessage: (message: AgentMessage) => void
  visibleRunID: string
  streamText: string
  recoveryText?: string
  recoveryRunID: string
  eventResumeEnabled: boolean
  activeRun?: AgentActiveRun
  streamStage: string
  streaming: boolean
  runID: string
  streamConnection: RunStatusProps['connection']
  pendingActions: number
  streamError: AgentErrorInput
  streamErrors: AgentErrorInput[]
  completedNotice: string
  handleRunErrorAction: (action: string) => void
  hasRunActivity: boolean
  dragging: boolean
  dragHandlers: {
    onDragEnter: (event: React.DragEvent<HTMLDivElement>) => void
    onDragLeave: (event: React.DragEvent<HTMLDivElement>) => void
    onDragOver: (event: React.DragEvent<HTMLDivElement>) => void
    onDrop: (event: React.DragEvent<HTMLDivElement>) => void
  }
  noModel: boolean
  todayOpsEnabled: boolean
  todayOpsSummaryData?: TodayOpsView
  todayOpsSummaryIsError: boolean
  pendingQuestions: number
  onOpenTodayOps: () => void
  aux?: React.ReactNode
  composer?: React.ReactNode
}

export function AgentMessageStream(props: AgentMessageStreamProps) {
  const p = props
  const { stream } = p
  const pendingActions = p.pendingActions
  const pendingQuestions = p.pendingQuestions
  // DEV-AI27-13b：消息流候选记忆（run 结束后展示，确认后才注入后续对话）
  const [memoryCandidates, setMemoryCandidates] = useState<Array<{ id: string; text: string; state: string; revision: number }>>([])
  useEffect(() => {
    if (p.busy || !p.conversationId || !p.personalMemoriesEnabled) {
      setMemoryCandidates([])
      return
    }
    const controller = new AbortController()
    void fetch(`/api/v1/agent/personal-memories?state=candidate&source_conversation_id=${p.conversationId}`, {
      credentials: 'same-origin', signal: controller.signal,
    }).then((res) => res.ok ? res.json() : null).then((data) => {
      if (data?.memories) setMemoryCandidates(data.memories)
    }).catch(() => {})
    return () => controller.abort()
  }, [p.busy, p.conversationId, p.personalMemoriesEnabled])
  const memoryCandidateHandlers = {
    busy: p.busy,
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
  const renderMessageBlock = (message: AgentMessage, sourceMessages: AgentMessage[], inlineAssistant = false, showFeedback = true) => (
    <>
      <MessageView message={message} lastAssistant={message.id === p.lastAssistant?.id} canSeeImages={p.selectedModelOption?.vision === true} desktopPresentation={p.desktopPresentation} inlineAssistant={inlineAssistant}
        showFeedback={showFeedback} showToolActivity={!p.workbenchUI}
        forkMessages={sourceMessages.length > 1 ? sourceMessages : undefined}
        skillRequests={stream.messages.find((candidate) => candidate.role === 'user' && candidate.run_id === message.run_id)?.skill_requests ?? []}
        onFork={p.organizeEnabled && message.role !== 'system' ? () => void p.forkFromMessage(message) : undefined}
        onForkMessage={p.organizeEnabled ? (source) => void p.forkFromMessage(source) : undefined}
        onEdit={message.id === p.lastUser?.id && !p.busy && !p.pendingQuestion && p.canWrite && p.pageRefs.length === 0 && !message.attachments.length && !message.context_refs?.length && !message.skill_requests?.length ? () => { p.setEditMessage(message); p.setText(message.content); p.clearDraftAttachments(); p.setContextRefs([]); p.setPageRefs([]); p.setSkillRequests([]); p.inputRef.current?.focus() } : undefined}
        onRegenerate={message.id === p.lastAssistant?.id && !p.busy && p.canWrite ? p.regenerate : undefined}
        onQuoteSelection={p.canWrite ? (ref) => {
          p.addContextSelection({ id: ref.id, type: 'message', name: '引用', summary: '选段引用', scope: 'turn', account_id: p.selectedAccount || null, revision: '', updated_at: '', reference_scope: 'turn', anchor: ref.anchor })
        } : undefined} />
      {message.role === 'assistant' && message.run_id && sourceMessages.some((source) => p.actionMessageByRun[message.run_id!] === source.id) && <div className={p.desktopPresentation ? 'desktop-agent-action-wrapper' : ''}><AgentActionCards
        actions={p.actions.filter((action) => action.run_id === message.run_id)}
        running={p.busy || p.actionExecuting}
        onRefresh={p.invalidate}
        onContinue={p.continueRun}
        onExecutingChange={p.setActionExecuting}
        desktopPresentation={p.desktopPresentation}
        reviewActionID={p.reviewActionID}
        onOpenReview={(id) => { trackAgentEvent('agent_review_open', 'action'); p.setReviewActionID(id) }}
        onCloseReview={() => p.setReviewActionID(null)}
      /></div>}
      {message.role === 'assistant' && message.run_id && p.plans.filter((plan) => plan.source_run_id === message.run_id).map((plan) => <AgentPlanCard key={plan.id} plan={plan} canWrite={p.canWrite} busy={p.busy} blocked={!!p.pendingQuestion} onAccept={(item) => void p.acceptPlan(item)} />)}
      {message.role === 'assistant' && message.run_id && p.questions.filter((question) => question.run_id === message.run_id).map((question) => <AgentQuestionCard key={question.id} question={question} canWrite={p.canWrite} busy={p.busy} onAnswer={(item, answers) => void p.answerQuestion(item, answers)} />)}
    </>
  )

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {p.dragging && <div className="absolute inset-3 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-ink-400 bg-white/90 text-ink-700">松开以上传图片或文本</div>}
      <div className={`scrollbar-thin min-h-0 flex-1 overflow-y-auto px-3 py-5 sm:px-6 ${p.desktopPresentation ? 'desktop-agent-chat-stream' : ''}`} onWheel={() => { stream.manualScrollRef.current = true }} onTouchStart={() => { stream.manualScrollRef.current = true }} onPointerDown={() => { stream.manualScrollRef.current = true }} onKeyDown={(event) => { if (['End', 'PageDown', 'ArrowDown'].includes(event.key)) stream.manualScrollRef.current = true }} onScroll={(event) => {
        if (!stream.manualScrollRef.current || stream.manualUnreadSuppressedID !== p.conversationId) return
        const node = event.currentTarget
        if (node.scrollHeight - node.scrollTop - node.clientHeight <= 8) {
          stream.manualScrollRef.current = false
          stream.setManualUnreadSuppressedID('')
        }
      }} {...p.dragHandlers}>
        {p.detailLoading && p.conversationId && <div className="mx-auto max-w-3xl py-6"><StateBlock tone="loading" title="正在加载对话…" desc="消息、卡片与任务状态会一起恢复。" /></div>}
        {p.detailErrorIsError && (() => {
          const mapped = mapAgentError(p.detailError as AgentErrorInput)
          return <div className="mx-auto max-w-3xl"><StateBlock tone="error" title={mapped.title} desc={mapped.reason} requestId={mapped.requestId}
            action={<div className="flex items-center gap-2"><Button size="sm" variant="outline" onClick={() => p.onRefetchDetail()}>重试</Button>
              {mapped.requestId && <Button size="sm" variant="ghost" onClick={() => { void navigator.clipboard.writeText(mapped.requestId); toast('请求 ID 已复制') }}>复制请求 ID</Button>}</div>} /></div>
        })()}
        {!p.conversationId && !stream.messages.length && <Welcome onPrompt={(value) => p.setText(value)} noModel={p.noModel} desktopWorkbench={p.workbenchUI}
          summary={p.workbenchUI ? (p.todayOpsEnabled ? (p.todayOpsSummaryData ? todayOpsWelcomeSummary(p.todayOpsSummaryData) : p.todayOpsSummaryIsError ? '今日运营需要权限或暂时不可用 · 查看说明' : '正在汇总今日运营…') : `今天 ${pendingActions + pendingQuestions} 项待处理`) : null}
          onOpenTodayOps={p.todayOpsEnabled ? () => p.onOpenTodayOps() : undefined} />}
        {p.detailHasMore && <div className="mx-auto mb-4 max-w-3xl text-center"><Button size="sm" variant="ghost" onClick={() => void stream.loadOlder()}>加载更早的消息</Button></div>}
        <div className={`mx-auto flex max-w-3xl flex-col gap-4 ${p.desktopPresentation ? 'desktop-agent-message-column' : ''}`}>
          {stream.displayEntries.map((entry, index) => {
            const entryMessages = entry.kind === 'message' ? [entry.message] : entry.messages
            const firstMessage = entryMessages[0]
            const previousEntry = stream.displayEntries[index - 1]
            const previous = previousEntry ? (previousEntry.kind === 'message' ? previousEntry.message : previousEntry.messages.at(-1)) : undefined
            const startsDay = p.desktopPresentation && (!previous || splitDate(previous.created_at) !== splitDate(firstMessage.created_at))
            if (entry.kind === 'message') return <div key={entry.message.id} data-message-seq={entry.message.seq} data-message-id={entry.message.id} className="relative">
              {startsDay && <div className="desktop-agent-day">{splitDate(firstMessage.created_at)} · {messageTime(firstMessage.created_at)}</div>}
              {renderMessageBlock(entry.message, [entry.message])}
            </div>

            const segments = groupAssistantRunSegments(entry.messages)
            const feedbackSegment = [...segments].reverse().find(({ message }) => message.content.trim() || message.attachments.length > 0)
            let previousSegmentMessage: AgentMessage | undefined
            const showRunActivity = p.visibleRunID === entry.runId
            const runningToolName = entry.messages.flatMap((message) => message.tool_calls ?? []).find((call) => call.status === 'running')?.name
            return <article key={`run:${entry.runId}`} data-run-id={entry.runId} className="desktop-agent-message assistant desktop-agent-run-message">
              {startsDay && <div className="desktop-agent-day">{splitDate(firstMessage.created_at)} · {messageTime(firstMessage.created_at)}</div>}
              <div className="desktop-agent-message-speaker">
                <span className="desktop-agent-bot-avatar"><Bot /></span><strong>OPS</strong>
                <small>{p.activeRun?.id === entry.runId ? (p.streamStage.startsWith('tool:') ? '处理中' : '运行中') : messageTime(entry.messages.at(-1)!.created_at)}</small>
              </div>
              {p.workbenchUI && <AgentRunTimeline runId={entry.runId}
                toolCalls={entry.messages.flatMap((message) => message.tool_calls ?? [])}
                actions={p.actions.filter((action) => action.run_id === entry.runId)}
                plan={p.plans.find((item) => item.source_run_id === entry.runId) ?? null} />}
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
                {p.streamText && <div className="desktop-agent-run-live"><AgentMarkdown text={p.streamText} /><p className="desktop-agent-run-live-note">正在生成，内容尚未完成</p></div>}
                {!p.streamText && p.recoveryText && p.recoveryRunID === entry.runId && <div className="desktop-agent-run-live">
                  <AgentMarkdown text={p.recoveryText} />
                  <div className="desktop-agent-run-live-note" data-testid="agent-partial-note">
                    {p.eventResumeEnabled && !p.activeRun ? '这是服务端保存的未完成内容。你可以发送新消息继续处理。' : p.busy || p.activeRun
                      ? '这是上次离开页面时已生成的部分，服务端仍在继续，完成后会补全这条回复。'
                      : '这是上次中断时已生成的部分。这一轮没有正常结束，可以点下方「继续」让智能体接着做。'}
                  </div>
                </div>}
                <RunStatus activeRun={p.activeRun?.id === entry.runId ? p.activeRun : undefined} streamStage={p.streamStage} toolName={runningToolName} connection={p.streamConnection} pendingActions={p.pendingActions} error={p.streamError} errors={p.streamErrors} completedNotice={p.completedNotice} onErrorAction={p.handleRunErrorAction} />
              </>}
            </article>
          })}
          {p.plans.filter((plan) => !stream.displayEntries.some((entry) => entry.kind === 'assistant-run' && entry.runId === plan.source_run_id)).map((plan) => <AgentPlanCard key={plan.id} plan={plan} canWrite={p.canWrite} busy={p.busy} blocked={!!p.pendingQuestion} onAccept={(item) => void p.acceptPlan(item)} />)}
          {p.desktopPresentation && p.hasRunActivity && p.visibleRunID && !stream.displayEntries.some((entry) => entry.kind === 'assistant-run' && entry.runId === p.visibleRunID) && <article data-run-id={p.visibleRunID} className="desktop-agent-message assistant desktop-agent-run-message">
            <div className="desktop-agent-message-speaker"><span className="desktop-agent-bot-avatar"><Bot /></span><strong>OPS</strong><small>{p.activeRun || p.streaming || p.runID ? '运行中' : '正在恢复'}</small></div>
            {p.workbenchUI && <AgentRunTimeline runId={p.visibleRunID}
              toolCalls={stream.messages.filter((message) => message.run_id === p.visibleRunID).flatMap((message) => message.tool_calls ?? [])}
              actions={p.actions.filter((action) => action.run_id === p.visibleRunID)} />}
            {p.streamText && <div className="desktop-agent-run-live"><AgentMarkdown text={p.streamText} /><p className="desktop-agent-run-live-note">正在生成，内容尚未完成</p></div>}
            {!p.streamText && p.recoveryText && <div className="desktop-agent-run-live">
              <AgentMarkdown text={p.recoveryText} />
              <div className="desktop-agent-run-live-note" data-testid="agent-partial-note">
                {p.eventResumeEnabled && !p.activeRun ? '这是服务端保存的未完成内容。你可以发送新消息继续处理。' : p.busy || p.activeRun
                  ? '这是上次离开页面时已生成的部分，服务端仍在继续，完成后会补全这条回复。'
                  : '这是上次中断时已生成的部分。这一轮没有正常结束，可以点下方「继续」让智能体接着做。'}
              </div>
            </div>}
            <RunStatus activeRun={p.activeRun} streamStage={p.streamStage} toolName={stream.messages.filter((message) => message.run_id === p.visibleRunID).flatMap((message) => message.tool_calls ?? []).find((call) => call.status === 'running')?.name} connection={p.streamConnection} pendingActions={p.pendingActions} error={p.streamError} errors={p.streamErrors} completedNotice={p.completedNotice} onErrorAction={p.handleRunErrorAction} />
          </article>}
          {!p.desktopPresentation && p.streamText && <div className="flex justify-start"><div className="max-w-[82%] rounded-2xl bg-white px-4 py-3 shadow-card"><AgentMarkdown text={p.streamText} /><p className="mt-2 text-[12px] text-mist-500">正在生成，内容尚未完成</p></div></div>}
          {/* AG-04：离开页面时没写完的回复。服务端整轮结束后才落库，这里先把已生成的部分显示出来，
              并说明「服务端仍在继续」，避免用户以为内容丢了而重新发一遍。 */}
          {!p.desktopPresentation && !p.streamText && p.recoveryText && <div className="flex justify-start"><div className="max-w-[82%] rounded-2xl bg-white px-4 py-3 shadow-card">
            <AgentMarkdown text={p.recoveryText} />
            <div className="mt-2 border-t border-mist-200 pt-2 text-[12px] text-mist-500" data-testid="agent-partial-note">
              {p.eventResumeEnabled && !p.activeRun ? '这是服务端保存的未完成内容。你可以发送新消息继续处理。' : p.busy || p.activeRun
                ? '这是上次离开页面时已生成的部分，服务端仍在继续，完成后会补全这条回复。'
                : '这是上次中断时已生成的部分。这一轮没有正常结束，可以点下方「继续」让智能体接着做。'}
            </div>
          </div></div>}
        </div>
        <div ref={stream.bottomRef} className="h-px" />
      </div>
      {!p.busy && memoryCandidates.length > 0 && <MemoryCandidateCard candidates={memoryCandidates} {...memoryCandidateHandlers} />}
      {p.conversation && <MemoryUsagePanel conversationId={p.conversation.id} enabled={p.personalMemoriesEnabled} />}
      {p.aux}
      {p.composer}
    </div>
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
