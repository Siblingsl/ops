import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { Bookmark, CalendarDays, Copy, FileText, GitBranch, ImageIcon, Lightbulb, PenLine, Search, Send, Star, Tag, Trash2, UserRound, X } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { DeriveDialog } from '@/components/derive'
import { Dialog } from '@/components/dialog'
import { Button, Card, cn, Empty, IconButton, Input, MoreMenu, PageHeader, PageLoading, PageState, StatusBadge, Tabs } from '@/components/ui'
import { del, errorMessage, get, getPage, patch, post } from '@/lib/api'
import { assetUrl } from '@/lib/api-base'
import { relTime } from '@/lib/format'
import { isEnterWithoutComposition } from '@/lib/keyboard'
import { deleteWithUndo } from '@/lib/undo'
import { useCanWrite, useCurrentAccount, useInvalidate, useMe } from '@/lib/session'
import type { Account, StarItem, Work, WorkListItem, WorkStatus } from '@/lib/types'
import { usePrefetchWork, usePrefs, useSavePrefs } from '@/lib/v3'
import { useCreateWork } from './Dashboard'
import { openCreateWork } from '@/components/create-work-panel'
import { WorkImportDialog } from './work-import-dialog'
import { PlatformWorksView } from './platform-works'

type Filter = 'all' | 'drafting' | 'checking' | 'reviewing' | 'ready' | 'out' | 'published'
const filterStatus: Record<Filter, WorkStatus[] | null> = {
  all: null, drafting: ['drafting'], checking: ['checking'], reviewing: ['reviewing'], ready: ['ready'], out: ['pushed', 'packed'], published: ['published'],
}

function EmptyCreateActions({ create, onTopics }: { create: () => void; onTopics: () => void }) {
  return (
    <div className="flex flex-wrap justify-center gap-2">
      <Button variant="primary" onClick={create}>空白新建</Button>
      <Button icon={<Lightbulb className="size-4" />} onClick={onTopics}>从选题开始</Button>
    </div>
  )
}

// WL-01：行点击按状态跳到"当前该做的下一步"，可发布不再落回编辑器。
export function workLink(w: { id: string; status: WorkStatus }, platform?: Account['platform']) {
  switch (w.status) {
    case 'checking': return `/works/${w.id}/check`
    case 'pushed': return `/works/${w.id}/push`
    case 'packed': return `/works/${w.id}/pack`
    case 'ready': return `/works/${w.id}/${platform === 'wechat_mp' ? 'push' : 'pack'}`
    default: return `/works/${w.id}`
  }
}

function currentWeek(): [string, string] {
  const d = new Date()
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7))
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6)
  const iso = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
  return [iso(monday), iso(sunday)]
}

function SavedViews({ current, onApply, className }: { current: string; onApply: (query: string) => void; className?: string }) {
  const prefs = usePrefs()
  const save = useSavePrefs()
  const [naming, setNaming] = useState<string | null>(null)
  const views = prefs.saved_views.filter((v) => v.page === 'works')
  const add = () => {
    const name = (naming ?? '').trim()
    if (!name) return
    save.mutate({ saved_views: [...prefs.saved_views, { id: crypto.randomUUID(), name: name.slice(0, 20), page: 'works', query: current }] }, {
      onSuccess: () => { setNaming(null); toast.success('视图已保存') },
      onError: (e) => toast.error(errorMessage(e)),
    })
  }
  const remove = (id: string) => save.mutate({ saved_views: prefs.saved_views.filter((v) => v.id !== id) })
  return (
    <div className={cn('mb-4 flex flex-wrap items-center gap-1.5 text-[12.5px]', className)}>
      <Bookmark className="size-3.5 text-mist-400" />
      {views.map((v) => (
        <span key={v.id} className={cn('group inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5', v.query === current ? 'border-ink-300 bg-ink-50 text-ink-800' : 'border-mist-200 text-mist-600')}>
          <button className="cursor-pointer" onClick={() => onApply(v.query)}>{v.name}</button>
          <button className="cursor-pointer text-mist-400 opacity-0 transition group-hover:opacity-100 hover:text-danger" title="删除视图" onClick={() => remove(v.id)}><X className="size-3" /></button>
        </span>
      ))}
      {naming === null ? (
        <button className="cursor-pointer rounded-full px-2 py-0.5 text-ink-700 hover:bg-ink-50" onClick={() => setNaming('')}>保存当前筛选为视图</button>
      ) : (
        <span className="inline-flex items-center gap-1">
          <Input autoFocus value={naming} maxLength={20} placeholder="视图名称" className="h-7 w-36 text-[12.5px]"
            onChange={(e) => setNaming(e.target.value)} onKeyDown={(e) => { if (isEnterWithoutComposition(e.nativeEvent)) add(); if (e.key === 'Escape') setNaming(null) }} />
          <Button size="sm" variant="secondary" loading={save.isPending} onClick={add}>保存</Button>
          <Button size="sm" variant="ghost" onClick={() => setNaming(null)}>取消</Button>
        </span>
      )}
    </div>
  )
}

