import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowRight, BookOpen, CalendarDays, Check, Gauge, Inbox, Layers, Lightbulb, MoreHorizontal, Pencil, Pin, PinOff, Plus, RotateCcw, Sparkles, Trash2, Wand2, X,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { Dialog, Drawer, confirm } from '@/components/dialog'
import { AIFeedback, RefsNote, sendFeedback } from '@/components/refs'
import { StarButton } from '@/components/star-button'
import { Badge, Button, Card, cn, Empty, Field, HumanGate, IconButton, Input, Notice, PageHeader, PageLoading, Select, Switch, Tabs, Textarea } from '@/components/ui'
import { openQuickCollect } from '@/components/quick-collect'
import { VoiceButton } from '@/components/voice'
import { aiError } from '@/lib/ai-error'
import { del, errorMessage, get, patch, post } from '@/lib/api'
import { type AIRefs, relTime } from '@/lib/format'
import { useCanWrite, useCurrentAccount, useInvalidate } from '@/lib/session'
import { deleteWithUndo } from '@/lib/undo'
import type { InboxItem, InboxSuggestion, MaterialKind, Series, Topic, Work } from '@/lib/types'

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
const formatLabel: Record<string, string> = { long_article: '长图文', image_note: '图文笔记', comic: '漫画' }

function SuggestionCard({ s, added, adding, onAdd, onIgnore }: { s: Suggestion; added: boolean; adding: boolean; onAdd: () => void; onIgnore?: () => void }) {
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
              {s.format && <Badge tone="ink">{formatLabel[s.format] ?? s.format}</Badge>}
              {s.needed_materials?.map((m) => <Badge key={m}>需要：{m}</Badge>)}
            </div>
          )}
        </div>
        {added ? (
          <Badge tone="ink"><Check className="size-3" />已入库</Badge>
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
  const [ignored, setIgnored] = useState<Record<number, boolean>>({})
  const [adding, setAdding] = useState<number | null>(null)
  // 选题建议的去向（10 文档 3.3）：本批一条都没入库时记为放弃；之后再入库会覆盖为接受。
  const ignore = (i: number) => {
    setIgnored((x) => ({ ...x, [i]: true }))
    if (!Object.values(added).some(Boolean)) sendFeedback(callId, { outcome: 'rejected' })
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
      inv(['topics', accountId], ['series', accountId])
      if (r.similar.length) toast.warning(`已入库。注意与「${r.similar[0]}」相似`)
      else toast.success('已加入选题池')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setAdding(null)
    }
  }
  return { added, adding, add, ignored, ignore, reset: () => { setAdded({}); setIgnored({}) } }
}

