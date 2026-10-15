import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Bot, ChevronDown, ChevronLeft, Clipboard, FileText, LoaderCircle, Menu,
  MessageSquarePlus, MoreHorizontal, Paperclip, Pencil, Pin, PinOff, Search, Send, Square, Trash2, X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { AIFeedback } from '@/components/refs'
import { confirm, Dialog, Drawer } from '@/components/dialog'
import { Button, IconButton, Input, Notice, Select, Textarea } from '@/components/ui'
import { ApiError, del, errorMessage, get, patch, post, rawRequest, stream } from '@/lib/api'
import { isEnterWithoutComposition } from '@/lib/keyboard'
import { useAccounts, useCurrentAccount } from '@/lib/session'
import { useSavePrefs } from '@/lib/v3'
import { usePageVisible } from '@/lib/visibility'
import {
  type AgentAttachment, type AgentBootstrap, type AgentConversation, type AgentConversationDetail, type AgentConversationListItem,
  type AgentConversationPage, type AgentMessage, useAgentBootstrap,
} from '@/lib/agent'
import { AgentMarkdown } from '@/lib/agent-markdown'
import { AgentActionCards } from '@/pages/agent/ActionCards'

const pageSize = 30

function modelKey(providerID: string | null | undefined, model: string | null | undefined) {
  return providerID && model ? `${providerID}::${model}` : ''
}

function splitDate(value: string) {
  const date = new Date(value)
  const today = new Date()
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.floor((start(today) - start(date)) / 86_400_000)
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  if (days < 7) return '7 天内'
  return '更早'
}

function AgentConversationList({
  currentID, search, setSearch, onSelect, onNew, onClose,
}: {
  currentID?: string; search: string; setSearch: (v: string) => void
  onSelect: (id: string) => void; onNew: () => void; onClose?: () => void
}) {
  const list = useInfiniteQuery({
    queryKey: ['agent-conversations', search],
    queryFn: ({ pageParam }) => get<AgentConversationPage>(`/agent/conversations?limit=${pageSize}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}${search.trim() ? `&q=${encodeURIComponent(search.trim())}` : ''}`),
    initialPageParam: '' as string,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  })
  const sentinel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!sentinel.current || !list.hasNextPage || list.isFetchingNextPage) return
    const node = sentinel.current
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void list.fetchNextPage()
    }, { rootMargin: '200px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [list.hasNextPage, list.isFetchingNextPage, list.fetchNextPage])

  const items = list.data?.pages.flatMap((page) => page.items) ?? []
  const pinned = items.filter((item) => item.pinned_at)
  const rest = items.filter((item) => !item.pinned_at)
  const groups = ['今天', '昨天', '7 天内', '更早'].map((label) => ({ label, items: rest.filter((item) => splitDate(item.last_message_at) === label) }))

  const row = (item: AgentConversationListItem) => (
    <ConversationRow key={item.id} item={item} selected={item.id === currentID} onSelect={() => { onSelect(item.id); onClose?.() }} />
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 p-3">
        <Button variant="primary" className="flex-1" icon={<MessageSquarePlus className="size-4" />} onClick={onNew}>新对话</Button>
        {onClose && <IconButton label="关闭对话列表" onClick={onClose}><X className="size-4" /></IconButton>}
      </div>
      <label className="relative mx-3 mb-3 block">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-mist-400" />
        <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索对话" className="pl-9" aria-label="搜索对话" />
      </label>
      {list.isLoading ? <div className="px-4 py-3 text-sm text-mist-400">正在加载对话…</div> : list.isError ? (
        <div className="px-4 py-3 text-sm text-danger">{errorMessage(list.error)} <button type="button" className="ml-1 underline" onClick={() => void list.refetch()}>重试</button></div>
      ) : (
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {pinned.length > 0 && <ConversationGroup label="置顶" icon={<Pin className="size-3" />}>{pinned.map(row)}</ConversationGroup>}
          {groups.map(({ label, items: grouped }) => grouped.length > 0 && <ConversationGroup key={label} label={label}>{grouped.map(row)}</ConversationGroup>)}
          {!items.length && <div className="px-3 py-8 text-center text-[13px] text-mist-400">{search ? '没有匹配的对话' : '还没有对话'}</div>}
          <div ref={sentinel} className="h-1" />
          {list.isFetchingNextPage && <div className="py-3 text-center text-xs text-mist-400">加载更多…</div>}
        </div>
      )}
    </div>
  )
}