function WorkTagsDialog({ work, onClose, onSave }: { work: WorkListItem; onClose: () => void; onSave: (tags: string[]) => void }) {
  const [tags, setTags] = useState(work.tags ?? [])
  const [draft, setDraft] = useState('')
  const add = (e: FormEvent) => {
    e.preventDefault()
    const tag = draft.trim()
    if (!tag || tags.includes(tag)) return
    setTags([...tags, tag])
    setDraft('')
  }
  return (
    <Dialog open onClose={onClose} title="编辑作品标签" desc={work.title || '未命名作品'} width="max-w-md">
      <div className="flex flex-wrap gap-1.5">
        {tags.map((tag) => (
          <span key={tag} className="inline-flex items-center gap-1 rounded-full border border-ink-200 bg-ink-50 px-2.5 py-1 text-xs text-ink-800">
            {tag}
            <button type="button" aria-label={`移除标签 ${tag}`} onClick={() => setTags(tags.filter((item) => item !== tag))} className="cursor-pointer text-ink-500 hover:text-danger">×</button>
          </span>
        ))}
        {tags.length === 0 && <span className="text-xs text-mist-400">尚无标签</span>}
      </div>
      <form onSubmit={add} className="mt-4 flex gap-2">
        <Input aria-label="新增标签" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="输入标签" />
        <Button type="submit" disabled={!draft.trim()}>添加</Button>
      </form>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>取消</Button>
        <Button variant="primary" onClick={() => onSave(tags)}>保存标签</Button>
      </div>
    </Dialog>
  )
}

