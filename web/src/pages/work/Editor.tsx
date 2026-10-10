import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, CheckCircle2, Circle, CloudOff, Crop, ImagePlus, Images, Layers, Loader2,
  PanelRightOpen, PenLine, Plus, Sparkles, Star, Stethoscope, Trash2, Wand2, X,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { AssetCropDialog, CoverCropDialog, CropPreview, defaultCrops } from '@/components/cover-crop'
import { confirm, Dialog } from '@/components/dialog'
import { RefsNote, sendFeedback } from '@/components/refs'
import { Badge, Button, Card, cn, Field, formatBriefHint, HumanGate, IconButton, Input, Notice, Select, Spinner, Textarea } from '@/components/ui'
import { XhsCardMaker } from '@/components/xhs-cards'
import { aiError } from '@/lib/ai-error'
import { del, errorMessage, get, patch, post, put, rawRequest, stream } from '@/lib/api'
import { type AIRefs, fmtTime, parseTopics, runeLen } from '@/lib/format'
import { useCanWrite } from '@/lib/session'
import type { AIJob, Asset, CropBox, LibraryAsset, LintHit, Material, MaterialKind, OutlineItem, OutlineTemplate, Section, SeriesContext, SeriesNeighbour, Work } from '@/lib/types'
import { usePrefs, useWorkCmd, waitJob } from '@/lib/v3'
import CardEditor from './CardEditor'
import ComicEditor from './ComicEditor'
import { EditorSidebar } from './editor-sidebar'
import { emitEditor, type EditorEvent, findPending, scrollToSection, type SidebarTab, TagSuggest, useEditorEvents } from './editor-tools'
import { SectionBlock } from './section-block'
import { useWork } from './WorkLayout'

const kindLabel: Record<MaterialKind, string> = { experience: '经历', opinion: '观点', case: '案例', data: '数据' }

type SaveState = { pending: number; offline: boolean; last: string | null }

interface TitleCand { text: string; style: string; chars: number; over_limit: boolean; features: string[]; strong_hits: string[]; call?: string; idx?: number }
interface TitleResp { titles: TitleCand[]; refs: AIRefs; ai_call_id: string; max_chars: number; strong_features: string[] }

// ---------- 核心观点（H-02） ----------

function SeriesStrip({ sc }: { sc: SeriesContext }) {
  const cell = (label: string, n: SeriesNeighbour | null) => (
    <div className="min-w-0 flex-1 rounded-lg bg-mist-50 px-3 py-2">
      <div className="text-[11px] text-mist-400">{label}</div>
      {n ? (
        <>
          <div className="truncate text-[12.5px] font-medium text-mist-800">
            {n.work_id ? <Link to={`/works/${n.work_id}`} className="hover:text-ink-700 hover:underline">《{n.title}》</Link> : `《${n.title}》`}
          </div>
          <p className="line-clamp-2 text-[12px] leading-snug text-mist-500">{n.viewpoint || '还没有观点'}</p>
        </>
      ) : <div className="text-[12px] text-mist-400">没有了</div>}
    </div>
  )
  return (
    <div className="mt-3 rounded-xl border border-mist-200 p-3">
      <div className="mb-2 flex items-center gap-2 text-[12.5px] text-mist-600">
        <Layers className="size-3.5 text-ink-500" />系列「{sc.name}」{sc.position > 0 && <span className="text-mist-400">第 {sc.position} / {sc.total} 篇</span>}
        <span className="ml-auto text-[11.5px] text-mist-400">起草时会参考上下篇观点，避免重复</span>
      </div>
      <div className="flex gap-2">{cell('上一篇', sc.prev)}{cell('下一篇', sc.next)}</div>
    </div>
  )
}

function ViewpointCard({ work, setWork, readOnly }: { work: Work; setWork: (w: Work) => void; readOnly: boolean }) {
  const [text, setText] = useState(work.viewpoint)
  const [picking, setPicking] = useState(false)
  const [matQ, setMatQ] = useState('')
  const { data: materials } = useQuery({
    queryKey: ['materials', work.account_id, ''],
    queryFn: () => get<Material[]>(`/materials?account_id=${work.account_id}`),
  })
  const seriesCtx = useQuery({
    queryKey: ['series-context', work.id],
    queryFn: () => get<SeriesContext | null>(`/works/${work.id}/series-context`),
    enabled: !!work.topic_id,
    staleTime: 60_000,
  })
  useEffect(() => setText(work.viewpoint), [work.viewpoint])
  const save = async () => {
    if (text.trim() === work.viewpoint) return
    try {
      setWork(await patch<Work>(`/works/${work.id}`, { viewpoint: text }))
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const [ids, setIds] = useState(work.material_ids)
  useEffect(() => setIds(work.material_ids), [work.material_ids])
  const toggle = async (id: string) => {
    const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]
    setIds(next)
    try {
      setWork(await patch<Work>(`/works/${work.id}`, { material_ids: next }))
    } catch (e) {
      setIds(work.material_ids)
      toast.error(errorMessage(e))
    }
  }
  const selected = (materials ?? []).filter((m) => ids.includes(m.id))
  const filtered = (materials ?? []).filter((m) => {
    if (!matQ.trim()) return true
    const q = matQ.trim().toLowerCase()
    return m.content.toLowerCase().includes(q) || (m.source || '').toLowerCase().includes(q) || kindLabel[m.kind].includes(matQ.trim())
  })
  return (
    <Card id="step-viewpoint" className="scroll-mt-24 p-5">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="font-display text-[17px] font-bold text-mist-900">核心观点</h2>
        <Badge tone="gamboge">H-02 必须由你来写</Badge>
      </div>
      <Textarea rows={3} value={text} disabled={readOnly} onChange={(e) => setText(e.target.value)} onBlur={save}
        placeholder={work.topic_angle
          ? `选题角度：${work.topic_angle}\n——这只是提示，请用你自己的话写下观点。`
          : '用一两句话写下你自己的观点。AI 会围绕它组织大纲，不会替你决定立场。'}
        className="font-display text-[16px] leading-relaxed" />
      {seriesCtx.data && <SeriesStrip sc={seriesCtx.data} />}
      <div className="mt-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[13px] font-medium text-mist-700">参考素材 <span className="font-normal text-mist-400">· AI 只会把这些当作事实来源</span></span>
          {!readOnly && <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => { setMatQ(''); setPicking(true) }}>选择素材</Button>}
        </div>
        {selected.length === 0 ? (
          <p className="rounded-lg border border-dashed border-mist-200 px-3 py-3 text-[13px] text-mist-400">还没有选择素材。没有素材时，AI 遇到需要数据的地方会写成「【待核实：…】」让你补充。</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {selected.map((m) => (
              <span key={m.id} className="inline-flex max-w-full items-center gap-1.5 rounded-lg bg-mist-100 py-1 pl-2.5 pr-1 text-[12.5px] text-mist-700">
                <Badge tone="ink">{kindLabel[m.kind]}</Badge>
                <span className="max-w-64 truncate">{m.content}</span>
                {!readOnly && <button type="button" onClick={() => toggle(m.id)} className="cursor-pointer rounded p-0.5 text-mist-400 hover:bg-mist-200 hover:text-mist-700"><X className="size-3" /></button>}
              </span>
            ))}
          </div>
        )}
      </div>
      <Dialog open={picking} onClose={() => setPicking(false)} title="选择参考素材" desc="只列出本账号和共享的素材。点芯片可快速取消。" width="max-w-xl"
        footer={<Button variant="primary" onClick={() => setPicking(false)}>完成{ids.length ? `（已选 ${ids.length}）` : ''}</Button>}>
        <Input value={matQ} onChange={(e) => setMatQ(e.target.value)} placeholder="搜索素材内容、来源或类型…" className="mb-3" />
        <div className="scrollbar-thin max-h-[50vh] space-y-2 overflow-y-auto">
          {(materials ?? []).length === 0 && <p className="py-8 text-center text-sm text-mist-400">素材库是空的，可以先去「素材库」添加经历、观点、案例和数据。</p>}
          {(materials ?? []).length > 0 && filtered.length === 0 && <p className="py-6 text-center text-sm text-mist-400">没有匹配「{matQ}」的素材。</p>}
          {filtered.map((m) => (
            <label key={m.id} className={cn('flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition', ids.includes(m.id) ? 'border-ink-300 bg-ink-50/50' : 'border-mist-200 hover:border-mist-300')}>
              <input type="checkbox" className="mt-1 accent-ink-600" checked={ids.includes(m.id)} onChange={() => toggle(m.id)} />
              <div className="min-w-0">
                <div className="flex items-center gap-2"><Badge tone="ink">{kindLabel[m.kind]}</Badge>{!m.account_id && <Badge>共享</Badge>}</div>
                <p className="mt-1 text-[13px] leading-relaxed text-mist-700">{m.content}</p>
                {m.source && <p className="mt-0.5 text-xs text-mist-400">来源：{m.source}</p>}
              </div>
            </label>
          ))}
        </div>
      </Dialog>
    </Card>
  )
}

