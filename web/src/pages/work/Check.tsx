import { useQuery, useQueryClient } from '@tanstack/react-query'
import { marked } from 'marked'
import { AlertTriangle, ArrowRight, CheckCircle2, Loader2, PenLine, RefreshCw, ShieldCheck, XCircle } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { Badge, Button, Card, cn, HumanGate, Notice, PageLoading, Textarea } from '@/components/ui'
import { ApiError, errorMessage, get, patch, post } from '@/lib/api'
import { htmlStats, renderWechat } from '@/lib/render'
import type { CheckItem, CheckRun, Section, Work } from '@/lib/types'
import { useWork } from './WorkLayout'

const catMeta: Record<CheckItem['category'], { label: string; tone: 'gray' | 'red' | 'blue' | 'gamboge' | 'ink' }> = {
  format: { label: '格式', tone: 'gray' },
  sensitive: { label: '敏感词', tone: 'red' },
  fact: { label: '事实', tone: 'blue' },
  ai_disclosure: { label: 'AI 声明', tone: 'gamboge' },
  similarity: { label: '同质化', tone: 'ink' },
  ad_law: { label: '广告法', tone: 'ink' },
}

const options: Record<string, { value: string; label: string }[]> = {
  sensitive: [{ value: 'modified', label: '已修改' }, { value: 'kept', label: '已知悉，保留' }],
  fact: [{ value: 'verified', label: '已核实' }, { value: 'modified', label: '已修改' }],
  ai_disclosure: [{ value: 'acknowledged', label: '已知悉，发布时会声明' }],
  similarity: [{ value: 'acknowledged', label: '已知悉' }, { value: 'modified', label: '已修改' }],
  ad_law: [{ value: 'acknowledged', label: '已知悉' }, { value: 'modified', label: '已修改' }],
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

function SectionView({ section, index, items, active, onPick, onSaved, editable }: {
  section: Section
  index: number
  items: CheckItem[]
  active: string | null
  onPick: (id: string) => void
  onSaved: () => void
  editable: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(section.content_md)
  const [saving, setSaving] = useState(false)
  useEffect(() => setText(section.content_md), [section.content_md])
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
          <Textarea rows={Math.min(16, Math.max(4, text.split('\n').length + 1))} value={text} onChange={(e) => setText(e.target.value)} className="font-mono text-[13px]" />
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

function ItemCard({ item, active, onPick, onResolve, disabled, workId }: {
  item: CheckItem
  active: boolean
  onPick: () => void
  onResolve: (v: string | null) => void
  disabled: boolean
  workId: string
}) {
  const meta = catMeta[item.category]
  const isFormat = item.category === 'format'
  const done = isFormat ? item.passed : !!item.resolution
  const fieldLink = item.location.field === 'title' || item.location.field === 'summary' ? '#step-title' : item.location.field === 'cover' || item.location.field === 'images' ? '#step-images' : ''
  return (
    <div onClick={onPick} className={cn('cursor-pointer rounded-lg border p-3 transition',
      active ? 'border-gamboge-300 bg-gamboge-50/60 ring-3 ring-gamboge-100' : done ? 'border-mist-200 bg-white' : isFormat ? 'border-orange-200 bg-orange-50/40' : 'border-mist-200 bg-white hover:border-mist-300')}>
      <div className="flex items-start gap-2">
        {isFormat ? (item.passed ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ink-500" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-danger" />)
          : done ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ink-500" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0 text-gamboge-500" />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={meta.tone}>{meta.label}</Badge>
            <span className="text-[13.5px] font-medium text-mist-800">{item.message}</span>
          </div>
          {item.detail && <p className="mt-1 text-[12.5px] leading-relaxed text-mist-500">{item.detail}</p>}
          {item.matched_text && item.category === 'fact' && <p className="mt-1.5 rounded bg-sky-50 px-2 py-1 text-[12.5px] text-sky-800">「{item.matched_text}」</p>}
          {item.location.label && <p className="mt-1 text-[11.5px] text-mist-400">位置：{item.location.label}{item.location.found === false && '（未在正文中定位到原文）'}</p>}
          {isFormat && !item.passed && (
            <p className="mt-1.5 text-[12px] font-medium text-danger">
              格式问题必须修改，不能保留。{fieldLink && <Link to={`/works/${workId}${fieldLink}`} className="underline">去修改</Link>}
            </p>
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
    </div>
  )
}

export default function Check() {
  const { work, setWork, refresh } = useWork()
  const qc = useQueryClient()
  const nav = useNavigate()
  const [params, setParams] = useSearchParams()
  const [active, setActive] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [completing, setCompleting] = useState(false)
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
    if (q.isLoading || started.current || work.locked) return
    if (params.get('start')) setParams({}, { replace: true })
    if (!run || run.stale) {
      started.current = true
      start()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.isLoading])

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
      setWork(await post<Work>(`/works/${work.id}/checks/complete`))
      q.refetch()
      toast.success('检查完成，作品可以发布了')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setCompleting(false)
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
  const groups = (['format', 'sensitive', 'fact', 'ai_disclosure', 'similarity', 'ad_law'] as const)
    .map((c) => ({ c, items: (run?.items ?? []).filter((i) => i.category === c) }))
    .filter((g) => g.items.length)
  const formatFailed = run?.items.filter((i) => i.category === 'format' && !i.passed) ?? []
  const factPending = run?.fact_status === 'pending'
  const canComplete = !!run && !run.stale && !factPending && run.blocking === 0 && run.confirmed === run.total
  const isDone = !!run?.completed_at && !run.stale && ['ready', 'pushed', 'packed', 'published'].includes(work.status)
  const wx = work.platform === 'wechat_mp'
  const sectionItems = (sid: string) => (run?.items ?? []).filter((i) => i.location.section_id === sid && (i.category !== 'format' || !i.passed))

  return (
    <div className="mx-auto w-full max-w-[1400px] px-6 py-6 2xl:max-w-[1600px]">
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
            <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} loading={starting} disabled={work.locked} onClick={start}>重新检查</Button>
          </div>
        )}
      </div>

      {run?.stale && !starting && (
        <Notice tone="gamboge" className="mb-4">内容在检查后又修改过。<button className="cursor-pointer font-medium underline" onClick={start}>重新检查</button>，已确认且文字没变的项会保持确认。</Notice>
      )}
      {!run && !starting && <Card className="p-10 text-center"><Button variant="primary" onClick={start} icon={<ShieldCheck className="size-4" />}>开始检查</Button></Card>}
      {starting && !run && <Card className="flex items-center justify-center gap-2 p-10 text-mist-500"><Loader2 className="size-4 animate-spin" />正在检查…</Card>}

      {run && (
        <div className="grid gap-6 lg:grid-cols-[1fr_420px]">
          <Card className="min-w-0 p-6">
            <h2 className="mb-1 font-display text-[22px] font-bold text-mist-900">{work.title || '（未填写标题）'}</h2>
            {work.summary && <p className="mb-4 text-[13px] text-mist-500">摘要：{work.summary}</p>}
            <div className="space-y-4 border-t border-mist-100 pt-4">
              {work.sections.map((s, i) => (
                <SectionView key={s.id + s.revision} section={s} index={i} items={sectionItems(s.id)} active={active} onPick={pick}
                  editable={!work.locked} onSaved={async () => { await refresh(); await start() }} />
              ))}
            </div>
          </Card>

          <div className="lg:sticky lg:top-20 lg:h-[calc(100vh-7rem)] lg:overflow-y-auto scrollbar-thin space-y-4 pr-1">
            {factPending && (
              <Notice tone="ink" icon={<Loader2 className="size-4 animate-spin" />}>AI 正在标出需要核实的数据、引语和绝对化表达，完成后会出现在「事实」分组中。</Notice>
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
                  {g.items.map((it) => (
                    <div key={it.id} id={`item-${it.id}`}>
                      <ItemCard item={it} active={active === it.id} onPick={() => pick(it.id)} onResolve={(v) => resolve(it, v)} disabled={run.stale || work.locked} workId={work.id} />
                    </div>
                  ))}
                </div>
              </div>
            ))}
            <div className="sticky bottom-0 -mx-1 space-y-2 bg-gradient-to-t from-[var(--color-paper,#f7f6f2)] via-[var(--color-paper,#f7f6f2)] to-transparent px-1 pb-1 pt-6">
              {isDone ? (
                <>
                  <Notice tone="ink" icon={<CheckCircle2 className="size-4" />}>检查已完成，作品处于「{work.status === 'ready' ? '可发布' : '已进入下一步'}」状态。</Notice>
                  <Button variant="primary" size="lg" className="w-full" onClick={() => nav(`/works/${work.id}/${wx ? 'push' : 'pack'}`)}>
                    {wx ? '去写入草稿箱' : '生成发布包'}<ArrowRight className="size-4" />
                  </Button>
                </>
              ) : (
                <>
                  {formatFailed.length > 0 && <Notice tone="red">还有 {formatFailed.length} 项格式问题，修改后重新检查。</Notice>}
                  <HumanGate code="H-04">每一条敏感词和事实都需要你单独确认，没有「全部确认」。</HumanGate>
                  <Button variant="human" size="lg" className="w-full" disabled={!canComplete} loading={completing} onClick={complete} icon={<ShieldCheck className="size-4" />}>
                    确认完成检查
                  </Button>
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