function SuggestDrawer({ open, onClose, accountId }: { open: boolean; onClose: () => void; accountId: string }) {
  const [direction, setDirection] = useState('')
  const [list, setList] = useState<Suggestion[]>([])
  const [refs, setRefs] = useState<AIRefs | null>(null)
  const [callId, setCallId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const s = useAddSuggestion(accountId, 'ai', callId)
  const run = async () => {
    setBusy(true)
    try {
      const r = await post<{ suggestions: Suggestion[]; refs: AIRefs; ai_call_id: string }>(`/accounts/${accountId}/topics/suggest`, { direction })
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
      <div className="flex gap-2">
        <Input value={direction} onChange={(e) => setDirection(e.target.value)} placeholder="方向关键词（可选），例如：时间管理" onKeyDown={(e) => e.key === 'Enter' && run()} />
        <Button variant="primary" onClick={run} loading={busy} icon={<Sparkles className="size-4" />}>生成</Button>
      </div>
      <HumanGate code="H-01" className="mt-4">每条建议都需要你单独点「入库」。这里刻意没有「全部入库」。</HumanGate>
      {!busy && <RefsNote refs={refs} callId={callId} className="mt-3" onRetry={run} />}
      <div className="mt-4 space-y-3">
        {busy && list.length === 0 && Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-24 animate-pulse rounded-xl bg-mist-100" />)}
        {list.map((x, i) => s.ignored[i] ? null : <SuggestionCard key={i} s={x} added={!!s.added[i]} adding={s.adding === i} onAdd={() => s.add(i, x)} onIgnore={() => s.ignore(i)} />)}
        {!busy && list.length === 0 && <Empty icon={<Sparkles className="size-5" />} title="输入一个方向，或直接生成" desc="AI 会参考账号定位档案、已确认的写作记忆和最近的选题，避免重复。" />}
      </div>
    </Drawer>
  )
}

function HotSuggestDrawer({ open, onClose, accountId }: { open: boolean; onClose: () => void; accountId: string }) {
  const [direction, setDirection] = useState('')
  const [context, setContext] = useState('')
  const [list, setList] = useState<Suggestion[]>([])
  const [refs, setRefs] = useState<AIRefs | null>(null)
  const [callId, setCallId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const s = useAddSuggestion(accountId, 'hot', callId)
  const run = async () => {
    setBusy(true)
    try {
      const r = await post<{ suggestions: Suggestion[]; refs: AIRefs; ai_call_id?: string }>(`/accounts/${accountId}/topics/hot-suggest`, { direction, context })
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
        <Field label="方向（可选）">
          <Input value={direction} onChange={(e) => setDirection(e.target.value)} placeholder="例如：职场沟通、育儿" onKeyDown={(e) => e.key === 'Enter' && run()} />
        </Field>
        <Field label="公开资讯摘要（可选）" hint="粘贴新闻或公告要点；采集关闭时仍可使用。">
          <Textarea rows={4} value={context} onChange={(e) => setContext(e.target.value)} placeholder="把公开报道或公告的要点贴在这里…" />
        </Field>
        <Button variant="primary" onClick={run} loading={busy} icon={<Sparkles className="size-4" />}>生成热点选题</Button>
      </div>
      <HumanGate code="H-01" className="mt-4">每条建议都需要你单独点「入库」，引用热点前请核实原文。</HumanGate>
      {!busy && <RefsNote refs={refs} callId={callId} className="mt-3" onRetry={run} />}
      <div className="mt-4 space-y-3">
        {busy && list.length === 0 && Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-24 animate-pulse rounded-xl bg-mist-100" />)}
        {list.map((x, i) => s.ignored[i] ? null : <SuggestionCard key={i} s={x} added={!!s.added[i]} adding={s.adding === i} onAdd={() => s.add(i, x)} onIgnore={() => s.ignore(i)} />)}
        {!busy && list.length === 0 && <Empty icon={<Sparkles className="size-5" />} title="生成有时效感的选题" desc="可贴资讯摘要；仍须逐条入库。" />}
      </div>
    </Drawer>
  )
}

function TopicEditDialog({ t, series, onClose }: { t: Topic; series: Series[]; onClose: () => void }) {
  const inv = useInvalidate()
  const [f, setF] = useState({
    title: t.title, angle: t.angle, audience: t.audience ?? '', hook: t.hook ?? '', needed: (t.needed_materials ?? []).join('、'),
    format: t.format ?? '', planned_date: t.planned_date ?? '', series_id: t.series_id ?? '',
  })
  const [busy, setBusy] = useState(false)
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
            <option value="">未定</option><option value="long_article">长图文</option><option value="image_note">图文笔记</option><option value="comic">漫画</option>
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

function TopicCard({ t, accountId, series, focused, primed }: { t: Topic; accountId: string; series: Series[]; focused: boolean; primed?: boolean }) {
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
    const key = ['topics', accountId]
    const before = qc.getQueriesData<Topic[]>({ queryKey: key })
    qc.setQueriesData<Topic[]>({ queryKey: key }, (list) => list?.map((x) => (x.id === t.id ? { ...x, status } : x)))
    try {
      await patch(`/topics/${t.id}`, { status })
    } catch (e) {
      for (const [k, v] of before) qc.setQueryData(k, v)
      toast.error(errorMessage(e))
    }
    inv(key)
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
      <Card className={cn('group relative p-4 transition hover:border-mist-300', focused && 'ring-2 ring-ink-300')}>
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="font-display text-[15px] font-semibold leading-snug text-mist-900">
              {t.pinned && <Pin className="mr-1 inline size-3.5 -translate-y-px text-ink-500" aria-label="已置顶" />}{t.title}
            </div>
            {t.angle && <p className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-mist-500">{t.angle}</p>}
            {(t.audience || t.hook) && (
              <div className="mt-1.5 space-y-0.5 text-[12.5px] text-mist-500">
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
                  {t.status !== 'dropped' && <button onClick={() => { setMenu(false); setStatus('dropped') }} className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-mist-50"><X className="size-3.5" />放弃</button>}
                  <button onClick={remove} className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-danger hover:bg-orange-50"><Trash2 className="size-3.5" />删除</button>
                </div>
              )}
            </div>
          )}
        </div>
        {((t.needed_materials?.length ?? 0) > 0 || t.format || t.planned_date || sr) && (
          <div className="mt-2 flex flex-wrap gap-1">
            {t.format && <Badge tone="ink">{formatLabel[t.format] ?? t.format}</Badge>}
            {t.planned_date && <Badge tone="gamboge"><CalendarDays className="size-3" />计划 {t.planned_date.slice(5)}</Badge>}
            {sr && <Badge><Layers className="size-3" />{sr.name}</Badge>}
            {t.needed_materials?.slice(0, 3).map((m) => <Badge key={m}>需要：{m}</Badge>)}
          </div>
        )}
        {t.status === 'pending' && (t.score_fit != null || t.score_material != null) && (
          <div className="mt-2.5 space-y-0.5 rounded-lg bg-mist-50/70 px-2.5 py-1.5">
            <ScoreBar label="契合度" value={t.score_fit} tip={t.score_reason} />
            <ScoreBar label="素材充足" value={t.score_material} tip="素材库里能支撑这个选题的素材多少" />
            <ScoreBar label="新颖度" value={t.score_novelty} tip="与本账号写过的标题越不像，分越高" />
            {t.score_reason && <p className="pt-0.5 text-[11px] leading-snug text-mist-400">{t.score_reason}</p>}
          </div>
        )}
        <div className="mt-3 flex items-center gap-2">
          <Badge tone={sourceLabel[t.source]?.tone ?? 'gray'}>{sourceLabel[t.source]?.label ?? t.source}</Badge>
          <span className="text-xs text-mist-400">{relTime(t.created_at)}</span>
          <div className="ml-auto">
            {canWrite && t.status === 'pending' && <Button size="sm" variant="ghost" onClick={() => setStatus('adopted')} icon={<Check className="size-3.5" />}>采用</Button>}
            {t.status === 'adopted' && (t.work_id
              ? <Link to={`/works/${t.work_id}`}><Button size="sm" variant="ghost">打开作品<ArrowRight className="size-3.5" /></Button></Link>
              : canWrite ? <Button size="sm" variant="primary" loading={busy} onClick={start} className={cn(primed && 'animate-pulse')}>开始创作</Button> : null)}
          </div>
        </div>
        {primed && !t.work_id && canWrite && <p className="mt-2 text-[12px] text-ink-700">这是最早采用、还没开始写的选题，点「开始创作」进入编辑器。</p>}
      </Card>
      {edit && <TopicEditDialog t={{ ...t, account_id: t.account_id ?? accountId }} series={series} onClose={() => setEdit(false)} />}
    </div>
  )
}

function ConvertDialog({ item, accountId, suggestion, onClose }: { item: InboxItem; accountId: string; suggestion: InboxSuggestion | null; onClose: () => void }) {
  const inv = useInvalidate()
  const [to, setTo] = useState<'topic' | 'material'>(suggestion?.as ?? 'topic')
  const [title, setTitle] = useState(suggestion?.title || item.content.slice(0, 30))
  const [angle, setAngle] = useState(suggestion?.angle ?? '')
  const [audience, setAudience] = useState(suggestion?.audience ?? '')
  const [kind, setKind] = useState<MaterialKind>((suggestion?.kind as MaterialKind) || 'opinion')
  const [content, setContent] = useState(item.content)
  const [tags, setTags] = useState((suggestion?.tags ?? []).join('、'))
  const [busy, setBusy] = useState(false)
  const go = async () => {
    setBusy(true)
    try {
      await post(`/inbox/${item.id}/convert`, to === 'topic'
        ? { to, account_id: accountId, title, angle, audience }
        : { to, account_id: accountId, kind, content, tags: tags.split(/[、,，]/).map((x) => x.trim()).filter(Boolean) })
      inv(['inbox'], ['topics', accountId], ['materials'])
      toast.success(to === 'topic' ? '已转为选题' : '已存入素材库')
      onClose()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open onClose={onClose} title="整理这条灵感" desc="只处理这一条。确认后原灵感会标记为已整理。"
      footer={<><Button variant="ghost" onClick={onClose}>取消</Button><Button variant="primary" loading={busy} onClick={go}>{to === 'topic' ? '转为选题' : '存为素材'}</Button></>}>
      <div className="space-y-4">
        <Tabs value={to} onChange={setTo} items={[{ value: 'topic', label: '转为选题' }, { value: 'material', label: '存为素材' }]} />
        {suggestion?.reason && <Notice tone="ink" icon={<Sparkles className="size-4" />}>AI 建议{suggestion.as === 'topic' ? '作为选题' : '作为素材'}：{suggestion.reason}</Notice>}
        {to === 'topic' ? (
          <>
            <Field label="选题标题"><Input value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
            <Field label="切入角度"><Textarea rows={2} value={angle} onChange={(e) => setAngle(e.target.value)} /></Field>
            <Field label="目标读者"><Input value={audience} onChange={(e) => setAudience(e.target.value)} /></Field>
          </>
        ) : (
          <>
            <Field label="类型">
              <Select value={kind} onChange={(e) => setKind(e.target.value as MaterialKind)}>
                <option value="experience">经历</option><option value="opinion">观点</option><option value="case">案例</option><option value="data">数据</option>
              </Select>
            </Field>
            <Field label="内容"><Textarea rows={4} value={content} onChange={(e) => setContent(e.target.value)} /></Field>
            <Field label="标签" hint="用顿号分隔"><Input value={tags} onChange={(e) => setTags(e.target.value)} /></Field>
          </>
        )}
      </div>
    </Dialog>
  )
}

function InboxPanel({ accountId }: { accountId: string }) {
  const canWrite = useCanWrite()
  const inv = useInvalidate()
  const { data, isLoading } = useQuery({ queryKey: ['inbox'], queryFn: () => get<InboxItem[]>('/inbox') })
  const [text, setText] = useState('')
  const [readPage, setReadPage] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [suggestions, setSuggestions] = useState<Record<string, InboxSuggestion>>({})
  const [converting, setConverting] = useState<InboxItem | null>(null)
  const add = async () => {
    if (!text.trim()) return
    try {
      await post('/inbox', { account_id: accountId, content: text.trim(), source: 'quick', read_page: readPage && /https:\/\/(?:[^\s/]+\.)?(?:xiaohongshu\.com|xhslink\.com|mp\.weixin\.qq\.com)\//i.test(text) })
      setText('')
      setReadPage(false)
      if (readPage) inv(['references'])
      inv(['inbox'])
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const triage = async (it: InboxItem) => {
    setBusyId(it.id)
    try {
      const s = await post<InboxSuggestion>(`/inbox/${it.id}/triage`)
      setSuggestions((m) => ({ ...m, [it.id]: s }))
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusyId(null)
    }
  }
  const dismiss = async (it: InboxItem) => {
    await del(`/inbox/${it.id}`).catch((e) => toast.error(errorMessage(e)))
    inv(['inbox'])
  }
  if (isLoading) return <PageLoading />
  const list = data ?? []
  return (
    <div className="space-y-4">
      {canWrite && (
        <Card className="p-3">
          <div className="flex items-start gap-2">
            <Textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="随手记一条灵感，不用想好怎么分类…（Ctrl+Enter 保存）"
              onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void add() } }} />
            <div className="flex flex-col gap-1.5">
              <Button variant="primary" onClick={add} disabled={!text.trim()}>记下</Button>
              <VoiceButton onText={(t) => setText((v) => v + t)} className="self-center" />
            </div>
          </div>
          {/https:\/\/(?:[^\s/]+\.)?(?:xiaohongshu\.com|xhslink\.com|mp\.weixin\.qq\.com)\//i.test(text) && <label className="mt-2 flex items-center gap-2 text-sm text-mist-600"><input type="checkbox" checked={readPage} onChange={(e) => setReadPage(e.target.checked)} />读取页面为对标参考（受 robots 和限额约束，可手动粘贴）</label>}
        </Card>
      )}
      <Notice icon={<Inbox className="size-4" />}>收件箱里的灵感需要你一条一条处理：可以先让 AI 建议归类，再决定转为选题、存为素材，或者丢掉。系统每天也会为新灵感预先生成归类建议，但不会替你转换。</Notice>
      {list.length === 0 ? <Card><Empty icon={<Inbox className="size-5" />} title="收件箱是空的" desc="任何页面按 Ctrl+Shift+I 都能快速记一条灵感，手机上可以用右下角按钮。"
        action={canWrite ? <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => openQuickCollect('inbox')}>记一条灵感</Button> : undefined} /></Card> : (
        <div className="grid gap-3 md:grid-cols-2">
          {list.map((it) => {
            const sug = suggestions[it.id] ?? it.suggestion
            return (
              <Card key={it.id} className="p-4">
                <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-mist-800">{it.content}</p>
                <div className="mt-1.5 text-[11.5px] text-mist-400">{relTime(it.created_at)} · {{ quick: '随手记', share: '分享', palette: '命令面板', mobile: '手机' }[it.source] ?? it.source}</div>
                {sug && (
                  <div className="mt-2 rounded-lg bg-ink-50/60 px-2.5 py-1.5 text-[12.5px] text-ink-800">
                    <Sparkles className="mr-1 inline size-3.5" />建议{sug.as === 'topic' ? `作为选题「${sug.title}」` : '作为素材'}{sug.reason && `：${sug.reason}`}
                  </div>
                )}
                {canWrite && (
                  <div className="mt-3 flex flex-wrap items-center gap-1.5">
                    {!sug && <Button size="sm" variant="ghost" icon={<Wand2 className="size-3.5" />} loading={busyId === it.id} onClick={() => triage(it)}>AI 建议归类</Button>}
                    <Button size="sm" variant="outline" icon={<Lightbulb className="size-3.5" />} onClick={() => setConverting(it)}>整理</Button>
                    <Button size="sm" variant="ghost" className="ml-auto text-mist-400" onClick={() => dismiss(it)}>丢掉</Button>
                  </div>
                )}
              </Card>
            )
          })}
        </div>
      )}
      {converting && <ConvertDialog item={converting} accountId={accountId} suggestion={suggestions[converting.id] ?? converting.suggestion} onClose={() => setConverting(null)} />}
    </div>
  )
}

function SeriesPanel({ accountId, series, topics }: { accountId: string; series: Series[]; topics: Topic[] }) {
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
      {suggestFor && <SeriesSuggestDrawer s={suggestFor} accountId={accountId} onClose={() => setSuggestFor(null)} />}
    </div>
  )
}

function SeriesSuggestDrawer({ s, accountId, onClose }: { s: Series; accountId: string; onClose: () => void }) {
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
      {callId && <div className="mt-2"><AIFeedback callId={callId} /></div>}
      <div className="mt-4 space-y-3">
        {list.map((x, i) => add.ignored[i] ? null : <SuggestionCard key={i} s={x} added={!!add.added[i]} adding={add.adding === i} onAdd={() => add.add(i, x)} onIgnore={() => add.ignore(i)} />)}
      </div>
    </Drawer>
  )
}

type Tab = Topic['status'] | 'inbox' | 'series'

export default function Topics() {
  const acc = useCurrentAccount()
  const canWrite = useCanWrite()
  const [params, setParams] = useSearchParams()
  const [tab, setTab] = useState<Tab>((params.get('tab') as Tab) || 'pending')
  const [suggest, setSuggest] = useState(params.get('suggest') === '1')
  const [hotSuggest, setHotSuggest] = useState(params.get('hot') === '1')
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')
  const [angle, setAngle] = useState('')
  const [similar, setSimilar] = useState<string[]>([])
  const [byScore, setByScore] = useState(false)
  const [scoring, setScoring] = useState(false)
  const startId = params.get('start')
  const focus = params.get('focus') || startId
  const inv = useInvalidate()
  const { data, isLoading } = useQuery({
    queryKey: ['topics', acc?.id, byScore],
    queryFn: () => get<Topic[]>(`/accounts/${acc!.id}/topics?scores=1${byScore ? '&sort=score' : ''}`),
    enabled: !!acc,
  })
  const series = useQuery({ queryKey: ['series', acc?.id], queryFn: () => get<Series[]>(`/accounts/${acc!.id}/series`), enabled: !!acc })
  const inbox = useQuery({ queryKey: ['inbox'], queryFn: () => get<InboxItem[]>('/inbox'), enabled: !!acc })
  useEffect(() => {
    if (params.get('suggest') || params.get('tab') || params.get('new') || params.get('hot')) {
      if (params.get('hot') === '1') setHotSuggest(true)
      if (params.get('tab')) setTab(params.get('tab') as Tab)
      if (params.get('new')) {
        setSimilar([])
        setTitle(params.get('title') ?? '')
        setAdding(true)
      }
      const n = new URLSearchParams(params)
      for (const k of ['suggest', 'tab', 'new', 'title', 'hot']) n.delete(k)
      setParams(n, { replace: true })
    }
  }, [params, setParams])
  useEffect(() => {
    if (focus && data) {
      const t = data.find((x) => x.id === focus)
      if (t) setTab(t.status)
    }
  }, [focus, data])
  if (!acc || isLoading) return <PageLoading />
  const list = data ?? []
  const shown = list.filter((t) => t.status === tab)
  const save = async () => {
    try {
      const r = await post<{ topic: Topic; similar: string[] }>(`/accounts/${acc.id}/topics`, { title, angle })
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
  return (
    <div className="animate-fade-in">
      <PageHeader title="选题池" desc="先把想法存下来，采用后再开始创作。"
        action={canWrite ? <>
          <Button icon={<Plus className="size-4" />} onClick={() => { setSimilar([]); setAdding(true) }}>手动添加</Button>
          <Button icon={<Sparkles className="size-4" />} onClick={() => setHotSuggest(true)}>热点选题</Button>
          <Button variant="primary" icon={<Sparkles className="size-4" />} onClick={() => setSuggest(true)}>AI 选题建议</Button>
        </> : undefined} />
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Tabs value={tab} onChange={setTab} items={[
          { value: 'pending', label: '待定', count: list.filter((t) => t.status === 'pending').length },
          { value: 'adopted', label: '已采用', count: list.filter((t) => t.status === 'adopted').length },
          { value: 'dropped', label: '已放弃', count: list.filter((t) => t.status === 'dropped').length },
          { value: 'inbox', label: <span className="inline-flex items-center gap-1"><Inbox className="size-3.5" />收件箱</span>, count: inbox.data?.length || undefined },
          { value: 'series', label: <span className="inline-flex items-center gap-1"><Layers className="size-3.5" />系列</span>, count: series.data?.length || undefined },
        ]} />
        {tab === 'pending' && (
          <div className="ml-auto flex items-center gap-3">
            <label className="flex items-center gap-2 text-[12.5px] text-mist-600"><Switch checked={byScore} onChange={setByScore} />按评分排序</label>
            {canWrite && <Button size="sm" icon={<Gauge className="size-3.5" />} loading={scoring} onClick={score}>AI 评估契合度</Button>}
          </div>
        )}
      </div>
      {tab === 'inbox' ? <InboxPanel accountId={acc.id} /> : tab === 'series' ? <SeriesPanel accountId={acc.id} series={series.data ?? []} topics={list} /> : shown.length === 0 ? (
        <Card><Empty icon={<Lightbulb className="size-5" />} title={tab === 'pending' ? '还没有待定的选题' : tab === 'adopted' ? '还没有采用的选题' : '没有放弃的选题'}
          desc={tab === 'pending' ? '手动记下一个想法，或者让 AI 根据账号定位给些建议。' : undefined}
          action={canWrite && tab === 'pending' ? <Button variant="primary" icon={<Sparkles className="size-4" />} onClick={() => setSuggest(true)}>AI 选题建议</Button> : undefined} /></Card>
      ) : (
        <>
          {tab === 'pending' && byScore && <p className="mb-3 text-[12px] text-mist-400"><BookOpen className="mr-1 inline size-3.5" />综合排序 = 契合度、素材充足度、新颖度的加权；只是参考，不预测阅读量。</p>}
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{shown.map((t) => <TopicCard key={t.id} t={t} accountId={acc.id} series={series.data ?? []} focused={t.id === focus} primed={t.id === startId} />)}</div>
        </>
      )}
      <SuggestDrawer open={suggest} onClose={() => setSuggest(false)} accountId={acc.id} />
      <HotSuggestDrawer open={hotSuggest} onClose={() => setHotSuggest(false)} accountId={acc.id} />
      <Dialog open={adding} onClose={() => setAdding(false)} title="添加选题"
        footer={<><Button variant="ghost" onClick={() => setAdding(false)}>{similar.length ? '完成' : '取消'}</Button><Button variant="primary" onClick={save} disabled={!title.trim()}>加入选题池</Button></>}>
        <div className="space-y-4">
          <Field label={<span className="flex items-center justify-between">标题<VoiceButton onText={(t) => setTitle((v) => v + t)} /></span>}><Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
          <Field label="切入角度（可选）"><Textarea rows={3} value={angle} onChange={(e) => setAngle(e.target.value)} /></Field>
          {similar.length > 0 && <Notice tone="gamboge">刚才入库的选题与「{similar.join('」「')}」相似，可以继续保留，也可以去删掉。</Notice>}
          <p className="text-[12px] text-mist-400">入库后可在卡片菜单里补充读者、钩子、需要的素材和计划发布日。</p>
        </div>
      </Dialog>
    </div>
  )
}
