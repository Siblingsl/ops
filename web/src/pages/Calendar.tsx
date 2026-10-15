import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { CalendarDays, ChevronLeft, ChevronRight, Info, Lightbulb } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { Button, Card, cn, Notice, PageHeader, PageLoading, PlatformMark, StatusBadge, Tabs } from '@/components/ui'
import { errorMessage, get, patch } from '@/lib/api'
import { useAccounts, useCanWrite, useCurrentAccount } from '@/lib/session'
import type { CalendarItem, TopicPage, WorkListItem, WorkStatus } from '@/lib/types'

const pad = (n: number) => String(n).padStart(2, '0')
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const WEEK = ['一', '二', '三', '四', '五', '六', '日']
const ACCOUNT_COLORS = ['#3b6fd8', '#d9822b', '#2f9e74', '#b8478f', '#7a5af5', '#c2410c', '#0e7490', '#65a30d']

const mondayOf = (d: Date) => { const m = new Date(d.getFullYear(), d.getMonth(), d.getDate()); m.setDate(m.getDate() - ((m.getDay() + 6) % 7)); return m }

type Phase = 'writing' | 'ready' | 'published'
const phaseOf = (it: CalendarItem): Phase => {
  if (it.date_kind === 'published' || it.status === 'published') return 'published'
  if (['ready', 'pushed', 'packed'].includes(it.status)) return 'ready'
  return 'writing'
}
const phaseClass: Record<Phase, string> = {
  writing: 'bg-gamboge-50 text-gamboge-700',
  ready: 'bg-ink-50 text-ink-800',
  published: 'bg-success/10 text-success',
}

