import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { toast } from 'sonner'
import { ApiError, errorMessage, get, post, stream } from '@/lib/api'
import {
  type AgentConversationDetail, type AgentEventEnvelope, type AgentMessage,
  type AgentPlan, type AgentQuestion, type AgentRunAcceptance,
  streamAgentEvents,
} from '@/lib/agent'

export function useAgentRun({
  conversationId,
  detail,
  eventResumeEnabled,
  submitting,
  setSubmitting,
  baseMessages,
  desktopPresentation = false,
}: {
  conversationId: string | undefined
  detail: AgentConversationDetail | undefined
  eventResumeEnabled: boolean
  submitting: boolean
  setSubmitting: Dispatch<SetStateAction<boolean>>
  baseMessages: AgentMessage[]
  desktopPresentation?: boolean
}) {
  const qc = useQueryClient()
  const [streaming, setStreaming] = useState(false)
  const [streamText, setStreamText] = useState('')
  const [streamStage, setStreamStage] = useState('')
  const [streamError, setStreamError] = useState('')
  const [streamConnection, setStreamConnection] = useState('')
  const [runID, setRunID] = useState('')
  const [completedNotice, setCompletedNotice] = useState('')
  const [eventResumeGeneration, setEventResumeGeneration] = useState(0)
  const [computerPickerOpen, setComputerPickerOpen] = useState(false)
  const handledComputerRequests = useRef<Set<string>>(new Set())
  const [browserPickerOpen, setBrowserPickerOpen] = useState(false)
  const handledBrowserRequests = useRef<Set<string>>(new Set())
  const eventController = useRef<AbortController | null>(null)
  // 卡片执行完会自动续跑；续跑若与用户刚发出的消息撞车，会把那条消息的运行控制器 abort 掉，
  // 表现为消息已点发送却一直没有响应。用这个 ref 判断是否已有运行在受理/流出。
  const runInFlight = useRef(false)
  const sendInFlight = useRef(false)
  const eventConversationID = useRef('')
  const streamPartialRef = useRef<{ messageKey: string; chunkIndex: number }>({ messageKey: '', chunkIndex: 0 })
  const lastEventSeqRef = useRef(0)
  const resumeAfterSnapshotRef = useRef(false)
  const conversationIDRef = useRef(conversationId)
  conversationIDRef.current = conversationId

  const activeRun = detail?.active_run
  const busy = submitting || streaming || !!activeRun

  const applyPersistentEvent = useCallback((id: string, type: string, event: AgentEventEnvelope, targetRunID = '') => {
    lastEventSeqRef.current = Math.max(lastEventSeqRef.current, event.event_seq)
    const data = event.data ?? {}
    if (type === 'run.started') {
      setRunID(event.run_id ?? '')
      setStreaming(true)
      setStreamStage(data.status === 'queued' ? 'queued' : 'thinking')
      void qc.invalidateQueries({ queryKey: ['agent-conversation', id] })
    } else if (type === 'run.stage') {
      setStreamStage(data.stage || 'thinking')
    } else if (type === 'message.delta' || type === 'message.snapshot') {
      const messageKey = String(data.message_key ?? '')
      const chunkIndex = Number(data.chunk_index ?? 0)
      if (!messageKey || chunkIndex <= 0) return
      if (qc.getQueryData<AgentConversationDetail>(['agent-conversation', id])?.messages.some((message) => message.message_key === messageKey)) return
      const current = streamPartialRef.current
      if (type === 'message.snapshot') {
        if (current.messageKey === messageKey && chunkIndex <= current.chunkIndex) return
        streamPartialRef.current = { messageKey, chunkIndex }
        setStreamText(String(data.text ?? ''))
      } else {
        if (current.messageKey === messageKey && chunkIndex <= current.chunkIndex) return
        streamPartialRef.current = { messageKey, chunkIndex }
        setStreamText((old) => current.messageKey === messageKey ? old + String(data.text ?? '') : String(data.text ?? ''))
      }
    } else if (type === 'tool.started' || type === 'tool.ended' || type === 'action.updated' || type === 'message.saved' || type === 'conversation.updated' || type === 'context.updated' || type === 'plan.updated' || type === 'question.created' || type === 'question.resolved' || type.startsWith('input.')) {
      if (type === 'tool.started') setStreamStage(`tool:${data.name || '工具'}`)
      // A12：模型请求前台目标时弹本机选窗器；同一 tool_call_id 只弹一次（事件重放不重复打扰）。
      if (type === 'tool.ended' && data.name === 'computer_request_target' && data.status === 'done') {
        const callID = String(data.tool_call_id ?? '')
        if (callID && !handledComputerRequests.current.has(callID)) {
          handledComputerRequests.current.add(callID)
          setComputerPickerOpen(true)
        }
      }
      // A30：模型请求浏览器标签时弹授权弹窗（选定后即时建 30 秒标签租约）。
      if (type === 'tool.ended' && data.name === 'browser_request_tab' && data.status === 'done') {
        const callID = String(data.tool_call_id ?? '')
        if (callID && !handledBrowserRequests.current.has(callID)) {
          handledBrowserRequests.current.add(callID)
          setBrowserPickerOpen(true)
        }
      }
      void qc.invalidateQueries({ queryKey: ['agent-conversation', id] })
      void qc.invalidateQueries({ queryKey: ['agent-conversations'] })
    } else if (type === 'artifact.created') {
      void qc.invalidateQueries({ queryKey: ['agent-conversation', id] })
      void qc.invalidateQueries({ queryKey: ['agent-artifacts'] })
      void qc.invalidateQueries({ queryKey: ['agent-artifact'] })
    } else if (type === 'run.ended') {
      if (!targetRunID) setStreaming(false)
      setRunID('')
      setStreamText('')
      setStreamStage('')
      void qc.invalidateQueries({ queryKey: ['agent-conversation', id] })
      void qc.invalidateQueries({ queryKey: ['agent-conversations'] })
    }
  }, [qc])

  const resumeEventSnapshot = useCallback(async (id: string, runID: string) => {
    const snapshot = await qc.fetchQuery({ queryKey: ['agent-conversation', id], queryFn: () => get<AgentConversationDetail>(`/agent/conversations/${id}`), staleTime: 0 })
    if (runID && snapshot.last_run?.id !== runID) return { after: lastEventSeqRef.current }
    const partial = snapshot.partial_output
    streamPartialRef.current = { messageKey: partial?.message_key ?? '', chunkIndex: partial?.chunk_index ?? 0 }
    setStreamText(snapshot.active_run ? partial?.text ?? '' : '')
    lastEventSeqRef.current = snapshot.last_event_seq ?? lastEventSeqRef.current
    return { after: lastEventSeqRef.current, ...(runID && !snapshot.active_run ? { ended: snapshot.last_run ?? undefined } : {}) }
  }, [qc])

  useEffect(() => {
    if (eventController.current && eventConversationID.current === conversationId) return
    eventController.current?.abort()
    eventController.current = null
    lastEventSeqRef.current = 0
    streamPartialRef.current = { messageKey: '', chunkIndex: 0 }
    setStreaming(false)
    setRunID('')
    setStreamText('')
    setStreamStage('')
    setStreamConnection('')
  }, [conversationId])

  useEffect(() => () => eventController.current?.abort(), [])

  useEffect(() => {
    const key = streamPartialRef.current.messageKey
    if (eventResumeEnabled && key && baseMessages.some((message) => message.message_key === key)) {
      setStreamText('')
    }
  }, [baseMessages, eventResumeEnabled])

  const consumeRun = useCallback(async (id: string, endpoint: string, body: Record<string, unknown>, onAccepted?: (accepted?: Pick<AgentRunAcceptance, 'run_id' | 'message_id'>) => void) => {
    const controller = new AbortController()
    runInFlight.current = true
    eventController.current?.abort()
    eventController.current = controller
    eventConversationID.current = id
    let acceptedRequest = false
    const markAccepted = (accepted?: Pick<AgentRunAcceptance, 'run_id' | 'message_id'>) => {
      if (acceptedRequest) return
      acceptedRequest = true
      onAccepted?.(accepted)
      if (desktopPresentation) {
        // 受理事务已将用户消息持久化；在第一条工具/回答事件前刷新，立即同步服务端消息。
        void qc.cancelQueries({ queryKey: ['agent-conversation', id], exact: true }).then(() =>
          qc.fetchQuery({
            queryKey: ['agent-conversation', id],
            queryFn: () => get<AgentConversationDetail>(`/agent/conversations/${id}`),
            staleTime: 0,
          }),
        ).catch(() => { void qc.invalidateQueries({ queryKey: ['agent-conversation', id], exact: true }) })
        void qc.invalidateQueries({ queryKey: ['agent-conversations'] })
      }
      if (accepted?.run_id) setRunID(accepted.run_id)
    }
    setStreaming(true)
    setStreamText('')
    setStreamStage('thinking')
    setStreamError('')
    setRunID('')
    setStreamConnection('')
    try {
      const requestID = typeof body.request_id === 'string' && body.request_id ? body.request_id : crypto.randomUUID()
      const result = eventResumeEnabled
        ? await (async () => {
          const accepted = await post<AgentRunAcceptance>(endpoint, { ...body, request_id: requestID, protocol_version: 2 }, controller.signal)
          markAccepted(accepted)
          lastEventSeqRef.current = accepted.last_event_seq
          streamPartialRef.current = { messageKey: '', chunkIndex: 0 }
          return streamAgentEvents(accepted.events_url, accepted.last_event_seq, {
            signal: controller.signal,
            runID: accepted.run_id,
            onEvent: (type, event) => applyPersistentEvent(id, type, event, accepted.run_id),
            onConnectionState: setStreamConnection,
            onResume: () => resumeEventSnapshot(id, accepted.run_id),
          })
        })()
        : await stream<{ status?: string; reason?: string }>(endpoint, body, {
          signal: controller.signal,
          onDelta: (delta) => setStreamText((old) => old + delta),
          onEvent: (name, data) => {
            if (name === 'run') markAccepted({ run_id: data.run_id ?? '' })
            if (name === 'stage') setStreamStage(data.stage === 'tool' ? `tool:${data.label || data.tool_name || '工具'}` : data.stage || 'thinking')
            if (name === 'action' || name === 'message' || name === 'tool') {
              void qc.invalidateQueries({ queryKey: ['agent-conversation', id] })
              void qc.invalidateQueries({ queryKey: ['agent-conversations'] })
            }
            if (name === 'error') setStreamError(data.message || '运行失败，请重试')
            if (name === 'done') setStreamStage(data.reason === 'waiting_confirmation' ? 'waiting_confirmation' : '')
          },
        })
      markAccepted()
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['agent-conversation', id] }),
        qc.invalidateQueries({ queryKey: ['agent-conversations'] }),
      ])
      setCompletedNotice(result?.status === 'stopped' ? '已停止'
        : result?.reason === 'round_limit' || result?.reason === 'deadline' ? '已达到单次运行上限'
          : result?.status === 'awaiting_confirmation' ? '等待你逐张确认操作卡片' : '')
      if (result?.status === 'failed') setStreamError('本次运行已中断，请查看已保存的结果后再继续。')
      return true
    } catch (error) {
      if (controller.signal.aborted) return acceptedRequest
      await qc.invalidateQueries({ queryKey: ['agent-conversation', id] })
      if (error instanceof ApiError && error.code === 'agent_event_cursor_expired') {
        resumeAfterSnapshotRef.current = true
        await qc.fetchQuery({ queryKey: ['agent-conversation', id], queryFn: () => get<AgentConversationDetail>(`/agent/conversations/${id}`) })
      } else {
        setStreamError(errorMessage(error))
      }
      return acceptedRequest
    } finally {
      if (eventController.current === controller) {
        runInFlight.current = false
        eventController.current = null
        if (resumeAfterSnapshotRef.current) {
          resumeAfterSnapshotRef.current = false
          setEventResumeGeneration((generation) => generation + 1)
        }
        setStreaming(false)
        setRunID('')
        setStreamText('')
        setStreamStage('')
        setStreamConnection('')
        if (eventResumeEnabled) setEventResumeGeneration((generation) => generation + 1)
      }
    }
  }, [qc, eventResumeEnabled, applyPersistentEvent, resumeEventSnapshot, desktopPresentation])

  const acceptPlan = async (plan: AgentPlan) => {
    if (!conversationId || busy || sendInFlight.current) return
    sendInFlight.current = true
    setSubmitting(true)
    try {
      await consumeRun(conversationId, `/agent/plans/${plan.id}/accept`, {
        expected_version: plan.version, request_id: crypto.randomUUID(),
      })
    } finally {
      sendInFlight.current = false
      setSubmitting(false)
    }
  }
  const answerQuestion = async (question: AgentQuestion, answers: { question_id: string; choice_id?: string; text?: string; skip?: boolean }[]) => {
    if (!conversationId || busy || sendInFlight.current) return
    sendInFlight.current = true
    setSubmitting(true)
    try {
      await consumeRun(conversationId, `/agent/questions/${question.id}/answer`, {
        expected_revision: question.revision, request_id: crypto.randomUUID(), answers,
      })
    } finally {
      sendInFlight.current = false
      setSubmitting(false)
    }
  }

  useEffect(() => {
    if (!eventResumeEnabled || !conversationId || detail?.conversation.id !== conversationId || eventController.current) return
    const controller = new AbortController()
    eventController.current = controller
    eventConversationID.current = conversationId
    const lastEventSeq = Math.max(lastEventSeqRef.current, detail?.last_event_seq ?? 0)
    lastEventSeqRef.current = lastEventSeq
    const partial = activeRun ? detail?.partial_output : null
    if (partial?.text) {
      streamPartialRef.current = { messageKey: partial.message_key, chunkIndex: partial.chunk_index }
      setStreamText(partial.text)
    } else {
      streamPartialRef.current = { messageKey: '', chunkIndex: 0 }
      setStreamText('')
    }
    const targetRunID = activeRun?.id ?? ''
    setRunID(targetRunID)
    setStreamStage(activeRun?.stage || '')
    setStreaming(!!activeRun)
    void streamAgentEvents(`/api/v1/agent/conversations/${conversationId}/events`, lastEventSeq, {
      signal: controller.signal,
      runID: targetRunID,
      onEvent: (type, event) => applyPersistentEvent(conversationId, type, event, targetRunID),
      onConnectionState: setStreamConnection,
      onResume: () => resumeEventSnapshot(conversationId, targetRunID),
    }).then(async (result) => {
      await qc.invalidateQueries({ queryKey: ['agent-conversation', conversationId] })
      await qc.invalidateQueries({ queryKey: ['agent-conversations'] })
      if (conversationIDRef.current !== conversationId) return
      setCompletedNotice(result.status === 'stopped' ? '已停止'
        : result.reason === 'round_limit' || result.reason === 'deadline' ? '已达到单次运行上限'
          : result.status === 'awaiting_confirmation' ? '等待你逐张确认操作卡片' : '')
      if (result.status === 'failed') setStreamError('本次运行已中断，请查看已保存的结果后再继续。')
    }).catch(async (error) => {
      if (controller.signal.aborted) return
      if (error instanceof ApiError && error.code === 'agent_event_cursor_expired') {
        resumeAfterSnapshotRef.current = true
        await qc.fetchQuery({ queryKey: ['agent-conversation', conversationId], queryFn: () => get<AgentConversationDetail>(`/agent/conversations/${conversationId}`) })
      } else {
        setStreamError(errorMessage(error))
      }
    }).finally(() => {
      if (eventController.current !== controller) return
      eventController.current = null
      setStreaming(false)
      setRunID('')
      setStreamText('')
      setStreamStage('')
      setStreamConnection('')
      if (resumeAfterSnapshotRef.current) {
        resumeAfterSnapshotRef.current = false
        setEventResumeGeneration((generation) => generation + 1)
      }
    })
    return () => {
      if (eventController.current === controller) {
        controller.abort()
        eventController.current = null
        setStreaming(false)
        setRunID('')
        setStreamStage('')
        setStreamConnection('')
      }
    }
  }, [eventResumeEnabled, conversationId, detail?.conversation.id, activeRun?.id, eventResumeGeneration,
    qc, applyPersistentEvent, resumeEventSnapshot])

  // 操作卡片执行成功后的自动续跑：已有运行在受理/流出时让位，避免 abort 掉用户刚发的消息。
  const continueRun = () => { if (conversationId && !runInFlight.current) void consumeRun(conversationId, `/agent/conversations/${conversationId}/continue`, {}) }
  const compactRun = () => conversationId
    ? consumeRun(conversationId, `/agent/conversations/${conversationId}/compact`, { request_id: crypto.randomUUID() })
    : Promise.resolve(false)
  const regenerate = () => { if (conversationId) void consumeRun(conversationId, `/agent/conversations/${conversationId}/regenerate`, {}) }
  const stop = async () => {
    const id = runID || activeRun?.id
    if (!id) return
    try {
      await post(`/agent/runs/${id}/cancel`, {})
      setStreamStage('stopping')
      await qc.invalidateQueries({ queryKey: ['agent-conversation', conversationId] })
    } catch (error) { toast.error(errorMessage(error)) }
  }

  return {
    streaming, setStreaming,
    streamText, setStreamText,
    streamStage, setStreamStage,
    streamError, setStreamError,
    streamConnection,
    runID, setRunID,
    completedNotice, setCompletedNotice,
    runInFlight,
    sendInFlight,
    computerPickerOpen, setComputerPickerOpen,
    browserPickerOpen, setBrowserPickerOpen,
    consumeRun,
    continueRun,
    compactRun,
    acceptPlan,
    answerQuestion,
    regenerate,
    stop,
  }
}