// ---------- 大纲（H-03） ----------

function TemplateManager({ open, onClose, list }: { open: boolean; onClose: () => void; list: OutlineTemplate[] }) {
  const qc = useQueryClient()
  const [rows, setRows] = useState<OutlineTemplate[]>([])
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (open) setRows(list.filter((t) => !t.builtin))
  }, [open, list])
  const set = (i: number, p: Partial<OutlineTemplate>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...p } : r)))
  const invalid = rows.some((r) => !r.name.trim() || !r.structure.trim() || runeLen(r.name) > 20 || runeLen(r.structure) > 500)
  const save = async () => {
    setSaving(true)
    try {
      await put('/outline-templates', { items: rows.map((r) => ({ id: r.id, name: r.name.trim(), structure: r.structure.trim() })) })
      await qc.invalidateQueries({ queryKey: ['outline-templates'] })
      toast.success('大纲模板已保存')
      onClose()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setSaving(false)
    }
  }
  return (
    <Dialog open={open} onClose={onClose} title="管理大纲模板" desc="内置模板不能修改；自定义模板在整个工作区可用，生成大纲时 AI 会按结构展开。" width="max-w-xl"
      footer={<>
        <Button variant="ghost" onClick={onClose}>取消</Button>
        <Button variant="primary" loading={saving} disabled={invalid} onClick={save}>保存</Button>
      </>}>
      <div className="space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {list.filter((t) => t.builtin).map((t) => <span key={t.id} title={t.structure}><Badge tone="gray">{t.name}</Badge></span>)}
        </div>
        {rows.map((r, i) => (
          <div key={r.id || `new-${i}`} className="space-y-2 rounded-lg border border-mist-200 p-3">
            <div className="flex items-center gap-2">
              <Input className="h-8 flex-1 text-[13px]" value={r.name} maxLength={20} placeholder="模板名称，如：三段式" onChange={(e) => set(i, { name: e.target.value })} />
              <IconButton label="删除模板" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}><Trash2 className="size-4" /></IconButton>
            </div>
            <Textarea rows={2} className="text-[13px]" value={r.structure} maxLength={500} placeholder="用 → 分隔每一段，如：现象 → 原因 → 对策"
              onChange={(e) => set(i, { structure: e.target.value })} />
          </div>
        ))}
        {rows.length === 0 && <p className="text-[13px] text-mist-500">还没有自定义模板。复盘页可以把一篇爆文的结构存成模板，也可以在这里手动添加。</p>}
        {rows.length < 30 && (
          <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => setRows((rs) => [...rs, { id: '', name: '', structure: '', builtin: false }])}>添加模板</Button>
        )}
      </div>
    </Dialog>
  )
}