export default function Works() {
  const nav = useNavigate()
  const [copying, setCopying] = useState<string | null>(null)
  const prefetch = usePrefetchWork()
  const acc = useCurrentAccount()
  const canWrite = useCanWrite()
  const { data: me } = useMe()
  const [params, setParams] = useSearchParams()
  const filter = (params.get('status') as Filter) || 'all'
  const q = params.get('q') ?? ''
  const tag = params.get('tag') ?? ''
  const assignee = params.get('assignee') ?? ''
  const onlyStar = params.get('star') === '1'
  const onlyMine = params.get('mine') === '1'
  const thisWeek = params.get('week') === '1'
  const setParam = (k: string, v: string) => {
    const p = new URLSearchParams(params)
    if (v && v !== 'all') p.set(k, v)
    else p.delete(k)
    setParams(p, { replace: true })
  }
  const setFilter = (f: Filter) => setParam('status', f)
  const setQ = (v: string) => setParam('q', v)
  const sourceView = params.get('source') === 'platform' ? 'platform' : 'local'
  const setSourceView = (value: 'local' | 'platform') => setParam('source', value === 'platform' ? 'platform' : '')
  // NW-A5：头条不再绕行作品页；`?create=1` 只是深链，打开同一个创建面板。
  const createDeepLink = params.get('create') === '1'
  useEffect(() => {
    if (!createDeepLink || !acc || !canWrite) return
    const next = new URLSearchParams(params)
    next.delete('create')
    setParams(next, { replace: true })
    openCreateWork({ accountId: acc.id, platform: acc.platform })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createDeepLink, acc?.id, canWrite])
  const [derive, setDerive] = useState<WorkListItem | null>(null)
  const [tagEditing, setTagEditing] = useState<WorkListItem | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const inv = useInvalidate()
  const create = useCreateWork(acc?.id, acc?.platform)
  // WL-02：列表用 updated_at + id 稳定游标翻页，避免大 offset 漏项；服务端数组契约保持不变。
  const { data, isLoading, isError, error, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: ['works', acc?.id, q],
    queryFn: ({ pageParam }) => getPage<WorkListItem>(`/accounts/${acc!.id}/works?q=${encodeURIComponent(q)}&limit=50${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`),
    initialPageParam: '' as string,
    getNextPageParam: (last) => (last.meta.hasMore ? last.meta.nextCursor ?? undefined : undefined),
    enabled: !!acc,
  })
  const rows = data?.pages.flatMap((page) => page.items) ?? []
  const totalCount = data?.pages[0]?.meta.total ?? rows.length
  const stars = useQuery({ queryKey: ['stars'], queryFn: () => get<StarItem[]>('/stars'), staleTime: 60_000 })
  if (!acc) return <PageLoading />
  const starSet = new Set((stars.data ?? []).filter((s) => s.object_type === 'work').map((s) => s.object_id))
  const toggleStar = async (w: WorkListItem) => {
    try {
      if (starSet.has(w.id)) await del(`/stars/work/${w.id}`)
      else await post('/stars', { object_type: 'work', object_id: w.id })
      void stars.refetch()
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const [weekStart, weekEnd] = currentWeek()
  const list = rows.filter((w) => (!tag || (w.tags ?? []).includes(tag)) && (!assignee || w.assignee_id === assignee) && (!onlyStar || starSet.has(w.id)) && (!onlyMine || (!!me?.user_id && w.assignee_id === me.user_id))
    && (!thisWeek || (!!w.planned_date && w.planned_date.slice(0, 10) >= weekStart && w.planned_date.slice(0, 10) <= weekEnd)))
  const tagOptions = [...new Set([...rows.flatMap((w) => w.tags ?? []), ...(tag ? [tag] : [])])].sort()
  const shown = list.filter((w) => !filterStatus[filter] || filterStatus[filter]!.includes(w.status))
  const count = (f: Filter) => list.filter((w) => !filterStatus[f] || filterStatus[f]!.includes(w.status)).length
  const savedViews = <SavedViews current={params.toString()} onApply={(query) => setParams(new URLSearchParams(query), { replace: true })} />
  const searchField = <div className="relative ml-auto w-full sm:w-64">
    <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-mist-400" />
    <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索标题" className="pl-9" />
  </div>
  const quickFilters = <div className="flex items-center gap-1.5">
    <button onClick={() => setParam('star', onlyStar ? '' : '1')}
      className={cn('inline-flex cursor-pointer items-center gap-1 rounded-full border px-2.5 py-1 text-[12.5px]', onlyStar ? 'border-gamboge-300 bg-gamboge-50 text-gamboge-800' : 'border-mist-200 text-mist-600 hover:border-mist-300')}>
      <Star className="size-3.5" />收藏
    </button>
    <button onClick={() => setParam('mine', onlyMine ? '' : '1')}
      className={cn('inline-flex cursor-pointer items-center gap-1 rounded-full border px-2.5 py-1 text-[12.5px]', onlyMine ? 'border-ink-300 bg-ink-50 text-ink-800' : 'border-mist-200 text-mist-600 hover:border-mist-300')}>
      <UserRound className="size-3.5" />我负责的
    </button>
    <button onClick={() => setParam('week', thisWeek ? '' : '1')} title="计划发布日在本周（周一至周日）的作品"
      className={cn('inline-flex cursor-pointer items-center gap-1 rounded-full border px-2.5 py-1 text-[12.5px]', thisWeek ? 'border-ink-300 bg-ink-50 text-ink-800' : 'border-mist-200 text-mist-600 hover:border-mist-300')}>
      <CalendarDays className="size-3.5" />本周要发
    </button>
  </div>
  const remove = async (w: WorkListItem) => {
    const extra = [
      w.derived_count > 0 && `这篇作品有 ${w.derived_count} 篇衍生作品，它们不受影响，只会显示「源作品已删除」。`,
      (w.status === 'pushed' || w.status === 'published') && acc.platform === 'wechat_mp' && '公众号草稿箱里的草稿不会被删除。',
    ].filter(Boolean)
    await deleteWithUndo('work', w.id, `「${w.title || '未命名作品'}」`, () => inv(['works', acc.id]), extra.join(''))
  }
  const duplicate = async (id: string) => {
    if (copying) return
    setCopying(id)
    try {
      const work = await post<Work>(`/works/${id}/duplicate`)
      inv(['works', acc.id])
      nav(`/works/${work.id}`)
    } catch (e) { toast.error(errorMessage(e)) } finally { setCopying(null) }
  }
  const saveTags = async (tags: string[]) => {
    if (!tagEditing) return
    try {
      await patch(`/works/${tagEditing.id}`, { tags })
      inv(['works', acc.id])
      setTagEditing(null)
      toast.success('标签已保存')
    } catch (e) { toast.error(errorMessage(e)) }
  }
  return (
    <div className="animate-fade-in">
      <PageHeader title="作品" desc={`${acc.name} 的全部作品`} action={sourceView === 'local' && canWrite ? <div className="flex gap-2">
        {acc.platform === 'wechat_mp' && acc.content_format === 'long_article' && <Button variant="secondary" onClick={() => setImportOpen(true)}>导入旧文</Button>}
        <Button variant="primary" icon={<PenLine className="size-4" />} onClick={() => create()}>新建作品</Button>
      </div> : undefined} />
      <div className="mb-5">
        <Tabs role="tablist" ariaLabel="作品来源" value={sourceView} onChange={setSourceView} items={[
          { value: 'local', label: '本地创作' },
          { value: 'platform', label: '平台作品' },
        ]} />
      </div>
      {sourceView === 'platform' ? <PlatformWorksView account={acc} canWrite={canWrite} /> : <>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Tabs role="tablist" ariaLabel="作品状态" value={filter} onChange={setFilter} items={[
          { value: 'all', label: '全部', count: count('all') },
          { value: 'drafting', label: '创作中', count: count('drafting') },
          { value: 'checking', label: '检查中', count: count('checking') },
          { value: 'reviewing', label: '待审阅', count: count('reviewing') },
          { value: 'ready', label: '可发布', count: count('ready') },
          { value: 'out', label: acc.platform === 'wechat_mp' ? '已进草稿箱' : '发布包', count: count('out') },
          { value: 'published', label: '已发布', count: count('published') },
        ]} />
      </div>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1.5">
          {quickFilters}
          <select aria-label="按标签筛选" value={tag} onChange={(e) => setParam('tag', e.target.value)}
            className="h-8 rounded-full border border-mist-200 bg-white px-2.5 text-[12.5px] text-mist-600 outline-none focus:border-ink-300">
            <option value="">全部标签</option>
            {tagOptions.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </div>
        {searchField}
      </div>
      {savedViews}
      {/* XC-04：请求失败要说"加载失败"并可重试，不能显示成"这里还没有作品"。 */}
      {isError ? <PageState loading={false} error={error} onRetry={() => void refetch()} />
        : isLoading ? <PageLoading /> : shown.length === 0 ? (
        <Card><Empty icon={<FileText className="size-5" />} title="这里还没有作品" desc={canWrite ? '从选题池开始，或者直接新建一篇。' : '当前为观察者，只能浏览已有作品。'} action={canWrite ? <EmptyCreateActions create={create} onTopics={() => nav(`/a/${acc.id}/topics`)} /> : undefined} /></Card>
      ) : (
        <Card className="divide-y divide-mist-100">
          {shown.map((w) => {
            const thumb = w.cover_asset_id ?? w.first_asset_id
            return (
              <div key={w.id} className="group flex items-center gap-4 px-5 py-3.5 transition hover:bg-mist-50/70">
                <Link to={workLink(w, acc?.platform)} {...prefetch.hover(w.id)} data-testid="work-row-link" className="flex min-w-0 flex-1 items-center gap-4">
                  <div className="flex h-14 w-20 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-mist-100 text-mist-300">
                    {thumb ? <img src={assetUrl(`/api/v1/assets/${thumb}/file?variant=256`)} className="size-full object-cover" alt="" /> : <ImageIcon className="size-5" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-display text-[15.5px] font-semibold text-mist-900 group-hover:text-ink-700">{w.title || '未命名作品'}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-mist-500">
                      <StatusBadge status={w.status} />
                      {(w.tags ?? []).map((item) => <span key={item} className="rounded-full bg-ink-50 px-2 py-0.5 text-ink-700">{item}</span>)}
                      <span>{w.section_count} 段 · {w.char_count.toLocaleString()} 字</span>
                      {w.source_title !== null && w.source_work_id && <span className="inline-flex items-center gap-1 text-ink-600"><GitBranch className="size-3" />派生自《{w.source_title || '未命名'}》</span>}
                      {w.derived_count > 0 && <span className="inline-flex items-center gap-1"><GitBranch className="size-3" />{w.derived_count} 篇衍生</span>}
                      {!!w.todos_total && (w.todos_done ?? 0) < w.todos_total && (
                        <span className="rounded bg-gamboge-50 px-1.5 py-0.5 text-gamboge-700">后台待办 {w.todos_done ?? 0}/{w.todos_total}</span>
                      )}
                      <span>{relTime(w.updated_at)}更新</span>
                    </div>
                  </div>
                </Link>
                {/* GL-07：ready 行给显式「去发布」次按钮，承诺与入口名称一致。 */}
                {w.status === 'ready' && <Button variant="ghost" size="sm" icon={<Send className="size-3.5" />} onClick={() => nav(workLink(w, acc?.platform))}>去发布</Button>}
                {canWrite && <IconButton label="编辑作品标签" onClick={() => setTagEditing(w)} className="text-mist-400 hover:text-ink-700"><Tag className="size-4" /></IconButton>}
                <IconButton label={starSet.has(w.id) ? '取消收藏' : '收藏'} onClick={() => toggleStar(w)}
                  className={cn(starSet.has(w.id) ? 'text-gamboge-500' : 'opacity-0 transition group-hover:opacity-100')}>
                  <Star className={cn('size-4', starSet.has(w.id) && 'fill-current')} />
                </IconButton>
                {canWrite && (
                  <div className="flex items-center gap-1 opacity-0 transition group-hover:opacity-100">
                    <IconButton label="派生到其他平台" onClick={() => setDerive(w)}><GitBranch className="size-4" /></IconButton>
                    <MoreMenu items={[{ label: '复制为新草稿', icon: <Copy />, disabled: !!copying, loading: copying === w.id, onClick: () => void duplicate(w.id) }]} />
                    <IconButton label="删除" onClick={() => remove(w)} className="hover:text-danger"><Trash2 className="size-4" /></IconButton>
                  </div>
                )}
              </div>
            )
          })}
        </Card>
      )}
      {!isLoading && hasNextPage && (
        <div className="mt-4 flex flex-col items-center gap-1.5">
          <Button variant="secondary" loading={isFetchingNextPage} onClick={() => void fetchNextPage()}>
            加载更多作品
          </Button>
          {/* WL-02：明确告知「看到的是其中一部分」，避免用户以为列表只有这些。 */}
          <span className="text-[11.5px] text-mist-500">已显示 {shown.length} / {totalCount} 篇，还有更多未加载</span>
        </div>
      )}
      {!isLoading && !hasNextPage && totalCount > shown.length && (
        <p className="mt-4 text-center text-[11.5px] text-mist-500">共 {totalCount} 篇，当前筛选显示 {shown.length} 篇</p>
      )}
      {!isLoading && <p className="mt-[14px] text-[11px] text-mist-500">计划发布日只用于提醒；公众号草稿、小红书与头条发布包仍需你在对应平台完成发布。</p>}
      {derive && canWrite && <DeriveDialog open onClose={() => setDerive(null)} workId={derive.id} platform={acc.platform} format={derive.content_format} />}
      {tagEditing && canWrite && <WorkTagsDialog key={tagEditing.id} work={tagEditing} onClose={() => setTagEditing(null)} onSave={saveTags} />}
      {importOpen && canWrite && <WorkImportDialog accountId={acc.id} onClose={() => setImportOpen(false)} onImported={id => { setImportOpen(false); inv(['works', acc.id]); nav(`/works/${id}`) }} />}
      </>}
    </div>
  )
}
