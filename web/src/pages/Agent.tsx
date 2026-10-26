import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Archive, ArchiveRestore, AtSign, Bot, Check, ChevronDown, ChevronLeft, Clipboard, FileText, FolderPlus, LoaderCircle, Menu, RotateCcw,
  MessageSquarePlus, MoreHorizontal, Paperclip, Pencil, Pin, PinOff, Search, Send, Settings2, Sparkles, Square, Trash2, X,
} from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate, useParams } from 'react-router-dom' // AG-01: Added useNavigate for navigation to settings pages
import { toast } from 'sonner'
import { AIFeedback } from '@/components/refs'
import { confirm, Dialog, Drawer } from '@/components/dialog'
import { Button, cn, IconButton, Input, Notice, Select, Textarea } from '@/components/ui'
import { ApiError, del, errorMessage, get, patch, post, rawRequest, stream } from '@/lib/api'
import { isEnterWithoutComposition } from '@/lib/keyboard'
import { useAccounts, useCurrentAccount, useMe } from '@/lib/session'
import { useSavePrefs } from '@/lib/v3'
import { usePageVisible } from '@/lib/visibility'
import {
  type AgentAttachment, type AgentBootstrap, type AgentConversation, type AgentConversationDetail, type AgentConversationListItem,
  type AgentConversationGroup, type AgentConversationPage, type AgentMessage, useAgentBootstrap,
} from '@/lib/agent'
import { AgentMarkdown } from '@/lib/agent-markdown'
import { AgentActionCards } from '@/pages/agent/ActionCards'
import { ArtifactPanel } from '@/pages/agent/ArtifactPanel'
import { browserStore, clearPartial, type PartialStream, readPartial, savePartial } from '@/pages/agent/partial-stream'
import { ContextPickerDialog, SkillPickerDialog, type AgentContextSelection, type AgentSkillSelection } from '@/pages/agent/ContextPickers'

const pageSize = 30

type DraftAttachment = {
  clientID: string
  file: File
  status: 'uploading' | 'ready' | 'failed'
  attachment?: AgentAttachment
  error?: string
}

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

