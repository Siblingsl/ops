import {
  Bot, ChevronDown, ChevronLeft, Clipboard, FileText, GitBranch, LoaderCircle, Pencil,
} from 'lucide-react'
import { useId, useState } from 'react'
import { toast } from 'sonner'
import { AIFeedback } from '@/components/refs'
import { Notice, Select } from '@/components/ui'
import { assetUrl } from '@/lib/api-base'
import {
  type AgentConversationDetail, type AgentMessage, type AgentMode,
} from '@/lib/agent'
import { AgentMarkdown } from '@/lib/agent-markdown'
import { AttachmentReceipt } from '@/pages/agent/AttachmentReceipt'

export type PendingAgentMessage = {
  conversationID: string
  requestID: string
  messageID?: string
  runID?: string
  message: AgentMessage
}

export function pendingAgentMessageIsPersisted(pending: PendingAgentMessage, messages: AgentMessage[]) {
  return messages.some((message) => message.role === 'user'
    && ((pending.messageID && message.id === pending.messageID) || (pending.runID && message.run_id === pending.runID)))
}

export function attachmentVariantURL(value: string, variant: 'thumb' | 'original') {
  // D-153：附件 URL 由后端返回相对路径，跨源部署（前端在 CF、后端在云服务器）时必须先补上 API 基址。
  const url = new URL(assetUrl(value), window.location.origin)
  url.searchParams.set('variant', variant)
  return url.href
}

export function modelKey(providerID: string | null | undefined, model: string | null | undefined) {
  return providerID && model ? `${providerID}::${model}` : ''
}

export function splitDate(value: string) {
  const date = new Date(value)
  const today = new Date()
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.floor((start(today) - start(date)) / 86_400_000)
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  if (days < 7) return '7 天内'
  return '更早'
}