function ConversationGroup({ label, icon, children }: { label: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return <section className="mb-3"><div className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold tracking-wide text-mist-400">{icon}{label}</div><div className="space-y-0.5">{children}</div></section>
}

function ConversationRow({ item, selected, onSelect }: { item: AgentConversationListItem; selected: boolean; onSelect: () => void }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [renameOpen, setRenameOpen] = useState(false)
  const [title, setTitle] = useState(item.title)
  const [menuOpen, setMenuOpen] = useState(false)
  const changePin = async () => {
    await patch(`/agent/conversations/${item.id}`, { pinned: !item.pinned_at })
    await qc.invalidateQueries({ queryKey: ['agent-conversations'] })
  }
  const saveTitle = async () => {
    try {
      await patch(`/agent/conversations/${item.id}`, { title: title.trim() })
      setRenameOpen(false)
      await qc.invalidateQueries({ queryKey: ['agent-conversations'] })
    } catch (error) { toast.error(errorMessage(error)) }
  }
  const remove = async () => {
    if (!(await confirm({ title: '删除这段对话？', desc: '对话、消息和附件会一并删除，无法恢复。', confirmText: '删除', danger: true }))) return
    try {
      await del(`/agent/conversations/${item.id}?confirm=true`)
      await qc.invalidateQueries({ queryKey: ['agent-conversations'] })
      await qc.removeQueries({ queryKey: ['agent-conversation', item.id] })
      if (selected) navigate('/agent')
    } catch (error) { toast.error(errorMessage(error)) }
  }
  const pending = item.pending_actions
  const busy = item.has_active_run
  return (
    <div className={`group flex items-center rounded-lg ${selected ? 'bg-ink-50' : 'hover:bg-mist-100/80'}`}>
      <button type="button" onClick={onSelect} className={`min-w-0 flex-1 cursor-pointer px-2.5 py-2 text-left ${selected ? 'text-ink-800' : 'text-mist-700'}`}>
        <span className="flex items-center gap-1.5">
          {busy && <LoaderCircle className="size-3.5 shrink-0 animate-spin text-ink-500" />}
          <span className="truncate text-[13px] font-medium">{item.title || '新对话'}</span>
          {pending > 0 && <span className="rounded-full bg-gamboge-100 px-1.5 text-[10px] text-gamboge-800">{pending}</span>}
        </span>
        <span className="mt-0.5 block truncate text-[11px] text-mist-400">{item.model || '尚未选择模型'}</span>
      </button>
      <div className="relative mr-1">
        <IconButton label="对话操作" className="size-7 opacity-0 group-hover:opacity-100 focus:opacity-100" onClick={() => setMenuOpen((value) => !value)}><MoreHorizontal className="size-4" /></IconButton>
        {menuOpen && <>
          <button type="button" className="fixed inset-0 z-20 cursor-default" aria-label="关闭菜单" onClick={() => setMenuOpen(false)} />
          <div role="menu" className="absolute right-0 top-8 z-30 min-w-36 rounded-lg border border-mist-200 bg-white p-1 shadow-pop">
            <MenuButton icon={<Pencil />} label="重命名" onClick={() => { setTitle(item.title); setRenameOpen(true); setMenuOpen(false) }} />
            <MenuButton icon={item.pinned_at ? <PinOff /> : <Pin />} label={item.pinned_at ? '取消置顶' : '置顶'} onClick={() => { setMenuOpen(false); void changePin().catch((e) => toast.error(errorMessage(e))) }} />
            <MenuButton icon={<Trash2 />} label="删除" danger onClick={() => { setMenuOpen(false); void remove() }} />
          </div>
        </>}
      </div>
      {renameOpen && <Dialog open onClose={() => setRenameOpen(false)} title="重命名对话" footer={<><Button variant="ghost" onClick={() => setRenameOpen(false)}>取消</Button><Button variant="primary" onClick={() => void saveTitle()} disabled={!title.trim()}>保存</Button></>}>
        <Input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} maxLength={60} onKeyDown={(event) => isEnterWithoutComposition(event.nativeEvent) && void saveTitle()} />
      </Dialog>}
    </div>
  )
}

function MenuButton({ icon, label, onClick, danger }: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return <button type="button" role="menuitem" onClick={onClick} className={`flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] hover:bg-mist-50 ${danger ? 'text-danger' : 'text-mist-600'}`}><span className="[&>svg]:size-3.5">{icon}</span>{label}</button>
}

