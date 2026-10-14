import { useQuery, useQueryClient } from '@tanstack/react-query'
import { marked } from 'marked'
import { AlertTriangle, ArrowRight, CheckCircle2, FileText, Loader2, PenLine, RefreshCw, ShieldCheck, Sparkles, UserCheck, XCircle } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { sendFeedback } from '@/components/refs'
import { aiError } from '@/lib/ai-error'
import { Badge, Button, Card, cn, HumanGate, Notice, PageLoading, Textarea } from '@/components/ui'
import { ApiError, errorMessage, get, patch, post } from '@/lib/api'
import { htmlStats, renderWechat } from '@/lib/render'
import { useCanWrite, useMe } from '@/lib/session'
import type { CheckItem, CheckRun, ComicPanel, Section, Variant, Work } from '@/lib/types'
import { useWork, WorkHeaderAction } from './WorkLayout'

interface FixResp { item_id: string; sentence: string; section_id: string | null; variants: Variant[]; ai_call_id: string }

const catMeta: Record<CheckItem['category'], { label: string; tone: 'gray' | 'red' | 'blue' | 'gamboge' | 'ink' }> = {
  format: { label: '格式', tone: 'gray' },
  sensitive: { label: '敏感词', tone: 'red' },
  fact: { label: '事实', tone: 'blue' },
  ai_disclosure: { label: 'AI 声明', tone: 'gamboge' },
  similarity: { label: '同质化', tone: 'ink' },
  ad_law: { label: '广告法', tone: 'ink' },
  stale: { label: '数据过期', tone: 'gamboge' },
}

const options: Record<string, { value: string; label: string }[]> = {
  sensitive: [{ value: 'modified', label: '已修改' }, { value: 'kept', label: '已知悉，保留' }],
  fact: [{ value: 'verified', label: '已核实' }, { value: 'modified', label: '已修改' }],
  ai_disclosure: [{ value: 'acknowledged', label: '已知悉，发布时会声明' }],
  similarity: [{ value: 'acknowledged', label: '已知悉' }, { value: 'modified', label: '已修改' }],
  ad_law: [{ value: 'acknowledged', label: '已知悉' }, { value: 'modified', label: '已修改' }],
  stale: [{ value: 'verified', label: '已核实仍准确' }, { value: 'modified', label: '已换用新数据' }],
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** highlight wraps every occurrence of each term in the rendered HTML's text nodes. */
function highlight(html: string, marks: { text: string; id: string; tone: string }[], active: string | null) {
  if (!marks.length) return html
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html')
  const root = doc.body.firstElementChild!
  const re = new RegExp(marks.map((m) => escapeRe(m.text)).join('|'), 'g')
  const byText = new Map(marks.map((m) => [m.text, m]))
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  while (walker.nextNode()) nodes.push(walker.currentNode as Text)
  for (const node of nodes) {
    const text = node.data
    re.lastIndex = 0
    if (!re.test(text)) continue
    re.lastIndex = 0
    const frag = doc.createDocumentFragment()
    let last = 0
    for (const m of text.matchAll(re)) {
      frag.append(text.slice(last, m.index))
      const info = byText.get(m[0])!
      const el = doc.createElement('mark')
      el.className = cn('hl', `hl-${info.tone}`, info.id === active && 'hl-active')
      el.dataset.item = info.id
      el.textContent = m[0]
      frag.append(el)
      last = m.index! + m[0].length
    }
    frag.append(text.slice(last))
    node.replaceWith(frag)
  }
  return root.innerHTML
}

function PanelView({ panel, items, active, onPick, onSaved, editable }: {
  panel: ComicPanel
  items: CheckItem[]
  active: string | null
  onPick: (id: string) => void
  onSaved: () => void
  editable: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [narration, setNarration] = useState(panel.narration)
  const [dialogue, setDialogue] = useState(panel.dialogue)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    setNarration(panel.narration)
    setDialogue(panel.dialogue)
  }, [panel.narration, panel.dialogue])
  const body = [panel.narration, panel.dialogue].filter(Boolean).join('\n')
  const marks = items.filter((i) => i.matched_text).map((i) => ({ text: i.matched_text, id: i.id, tone: i.category === 'fact' ? 'blue' : i.category === 'format' ? 'red' : 'gamboge' }))
  const html = useMemo(() => highlight(marked.parse(body || '（无旁白/对白）', { async: false }) as string, marks, active), [body, marks, active])
  const save = async () => {
    setSaving(true)
    try {
      await patch(`/panels/${panel.id}`, { narration, dialogue })
      setEditing(false)
      onSaved()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setSaving(false)
    }
  }
  return (
    <div id={`chk-${panel.id}`} className="group scroll-mt-28 rounded-lg px-3 py-2 -mx-3">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="font-display text-[17px] font-bold text-mist-900">第 {panel.position} 格</h3>
        {panel.scene && <span className="truncate text-xs text-mist-400">{panel.scene}</span>}
        {editable && !editing && (
          <button onClick={() => setEditing(true)} className="ml-auto flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-xs text-mist-400 opacity-0 transition hover:bg-mist-100 hover:text-ink-600 group-hover:opacity-100">
            <PenLine className="size-3" />修改这格
          </button>
        )}
      </div>
      {editing ? (
        <div className="space-y-2">
          <Textarea rows={3} value={narration} onChange={(e) => setNarration(e.target.value)} placeholder="旁白" />
          <Textarea rows={2} value={dialogue} onChange={(e) => setDialogue(e.target.value)} placeholder="对白" />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => { setNarration(panel.narration); setDialogue(panel.dialogue); setEditing(false) }}>取消</Button>
            <Button size="sm" variant="primary" loading={saving} onClick={save}>保存并重新检查</Button>
          </div>
        </div>
      ) : (
        <div className="md text-[15px] leading-[1.9] text-mist-700" dangerouslySetInnerHTML={{ __html: html }}
          onClick={(e) => { const id = (e.target as HTMLElement).dataset?.item; if (id) onPick(id) }} />
      )}
    </div>
  )
}