export function messageTime(value: string) {
  return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

export type AgentDisplayEntry = { kind: 'message'; message: AgentMessage }
  | { kind: 'assistant-run'; runId: string; messages: AgentMessage[] }
export type AgentRunSegment = { message: AgentMessage; sourceMessages: AgentMessage[] }

export function isToolOnlyAssistantMessage(message: AgentMessage) {
  return message.role === 'assistant' && !!message.run_id && message.tool_calls.length > 0
    && !message.content.trim() && message.attachments.length === 0
}

export function groupDesktopAgentMessages(messages: AgentMessage[], enabled: boolean): AgentDisplayEntry[] {
  const displayEntries: AgentDisplayEntry[] = []
  for (let index = 0; index < messages.length;) {
    const first = messages[index]
    if (!enabled || first.role !== 'assistant' || !first.run_id) {
      displayEntries.push({ kind: 'message', message: first })
      index++
      continue
    }
    const runMessages = [first]
    let nextIndex = index + 1
    while (nextIndex < messages.length) {
      const next = messages[nextIndex]
      if (next.role !== 'assistant' || next.run_id !== first.run_id) break
      runMessages.push(next)
      nextIndex++
    }
    displayEntries.push({ kind: 'assistant-run', runId: first.run_id, messages: runMessages })
    index = nextIndex
  }
  return displayEntries
}

export function groupAssistantRunSegments(messages: AgentMessage[]): AgentRunSegment[] {
  const segments: AgentRunSegment[] = []
  for (let index = 0; index < messages.length;) {
    const first = messages[index]
    if (!isToolOnlyAssistantMessage(first)) {
      segments.push({ message: first, sourceMessages: [first] })
      index++
      continue
    }
    const sourceMessages = [first]
    let nextIndex = index + 1
    while (nextIndex < messages.length) {
      const next = messages[nextIndex]
      if (!isToolOnlyAssistantMessage(next) || splitDate(next.created_at) !== splitDate(first.created_at)) break
      sourceMessages.push(next)
      nextIndex++
    }
    const last = sourceMessages[sourceMessages.length - 1]
    const skillUsage = new Map<string, NonNullable<AgentMessage['skill_usage']>[number]>()
    for (const source of sourceMessages) for (const usage of source.skill_usage ?? []) skillUsage.set(`${usage.id}:${usage.scope}`, usage)
    segments.push({
      message: { ...last, tool_calls: sourceMessages.flatMap((source) => source.tool_calls), skill_usage: [...skillUsage.values()] },
      sourceMessages,
    })
    index = nextIndex
  }
  return segments
}

export function AgentModeSelect({ value, disabled, readOnly, onChange }: { value: AgentMode; disabled: boolean; readOnly: boolean; onChange: (mode: AgentMode) => void }) {
  return <span className="inline-flex w-24 shrink-0"><Select aria-label="对话模式" title={disabled ? '运行或操作执行期间模式锁定' : '执行模式允许提出单张卡片，每张仍需亲自确认'} value={readOnly ? 'discuss' : value} disabled={disabled || readOnly} className="h-8 py-1 text-xs" onChange={(event) => onChange(event.target.value as AgentMode)}>
    <option value="discuss">讨论</option><option value="plan">计划</option><option value="execute">执行</option>
  </Select></span>
}

export function MessageView({ message, lastAssistant, canSeeImages, onEdit, onRegenerate, onFork, onForkMessage, forkMessages, skillRequests = [], desktopPresentation = false, inlineAssistant = false, showFeedback = true }: {
  message: AgentMessage; lastAssistant: boolean; canSeeImages: boolean; onEdit?: () => void; onRegenerate?: () => void; onFork?: () => void
  onForkMessage?: (message: AgentMessage) => void; forkMessages?: AgentMessage[]
  skillRequests?: AgentMessage['skill_requests']; desktopPresentation?: boolean; inlineAssistant?: boolean; showFeedback?: boolean
}) {
  const [toolsOpen, setToolsOpen] = useState(false)
  const toolsId = useId()
  const user = message.role === 'user'
  const time = messageTime(message.created_at)
  const Wrapper = inlineAssistant ? 'div' : 'article'
  return (
    <Wrapper className={inlineAssistant ? 'group desktop-agent-run-message-item' : `group flex ${user ? 'justify-end' : 'justify-start'} ${desktopPresentation ? `desktop-agent-message ${user ? 'user' : 'assistant'}` : ''}`}>
      {desktopPresentation && !inlineAssistant && <div className="desktop-agent-message-speaker">
        {user ? <span className="desktop-agent-user-avatar">林</span> : <span className="desktop-agent-bot-avatar"><Bot /></span>}
        <strong>{user ? '你' : 'OPS'}</strong>
        <small>{user ? time : message.tool_calls?.length ? '工具活动' : time}</small>
      </div>}
      <div className={`min-w-0 max-w-[92%] rounded-2xl px-4 py-3 sm:max-w-[82%] ${desktopPresentation ? 'desktop-agent-message-bubble' : ''} ${user ? 'bg-ink-600 text-white' : message.role === 'system' ? 'border border-gamboge-200 bg-gamboge-50 text-gamboge-900' : 'bg-white shadow-card'}`}>
        {message.attachments?.length > 0 && <div className="mb-2 flex flex-wrap gap-2">
          {message.attachments.map((attachment) => attachment.kind === 'image'
            ? <a key={attachment.id} href={attachmentVariantURL(attachment.url, 'original')} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-lg"><img src={attachmentVariantURL(attachment.url, 'thumb')} alt={attachment.name} className="size-24 object-cover" /></a>
            : <div key={attachment.id} className={`rounded-lg px-2 py-1 text-xs ${user ? 'bg-white/15' : 'bg-mist-100 text-mist-600'}`}><span className="inline-flex items-center gap-1"><FileText className="size-3.5" />{attachment.url ? <a href={assetUrl(attachment.url)} download className="underline">{attachment.name}</a> : attachment.name}</span><AttachmentReceipt attachment={attachment} sent /></div>)}
        </div>}
        {user && !canSeeImages && message.attachments?.some((attachment) => attachment.kind === 'image') && <Notice tone="gamboge" className="mb-2">当前模型不能看图，图片只能用于保存或数据截图识别。</Notice>}
        {user && !!message.context_refs?.length && <div className="mb-2 flex flex-wrap gap-1.5">
          {message.context_refs.map((ref) => <span key={`${ref.type}:${ref.id}`} className={`rounded-md px-2 py-1 text-[11px] ${user ? 'bg-white/15 text-white/90' : 'bg-ink-50 text-ink-700'}`}>{ref.name || (ref.type === 'work' ? '作品' : ref.type === 'material' ? '素材' : ref.type === 'topic' ? '选题' : ref.type === 'image' ? '图片' : ref.type === 'report' ? '报告' : ref.type)} · {ref.scope === 'conversation' ? '固定引用' : '本轮引用'}</span>)}
        </div>}
        {user && !!message.skill_requests?.length && <div className="mb-2 flex flex-wrap gap-1.5">
          {message.skill_requests.map((request) => <span key={`${request.skill_id}:${request.work_id ?? ''}`} className="rounded-md bg-white/15 px-2 py-1 text-[11px] text-white/90">技能已请求 · {request.name || request.skill_id.slice(0, 8)}</span>)}
        </div>}
        {user ? <p className={`whitespace-pre-wrap break-words text-[14px] leading-relaxed ${desktopPresentation ? 'desktop-agent-user-content' : ''}`}>{message.content}</p>
          : <AgentMarkdown text={message.content} />}
        {!user && skillRequests.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">
          {skillRequests.map((request) => {
            const usage = message.skill_usage?.find((skill) => skill.id === request.skill_id)
            const status = usage?.loaded ? '已加载到本次模型上下文；实际使用未验证' : '已请求，未加载'
            return <span key={request.skill_id} className="rounded-md bg-mist-100 px-2 py-1 text-[11px] text-mist-600">{status} · {usage?.name || request.name || request.skill_id.slice(0, 8)}</span>
          })}
        </div>}
        {message.tool_calls?.length > 0 && <div className={`mt-2 border-t pt-2 ${user ? 'border-white/20' : 'border-mist-100'}`}>
          <button type="button" aria-expanded={toolsOpen} aria-controls={toolsId} onClick={() => setToolsOpen((value) => !value)} className={`inline-flex cursor-pointer items-center gap-1 text-[12px] ${desktopPresentation ? 'desktop-agent-tool-summary' : ''} ${user ? 'text-white/75' : 'text-mist-500 hover:text-mist-700'}`}>
            {message.tool_calls.some((call) => call.status === 'running') ? <LoaderCircle className="size-3.5 animate-spin" /> : <ChevronDown className={`size-3.5 transition-transform ${toolsOpen ? '' : '-rotate-90'}`} />}
            工具活动 {message.tool_calls.length} 项
          </button>
          <div id={toolsId} aria-hidden={!toolsOpen} className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out ${toolsOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
            <div className="min-h-0 overflow-hidden">
              <div className={`mt-2 space-y-2 text-xs ${user ? 'text-white/80' : 'text-mist-500'}`}>
                {message.tool_calls.map((call) => <details key={call.id} className="rounded-lg border border-current/10 px-2.5 py-2">
                  <summary tabIndex={toolsOpen ? undefined : -1} className="cursor-pointer">
                    {call.summary || call.name}
                    {call.status && <span className="ml-2">{call.status === 'running' ? '处理中' : call.status === 'done' ? '已完成' : call.status === 'cancelled' ? '已取消，未执行' : call.status === 'interrupted' ? '结果未确认' : '失败'}</span>}
                    {call.duration_ms !== undefined && call.status !== 'running' && <span className="ml-2">{(call.duration_ms / 1000).toFixed(1)} 秒</span>}
                  </summary>
                  {call.error && <p className="mt-2 text-danger">{call.error.message}（{call.error.code}）{call.error.request_id && ` · ${call.error.request_id}`}</p>}
                  {call.result_preview && <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-sans">{call.result_preview}</pre>}
                </details>)}
              </div>
            </div>
          </div>
        </div>}
        <div className={`mt-1.5 flex items-center gap-1 text-[10.5px] ${desktopPresentation ? 'desktop-agent-message-footer' : ''} ${user ? 'text-white/60' : 'text-mist-400'}`}>
          <time>{time}</time>
          {user && desktopPresentation ? <div className="ml-auto flex items-center gap-1 text-mist-500 opacity-70 group-hover:opacity-100">
            {onEdit && <button type="button" title="编辑" aria-label={`编辑第 ${message.seq} 条消息`} onClick={onEdit} className="cursor-pointer rounded p-1 hover:bg-mist-100"><Pencil className="size-3.5" /></button>}
            {onFork && <button type="button" title="从这里继续" aria-label={`从第 ${message.seq} 条消息创建分支`} onClick={onFork} className="cursor-pointer rounded p-1 hover:bg-mist-100"><GitBranch className="size-3.5" /></button>}
            {!!message.content.trim() && <button type="button" title="复制" aria-label={`复制第 ${message.seq} 条消息`} onClick={() => void navigator.clipboard.writeText(message.content).then(() => toast.success('已复制')).catch(() => toast.error('复制失败'))} className="cursor-pointer rounded p-1 hover:bg-mist-100"><Clipboard className="size-3.5" /></button>}
          </div> : <>
            {user && onEdit && <button type="button" onClick={onEdit} className="ml-2 cursor-pointer opacity-0 underline group-hover:opacity-100 focus:opacity-100">编辑</button>}
            {user && onFork && <button type="button" title="从这里继续" aria-label={`从第 ${message.seq} 条消息创建分支`} onClick={onFork} className="ml-2 inline-flex cursor-pointer items-center gap-1 opacity-0 underline group-hover:opacity-100 focus:opacity-100"><GitBranch className="size-3.5" />从这里继续</button>}
          </>}
          {!user && message.role === 'assistant' && <div className="ml-auto flex items-center gap-1 opacity-70 group-hover:opacity-100">
            {!!message.content.trim() && <button type="button" title="复制" onClick={() => void navigator.clipboard.writeText(message.content).then(() => toast.success('已复制')).catch(() => toast.error('复制失败'))} className="cursor-pointer rounded p-1 hover:bg-mist-100"><Clipboard className="size-3.5" /></button>}
            {onFork && (forkMessages?.length
              ? forkMessages.map((source) => <button key={source.id} type="button" title={`从第 ${source.seq} 条消息继续`} aria-label={`从第 ${source.seq} 条消息创建分支`} onClick={() => onForkMessage?.(source)} className="cursor-pointer rounded p-1 hover:bg-mist-100"><GitBranch className="size-3.5" /></button>)
              : <button type="button" title="从这里继续" aria-label={`从第 ${message.seq} 条消息创建分支`} onClick={onFork} className="cursor-pointer rounded p-1 hover:bg-mist-100"><GitBranch className="size-3.5" /></button>)}
            {showFeedback && <AIFeedback callId={message.ai_call_id} />}
            {lastAssistant && onRegenerate && <button type="button" title="重新生成" onClick={onRegenerate} className="cursor-pointer rounded p-1 hover:bg-mist-100"><ChevronLeft className="size-3.5" /></button>}
          </div>}
        </div>
      </div>
    </Wrapper>
  )
}

export function RunStatus({ activeRun, streamStage, toolName, connection, pendingActions, error, completedNotice }: { activeRun: AgentConversationDetail['active_run'] | undefined; streamStage: string; toolName?: string; connection: string; pendingActions: number; error: string; completedNotice: string }) {
  if (error) return <div role="alert" className="mx-auto mb-3 max-w-3xl rounded-lg bg-danger/5 px-3 py-2 text-[12.5px] text-danger">{error}</div>
  const text = connection === 'reconnecting' ? '连接中断，任务可能仍在运行，正在恢复…'
    : connection === 'paused' ? '实时连接已暂停，任务可能仍在运行'
    : streamStage === 'stopping' || activeRun?.stage === 'stopping' ? '正在停止，等待在途工具结束…'
    : streamStage === 'queued' || activeRun?.status === 'queued' ? '排队中'
    : streamStage.startsWith('tool:') ? `正在处理工具：${streamStage.slice(5)}`
    : toolName && activeRun?.stage === 'tool' ? `正在处理工具：${toolName}`
      : streamStage === 'waiting_confirmation' ? `等待你确认 ${pendingActions} 项`
        : activeRun || streamStage ? '思考中' : pendingActions ? `等待你确认 ${pendingActions} 项` : completedNotice
  return text ? <div role="status" className="mx-auto mb-3 flex max-w-3xl items-center gap-2 rounded-lg bg-ink-50 px-3 py-2 text-[12.5px] text-ink-700">{activeRun || streamStage ? <LoaderCircle className="size-3.5 animate-spin" /> : <span className="size-1.5 rounded-full bg-ink-500" />}{text}</div> : null
}
