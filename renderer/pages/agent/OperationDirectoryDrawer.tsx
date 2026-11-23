import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { CalendarDays, Image as ImageIcon, Library, LoaderCircle, Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Drawer } from '@/components/dialog'
import { Button, Input, Notice, Select } from '@/components/ui'
import { errorMessage, get } from '@/lib/api'
import { useAccounts } from '@/lib/session'
import type { CalendarItem } from '@/lib/types'
import type { AgentContextCandidate, AgentContextSelection } from '@/pages/agent/ContextPickers'

type DirectoryType = 'work' | 'topic' | 'material' | 'image' | 'calendar'

interface CandidatePage { items: AgentContextCandidate[]; next_cursor: string | null }
interface CalendarPage { from: string; to: string; items: CalendarItem[] }

const tabs: { id: DirectoryType; label: string }[] = [
  { id: 'work', label: '作品' },
  { id: 'topic', label: '选题' },
  { id: 'material', label: '素材' },
  { id: 'image', label: '图片' },
  { id: 'calendar', label: '日历' },
]

function isoDate(date: Date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function calendarWindow() {
  const from = new Date()
  const to = new Date()
  from.setDate(from.getDate() - 1)
  to.setDate(to.getDate() + 30)
  return { from: isoDate(from), to: isoDate(to) }
}

export function OperationDirectoryDrawer({ open, onClose, accountID, selected, onAdd }: {
  open: boolean
  onClose: () => void
  accountID: string
  selected: AgentContextSelection[]
  onAdd: (item: AgentContextSelection) => void
}) {
  const accounts = useAccounts()
  const [type, setType] = useState<DirectoryType>('work')
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [calendarBusy, setCalendarBusy] = useState('')
  const [failure, setFailure] = useState('')
  const currentAccount = accounts.data?.find((item) => item.id === accountID)
  const accountRequired = type !== 'material'
  const calendarRange = useMemo(calendarWindow, [])

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 250)
    return () => window.clearTimeout(timer)
  }, [search])

  const candidates = useInfiniteQuery({
    queryKey: ['agent-operation-directory', type, accountID, debouncedSearch],
    enabled: open && type !== 'calendar' && (!accountRequired || !!accountID),
    initialPageParam: '' as string,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ type, q: debouncedSearch, limit: '20' })
      if (accountID) params.set('account_id', accountID)
      if (pageParam) params.set('cursor', pageParam)
      return get<CandidatePage>(`/agent/context-candidates?${params}`)
    },
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  })
  const items = candidates.data?.pages.flatMap((page) => page.items) ?? []

  const calendar = useQuery({
    queryKey: ['agent-operation-directory-calendar', accountID, calendarRange.from, calendarRange.to],
    queryFn: () => get<CalendarPage>(`/calendar?from=${calendarRange.from}&to=${calendarRange.to}${accountID ? `&account_id=${accountID}` : ''}`),
    enabled: open && type === 'calendar' && !!accountID,
  })
  const calendarItems = (calendar.data?.items ?? []).filter((item) => !debouncedSearch || item.title.includes(debouncedSearch))

  const duplicate = (candidate: AgentContextCandidate) => selected.some((item) => item.type === candidate.type && item.id === candidate.id)
  const addCandidate = (candidate: AgentContextCandidate) => {
    if (duplicate(candidate)) return
    onAdd({ ...candidate, reference_scope: 'turn' })
  }

  // 日历只暴露日期/标题，不复制作品或选题对象；点击时仍走同一候选接口取 revision，发送时再按当前权限复核。
  const addCalendarItem = async (item: CalendarItem) => {
    if (!accountID || calendarBusy) return
    if (selected.some((ref) => ref.type === item.kind && ref.id === item.id)) return
    setCalendarBusy(item.id)
    setFailure('')
    try {
      const page = await get<CandidatePage>(`/agent/context-candidates?type=${item.kind}&account_id=${accountID}&q=${encodeURIComponent(item.title)}&limit=20`)
      const candidate = page.items.find((value) => value.id === item.id)
      if (!candidate) throw new Error('这条日历记录当前不可引用，请刷新后重试。')
      addCandidate(candidate)
    } catch (error) {
      setFailure(errorMessage(error))
    } finally {
      setCalendarBusy('')
    }
  }

  const changeType = (next: DirectoryType) => {
    setType(next)
    setSearch('')
    setFailure('')
  }

  return <Drawer open={open} onClose={onClose} title={<span className="flex items-center gap-2"><Library className="size-4" />运营目录</span>}
    desc="只读浏览当前账号的资料与排期；点击只生成输入台引用，不会自动发送，也不提供批量操作。"
    width="w-[480px]">
    <div data-testid="agent-operation-directory" data-width="480" className="space-y-3">
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
        <Select aria-label="目录账号" value={accountID} disabled>
          <option value="">未选择账号</option>
          {accountID && <option value={accountID}>{currentAccount?.name ?? '当前账号'}</option>}
        </Select>
        <div className="flex min-w-0 items-center justify-end text-xs text-mist-500">
          {accountID ? `按「${currentAccount?.name ?? '当前账号'}」浏览` : '先在顶部选择操作账号'}
        </div>
      </div>
      <div role="tablist" aria-label="运营目录分类" className="flex flex-wrap gap-1 rounded-lg bg-mist-50 p-1">
        {tabs.map((tab) => <button key={tab.id} type="button" role="tab" aria-selected={type === tab.id}
          onClick={() => changeType(tab.id)}
          className={`rounded-md px-3 py-1.5 text-xs font-medium ${type === tab.id ? 'bg-white text-ink-700 shadow-sm' : 'text-mist-500 hover:text-mist-800'}`}>
          {tab.label}
        </button>)}
      </div>
      {accountRequired && !accountID && <Notice tone="gamboge">运营目录需要先选择操作账号；素材可浏览工作区共享项，作品/选题/图片/日历按账号读取。</Notice>}
      <label className="relative block">
        <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-mist-400" />
        <Input aria-label="搜索运营目录" value={search} onChange={(event) => { setSearch(event.target.value); setFailure('') }} placeholder={type === 'calendar' ? '按标题筛选日历' : '搜索标题、摘要或来源'} className="pl-9" />
      </label>
      {failure && <Notice tone="red">{failure}</Notice>}
      {type !== 'calendar' && <>
        {candidates.isLoading && <p role="status" className="flex items-center gap-2 text-sm text-mist-500"><LoaderCircle className="size-4 animate-spin" />正在读取当前可访问资料…</p>}
        {candidates.isError && <Notice tone="red">{errorMessage(candidates.error)} <button type="button" className="ml-1 underline" onClick={() => void candidates.refetch()}>重试</button></Notice>}
        {!candidates.isLoading && !candidates.isError && <div className="max-h-[calc(100vh-290px)] space-y-1 overflow-y-auto rounded-lg border border-mist-200 p-1">
          {items.map((item) => {
            const alreadyAdded = duplicate(item)
            return <button key={`${item.type}:${item.id}`} type="button" disabled={alreadyAdded || !accountID && accountRequired}
              aria-label={`引用${item.type === 'work' ? '作品' : item.type === 'topic' ? '选题' : item.type === 'material' ? '素材' : '图片'} ${item.name}`}
              onClick={() => addCandidate(item)}
              className={`block w-full rounded-md px-3 py-2 text-left disabled:opacity-50 ${alreadyAdded ? 'bg-mist-50' : 'hover:bg-mist-50'}`}>
              <span className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate text-sm font-medium text-mist-800">{item.name}</span>{item.type === 'image' && <ImageIcon className="size-3.5 shrink-0 text-mist-400" />}</span>
              <span className="mt-0.5 block truncate text-xs text-mist-500">{item.summary} · {item.scope === 'workspace' ? '工作区' : '当前账号'} · {item.updated_at ? new Date(item.updated_at).toLocaleString('zh-CN') : '时间未知'}{alreadyAdded ? ' · 已添加' : ''}</span>
            </button>
          })}
          {!items.length && <p className="px-3 py-6 text-center text-sm text-mist-500">没有找到可访问资料。</p>}
          {candidates.hasNextPage && <Button variant="ghost" size="sm" className="w-full" loading={candidates.isFetchingNextPage} onClick={() => void candidates.fetchNextPage()}>加载更多</Button>}
        </div>}
      </>}
      {type === 'calendar' && <>
        <p className="flex items-center gap-1.5 text-xs text-mist-500"><CalendarDays className="size-3.5" />{calendarRange.from} 至 {calendarRange.to}，只读排期</p>
        {calendar.isLoading && <p role="status" className="flex items-center gap-2 text-sm text-mist-500"><LoaderCircle className="size-4 animate-spin" />正在读取日历…</p>}
        {calendar.isError && <Notice tone="red">{errorMessage(calendar.error)} <button type="button" className="ml-1 underline" onClick={() => void calendar.refetch()}>重试</button></Notice>}
        {!calendar.isLoading && !calendar.isError && <div className="max-h-[calc(100vh-320px)] space-y-1 overflow-y-auto rounded-lg border border-mist-200 p-1">
          {calendarItems.map((item) => {
            const alreadyAdded = selected.some((ref) => ref.type === item.kind && ref.id === item.id)
            return <button key={`${item.kind}:${item.id}:${item.date}`} type="button" disabled={!accountID || calendarBusy === item.id || alreadyAdded}
              aria-label={`引用日历 ${item.date} ${item.title}`} onClick={() => void addCalendarItem(item)}
              className={`block w-full rounded-md px-3 py-2 text-left disabled:opacity-50 ${alreadyAdded ? 'bg-mist-50' : 'hover:bg-mist-50'}`}>
              <span className="flex items-center justify-between gap-2"><span className="text-xs tabular-nums text-mist-500">{item.date}</span><span className="rounded bg-mist-50 px-1.5 py-0.5 text-[11px] text-mist-500">{item.kind === 'work' ? '作品' : '选题'}</span></span>
              <span className="mt-1 block truncate text-sm font-medium text-mist-800">{item.title || '未命名'}</span>
              <span className="mt-0.5 block truncate text-xs text-mist-500">{item.status} · {item.date_kind === 'published' ? '已发布' : '计划'}{alreadyAdded ? ' · 已添加' : ''}{calendarBusy === item.id ? ' · 正在校验' : ''}</span>
            </button>
          })}
          {!calendarItems.length && <p className="px-3 py-6 text-center text-sm text-mist-500">当前范围内没有排期。</p>}
        </div>}
      </>}
    </div>
  </Drawer>
}