function SectionView({ section, index, items, active, onPick, onSaved, editable, editSignal }: {
  section: Section
  index: number
  items: CheckItem[]
  active: string | null
  onPick: (id: string) => void
  onSaved: () => void
  editable: boolean
  editSignal?: { text: string; n: number } | null
}) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(section.content_md)
  const [saving, setSaving] = useState(false)
  const ta = useRef<HTMLTextAreaElement>(null)
  useEffect(() => setText(section.content_md), [section.content_md])
  // 就地修复（EX-H-01）：打开本段编辑并选中命中的文字。
  useEffect(() => {
    if (!editSignal || !editable) return
    setEditing(true)
    window.setTimeout(() => {
      const el = ta.current
      if (!el) return
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      const i = editSignal.text ? el.value.indexOf(editSignal.text) : -1
      el.focus()
      if (i >= 0) el.setSelectionRange(i, i + editSignal.text.length)
    }, 50)
  }, [editSignal?.n]) // eslint-disable-line react-hooks/exhaustive-deps
  const marks = items.filter((i) => i.matched_text).map((i) => ({ text: i.matched_text, id: i.id, tone: i.category === 'fact' ? 'blue' : i.category === 'format' ? 'red' : 'gamboge' }))
  const html = useMemo(() => highlight(marked.parse(section.content_md, { async: false }) as string, marks, active), [section.content_md, marks, active])
  const save = async () => {
    setSaving(true)
    try {
      await patch(`/sections/${section.id}`, { content_md: text, base_revision: section.revision })
      setEditing(false)
      onSaved()
    } catch (e) {
      toast.error(e instanceof ApiError && e.code === 'version_conflict' ? '这一段在别处被修改过，请刷新后再改' : errorMessage(e))
    } finally {
      setSaving(false)
    }
  }
  return (
    <div id={`chk-${section.id}`} className="group scroll-mt-28 rounded-lg px-3 py-2 -mx-3">
      <div className="mb-2 flex items-center gap-2">
        {section.heading && <h3 className="font-display text-[17px] font-bold text-mist-900">{section.heading}</h3>}
        {!section.heading && <span className="text-xs text-mist-400">第 {index + 1} 段</span>}
        {editable && !editing && (
          <button onClick={() => setEditing(true)} className="ml-auto flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-xs text-mist-400 opacity-0 transition hover:bg-mist-100 hover:text-ink-600 group-hover:opacity-100">
            <PenLine className="size-3" />修改这段
          </button>
        )}
      </div>
      {editing ? (
        <div>
          <Textarea ref={ta} rows={Math.min(16, Math.max(4, text.split('\n').length + 1))} value={text} onChange={(e) => setText(e.target.value)} className="font-mono text-[13px]" />
          <div className="mt-2 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => { setText(section.content_md); setEditing(false) }}>取消</Button>
            <Button size="sm" variant="primary" loading={saving} onClick={save}>保存并重新检查</Button>
          </div>
        </div>
      ) : (
        <div className="md text-[15px] leading-[1.9] text-mist-700" dangerouslySetInnerHTML={{ __html: html }}
          onClick={(e) => { const id = (e.target as HTMLElement).dataset?.item; if (id) onPick(id) }} />
      )}
    </div>
  )
}