function OutlineCard({ work, setWork, readOnly, onConfirmed }: { work: Work; setWork: (w: Work) => void; readOnly: boolean; onConfirmed?: () => void }) {
  const confirmed = !!work.outline_confirmed_at
  const [items, setItems] = useState<OutlineItem[]>(work.outline)
  const [editing, setEditing] = useState(!confirmed)
  const [busy, setBusy] = useState<'gen' | 'save' | 'confirm' | 'review' | null>(null)
  const [refs, setRefs] = useState<AIRefs | null>(null)
  const [callId, setCallId] = useState<string | null>(null)
  const [template, setTemplate] = useState('')
  const [managing, setManaging] = useState(false)
  const [review, setReview] = useState<{ issues: { items: number[]; problem: string; suggestion: string }[]; overall: string; ai_call_id: string } | null>(null)
  const templates = useQuery({ queryKey: ['outline-templates'], queryFn: () => get<OutlineTemplate[]>('/outline-templates'), staleTime: 300_000, enabled: !readOnly })
  useEffect(() => {
    setItems(work.outline)
    setEditing(!work.outline_confirmed_at)
  }, [work.outline, work.outline_confirmed_at])
  useEffect(() => {
    if (template && templates.data && !templates.data.some((t) => t.id === template)) setTemplate('')
  }, [template, templates.data])
  const noViewpoint = !work.viewpoint.trim()
  const generate = async () => {
    if (items.length && !(await confirm({ title: '重新生成大纲？', desc: '当前未确认的大纲会被替换。已经确认生成的段落不受影响。', confirmText: '重新生成' }))) return
    setBusy('gen')
    try {
      const r = await post<{ items: OutlineItem[]; refs: AIRefs; ai_call_id: string }>(`/works/${work.id}/outline/generate`, template ? { template } : {})
      setItems(r.items)
      setRefs(r.refs)
      setCallId(r.ai_call_id)
      setReview(null)
      setEditing(true)
    } catch (e) {
      aiError(e, '生成大纲', generate)
    } finally {
      setBusy(null)
    }
  }
  const runReview = async () => {
    setBusy('review')
    try {
      setReview(await post(`/works/${work.id}/outline/review`, { items: items.filter((x) => x.heading.trim()) }))
    } catch (e) {
      aiError(e, '大纲评审', runReview)
    } finally {
      setBusy(null)
    }
  }
  const flagged = new Set((review?.issues ?? []).flatMap((i) => i.items))
  const save = async (confirmIt: boolean) => {
    setBusy(confirmIt ? 'confirm' : 'save')
    try {
      const w = await put<Work>(`/works/${work.id}/outline`, { items, confirm: confirmIt })
      setWork(w)
      if (confirmIt) {
        setEditing(false)
        toast.success('大纲已确认，可以逐段起草了')
        onConfirmed?.()
      }
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }
  const update = (i: number, p: Partial<OutlineItem>) => setItems(items.map((x, j) => (j === i ? { ...x, ...p } : x)))
  const move = (i: number, d: number) => {
    const j = i + d
    if (j < 0 || j >= items.length) return
    const next = [...items]
    ;[next[i], next[j]] = [next[j], next[i]]
    setItems(next)
  }
  return (
    <Card id="step-outline" className="scroll-mt-24 p-5">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="font-display text-[17px] font-bold text-mist-900">大纲</h2>
        {confirmed ? <Badge tone="green"><Check className="size-3" />已确认</Badge> : <Badge tone="gamboge">H-03 确认后才能起稿</Badge>}
        <div className="ml-auto flex flex-wrap justify-end gap-2">
          {!readOnly && editing && (
            <Select className="h-8 w-36 text-[12.5px]" value={template} onChange={(e) => setTemplate(e.target.value)} title="生成大纲时使用的结构模板">
              <option value="">不用结构模板</option>
              {(templates.data ?? []).map((t) => <option key={t.id} value={t.id} title={t.structure}>{t.name}</option>)}
            </Select>
          )}
          {!readOnly && editing && <Button size="sm" variant="ghost" onClick={() => setManaging(true)}>管理模板</Button>}
          {!readOnly && <Button size="sm" variant={items.length ? 'ghost' : 'primary'} icon={<Sparkles className="size-3.5" />} loading={busy === 'gen'} disabled={noViewpoint} onClick={generate}
            title={noViewpoint ? '请先写下核心观点' : undefined}>{items.length ? '重新生成' : 'AI 生成大纲'}</Button>}
          {!readOnly && items.some((x) => x.heading.trim()) && (
            <Button size="sm" variant="ghost" icon={<Stethoscope className="size-3.5" />} loading={busy === 'review'} onClick={runReview}>让 AI 看看大纲</Button>
          )}
          {confirmed && !editing && !readOnly && <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>修改大纲</Button>}
        </div>
      </div>
      {noViewpoint && !confirmed && <HumanGate code="H-02" className="mb-3">先写下你的核心观点，才能生成大纲。</HumanGate>}
      {template && editing && <p className="mb-2 text-[12px] text-mist-500">结构：{templates.data?.find((t) => t.id === template)?.structure}</p>}
      {!template && formatBriefHint[work.content_format] && <p className="mb-2 text-[12px] text-mist-500">{formatBriefHint[work.content_format]}</p>}
      <TemplateManager open={managing} onClose={() => setManaging(false)} list={templates.data ?? []} />
      <RefsNote refs={refs} callId={callId} className="mb-3" onRetry={editing && !readOnly ? generate : undefined} />
      {review && (
        <div className="mb-3 animate-fade-in rounded-lg border border-gamboge-200 bg-gamboge-50/50 p-3 text-[13px]">
          <div className="mb-1.5 flex items-center gap-2 font-medium text-mist-800">
            大纲评审<span className="text-xs font-normal text-mist-500">只提建议，大纲由你来改</span>
            <button type="button" className="ml-auto cursor-pointer text-mist-400 hover:text-mist-700" onClick={() => setReview(null)}><X className="size-3.5" /></button>
          </div>
          {review.overall && <p className="mb-2 leading-relaxed text-mist-700">{review.overall}</p>}
          <ul className="space-y-1.5">
            {review.issues.map((i, k) => (
              <li key={k} className="leading-relaxed">
                {i.items.length > 0 && <Badge tone="gamboge" className="mr-1.5">第 {i.items.join('、')} 项</Badge>}
                <span className="text-mist-800">{i.problem}</span>
                <span className="text-mist-500"> — {i.suggestion}</span>
              </li>
            ))}
          </ul>
          <RefsNote callId={review.ai_call_id} className="mt-2" onRetry={runReview} />
        </div>
      )}
      {!editing ? (
        <ol className="space-y-1.5">
          {items.map((it, i) => (
            <li key={i} className="flex gap-3 text-[13.5px]">
              <span className={cn('w-5 shrink-0 text-right font-mono', flagged.has(i + 1) ? 'text-gamboge-600' : 'text-mist-400')}>{i + 1}</span>
              <span><span className="font-medium text-mist-800">{it.heading}</span>{it.key_point && <span className="text-mist-500"> — {it.key_point}</span>}</span>
            </li>
          ))}
        </ol>
      ) : (
        <>
          {items.length === 0 ? (
            <p className="rounded-lg border border-dashed border-mist-200 px-3 py-6 text-center text-[13px] text-mist-400">点「AI 生成大纲」或手动添加大纲项。</p>
          ) : (
            <ol className="space-y-2">
              {items.map((it, i) => (
                <li key={i} className={cn('group flex items-start gap-2 rounded-lg border bg-white p-2.5', flagged.has(i + 1) ? 'border-gamboge-300' : 'border-mist-200')}>
                  <span className="mt-2 w-5 shrink-0 text-right font-mono text-xs text-mist-400">{i + 1}</span>
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <Input value={it.heading} onChange={(e) => update(i, { heading: e.target.value })} placeholder="段落小标题" className="h-8 font-medium" />
                    <Input value={it.key_point} onChange={(e) => update(i, { key_point: e.target.value })} placeholder="本段要点" className="h-8 text-[13px]" />
                  </div>
                  <div className="flex flex-col opacity-40 group-hover:opacity-100">
                    <IconButton label="上移" className="size-6" onClick={() => move(i, -1)}><ArrowUp className="size-3.5" /></IconButton>
                    <IconButton label="下移" className="size-6" onClick={() => move(i, 1)}><ArrowDown className="size-3.5" /></IconButton>
                    <IconButton label="删除" className="size-6 hover:text-danger" onClick={() => setItems(items.filter((_, j) => j !== i))}><X className="size-3.5" /></IconButton>
                  </div>
                </li>
              ))}
            </ol>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => setItems([...items, { heading: '', key_point: '', material_ids: [] }])}>添加一项</Button>
            <div className="ml-auto flex gap-2">
              {!confirmed && <Button size="sm" loading={busy === 'save'} disabled={!items.length} onClick={() => save(false)}>暂存</Button>}
              {confirmed && <Button size="sm" variant="ghost" onClick={() => { setItems(work.outline); setEditing(false) }}>取消</Button>}
              <Button size="sm" variant="human" loading={busy === 'confirm'} disabled={!items.some((x) => x.heading.trim()) || readOnly} onClick={() => save(true)} icon={<Check className="size-3.5" />}>
                确认大纲
              </Button>
            </div>
          </div>
          {confirmed && <p className="mt-2 text-xs text-mist-400">重新确认后，修改过的大纲项会更新对应段落的小标题和要点，新增的大纲项会生成空段落。</p>}
        </>
      )}
    </Card>
  )
}

// ---------- 口述 / 要点扩写 ----------

function OrganizeNotesCard({ work, setWork, readOnly }: { work: Work; setWork: (w: Work) => void; readOnly: boolean }) {
  const [open, setOpen] = useState(false)
  const [notes, setNotes] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [applying, setApplying] = useState(false)
  const abort = useRef<AbortController | null>(null)
  const run = async () => {
    if (!notes.trim()) return
    setBusy(true)
    setText('')
    abort.current = new AbortController()
    try {
      const done = await stream<{ text: string }>(`/works/${work.id}/organize-notes`, { notes }, {
        signal: abort.current.signal,
        onDelta: (d) => setText((t) => t + d),
      })
      if (done?.text) setText(done.text)
    } catch (e) {
      aiError(e, '整理笔记', run)
    } finally {
      setBusy(false)
    }
  }
  const apply = async () => {
    if (!text.trim()) return
    if (!(await confirm({ title: '用整理结果覆盖当前正文？', desc: '会按小标题重建大纲与段落，并写入 AI 初稿。现有段落会被替换。', confirmText: '写入正文' }))) return
    setApplying(true)
    try {
      setWork(await post<Work>(`/works/${work.id}/organize-notes/apply`, { markdown: text }))
      toast.success('已写入正文')
      setOpen(false)
      setNotes('')
      setText('')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setApplying(false)
    }
  }
  if (readOnly) return null
  return (
    <>
      <Card className="flex items-center gap-3 p-4">
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold text-mist-800">口述 / 要点扩写</div>
          <p className="text-[12.5px] text-mist-500">粘贴要点或语音转写，AI 只整理不扩写事实。</p>
        </div>
        <Button size="sm" variant="secondary" icon={<Wand2 className="size-3.5" />} onClick={() => setOpen(true)}>开始整理</Button>
      </Card>
      <Dialog open={open} onClose={() => { abort.current?.abort(); setOpen(false) }} title="要点整理成稿" desc="只组织你提供的内容；缺数据处会标【待核实】。" width="max-w-2xl"
        footer={<>
          <Button variant="ghost" onClick={() => { abort.current?.abort(); setOpen(false) }}>取消</Button>
          {!text ? <Button variant="primary" loading={busy} disabled={!notes.trim()} onClick={run}>生成初稿</Button>
            : <Button variant="primary" loading={applying} onClick={apply}>写入正文</Button>}
        </>}>
        <div className="space-y-4">
          <Field label="要点或口述转写"><Textarea rows={6} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="每行一条要点，或粘贴语音转写全文" disabled={busy || !!text} /></Field>
          {(busy || text) && (
            <div className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-lg border border-mist-200 bg-mist-50/60 p-3 text-[13.5px] leading-relaxed text-mist-800">
              {text || <span className="text-mist-400">整理中…</span>}
            </div>
          )}
          {text && !busy && <Button size="sm" variant="ghost" onClick={() => { setText(''); }}>重新生成</Button>}
        </div>
      </Dialog>
    </>
  )
}

// ---------- 标题与摘要 ----------

function TitleCard({ work, setWork, readOnly }: { work: Work; setWork: (w: Work) => void; readOnly: boolean }) {
  const wx = work.platform === 'wechat_mp'
  const [title, setTitle] = useState(work.title)
  const [summary, setSummary] = useState(work.summary)
  const [topics, setTopics] = useState(work.topics.map((t) => '#' + t).join(' '))
  const [titles, setTitles] = useState<TitleCand[]>([])
  const [titleRefs, setTitleRefs] = useState<AIRefs | null>(null)
  const [titleCall, setTitleCall] = useState<string | null>(null)
  const [strong, setStrong] = useState<string[]>([])
  const toCand = (f: { text: string; style: string }): TitleCand => ({ ...f, chars: runeLen(f.text), over_limit: runeLen(f.text) > (wx ? 32 : 20), features: [], strong_hits: [] })
  const favs = (work.title_favorites ?? []).map(toCand)
  const [rewriting, setRewriting] = useState<string | null>(null)
  const [busy, setBusy] = useState<'t' | 's' | null>(null)
  const saveFavs = async (items: { text: string; style: string }[]) => {
    try {
      const list = await put<{ text: string; style: string }[]>(`/works/${work.id}/title-favorites`, { items })
      setWork({ ...work, title_favorites: list })
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  useEffect(() => {
    const key = `ops.title-favs.${work.id}`
    const old = localStorage.getItem(key)
    if (!old || readOnly) return
    localStorage.removeItem(key)
    const items = (JSON.parse(old) as TitleCand[]).map((t) => ({ text: t.text, style: t.style }))
    if (items.length && !(work.title_favorites ?? []).length) void saveFavs(items)
  }, [work.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const toggleFav = (t: TitleCand) => {
    const cur = work.title_favorites ?? []
    void saveFavs(cur.some((f) => f.text === t.text) ? cur.filter((f) => f.text !== t.text) : [...cur, { text: t.text, style: t.style }])
  }
  const rewriteOne = async (base: string) => {
    setRewriting(base)
    try {
      const r = await post<TitleResp>(`/works/${work.id}/titles`, { base })
      setTitles((prev) => {
        const i = prev.findIndex((x) => x.text === base)
        const extra = r.titles.map((x, k) => ({ ...x, call: r.ai_call_id, idx: k })).filter((x) => !prev.some((p) => p.text === x.text))
          .map((x) => ({ ...x, style: `${x.style}（改写自候选）` }))
        return i < 0 ? [...prev, ...extra] : [...prev.slice(0, i + 1), ...extra, ...prev.slice(i + 1)]
      })
      setStrong(r.strong_features ?? [])
    } catch (e) {
      aiError(e, '改写标题', () => rewriteOne(base))
    } finally {
      setRewriting(null)
    }
  }
  useEffect(() => { setTitle(work.title); setSummary(work.summary); setTopics(work.topics.map((t) => '#' + t).join(' ')) }, [work.title, work.summary, work.topics])
  const titleMax = wx ? 32 : 20
  const save = async (body: Record<string, unknown>) => {
    try {
      setWork(await patch<Work>(`/works/${work.id}`, body))
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const genTitles = async () => {
    setBusy('t')
    try {
      const r = await post<TitleResp>(`/works/${work.id}/titles`)
      setTitles(r.titles.map((x, k) => ({ ...x, call: r.ai_call_id, idx: k })))
      setTitleRefs(r.refs)
      setTitleCall(r.ai_call_id)
      setStrong(r.strong_features ?? [])
    } catch (e) {
      aiError(e, '生成标题', genTitles)
    } finally {
      setBusy(null)
    }
  }
  useWorkCmd((c) => {
    if (c.cmd !== 'titles' || readOnly) return
    document.getElementById('step-title')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    void genTitles()
  })
  const genSummary = async () => {
    setBusy('s')
    try {
      const r = await post<{ summary: string; truncated: boolean }>(`/works/${work.id}/summary`)
      setSummary(r.summary)
      if (r.truncated) toast.info('AI 写的摘要超过 120 字，已截断，请检查结尾')
      await save({ summary: r.summary })
    } catch (e) {
      aiError(e, '生成摘要', genSummary)
    } finally {
      setBusy(null)
    }
  }
  const picked = useRef<TitleCand | null>(null)
  const pickTitle = (t: string) => {
    setTitle(t)
    save({ title: t })
    const c = titles.find((x) => x.text === t)
    picked.current = c ?? null
    if (c?.call) sendFeedback(c.call, { outcome: 'accepted', choice_index: c.idx })
  }
  // 标题候选"是否改写后使用"（10 文档 3.3）：选用后又手改，记为 edited。
  const titleEdited = (next: string) => {
    const c = picked.current
    if (!c?.call || next === c.text) return
    sendFeedback(c.call, { outcome: 'edited', choice_index: c.idx })
    picked.current = null
  }
  const groups = [...new Set(titles.map((t) => t.style.replace('（改写自候选）', '')))]
  const titleRow = (t: TitleCand) => {
    const fav = favs.some((f) => f.text === t.text)
    return (
      <div key={t.text} className={cn('group flex items-start gap-2 rounded-lg border px-3 py-2 transition hover:border-ink-300', title === t.text ? 'border-ink-400 bg-ink-50' : 'border-mist-200')}>
        <button type="button" onClick={() => pickTitle(t.text)} className="min-w-0 flex-1 cursor-pointer text-left">
          <div className="text-[13.5px] font-medium text-mist-800">{t.text}</div>
          <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-mist-400">
            <span className={cn(t.over_limit && 'font-medium text-danger')}>{t.chars} 字{t.over_limit ? '（超出）' : ''}</span>
            {(t.features ?? []).map((f) => (
              <span key={f} className={cn('rounded px-1', t.strong_hits?.includes(f) ? 'bg-gamboge-100 text-gamboge-800' : 'bg-mist-100')}
                title={t.strong_hits?.includes(f) ? '你过去表现较好的标题也常有这个特征' : undefined}>{f}</span>
            ))}
          </div>
        </button>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <button type="button" title={fav ? '取消收藏' : '收藏这个候选'} onClick={() => toggleFav(t)} className={cn('cursor-pointer', fav ? 'text-gamboge-500' : 'text-mist-300 hover:text-gamboge-500')}>
            <Star className="size-3.5" fill={fav ? 'currentColor' : 'none'} />
          </button>
          {!readOnly && (
            <button type="button" disabled={!!rewriting} onClick={() => rewriteOne(t.text)} className="cursor-pointer text-[11px] text-mist-400 opacity-0 transition hover:text-ink-600 group-hover:opacity-100 disabled:opacity-50">
              {rewriting === t.text ? <Loader2 className="size-3 animate-spin" /> : '再改写 3 个'}
            </button>
          )}
        </div>
      </div>
    )
  }
  return (
    <Card id="step-title" className="scroll-mt-24 p-5">
      <h2 className="mb-4 font-display text-[17px] font-bold text-mist-900">标题{wx ? '与摘要' : '与话题'}</h2>
      <div className="space-y-4">
        <Field label="标题" counter={{ value: runeLen(title), max: titleMax }} hint={wx ? '公众号标题不超过 32 字' : '小红书标题字数上限待核实（V-012），暂按 20 字提示'}>
          <div className="flex gap-2">
            <Input value={title} disabled={readOnly} onChange={(e) => setTitle(e.target.value)} invalid={wx && runeLen(title) > 32}
              onBlur={() => { if (title !== work.title && !(wx && runeLen(title) > 32)) { titleEdited(title); void save({ title }) } }} className="font-display text-[15px] font-semibold" />
            {!readOnly && <Button icon={<Sparkles className="size-4" />} loading={busy === 't'} onClick={genTitles}>候选</Button>}
          </div>
        </Field>
        {favs.length > 0 && (
          <div>
            <div className="mb-1.5 text-[12px] font-medium text-mist-600">收藏的候选</div>
            <div className="grid gap-2 sm:grid-cols-2">{favs.map(titleRow)}</div>
          </div>
        )}
        {titles.length > 0 && (
          <div className="space-y-3 rounded-xl bg-mist-50/70 p-3">
            <div className="flex flex-wrap items-center gap-2 text-[12px] text-mist-500">
              标题工作台
              {strong.length > 0 && <span>· 你过去表现较好的标题常见特征：{strong.map((s) => <Badge key={s} tone="gamboge" className="ml-1">{s}</Badge>)}</span>}
              <span className="text-mist-400">只展示可解释的特征，不做热度预测</span>
            </div>
            {groups.map((g) => (
              <div key={g}>
                <div className="mb-1 text-[11.5px] font-medium text-mist-500">{g}</div>
                <div className="grid gap-2 sm:grid-cols-2">{titles.filter((t) => t.style.replace('（改写自候选）', '') === g).map(titleRow)}</div>
              </div>
            ))}
            <RefsNote refs={titleRefs} callId={titleCall} onRetry={readOnly ? undefined : genTitles} />
          </div>
        )}
        {wx ? (
          <Field label="摘要" counter={{ value: runeLen(summary), max: 120 }} hint="留空时微信会自动抓取正文前 54 个字">
            <div className="flex gap-2">
              <Textarea rows={2} value={summary} disabled={readOnly} onChange={(e) => setSummary(e.target.value)} invalid={runeLen(summary) > 120}
                onBlur={() => summary !== work.summary && runeLen(summary) <= 120 && save({ summary })} />
              {!readOnly && <Button icon={<Sparkles className="size-4" />} loading={busy === 's'} onClick={genSummary}>生成</Button>}
            </div>
          </Field>
        ) : (
          <Field label="话题标签" hint="用空格分隔，例如：#职场 #效率。发布时在小红书里用话题选择器添加。">
            <Input value={topics} disabled={readOnly} onChange={(e) => setTopics(e.target.value)}
              onBlur={() => {
                const list = parseTopics(topics)
                if (list.join(' ') !== work.topics.join(' ')) save({ topics: list })
              }} />
            <div className="mt-2">
              <TagSuggest workId={work.id} current={parseTopics(topics)} disabled={readOnly} onAdd={(t) => {
                const list = [...parseTopics(topics), t]
                setTopics(list.map((x) => '#' + x).join(' '))
                save({ topics: list })
              }} />
            </div>
          </Field>
        )}
      </div>
    </Card>
  )
}

// ---------- 配图与封面 ----------

function ImagesCard({ work, setWork, readOnly, upload }: { work: Work; setWork: (w: Work) => void; readOnly: boolean; upload: (f: File) => Promise<Asset | null> }) {
  const wx = work.platform === 'wechat_mp'
  const [cropFor, setCropFor] = useState<Asset | null>(null)
  const [ratioCrop, setRatioCrop] = useState<Asset | null>(null)
  const [uploading, setUploading] = useState(0)
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const cover = work.assets.find((a) => a.id === work.cover_asset_id)
  const handleFiles = async (files: FileList | null) => {
    if (!files) return
    const list = Array.from(files)
    setUploading(list.length)
    for (const f of list) {
      await upload(f)
      setUploading((n) => n - 1)
    }
  }
  const move = async (a: Asset, d: number) => {
    const list = await patch<Asset[]>(`/assets/${a.id}`, { position: a.position + d })
    setWork({ ...work, assets: list })
  }
  const remove = async (a: Asset) => {
    if (!(await confirm({ title: '删除这张图片？', desc: a.id === work.cover_asset_id ? '它是当前封面，删除后需要重新设置封面。' : '正文中引用这张图片的地方会显示为空。', confirmText: '删除', danger: true }))) return
    await del(`/assets/${a.id}`)
    setWork(await get<Work>(`/works/${work.id}`))
  }
  const [coverInit, setCoverInit] = useState<Record<string, CropBox> | null>(null)
  const [library, setLibrary] = useState(false)
  const [cardMaker, setCardMaker] = useState(false)
  const setCover = async (a: Asset) => {
    let init = a.id === work.cover_asset_id && work.cover_crops ? work.cover_crops : null
    if (!init) {
      try {
        const r = await get<{ crops: Record<string, CropBox> }>(`/assets/${a.id}/smart-crop?aspects=2.35:1,1:1`)
        if (r.crops['2.35:1'] && r.crops['1:1']) init = { '2.35_1': r.crops['2.35:1'], '1_1': r.crops['1:1'] }
      } catch {
        // 智能裁剪失败时退回居中裁剪。
      }
    }
    setCoverInit(init ?? defaultCrops(a.width, a.height))
    setCropFor(a)
  }
  const saveCrop = async (crops: Record<string, unknown>) => {
    try {
      setWork(await patch<Work>(`/works/${work.id}`, { cover_asset_id: cropFor!.id, cover_crops: crops }))
      setCropFor(null)
      toast.success('封面已设置')
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  return (
    <Card id="step-images" className="scroll-mt-24 p-5">
      <div className="mb-4 flex items-center gap-2">
        <h2 className="font-display text-[17px] font-bold text-mist-900">{wx ? '配图与封面' : '笔记图片'}</h2>
        <span className="text-xs text-mist-400">{wx ? '正文图片会自动压缩到 1MB 以内' : `${work.assets.length} / 18 张，按顺序发布`}</span>
        {!readOnly && (
          <div className="ml-auto flex gap-2">
            {!wx && <Button size="sm" variant="ghost" icon={<Sparkles className="size-3.5" />} onClick={() => setCardMaker(true)}>文字卡片</Button>}
            <Button size="sm" variant="ghost" icon={<Images className="size-3.5" />} onClick={() => setLibrary(true)}>从图片库选择</Button>
            <Button size="sm" icon={<ImagePlus className="size-3.5" />} loading={uploading > 0} onClick={() => input.current?.click()}>上传图片</Button>
          </div>
        )}
      </div>
      {!readOnly && (
        <div className="mb-4 flex flex-wrap gap-2">
          <Input className="h-9 min-w-[220px] flex-1" value={aiPrompt} onChange={(e) => setAiPrompt(e.target.value)} placeholder="AI 出图提示词（生成图带「AI 生成」标识）" />
          <Button size="sm" variant="secondary" icon={<Sparkles className="size-3.5" />} loading={aiBusy} disabled={!aiPrompt.trim()} onClick={async () => {
            setAiBusy(true)
            try {
              const { job_id } = await post<{ job_id: string }>(`/works/${work.id}/generate-image`, { prompt: aiPrompt.trim(), background: true })
              const a = await waitJob<Asset>(job_id)
              setWork({ ...work, assets: [...work.assets, a] })
              setAiPrompt('')
              toast.success('已出图（含 AI 标识）')
            } catch (e) { aiError(e, 'AI 出图') }
            finally { setAiBusy(false) }
          }}>AI 出图</Button>
        </div>
      )}
      {wx && (
        <div className="mb-4 flex items-center gap-4 rounded-xl bg-mist-50 p-3">
          {cover && work.cover_crops ? (
            <>
              <CropPreview src={cover.url} box={work.cover_crops['2.35_1']} aspect={2.35} className="w-40 rounded-md" />
              <CropPreview src={cover.url} box={work.cover_crops['1_1']} aspect={1} className="w-[68px] rounded-md" />
              <div className="text-[13px] text-mist-600">已设置封面<div className="text-xs text-mist-400">左：消息列表大图，右：转发卡片小图</div></div>
              {!readOnly && <Button size="sm" variant="ghost" className="ml-auto" icon={<Crop className="size-3.5" />} onClick={() => void setCover(cover)}>调整裁剪</Button>}
            </>
          ) : (
            <p className="text-[13px] text-mist-500"><Star className="mr-1 inline size-3.5 text-gamboge-400" />还没有封面。写入草稿前必须设置封面：在下方图片上点「设为封面」。</p>
          )}
        </div>
      )}
      {work.assets.length === 0 ? (
        <button disabled={readOnly} onClick={() => input.current?.click()} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); handleFiles(e.dataTransfer.files) }}
          className="flex w-full cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-mist-200 py-10 text-mist-400 transition hover:border-ink-300 hover:text-ink-600">
          <ImagePlus className="mb-2 size-6" />
          <span className="text-[13px]">点击或拖拽上传图片（JPG、PNG、WebP、GIF，单张不超过 20MB）</span>
        </button>
      ) : (
        <div className="grid grid-cols-3 gap-3 md:grid-cols-4" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); handleFiles(e.dataTransfer.files) }}>
          {work.assets.map((a, i) => (
            <div key={a.id} className="group relative overflow-hidden rounded-lg border border-mist-200 bg-mist-50">
              <img src={a.url} alt="" className={cn('w-full object-cover', wx ? 'aspect-[4/3]' : 'aspect-[3/4]')} />
              <span className="absolute left-1.5 top-1.5 rounded bg-mist-900/60 px-1.5 text-[11px] font-medium text-white">{String(i + 1).padStart(2, '0')}</span>
              {a.id === work.cover_asset_id && <span className="absolute right-1.5 top-1.5 rounded bg-gamboge-400 px-1.5 text-[11px] font-bold text-mist-900">封面</span>}
              {a.ai_generated && <span className="absolute left-1.5 bottom-8 rounded bg-mist-900/70 px-1.5 text-[10px] text-white">AI</span>}
              {!readOnly && (
                <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-mist-900/70 to-transparent px-1.5 pb-1.5 pt-6 opacity-0 transition group-hover:opacity-100">
                  <div className="flex">
                    <button disabled={i === 0} onClick={() => move(a, -1)} className="cursor-pointer rounded p-1 text-white hover:bg-white/20 disabled:opacity-30" title="前移"><ArrowLeft className="size-3.5" /></button>
                    <button disabled={i === work.assets.length - 1} onClick={() => move(a, 1)} className="cursor-pointer rounded p-1 text-white hover:bg-white/20 disabled:opacity-30" title="后移"><ArrowRight className="size-3.5" /></button>
                  </div>
                  <div className="flex">
                    {wx && <button onClick={() => void setCover(a)} className="cursor-pointer rounded px-1.5 py-1 text-[11px] text-white hover:bg-white/20">设为封面</button>}
                    <button onClick={() => setRatioCrop(a)} className="cursor-pointer rounded px-1.5 py-1 text-[11px] text-white hover:bg-white/20" title="3:4 裁剪另存">3:4</button>
                    <button onClick={() => remove(a)} className="cursor-pointer rounded p-1 text-white hover:bg-white/20" title="删除"><Trash2 className="size-3.5" /></button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <input ref={input} type="file" accept="image/*" multiple hidden onChange={(e) => { handleFiles(e.target.files); e.target.value = '' }} />
      {cropFor && (
        <CoverCropDialog open onClose={() => setCropFor(null)} src={cropFor.url} width={cropFor.width} height={cropFor.height}
          initial={coverInit ?? defaultCrops(cropFor.width, cropFor.height)} onSave={saveCrop} />
      )}
      {library && <LibraryDialog work={work} onClose={() => setLibrary(false)} onPicked={(a) => setWork({ ...work, assets: [...work.assets, a] })} />}
      {!wx && <XhsCardMaker workId={work.id} open={cardMaker} onClose={() => setCardMaker(false)} onAdded={(a) => setWork({ ...work, assets: [...work.assets, a] })} />}
      {ratioCrop && (
        <AssetCropDialog open onClose={() => setRatioCrop(null)} src={ratioCrop.url} width={ratioCrop.width} height={ratioCrop.height}
          onSave={async (box) => {
            try {
              const a = await post<Asset>(`/assets/${ratioCrop.id}/crop`, { x1: box.x1, y1: box.y1, x2: box.x2, y2: box.y2, aspect: box.aspect })
              setWork({ ...work, assets: [...work.assets, a] })
              setRatioCrop(null)
              toast.success('已另存 3:4 裁剪图')
            } catch (e) { toast.error(errorMessage(e)) }
          }} />
      )}
    </Card>
  )
}

// ---------- 图片库（EX-G-04） ----------

function LibraryDialog({ work, onClose, onPicked }: { work: Work; onClose: () => void; onPicked: (a: Asset) => void }) {
  const [scope, setScope] = useState<'account' | 'all'>('account')
  const [ai, setAi] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const q = useQuery({
    queryKey: ['library', scope, ai, work.account_id],
    queryFn: () => get<LibraryAsset[]>(`/assets?${scope === 'account' ? `account_id=${work.account_id}&` : ''}${ai ? `ai=${ai}` : ''}`),
  })
  const list = (q.data ?? []).filter((a) => a.work_id !== work.id)
  const reuse = async (a: LibraryAsset) => {
    setBusy(a.id)
    try {
      onPicked(await post<Asset>(`/works/${work.id}/assets/reuse`, { asset_id: a.id }))
      toast.success('已加入本作品的图片')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }
  return (
    <Dialog open onClose={onClose} title="从图片库选择" desc="复用其他作品里的图片，不用重新上传。每次点选加入一张。" width="max-w-3xl"
      footer={<Button variant="primary" onClick={onClose}>完成</Button>}>
      <div className="mb-3 flex flex-wrap gap-2">
        <Select className="h-8 w-36 text-[12.5px]" value={scope} onChange={(e) => setScope(e.target.value as 'account' | 'all')}>
          <option value="account">本账号</option>
          <option value="all">全部账号</option>
        </Select>
        <Select className="h-8 w-36 text-[12.5px]" value={ai} onChange={(e) => setAi(e.target.value)}>
          <option value="">全部图片</option>
          <option value="0">实拍 / 上传</option>
          <option value="1">AI 生成</option>
        </Select>
      </div>
      {q.isLoading ? <Spinner /> : list.length === 0 ? <p className="py-10 text-center text-sm text-mist-400">图片库里还没有其他作品的图片。</p> : (
        <div className="scrollbar-thin grid max-h-[55vh] grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4 md:grid-cols-5">
          {list.map((a) => (
            <button key={a.id} type="button" disabled={!!busy} onClick={() => reuse(a)} title={`《${a.work_title || '未命名'}》 · ${a.account_name}`}
              className="group relative cursor-pointer overflow-hidden rounded-lg border border-mist-200 bg-mist-50 transition hover:border-ink-400">
              <img src={a.url} alt="" loading="lazy" className="aspect-square w-full object-cover" />
              {a.ai_generated && <span className="absolute left-1 top-1 rounded bg-mist-900/70 px-1 text-[10px] text-white">AI</span>}
              <span className="absolute inset-x-0 bottom-0 truncate bg-mist-900/60 px-1.5 py-0.5 text-[10.5px] text-white">{a.work_title || '未命名'}</span>
              {busy === a.id && <span className="absolute inset-0 flex items-center justify-center bg-white/60"><Loader2 className="size-5 animate-spin text-ink-600" /></span>}
            </button>
          ))}
        </div>
      )}
    </Dialog>
  )
}

// ---------- 页面 ----------

export default function Editor() {
  const { work } = useWork()
  if (work.content_format === 'comic') return <ComicEditor />
  if (work.content_format === 'card_post') return <CardEditor />
  return <ArticleEditor />
}

const SIDEBAR_KEY = 'ops.editor.sidebar'

/** LazyMount renders a light placeholder until the block comes near the viewport, then keeps it mounted (4.5). */
function LazyMount({ id, enabled, children, preview }: { id: string; enabled: boolean; children: React.ReactNode; preview: string }) {
  const [shown, setShown] = useState(!enabled)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (shown || !ref.current) return
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) setShown(true) }, { rootMargin: '800px 0px' })
    io.observe(ref.current)
    const show = (e: Event) => {
      const d = (e as CustomEvent<EditorEvent>).detail
      if (d && 'sectionId' in d && d.sectionId === id) setShown(true)
    }
    window.addEventListener('ops:editor', show)
    return () => { io.disconnect(); window.removeEventListener('ops:editor', show) }
  }, [shown, id])
  if (shown) return <>{children}</>
  return (
    <div ref={ref} id={`sec-${id}`} className="min-h-[160px] rounded-xl border border-mist-200/80 bg-white px-5 py-4 text-[14px] leading-relaxed text-mist-400 shadow-card">
      <p className="line-clamp-4 whitespace-pre-wrap">{preview || '（空段落）'}</p>
    </div>
  )
}

function ArticleEditor() {
  const { work, setWork, patchWork, refresh, focus, presence, reportSection, reportEditing } = useWork()
  const nav = useNavigate()
  const canWrite = useCanWrite()
  const prefs = usePrefs()
  const readOnly = work.locked || !canWrite
  const [save, setSave] = useState<SaveState>({ pending: 0, offline: false, last: null })
  const [activeId, setActiveId] = useState<string | null>(null)
  const [selection, setSelection] = useState('')
  const fromMention = new URLSearchParams(location.search).has('comment')
  const [sidebar, setSidebar] = useState(() => fromMention || localStorage.getItem(SIDEBAR_KEY) !== '0')
  const [sideTab, setSideTab] = useState<SidebarTab>(fromMention ? 'comments' : 'materials')
  const lintCounts = useRef<Record<string, number>>({})
  const resumeJobs = useQuery({
    queryKey: ['work-jobs', work.id],
    queryFn: () => get<AIJob[]>(`/ai-jobs?status=active&work_id=${work.id}`),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    select: (list) => Object.fromEntries(list.filter((j) => j.task_type === 'section_draft' && j.section_id).map((j) => [j.section_id!, j.id])),
  })
  const onSave = useCallback((d: number, offline = false) => {
    setSave((s) => ({ pending: Math.max(0, s.pending + d), offline, last: d < 0 && !offline ? new Date().toISOString() : s.last }))
  }, [])
  const setWorkStable = setWork
  useEffect(() => {
    if (!location.hash) return
    const t = window.setTimeout(() => document.getElementById(location.hash.slice(1).replace(/^section-/, 'sec-'))?.scrollIntoView({ behavior: 'smooth' }), 300)
    return () => window.clearTimeout(t)
  }, [])
  const toggleSidebar = (v: boolean) => {
    setSidebar(v)
    localStorage.setItem(SIDEBAR_KEY, v ? '1' : '0')
  }
  useEditorEvents((e) => {
    if (e.type === 'sidebar') setSideTab(e.tab)
    if (e.type === 'comment') setSideTab('comments')
    if ((e.type === 'sidebar' || e.type === 'comment') && !sidebar) toggleSidebar(true)
  })
  const onActive = useCallback((id: string, sel: string) => {
    setActiveId(id)
    setSelection(sel)
    reportSection(id)
  }, [reportSection])

  const upload = async (f: File): Promise<Asset | null> => {
    const fd = new FormData()
    fd.append('file', f)
    try {
      const res = await rawRequest('POST', `/works/${work.id}/assets`, fd)
      const a = (await res.json()) as Asset
      patchWork((w) => ({ assets: [...w.assets, a] }))
      return a
    } catch (e) {
      toast.error(`${f.name}：${errorMessage(e)}`)
      return null
    }
  }
  const addSection = async () => {
    try {
      setWork(await post<Work>(`/works/${work.id}/sections`, { heading: '' }))
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const moveSection = async (i: number, d: number) => {
    const before = work
    const sections = [...work.sections]
    const j = i + d
    ;[sections[i], sections[j]] = [sections[j], sections[i]]
    setWork({ ...work, sections })
    try {
      setWork(await put<Work>(`/works/${work.id}/sections/order`, { ids: sections.map((s) => s.id) }))
    } catch (e) {
      setWork(before)
      toast.error(errorMessage(e))
    }
  }
  // 删除不再二次确认，改为可撤销（4.3 撤销体系）。
  const removeSection = async (s: Section) => {
    const n = work.sections.findIndex((x) => x.id === s.id) + 1
    try {
      setWork(await del<Work>(`/sections/${s.id}`))
      toast(`已删除第 ${n} 段`, {
        duration: 10_000,
        action: {
          label: '撤销',
          onClick: async () => {
            try {
              setWork(await post<Work>(`/sections/${s.id}/restore`))
            } catch (e) {
              toast.error(errorMessage(e))
            }
          },
        },
      })
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const drafted = work.sections.filter((s) => s.content_md.trim()).length
  const emptySections = work.sections.filter((s) => !s.content_md.trim())
  const totalChars = work.sections.reduce((n, s) => n + runeLen(s.content_md.replace(/[#>*_`[\]()!-]/g, '')), 0)
  const target = work.target_chars ?? 0
  const pendingAll = work.sections.flatMap((s) => findPending(s.content_md).map((p) => ({ s, p })))
  const titleDone = !!work.title.trim()
  const imagesDone = work.platform === 'wechat_mp' ? !!work.cover_asset_id : work.assets.length > 0
  const steps = [
    { id: 'step-viewpoint', label: '核心观点', done: !!work.viewpoint.trim() },
    { id: 'step-outline', label: '大纲', done: !!work.outline_confirmed_at },
    { id: 'step-sections', label: '分段起稿', done: work.sections.length > 0 && drafted === work.sections.length, extra: work.sections.length ? `${drafted}/${work.sections.length}` : '' },
    { id: 'step-title', label: work.platform === 'wechat_mp' ? '标题与摘要' : '标题与话题', done: titleDone },
    { id: 'step-images', label: work.platform === 'wechat_mp' ? '配图与封面' : '笔记图片', done: imagesDone },
  ]
  const activeStep = !work.viewpoint.trim() ? 'step-viewpoint'
    : !work.outline_confirmed_at ? 'step-outline'
    : emptySections.length > 0 ? 'step-sections'
    : !titleDone ? 'step-title'
    : 'step-images'
  const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  const jumpNextEmpty = (afterId?: string) => {
    const list = work.sections
    const isEmpty = (s: (typeof list)[number]) => s.id !== afterId && !s.content_md.trim()
    const last = list[list.length - 1]
    if (!afterId && prefs.write_ending_first && last && isEmpty(last) && list.length > 1) {
      scrollTo(`sec-${last.id}`)
      return true
    }
    const start = afterId ? list.findIndex((s) => s.id === afterId) + 1 : 0
    const next = list.slice(Math.max(0, start)).find(isEmpty) ?? list.find(isEmpty)
    if (next) {
      scrollTo(`sec-${next.id}`)
      return true
    }
    return false
  }
  const onOutlineConfirmed = () => {
    window.setTimeout(() => scrollTo('step-sections'), 80)
  }
  const onDrafted = (sectionId: string) => {
    if (!prefs.auto_jump_next_empty) return
    window.setTimeout(() => {
      if (jumpNextEmpty(sectionId)) toast.message('已跳到下一段空稿')
    }, 120)
  }
  // F8：跳到下一处待核实并打开处理面板（EX-E-04）。
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'F8' || readOnly) return
      e.preventDefault()
      if (!pendingAll.length) return toast.message('没有待核实的地方了')
      const cur = work.sections.findIndex((s) => s.id === activeId)
      const next = pendingAll.find(({ s }) => work.sections.indexOf(s) > cur) ?? pendingAll[0]
      scrollToSection(next.s.id)
      emitEditor({ type: 'open-pending', sectionId: next.s.id, index: next.p.index })
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  })
  const gotoSection = (id: string) => {
    scrollToSection(id)
    window.setTimeout(() => emitEditor({ type: 'focus', sectionId: id }), 250)
  }
  useWorkCmd((c) => c.cmd === 'goto' && gotoSection(c.sectionId))
  const saveVersion = async () => {
    const wait: Promise<unknown>[] = []
    emitEditor({ type: 'flush', wait })
    try {
      await Promise.all(wait)
      await post(`/works/${work.id}/versions`)
      toast.success('已保存，并留了一个手动版本')
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  // 编辑器快捷键（10 文档 9.1）：Ctrl+S 保存版本、Ctrl+J 副驾驶、Alt+↑/↓ 切段、Alt+N 下一段空稿。
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const mod = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (!readOnly) void saveVersion()
        return
      }
      if (mod && e.key.toLowerCase() === 'j') {
        e.preventDefault()
        if (showSidebar && sideTab === 'copilot') toggleSidebar(false)
        else {
          setSideTab('copilot')
          if (!sidebar) toggleSidebar(true)
        }
        return
      }
      if (!e.altKey || e.ctrlKey || e.metaKey || !work.sections.length) return
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault()
        const cur = work.sections.findIndex((s) => s.id === activeId)
        const next = cur < 0 ? 0 : Math.min(work.sections.length - 1, Math.max(0, cur + (e.key === 'ArrowUp' ? -1 : 1)))
        gotoSection(work.sections[next].id)
      } else if (e.key.toLowerCase() === 'n' || e.code === 'KeyN') {
        e.preventDefault()
        const list = work.sections
        const start = list.findIndex((s) => s.id === activeId) + 1
        const next = list.slice(start).find((s) => !s.content_md.trim()) ?? list.find((s) => s.id !== activeId && !s.content_md.trim())
        if (next) gotoSection(next.id)
        else toast.message('没有空段落了')
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  })
  // 检查前预检（EX-H-03）：只提醒，可以继续。
  const toCheck = async () => {
    let lintTotal = Object.values(lintCounts.current).reduce((a, b) => a + b, 0)
    const body = work.sections.map((s) => s.content_md).join('\n\n')
    if (body.trim()) {
      try {
        const r = await post<{ hits: LintHit[] }>(`/works/${work.id}/lint`, { text: body })
        lintTotal = r.hits.filter((h) => h.category !== 'pending').length
      } catch { /* 预检失败不拦提交 */ }
    }
    const parts: string[] = []
    if (pendingAll.length) parts.push(`${pendingAll.length} 处待核实`)
    if (lintTotal) parts.push(`${lintTotal} 处敏感词或极限词提示`)
    if (parts.length && !(await confirm({ title: `还有 ${parts.join('、')}`, desc: '建议先处理再提交检查；也可以继续，检查页会逐项列出。', confirmText: '继续提交检查', cancelText: '先去处理' }))) {
      if (pendingAll.length) emitEditor({ type: 'sidebar', tab: 'pending' })
      return
    }
    nav(work.platform === 'wechat_mp' ? `/works/${work.id}/preview?next=check` : `/works/${work.id}/check?start=1`)
  }
  const remainHints: string[] = []
  if (work.outline_confirmed_at && emptySections.length > 0) remainHints.push(`还差 ${emptySections.length} 段未起草`)
  if (pendingAll.length > 0) remainHints.push(`${pendingAll.length} 处待核实（F8 逐个处理）`)
  if (work.outline_confirmed_at && drafted > 0 && !titleDone) remainHints.push('标题未定')
  if (work.outline_confirmed_at && drafted > 0 && !imagesDone) {
    remainHints.push(work.platform === 'wechat_mp' ? '封面未设' : '图片未加')
  }
  const activeIdx = work.sections.findIndex((s) => s.id === activeId)
  const active = activeIdx >= 0 ? work.sections[activeIdx] : null
  const showSidebar = sidebar && !focus

  return (
    <div className={cn('mx-auto flex w-full gap-6 px-4 py-6 sm:px-6 sm:py-8 xl:gap-8', focus ? 'max-w-[860px]' : showSidebar ? 'max-w-[1600px]' : 'max-w-[1280px] 2xl:max-w-[1480px]')}>
      {!focus && (
        <aside className="sticky top-24 hidden h-fit w-52 shrink-0 lg:block">
          <div className="mb-3 text-[11px] font-semibold tracking-wider text-mist-400">创作步骤</div>
          <ol className="space-y-0.5">
            {steps.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`} onClick={(e) => { e.preventDefault(); scrollTo(s.id) }}
                  className={cn(
                    'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13.5px] transition',
                    s.id === activeStep ? 'bg-ink-50 font-medium text-ink-800' : 'text-mist-600 hover:bg-mist-100 hover:text-mist-900',
                  )}>
                  {s.done ? <CheckCircle2 className="size-4 text-ink-500" /> : <Circle className={cn('size-4', s.id === activeStep ? 'text-ink-400' : 'text-mist-300')} />}
                  <span className="flex-1">{s.label}</span>
                  {s.extra && <span className="font-mono text-xs text-mist-400">{s.extra}</span>}
                </a>
              </li>
            ))}
          </ol>
          <div className="mt-4 border-t border-mist-100 pt-3 text-[11.5px] text-mist-500">
            <div className="flex items-baseline justify-between">
              <span>{totalChars} 字{target ? ` / 目标 ${target}` : ''}</span>
              <span>约 {Math.max(1, Math.ceil(totalChars / 400))} 分钟读完</span>
            </div>
            {target > 0 && (
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-mist-100">
                <div className={cn('h-full rounded-full transition-all', totalChars >= target ? 'bg-ink-500' : 'bg-gamboge-400')} style={{ width: `${Math.min(100, (totalChars / target) * 100)}%` }} />
              </div>
            )}
          </div>
          {remainHints.length > 0 && (
            <ul className="mt-3 space-y-1 border-t border-mist-100 pt-3 text-[11.5px] leading-relaxed text-mist-500">
              {remainHints.map((h) => <li key={h}>· {h}</li>)}
            </ul>
          )}
          {!readOnly && emptySections.length > 0 && work.outline_confirmed_at && (
            <Button size="sm" variant="secondary" className="mt-3 w-full" onClick={() => jumpNextEmpty()}>下一段空稿</Button>
          )}
          <div className="mt-6 border-t border-mist-200 pt-4 text-xs text-mist-500">
            {save.offline ? <span className="flex items-center gap-1.5 text-danger"><CloudOff className="size-3.5" />离线，未保存（恢复后自动同步）</span>
              : save.pending > 0 ? <span className="flex items-center gap-1.5"><Loader2 className="size-3.5 animate-spin" />保存中…</span>
              : save.last ? <span className="flex items-center gap-1.5"><Check className="size-3.5 text-ink-500" />已保存 {fmtTime(save.last)}</span>
              : <span>自动保存已开启</span>}
          </div>
          {!readOnly && (
            <Button variant="primary" className="mt-4 w-full" onClick={toCheck} disabled={drafted === 0} icon={<PenLine className="size-4" />}>
              {work.platform === 'wechat_mp' ? '排版并检查' : '提交检查'}
            </Button>
          )}
        </aside>
      )}

      <div className="min-w-0 flex-1 space-y-5">
        {focus && (
          <div className="flex items-center gap-3 text-[12px] text-mist-500">
            <span>专注模式 · F11 退出</span>
            <span className="ml-auto">{totalChars} 字{target ? ` / ${target}` : ''}</span>
            {target > 0 && <div className="h-1 w-32 overflow-hidden rounded-full bg-mist-100"><div className="h-full bg-ink-500" style={{ width: `${Math.min(100, (totalChars / target) * 100)}%` }} /></div>}
          </div>
        )}
        {!focus && <OrganizeNotesCard work={work} setWork={setWorkStable} readOnly={readOnly} />}
        {!focus && <ViewpointCard work={work} setWork={setWorkStable} readOnly={readOnly} />}
        {!focus && <OutlineCard work={work} setWork={setWorkStable} readOnly={readOnly} onConfirmed={onOutlineConfirmed} />}
        <section id="step-sections" className="scroll-mt-24 space-y-4">
          <div className="flex flex-wrap items-center gap-2 pt-2">
            <h2 className="font-display text-[17px] font-bold text-mist-900">正文</h2>
            <span className="text-xs text-mist-400">每一段单独起草，没有「全部起草」</span>
            {!readOnly && emptySections.length > 0 && work.outline_confirmed_at && (
              <Button size="sm" variant="ghost" className="ml-auto" onClick={() => jumpNextEmpty()}>跳到下一段空稿（{emptySections.length}）</Button>
            )}
          </div>
          {!work.outline_confirmed_at ? (
            <HumanGate code="H-03">确认大纲后，这里会按大纲生成段落块，然后你可以逐段起草和修改。</HumanGate>
          ) : (
            <>
              {work.sections.map((s, i) => (
                <LazyMount key={s.id} id={s.id} enabled={work.sections.length > 30 && i > 3} preview={s.content_md}>
                <SectionBlock key={s.id} section={s} index={i} total={work.sections.length} work={work} prefs={prefs} patchWork={patchWork} setWork={setWorkStable}
                  refresh={refresh} readOnly={readOnly} dim={focus && activeIdx >= 0 && Math.abs(i - activeIdx) > 1}
                  othersHere={presence.filter((p) => p.section_id === s.id).map((p) => p.username)}
                  othersEditing={presence.filter((p) => p.section_id === s.id && p.editing).map((p) => p.username)} onEditing={reportEditing}
                  onSave={onSave} onMove={(d) => moveSection(i, d)} onRemove={() => removeSection(s)} onUploadImage={upload} onDrafted={onDrafted}
                  onActive={onActive} onLint={(id, n) => { lintCounts.current[id] = n }} resumeJob={resumeJobs.data?.[s.id]} />
                </LazyMount>
              ))}
              {!readOnly && (
                <button type="button" onClick={addSection} className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl border-2 border-dashed border-mist-200 py-3 text-[13px] text-mist-500 transition hover:border-ink-300 hover:text-ink-600">
                  <Plus className="size-4" />新增段落
                </button>
              )}
            </>
          )}
        </section>
        {!focus && <TitleCard work={work} setWork={setWorkStable} readOnly={readOnly} />}
        {!focus && <ImagesCard work={work} setWork={setWorkStable} readOnly={readOnly} upload={upload} />}
        {!readOnly && !focus && (
          <div className="flex justify-end pb-10 lg:hidden">
            <Button variant="primary" onClick={toCheck} disabled={drafted === 0}>{work.platform === 'wechat_mp' ? '排版并检查' : '提交检查'}</Button>
          </div>
        )}
        {work.locked && <Notice tone="gray">作品已发布，当前为只读模式。</Notice>}
      </div>

      {showSidebar ? (
        <aside className="sticky top-20 hidden h-[calc(100vh-6.5rem)] w-[320px] shrink-0 overflow-hidden rounded-xl border border-mist-200 bg-white shadow-card xl:block 2xl:w-[360px]">
          <EditorSidebar work={work} setWork={setWorkStable} active={active} selection={selection} tab={sideTab} onTab={setSideTab} onClose={() => toggleSidebar(false)} />
        </aside>
      ) : !focus && (
        <button type="button" onClick={() => toggleSidebar(true)} title="打开助手侧栏：素材推荐、副驾驶、体检、待核实、批注、动态"
          className="fixed right-4 top-1/2 z-20 hidden -translate-y-1/2 cursor-pointer flex-col items-center gap-1 rounded-xl border border-mist-200 bg-white px-2 py-3 text-[11px] text-mist-500 shadow-pop transition hover:text-ink-700 xl:flex">
          <PanelRightOpen className="size-4" />助手
          {pendingAll.length > 0 && <span className="rounded-full bg-gamboge-400 px-1 text-[10px] font-bold text-mist-900">{pendingAll.length}</span>}
        </button>
      )}
    </div>
  )
}