function MessageView({ message, lastAssistant, canSeeImages, onEdit, onRegenerate }: {
  message: AgentMessage; lastAssistant: boolean; canSeeImages: boolean; onEdit?: () => void; onRegenerate?: () => void
}) {
  const [toolsOpen, setToolsOpen] = useState(false)
  const user = message.role === 'user'
  return (
    <article className={`group flex ${user ? 'justify-end' : 'justify-start'}`}>
      <div className={`min-w-0 max-w-[92%] rounded-2xl px-4 py-3 sm:max-w-[82%] ${user ? 'bg-ink-600 text-white' : message.role === 'system' ? 'border border-gamboge-200 bg-gamboge-50 text-gamboge-900' : 'bg-white shadow-card'}`}>
        {message.attachments?.length > 0 && <div className="mb-2 flex flex-wrap gap-2">
          {message.attachments.map((attachment) => attachment.kind === 'image'
            ? <a key={attachment.id} href={`${attachment.url}?variant=original`} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-lg"><img src={`${attachment.url}?variant=thumb`} alt={attachment.name} className="size-24 object-cover" /></a>
            : <span key={attachment.id} className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs ${user ? 'bg-white/15' : 'bg-mist-100 text-mist-600'}`}><FileText className="size-3.5" />{attachment.name}</span>)}
        </div>}
        {user && !canSeeImages && message.attachments?.some((attachment) => attachment.kind === 'image') && <Notice tone="gamboge" className="mb-2">当前模型不能看图，图片只能用于保存或数据截图识别。</Notice>}
        {user ? <p className="whitespace-pre-wrap break-words text-[14px] leading-relaxed">{message.content}</p>
          : <AgentMarkdown text={message.content} />}
        {message.tool_calls?.length > 0 && <div className={`mt-2 border-t pt-2 ${user ? 'border-white/20' : 'border-mist-100'}`}>
          <button type="button" onClick={() => setToolsOpen((value) => !value)} className={`inline-flex cursor-pointer items-center gap-1 text-[12px] ${user ? 'text-white/75' : 'text-mist-500 hover:text-mist-700'}`}>
            <ChevronDown className={`size-3.5 transition-transform ${toolsOpen ? '' : '-rotate-90'}`} />
            已读取 {message.tool_calls.length} 项
          </button>
          {toolsOpen && <div className={`mt-2 space-y-2 text-xs ${user ? 'text-white/80' : 'text-mist-500'}`}>
            {message.tool_calls.map((call) => <details key={call.id} className="rounded-lg border border-current/10 px-2.5 py-2">
              <summary className="cursor-pointer">{call.summary || call.name}</summary>
              {call.result_preview && <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-sans">{call.result_preview}</pre>}
            </details>)}
          </div>}
        </div>}
        <div className={`mt-1.5 flex items-center gap-1 text-[10.5px] ${user ? 'text-white/60' : 'text-mist-400'}`}>
          <time>{new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
          {user && onEdit && <button type="button" onClick={onEdit} className="ml-2 cursor-pointer opacity-0 underline group-hover:opacity-100 focus:opacity-100">编辑</button>}
          {!user && message.role === 'assistant' && <div className="ml-auto flex items-center gap-1 opacity-70 group-hover:opacity-100">
            <button type="button" title="复制" onClick={() => void navigator.clipboard.writeText(message.content).then(() => toast.success('已复制')).catch(() => toast.error('复制失败'))} className="cursor-pointer rounded p-1 hover:bg-mist-100"><Clipboard className="size-3.5" /></button>
            <AIFeedback callId={message.ai_call_id} />
            {lastAssistant && onRegenerate && <button type="button" title="重新生成" onClick={onRegenerate} className="cursor-pointer rounded p-1 hover:bg-mist-100"><ChevronLeft className="size-3.5" /></button>}
          </div>}
        </div>
      </div>
    </article>
  )
}

function RunStatus({ activeRun, streamStage, pendingActions, error, completedNotice }: { activeRun: AgentConversationDetail['active_run'] | undefined; streamStage: string; pendingActions: number; error: string; completedNotice: string }) {
  if (error) return <div role="alert" className="mx-auto mb-3 max-w-3xl rounded-lg bg-danger/5 px-3 py-2 text-[12.5px] text-danger">{error}</div>
  const text = streamStage === 'queued' || activeRun?.status === 'queued' ? '排队中'
    : streamStage.startsWith('tool:') ? `正在读取：${streamStage.slice(5)}`
      : streamStage === 'waiting_confirmation' ? `等待你确认 ${pendingActions} 项`
        : activeRun || streamStage ? '思考中' : pendingActions ? `等待你确认 ${pendingActions} 项` : completedNotice
  return text ? <div role="status" className="mx-auto mb-3 flex max-w-3xl items-center gap-2 rounded-lg bg-ink-50 px-3 py-2 text-[12.5px] text-ink-700">{activeRun || streamStage ? <LoaderCircle className="size-3.5 animate-spin" /> : <span className="size-1.5 rounded-full bg-ink-500" />}{text}</div> : null
}

export default function Agent() {
  const { conversationId } = useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const bootstrap = useAgentBootstrap()
  const accounts = useAccounts()
  const currentAccount = useCurrentAccount()
  const savePrefs = useSavePrefs()
  const pageVisible = usePageVisible()
  const [search, setSearch] = useState('')
  const [mobileListOpen, setMobileListOpen] = useState(false)
  const [text, setText] = useState('')
  const [files, setFiles] = useState<AgentAttachment[]>([])
  const [uploading, setUploading] = useState(false)
  const [streaming, setStreaming] = useState(false)
  const [streamText, setStreamText] = useState('')
  const [streamStage, setStreamStage] = useState('')
  const [streamError, setStreamError] = useState('')
  const [runID, setRunID] = useState('')
  const [selectedModel, setSelectedModel] = useState('')
  const [selectedAccount, setSelectedAccount] = useState('')
  const [privacyOpen, setPrivacyOpen] = useState(false)
  const [editMessage, setEditMessage] = useState<AgentMessage | null>(null)
  const [olderMessages, setOlderMessages] = useState<AgentMessage[]>([])
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const uploadingRef = useRef(false)
  const uploadGeneration = useRef(0)
  const bottomRef = useRef<HTMLDivElement>(null)
  const dragDepth = useRef(0)
  const [dragging, setDragging] = useState(false)
  const [completedNotice, setCompletedNotice] = useState('')
  const [actionExecuting, setActionExecuting] = useState(false)

  const bootstrapData = bootstrap.data
  const canRead = !!bootstrapData && (bootstrapData.can_use || bootstrapData.reason === 'no_model')
  const canWrite = bootstrapData?.can_use === true
  const detailQuery = useQuery({
    queryKey: ['agent-conversation', conversationId],
    queryFn: () => get<AgentConversationDetail>(`/agent/conversations/${conversationId}`),
    enabled: !!conversationId && canRead,
    refetchInterval: (query) => query.state.data?.active_run && pageVisible ? 2000 : false,
    refetchIntervalInBackground: false,
  })
  const detail = detailQuery.data
  const conversation = detail?.conversation
  const activeRun = detail?.active_run
  const actions = detail?.actions ?? []
  const pendingActions = actions.filter((action) => ['pending', 'needs_input'].includes(action.status)).length
  const baseMessages = detail?.messages ?? []
  const messages = useMemo(() => [...olderMessages, ...baseMessages], [olderMessages, baseMessages])
  const lastUser = [...messages].reverse().find((message) => message.role === 'user')
  const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant')
  const selectedModelOption = bootstrapData?.models.find((model) => modelKey(model.provider_id, model.model) === selectedModel)
  const actionRunIDs = useMemo(() => new Set(actions.map((action) => action.run_id)), [actions])
  const actionMessageByRun = useMemo(() => {
    const latest: Record<string, string> = {}
    for (const message of messages) if (message.role === 'assistant' && message.run_id && actionRunIDs.has(message.run_id)) latest[message.run_id] = message.id
    return latest
  }, [messages, actionRunIDs])
  const busy = streaming || !!activeRun

  useEffect(() => {
    if (!conversation) {
      setSelectedModel((old) => old || modelKey(bootstrapData?.default_model?.provider_id, bootstrapData?.default_model?.model))
      setSelectedAccount((old) => old || currentAccount?.id || '')
      return
    }
    setSelectedModel(modelKey(conversation.model_provider_id, conversation.model))
    setSelectedAccount(conversation.account_id ?? '')
  }, [conversation?.id, conversation?.model_provider_id, conversation?.model, conversation?.account_id, bootstrapData?.default_model?.provider_id, bootstrapData?.default_model?.model, currentAccount?.id])

  useEffect(() => {
    if (!bootstrapData || bootstrap.isLoading || bootstrapData.privacy_notice_seen || savePrefs.isPending) return
    setPrivacyOpen(true)
  }, [bootstrapData?.privacy_notice_seen, bootstrap.isLoading])

  useEffect(() => {
    if (!conversationId) setOlderMessages([])
  }, [conversationId])

  useEffect(() => {
    uploadGeneration.current++
    setText('')
    setFiles([])
    setEditMessage(null)
  }, [conversationId])

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

  const openConversation = (id: string) => navigate(`/agent/c/${id}`)
  const newConversation = () => {
    setText('')
    setFiles([])
    setStreamError('')
    setCompletedNotice('')
    setMobileListOpen(false)
    navigate('/agent')
  }

  const modelRef = selectedModelOption ? { provider_id: selectedModelOption.provider_id, model: selectedModelOption.model } : undefined
  const createConversation = async () => post<AgentConversation>('/agent/conversations', {
    ...(selectedAccount ? { account_id: selectedAccount } : {}), ...(modelRef ? { model: modelRef } : {}),
  })

  const consumeRun = useCallback(async (id: string, endpoint: string, body: Record<string, unknown>) => {
    setStreaming(true)
    setStreamText('')
    setStreamStage('thinking')
    setStreamError('')
    setRunID('')
    try {
      const result = await stream<{ status?: string; reason?: string }>(endpoint, body, {
        onDelta: (delta) => setStreamText((old) => old + delta),
        onEvent: (name, data) => {
          if (name === 'run') setRunID(data.run_id ?? '')
          if (name === 'stage') setStreamStage(data.stage === 'tool' ? `tool:${data.label || data.tool_name || '工具'}` : data.stage || 'thinking')
          if (name === 'action' || name === 'message' || name === 'tool') {
            void qc.invalidateQueries({ queryKey: ['agent-conversation', id] })
            void qc.invalidateQueries({ queryKey: ['agent-conversations'] })
          }
          if (name === 'error') setStreamError(data.message || '运行失败，请重试')
          if (name === 'done') setStreamStage(data.reason === 'waiting_confirmation' ? 'waiting_confirmation' : '')
        },
      })
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['agent-conversation', id] }),
        qc.invalidateQueries({ queryKey: ['agent-conversations'] }),
      ])
      setCompletedNotice(result?.status === 'stopped' ? '已停止'
        : result?.reason === 'round_limit' || result?.reason === 'deadline' ? '已达到单次运行上限'
          : result?.status === 'awaiting_confirmation' ? '等待你逐张确认操作卡片' : '')
    } catch (error) {
      // A closed tab or lost SSE connection does not stop server-side work. The detail poll recovers it.
      await qc.invalidateQueries({ queryKey: ['agent-conversation', id] })
      if (!(error instanceof ApiError) || error.code !== 'internal') setStreamError(errorMessage(error))
    } finally {
      setStreaming(false)
      setRunID('')
      setStreamText('')
      setStreamStage('')
    }
  }, [qc])

  const sendMessage = async (edit?: AgentMessage) => {
  const value = text.trim()
    if ((!value && files.length === 0) || !canWrite || busy || uploading) return
    setStreamError('')
    setCompletedNotice('')
    try {
      let conv = conversation
      if (!conv) {
        conv = await createConversation()
        navigate(`/agent/c/${conv.id}`, { replace: true })
      }
      const payload = {
        text: value,
        attachment_ids: edit ? [] : files.map((file) => file.id),
        ...(selectedAccount ? { account_id: selectedAccount } : { account_id: '' }),
        ...(modelRef ? { model: modelRef } : {}),
      }
      setText('')
      setFiles([])
      setEditMessage(null)
      await consumeRun(conv.id, edit
        ? `/agent/conversations/${conv.id}/messages/${edit.id}/edit`
        : `/agent/conversations/${conv.id}/messages`, payload)
    } catch (error) { toast.error(errorMessage(error)) }
  }

  const continueRun = () => { if (conversationId) void consumeRun(conversationId, `/agent/conversations/${conversationId}/continue`, {}) }
  const regenerate = () => { if (conversationId) void consumeRun(conversationId, `/agent/conversations/${conversationId}/regenerate`, {}) }
  const stop = async () => {
    const id = runID || activeRun?.id
    if (!id) return
    try {
      await post(`/agent/runs/${id}/cancel`, {})
      setStreamStage('已停止')
      await qc.invalidateQueries({ queryKey: ['agent-conversation', conversationId] })
    } catch (error) { toast.error(errorMessage(error)) }
  }

  const updateSelection = async (kind: 'model' | 'account', value: string) => {
    if (kind === 'model') setSelectedModel(value)
    else setSelectedAccount(value)
    if (!conversationId) return
    try {
      const payload = kind === 'model'
        ? { model: value ? { provider_id: value.split('::')[0], model: value.slice(value.indexOf('::') + 2) } : null }
        : { account_id: value }
      await patch(`/agent/conversations/${conversationId}`, payload)
      await qc.invalidateQueries({ queryKey: ['agent-conversation', conversationId] })
      await qc.invalidateQueries({ queryKey: ['agent-conversations'] })
    } catch (error) { toast.error(errorMessage(error)); void detailQuery.refetch() }
  }

  const loadOlder = async () => {
    if (!conversationId || !messages.length || !detail?.has_more) return
    try {
      const page = await get<AgentConversationDetail>(`/agent/conversations/${conversationId}?before_seq=${messages[0].seq}`)
      setOlderMessages((old) => [...page.messages, ...old])
      qc.setQueryData<AgentConversationDetail>(['agent-conversation', conversationId], (current) => current ? { ...current, has_more: page.has_more } : current)
    } catch (error) { toast.error(errorMessage(error)) }
  }

  const addFiles = async (incoming: FileList | File[]) => {
    if (!canWrite || busy || uploadingRef.current) return
    const filesToUpload = Array.from(incoming)
    if (!filesToUpload.length) return
    const maxFiles = bootstrapData?.limits.attachments_per_message ?? 6
    if (files.length + filesToUpload.length > maxFiles) { toast.error(`一条消息最多添加 ${maxFiles} 个附件`); return }
    for (const file of filesToUpload) {
      const image = /^image\/(jpeg|png|webp|gif)$/i.test(file.type)
      const textFile = /\.(txt|md)$/i.test(file.name)
      if (!image && !textFile) { toast.error('仅支持 JPEG、PNG、WebP、GIF 图片和 txt、md 文本'); return }
      const max = image ? (bootstrapData?.limits.image_bytes ?? 20 * 1024 * 1024) : (bootstrapData?.limits.text_bytes ?? 1024 * 1024)
      if (file.size > max) { toast.error(`${file.name} 超过大小限制`); return }
    }
    uploadingRef.current = true
    setUploading(true)
    const generation = uploadGeneration.current
    try {
      const uploaded: AgentAttachment[] = []
      for (const file of filesToUpload) {
        const form = new FormData()
        form.append('file', file)
        if (conversationId) form.append('conversation_id', conversationId)
        const response = await rawRequest('POST', '/agent/attachments', form)
        uploaded.push(await response.json() as AgentAttachment)
        if (generation !== uploadGeneration.current) {
          await Promise.all(uploaded.map((item) => del(`/agent/attachments/${item.id}`).catch(() => undefined)))
          return
        }
      }
      setFiles((old) => [...old, ...uploaded])
    } catch (error) { toast.error(errorMessage(error)) }
    finally { uploadingRef.current = false; setUploading(false) }
  }

  const removeFile = async (file: AgentAttachment) => {
    setFiles((old) => old.filter((item) => item.id !== file.id))
    await del(`/agent/attachments/${file.id}`).catch(() => undefined)
  }

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isEnterWithoutComposition(event.nativeEvent) && !event.shiftKey) {
      event.preventDefault()
      if (editMessage) void sendMessage(editMessage)
      else void sendMessage()
    }
  }

  const inputDisabled = !canWrite || busy || uploading
  const accountList = (accounts.data ?? []).filter((account) => account.status === 'active')

  if (bootstrap.isLoading) return <div className="flex h-full items-center justify-center text-sm text-mist-400"><LoaderCircle className="mr-2 size-4 animate-spin" />正在准备智能体…</div>
  if (bootstrap.isError || !bootstrapData) return <div className="m-auto max-w-xl p-6 text-center"><p className="text-sm text-danger">{errorMessage(bootstrap.error)}</p><Button className="mt-3" onClick={() => void bootstrap.refetch()}>重试</Button></div>
  if (!bootstrapData.can_use && bootstrapData.reason !== 'no_model') return <Unavailable bootstrap={bootstrapData} />

  return (
    <div className="relative flex h-full min-h-0 overflow-hidden bg-[#f7f8f6]">
      <aside className="hidden w-[272px] shrink-0 border-r border-mist-200 bg-white md:flex md:flex-col">
        <AgentConversationList currentID={conversationId} search={search} setSearch={setSearch} onSelect={openConversation} onNew={newConversation} />
      </aside>
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-14 shrink-0 items-center gap-2 border-b border-mist-200 bg-white px-3 sm:px-5">
          <IconButton label="打开对话列表" className="md:hidden" onClick={() => setMobileListOpen(true)}><Menu className="size-4" /></IconButton>
          <div className="min-w-0 flex-1">
            {conversation ? <input key={conversation.id} defaultValue={conversation.title} aria-label="对话标题" maxLength={60}
              onBlur={(event) => {
                const title = event.target.value.trim()
                if (title && title !== conversation.title) void patch(`/agent/conversations/${conversation.id}`, { title }).then(() => invalidate()).catch((error) => toast.error(errorMessage(error)))
              }} className="w-full truncate border-0 bg-transparent text-[14px] font-semibold text-mist-800 outline-none" />
              : <div className="flex items-center gap-2 text-[14px] font-semibold text-mist-800"><Bot className="size-4 text-ink-600" />智能体</div>}
            {conversation && <div className="text-[10.5px] text-mist-400">本对话用量 {detail?.usage.prompt_tokens ?? 0} 输入 / {detail?.usage.completion_tokens ?? 0} 输出 token</div>}
          </div>
          {bootstrapData.models.length > 0 && <Select aria-label="选择模型" value={selectedModel} disabled={!canWrite || !bootstrapData.allow_model_pick || busy} onChange={(event) => void updateSelection('model', event.target.value)} className="max-w-[140px] text-[11px] sm:max-w-[250px] sm:text-xs">
            {!selectedModel && <option value="">选择模型</option>}
            {bootstrapData.default_model_unsupported && <option value="" disabled>默认模型未通过工具调用自检</option>}
            {selectedModel && !bootstrapData.models.some((model) => modelKey(model.provider_id, model.model) === selectedModel) && <option value={selectedModel}>所选模型已不可用</option>}
            {bootstrapData.models.map((model) => <option key={modelKey(model.provider_id, model.model)} value={modelKey(model.provider_id, model.model)}>{model.provider_name} · {model.model}{model.vision ? ' · 看图' : ''}{model.is_default ? ' · 默认' : ''}</option>)}
          </Select>}
          <Select aria-label="选择账号" value={selectedAccount} disabled={!canWrite || busy || accounts.isLoading} onChange={(event) => void updateSelection('account', event.target.value)} className="max-w-[105px] text-[11px] sm:max-w-[180px] sm:text-xs">
            <option value="">不指定账号</option>
            {accountList.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
          </Select>
        </header>

        {bootstrapData.read_only && <div className="border-b border-gamboge-200 bg-gamboge-50 px-4 py-2 text-center text-[12px] text-gamboge-800">当前为观察者：智能体只能查询，不能修改。</div>}
        {bootstrapData.default_model_unsupported && <div className="border-b border-gamboge-200 bg-gamboge-50 px-4 py-2 text-center text-[12px] text-gamboge-800">默认模型未通过工具调用自检，请在模型配置页选择可用于智能体的模型。</div>}

        <div className="relative flex min-h-0 flex-1 flex-col">
          {dragging && <div className="absolute inset-3 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-ink-400 bg-white/90 text-ink-700">松开以上传图片或文本</div>}
          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-3 py-5 sm:px-6" onDragEnter={(event) => { event.preventDefault(); if (canWrite && !busy && !uploading) { dragDepth.current++; setDragging(true) } }} onDragLeave={(event) => { event.preventDefault(); dragDepth.current--; if (dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false) } }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); dragDepth.current = 0; setDragging(false); void addFiles(event.dataTransfer.files) }}>
            {detailQuery.isLoading && conversationId && <div className="mx-auto max-w-3xl py-12 text-center text-sm text-mist-400"><LoaderCircle className="mx-auto mb-2 size-5 animate-spin" />正在加载对话…</div>}
            {detailQuery.isError && <Notice tone="red" className="mx-auto max-w-3xl">{errorMessage(detailQuery.error)} <button type="button" className="ml-2 underline" onClick={() => void detailQuery.refetch()}>重试</button></Notice>}
            {!conversationId && !messages.length && <Welcome onPrompt={(value) => setText(value)} noModel={!bootstrapData.can_use} />}
            {detail?.has_more && <div className="mx-auto mb-4 max-w-3xl text-center"><Button size="sm" variant="ghost" onClick={() => void loadOlder()}>加载更早的消息</Button></div>}
            <div className="mx-auto flex max-w-3xl flex-col gap-4">
              {messages.map((message) => <div key={message.id}>
                <MessageView message={message} lastAssistant={message.id === lastAssistant?.id} canSeeImages={selectedModelOption?.vision === true}
                  onEdit={message.id === lastUser?.id && !busy && canWrite && !message.attachments.length ? () => { setEditMessage(message); setText(message.content); setFiles([]); inputRef.current?.focus() } : undefined}
                  onRegenerate={message.id === lastAssistant?.id && !busy && canWrite ? regenerate : undefined} />
                {message.role === 'assistant' && message.run_id && actionMessageByRun[message.run_id] === message.id && <AgentActionCards
                  actions={actions.filter((action) => action.run_id === message.run_id)}
                  running={busy || actionExecuting}
                  onRefresh={invalidate}
                  onContinue={continueRun}
                  onExecutingChange={setActionExecuting}
                />}
              </div>)}
              {streamText && <div className="flex justify-start"><div className="max-w-[82%] rounded-2xl bg-white px-4 py-3 shadow-card"><AgentMarkdown text={streamText} /></div></div>}
            </div>
            <div ref={bottomRef} />
          </div>

          <div className="shrink-0 border-t border-mist-200 bg-white px-3 pb-[calc(env(safe-area-inset-bottom)+4.5rem)] pt-3 md:pb-4">
            <RunStatus activeRun={activeRun} streamStage={streamStage} pendingActions={pendingActions} error={streamError} completedNotice={completedNotice} />
            {!bootstrapData.can_use && bootstrapData.reason === 'no_model' && <Notice tone="gamboge" className="mx-auto mb-2 max-w-3xl">请到模型配置页选择支持工具调用的模型并完成能力自检。历史对话仍可查看。 <a href="/settings/models" className="underline">去模型配置</a></Notice>}
            {pendingActions > 0 && <div className="mx-auto mb-2 max-w-3xl text-[12px] text-mist-500">等待你逐张处理 {pendingActions} 项后，智能体会继续。卡片操作入口显示在对应消息下方。</div>}
            {detail?.can_continue && !busy && !actionExecuting && pendingActions === 0 && <div className="mx-auto mb-2 max-w-3xl text-right"><Button size="sm" variant="ghost" onClick={continueRun}>继续</Button></div>}
            {activeRun && <div className="mx-auto mb-2 max-w-3xl text-right"><Button size="sm" variant="ghost" icon={<Square className="size-3" />} onClick={() => void stop()}>停止</Button></div>}
            {conversation && !activeRun && detail?.actions.some((action) => action.status === 'executing') && <div className="mx-auto mb-2 max-w-3xl text-[12px] text-mist-500">有操作卡片正在执行，请稍候。</div>}
            {detail?.messages.length === 0 && bootstrapData.default_model_unsupported && <div className="mx-auto mb-2 max-w-3xl text-[12px] text-gamboge-700">默认模型未通过工具调用自检，请先选择其他模型。</div>}
            {editMessage && <div className="mx-auto mb-2 flex max-w-3xl items-center justify-between rounded-lg bg-mist-50 px-3 py-1.5 text-xs text-mist-600"><span>编辑最后一条消息并重新运行</span><button type="button" className="cursor-pointer underline" onClick={() => { setEditMessage(null); setText('') }}>取消</button></div>}
            {files.length > 0 && <div className="mx-auto mb-2 flex max-w-3xl flex-wrap gap-2">
              {files.map((file) => <div key={file.id} className="flex items-center gap-2 rounded-lg border border-mist-200 bg-mist-50 p-1.5 text-xs text-mist-600">
                {file.kind === 'image' ? <img src={`${file.url}?variant=thumb`} alt={file.name} className="size-10 rounded object-cover" /> : <FileText className="ml-1 size-4" />}
                <span className="max-w-40 truncate">{file.name}</span><IconButton label={`移除 ${file.name}`} className="size-6" onClick={() => void removeFile(file)}><X className="size-3" /></IconButton>
              </div>)}
            </div>}
            <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-2xl border border-mist-200 bg-white p-2 shadow-card focus-within:border-ink-300">
              <input ref={fileRef} type="file" multiple accept="image/jpeg,image/png,image/webp,image/gif,.txt,.md" className="hidden" onChange={(event) => { if (event.target.files) void addFiles(event.target.files); event.target.value = '' }} />
              <IconButton label="添加附件" disabled={!canWrite || busy || uploading || files.length >= (bootstrapData.limits.attachments_per_message ?? 6)} onClick={() => fileRef.current?.click()} className="mb-0.5"><Paperclip className="size-4" /></IconButton>
              <Textarea ref={inputRef} rows={1} value={text} disabled={inputDisabled} onChange={(event) => { setText(event.target.value); event.target.style.height = 'auto'; event.target.style.height = `${Math.min(event.target.scrollHeight, 192)}px` }} onKeyDown={onInputKeyDown}
                placeholder={bootstrapData.read_only ? '观察者可以提问，智能体不会修改工作区数据' : !bootstrapData.can_use ? '请先配置支持工具调用的模型' : '发送消息…（Enter 发送，Shift+Enter 换行）'} className="max-h-48 min-h-10 resize-none border-0 bg-transparent px-2 py-2 shadow-none focus:border-transparent focus:ring-0 disabled:bg-transparent" />
              {busy ? <Button variant="ghost" className="mb-0.5 shrink-0" icon={<Square className="size-4" />} onClick={() => void stop()}>停止</Button>
                : <Button variant="primary" className="mb-0.5 shrink-0" icon={<Send className="size-4" />} disabled={!canWrite || (!text.trim() && files.length === 0) || uploading || Array.from(text).length > bootstrapData.limits.message_chars} onClick={() => editMessage ? void sendMessage(editMessage) : void sendMessage()}>{uploading ? '上传中' : '发送'}</Button>}
            </div>
            <div className="mx-auto mt-1 flex max-w-3xl justify-between px-2 text-[10.5px] text-mist-400"><span>{files.length ? `已添加 ${files.length} 个附件` : '附件支持图片、txt 与 md'}</span><span>{Array.from(text).length} / {bootstrapData.limits.message_chars}</span></div>
          </div>
        </div>
      </section>

      <Drawer open={mobileListOpen} onClose={() => setMobileListOpen(false)} title="对话" width="w-[min(88vw,360px)]">
        <AgentConversationList currentID={conversationId} search={search} setSearch={setSearch} onSelect={openConversation} onNew={newConversation} onClose={() => setMobileListOpen(false)} />
      </Drawer>
      <Dialog open={privacyOpen} onClose={() => { setPrivacyOpen(false); savePrefs.mutate({ agent_privacy_notice_seen: true }) }} title="智能体隐私说明" desc="对话仅你本人可见。工作区所有者和系统管理员也无法查看你的对话；卡片执行会照常写入操作日志，并标记为来自智能体。" footer={<Button variant="primary" onClick={() => { setPrivacyOpen(false); savePrefs.mutate({ agent_privacy_notice_seen: true }) }}>我知道了</Button>}>
        <p className="text-[13px] leading-relaxed text-mist-600">不要在对话或附件中发送 API 密钥、平台密钥、密码或邀请码。智能体读取的信息会按系统规则传给当前选择的模型供应商。</p>
      </Dialog>
    </div>
  )
}

function Welcome({ onPrompt, noModel }: { onPrompt: (value: string) => void; noModel: boolean }) {
  const examples = ['这周有哪些作品还没做发布前检查？', '帮我从这段笔记里提炼素材', '给《我的文章》起 5 个标题']
  return <div className="mx-auto flex min-h-[50%] max-w-2xl flex-col items-center justify-center py-12 text-center">
    <div className="flex size-14 items-center justify-center rounded-2xl bg-ink-50 text-ink-600"><Bot className="size-7" /></div>
    <h1 className="mt-4 font-display text-xl font-bold text-mist-900">有什么可以帮你？</h1>
    <p className="mt-2 max-w-lg text-[13px] leading-relaxed text-mist-500">可以读取工作区信息并生成建议。任何写入操作都会先列出单张卡片，由你逐张确认执行。</p>
    {!noModel && <div className="mt-6 flex flex-wrap justify-center gap-2">{examples.map((example) => <button key={example} type="button" onClick={() => onPrompt(example)} className="cursor-pointer rounded-full border border-mist-200 bg-white px-3 py-2 text-[12px] text-mist-600 shadow-card hover:border-ink-300 hover:text-ink-700">{example}</button>)}</div>}
  </div>
}

function Unavailable({ bootstrap }: { bootstrap: AgentBootstrap }) {
  const message = bootstrap.reason === 'admin_override' ? '代访问期间不能使用智能体'
    : bootstrap.reason === 'viewer_disabled' ? '所有者已关闭观察者使用智能体' : '所有者已关闭智能体'
  return <div className="flex h-full items-center justify-center p-6"><div className="max-w-md rounded-2xl border border-mist-200 bg-white p-8 text-center shadow-card"><Bot className="mx-auto size-8 text-mist-300" /><h1 className="mt-3 text-lg font-semibold text-mist-800">{message}</h1><p className="mt-2 text-sm text-mist-500">如需使用，请联系工作区所有者。</p></div></div>
}