function ItemCard({ item, active, onPick, onResolve, disabled, workId, onEditInPlace, onApplyFix }: {
  item: CheckItem
  active: boolean
  onPick: () => void
  onResolve: (v: string | null) => void
  disabled: boolean
  workId: string
  onEditInPlace?: () => void
  onApplyFix?: (fix: FixResp, i: number) => Promise<void>
}) {
  const meta = catMeta[item.category]
  const isFormat = item.category === 'format'
  const done = isFormat ? item.passed : !!item.resolution
  const [fix, setFix] = useState<FixResp | null>(null)
  const [fixBusy, setFixBusy] = useState(false)
  const [applying, setApplying] = useState<number | null>(null)
  const canFix = !disabled && !done && !!item.location.section_id && ['sensitive', 'ad_law', 'fact'].includes(item.category)
  const suggest = async () => {
    setFixBusy(true)
    try {
      setFix(await post<FixResp>(`/check-items/${item.id}/fix-suggest`))
    } catch (e) {
      aiError(e, '建议改法', suggest)
    } finally {
      setFixBusy(false)
    }
  }
  const fieldLink = item.location.field === 'title' || item.location.field === 'summary' ? '#step-title' : item.location.field === 'cover' || item.location.field === 'images' ? '#step-images' : ''
  return (
    <div className={cn('rounded-lg border p-3 transition',
      active ? 'border-gamboge-300 bg-gamboge-50/60 ring-3 ring-gamboge-100' : done ? 'border-mist-200 bg-white' : isFormat ? 'border-orange-200 bg-orange-50/40' : 'border-mist-200 bg-white hover:border-mist-300')}>
      <button type="button" aria-label={`定位检查项：${item.message}`} onClick={onPick}
        className="flex w-full cursor-pointer items-start gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ink-400">
        {isFormat ? (item.passed ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ink-500" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-danger" />)
          : done ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ink-500" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0 text-gamboge-500" />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={meta.tone}>{meta.label}</Badge>
            <span className="text-[13.5px] font-medium text-mist-800">{item.message}</span>
          </div>
          {item.detail && <p className="mt-1 text-[12.5px] leading-relaxed text-mist-500">{item.detail}</p>}
          {item.matched_text && item.category === 'fact' && <p className="mt-1.5 rounded bg-sky-50 px-2 py-1 text-[12.5px] text-sky-800">「{item.matched_text}」</p>}
          {item.location.material_support && <p className="mt-1.5 rounded bg-ink-50 px-2 py-1 text-[12px] text-ink-700">关联素材引句：「{item.location.material_support.quote}」</p>}
          {item.location.label && <p className="mt-1 text-[11.5px] text-mist-400">位置：{item.location.label}{item.location.found === false && '（未在正文中定位到原文）'}</p>}
        </div>
      </button>
      <div className="ml-6">
        {isFormat && !item.passed && (
          <p className="mt-1.5 text-[12px] font-medium text-danger">
            格式问题必须修改，不能保留。{fieldLink && <Link to={`/works/${workId}${fieldLink}`} className="underline">去修改</Link>}
          </p>
        )}
        {!disabled && !done && item.location.section_id && (onEditInPlace || canFix) && (
          <div className="mt-2 flex flex-wrap gap-1.5" onClick={(e) => e.stopPropagation()}>
            {onEditInPlace && <Button size="sm" variant="ghost" icon={<PenLine className="size-3" />} onClick={onEditInPlace}>在原文中修改</Button>}
            {canFix && <Button size="sm" variant="ghost" icon={<Sparkles className="size-3" />} loading={fixBusy} onClick={suggest}>建议改法</Button>}
          </div>
        )}
        {fix && (
          <div className="mt-2 space-y-1.5 rounded-lg border border-ink-100 bg-ink-50/40 p-2" onClick={(e) => e.stopPropagation()}>
            <p className="text-[11.5px] text-mist-500">原句：{fix.sentence}</p>
            {fix.variants.map((v, i) => (
              <div key={i} className="rounded-md bg-white p-2 text-[12.5px]">
                <p className="leading-relaxed text-mist-800">{v.text}</p>
                {v.note && <p className="mt-0.5 text-[11px] text-mist-400">{v.note}</p>}
                <div className="mt-1 flex justify-end">
                  <Button size="sm" variant="primary" loading={applying === i} disabled={applying !== null} onClick={async () => {
                    setApplying(i)
                    try { await onApplyFix?.(fix, i); setFix(null) } finally { setApplying(null) }
                  }}>用这个替换</Button>
                </div>
              </div>
            ))}
            <div className="flex items-center justify-between text-[11px] text-mist-400">
              替换后会重新检查，这一项需要你再确认一次
              <button type="button" className="cursor-pointer hover:text-mist-600" onClick={() => { sendFeedback(fix.ai_call_id, { outcome: 'rejected' }); setFix(null) }}>收起</button>
            </div>
          </div>
        )}
        {!isFormat && (
          <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5" onClick={(e) => e.stopPropagation()}>
            {options[item.category]?.map((o) => (
              <label key={o.value} className={cn('flex cursor-pointer items-center gap-1.5 text-[13px]', item.resolution === o.value ? 'font-medium text-ink-700' : 'text-mist-600')}>
                <input type={item.category === 'ai_disclosure' ? 'checkbox' : 'radio'} name={item.id} disabled={disabled} className="accent-ink-600"
                  checked={item.resolution === o.value}
                  onChange={(e) => onResolve(item.category === 'ai_disclosure' && !e.target.checked ? null : o.value)} />
                {o.label}
              </label>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default function Check() {
  const { work, setWork, refresh } = useWork()
  const canWrite = useCanWrite()
  const qc = useQueryClient()
  const nav = useNavigate()
  const [params, setParams] = useSearchParams()
  const [active, setActive] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [completing, setCompleting] = useState(false)
  const [approving, setApproving] = useState(false)
  const [editSignal, setEditSignal] = useState<{ sectionId: string; text: string; n: number } | null>(null)
  const { data: me } = useMe()
  const editable = canWrite && !work.locked
  const key = ['check', work.id]
  const q = useQuery({
    queryKey: key,
    queryFn: () => get<{ run: CheckRun | null }>(`/works/${work.id}/checks/latest`),
    refetchInterval: (query) => (query.state.data?.run?.fact_status === 'pending' ? 1500 : false),
  })
  const run = q.data?.run ?? null
  const started = useRef(false)

  const start = async () => {
    setStarting(true)
    try {
      const body: Record<string, number> = {}
      if (work.platform === 'wechat_mp') {
        const fresh = await get<Work>(`/works/${work.id}`)
        const s = htmlStats(renderWechat(fresh.sections, fresh.theme))
        body.html_chars = s.chars
        body.html_bytes = s.bytes
      }
      const r = await post<{ run: CheckRun }>(`/works/${work.id}/checks`, body)
      qc.setQueryData(key, r)
      await refresh()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setStarting(false)
    }
  }

  useEffect(() => {
    if (q.isLoading || started.current || !canWrite || work.locked) return
    if (params.get('start')) setParams({}, { replace: true })
    if (!run || run.stale) {
      started.current = true
      start()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.isLoading, canWrite])

  const resolve = async (item: CheckItem, v: string | null) => {
    qc.setQueryData<{ run: CheckRun | null }>(key, (old) => old?.run
      ? { run: { ...old.run, items: old.run.items.map((i) => (i.id === item.id ? { ...i, resolution: v } : i)) } }
      : old)
    try {
      const r = await patch<{ run: CheckRun }>(`/check-items/${item.id}`, { resolution: v })
      qc.setQueryData(key, r)
    } catch (e) {
      toast.error(errorMessage(e))
      q.refetch()
    }
  }
  const complete = async () => {
    setCompleting(true)
    try {
      const w = await post<Work>(`/works/${work.id}/checks/complete`)
      setWork(w)
      q.refetch()
      toast.success(w.status === 'reviewing' ? '检查完成，已提交审阅' : '检查完成，作品可以发布了')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setCompleting(false)
    }
  }
  const approve = async () => {
    setApproving(true)
    try {
      setWork(await post<Work>(`/works/${work.id}/review/approve`))
      toast.success('审阅通过，可以写入草稿或生成发布包了')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setApproving(false)
    }
  }
  // 逐项 AI 修复（EX-H-02）：只替换命中的一句，随后重新检查，该项需要重新确认（HC-18）。
  const applyFix = async (fix: FixResp, i: number) => {
    const fresh = await get<Work>(`/works/${work.id}`)
    const sec = fresh.sections.find((s) => s.id === fix.section_id)
    if (!sec || !sec.content_md.includes(fix.sentence)) {
      toast.info('原句已经改动过，请用「在原文中修改」手动处理')
      return
    }
    try {
      await patch(`/sections/${sec.id}`, { content_md: sec.content_md.replace(fix.sentence, fix.variants[i].text), base_revision: sec.revision })
      sendFeedback(fix.ai_call_id, { outcome: 'accepted', choice_index: i })
      await refresh()
      await start()
      toast.success('已替换并重新检查')
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const pick = (id: string) => {
    setActive(id)
    const it = run?.items.find((x) => x.id === id)
    const sid = it?.location.section_id
    if (sid) {
      const el = document.getElementById(`chk-${sid}`)
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      el?.classList.remove('flash')
      void el?.offsetWidth
      el?.classList.add('flash')
    }
    document.getElementById(`item-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }

  if (q.isLoading) return <PageLoading />
  const groups = (['format', 'sensitive', 'fact', 'stale', 'ai_disclosure', 'similarity', 'ad_law'] as const)
    .map((c) => ({ c, items: (run?.items ?? []).filter((i) => i.category === c) }))
    .filter((g) => g.items.length)
  const formatFailed = run?.items.filter((i) => i.category === 'format' && !i.passed) ?? []
  const factPending = run?.fact_status === 'pending'
  const canComplete = !!run && !run.stale && !factPending && run.blocking === 0 && run.confirmed === run.total
  const isDone = !!run?.completed_at && !run.stale && ['ready', 'pushed', 'packed', 'published'].includes(work.status)
  const reviewing = work.status === 'reviewing'
  const canApprove = reviewing && (me?.role === 'owner' || (!!me?.user_id && me.user_id === work.reviewer_id && me.user_id !== work.assignee_id))
  const wx = work.platform === 'wechat_mp'
  const comic = work.content_format === 'comic'
  const sectionItems = (sid: string) => (run?.items ?? []).filter((i) => i.location.section_id === sid && (i.category !== 'format' || !i.passed))
  const renderItem = (it: CheckItem) => (
    <div key={it.id} id={`item-${it.id}`}>
      <ItemCard item={it} active={active === it.id} onPick={() => pick(it.id)} onResolve={(v) => resolve(it, v)} disabled={!editable || run!.stale} workId={work.id}
        onEditInPlace={!comic && it.location.section_id ? () => setEditSignal({ sectionId: it.location.section_id!, text: it.matched_text, n: Date.now() }) : undefined}
        onApplyFix={comic ? undefined : applyFix} />
    </div>
  )

  return (
    <div className="mx-auto w-full max-w-[1400px] px-6 py-6 2xl:max-w-[1600px]">
      {!run && !starting && editable && <WorkHeaderAction>
        <Button size="sm" variant="primary" onClick={start} icon={<ShieldCheck className="size-4" />}>开始检查</Button>
      </WorkHeaderAction>}
      {run && <WorkHeaderAction>
        {reviewing && run.completed_at && !run.stale
          ? canApprove ? <Button size="sm" variant="human" loading={approving} onClick={approve} icon={<UserCheck className="size-4" />}>审阅通过</Button> : null
          : isDone
            ? <Button size="sm" variant="primary" onClick={() => nav(`/works/${work.id}/${wx ? 'push' : 'pack'}`)}>{wx ? '去写入草稿箱' : '生成发布包'}<ArrowRight className="size-4" /></Button>
            : <Button size="sm" variant="human" disabled={!canComplete || !editable} loading={completing} onClick={complete} icon={<ShieldCheck className="size-4" />}>确认完成检查</Button>}
      </WorkHeaderAction>}
      <div className="mb-5 flex flex-wrap items-center gap-4">
        <div>
          <h1 className="font-display text-[22px] font-bold text-mist-900">发布前检查</h1>
          <p className="text-[13px] text-mist-500">目标：{wx ? '公众号' : '小红书'} · {work.account_name}</p>
        </div>
        {run && (
          <div className="ml-auto flex items-center gap-5">
            <Stat label="已确认" value={`${run.confirmed} / ${run.total}`} ok={run.confirmed === run.total} />
            <Stat label="格式问题" value={String(run.blocking)} ok={run.blocking === 0} />
            <Stat label="事实核查" value={factPending ? '进行中' : run.fact_status === 'done' ? '已完成' : run.fact_status === 'failed' ? '需人工' : '—'} ok={run.fact_status === 'done'} />
            <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} loading={starting} disabled={!editable} onClick={start}>重新检查</Button>
            {run.completed_at && !run.stale && (
              <Link to={`/works/${work.id}/check/report`} target="_blank" className="inline-flex items-center gap-1 text-[13px] text-ink-700 hover:underline"><FileText className="size-3.5" />检查报告</Link>
            )}
          </div>
        )}
      </div>

      {!canWrite && <Notice tone="gray" className="mb-4">观察者只读：可查看检查结果，不能重新检查或确认。</Notice>}
      {run?.stale && !starting && editable && (
        <Notice tone="gamboge" className="mb-4">内容在检查后又修改过。<button className="cursor-pointer font-medium underline" onClick={start}>重新检查</button>，已确认且文字没变的项会保持确认。</Notice>
      )}
      {!run && !starting && editable && <Card className="p-10 text-center text-mist-500">还没有检查记录。</Card>}
      {!run && !starting && !canWrite && <Card className="p-10 text-center text-mist-500">还没有检查记录。</Card>}
      {starting && !run && <Card className="flex items-center justify-center gap-2 p-10 text-mist-500"><Loader2 className="size-4 animate-spin" />正在检查…</Card>}

      {run && (
        <div className="grid gap-6 lg:grid-cols-[1fr_420px]">
          <Card className="min-w-0 p-6">
            <h2 className="mb-1 font-display text-[22px] font-bold text-mist-900">{work.title || '（未填写标题）'}</h2>
            {work.summary && <p className="mb-4 text-[13px] text-mist-500">摘要：{work.summary}</p>}
            <div className="space-y-4 border-t border-mist-100 pt-4">
              {comic
                ? work.panels.map((p) => (
                  <PanelView key={p.id + p.updated_at} panel={p} items={sectionItems(p.id)} active={active} onPick={pick}
                    editable={editable} onSaved={async () => { await refresh(); await start() }} />
                ))
                : work.sections.map((s, i) => (
                  <SectionView key={s.id + s.revision} section={s} index={i} items={sectionItems(s.id)} active={active} onPick={pick}
                    editable={editable} onSaved={async () => { await refresh(); await start() }}
                    editSignal={editSignal?.sectionId === s.id ? editSignal : null} />
                ))}
            </div>
          </Card>

          <div className="lg:sticky lg:top-20 lg:h-[calc(100vh-7rem)] lg:overflow-y-auto scrollbar-thin space-y-4 pr-1">
            {factPending && (
              <Notice tone="ink" icon={<Loader2 className="size-4 animate-spin" />}>AI 正在区分有素材支撑和待核实的事实句子，完成后会分别显示。</Notice>
            )}
            {groups.map((g) => (
              <div key={g.c}>
                <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-mist-500">
                  {catMeta[g.c].label}
                  <span className="font-normal text-mist-400">
                    {g.c === 'format' ? `${g.items.filter((i) => i.passed).length} / ${g.items.length} 通过` : `${g.items.filter((i) => i.resolution).length} / ${g.items.length} 已处理`}
                  </span>
                </div>
                <div className="space-y-2">
                  {g.c === 'fact' ? [
                    { label: '有素材支撑', items: g.items.filter((it) => !!it.location.material_support) },
                    { label: '待核实', items: g.items.filter((it) => !it.location.material_support) },
                  ].filter((group) => group.items.length > 0).map((group) => (
                    <div key={group.label} data-testid={group.label === '有素材支撑' ? 'fact-subgroup-supported' : 'fact-subgroup-unverified'} className="space-y-2">
                      <div className="flex items-center gap-2 pt-1 text-[12px] font-medium text-mist-600">
                        {group.label}<span className="font-normal text-mist-400">{group.items.filter((it) => it.resolution).length} / {group.items.length} 已处理</span>
                      </div>
                      {group.items.map(renderItem)}
                    </div>
                  )) : g.items.map(renderItem)}
                </div>
              </div>
            ))}
            <div className="sticky bottom-0 -mx-1 space-y-2 bg-gradient-to-t from-[var(--color-paper,#f7f6f2)] via-[var(--color-paper,#f7f6f2)] to-transparent px-1 pb-1 pt-6">
              {reviewing && run.completed_at && !run.stale ? (
                <>
                  <Notice tone="gamboge" icon={<UserCheck className="size-4" />}>检查已完成，这篇作品需要审阅。审阅通过前不能写入草稿或生成发布包。</Notice>
                  {canApprove ? (
                    <HumanGate code="H-09">请通读正文和上面的检查记录，再在页头点击“审阅通过”。</HumanGate>
                  ) : <p className="text-center text-[12.5px] text-mist-500">已通知工作区所有者{work.reviewer_id ? '和指定的审阅人' : ''}审阅。</p>}
                </>
              ) : isDone ? (
                <>
                  <Notice tone="ink" icon={<CheckCircle2 className="size-4" />}>检查已完成，作品处于「{work.status === 'ready' ? '可发布' : '已进入下一步'}」状态。</Notice>
                </>
              ) : (
                <>
                  {formatFailed.length > 0 && <Notice tone="red">还有 {formatFailed.length} 项格式问题，修改后重新检查。</Notice>}
                  <HumanGate code="H-04">每一条敏感词和事实都需要你单独确认，没有「全部确认」。</HumanGate>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div className="text-right">
      <div className="text-[11px] text-mist-400">{label}</div>
      <div className={cn('text-[15px] font-semibold tabular-nums', ok ? 'text-ink-700' : 'text-gamboge-600')}>{value}</div>
    </div>
  )
}