/** Calendar (EX-B-02): 计划发布日 only. Dates are reminders for people; nothing is ever pushed or published on a date (HC-16). */
export default function CalendarPage() {
  const acc = useCurrentAccount()
  const canWrite = useCanWrite()
  const { data: accounts } = useAccounts()
  const [view, setView] = useState<'month' | 'week'>('month')
  const [anchor, setAnchor] = useState(() => new Date())
  const [scope, setScope] = useState<'account' | 'all'>('account')
  const [side, setSide] = useState<'works' | 'topics'>('works')
  const [dragOver, setDragOver] = useState('')
  const month = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
  const grid = useMemo(() => {
    const start = view === 'week' ? mondayOf(anchor) : mondayOf(new Date(anchor.getFullYear(), anchor.getMonth(), 1))
    return Array.from({ length: view === 'week' ? 7 : 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d })
  }, [anchor, view])
  const from = iso(grid[0])
  const to = iso(grid[grid.length - 1])
  const cal = useQuery({
    queryKey: ['calendar', from, to, scope, acc?.id],
    queryFn: () => get<{ items: CalendarItem[] }>(`/calendar?from=${from}&to=${to}${scope === 'account' && acc ? `&account_id=${acc.id}` : ''}`),
    enabled: !!acc,
  })
  const works = useQuery({
    queryKey: ['works', acc?.id, ''],
    queryFn: () => get<WorkListItem[]>(`/accounts/${acc!.id}/works?q=`),
    enabled: !!acc,
  })
  const topics = useInfiniteQuery({
    queryKey: ['topics', acc?.id, 'calendar'],
    queryFn: ({ pageParam }) => get<TopicPage>(`/accounts/${acc!.id}/topics?limit=50${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`),
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: !!acc,
  })
  if (!acc) return <PageLoading />
  const colorOf = (accountId: string) => {
    const i = (accounts ?? []).findIndex((a) => a.id === accountId)
    return ACCOUNT_COLORS[(i < 0 ? 0 : i) % ACCOUNT_COLORS.length]
  }
  const byDate = new Map<string, CalendarItem[]>()
  for (const it of cal.data?.items ?? []) byDate.set(it.date, [...(byDate.get(it.date) ?? []), it])
  const unplanned = (works.data ?? []).filter((w) => !w.planned_date && ['drafting', 'checking', 'reviewing', 'ready'].includes(w.status))
  const topicList = topics.data?.pages.flatMap((page) => page.items) ?? []
  const unplannedTopics = topicList.filter((t) => !t.planned_date && !t.work_id && t.status !== 'dropped')
  const today = iso(new Date())
  const shownAccounts = [...new Map((cal.data?.items ?? []).map((it) => [it.account_id, it.account_name])).entries()]

  const setDate = async (kind: 'work' | 'topic', id: string, date: string) => {
    try {
      await patch(kind === 'work' ? `/works/${id}` : `/topics/${id}`, { planned_date: date })
      void cal.refetch()
      void (kind === 'work' ? works.refetch() : topics.refetch())
      toast.success(date ? `计划发布日已设为 ${date}` : '已取消计划发布日', { description: '到日子只会在工作台提醒你，不会自动发布。' })
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const onDrop = (date: string, e: React.DragEvent) => {
    e.preventDefault()
    setDragOver('')
    const raw = e.dataTransfer.getData('text/ops-plan')
    if (!raw || !canWrite) return
    const { kind, id } = JSON.parse(raw) as { kind: 'work' | 'topic'; id: string }
    void setDate(kind, id, date)
  }
  const dragStart = (kind: string, id: string) => (e: React.DragEvent) => e.dataTransfer.setData('text/ops-plan', JSON.stringify({ kind, id }))
  const shift = (n: number) => setAnchor(view === 'week'
    ? new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + n * 7)
    : new Date(anchor.getFullYear(), anchor.getMonth() + n, 1))
  const label = view === 'week'
    ? `${grid[0].getMonth() + 1} 月 ${grid[0].getDate()} 日 – ${grid[6].getMonth() + 1} 月 ${grid[6].getDate()} 日`
    : `${month.getFullYear()} 年 ${month.getMonth() + 1} 月`
  const perCell = view === 'week' ? 30 : 4

  return (
    <div className="animate-fade-in">
      <PageHeader title="内容日历" desc="把作品和选题拖到某一天，设为「计划发布日」。到日子只会提醒你，发布永远由你在平台后台完成。"
        action={<Tabs value={scope} onChange={setScope} items={[{ value: 'account', label: '当前账号' }, { value: 'all', label: '全部账号' }]} />} />
      <div className="grid gap-5 xl:grid-cols-[1fr_280px]">
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-mist-100 px-4 py-3">
            <div className="flex items-center gap-1">
              <Button size="sm" variant="ghost" aria-label="上一页" icon={<ChevronLeft className="size-4" />} onClick={() => shift(-1)} />
              <span className="min-w-[9rem] text-center font-display text-[16px] font-semibold text-mist-900">{label}</span>
              <Button size="sm" variant="ghost" aria-label="下一页" icon={<ChevronRight className="size-4" />} onClick={() => shift(1)} />
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={() => setAnchor(new Date())}>{view === 'week' ? '回到本周' : '回到本月'}</Button>
              <Tabs value={view} onChange={setView} items={[{ value: 'month', label: '月' }, { value: 'week', label: '周' }]} />
            </div>
          </div>
          <div className="grid grid-cols-7 border-b border-mist-100 bg-mist-50/60 text-center text-[11.5px] text-mist-400">
            {WEEK.map((w, i) => <div key={w} className="py-1.5">周{w}{view === 'week' && ` · ${grid[i].getDate()}`}</div>)}
          </div>
          <div className="grid grid-cols-7">
            {grid.map((d) => {
              const k = iso(d)
              const items = byDate.get(k) ?? []
              const other = view === 'month' && d.getMonth() !== month.getMonth()
              return (
                <div key={k}
                  onDragOver={(e) => { if (canWrite) { e.preventDefault(); setDragOver(k) } }}
                  onDragLeave={() => setDragOver((v) => (v === k ? '' : v))}
                  onDrop={(e) => onDrop(k, e)}
                  className={cn('border-b border-r border-mist-100 p-1.5 transition-colors', view === 'week' ? 'min-h-[420px]' : 'min-h-[92px] sm:min-h-[110px]',
                    other && 'bg-mist-50/50', dragOver === k && 'bg-ink-50 ring-2 ring-inset ring-ink-300')}>
                  {view === 'month' && (
                    <div className={cn('mb-1 flex size-6 items-center justify-center rounded-full text-[12px] tabular-nums',
                      k === today ? 'bg-ink-600 font-bold text-white' : other ? 'text-mist-300' : 'text-mist-600')}>{d.getDate()}</div>
                  )}
                  {view === 'week' && k === today && <div className="mb-1 h-0.5 rounded bg-ink-500" />}
                  <div className="space-y-1">
                    {items.slice(0, perCell).map((it) => (
                      <Link key={it.kind + it.id} to={it.kind === 'work' ? `/works/${it.id}` : `/a/${it.account_id}/topics?focus=${it.id}`}
                        draggable={canWrite && it.date_kind === 'planned'} onDragStart={dragStart(it.kind, it.id)}
                        title={`${it.account_name} · ${it.title || '未命名'}${it.date_kind === 'published' ? '（已发布）' : '（计划）'}`}
                        style={scope === 'all' ? { borderLeft: `3px solid ${colorOf(it.account_id)}` } : undefined}
                        className={cn('flex items-center gap-1 rounded px-1 py-0.5 leading-tight', view === 'week' ? 'text-[12px]' : 'truncate text-[11.5px]',
                          it.kind === 'topic' ? 'border border-dashed border-gamboge-300 text-gamboge-700' : phaseClass[phaseOf(it)])}>
                        {scope === 'all' && <PlatformMark platform={it.platform} size="sm" />}
                        {it.kind === 'topic' && <Lightbulb className="size-3 shrink-0" />}
                        <span className={view === 'week' ? 'line-clamp-2' : 'truncate'}>{it.title || '未命名'}</span>
                      </Link>
                    ))}
                    {items.length > perCell && <div className="px-1 text-[11px] text-mist-400">还有 {items.length - perCell} 项</div>}
                  </div>
                </div>
              )
            })}
          </div>
        </Card>
        <div className="space-y-4">
          <Card className="p-4">
            <div className="mb-2 flex items-center gap-2 text-[13.5px] font-semibold text-mist-900"><CalendarDays className="size-4 text-ink-600" />未排期</div>
            <Tabs value={side} onChange={setSide} className="mb-2" items={[{ value: 'works', label: `作品 ${unplanned.length}` }, { value: 'topics', label: `选题 ${unplannedTopics.length}` }]} />
            <p className="mb-3 text-[12px] text-mist-500">拖到日历上的某一天，或直接选日期。</p>
            {side === 'works' ? (
              unplanned.length === 0 ? <p className="py-4 text-center text-[12.5px] text-mist-400">作品都排好了</p> : (
                <ul className="space-y-1.5">
                  {unplanned.slice(0, 20).map((w) => (
                    <li key={w.id} draggable={canWrite} onDragStart={dragStart('work', w.id)}
                      className="rounded-lg border border-mist-200 bg-white px-2.5 py-2 text-[12.5px] hover:border-ink-200">
                      <div className="flex items-center gap-2">
                        <Link to={`/works/${w.id}`} className="min-w-0 flex-1 truncate font-medium text-mist-800 hover:text-ink-700">{w.title || '未命名作品'}</Link>
                        <StatusBadge status={w.status as WorkStatus} />
                      </div>
                      {canWrite && <input type="date" aria-label="计划发布日" className="mt-1.5 w-full rounded border border-mist-200 px-1.5 py-0.5 text-[12px] text-mist-600" onChange={(e) => e.target.value && setDate('work', w.id, e.target.value)} />}
                    </li>
                  ))}
                </ul>
              )
            ) : unplannedTopics.length === 0 ? (
              <p className="py-4 text-center text-[12.5px] text-mist-400">没有待排期的选题，<Link to={`/a/${acc.id}/topics`} className="text-ink-700 hover:underline">去选题池</Link></p>
            ) : (
              <ul className="space-y-1.5">
                {unplannedTopics.slice(0, 20).map((t) => (
                  <li key={t.id} draggable={canWrite} onDragStart={dragStart('topic', t.id)}
                    className="rounded-lg border border-dashed border-gamboge-300 bg-white px-2.5 py-2 text-[12.5px] hover:border-gamboge-400">
                    <div className="flex items-center gap-2">
                      <Lightbulb className="size-3.5 shrink-0 text-gamboge-500" />
                      <Link to={`/a/${acc.id}/topics?focus=${t.id}`} className="min-w-0 flex-1 truncate font-medium text-mist-800 hover:text-ink-700">{t.title}</Link>
                      <span className="shrink-0 text-[11px] text-mist-400">{t.status === 'adopted' ? '已采用' : '待定'}</span>
                    </div>
                    {canWrite && <input type="date" aria-label="计划发布日" className="mt-1.5 w-full rounded border border-mist-200 px-1.5 py-0.5 text-[12px] text-mist-600" onChange={(e) => e.target.value && setDate('topic', t.id, e.target.value)} />}
                  </li>
                ))}
                {topics.hasNextPage && <li className="pt-2"><Button size="sm" variant="ghost" loading={topics.isFetchingNextPage} onClick={() => void topics.fetchNextPage()}>加载更多选题</Button></li>}
              </ul>
            )}
          </Card>
          <Notice icon={<Info className="size-4" />}>
            <b>计划发布日</b>只是给人看的提醒：到日子会出现在工作台「现在最值得做的」里。系统不会在这一天自动写入草稿、推送或发布。
          </Notice>
          <div className="flex flex-wrap gap-3 px-1 text-[11.5px] text-mist-500">
            <span className="flex items-center gap-1"><span className="size-2.5 rounded bg-gamboge-100" />创作中</span>
            <span className="flex items-center gap-1"><span className="size-2.5 rounded bg-ink-100" />可发布</span>
            <span className="flex items-center gap-1"><span className="size-2.5 rounded bg-success/20" />已发布</span>
            <span className="flex items-center gap-1"><span className="size-2.5 rounded border border-dashed border-gamboge-400" />计划中的选题</span>
          </div>
          {scope === 'all' && shownAccounts.length > 0 && (
            <div className="flex flex-wrap gap-3 px-1 text-[11.5px] text-mist-500">
              {shownAccounts.map(([id, name]) => (
                <span key={id} className="flex items-center gap-1"><span className="size-2.5 rounded-full" style={{ background: colorOf(id) }} />{name}</span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