function messageTime(value: string) {
  return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function AgentConversationList({
  currentID, search, setSearch, onSelect, onNew, onClose, sidebarTitle, desktopPresentation = false, organizeEnabled = false,
}: {
  currentID?: string; search: string; setSearch: (v: string) => void
  onSelect: (id: string, matchedSeq?: number) => void; onNew: () => void; onClose?: () => void
  sidebarTitle?: string
  desktopPresentation?: boolean
  organizeEnabled?: boolean
}) {
  const qc = useQueryClient()
  const accounts = useAccounts()
  const [debouncedSearch, setDebouncedSearch] = useState(search)
  const [archived, setArchived] = useState(false)
  const [accountID, setAccountID] = useState('')
  const [groupID, setGroupID] = useState('')
  const [stateFilter, setStateFilter] = useState('')
  const [groupDialog, setGroupDialog] = useState<{ id?: string; name: string } | null>(null)
  const [groupManageOpen, setGroupManageOpen] = useState(false)
  const [groupBusy, setGroupBusy] = useState(false)
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 300)
    return () => window.clearTimeout(timer)
  }, [search])
  const groupQuery = useQuery({
    queryKey: ['agent-conversation-groups'],
    queryFn: () => get<AgentConversationGroup[]>('/agent/conversation-groups'),
    enabled: organizeEnabled,
  })
  const queryParams = new URLSearchParams({ limit: String(pageSize) })
  if (debouncedSearch) queryParams.set('q', debouncedSearch)
  if (organizeEnabled) {
    if (archived) queryParams.set('archived', 'true')
    if (accountID) queryParams.set('account_id', accountID)
    if (groupID) queryParams.set('group_id', groupID)
    if (stateFilter) queryParams.set('state', stateFilter)
  }
  const list = useInfiniteQuery({
    queryKey: ['agent-conversations', debouncedSearch, archived, accountID, groupID, stateFilter, organizeEnabled],
    queryFn: ({ pageParam }) => get<AgentConversationPage>(`/agent/conversations?${queryParams.toString()}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`),
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
  const pinned = archived ? [] : items.filter((item) => item.pinned_at)
  const rest = items.filter((item) => !item.pinned_at)
  const groups = ['今天', '昨天', '7 天内', '更早'].map((label) => ({ label, items: rest.filter((item) => splitDate(item.last_message_at) === label) }))
  const namedGroups = groupQuery.data ?? []
  const groupedRows = organizeEnabled && !groupID
    ? namedGroups.flatMap((group) => {
      const members = rest.filter((item) => item.group_id === group.id)
      return members.length ? [{ label: group.name, groupID: group.id, items: members }] : []
    })
    : []
  const ungrouped = organizeEnabled && !groupID ? rest.filter((item) => !item.group_id) : rest
  const dateGroups = ['今天', '昨天', '7 天内', '更早'].map((label) => ({ label, items: ungrouped.filter((item) => splitDate(item.last_message_at) === label) }))
  const invalidateOrganize = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['agent-conversations'] }),
      qc.invalidateQueries({ queryKey: ['agent-conversation-groups'] }),
    ])
  }
  const saveGroup = async () => {
    if (!groupDialog || !groupDialog.name.trim() || groupBusy) return
    setGroupBusy(true)
    try {
      if (groupDialog.id) await patch(`/agent/conversation-groups/${groupDialog.id}`, { name: groupDialog.name.trim() })
      else await post('/agent/conversation-groups', { name: groupDialog.name.trim() })
      setGroupDialog(null)
      await invalidateOrganize()
    } catch (error) { toast.error(errorMessage(error)) }
    finally { setGroupBusy(false) }
  }
  const removeGroup = async (group: AgentConversationGroup) => {
    if (!(await confirm({ title: `删除分组「${group.name}」？`, desc: '其中的对话会保留，并变为未分组。', confirmText: '删除分组', danger: true }))) return
    try {
      await del(`/agent/conversation-groups/${group.id}`)
      if (groupID === group.id) setGroupID('')
      await invalidateOrganize()
    } catch (error) { toast.error(errorMessage(error)) }
  }

  const row = (item: AgentConversationListItem) => (
    <ConversationRow key={item.id} item={item} groups={namedGroups} organizeEnabled={organizeEnabled} selected={item.id === currentID} desktopPresentation={desktopPresentation} onChanged={invalidateOrganize} onSelect={() => { onSelect(item.id, item.matched_message_seq ?? undefined); onClose?.() }} />
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {sidebarTitle !== undefined && <div className={cn('mb-1.5 min-w-0 px-6 pt-3 text-[11px] font-semibold tracking-[0.16em] text-mist-400', desktopPresentation && 'desktop-agent-list-title')}><div className="truncate" title={sidebarTitle}>{sidebarTitle}</div></div>}
      <div className={cn('flex items-center gap-2', desktopPresentation ? 'desktop-agent-list-new' : sidebarTitle !== undefined ? 'px-3 pb-3 pt-0' : 'p-3')}>
        <Button variant="primary" className="flex-1" icon={<MessageSquarePlus className="size-4" />} onClick={onNew}>新对话</Button>
        {onClose && <IconButton label="关闭对话列表" onClick={onClose}><X className="size-4" /></IconButton>}
      </div>
      <label className={cn('relative mx-3 mb-3 block', desktopPresentation && 'desktop-agent-list-search')}>
        {!desktopPresentation && <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-mist-400" />}
        <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={desktopPresentation ? '搜索最近的对话' : '搜索对话'} className={desktopPresentation ? '' : 'pl-9'} aria-label="搜索对话" />
      </label>
      {organizeEnabled && <div className="mx-3 mb-3 grid grid-cols-2 gap-1.5">
        <Select aria-label="筛选归档状态" value={archived ? 'archived' : 'active'} onChange={(event) => setArchived(event.target.value === 'archived')}>
          <option value="active">当前对话</option><option value="archived">已归档</option>
        </Select>
        <Select aria-label="筛选对话状态" value={stateFilter} onChange={(event) => setStateFilter(event.target.value)}>
          <option value="">全部状态</option><option value="active">进行中</option><option value="needs_action">待我处理</option><option value="unread">未读</option>
        </Select>
        <Select aria-label="按账号筛选" value={accountID} onChange={(event) => setAccountID(event.target.value)}>
          <option value="">全部账号</option>{(accounts.data ?? []).map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
        </Select>
        <Select aria-label="按分组筛选" value={groupID} onChange={(event) => setGroupID(event.target.value)}>
          <option value="">全部分组</option><option value="none">未分组</option>{namedGroups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
        </Select>
        <Button className="col-span-2" variant="ghost" size="sm" icon={<FolderPlus className="size-4" />} disabled={(namedGroups.length >= 20)} onClick={() => setGroupDialog({ name: '' })}>{namedGroups.length >= 20 ? '分组已达 20 个上限' : '新建分组'}</Button>
        <Button className="col-span-2" variant="ghost" size="sm" onClick={() => setGroupManageOpen(true)}>管理分组（{namedGroups.length}）</Button>
      </div>}
      {organizeEnabled && groupQuery.isError && <p role="alert" className="mx-4 mb-2 text-xs text-danger">分组加载失败。<button type="button" className="ml-1 underline" onClick={() => void groupQuery.refetch()}>重试</button></p>}
      {list.isLoading ? <div className="px-4 py-3 text-sm text-mist-400">正在加载对话…</div> : list.isError ? (
        <div className="px-4 py-3 text-sm text-danger">{errorMessage(list.error)} <button type="button" className="ml-1 underline" onClick={() => void list.refetch()}>重试</button></div>
      ) : (
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {pinned.length > 0 && <ConversationGroup label="置顶" icon={<Pin className="size-3" />}>{pinned.map(row)}</ConversationGroup>}
          {groupedRows.map(({ label, groupID: id, items: grouped }) => <ConversationGroup key={id} label={label} actions={<>
            <IconButton label={`重命名分组 ${label}`} className="size-6" onClick={() => setGroupDialog({ id, name: label })}><Pencil className="size-3" /></IconButton>
            <IconButton label={`删除分组 ${label}`} className="size-6" onClick={() => { const group = namedGroups.find((item) => item.id === id); if (group) void removeGroup(group) }}><Trash2 className="size-3" /></IconButton>
          </>}>{grouped.map(row)}</ConversationGroup>)}
          {(organizeEnabled ? dateGroups : groups).map(({ label, items: grouped }) => grouped.length > 0 && <ConversationGroup key={label} label={label}>{grouped.map(row)}</ConversationGroup>)}
          {!items.length && <div className="px-3 py-8 text-center text-[13px] text-mist-400">{search ? '没有匹配的对话' : archived ? '没有已归档的对话' : '还没有对话'}</div>}
          <div ref={sentinel} className="h-1" />
          {list.isFetchingNextPage && <div className="py-3 text-center text-xs text-mist-400">加载更多…</div>}
        </div>
      )}
      {desktopPresentation && <div className="desktop-agent-privacy-note">你的对话仅本人可见。操作卡片执行后，仍保留原操作日志。</div>}
      {groupDialog && <Dialog open onClose={() => setGroupDialog(null)} title={groupDialog.id ? '重命名分组' : '新建私有分组'} footer={<><Button variant="ghost" onClick={() => setGroupDialog(null)}>取消</Button><Button variant="primary" onClick={() => void saveGroup()} disabled={!groupDialog.name.trim() || groupBusy}>保存</Button></>}>
        <Input autoFocus aria-label="分组名称" value={groupDialog.name} maxLength={30} onChange={(event) => setGroupDialog({ ...groupDialog, name: event.target.value })} onKeyDown={(event) => isEnterWithoutComposition(event.nativeEvent) && void saveGroup()} />
      </Dialog>}
      {groupManageOpen && <Dialog open onClose={() => setGroupManageOpen(false)} title="管理私有分组" desc="删除分组只会解除会话归类，不会删除对话。">
        {groupQuery.isLoading ? <p className="py-4 text-sm text-mist-500">正在加载分组…</p> : !namedGroups.length ? <p className="py-4 text-sm text-mist-500">还没有分组。</p> : <ul className="max-h-80 space-y-1 overflow-y-auto">
          {namedGroups.map((group) => <li key={group.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-mist-700">
            <span className="min-w-0 flex-1 truncate">{group.name}</span>
            <IconButton label={`重命名分组 ${group.name}`} onClick={() => { setGroupManageOpen(false); setGroupDialog({ id: group.id, name: group.name }) }}><Pencil className="size-4" /></IconButton>
            <IconButton label={`删除分组 ${group.name}`} onClick={() => { setGroupManageOpen(false); void removeGroup(group) }}><Trash2 className="size-4" /></IconButton>
          </li>)}
        </ul>}
      </Dialog>}
    </div>
  )
}

function ConversationGroup({ label, icon, actions, children }: { label: string; icon?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode }) {
  return <section className="mb-3"><div className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold tracking-wide text-mist-400">{icon}{label}<span className="ml-auto flex items-center">{actions}</span></div><div className="space-y-0.5">{children}</div></section>
}

function ConversationRow({ item, groups, organizeEnabled, selected, onSelect, onChanged, desktopPresentation = false }: {
  item: AgentConversationListItem; groups: AgentConversationGroup[]; organizeEnabled: boolean; selected: boolean
  onSelect: () => void; onChanged: () => Promise<void>; desktopPresentation?: boolean
}) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [renameOpen, setRenameOpen] = useState(false)
  const [title, setTitle] = useState(item.title)
  const [menuOpen, setMenuOpen] = useState(false)
  const [groupOpen, setGroupOpen] = useState(false)
  const [groupID, setGroupID] = useState(item.group_id ?? '')
  const refresh = async () => {
    await onChanged()
    if (selected) await qc.invalidateQueries({ queryKey: ['agent-conversation', item.id] })
  }
  const changePin = async () => {
    await patch(`/agent/conversations/${item.id}`, { expected_revision: item.revision, pinned: !item.pinned_at })
    await refresh()
  }
  const saveTitle = async () => {
    try {
      await patch(`/agent/conversations/${item.id}`, { expected_revision: item.revision, title: title.trim() })
      setRenameOpen(false)
      await refresh()
      if (selected) await qc.invalidateQueries({ queryKey: ['agent-conversation', item.id] })
    } catch (error) { toast.error(errorMessage(error)) }
  }
  const remove = async () => {
    if (!(await confirm({ title: '删除这段对话？', desc: '对话、消息和附件会一并删除；已完成的业务操作不会回滚。', confirmText: '删除', danger: true }))) return
    try {
      await del(`/agent/conversations/${item.id}?confirm=true`)
      await refresh()
      await qc.removeQueries({ queryKey: ['agent-conversation', item.id] })
      if (selected) navigate('/agent')
    } catch (error) { toast.error(errorMessage(error)) }
  }
  const moveToGroup = async () => {
    try {
      await patch(`/agent/conversations/${item.id}`, { expected_revision: item.revision, group_id: groupID || null })
      setGroupOpen(false)
      await refresh()
    } catch (error) { toast.error(errorMessage(error)) }
  }
  const toggleArchive = async () => {
    const restoring = !!item.archived_at
    if (!restoring && item.pending_actions > 0 && !(await confirm({
      title: '归档这段对话？', desc: `仍有 ${item.pending_actions} 张待处理操作卡片。确认后会保留卡片并按原时限过期。`, confirmText: '确认归档', danger: true,
    }))) return
    try {
      await patch(`/agent/conversations/${item.id}`, {
        expected_revision: item.revision, archived: restoring ? false : true,
        ...(!restoring && item.pending_actions > 0 ? { confirm_pending_actions: true } : {}),
      })
      await refresh()
    } catch (error) { toast.error(errorMessage(error)) }
  }
  const markUnread = async () => {
    try {
      await post(`/agent/conversations/${item.id}/read`, { unread: true })
      if (selected) window.dispatchEvent(new CustomEvent('ops:agent-manual-unread', { detail: { id: item.id } }))
      await refresh()
    } catch (error) { toast.error(errorMessage(error)) }
  }
  const pending = item.pending_actions
  const busy = item.has_active_run
  return (
    <div className={`group flex items-center rounded-lg ${selected ? 'bg-ink-50' : 'hover:bg-mist-100/80'}`}>
      <button type="button" onClick={onSelect} className={`min-w-0 flex-1 cursor-pointer px-2.5 py-2 text-left ${selected ? 'text-ink-800' : 'text-mist-700'}`}>
        <span className="flex items-center gap-1.5">
          {busy && <LoaderCircle className="size-3.5 shrink-0 animate-spin text-ink-500" />}
          {item.has_unread && <span aria-label="未读" title="未读" className="size-2 shrink-0 rounded-full bg-ink-500" />}
          <span className="truncate text-[13px] font-medium">{item.title || '新对话'}</span>
          {pending > 0 && <span className="rounded-full bg-gamboge-100 px-1.5 text-[10px] text-gamboge-800">{pending}</span>}
        </span>
        <span className="mt-0.5 block truncate text-[11px] text-mist-400" title={desktopPresentation ? item.model || '尚未选择模型' : undefined}>{item.matched_message_snippet || (item.archived_at ? '已归档' : desktopPresentation ? pending > 0 ? `${pending} 张待确认卡片` : splitDate(item.last_message_at) : item.model || '尚未选择模型')}</span>
      </button>
      <div className="relative mr-1">
        <IconButton label="对话操作" className="size-7 opacity-0 group-hover:opacity-100 focus:opacity-100" onClick={() => setMenuOpen((value) => !value)}><MoreHorizontal className="size-4" /></IconButton>
        {menuOpen && <>
          <button type="button" className="fixed inset-0 z-20 cursor-default" aria-label="关闭菜单" onClick={() => setMenuOpen(false)} />
          <div role="menu" className="absolute right-0 top-8 z-30 min-w-36 rounded-lg border border-mist-200 bg-white p-1 shadow-pop">
            <MenuButton icon={<Pencil />} label="重命名" onClick={() => { setTitle(item.title); setRenameOpen(true); setMenuOpen(false) }} />
            <MenuButton icon={item.pinned_at ? <PinOff /> : <Pin />} label={item.pinned_at ? '取消置顶' : '置顶'} onClick={() => { setMenuOpen(false); void changePin().catch((e) => toast.error(errorMessage(e))) }} />
            {organizeEnabled && <>
              <MenuButton icon={<FolderPlus />} label="移动到分组" onClick={() => { setGroupID(item.group_id ?? ''); setGroupOpen(true); setMenuOpen(false) }} />
              {!item.archived_at && <MenuButton icon={<span aria-hidden="true">•</span>} label="标为未读" onClick={() => { setMenuOpen(false); void markUnread() }} />}
              <MenuButton icon={item.archived_at ? <ArchiveRestore /> : <Archive />} label={item.archived_at ? '恢复归档' : '归档'} onClick={() => { setMenuOpen(false); void toggleArchive() }} />
            </>}
            <MenuButton icon={<Trash2 />} label="删除" danger onClick={() => { setMenuOpen(false); void remove() }} />
          </div>
        </>}
      </div>
      {renameOpen && <Dialog open onClose={() => setRenameOpen(false)} title="重命名对话" footer={<><Button variant="ghost" onClick={() => setRenameOpen(false)}>取消</Button><Button variant="primary" onClick={() => void saveTitle()} disabled={!title.trim()}>保存</Button></>}>
        <Input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} maxLength={60} onKeyDown={(event) => isEnterWithoutComposition(event.nativeEvent) && void saveTitle()} />
      </Dialog>}
      {groupOpen && <Dialog open onClose={() => setGroupOpen(false)} title="移动到分组" footer={<><Button variant="ghost" onClick={() => setGroupOpen(false)}>取消</Button><Button variant="primary" onClick={() => void moveToGroup()}>保存</Button></>}>
        <Select aria-label="选择分组" value={groupID} onChange={(event) => setGroupID(event.target.value)}><option value="">未分组</option>{groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</Select>
      </Dialog>}
    </div>
  )
}

function MenuButton({ icon, label, onClick, danger }: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return <button type="button" role="menuitem" onClick={onClick} className={`flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] hover:bg-mist-50 ${danger ? 'text-danger' : 'text-mist-600'}`}><span className="[&>svg]:size-3.5">{icon}</span>{label}</button>
}

function MessageView({ message, lastAssistant, canSeeImages, onEdit, onRegenerate, skillRequests = [], desktopPresentation = false }: {
  message: AgentMessage; lastAssistant: boolean; canSeeImages: boolean; onEdit?: () => void; onRegenerate?: () => void
  skillRequests?: AgentMessage['skill_requests']; desktopPresentation?: boolean
}) {
  const [toolsOpen, setToolsOpen] = useState(false)
  const toolsId = useId()
  const user = message.role === 'user'
  const time = messageTime(message.created_at)
  return (
    <article className={`group flex ${user ? 'justify-end' : 'justify-start'} ${desktopPresentation ? `desktop-agent-message ${user ? 'user' : 'assistant'}` : ''}`}>
      {desktopPresentation && <div className="desktop-agent-message-speaker">
        {user ? <span className="desktop-agent-user-avatar">林</span> : <span className="desktop-agent-bot-avatar"><Bot /></span>}
        <strong>{user ? '你' : 'OPS'}</strong>
        <small>{user ? time : message.tool_calls?.length ? '已完成参考资料读取' : time}</small>
      </div>}
      <div className={`min-w-0 max-w-[92%] rounded-2xl px-4 py-3 sm:max-w-[82%] ${desktopPresentation ? 'desktop-agent-message-bubble' : ''} ${user ? 'bg-ink-600 text-white' : message.role === 'system' ? 'border border-gamboge-200 bg-gamboge-50 text-gamboge-900' : 'bg-white shadow-card'}`}>
        {message.attachments?.length > 0 && <div className="mb-2 flex flex-wrap gap-2">
          {message.attachments.map((attachment) => attachment.kind === 'image'
            ? <a key={attachment.id} href={`${attachment.url}?variant=original`} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-lg"><img src={`${attachment.url}?variant=thumb`} alt={attachment.name} className="size-24 object-cover" /></a>
            : <span key={attachment.id} className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs ${user ? 'bg-white/15' : 'bg-mist-100 text-mist-600'}`}><FileText className="size-3.5" />{attachment.name}</span>)}
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
            {desktopPresentation ? <Check className="size-3.5" /> : <ChevronDown className={`size-3.5 transition-transform ${toolsOpen ? '' : '-rotate-90'}`} />}
            已读取 {message.tool_calls.length} 项
          </button>
          <div id={toolsId} aria-hidden={!toolsOpen} className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out ${toolsOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
            <div className="min-h-0 overflow-hidden">
              <div className={`mt-2 space-y-2 text-xs ${user ? 'text-white/80' : 'text-mist-500'}`}>
                {message.tool_calls.map((call) => <details key={call.id} className="rounded-lg border border-current/10 px-2.5 py-2">
                  <summary tabIndex={toolsOpen ? undefined : -1} className="cursor-pointer">{call.summary || call.name}</summary>
                  {call.result_preview && <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-sans">{call.result_preview}</pre>}
                </details>)}
              </div>
            </div>
          </div>
        </div>}
        <div className={`mt-1.5 flex items-center gap-1 text-[10.5px] ${desktopPresentation ? 'desktop-agent-message-footer' : ''} ${user ? 'text-white/60' : 'text-mist-400'}`}>
          <time>{time}</time>
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

function WorkbenchSidePanel({
  tab, setTab, close, conversation, activeRun, busy, pendingActions, actionCount, selectedAccountName, selectedModelName, attachmentCount,
  contextRefs, skillRequests, latestSkillUsage, artifactsEnabled, actions,
}: {
  tab: 'task' | 'context' | 'artifact'; setTab: (tab: 'task' | 'context' | 'artifact') => void; close: () => void
  conversation?: AgentConversation; activeRun?: AgentConversationDetail['active_run']; busy: boolean; pendingActions: number; actionCount: number
  selectedAccountName: string; selectedModelName: string; attachmentCount: number
  contextRefs: AgentContextSelection[]; skillRequests: AgentSkillSelection[]; latestSkillUsage: AgentMessage['skill_usage']; artifactsEnabled: boolean; actions: AgentConversationDetail['actions']
}) {
  const tabs = [
    { id: 'task' as const, label: '任务' },
    { id: 'context' as const, label: '上下文' },
    ...(artifactsEnabled ? [{ id: 'artifact' as const, label: '产物' }] : []),
  ]
  const taskStatus = busy ? '正在运行' : pendingActions ? `等待你逐张处理 ${pendingActions} 项` : conversation ? '当前没有运行中的任务' : '发送第一条消息后，这里会显示对话任务状态'
  return <aside className="desktop-agent-side-panel" data-testid="desktop-agent-side-panel" aria-label="辅助面板">
    <header className="desktop-agent-side-panel-heading">
      <div><h2>辅助面板</h2><IconButton label="关闭任务面板" onClick={close}><X className="size-4" /></IconButton></div>
      <div role="tablist" aria-label="辅助面板视图" className="desktop-agent-side-tabs">
        {tabs.map((item) => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} onClick={() => setTab(item.id)}>{item.label}</button>)}
      </div>
    </header>
    <div role="tabpanel" className="desktop-agent-side-content">
      {tab === 'task' && <section aria-labelledby="workbench-task-heading">
        <h3 id="workbench-task-heading">当前任务</h3>
        <p className="desktop-agent-side-status" role="status">{busy && <LoaderCircle className="size-4 animate-spin" />}{taskStatus}</p>
        {activeRun && <p className="desktop-agent-side-detail">运行状态：{activeRun.status === 'queued' ? '排队中' : '执行中'}</p>}
        {conversation && <p className="desktop-agent-side-detail">本对话操作卡片：{actionCount} 项</p>}
        {pendingActions > 0 && <p className="desktop-agent-side-note">请在对应消息下逐张审阅操作卡片。</p>}
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
      {tab === 'artifact' && <section aria-labelledby="workbench-artifact-heading"><h3 id="workbench-artifact-heading">产物</h3><ArtifactPanel conversationID={conversation?.id} updatedAt={conversation?.updated_at} compact /></section>}
    </div>
  </aside>
}

export default function Agent() {
  const { conversationId } = useParams()
  const desktopPresentation = document.documentElement.dataset.presentation === 'ops-creative-desktop'
  const navigate = useNavigate()
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
  const [workbenchPanelTab, setWorkbenchPanelTab] = useState<'task' | 'context' | 'artifact'>('task')
  const [artifactsOpen, setArtifactsOpen] = useState(false)
  const [workbenchLayoutLoadedKey, setWorkbenchLayoutLoadedKey] = useState('')
  const [text, setText] = useState('')
  const [files, setFiles] = useState<DraftAttachment[]>([])
  const [contextRefs, setContextRefs] = useState<AgentContextSelection[]>([])
  const [skillRequests, setSkillRequests] = useState<AgentSkillSelection[]>([])
  const [contextPickerOpen, setContextPickerOpen] = useState(false)
  const [skillPickerOpen, setSkillPickerOpen] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [streaming, setStreaming] = useState(false)
  const [streamText, setStreamText] = useState('')
  const [streamStage, setStreamStage] = useState('')
  const [streamError, setStreamError] = useState('')
  const [runID, setRunID] = useState('')
  const [selectedModel, setSelectedModel] = useState('')
  const [selectedAccount, setSelectedAccount] = useState('')
  // AG-03：对话创建时绑定的账号。切换后历史仍属于原账号，必须明确提示，不能默默换上下文。
  const [historyAccount, setHistoryAccount] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
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
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const localSearchInputRef = useRef<HTMLInputElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const uploadingRef = useRef(false)
  const uploadGeneration = useRef(0)
  const cancelledUploads = useRef(new Set<string>())
  const messageRequest = useRef<{ key: string; id: string } | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const dragDepth = useRef(0)
  const [dragging, setDragging] = useState(false)
  const [completedNotice, setCompletedNotice] = useState('')
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
  const workbenchUI = desktopPresentation && bootstrapData?.features?.workbench_ui === true
  const organizeEnabled = bootstrapData?.features?.conversation_organize === true
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
  const readyFiles = files.filter((file) => file.status === 'ready' && file.attachment)
  const failedFiles = files.filter((file) => file.status === 'failed')

  useEffect(() => {
    if (!workbenchUI || !layoutPreferenceKey) return
    setWorkbenchLayoutLoadedKey('')
    try {
      const saved = JSON.parse(window.localStorage.getItem(layoutPreferenceKey) || '{}') as { listCollapsed?: boolean; panelOpen?: boolean }
      setWorkbenchListCollapsed(saved.listCollapsed === true)
      setWorkbenchPanelOpen(saved.panelOpen === true)
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
        window.setTimeout(() => document.querySelector<HTMLInputElement>('[data-testid="desktop-agent-list"] [aria-label="搜索对话"]')?.focus(), 0)
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
    window.localStorage.setItem(layoutPreferenceKey, JSON.stringify({ listCollapsed: workbenchListCollapsed, panelOpen: workbenchPanelOpen }))
  }, [workbenchUI, layoutPreferenceKey, workbenchLayoutLoadedKey, workbenchListCollapsed, workbenchPanelOpen])

  useEffect(() => {
    if (!conversation) {
      setSelectedModel((old) => old || modelKey(bootstrapData?.default_model?.provider_id, bootstrapData?.default_model?.model))
      setSelectedAccount((old) => old || currentAccount?.id || '')
      return
    }
    setSelectedModel(modelKey(conversation.model_provider_id, conversation.model))
    setSelectedAccount(conversation.account_id ?? '')
    setHistoryAccount(conversation.account_id ?? '')
  }, [conversation?.id, conversation?.model_provider_id, conversation?.model, conversation?.account_id, bootstrapData?.default_model?.provider_id, bootstrapData?.default_model?.model, currentAccount?.id])

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
      if (item.attachment) void del(`/agent/attachments/${item.attachment.id}`).catch(() => undefined)
      else cancelledUploads.current.add(item.clientID)
    }
    setFiles([])
    setContextRefs([])
    setSkillRequests([])
    setEditMessage(null)
  }, [conversationId, files])

  // AG-04：进入对话时先看本地有没有中断前的草稿；服务端整轮结束才落库，
  // 没有这份草稿，用户切回来只能看到空白等整轮跑完。
  useEffect(() => {
    if (partialStore.current === null) partialStore.current = browserStore()
    if (!conversationId) { setRecovered(null); return }
    setRecovered(readPartial(partialStore.current, conversationId))
  }, [conversationId])

  // AG-04：把正在生成的片段写进 sessionStorage；节流到 1 秒，避免每个 delta 都序列化。
  useEffect(() => {
    if (!conversationId || !streamText) return
    const now = Date.now()
    if (now - partialSavedAt.current < 1000) return
    partialSavedAt.current = now
    savePartial(partialStore.current, { conversationId, runId: runID, text: streamText, stage: streamStage, updatedAt: now })
  }, [conversationId, streamText, streamStage, runID])

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
  const newConversation = () => {
    setText('')
    clearDraftAttachments()
    setContextRefs([])
    setSkillRequests([])
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
    if ((!value && readyFiles.length === 0 && contextRefs.length === 0 && skillRequests.length === 0) || !canWrite || busy || uploading || failedFiles.length > 0) return
    setStreamError('')
    setCompletedNotice('')
    try {
      let conv = conversation
      if (!conv) {
        conv = await createConversation()
        sendDestinationConversationID.current = conv.id
        navigate(`/agent/c/${conv.id}`, { replace: true })
      }
      const messageKey = JSON.stringify({
        conversation_id: conv.id, text: value, attachment_ids: edit ? [] : readyFiles.map((file) => file.attachment!.id),
        context_refs: !edit ? contextRefs.map(({ type, id, revision, reference_scope }) => ({ type, id, revision, scope: reference_scope })) : [],
        skill_requests: !edit ? skillRequests.map(({ skill_id, work_id }) => ({ skill_id, ...(work_id ? { work_id } : {}) })) : [],
        account_id: selectedAccount || '', model: modelRef || null,
      })
      const requestID = edit ? undefined : messageRequest.current?.key === messageKey
        ? messageRequest.current.id
        : crypto.randomUUID()
      if (requestID) messageRequest.current = { key: messageKey, id: requestID }
      const payload = {
        text: value,
        attachment_ids: edit ? [] : readyFiles.map((file) => file.attachment!.id),
        ...(!edit && contextRefs.length ? { context_refs: contextRefs.map(({ type, id, revision, reference_scope }) => ({ type, id, revision, scope: reference_scope })) } : {}),
        ...(!edit && skillRequests.length ? { skill_requests: skillRequests.map(({ skill_id, work_id }) => ({ skill_id, ...(work_id ? { work_id } : {}) })) } : {}),
        ...(selectedAccount ? { account_id: selectedAccount } : { account_id: '' }),
        ...(modelRef ? { model: modelRef } : {}),
        ...(requestID ? { request_id: requestID } : {}),
      }
      await consumeRun(conv.id, edit
        ? `/agent/conversations/${conv.id}/messages/${edit.id}/edit`
        : `/agent/conversations/${conv.id}/messages`, payload)
      setText('')
      setFiles([])
      sendDestinationConversationID.current = ''
      messageRequest.current = null
      if (!edit) {
        setContextRefs([])
        setSkillRequests([])
      }
      setEditMessage(null)
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
    const readSeq = conversation.read_upto_message_seq ?? 0
    const latestSeq = messages[messages.length - 1].seq
    const hasUnread = conversation.force_unread || messages.some((message) => message.seq > readSeq && message.role !== 'user')
    if (!hasUnread || latestSeq <= readSeq && !conversation.force_unread || !bottomRef.current) return
    const node = bottomRef.current
    let timer = 0
    const observer = new IntersectionObserver((entries) => {
      window.clearTimeout(timer)
      if (entries.some((entry) => entry.isIntersecting) && document.visibilityState === 'visible') {
        timer = window.setTimeout(() => {
          if (conversationIDRef.current !== conversationId || document.visibilityState !== 'visible') return
          void post<{ read_upto_message_seq: number; force_unread: boolean; revision: number }>(`/agent/conversations/${conversationId}/read`, { upto_message_seq: latestSeq })
            .then((result) => {
              qc.setQueryData<AgentConversationDetail>(['agent-conversation', conversationId], (current) => current ? {
                ...current,
                conversation: { ...current.conversation, read_upto_message_seq: result.read_upto_message_seq, force_unread: result.force_unread, revision: result.revision },
              } : current)
              return qc.invalidateQueries({ queryKey: ['agent-conversations'] })
            })
            .catch((error) => toast.error(errorMessage(error)))
        }, 1000)
      }
    }, { threshold: 1 })
    observer.observe(node)
    return () => { window.clearTimeout(timer); observer.disconnect() }
  }, [organizeEnabled, conversationId, conversation, messages, pageVisible, qc, manualUnreadSuppressedID])

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
    if (!canWrite || busy || uploadingRef.current) return
    const filesToAdd = Array.from(incoming)
    if (!filesToAdd.length) return
    const maxFiles = bootstrapData?.limits.attachments_per_message ?? 6
    const available = Math.max(0, maxFiles - files.length)
    if (filesToAdd.length > available) toast.error(`一条消息最多添加 ${maxFiles} 个附件`)
    const filesToAccept = filesToAdd.slice(0, available)
    const queue = filesToAccept.map((file): DraftAttachment => {
      const image = /^image\/(jpeg|png|webp|gif)$/i.test(file.type)
      const textFile = /\.(txt|md)$/i.test(file.name)
      const max = image ? (bootstrapData?.limits.image_bytes ?? 20 * 1024 * 1024) : (bootstrapData?.limits.text_bytes ?? 1024 * 1024)
      const error = !image && !textFile ? '仅支持 JPEG、PNG、WebP、GIF 图片和 txt、md 文本' : file.size > max ? '文件超过大小限制' : undefined
      return { clientID: crypto.randomUUID(), file, status: error ? 'failed' : 'uploading', error }
    })
    setFiles((old) => [...old, ...queue])
    for (const item of queue) if (item.status === 'uploading') await uploadFile(item)
  }

  const uploadFile = async (item: DraftAttachment) => {
    if (uploadingRef.current) return
    const generation = uploadGeneration.current
    uploadingRef.current = true
    setUploading(true)
    setFiles((old) => old.map((file) => file.clientID === item.clientID ? { ...file, status: 'uploading', error: undefined } : file))
    try {
      const form = new FormData()
      form.append('file', item.file)
      if (conversationId) form.append('conversation_id', conversationId)
      const response = await rawRequest('POST', '/agent/attachments', form)
      const attachment = await response.json() as AgentAttachment
      if (generation !== uploadGeneration.current || cancelledUploads.current.delete(item.clientID)) {
        await del(`/agent/attachments/${attachment.id}`).catch(() => undefined)
        return
      }
      setFiles((old) => old.map((file) => file.clientID === item.clientID ? { ...file, status: 'ready', attachment } : file))
    } catch (error) {
      if (generation === uploadGeneration.current && !cancelledUploads.current.delete(item.clientID)) {
        setFiles((old) => old.map((file) => file.clientID === item.clientID ? { ...file, status: 'failed', error: errorMessage(error) } : file))
      }
    } finally {
      uploadingRef.current = false
      setUploading(false)
    }
  }

  const retryFile = (item: DraftAttachment) => { void uploadFile(item) }

  const clearDraftAttachments = () => {
    for (const item of files) {
      if (item.status === 'uploading') cancelledUploads.current.add(item.clientID)
      if (item.attachment) void del(`/agent/attachments/${item.attachment.id}`).catch(() => undefined)
    }
    setFiles([])
  }

  const removeFile = async (item: DraftAttachment) => {
    if (item.status === 'uploading') cancelledUploads.current.add(item.clientID)
    setFiles((old) => old.filter((file) => file.clientID !== item.clientID))
    if (item.attachment) await del(`/agent/attachments/${item.attachment.id}`).catch(() => undefined)
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
  const selectedAccountName = accountList.find((account) => account.id === selectedAccount)?.name || '不指定账号'
  const selectedModelName = selectedModelOption?.model || '选择模型'
  // AG-03：选了别的账号而历史仍属于原账号时，界面必须说清楚，否则用户以为上下文也跟着换了。
  const accountSwitched = !!conversationId && !!historyAccount && selectedAccount !== historyAccount
  const historyAccountName = accountList.find((account) => account.id === historyAccount)?.name || '原账号'
  const attachmentCount = messages.reduce((total, message) => total + message.attachments.length, 0)
  const workbenchStatus = busy ? '运行中' : pendingActions ? `待处理 ${pendingActions}` : conversation ? '已就绪' : '待开始'
  const canSendContent = !!text.trim() || readyFiles.length > 0 || contextRefs.length > 0 || skillRequests.length > 0
  const selectedWorkOptions = contextRefs.filter((ref) => ref.type === 'work').map((ref) => ({ id: ref.id, name: ref.name }))
  const latestSkillUsage = lastAssistant && lastUser && lastAssistant.run_id === lastUser.run_id
    ? (lastUser.skill_requests ?? []).map((request) => lastAssistant.skill_usage?.find((skill) => skill.id === request.skill_id)
      ?? { id: request.skill_id, name: request.name || request.skill_id.slice(0, 8), scope: '', loaded: false })
    : []

  if (bootstrap.isLoading) return <div className="flex h-full items-center justify-center text-sm text-mist-400"><LoaderCircle className="mr-2 size-4 animate-spin" />正在准备智能体…</div>
  if (bootstrap.isError || !bootstrapData) return <div className="m-auto max-w-xl p-6 text-center"><p className="text-sm text-danger">{errorMessage(bootstrap.error)}</p><Button className="mt-3" onClick={() => void bootstrap.refetch()}>重试</Button></div>
  // AG-01: Navigate for unavailability page
  if (!bootstrapData.can_use && bootstrapData.reason !== 'no_model' && bootstrapData.reason !== 'not_tested') return <Unavailable bootstrap={bootstrapData} navigate={navigate} />

  const sidebarSlot = document.getElementById('agent-sidebar-slot')
  const titleSlot = document.getElementById('agent-title-slot')
  const toolbarSlot = document.getElementById('agent-toolbar-slot')
  const renderConversationTitle = () => (
    <>
      {conversation
        ? <input key={`${conversation.id}:${conversation.title}`} defaultValue={conversation.title} aria-label="对话标题" maxLength={60}
            style={{ width: `${Math.min(440, Math.max(42, Array.from(conversation.title).length * 12))}px` }}
            onBlur={(event) => {
              const title = event.target.value.trim()
              if (title && title !== conversation.title) void patch(`/agent/conversations/${conversation.id}`, { expected_revision: conversation.revision, title }).then(() => invalidate()).catch((error) => toast.error(errorMessage(error)))
            }} className="min-w-0 max-w-[320px] truncate border-0 bg-transparent text-[13px] font-semibold text-mist-800 outline-none" />
        : <span className="text-[13px] font-semibold text-mist-800">AI 对话</span>}
      {conversation && !desktopPresentation && <span className="hidden text-[10.5px] text-mist-400 xl:inline">本对话 {detail?.usage.prompt_tokens ?? 0} 输入 / {detail?.usage.completion_tokens ?? 0} 输出 token</span>}
    </>
  )
  const renderTitle = () => desktopPresentation
    ? <span className="text-[13px] font-semibold text-mist-800">AI 对话</span>
    : renderConversationTitle()
  return (
    <>
      {sidebarSlot && !desktopPresentation && createPortal(
        <div className="absolute inset-0 flex min-h-0 flex-col">
          <AgentConversationList currentID={conversationId} search={search} setSearch={setSearch} onSelect={openConversation} onNew={newConversation} sidebarTitle={conversation?.title || '对话'} organizeEnabled={organizeEnabled} />
        </div>,
        sidebarSlot,
      )}
      {titleSlot && createPortal(<div className="flex min-w-0 items-center gap-2">{renderTitle()}</div>, titleSlot)}
      {toolbarSlot && !desktopPresentation && createPortal(
        <>
          {bootstrapData.features.artifacts === true && conversation && <IconButton label="查看产物" onClick={() => setArtifactsOpen(true)}><FileText className="size-4" /></IconButton>}
          <IconButton label="对话设置" onClick={() => setSettingsOpen(true)}><Settings2 className="size-4" /></IconButton>
        </>,
        toolbarSlot,
      )}
      <div className={`relative flex h-full min-h-0 overflow-hidden bg-[#f7f8f6] ${desktopPresentation ? 'desktop-agent-workspace' : ''} ${workbenchUI ? 'desktop-agent-workbench' : ''}`} data-list-collapsed={workbenchListCollapsed} data-panel-open={workbenchPanelOpen}>
      {desktopPresentation && <aside className="desktop-agent-list" aria-label="AI 对话列表" data-testid="desktop-agent-list">
        <AgentConversationList currentID={conversationId} search={search} setSearch={setSearch} onSelect={openConversation} onNew={newConversation} sidebarTitle="AI 对话" desktopPresentation organizeEnabled={organizeEnabled} />
      </aside>}
      <section className={`flex min-w-0 flex-1 flex-col ${workbenchUI ? 'desktop-agent-workbench-main' : ''}`}>
        <header className={`flex min-h-14 shrink-0 items-center gap-2 border-b border-mist-200 bg-white px-3 sm:px-5 ${desktopPresentation ? 'desktop-agent-chat-header' : 'lg:hidden'}`}>
          <IconButton label={workbenchUI && !workbenchListCollapsed && (document.querySelector('.desktop-agent-workbench')?.clientWidth ?? 0) >= 1320 ? '收起会话列表' : '打开对话列表'} className={`md:hidden ${workbenchUI ? 'desktop-agent-workbench-list-button' : ''}`} onClick={() => {
            if (workbenchUI && (document.querySelector('.desktop-agent-workbench')?.clientWidth ?? 0) >= 1320) setWorkbenchListCollapsed((value) => !value)
            else { setWorkbenchPanelOpen(false); setMobileListOpen(true) }
          }}><Menu className="size-4" /></IconButton>
          <div className={`flex min-w-0 items-center gap-2 ${desktopPresentation ? 'desktop-agent-chat-heading' : 'flex-1'}`}>
            {desktopPresentation ? <>{renderConversationTitle()}<span className="desktop-agent-private-tag">仅本人可见</span>{workbenchUI && <span className="desktop-agent-workbench-meta">{selectedAccountName} · {workbenchStatus}</span>}</> : renderTitle()}
          </div>
          {desktopPresentation
            ? workbenchUI
              ? <button type="button" className="desktop-agent-chat-settings desktop-agent-workbench-panel-button" aria-label="任务面板" aria-expanded={workbenchPanelOpen} onClick={() => { setMobileListOpen(false); setWorkbenchPanelOpen((value) => !value) }}>任务面板 <Settings2 /></button>
              : <button type="button" className="desktop-agent-chat-settings" aria-label="对话设置" onClick={() => setSettingsOpen(true)}>对话设置 <Settings2 /></button>
            : <IconButton label="对话设置" onClick={() => setSettingsOpen(true)}><Settings2 className="size-4" /></IconButton>}
        </header>

        {bootstrapData.read_only && <div className="border-b border-gamboge-200 bg-gamboge-50 px-4 py-2 text-center text-[12px] text-gamboge-800">当前为观察者：智能体只能查询，不能修改。</div>}

        <div className="relative flex min-h-0 flex-1 flex-col">
          {dragging && <div className="absolute inset-3 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-ink-400 bg-white/90 text-ink-700">松开以上传图片或文本</div>}
          <div className={`scrollbar-thin min-h-0 flex-1 overflow-y-auto px-3 py-5 sm:px-6 ${desktopPresentation ? 'desktop-agent-chat-stream' : ''}`} onWheel={() => { manualScrollRef.current = true }} onTouchStart={() => { manualScrollRef.current = true }} onPointerDown={() => { manualScrollRef.current = true }} onKeyDown={(event) => { if (['End', 'PageDown', 'ArrowDown'].includes(event.key)) manualScrollRef.current = true }} onScroll={(event) => {
            if (!manualScrollRef.current || manualUnreadSuppressedID !== conversationId) return
            const node = event.currentTarget
            if (node.scrollHeight - node.scrollTop - node.clientHeight <= 8) {
              manualScrollRef.current = false
              setManualUnreadSuppressedID('')
            }
          }} onDragEnter={(event) => { event.preventDefault(); if (canWrite && !busy && !uploading) { dragDepth.current++; setDragging(true) } }} onDragLeave={(event) => { event.preventDefault(); dragDepth.current--; if (dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false) } }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); dragDepth.current = 0; setDragging(false); void addFiles(event.dataTransfer.files) }}>
            {detailQuery.isLoading && conversationId && <div className="mx-auto max-w-3xl py-12 text-center text-sm text-mist-400"><LoaderCircle className="mx-auto mb-2 size-5 animate-spin" />正在加载对话…</div>}
            {detailQuery.isError && <Notice tone="red" className="mx-auto max-w-3xl">{errorMessage(detailQuery.error)} <button type="button" className="ml-2 underline" onClick={() => void detailQuery.refetch()}>重试</button></Notice>}
            {!conversationId && !messages.length && <Welcome onPrompt={(value) => setText(value)} noModel={!bootstrapData.can_use} desktopWorkbench={workbenchUI} />}
            {detail?.has_more && <div className="mx-auto mb-4 max-w-3xl text-center"><Button size="sm" variant="ghost" onClick={() => void loadOlder()}>加载更早的消息</Button></div>}
            <div className={`mx-auto flex max-w-3xl flex-col gap-4 ${desktopPresentation ? 'desktop-agent-message-column' : ''}`}>
              {messages.map((message, index) => {
                const previous = messages[index - 1]
                const startsDay = desktopPresentation && (!previous || splitDate(previous.created_at) !== splitDate(message.created_at))
                return <div key={message.id} data-message-seq={message.seq}>
                {startsDay && <div className="desktop-agent-day">{splitDate(message.created_at)} · {messageTime(message.created_at)}</div>}
                <MessageView message={message} lastAssistant={message.id === lastAssistant?.id} canSeeImages={selectedModelOption?.vision === true} desktopPresentation={desktopPresentation}
                  skillRequests={messages.find((candidate) => candidate.role === 'user' && candidate.run_id === message.run_id)?.skill_requests ?? []}
                  onEdit={message.id === lastUser?.id && !busy && canWrite && !message.attachments.length && !message.context_refs?.length && !message.skill_requests?.length ? () => { setEditMessage(message); setText(message.content); clearDraftAttachments(); setContextRefs([]); setSkillRequests([]); inputRef.current?.focus() } : undefined}
                  onRegenerate={message.id === lastAssistant?.id && !busy && canWrite ? regenerate : undefined} />
                {message.role === 'assistant' && message.run_id && actionMessageByRun[message.run_id] === message.id && <div className={desktopPresentation ? 'desktop-agent-action-wrapper' : ''}><AgentActionCards
                  actions={actions.filter((action) => action.run_id === message.run_id)}
                  running={busy || actionExecuting}
                  onRefresh={invalidate}
                  onContinue={continueRun}
                  onExecutingChange={setActionExecuting}
                  desktopPresentation={desktopPresentation}
                /></div>}
              </div>})}
              {streamText && <div className="flex justify-start"><div className="max-w-[82%] rounded-2xl bg-white px-4 py-3 shadow-card"><AgentMarkdown text={streamText} /></div></div>}
              {/* AG-04：离开页面时没写完的回复。服务端整轮结束后才落库，这里先把已生成的部分显示出来，
                  并说明「服务端仍在继续」，避免用户以为内容丢了而重新发一遍。 */}
              {!streamText && recovered && <div className="flex justify-start"><div className="max-w-[82%] rounded-2xl bg-white px-4 py-3 shadow-card">
                <AgentMarkdown text={recovered.text} />
                <div className="mt-2 border-t border-mist-200 pt-2 text-[12px] text-mist-500" data-testid="agent-partial-note">
                  {busy || activeRun
                    ? '这是上次离开页面时已生成的部分，服务端仍在继续，完成后会补全这条回复。'
                    : '这是上次中断时已生成的部分。这一轮没有正常结束，可以点下方「继续」让智能体接着做。'}
                </div>
              </div></div>}
            </div>
            <div ref={bottomRef} className="h-px" />
          </div>

          <div className={`shrink-0 border-t border-mist-200 bg-white px-3 pb-[calc(env(safe-area-inset-bottom)+4.5rem)] pt-3 md:pb-4 ${desktopPresentation ? 'desktop-agent-compose-area' : ''} ${workbenchUI ? 'desktop-agent-workbench-compose-area' : ''}`}>
            {(!desktopPresentation || workbenchUI || !!streamError) && <RunStatus activeRun={activeRun} streamStage={streamStage} pendingActions={pendingActions} error={streamError} completedNotice={completedNotice} />}
            {!bootstrapData.can_use && (bootstrapData.reason === 'no_model' || bootstrapData.reason === 'not_tested') && <Notice tone="gamboge" className="mx-auto mb-2 max-w-3xl">{bootstrapData.reason === 'not_tested' ? '模型已经配置好了，但还没有完成能力自检。完成一次自检后就能开始对话。' : '还没有配置可用于对话的模型，请到模型配置页添加支持工具调用的模型。'}历史对话仍可查看。 <a href="/settings/models" className="underline">去模型配置</a></Notice>}
            {pendingActions > 0 && !desktopPresentation && <div className="mx-auto mb-2 max-w-3xl text-[12px] text-mist-500">等待你逐张处理 {pendingActions} 项后，智能体会继续。卡片操作入口显示在对应消息下方。</div>}
            {detail?.can_continue && !busy && !actionExecuting && pendingActions === 0 && <div className="mx-auto mb-2 max-w-3xl text-right"><Button size="sm" variant="ghost" onClick={continueRun}>继续</Button></div>}
            {activeRun && !desktopPresentation && <div className="mx-auto mb-2 max-w-3xl text-right"><Button size="sm" variant="ghost" icon={<Square className="size-3" />} onClick={() => void stop()}>停止</Button></div>}
            {conversation && !activeRun && detail?.actions.some((action) => action.status === 'executing') && <div className="mx-auto mb-2 max-w-3xl text-[12px] text-mist-500">有操作卡片正在执行，请稍候。</div>}
            {detail?.messages.length === 0 && bootstrapData.default_model_unsupported && <div className="mx-auto mb-2 max-w-3xl text-[12px] text-gamboge-700">默认模型未通过工具调用自检，请先选择其他模型。</div>}
            {editMessage && <div className="mx-auto mb-2 flex max-w-3xl items-center justify-between rounded-lg bg-mist-50 px-3 py-1.5 text-xs text-mist-600"><span>编辑最后一条消息并重新运行</span><button type="button" className="cursor-pointer underline" onClick={() => { setEditMessage(null); setText('') }}>取消</button></div>}
            {files.length > 0 && <div className="mx-auto mb-2 max-w-3xl">
              <div className="flex flex-wrap gap-2">
              {files.map((file) => <div key={file.clientID} aria-label={`${file.file.name} ${file.status}`} className={`flex items-center gap-2 rounded-lg border p-1.5 text-xs ${file.status === 'failed' ? 'border-danger/30 bg-danger/5 text-danger' : 'border-mist-200 bg-mist-50 text-mist-600'}`}>
                {file.attachment?.kind === 'image' ? <img src={`${file.attachment.url}?variant=thumb`} alt={file.file.name} className="size-10 rounded object-cover" /> : <FileText className="ml-1 size-4" />}
                <span className="max-w-40 truncate">{file.file.name}</span>
                {file.status === 'uploading' && <span role="status">上传中</span>}
                {file.status === 'ready' && <span>已就绪</span>}
                {file.status === 'failed' && <><span title={file.error}>上传失败</span><Button size="sm" variant="ghost" icon={<RotateCcw className="size-3" />} onClick={() => retryFile(file)}>重试</Button></>}
                <IconButton label={`移除 ${file.file.name}`} className="size-6" onClick={() => void removeFile(file)}><X className="size-3" /></IconButton>
              </div>)}
              </div>
              {failedFiles.length > 0 && <p className="mt-1 text-xs text-danger" role="alert">有 {failedFiles.length} 个附件未成功上传，请重试或移除后再发送。</p>}
            </div>}
            {contextRefs.length > 0 && <div className="mx-auto mb-2 flex max-w-3xl flex-wrap gap-2">
              {contextRefs.map((ref) => <div key={`${ref.type}:${ref.id}`} className="flex items-center gap-2 rounded-lg border border-ink-200 bg-ink-50 px-2 py-1.5 text-xs text-ink-700">
                <AtSign className="size-3.5" /><span className="max-w-48 truncate">{ref.name}</span><span className="text-mist-500">{ref.reference_scope === 'conversation' ? '固定引用' : '本轮引用'}</span>
                <IconButton label={`移除引用 ${ref.name}`} className="size-6" onClick={() => setContextRefs((old) => old.filter((item) => item.id !== ref.id || item.type !== ref.type))}><X className="size-3" /></IconButton>
              </div>)}
            </div>}
            {skillRequests.length > 0 && <div className="mx-auto mb-2 flex max-w-3xl flex-wrap gap-2">
              {skillRequests.map((skill) => <div key={`${skill.skill_id}:${skill.work_id ?? ''}`} className="flex items-center gap-2 rounded-lg border border-ink-200 bg-ink-50 px-2 py-1.5 text-xs text-ink-700">
                <Sparkles className="size-3.5" /><span className="max-w-48 truncate">{skill.name}</span><span className="text-mist-500">已请求</span>
                <IconButton label={`移除技能请求 ${skill.name}`} className="size-6" onClick={() => setSkillRequests((old) => old.filter((item) => item.skill_id !== skill.skill_id || item.work_id !== skill.work_id))}><X className="size-3" /></IconButton>
              </div>)}
            </div>}
            <input ref={fileRef} type="file" multiple accept="image/jpeg,image/png,image/webp,image/gif,.txt,.md" className="hidden" onChange={(event) => { if (event.target.files) void addFiles(event.target.files); event.target.value = '' }} />
            {desktopPresentation ? <>
              <div className={`desktop-agent-compose ${workbenchUI ? 'desktop-agent-workbench-compose' : ''}`}>
                <Textarea ref={inputRef} rows={workbenchUI ? 3 : 1} aria-label={workbenchUI ? '发送消息' : undefined} value={text} disabled={inputDisabled} onChange={(event) => { setText(event.target.value); event.target.style.height = 'auto'; event.target.style.height = `${Math.min(event.target.scrollHeight, workbenchUI ? 176 : 192)}px` }} onKeyDown={onInputKeyDown}
                  placeholder={bootstrapData.read_only ? '观察者可以提问，智能体不会修改工作区数据' : !bootstrapData.can_use ? (bootstrapData.reason === 'not_tested' ? '请先完成模型能力自检' : '请先配置支持工具调用的模型') : '说说你想写什么，或继续调整上面的方向…'} className="desktop-agent-compose-input" />
                <div className="desktop-agent-compose-toolbar">
                  <IconButton label="添加附件" disabled={!canWrite || busy || uploading || files.length >= (bootstrapData.limits.attachments_per_message ?? 6)} onClick={() => fileRef.current?.click()}><Paperclip className="size-4" /></IconButton>
                  {bootstrapData.features.context_refs && <IconButton label="引用资料（@）" disabled={!canWrite || busy || contextRefs.length >= 12} onClick={() => setContextPickerOpen(true)}><AtSign className="size-4" /></IconButton>}
                  {bootstrapData.features.skill_requests && <IconButton label="请求技能（$）" disabled={!canWrite || busy || skillRequests.length >= 3} onClick={() => setSkillPickerOpen(true)}><Sparkles className="size-4" /></IconButton>}
                  <button type="button" className="desktop-agent-compose-choice" onClick={() => setSettingsOpen(true)} aria-label="选择操作账号">{selectedAccountName} <ChevronDown /></button>
                  <span className="desktop-agent-compose-spacer" />
                  <button type="button" className="desktop-agent-compose-choice" onClick={() => setSettingsOpen(true)} aria-label="选择模型">{selectedModelName} <ChevronDown /></button>
                  {busy ? <Button variant="ghost" icon={<Square className="size-4" />} onClick={() => void stop()}>停止</Button>
                    : <Button variant="primary" icon={<Send className="size-4" />} disabled={!canWrite || !canSendContent || uploading || failedFiles.length > 0 || Array.from(text).length > bootstrapData.limits.message_chars} onClick={() => editMessage ? void sendMessage(editMessage) : void sendMessage()}>{uploading ? '上传中' : '发送'}</Button>}
                </div>
              </div>
              <div className="desktop-agent-compose-note">{pendingActions > 0 ? `等待你逐张确认 ${pendingActions} 项 · AI 输出请自行核实` : busy ? '正在生成，可随时停止 · Enter 发送 · Shift+Enter 换行' : completedNotice || 'Enter 发送 · Shift+Enter 换行 · AI 输出请自行核实，写入操作需逐张确认'}</div>
            </> : <>
              <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-2xl border border-mist-200 bg-white p-2 shadow-card focus-within:border-ink-300">
                <IconButton label="添加附件" disabled={!canWrite || busy || uploading || files.length >= (bootstrapData.limits.attachments_per_message ?? 6)} onClick={() => fileRef.current?.click()} className="mb-0.5"><Paperclip className="size-4" /></IconButton>
                {bootstrapData.features.context_refs && <IconButton label="引用资料（@）" disabled={!canWrite || busy || contextRefs.length >= 12} onClick={() => setContextPickerOpen(true)} className="mb-0.5"><AtSign className="size-4" /></IconButton>}
                {bootstrapData.features.skill_requests && <IconButton label="请求技能（$）" disabled={!canWrite || busy || skillRequests.length >= 3} onClick={() => setSkillPickerOpen(true)} className="mb-0.5"><Sparkles className="size-4" /></IconButton>}
                <Textarea ref={inputRef} rows={1} value={text} disabled={inputDisabled} onChange={(event) => { setText(event.target.value); event.target.style.height = 'auto'; event.target.style.height = `${Math.min(event.target.scrollHeight, 192)}px` }} onKeyDown={onInputKeyDown}
                  placeholder={bootstrapData.read_only ? '观察者可以提问，智能体不会修改工作区数据' : !bootstrapData.can_use ? (bootstrapData.reason === 'not_tested' ? '请先完成模型能力自检' : '请先配置支持工具调用的模型') : '发送消息…（Enter 发送，Shift+Enter 换行）'} className="max-h-48 min-h-10 resize-none border-0 bg-transparent px-2 py-2 shadow-none focus:border-transparent focus:ring-0 disabled:bg-transparent" />
                {busy ? <Button variant="ghost" className="mb-0.5 shrink-0" icon={<Square className="size-4" />} onClick={() => void stop()}>停止</Button>
                  : <Button variant="primary" className="mb-0.5 shrink-0" icon={<Send className="size-4" />} disabled={!canWrite || !canSendContent || uploading || failedFiles.length > 0 || Array.from(text).length > bootstrapData.limits.message_chars} onClick={() => editMessage ? void sendMessage(editMessage) : void sendMessage()}>{uploading ? '上传中' : '发送'}</Button>}
              </div>
              <div className="mx-auto mt-1 flex max-w-3xl justify-between px-2 text-[10.5px] text-mist-400"><span>{files.length ? `已添加 ${files.length} 个附件` : '附件支持图片、txt 与 md'}</span><span>{Array.from(text).length} / {bootstrapData.limits.message_chars}</span></div>
            </>}
          </div>
        </div>
      </section>

      {workbenchUI && workbenchPanelOpen && <WorkbenchSidePanel
        tab={workbenchPanelTab}
        setTab={setWorkbenchPanelTab}
        close={() => setWorkbenchPanelOpen(false)}
        conversation={conversation}
        activeRun={activeRun}
        busy={busy}
        pendingActions={pendingActions}
        actionCount={actions.length}
        selectedAccountName={selectedAccountName}
        selectedModelName={selectedModelName}
        attachmentCount={attachmentCount}
        contextRefs={contextRefs}
        skillRequests={skillRequests}
        latestSkillUsage={latestSkillUsage}
        artifactsEnabled={bootstrapData.features.artifacts === true}
        actions={actions}
      />}

      {bootstrapData.features.artifacts === true && !desktopPresentation && <Drawer open={artifactsOpen} onClose={() => setArtifactsOpen(false)} title="本对话产物" width="w-[min(92vw,920px)]">
        <ArtifactPanel conversationID={conversation?.id} updatedAt={conversation?.updated_at} />
      </Drawer>}

      <Drawer open={mobileListOpen} onClose={() => setMobileListOpen(false)} title="对话" width="w-[min(88vw,360px)]">
        <AgentConversationList currentID={conversationId} search={search} setSearch={setSearch} onSelect={openConversation} onNew={newConversation} onClose={() => setMobileListOpen(false)} organizeEnabled={organizeEnabled} />
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
            <span className="text-[11px] font-medium text-mist-500">{message.role === 'user' ? '你' : '助手'} · 第 {message.seq} 条</span>
            <span className="mt-1 block whitespace-pre-wrap break-words text-[13px] leading-5 text-mist-800">{message.content.slice(0, 220)}</span>
          </button>)}
          {!localSearchText.trim() && <p className="py-5 text-center text-[13px] text-mist-500">输入关键词，搜索此对话的完整历史。</p>}
          {!localSearchBusy && !localSearchError && localSearchText.trim() && !localSearchResults.length && <p className="py-5 text-center text-[13px] text-mist-500">没有匹配的消息</p>}
        </div>
      </Dialog>
      <Dialog open={settingsOpen} onClose={() => setSettingsOpen(false)} title="对话设置" desc="选择本对话使用的模型与操作账号。">
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
      <SkillPickerDialog
        open={skillPickerOpen}
        onClose={() => setSkillPickerOpen(false)}
        accountID={selectedAccount}
        selected={skillRequests}
        workOptions={selectedWorkOptions}
        onAdd={(item) => setSkillRequests((old) => old.some((skill) => skill.skill_id === item.skill_id && skill.work_id === item.work_id) || old.length >= 3 ? old : [...old, item])}
      />
      <Dialog open={privacyOpen} onClose={() => { setPrivacyOpen(false); savePrefs.mutate({ agent_privacy_notice_seen: true }) }} title="智能体隐私说明" desc="对话仅你本人可见。工作区所有者和系统管理员也无法查看你的对话；卡片执行会照常写入操作日志，并标记为来自智能体。" footer={<Button variant="primary" onClick={() => { setPrivacyOpen(false); savePrefs.mutate({ agent_privacy_notice_seen: true }) }}>我知道了</Button>}>
        <p className="text-[13px] leading-relaxed text-mist-600">不要在对话或附件中发送 API 密钥、平台密钥、密码或邀请码。智能体读取的信息会按系统规则传给当前选择的模型供应商。</p>
      </Dialog>
      </div>
    </>
  )
}

function Welcome({ onPrompt, noModel, desktopWorkbench = false }: { onPrompt: (value: string) => void; noModel: boolean; desktopWorkbench?: boolean }) {
  const examples = ['这周有哪些作品还没做发布前检查？', '帮我从这段笔记里提炼素材', '给《我的文章》起 5 个标题']
  return <div className={`mx-auto flex min-h-[50%] max-w-2xl flex-col items-center justify-center py-12 text-center ${desktopWorkbench ? 'desktop-agent-workbench-welcome' : ''}`}>
    <div className="flex size-14 items-center justify-center rounded-2xl bg-ink-50 text-ink-600"><Bot className="size-7" /></div>
    <h1 className="mt-4 font-display text-xl font-bold text-mist-900">{desktopWorkbench ? '从一件具体的运营任务开始' : '有什么可以帮你？'}</h1>
    <p className="mt-2 max-w-lg text-[13px] leading-relaxed text-mist-500">可以读取工作区信息并生成建议。任何写入操作都会先列出单张卡片，由你逐张确认执行。</p>
    {!noModel && <div className={`mt-6 flex flex-wrap justify-center gap-2 ${desktopWorkbench ? 'desktop-agent-workbench-prompts' : ''}`}>{examples.map((example) => <button key={example} type="button" onClick={() => onPrompt(example)} className={`cursor-pointer rounded-full border border-mist-200 bg-white px-3 py-2 text-[12px] text-mist-600 shadow-card hover:border-ink-300 hover:text-ink-700 ${desktopWorkbench ? 'desktop-agent-workbench-prompt' : ''}`}>{example}</button>)}</div>}
  </div>
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

