import { useQueryClient } from '@tanstack/react-query'
import {
  Archive, ArchiveRestore, FolderPlus, LoaderCircle, MoreHorizontal,
  MessageSquarePlus, Pencil, Pin, PinOff, Search, Trash2, X,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { confirm, Dialog } from '@/components/dialog'
import { Button, cn, IconButton, Input, Select } from '@/components/ui'
import { del, errorMessage, patch, post } from '@/lib/api'
import { isEnterWithoutComposition } from '@/lib/keyboard'
import {
  type AgentConversationGroup, type AgentConversationListItem,
} from '@/lib/agent'
import { useConversationList } from '@/pages/agent/useConversationList'

export function AgentConversationList({
  currentID, search, setSearch, onSelect, onNew, onClose, sidebarTitle, organizeEnabled = false, goalsEnabled = false,
}: {
  currentID?: string; search: string; setSearch: (v: string) => void
  onSelect: (id: string, matchedSeq?: number) => void; onNew: () => void; onClose?: () => void
  sidebarTitle?: string
  organizeEnabled?: boolean
  goalsEnabled?: boolean
}) {
  const {
    accounts,
    archived, setArchived,
    accountID, setAccountID,
    groupID, setGroupID,
    stateFilter, setStateFilter,
    groupDialog, setGroupDialog,
    groupManageOpen, setGroupManageOpen,
    groupBusy,
    groupQuery,
    list,
    sentinel,
    items,
    pinned,
    groups,
    namedGroups,
    groupedRows,
    dateGroups,
    invalidateOrganize,
    saveGroup,
    removeGroup,
  } = useConversationList({ search, organizeEnabled, goalsEnabled })

  const row = (item: AgentConversationListItem) => (
    <ConversationRow key={item.id} item={item} groups={namedGroups} organizeEnabled={organizeEnabled} selected={item.id === currentID} onChanged={invalidateOrganize} onSelect={() => { onSelect(item.id, item.matched_message_seq ?? undefined); onClose?.() }} />
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {sidebarTitle !== undefined && <div className="mb-1.5 min-w-0 px-6 pt-3 text-[11px] font-semibold tracking-[0.16em] text-mist-400"><div className="truncate" title={sidebarTitle}>{sidebarTitle}</div></div>}
      <div className={cn('flex items-center gap-2', sidebarTitle !== undefined ? 'px-3 pb-3 pt-0' : 'p-3')}>
        <Button variant="primary" className="flex-1" icon={<MessageSquarePlus className="size-4" />} onClick={onNew}>新对话</Button>
        {onClose && <IconButton label="关闭对话列表" onClick={onClose}><X className="size-4" /></IconButton>}
      </div>
      <label className="relative mx-3 mb-3 block">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-mist-400" />
        <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索对话" className="pl-9" aria-label="搜索对话" />
      </label>
      {organizeEnabled && <div className="mx-3 mb-3 grid grid-cols-2 gap-1.5">
        {stateFilter !== 'task' && <Select aria-label="筛选归档状态" value={archived ? 'archived' : 'active'} onChange={(event) => setArchived(event.target.value === 'archived')}>
          <option value="active">当前对话</option><option value="archived">已归档</option>
        </Select>}
        <Select aria-label="筛选对话状态" value={stateFilter} onChange={(event) => setStateFilter(event.target.value)}>
          <option value="">全部状态</option><option value="active">进行中</option><option value="needs_action">待我处理</option><option value="unread">未读</option>{goalsEnabled && <option value="task">我的任务</option>}
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
      {!organizeEnabled && goalsEnabled && <label className="mx-3 mb-3 block"><Select aria-label="筛选对话状态" value={stateFilter} onChange={(event) => setStateFilter(event.target.value)}><option value="">全部对话</option><option value="task">我的任务（含已归档）</option></Select></label>}
      {goalsEnabled && stateFilter === 'task' && <p className="mx-4 -mt-2 mb-2 text-[11px] text-mist-400">跨会话显示任务，包含已归档对话。</p>}
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

function ConversationGroup({ label, icon, actions, children }: { label: string; icon?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return <section className="mb-3"><div className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold tracking-wide text-mist-400">{icon}{label}<span className="ml-auto flex items-center">{actions}</span></div><div className="space-y-0.5">{children}</div></section>
}

function ConversationRow({ item, groups, organizeEnabled, selected, onSelect, onChanged }: {
  item: AgentConversationListItem; groups: AgentConversationGroup[]; organizeEnabled: boolean; selected: boolean
  onSelect: () => void; onChanged: () => Promise<void>
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
        <span className="mt-0.5 block truncate text-[11px] text-mist-400">{item.matched_message_snippet || (item.goal ? `任务 · ${{ active: '进行中', paused: '已暂停', waiting_user: '等待处理', completed: '已完成', blocked: '已阻塞', budget_limited: '预算已用尽', cancelled: '已结束' }[item.goal.status] ?? item.goal.status}` : item.archived_at ? '已归档' : item.model || '尚未选择模型')}</span>
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

function MenuButton({ icon, label, onClick, danger }: { icon: ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return <button type="button" role="menuitem" onClick={onClick} className={`flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] hover:bg-mist-50 ${danger ? 'text-danger' : 'text-mist-600'}`}><span className="[&>svg]:size-3.5">{icon}</span>{label}</button>
}
