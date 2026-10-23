import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query'
import {
  ArrowRight, BookOpen, CalendarDays, Check, Gauge, Inbox, Layers, Lightbulb, MoreHorizontal, Pencil, Pin, PinOff, Plus, RotateCcw, Search, Sparkles, Trash2, X,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { openCreateWork } from '@/components/create-work-panel'
import { toast } from 'sonner'
import { Dialog, Drawer, confirm } from '@/components/dialog'
import { AIFeedback, RefsNote, sendFeedback } from '@/components/refs'
import { StarButton } from '@/components/star-button'
import { Badge, Button, Card, cn, Empty, Field, platformFormatLabel, HumanGate, IconButton, Input, Notice, PageHeader, PageLoading, PageState, Select, Switch, Tabs, Textarea } from '@/components/ui'
import { InboxPanel } from '@/components/inbox-panel'
import { VoiceButton } from '@/components/voice'
import { aiError } from '@/lib/ai-error'
import { del, errorMessage, get, patch, post } from '@/lib/api'
import { isEnterWithoutComposition } from '@/lib/keyboard'
import { type AIRefs, relTime, runeLen } from '@/lib/format'
import { useCanWrite, useCurrentAccount, useInvalidate } from '@/lib/session'
import { deleteWithUndo } from '@/lib/undo'
import type { ContentFormat, InboxPage, Platform, Series, Topic, TopicPage, Work } from '@/lib/types'

interface Suggestion {
	hot_item_id?: string | null
	source_url?: string
  title: string
  angle: string
  reason: string
  timeliness?: string
  audience?: string
  hook?: string
  needed_materials?: string[]
  format?: string
}

const sourceLabel: Record<Topic['source'], { label: string; tone: 'gray' | 'ink' | 'gamboge' }> = {
  manual: { label: '手动', tone: 'gray' },
  ai: { label: 'AI 建议', tone: 'ink' },
  review: { label: '复盘', tone: 'gamboge' },
  hot: { label: '热点', tone: 'gamboge' },
  inbox: { label: '收件箱', tone: 'gray' },
  plan: { label: '运营大纲', tone: 'ink' },
  daily: { label: '今日推荐', tone: 'ink' },
}

function SuggestionCard({ s, platform, added, adding, addedTopicId, accountId, onAdd, onIgnore, onDone }: { s: Suggestion; platform: Platform; added: boolean; adding: boolean; addedTopicId?: string; accountId?: string; onAdd: () => void; onIgnore?: () => void; onDone?: () => void }) {
  const nav = useNavigate()
  return (
    <div className={cn('rounded-xl border p-4 transition', added ? 'border-ink-200 bg-ink-50/40' : 'border-mist-200 bg-white')}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-display text-[15.5px] font-semibold leading-snug text-mist-900">{s.title}</div>
          {s.timeliness && <div className="mt-1 text-[12px] text-gamboge-700">时效 · {s.timeliness}</div>}
          <div className="mt-1.5 text-[13px] text-mist-600"><span className="text-mist-400">角度 · </span>{s.angle}</div>
          {s.audience && <div className="mt-0.5 text-[13px] text-mist-600"><span className="text-mist-400">读者 · </span>{s.audience}</div>}
          {s.hook && <div className="mt-0.5 text-[13px] text-mist-600"><span className="text-mist-400">钩子 · </span>{s.hook}</div>}
          <div className="mt-0.5 text-[13px] text-mist-500"><span className="text-mist-400">理由 · </span>{s.reason}</div>
          {s.source_url && <a className="text-xs text-ink-600" href={s.source_url} target="_blank" rel="noreferrer">核实热点原文</a>}
          {(s.needed_materials?.length || s.format) && (
            <div className="mt-2 flex flex-wrap gap-1">
              {s.format && <Badge tone="ink">{platformFormatLabel(platform, s.format)}</Badge>}
              {s.needed_materials?.map((m) => <Badge key={m}>需要：{m}</Badge>)}
            </div>
          )}
        </div>
        {added ? (
          // TP-06：入库后要有下一步——直接看这条选题，或用它开始创作。
          <div className="flex shrink-0 flex-col items-end gap-1.5">
            <Badge tone="ink"><Check className="size-3" />已入库</Badge>
            {addedTopicId && <>
              <Button size="sm" variant="ghost" onClick={() => { openCreateWork({ accountId, topicId: addedTopicId }); onDone?.() }}>用它开始创作</Button>
              <Button size="sm" variant="ghost" className="text-mist-400" onClick={() => nav('/topics?tab=adopted')}>查看已采用</Button>
            </>}
          </div>
        ) : (
          <div className="flex shrink-0 flex-col items-end gap-1">
            <Button size="sm" variant="outline" loading={adding} onClick={onAdd} icon={<Plus className="size-3.5" />}>入库</Button>
            {onIgnore && <Button size="sm" variant="ghost" onClick={onIgnore}>忽略</Button>}
          </div>
        )}
      </div>
    </div>
  )
}

function useAddSuggestion(accountId: string, source: string, callId: string | null, seriesId?: string) {
  const inv = useInvalidate()
  const [added, setAdded] = useState<Record<number, boolean>>({})
  // TP-06：记录每条建议入库后生成的选题 id，供"用它开始创作"使用。
  const [topicIDs, setTopicIDs] = useState<Record<number, string>>({})
  const [ignored, setIgnored] = useState<Record<number, boolean>>({})
  const [adding, setAdding] = useState<number | null>(null)
  // 选题建议的去向（10 文档 3.3）：本批一条都没入库时记为放弃；之后再入库会覆盖为接受。
  const ignore = (i: number, sampleText: string) => {
    setIgnored((x) => ({ ...x, [i]: true }))
    if (!Object.values(added).some(Boolean)) sendFeedback(callId, { outcome: 'rejected', sample_text: sampleText })
  }
  // H-01：每条建议单独入库，没有"全部入库"。
  const add = async (i: number, s: Suggestion) => {
    setAdding(i)
    try {
      const r = await post<{ topic: Topic; similar: string[] }>(`/accounts/${accountId}/topics`, {
        title: s.title, angle: s.angle, source, audience: s.audience, hook: s.hook, needed_materials: s.needed_materials, format: s.format, hot_item_id: s.hot_item_id,
        ai_call_id: callId, choice_index: i, ...(seriesId ? { series_id: seriesId } : {}),
      })
      setAdded((a) => ({ ...a, [i]: true }))
      setTopicIDs((ids) => ({ ...ids, [i]: r.topic.id }))
      inv(['topics', accountId], ['series', accountId])
      if (r.similar.length) toast.warning(`已入库。注意与「${r.similar[0]}」相似`)
      else toast.success('已加入选题池')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setAdding(null)
    }
  }
  return { added, adding, add, topicIDs, ignored, ignore, reset: () => { setAdded({}); setTopicIDs({}); setIgnored({}) } }
}

function SuggestDrawer({ open, onClose, accountId, platform, accountFormat }: { open: boolean; onClose: () => void; accountId: string; platform: Platform; accountFormat: string }) {
  const [direction, setDirection] = useState('')
  const [contentFormat, setContentFormat] = useState(accountFormat)
  const [list, setList] = useState<Suggestion[]>([])
  const [refs, setRefs] = useState<AIRefs | null>(null)
  const [callId, setCallId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const s = useAddSuggestion(accountId, 'ai', callId)
  useEffect(() => setContentFormat(accountFormat), [accountFormat])
  const run = async () => {
    setBusy(true)
    try {
      const r = await post<{ suggestions: Suggestion[]; refs: AIRefs; ai_call_id: string }>(`/accounts/${accountId}/topics/suggest`, { direction, ...(platform === 'toutiao' ? { content_format: contentFormat } : {}) })
      setList(r.suggestions)
      setRefs(r.refs)
      setCallId(r.ai_call_id)
      s.reset()
    } catch (e) {
      aiError(e, '生成选题建议', run)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Drawer open={open} onClose={onClose} title="AI 选题建议" desc="建议不会自动进入选题池，需要你逐条挑选。" width="w-[560px]">
      {platform === 'toutiao' && <Field className="mb-3" label="本批选题形态"><Select value={contentFormat} onChange={(e) => setContentFormat(e.target.value)}><option value="long_article">文章</option><option value="micro_post">微头条</option></Select></Field>}
      <div className="flex gap-2">
        <Input value={direction} onChange={(e) => setDirection(e.target.value)} placeholder="方向关键词（可选），例如：时间管理" onKeyDown={(e) => isEnterWithoutComposition(e.nativeEvent) && run()} />
        <Button variant="primary" onClick={run} loading={busy} icon={<Sparkles className="size-4" />}>生成</Button>
      </div>
      <HumanGate code="H-01" className="mt-4">每条建议都需要你单独点「入库」。这里刻意没有「全部入库」。</HumanGate>
      {!busy && <RefsNote refs={refs} callId={callId} sampleText={list.map((x) => [x.title, x.angle].filter(Boolean).join('｜')).join('\n')} className="mt-3" onRetry={run} />}
      <div className="mt-4 space-y-3">
        {busy && list.length === 0 && Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-24 animate-pulse rounded-xl bg-mist-100" />)}
        {list.map((x, i) => s.ignored[i] ? null : <SuggestionCard key={i} platform={platform} s={x} added={!!s.added[i]} adding={s.adding === i} addedTopicId={s.topicIDs[i]} accountId={accountId} onAdd={() => s.add(i, x)} onIgnore={() => s.ignore(i, [x.title, x.angle].filter(Boolean).join('｜'))} onDone={onClose} />)}
        {!busy && list.length === 0 && <Empty icon={<Sparkles className="size-5" />} title="输入一个方向，或直接生成" desc="AI 会参考账号定位档案、已确认的写作记忆和最近的选题，避免重复。" />}
      </div>
    </Drawer>
  )
}

function HotSuggestDrawer({ open, onClose, accountId, platform, accountFormat }: { open: boolean; onClose: () => void; accountId: string; platform: Platform; accountFormat: string }) {
  const [direction, setDirection] = useState('')
  const [contentFormat, setContentFormat] = useState(accountFormat)
  const [context, setContext] = useState('')
  const [list, setList] = useState<Suggestion[]>([])
  const [refs, setRefs] = useState<AIRefs | null>(null)
  const [callId, setCallId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const s = useAddSuggestion(accountId, 'hot', callId)
  useEffect(() => setContentFormat(accountFormat), [accountFormat])
  const run = async () => {
    setBusy(true)
    try {
      const r = await post<{ suggestions: Suggestion[]; refs: AIRefs; ai_call_id?: string }>(`/accounts/${accountId}/topics/hot-suggest`, { direction, context, ...(platform === 'toutiao' ? { content_format: contentFormat } : {}) })
      setList(r.suggestions)
      setRefs(r.refs)
      setCallId(r.ai_call_id ?? null)
      s.reset()
    } catch (e) {
      aiError(e, '生成热点选题', run)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Drawer open={open} onClose={onClose} title="热点选题" desc="使用已匹配的受控来源热点，也可粘贴公开资讯摘要；建议逐条入库。" width="w-[560px]">
      <div className="space-y-3">
        {platform === 'toutiao' && <Field label="本批选题形态"><Select value={contentFormat} onChange={(e) => setContentFormat(e.target.value)}><option value="long_article">文章</option><option value="micro_post">微头条</option></Select></Field>}
        <Field label="方向（可选）">
          <Input value={direction} onChange={(e) => setDirection(e.target.value)} placeholder="例如：职场沟通、育儿" onKeyDown={(e) => isEnterWithoutComposition(e.nativeEvent) && run()} />
        </Field>
        <Field label="公开资讯摘要（可选）" hint="粘贴新闻或公告要点；采集关闭时仍可使用。">
          <Textarea rows={4} value={context} onChange={(e) => setContext(e.target.value)} placeholder="把公开报道或公告的要点贴在这里…" />
        </Field>
        <Button variant="primary" onClick={run} loading={busy} icon={<Sparkles className="size-4" />}>生成热点选题</Button>
      </div>
      <HumanGate code="H-01" className="mt-4">每条建议都需要你单独点「入库」，引用热点前请核实原文。</HumanGate>
      {!busy && <RefsNote refs={refs} callId={callId} sampleText={list.map((x) => [x.title, x.angle].filter(Boolean).join('｜')).join('\n')} className="mt-3" onRetry={run} />}
      <div className="mt-4 space-y-3">
        {busy && list.length === 0 && Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-24 animate-pulse rounded-xl bg-mist-100" />)}
        {list.map((x, i) => s.ignored[i] ? null : <SuggestionCard key={i} platform={platform} s={x} added={!!s.added[i]} adding={s.adding === i} addedTopicId={s.topicIDs[i]} onAdd={() => s.add(i, x)} onIgnore={() => s.ignore(i, [x.title, x.angle].filter(Boolean).join('｜'))} />)}
        {!busy && list.length === 0 && <Empty icon={<Sparkles className="size-5" />} title="生成有时效感的选题" desc="可贴资讯摘要；仍须逐条入库。" />}
      </div>
    </Drawer>
  )
}

function TopicEditDialog({ t, accountFormat, accountPlatform, series, onClose }: { t: Topic; accountFormat: string; accountPlatform: Platform; series: Series[]; onClose: () => void }) {
  const inv = useInvalidate()
  const [f, setF] = useState({
    title: t.title, angle: t.angle, audience: t.audience ?? '', hook: t.hook ?? '', needed: (t.needed_materials ?? []).join('、'),
    format: t.format ?? '', planned_date: t.planned_date ?? '', series_id: t.series_id ?? '',
  })
  const [busy, setBusy] = useState(false)
  const formats = accountPlatform === 'toutiao' ? ['long_article', 'micro_post'] : accountFormat ? [accountFormat] : []
  const save = async () => {
    setBusy(true)
    try {
      await patch(`/topics/${t.id}`, {
        title: f.title, angle: f.angle, audience: f.audience, hook: f.hook, format: f.format, planned_date: f.planned_date, series_id: f.series_id,
        needed_materials: f.needed.split(/[、,，\n]/).map((x) => x.trim()).filter(Boolean),
      })
      inv(['topics', t.account_id ?? ''], ['topics'])
      toast.success('已保存')
      onClose()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open onClose={onClose} title="编辑选题卡" width="max-w-xl"
      footer={<><Button variant="ghost" onClick={onClose}>取消</Button><Button variant="primary" loading={busy} disabled={!f.title.trim()} onClick={save}>保存</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="标题" className="sm:col-span-2"><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <Field label="切入角度" className="sm:col-span-2"><Textarea rows={2} value={f.angle} onChange={(e) => setF({ ...f, angle: e.target.value })} /></Field>
        <Field label="目标读者"><Input value={f.audience} onChange={(e) => setF({ ...f, audience: e.target.value })} placeholder="写给谁看" /></Field>
        <Field label="预计形态">
          <Select value={f.format} onChange={(e) => setF({ ...f, format: e.target.value })}>
            <option value="">未定</option>{formats.map((format) => <option key={format} value={format}>{platformFormatLabel(accountPlatform, format)}</option>)}
          </Select>
        </Field>
        <Field label="钩子" className="sm:col-span-2"><Input value={f.hook} onChange={(e) => setF({ ...f, hook: e.target.value })} placeholder="开头用什么抓住读者" /></Field>
        <Field label="需要的素材" hint="用顿号分隔" className="sm:col-span-2"><Input value={f.needed} onChange={(e) => setF({ ...f, needed: e.target.value })} placeholder="一个亲身案例、一组数据" /></Field>
        <Field label="计划发布日" hint="只用于提醒，不会自动发布"><Input type="date" value={f.planned_date} onChange={(e) => setF({ ...f, planned_date: e.target.value })} /></Field>
        <Field label="所属系列">
          <Select value={f.series_id} onChange={(e) => setF({ ...f, series_id: e.target.value })}>
            <option value="">不属于系列</option>
            {series.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
      </div>
    </Dialog>
  )
}

function ScoreBar({ label, value, tip }: { label: string; value: number | null | undefined; tip?: string }) {
  if (value == null) return null
  return (
    <div className="flex items-center gap-1.5 text-[11px] text-mist-500" title={tip}>
      <span className="w-12 shrink-0">{label}</span>
      <div className="h-1 w-14 overflow-hidden rounded-full bg-mist-100"><div className={cn('h-full rounded-full', value >= 70 ? 'bg-success' : value >= 40 ? 'bg-ink-400' : 'bg-gamboge-400')} style={{ width: `${value}%` }} /></div>
      <span className="tabular-nums">{value}</span>
    </div>
  )
}

function TopicCard({ t, accountId, accountFormat, accountPlatform, series, focused, primed, desktop, selected, onSelect }: { t: Topic; accountId: string; accountFormat: string; accountPlatform: Platform; series: Series[]; focused: boolean; primed?: boolean; desktop?: boolean; selected?: boolean; onSelect?: () => void }) {
  const inv = useInvalidate()
  const qc = useQueryClient()
  const canWrite = useCanWrite()
  const nav = useNavigate()
  const ref = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState(false)
  const [edit, setEdit] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [focused])
  const setStatus = async (status: Topic['status']) => {
    let saved = false
    const key = ['topics', accountId]
    const before = qc.getQueriesData<InfiniteData<TopicPage, string>>({ queryKey: key })
    const update = (data: InfiniteData<TopicPage, string> | undefined, next: Topic, adjustCounts: boolean) => data && ({
      ...data,
      pages: data.pages.map((page, index) => ({
        ...page,
        status_counts: adjustCounts && index === 0 && t.status !== next.status ? {
          ...page.status_counts,
          [t.status]: Math.max(0, page.status_counts[t.status] - 1),
          [next.status]: page.status_counts[next.status] + 1,
        } : page.status_counts,
        items: page.items.map((x) => x.id === next.id ? next : x),
      })),
    })
    qc.setQueriesData<InfiniteData<TopicPage, string>>({ queryKey: key }, (data) => update(data, { ...t, status }, true))
    try {
      const result = await patch<{ topic: Topic }>(`/topics/${t.id}`, { status })
      qc.setQueriesData<InfiniteData<TopicPage, string>>({ queryKey: key }, (data) => update(data, result.topic, false))
      saved = true
    } catch (e) {
      for (const [k, v] of before) qc.setQueryData(k, v)
      toast.error(errorMessage(e))
    }
    return saved
  }
  const drop = async () => {
    setMenu(false)
    const previous = t.status
    if (await setStatus('dropped')) toast(`已放弃选题「${t.title}」`, {
      duration: 10_000,
      action: { label: '撤销', onClick: () => void setStatus(previous) },
    })
  }
  const togglePin = async () => {
    setMenu(false)
    try {
      await patch(`/topics/${t.id}`, { pinned: !t.pinned })
      inv(['topics', accountId])
      toast.success(t.pinned ? '已取消置顶' : '已置顶，排序时始终在最前')
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const start = async () => {
    setBusy(true)
    try {
      const w = await post<Work>(`/topics/${t.id}/works`)
      inv(['topics', accountId])
      nav(`/works/${w.id}`)
    } catch (e) {
      toast.error(errorMessage(e))
      setBusy(false)
    }
  }
  const remove = async () => {
    setMenu(false)
    await deleteWithUndo('topic', t.id, `选题「${t.title}」`, () => inv(['topics', accountId]))
  }
  const sr = series.find((s) => s.id === t.series_id)
  return (
    <div ref={ref}>
      <Card data-testid={desktop ? 'desktop-topic-row' : undefined} className={cn('group relative p-4 transition hover:border-mist-300', focused && 'ring-2 ring-ink-300', desktop && 'desktop-topic-row-card', desktop && selected && 'desktop-topic-row-selected')}>
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className={cn('font-display text-[15px] font-semibold leading-snug text-mist-900', desktop && 'desktop-topic-row-title')}>
              {desktop ? <button type="button" className="desktop-topic-select" aria-pressed={!!selected} onClick={onSelect}>{t.pinned && <Pin className="mr-1 inline size-3.5 -translate-y-px text-ink-500" aria-label="已置顶" />}{t.title}</button> : <>{t.pinned && <Pin className="mr-1 inline size-3.5 -translate-y-px text-ink-500" aria-label="已置顶" />}{t.title}</>}
            </div>
            {t.angle && <p className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-mist-500">{t.angle}</p>}
            {(t.audience || t.hook) && (
              <div className={cn('mt-1.5 space-y-0.5 text-[12.5px] text-mist-500', desktop && 'desktop-topic-row-extra')}>
                {t.audience && <div><span className="text-mist-400">读者 · </span>{t.audience}</div>}
                {t.hook && <div className="line-clamp-1"><span className="text-mist-400">钩子 · </span>{t.hook}</div>}
              </div>
            )}
          </div>
          <StarButton type="topic" id={t.id} className="mt-0.5" />
          {canWrite && (
            <div className="relative">
              <IconButton label="更多" onClick={() => setMenu(!menu)} className="opacity-60 group-hover:opacity-100"><MoreHorizontal className="size-4" /></IconButton>
              {menu && (
                <div className="absolute right-0 top-full z-10 mt-1 w-36 animate-fade-in rounded-lg border border-mist-200 bg-white p-1 shadow-pop" onMouseLeave={() => setMenu(false)}>
                  <button onClick={() => { setMenu(false); setEdit(true) }} className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-mist-50"><Pencil className="size-3.5" />编辑选题卡</button>
                  <button onClick={togglePin} className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-mist-50">{t.pinned ? <><PinOff className="size-3.5" />取消置顶</> : <><Pin className="size-3.5" />置顶</>}</button>
                  {t.status !== 'pending' && <button onClick={() => { setMenu(false); setStatus('pending') }} className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-mist-50"><RotateCcw className="size-3.5" />放回待定</button>}
                  {t.status !== 'dropped' && <button onClick={drop} className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-mist-50"><X className="size-3.5" />放弃</button>}
                  <button onClick={remove} className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-danger hover:bg-orange-50"><Trash2 className="size-3.5" />删除</button>
                </div>
              )}
            </div>
          )}
        </div>
        {((t.needed_materials?.length ?? 0) > 0 || t.format || t.planned_date || sr) && (
          <div className={cn('mt-2 flex flex-wrap gap-1', desktop && 'desktop-topic-row-tags')}>
            {t.format && <Badge tone="ink">{platformFormatLabel(accountPlatform, t.format)}</Badge>}
            {accountPlatform !== 'toutiao' && t.format && accountFormat && t.format !== accountFormat && <Badge tone="red">形态与账号类型不匹配</Badge>}
            {t.planned_date && <Badge tone="gamboge"><CalendarDays className="size-3" />计划 {t.planned_date.slice(5)}</Badge>}
            {sr && <Badge><Layers className="size-3" />{sr.name}</Badge>}
            {t.needed_materials?.slice(0, 3).map((m) => <Badge key={m}>需要：{m}</Badge>)}
          </div>
        )}
        {t.status === 'pending' && (t.score_fit != null || t.score_material != null) && (
          <div className={cn('mt-2.5 space-y-0.5 rounded-lg bg-mist-50/70 px-2.5 py-1.5', desktop && 'desktop-topic-row-scores')}>
            <ScoreBar label="契合度" value={t.score_fit} tip={t.score_reason} />
            <ScoreBar label="素材充足" value={t.score_material} tip="素材库里能支撑这个选题的素材多少" />
            <ScoreBar label="新颖度" value={t.score_novelty} tip="与本账号写过的标题越不像，分越高" />
            {t.score_reason && <p className="pt-0.5 text-[11px] leading-snug text-mist-400">{t.score_reason}</p>}
          </div>
        )}
        <div className={cn('mt-3 flex items-center gap-2', desktop && 'desktop-topic-row-footer')}>
          <Badge tone={sourceLabel[t.source]?.tone ?? 'gray'}>{sourceLabel[t.source]?.label ?? t.source}</Badge>
          <span className="text-xs text-mist-400">{relTime(t.created_at)}</span>
          <div className="ml-auto flex items-center gap-2">
            {canWrite && t.status === 'pending' && <>
              <Button size="sm" variant="primary" loading={busy} onClick={start}>采用并开始写</Button>
              {/* TP-07：两个动作结果不同，按钮文案必须自己说清楚：一个只标记，一个建作品。 */}
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setStatus('adopted')} icon={<Check className="size-3.5" />} title="只把选题标记为已采用，稍后可以再点「开始创作」">采用，稍后写</Button>
            </>}
            {t.status === 'adopted' && (t.work_id
              ? <Link to={`/works/${t.work_id}`}><Button size="sm" variant="ghost">打开作品<ArrowRight className="size-3.5" /></Button></Link>
              : canWrite ? <Button size="sm" variant="primary" loading={busy} onClick={start} className={cn(primed && 'animate-pulse')}>开始创作</Button> : null)}
          </div>
        </div>
        {primed && !t.work_id && canWrite && <p className="mt-2 text-[12px] text-ink-700">这是最早采用、还没开始写的选题，点「开始创作」进入编辑器。</p>}
      </Card>
      {edit && <TopicEditDialog t={{ ...t, account_id: t.account_id ?? accountId }} accountFormat={accountFormat} accountPlatform={accountPlatform} series={series} onClose={() => setEdit(false)} />}
    </div>
  )
}

function SeriesPanel({ accountId, platform, series, topics }: { accountId: string; platform: Platform; series: Series[]; topics: Topic[] }) {
  const canWrite = useCanWrite()
  const inv = useInvalidate()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [outline, setOutline] = useState('')
  const [suggestFor, setSuggestFor] = useState<Series | null>(null)
  const create = async () => {
    try {
      await post(`/accounts/${accountId}/series`, { name, outline })
      inv(['series', accountId])
      setCreating(false)
      setName('')
      setOutline('')
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const remove = async (s: Series) => {
    if (!(await confirm({ title: `删除系列「${s.name}」？`, desc: '系列里的选题不会被删除，只是不再归属这个系列。', danger: true, confirmText: '删除' }))) return
    await del(`/series/${s.id}`)
    inv(['series', accountId], ['topics', accountId])
  }
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-[13px] text-mist-500">把相关选题组成系列，起草时 AI 会参考同系列前后篇的观点，保持连贯。</p>
        {canWrite && <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>新建系列</Button>}
      </div>
      {series.length === 0 ? <Card><Empty icon={<Layers className="size-5" />} title="还没有系列" desc="例如「职场新人 30 天」：先定好系列大纲，再把选题挂进来。"
        action={canWrite ? <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>新建第一个系列</Button> : undefined} /></Card> : (
        <div className="grid gap-4 md:grid-cols-2">
          {series.map((s) => (
            <Card key={s.id} className="p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-display text-[15px] font-semibold text-mist-900">{s.name}</div>
                  {s.outline && <p className="mt-1 line-clamp-3 text-[12.5px] leading-relaxed text-mist-500">{s.outline}</p>}
                </div>
                {canWrite && <IconButton label="删除系列" onClick={() => remove(s)}><Trash2 className="size-3.5" /></IconButton>}
              </div>
              <ol className="mt-3 list-decimal space-y-0.5 pl-5 text-[13px] text-mist-700">
                {topics.filter((t) => t.series_id === s.id).map((t) => <li key={t.id}>{t.title} <span className="text-[11px] text-mist-400">{t.status === 'adopted' ? '已采用' : t.status === 'dropped' ? '已放弃' : ''}</span></li>)}
              </ol>
              {canWrite && <Button size="sm" variant="ghost" className="mt-2" icon={<Sparkles className="size-3.5" />} onClick={() => setSuggestFor(s)}>补全系列选题</Button>}
            </Card>
          ))}
        </div>
      )}
      <Dialog open={creating} onClose={() => setCreating(false)} title="新建系列"
        footer={<><Button variant="ghost" onClick={() => setCreating(false)}>取消</Button><Button variant="primary" disabled={!name.trim()} onClick={create}>创建</Button></>}>
        <div className="space-y-4">
          <Field label="系列名称"><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：新人职场生存手册" /></Field>
          <Field label="总纲（可选）" hint="这个系列想讲清楚什么、分几块"><Textarea rows={4} value={outline} onChange={(e) => setOutline(e.target.value)} /></Field>
        </div>
      </Dialog>
      {suggestFor && <SeriesSuggestDrawer platform={platform} s={suggestFor} accountId={accountId} onClose={() => setSuggestFor(null)} />}
    </div>
  )
}

function SeriesSuggestDrawer({ s, platform, accountId, onClose }: { s: Series; platform: Platform; accountId: string; onClose: () => void }) {
  const [list, setList] = useState<Suggestion[]>([])
  const [callId, setCallId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const add = useAddSuggestion(accountId, 'ai', callId, s.id)
  const run = async () => {
    setBusy(true)
    try {
      const r = await post<{ topics: Suggestion[]; ai_call_id: string }>(`/series/${s.id}/suggest`)
      setList(r.topics)
      setCallId(r.ai_call_id)
      add.reset()
    } catch (e) {
      aiError(e, '补全系列选题', run)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Drawer open onClose={onClose} title={`补全「${s.name}」`} desc="根据总纲找出系列里还缺的选题，逐条入库。">
      <Button variant="primary" loading={busy} icon={<Sparkles className="size-4" />} onClick={run}>{list.length ? '换一批' : '生成建议'}</Button>
      {callId && <div className="mt-2"><AIFeedback callId={callId} sampleText={list.map((x) => [x.title, x.angle].filter(Boolean).join('｜')).join('\n')} /></div>}
      <div className="mt-4 space-y-3">
        {list.map((x, i) => add.ignored[i] ? null : <SuggestionCard key={i} platform={platform} s={x} added={!!add.added[i]} adding={add.adding === i} addedTopicId={add.topicIDs[i]} accountId={accountId} onAdd={() => add.add(i, x)} onIgnore={() => add.ignore(i, [x.title, x.angle].filter(Boolean).join('｜'))} onDone={onClose} />)}
      </div>
    </Drawer>
  )
}

type Tab = Topic['status'] | 'inbox' | 'series'

export default function Topics() {
  const acc = useCurrentAccount()
  const canWrite = useCanWrite()
  const [params, setParams] = useSearchParams()
  const tab: Tab = ['pending', 'adopted', 'dropped', 'inbox', 'series'].includes(params.get('tab') ?? '') ? params.get('tab') as Tab : 'pending'
  const setTab = (value: Tab) => {
    if (tab === value) return
    const next = new URLSearchParams(params)
    if (value === 'pending') next.delete('tab')
    else next.set('tab', value)
    setParams(next, { replace: true })
  }
  const [suggest, setSuggest] = useState(params.get('suggest') === '1')
  const [hotSuggest, setHotSuggest] = useState(params.get('hot') === '1')
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')
  const [angle, setAngle] = useState('')
  const [topicFormat, setTopicFormat] = useState(acc?.content_format ?? 'long_article')
  const [similar, setSimilar] = useState<string[]>([])
  const [byScore, setByScore] = useState(false)
  const [scoring, setScoring] = useState(false)
  const [detailBusy, setDetailBusy] = useState(false)
  const nav = useNavigate()
  const desktopPresentation = document.documentElement.dataset.presentation === 'ops-creative-desktop'
  const [topicSearch, setTopicSearch] = useState(params.get('q') ?? '')
  const [sourceFilter, setSourceFilter] = useState(params.get('source') ?? 'all')
  const [selectedTopicId, setSelectedTopicId] = useState<string | null>(null)
  const startId = params.get('start')
  const focus = params.get('focus') || startId
  const inv = useInvalidate()
  const topicQuery = useInfiniteQuery({
    queryKey: ['topics', acc?.id, byScore, params.get('q') ?? ''],
    queryFn: ({ pageParam }) => get<TopicPage>(`/accounts/${acc!.id}/topics?limit=50&scores=1${byScore ? '&sort=score' : ''}${params.get('q') ? `&q=${encodeURIComponent(params.get('q')!)}` : ''}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`),
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: !!acc,
  })
  const series = useQuery({ queryKey: ['series', acc?.id], queryFn: () => get<Series[]>(`/accounts/${acc!.id}/series`), enabled: !!acc })
  const inbox = useInfiniteQuery({
    queryKey: ['inbox'],
    queryFn: ({ pageParam }) => get<InboxPage>(`/inbox${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ''}`),
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: !!acc,
  })
  useEffect(() => {
    if (params.get('suggest') || params.get('new') || params.get('hot')) {
      if (params.get('hot') === '1') setHotSuggest(true)
      if (params.get('new')) {
        setSimilar([])
        setTitle(params.get('title') ?? '')
        setTopicFormat(acc?.content_format ?? 'long_article')
        setAdding(true)
      }
      const n = new URLSearchParams(params)
      for (const k of ['suggest', 'new', 'title', 'hot']) n.delete(k)
      setParams(n, { replace: true })
    }
  }, [params, setParams, acc?.content_format])
  const data = topicQuery.data?.pages.flatMap((page) => page.items)
  useEffect(() => {
    setSourceFilter(params.get('source') ?? 'all')
  }, [params])
  useEffect(() => {
    if (focus && data) {
      const t = data.find((x) => x.id === focus)
      if (t) setTab(t.status)
      else if (topicQuery.hasNextPage && !topicQuery.isFetchingNextPage) void topicQuery.fetchNextPage()
    }
  }, [focus, data, topicQuery.hasNextPage, topicQuery.isFetchingNextPage, topicQuery.fetchNextPage])
  if (!acc || topicQuery.isLoading) return <PageLoading />
  // XC-04：选题请求失败要区分"加载失败"和"没有选题"。
  if (topicQuery.isError) {
    return <div className="mx-auto max-w-2xl px-6 py-16"><PageState loading={false} error={topicQuery.error}
      onRetry={() => void topicQuery.refetch()} emptyTitle="这里还没有选题" /></div>
  }
  const list = data ?? []
  const counts = topicQuery.data?.pages[0]?.status_counts
  const shown = list.filter((t) => t.status === tab)
  // TP-04：`q` 已由服务端过滤（见 server listTopics），这里只保留来源筛选与 URL 同步。
  const desktopShown = shown.filter((t) => sourceFilter === 'all' || t.source === sourceFilter)
  const selectedTopic = desktopShown.find((t) => t.id === selectedTopicId) ?? desktopShown.find((t) => t.id === focus) ?? desktopShown[0]
  const updateDesktopFilter = (key: 'q' | 'source', value: string) => {
    const next = new URLSearchParams(params)
    if (!value || (key === 'source' && value === 'all')) next.delete(key)
    else next.set(key, value)
    setParams(next, { replace: true })
  }
  const save = async () => {
    try {
      const r = await post<{ topic: Topic; similar: string[] }>(`/accounts/${acc.id}/topics`, { title, angle, ...(acc.platform === 'toutiao' ? { format: topicFormat } : {}) })
      inv(['topics', acc.id])
      setSimilar(r.similar)
      setTitle('')
      setAngle('')
      if (r.similar.length === 0) setAdding(false)
      toast.success('已加入选题池')
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const openAddTopic = () => {
    setSimilar([])
    setTitle('')
    setAngle('')
    setTopicFormat(acc.content_format)
    setAdding(true)
  }
  const score = async () => {
    setScoring(true)
    try {
      const r = await post<{ job_id: string | null; count: number }>(`/accounts/${acc.id}/topics/score`)
      if (!r.count) toast.info('待定选题都已评过分了')
      else toast.success(`正在后台为 ${r.count} 个选题评估契合度`, { description: '完成后会在右上角通知你，可以先去做别的。' })
    } catch (e) {
      aiError(e, '选题契合度评估', score)
    } finally {
      setScoring(false)
    }
  }
  // TP-03：详情栏主操作与列表卡片共用同一组接口，避免"读完详情还要回左边找按钮"。
  const detailStart = async (t: Topic) => {
    setDetailBusy(true)
    try {
      const w = await post<Work>(`/topics/${t.id}/works`)
      inv(['topics', acc.id])
      nav(`/works/${w.id}`)
    } catch (e) {
      toast.error(errorMessage(e))
      setDetailBusy(false)
    }
  }
  const detailStatus = async (t: Topic, status: Topic['status']) => {
    setDetailBusy(true)
    try {
      await patch<{ topic: Topic }>(`/topics/${t.id}`, { status })
      inv(['topics', acc.id])
      toast.success('已标记为已采用，稍后再写。')
    } catch (e) {
      toast.error(errorMessage(e))
      setDetailBusy(false)
    }
  }
  return (
    <div className={cn('animate-fade-in', desktopPresentation && 'desktop-topics-page')}>
      <PageHeader title="选题池" desc={desktopPresentation ? '先存下想法，再决定哪一条值得开始。' : '先把想法存下来，采用后再开始创作。'}
        action={canWrite ? <>
          {desktopPresentation ? <>
            <Button icon={<Sparkles className="size-4" />} onClick={() => setSuggest(true)}>AI 选题建议</Button>
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={openAddTopic}>添加选题</Button>
          </> : <>
            <Button icon={<Plus className="size-4" />} onClick={openAddTopic}>手动添加</Button>
            <Button icon={<Sparkles className="size-4" />} onClick={() => setHotSuggest(true)}>热点选题</Button>
            <Button variant="primary" icon={<Sparkles className="size-4" />} onClick={() => setSuggest(true)}>AI 选题建议</Button>
          </>}
        </> : undefined} />
      <div className={cn('mb-5 flex flex-wrap items-center gap-3', desktopPresentation && 'desktop-topic-tabs')}>
        <Tabs value={tab} onChange={setTab} items={[
          { value: 'pending', label: '待定', count: counts?.pending },
          { value: 'adopted', label: '已采用', count: desktopPresentation ? undefined : counts?.adopted },
          { value: 'dropped', label: '已放弃', count: desktopPresentation ? undefined : counts?.dropped },
          { value: 'inbox', label: desktopPresentation ? '收件箱' : <span className="inline-flex items-center gap-1"><Inbox className="size-3.5" />收件箱</span>, count: desktopPresentation ? undefined : inbox.data?.pages[0]?.total || undefined },
          { value: 'series', label: desktopPresentation ? '系列' : <span className="inline-flex items-center gap-1"><Layers className="size-3.5" />系列</span>, count: desktopPresentation ? undefined : series.data?.length || undefined },
        ]} />
        {tab === 'pending' && !desktopPresentation && (
          <div className="ml-auto flex items-center gap-3">
            <label className="flex items-center gap-2 text-[12.5px] text-mist-600"><Switch checked={byScore} onChange={setByScore} />按评分排序</label>
            {canWrite && <Button size="sm" icon={<Gauge className="size-3.5" />} loading={scoring} onClick={score}>AI 评估契合度</Button>}
          </div>
        )}
      </div>
      {desktopPresentation && tab !== 'inbox' && tab !== 'series' && <div className="desktop-topic-filterbar">
        <label className="desktop-topic-search"><Search aria-hidden="true" /><Input aria-label="搜索选题" value={topicSearch} onChange={(e) => { setTopicSearch(e.target.value); updateDesktopFilter('q', e.target.value) }} placeholder="搜索全部选题" /></label>
        <Select aria-label="选题来源" value={sourceFilter} onChange={(e) => { setSourceFilter(e.target.value); updateDesktopFilter('source', e.target.value) }}>
          <option value="all">全部来源</option><option value="manual">手动</option><option value="ai">AI 建议</option><option value="hot">热点</option><option value="review">复盘</option><option value="daily">每日推荐</option>
        </Select>
        {tab === 'pending' && <div className="desktop-topic-scorectl">
          <label className="flex items-center gap-2 text-[12.5px] text-mist-600"><Switch checked={byScore} onChange={setByScore} />按评分排序</label>
          {canWrite && <Button size="sm" icon={<Gauge className="size-3.5" />} loading={scoring} onClick={score}>AI 评估契合度</Button>}
        </div>}
      </div>}
      {desktopPresentation ? <div className="desktop-topic-layout" data-testid="desktop-topics-layout">
        <section className="desktop-topic-list" data-testid="desktop-topic-list" aria-label="选题列表">
          {tab === 'inbox' ? <InboxPanel accountId={acc.id} /> : tab === 'series' ? <SeriesPanel platform={acc.platform} accountId={acc.id} series={series.data ?? []} topics={list} /> : desktopShown.length === 0 ? (
            <Empty className="desktop-topic-empty" icon={<Lightbulb className="size-5" />} title={topicSearch || sourceFilter !== 'all' ? '没有符合筛选条件的选题' : tab === 'pending' ? '还没有待定的选题' : tab === 'adopted' ? '还没有采用的选题' : '没有放弃的选题'}
              desc={topicSearch || sourceFilter !== 'all' ? '试试调整关键词或来源。' : tab === 'pending' ? '手动记下一个想法，或者让 AI 根据账号定位给些建议。' : undefined}
              action={canWrite && tab === 'pending' ? <div className="flex flex-wrap justify-center gap-2"><Button variant="primary" icon={<Sparkles className="size-4" />} onClick={() => setSuggest(true)}>AI 选题建议</Button><Button icon={<Plus className="size-4" />} onClick={openAddTopic}>手动添加</Button></div> : undefined} />
          ) : <>
            {tab === 'pending' && byScore && <p className="desktop-topic-score-note"><BookOpen className="mr-1 inline size-3.5" />综合排序 = 契合度、素材充足度、新颖度的加权；只是参考，不预测阅读量。</p>}
            {desktopShown.map((t) => <TopicCard key={t.id} t={t} accountId={acc.id} accountFormat={acc.content_format} accountPlatform={acc.platform} series={series.data ?? []} focused={t.id === focus} primed={t.id === startId} desktop selected={t.id === selectedTopic?.id} onSelect={() => setSelectedTopicId(t.id)} />)}
          </>}
          {tab !== 'inbox' && topicQuery.hasNextPage && <div className="desktop-topic-load-more"><Button variant="outline" loading={topicQuery.isFetchingNextPage} onClick={() => void topicQuery.fetchNextPage()}>加载更多选题</Button></div>}
        </section>
        <aside className="desktop-topic-details" data-testid="desktop-topic-details" aria-label="选题详情">
          {selectedTopic ? <>
            <div className="desktop-topic-eyebrow">选题详情</div>
            <h2>{selectedTopic.title}</h2>
            <p><span>角度：</span>{selectedTopic.angle || '还没有补充切入角度。'}</p>
            <div className="desktop-topic-detail-badges"><Badge tone={sourceLabel[selectedTopic.source]?.tone ?? 'gray'}>{sourceLabel[selectedTopic.source]?.label ?? selectedTopic.source}</Badge><Badge tone={selectedTopic.status === 'pending' ? 'gamboge' : selectedTopic.status === 'adopted' ? 'green' : 'gray'}>{selectedTopic.status === 'pending' ? '待定' : selectedTopic.status === 'adopted' ? '已采用' : '已放弃'}</Badge></div>
            <div className="desktop-topic-divider" />
            <h3>参考与来源</h3>
            <dl className="desktop-topic-detail-meta">
              <div><dt>目标读者</dt><dd>{selectedTopic.audience || '尚未填写'}</dd></div>
              <div><dt>开篇钩子</dt><dd>{selectedTopic.hook || '尚未填写'}</dd></div>
              <div><dt>选题来源</dt><dd>{sourceLabel[selectedTopic.source]?.label ?? selectedTopic.source} · {relTime(selectedTopic.created_at)}</dd></div>
              {selectedTopic.strategy_pillar && <div><dt>账号定位</dt><dd>{selectedTopic.strategy_pillar}</dd></div>}
              {selectedTopic.needed_materials?.length ? <div><dt>需要的素材</dt><dd>{selectedTopic.needed_materials.join('、')}</dd></div> : null}
              {selectedTopic.planned_date && <div><dt>计划日期</dt><dd>{selectedTopic.planned_date}</dd></div>}
              {selectedTopic.series_id && <div><dt>所属系列</dt><dd>{series.data?.find((s) => s.id === selectedTopic.series_id)?.name ?? '系列'}</dd></div>}
            </dl>
            {selectedTopic.status === 'pending' && (selectedTopic.score_fit != null || selectedTopic.score_material != null) && <div className="desktop-topic-detail-scores"><ScoreBar label="契合度" value={selectedTopic.score_fit} tip={selectedTopic.score_reason} /><ScoreBar label="素材充足" value={selectedTopic.score_material} tip="素材库里能支撑这个选题的素材多少" /><ScoreBar label="新颖度" value={selectedTopic.score_novelty} tip="与本账号写过的标题越不像，分越高" /></div>}
            <p className="desktop-topic-detail-hint">采用不会自动确认观点、大纲或起草正文。</p>
            <div className="desktop-topic-detail-footer">
              {canWrite && selectedTopic.status === 'pending' && <>
                <Button size="sm" variant="primary" loading={detailBusy} onClick={() => void detailStart(selectedTopic)}>采用并开始写</Button>
                <Button size="sm" variant="ghost" disabled={detailBusy} onClick={() => void detailStatus(selectedTopic, 'adopted')} icon={<Check className="size-3.5" />} title="只把选题标记为已采用，稍后可以再点「开始创作」">采用，稍后写</Button>
              </>}
              {selectedTopic.status === 'adopted' && (selectedTopic.work_id
                ? <Link to={`/works/${selectedTopic.work_id}`}><Button size="sm" variant="ghost">打开作品<ArrowRight className="size-3.5" /></Button></Link>
                : canWrite ? <Button size="sm" variant="primary" loading={detailBusy} onClick={() => void detailStart(selectedTopic)}>开始创作</Button> : null)}
            </div>
          </> : <div className="desktop-topic-detail-empty"><div className="desktop-topic-detail-icon"><Lightbulb className="size-5" /></div><h2>{tab === 'series' ? '系列与选题' : tab === 'inbox' ? '灵感收件箱' : '选题详情'}</h2><p>{tab === 'series' ? '把相关选题组成系列，起草时可以参考前后篇的观点。' : tab === 'inbox' ? '逐条整理收件箱里的灵感，再决定转成选题还是素材。' : '选择一条选题，在这里查看角度、参考与来源。'}</p></div>}
        </aside>
      </div> : tab === 'inbox' ? <InboxPanel accountId={acc.id} /> : tab === 'series' ? <SeriesPanel platform={acc.platform} accountId={acc.id} series={series.data ?? []} topics={list} /> : shown.length === 0 ? (
        <Card><Empty icon={<Lightbulb className="size-5" />} title={tab === 'pending' ? '还没有待定的选题' : tab === 'adopted' ? '还没有采用的选题' : '没有放弃的选题'}
          desc={tab === 'pending' ? '手动记下一个想法，或者让 AI 根据账号定位给些建议。' : undefined}
          action={canWrite && tab === 'pending' ? <Button variant="primary" icon={<Sparkles className="size-4" />} onClick={() => setSuggest(true)}>AI 选题建议</Button> : undefined} /></Card>
      ) : (
        <>
          {tab === 'pending' && byScore && <p className="mb-3 text-[12px] text-mist-400"><BookOpen className="mr-1 inline size-3.5" />综合排序 = 契合度、素材充足度、新颖度的加权；只是参考，不预测阅读量。</p>}
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{shown.map((t) => <TopicCard key={t.id} t={t} accountId={acc.id} accountFormat={acc.content_format} accountPlatform={acc.platform} series={series.data ?? []} focused={t.id === focus} primed={t.id === startId} />)}</div>
        </>
      )}
      {!desktopPresentation && tab !== 'inbox' && topicQuery.hasNextPage && <div className="mt-5 flex justify-center"><Button variant="outline" loading={topicQuery.isFetchingNextPage} onClick={() => void topicQuery.fetchNextPage()}>加载更多选题</Button></div>}
      <SuggestDrawer open={suggest} onClose={() => setSuggest(false)} accountId={acc.id} platform={acc.platform} accountFormat={acc.content_format} />
      <HotSuggestDrawer open={hotSuggest} onClose={() => setHotSuggest(false)} accountId={acc.id} platform={acc.platform} accountFormat={acc.content_format} />
      <Dialog open={adding} onClose={() => setAdding(false)} title="添加选题"
        footer={<><Button variant="ghost" onClick={() => setAdding(false)}>{similar.length ? '完成' : '取消'}</Button><Button variant="primary" onClick={save} disabled={!title.trim()}>加入选题池</Button></>}>
        <div className="space-y-4">
          <Field label={<span className="flex items-center justify-between">标题<VoiceButton onText={(t) => setTitle((v) => v + t)} /></span>} counter={{ value: runeLen(title), max: 80 }}><Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (isEnterWithoutComposition(e.nativeEvent) && title.trim()) { e.preventDefault(); void save() } }} /></Field>
          <Field label="切入角度（可选）"><Textarea rows={3} value={angle} onChange={(e) => setAngle(e.target.value)} /></Field>
          {acc.platform === 'toutiao' && <Field label="预计形态"><Select value={topicFormat} onChange={(e) => setTopicFormat(e.target.value as ContentFormat)}><option value="long_article">文章</option><option value="micro_post">微头条</option></Select></Field>}
          {similar.length > 0 && <Notice tone="gamboge">刚才入库的选题与「{similar.join('」「')}」相似，可以继续保留，也可以去删掉。</Notice>}
          <p className="text-[12px] text-mist-400">入库后可在卡片菜单里补充读者、钩子、需要的素材和计划发布日。</p>
        </div>
      </Dialog>
    </div>
  )
}
