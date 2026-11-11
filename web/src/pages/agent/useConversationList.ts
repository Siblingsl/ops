import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { confirm } from '@/components/dialog'
import { del, errorMessage, get, patch, post } from '@/lib/api'
import { useAccounts } from '@/lib/session'
import {
  type AgentConversationGroup, type AgentConversationPage,
} from '@/lib/agent'

const pageSize = 30

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

export function useConversationList({ search, organizeEnabled, goalsEnabled }: {
  search: string
  organizeEnabled: boolean
  goalsEnabled: boolean
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
  if (organizeEnabled || goalsEnabled) {
    if (stateFilter === 'task' && goalsEnabled) queryParams.set('archived', 'all')
    else if (organizeEnabled && archived) queryParams.set('archived', 'true')
    if (accountID) queryParams.set('account_id', accountID)
    if (groupID) queryParams.set('group_id', groupID)
    if (stateFilter) queryParams.set('state', stateFilter)
  }
  const list = useInfiniteQuery({
    queryKey: ['agent-conversations', debouncedSearch, archived, accountID, groupID, stateFilter, organizeEnabled, goalsEnabled],
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
  // 归档视图是平铺的恢复列表：pinned_at 不再把会话排除掉，否则“置顶后归档”的会话在 UI 里不可达。
  const rest = archived ? items : items.filter((item) => !item.pinned_at)
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

  return {
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
  }
}
