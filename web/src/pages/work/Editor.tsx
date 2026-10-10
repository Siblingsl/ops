import { useQuery } from '@tanstack/react-query'
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, BookmarkPlus, Check, CheckCircle2, Circle, CloudOff, Crop, ImagePlus, Loader2, Minimize2,
  PenLine, Plus, Repeat2, Sparkles, Square, Star, Trash2, Wand2, X,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { AssetCropDialog, CoverCropDialog, CropPreview, defaultCrops } from '@/components/cover-crop'
import { confirm, Dialog } from '@/components/dialog'
import { RefsNote } from '@/components/refs'
import { type EditorHandle, PlainEditor, RichEditor } from '@/components/section-editor'
import { Badge, Button, Card, cn, Field, HumanGate, IconButton, Input, Notice, Select, Textarea } from '@/components/ui'
import { ApiError, del, errorMessage, get, patch, post, put, rawRequest, stream } from '@/lib/api'
import { type AIRefs, copyText, fmtTime, parseTopics, runeLen } from '@/lib/format'
import { useCanWrite } from '@/lib/session'
import type { Asset, Material, MaterialKind, OutlineItem, Section, Work } from '@/lib/types'
import ComicEditor from './ComicEditor'
import { useWork } from './WorkLayout'

const kindLabel: Record<MaterialKind, string> = { experience: '经历', opinion: '观点', case: '案例', data: '数据' }

type SaveState = { pending: number; offline: boolean; last: string | null }

// ---------- 核心观点（H-02） ----------

function ViewpointCard({ work, setWork, readOnly }: { work: Work; setWork: (w: Work) => void; readOnly: boolean }) {
  const [text, setText] = useState(work.viewpoint)
  const [picking, setPicking] = useState(false)
  const { data: materials } = useQuery({
    queryKey: ['materials', work.account_id, ''],
    queryFn: () => get<Material[]>(`/materials?account_id=${work.account_id}`),
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
  return (
    <Card id="step-viewpoint" className="scroll-mt-24 p-5">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="font-display text-[17px] font-bold text-mist-900">核心观点</h2>
        <Badge tone="gamboge">H-02 必须由你来写</Badge>
      </div>
      <Textarea rows={3} value={text} disabled={readOnly} onChange={(e) => setText(e.target.value)} onBlur={save}
        placeholder="用一两句话写下你自己的观点。AI 会围绕它组织大纲，不会替你决定立场。"
        className="font-display text-[16px] leading-relaxed" />
      <div className="mt-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[13px] font-medium text-mist-700">参考素材 <span className="font-normal text-mist-400">· AI 只会把这些当作事实来源</span></span>
          {!readOnly && <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => setPicking(true)}>选择素材</Button>}
        </div>
        {selected.length === 0 ? (
          <p className="rounded-lg border border-dashed border-mist-200 px-3 py-3 text-[13px] text-mist-400">还没有选择素材。没有素材时，AI 遇到需要数据的地方会写成「【待核实：…】」让你补充。</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {selected.map((m) => (
              <span key={m.id} className="inline-flex max-w-full items-center gap-1.5 rounded-lg bg-mist-100 py-1 pl-2.5 pr-1 text-[12.5px] text-mist-700">
                <Badge tone="ink">{kindLabel[m.kind]}</Badge>
                <span className="max-w-64 truncate">{m.content}</span>
                {!readOnly && <button onClick={() => toggle(m.id)} className="cursor-pointer rounded p-0.5 text-mist-400 hover:bg-mist-200 hover:text-mist-700"><X className="size-3" /></button>}
              </span>
            ))}
          </div>
        )}
      </div>
      <Dialog open={picking} onClose={() => setPicking(false)} title="选择参考素材" desc="只列出本账号和共享的素材。" width="max-w-xl"
        footer={<Button variant="primary" onClick={() => setPicking(false)}>完成</Button>}>
        <div className="scrollbar-thin max-h-[50vh] space-y-2 overflow-y-auto">
          {(materials ?? []).length === 0 && <p className="py-8 text-center text-sm text-mist-400">素材库是空的，可以先去「素材库」添加经历、观点、案例和数据。</p>}
          {(materials ?? []).map((m) => (
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

function OutlineCard({ work, setWork, readOnly }: { work: Work; setWork: (w: Work) => void; readOnly: boolean }) {
  const confirmed = !!work.outline_confirmed_at
  const [items, setItems] = useState<OutlineItem[]>(work.outline)
  const [editing, setEditing] = useState(!confirmed)
  const [busy, setBusy] = useState<'gen' | 'save' | 'confirm' | null>(null)
  const [refs, setRefs] = useState<AIRefs | null>(null)
  useEffect(() => {
    setItems(work.outline)
    setEditing(!work.outline_confirmed_at)
  }, [work.outline, work.outline_confirmed_at])
  const noViewpoint = !work.viewpoint.trim()
  const generate = async () => {
    if (items.length && !(await confirm({ title: '重新生成大纲？', desc: '当前未确认的大纲会被替换。已经确认生成的段落不受影响。', confirmText: '重新生成' }))) return
    setBusy('gen')
    try {
      const r = await post<{ items: OutlineItem[]; refs: AIRefs }>(`/works/${work.id}/outline/generate`)
      setItems(r.items)
      setRefs(r.refs)
      setEditing(true)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }
  const save = async (confirmIt: boolean) => {
    setBusy(confirmIt ? 'confirm' : 'save')
    try {
      const w = await put<Work>(`/works/${work.id}/outline`, { items, confirm: confirmIt })
      setWork(w)
      if (confirmIt) {
        setEditing(false)
        toast.success('大纲已确认，可以逐段起草了')
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
        <div className="ml-auto flex gap-2">
          {!readOnly && <Button size="sm" variant={items.length ? 'ghost' : 'primary'} icon={<Sparkles className="size-3.5" />} loading={busy === 'gen'} disabled={noViewpoint} onClick={generate}
            title={noViewpoint ? '请先写下核心观点' : undefined}>{items.length ? '重新生成' : 'AI 生成大纲'}</Button>}
          {confirmed && !editing && !readOnly && <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>修改大纲</Button>}
        </div>
      </div>
      {noViewpoint && !confirmed && <HumanGate code="H-02" className="mb-3">先写下你的核心观点，才能生成大纲。</HumanGate>}
      <RefsNote refs={refs} className="mb-3" />
      {!editing ? (
        <ol className="space-y-1.5">
          {items.map((it, i) => (
            <li key={i} className="flex gap-3 text-[13.5px]">
              <span className="w-5 shrink-0 text-right font-mono text-mist-400">{i + 1}</span>
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
                <li key={i} className="group flex items-start gap-2 rounded-lg border border-mist-200 bg-white p-2.5">
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

// ---------- 段落块 ----------

function SaveToMaterial({ text, work, onClose }: { text: string; work: Work; onClose: () => void }) {
  const [kind, setKind] = useState<MaterialKind>('opinion')
  const [content, setContent] = useState(text)
  const [shared, setShared] = useState(false)
  const save = async () => {
    try {
      await post('/materials', { account_id: shared ? null : work.account_id, kind, content, source: `作品《${work.title || '未命名'}》` })
      toast.success('已存入素材库')
      onClose()
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  return (
    <Dialog open onClose={onClose} title="存入素材库" footer={<><Button variant="ghost" onClick={onClose}>取消</Button><Button variant="primary" onClick={save}>保存</Button></>}>
      <div className="space-y-4">
        <Field label="类型">
          <Select value={kind} onChange={(e) => setKind(e.target.value as MaterialKind)}>
            {Object.entries(kindLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Field>
        <Field label="内容"><Textarea rows={4} value={content} onChange={(e) => setContent(e.target.value)} /></Field>
        <label className="flex items-center gap-2 text-[13px] text-mist-600"><input type="checkbox" className="accent-ink-600" checked={shared} onChange={(e) => setShared(e.target.checked)} />设为共享素材（所有账号都能引用）</label>
      </div>
    </Dialog>
  )
}

const originMeta = { ai: { label: 'AI 生成', tone: 'ink' as const }, human: { label: '手写', tone: 'gray' as const }, mixed: { label: 'AI + 人工修改', tone: 'blue' as const } }

function SectionBlock({ section, index, total, work, patchWork, refresh, readOnly, onSave, onMove, onRemove, onUploadImage }: {
  section: Section
  index: number
  total: number
  work: Work
  patchWork: (p: Partial<Work>) => void
  refresh: () => Promise<unknown>
  readOnly: boolean
  onSave: (d: number, offline?: boolean) => void
  onMove: (d: number) => void
  onRemove: () => void
  onUploadImage: (f: File) => Promise<Asset | null>
}) {
  const xhs = work.platform === 'xhs'
  const editor = useRef<EditorHandle>(null)
  const [heading, setHeading] = useState(section.heading)
  const [resetKey, setResetKey] = useState(0)
  const content = useRef(section.content_md)
  const revision = useRef(section.revision)
  const [origin, setOrigin] = useState(section.origin)
  const [streaming, setStreaming] = useState<{ kind: 'draft' | 'edit'; text: string } | null>(null)
  const [proposal, setProposal] = useState<{ original: string; text: string; whole: boolean } | null>(null)
  const [refs, setRefs] = useState<AIRefs | null>(null)
  const dirty = useRef(false)
  const [selection, setSelection] = useState('')
  const [conflict, setConflict] = useState<Section | null>(null)
  const [toMaterial, setToMaterial] = useState<string | null>(null)
  const [imgSuggest, setImgSuggest] = useState<{ description: string; prompt: string }[] | null>(null)
  const [imgBusy, setImgBusy] = useState(false)
  const [isEmpty, setIsEmpty] = useState(!section.content_md.trim())
  const abort = useRef<AbortController | null>(null)
  const timer = useRef<number>()
  const fileInput = useRef<HTMLInputElement>(null)
  const stashKey = `ops.unsaved.${section.id}`

  useEffect(() => {
    // 恢复离线时暂存的内容（E-12）。
    const raw = localStorage.getItem(stashKey)
    if (!raw) return
    const s = JSON.parse(raw) as { content: string; revision: number }
    if (s.content !== section.content_md && s.revision === section.revision) {
      content.current = s.content
      setResetKey((k) => k + 1)
      schedule()
      toast.info(`第 ${index + 1} 段恢复了未同步的修改`)
    } else localStorage.removeItem(stashKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const persist = useCallback(async (body: Record<string, unknown>) => {
    onSave(1)
    dirty.current = false
    try {
      const r = await patch<{ section: Section; work_revision: number; work_status: Work['status'] }>(`/sections/${section.id}`, { ...body, base_revision: revision.current })
      revision.current = r.section.revision
      setOrigin(r.section.origin)
      localStorage.removeItem(stashKey)
      patchWork({ status: r.work_status, revision: r.work_revision })
      onSave(-1)
    } catch (e) {
      if (e instanceof ApiError && e.code === 'version_conflict') {
        setConflict((e.detail as { server: Section }).server)
        onSave(-1)
      } else if (e instanceof ApiError && e.code === 'network') {
        localStorage.setItem(stashKey, JSON.stringify({ content: content.current, revision: revision.current }))
        onSave(-1, true)
        window.setTimeout(() => persist({ content_md: content.current }), 5000)
      } else {
        onSave(-1)
        toast.error(errorMessage(e))
      }
    }
  }, [section.id, patchWork, onSave, stashKey])

  useEffect(() => {
    if (section.revision === revision.current || dirty.current) return
    revision.current = section.revision
    content.current = section.content_md
    setHeading(section.heading)
    setOrigin(section.origin)
    setIsEmpty(!section.content_md.trim())
    setResetKey((k) => k + 1)
  }, [section.revision, section.content_md, section.heading, section.origin])

  const schedule = () => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => persist({ content_md: content.current }), 1200)
  }
  useEffect(() => () => window.clearTimeout(timer.current), [])

  const onChange = (md: string) => {
    content.current = md
    dirty.current = true
    setIsEmpty(!md.trim())
    localStorage.setItem(stashKey, JSON.stringify({ content: md, revision: revision.current }))
    schedule()
  }

  const draft = async () => {
    if (content.current.trim() && !(await confirm({ title: '重新起草这一段？', desc: '当前内容会被替换，替换前的内容保存在版本历史中。', confirmText: '重新起草' }))) return
    window.clearTimeout(timer.current)
    abort.current = new AbortController()
    setStreaming({ kind: 'draft', text: '' })
    try {
      const r = await stream<{ result: Section; refs: AIRefs }>(`/sections/${section.id}/draft`, {}, {
        signal: abort.current.signal,
        onDelta: (t) => setStreaming((s) => (s ? { ...s, text: s.text + t } : s)),
      })
      setRefs(r.refs)
      content.current = r.result.content_md
      revision.current = r.result.revision
      setOrigin('ai')
      setIsEmpty(false)
      setResetKey((k) => k + 1)
      refresh()
    } catch (e) {
      if ((e as Error).name !== 'AbortError') toast.error(errorMessage(e))
    } finally {
      setStreaming(null)
    }
  }

  const flush = async () => {
    if (!dirty.current) return
    window.clearTimeout(timer.current)
    await persist({ content_md: content.current })
  }

  const edit = async (mode: 'rewrite' | 'expand' | 'shorten') => {
    const sel = editor.current?.selectedText() || ''
    const original = sel || content.current
    if (!original.trim()) return toast.info('这一段还没有内容')
    await flush()
    abort.current = new AbortController()
    setStreaming({ kind: 'edit', text: '' })
    try {
      const r = await stream<{ text: string; refs: AIRefs }>(`/sections/${section.id}/edit`, { mode, selection: sel }, {
        signal: abort.current.signal,
        onDelta: (t) => setStreaming((s) => (s ? { ...s, text: s.text + t } : s)),
      })
      setRefs(r.refs)
      setProposal({ original, text: r.text.trim(), whole: !sel })
    } catch (e) {
      if ((e as Error).name !== 'AbortError') toast.error(errorMessage(e))
    } finally {
      setStreaming(null)
    }
  }

  const accept = () => {
    if (!proposal) return
    if (proposal.whole) editor.current?.setMarkdown(proposal.text)
    else editor.current?.replaceSelection(proposal.text)
    setProposal(null)
  }

  const resolveConflict = (keepMine: boolean) => {
    if (!conflict) return
    revision.current = conflict.revision
    if (keepMine) persist({ content_md: content.current, heading })
    else {
      content.current = conflict.content_md
      setHeading(conflict.heading)
      setResetKey((k) => k + 1)
    }
    setConflict(null)
  }

  const pickImage = () => fileInput.current?.click()
  const pendingCount = (content.current.match(/【待核实[^】]*】/g) ?? []).length
  const Editor = xhs ? PlainEditor : RichEditor
  const busy = !!streaming
  const bubble = (
    <div className="flex items-center gap-0.5 rounded-lg border border-mist-200 bg-white p-1 shadow-pop">
      <Button size="sm" variant="ghost" icon={<Repeat2 className="size-3.5" />} onClick={() => edit('rewrite')}>改写选中部分</Button>
      <Button size="sm" variant="ghost" icon={<BookmarkPlus className="size-3.5" />} onClick={() => setToMaterial(editor.current?.selectedText() || '')}>存入素材库</Button>
    </div>
  )

  return (
    <div id={`sec-${section.id}`} className="group/sec relative scroll-mt-24 rounded-xl border border-mist-200/80 bg-white shadow-card transition focus-within:border-ink-200 focus-within:shadow-pop">
      <div className={cn('absolute bottom-3 left-0 top-3 w-[3px] rounded-r', origin === 'ai' ? 'bg-ink-300' : origin === 'mixed' ? 'bg-sky-300' : 'bg-mist-200')} />
      <div className="flex items-center gap-2 border-b border-mist-100 px-5 py-2.5">
        <span className="font-mono text-xs text-mist-400">{String(index + 1).padStart(2, '0')}</span>
        {xhs ? (
          <span className="text-[13px] font-medium text-mist-600">{section.key_point || `第 ${index + 1} 段`}</span>
        ) : (
          <input value={heading} disabled={readOnly} onChange={(e) => setHeading(e.target.value)} onBlur={() => heading !== section.heading && persist({ heading })}
            placeholder="段落小标题" className="min-w-0 flex-1 bg-transparent font-display text-[16px] font-bold text-mist-900 outline-none placeholder:text-mist-300" />
        )}
        <Badge tone={originMeta[origin].tone} className="ml-auto">{originMeta[origin].label}</Badge>
        {!readOnly && (
          <div className="flex items-center opacity-0 transition group-hover/sec:opacity-100">
            <IconButton label="上移" disabled={index === 0} onClick={() => onMove(-1)}><ArrowUp className="size-3.5" /></IconButton>
            <IconButton label="下移" disabled={index === total - 1} onClick={() => onMove(1)}><ArrowDown className="size-3.5" /></IconButton>
            <IconButton label="删除段落" className="hover:text-danger" onClick={onRemove}><Trash2 className="size-3.5" /></IconButton>
          </div>
        )}
      </div>
      {section.key_point && !xhs && <div className="px-5 pt-2.5 text-[12.5px] text-mist-400">要点：{section.key_point}</div>}
      <div className="px-5 py-3">
        {streaming?.kind === 'draft' ? (
          <div className="min-h-[4em] whitespace-pre-wrap text-[15px] leading-[1.9] text-mist-700">
            {streaming.text}<span className="ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 animate-pulse bg-ink-500" />
            {!streaming.text && <span className="text-mist-400">正在根据观点、大纲和素材起草…</span>}
          </div>
        ) : (
          <Editor ref={editor} value={content.current} resetKey={resetKey} onChange={onChange} editable={!readOnly && !busy}
            placeholder={isEmpty ? '点「起草本段」让 AI 写初稿，或者直接自己写。' : ''} onSelection={setSelection}
            bubble={xhs ? undefined : bubble} onPickImage={xhs ? undefined : pickImage} />
        )}
        {streaming?.kind === 'edit' && (
          <div className="mt-3 rounded-lg border border-ink-100 bg-ink-50/50 p-3 text-[14px] leading-relaxed text-mist-700">
            <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-ink-600"><Loader2 className="size-3 animate-spin" />生成中</div>
            {streaming.text}
          </div>
        )}
        {proposal && (
          <div className="mt-3 animate-fade-in rounded-lg border border-ink-200 bg-ink-50/40 p-3">
            <div className="grid gap-3 text-[13.5px] leading-relaxed md:grid-cols-2">
              <div><div className="mb-1 text-xs font-medium text-mist-400">原文</div><p className="whitespace-pre-wrap text-mist-500 line-through decoration-mist-300">{proposal.original}</p></div>
              <div><div className="mb-1 text-xs font-medium text-ink-600">建议</div><p className="whitespace-pre-wrap text-mist-800">{proposal.text}</p></div>
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setProposal(null)}>放弃</Button>
              <Button size="sm" variant="primary" onClick={accept} icon={<Check className="size-3.5" />}>替换</Button>
            </div>
          </div>
        )}
        {!streaming && <RefsNote refs={refs} className="mt-2" />}
      </div>
      {!readOnly && (
        <div className="flex flex-wrap items-center gap-1 border-t border-mist-100 px-3 py-2">
          {busy ? (
            <Button size="sm" variant="ghost" icon={<Square className="size-3.5" />} onClick={() => abort.current?.abort()}>停止生成</Button>
          ) : (
            <>
              <Button size="sm" variant={isEmpty ? 'primary' : 'ghost'} icon={<Sparkles className="size-3.5" />} onClick={draft}
                disabled={!work.outline_confirmed_at}>{isEmpty ? '起草本段' : '重新起草'}</Button>
              <Button size="sm" variant="ghost" icon={<Repeat2 className="size-3.5" />} disabled={isEmpty} onClick={() => edit('rewrite')}>{selection ? '改写选中' : '改写'}</Button>
              <Button size="sm" variant="ghost" icon={<Wand2 className="size-3.5" />} disabled={isEmpty} onClick={() => edit('expand')}>扩写</Button>
              <Button size="sm" variant="ghost" icon={<Minimize2 className="size-3.5" />} disabled={isEmpty} onClick={() => edit('shorten')}>缩写</Button>
              <Button size="sm" variant="ghost" icon={<ImagePlus className="size-3.5" />} loading={imgBusy} disabled={isEmpty} onClick={async () => {
                setImgBusy(true)
                try {
                  const r = await post<{ suggestions: { description: string; prompt: string }[] }>(`/sections/${section.id}/image-suggest`)
                  setImgSuggest(r.suggestions)
                } catch (e) { toast.error(errorMessage(e)) }
                finally { setImgBusy(false) }
              }}>配图建议</Button>
              {!xhs && <Button size="sm" variant="ghost" icon={<ImagePlus className="size-3.5" />} onClick={pickImage}>插入图片</Button>}
            </>
          )}
          <div className="ml-auto flex items-center gap-2 pr-2 text-xs text-mist-400">
            {pendingCount > 0 && <span className="pending-mark font-medium">{pendingCount} 处待核实</span>}
            <span>{runeLen(content.current)} 字</span>
          </div>
        </div>
      )}
      <input ref={fileInput} type="file" accept="image/*" hidden onChange={async (e) => {
        const f = e.target.files?.[0]
        e.target.value = ''
        if (!f) return
        const a = await onUploadImage(f)
        if (a) editor.current?.insertImage(a.url)
      }} />
      <Dialog open={!!conflict} onClose={() => setConflict(null)} title="这一段已在其他地方修改过" desc="可能是另一个标签页或设备。请选择保留哪个版本。" width="max-w-2xl"
        footer={<><Button onClick={() => resolveConflict(false)}>使用另一处的版本</Button><Button variant="primary" onClick={() => resolveConflict(true)}>保留我现在的版本</Button></>}>
        <div className="grid gap-4 md:grid-cols-2">
          <div><div className="mb-1.5 text-xs font-medium text-mist-500">另一处保存的（{conflict && fmtTime(conflict.updated_at)}）</div><div className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg bg-mist-50 p-3 text-[13px]">{conflict?.content_md}</div></div>
          <div><div className="mb-1.5 text-xs font-medium text-ink-600">我现在的</div><div className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg bg-ink-50/60 p-3 text-[13px]">{content.current}</div></div>
        </div>
      </Dialog>
      {toMaterial !== null && <SaveToMaterial text={toMaterial} work={work} onClose={() => setToMaterial(null)} />}
      <Dialog open={!!imgSuggest} onClose={() => setImgSuggest(null)} title="配图建议" desc="可复制到外部工具，或直接用本系统文生图（出图带 AI 标识）。" width="max-w-lg"
        footer={<Button variant="primary" onClick={() => setImgSuggest(null)}>关闭</Button>}>
        <div className="space-y-3">
          {(imgSuggest ?? []).map((s, i) => (
            <div key={i} className="rounded-lg border border-mist-200 p-3">
              <div className="text-[13.5px] font-medium text-mist-800">{s.description}</div>
              <p className="mt-1.5 text-[13px] leading-relaxed text-mist-600">{s.prompt}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" variant="ghost" onClick={async () => { await copyText(s.prompt); toast.success('提示词已复制') }}>复制提示词</Button>
                <Button size="sm" variant="secondary" loading={imgBusy} onClick={async () => {
                  setImgBusy(true)
                  try {
                    const a = await post<Asset>(`/works/${work.id}/generate-image`, { prompt: s.prompt })
                    editor.current?.insertImage(a.url)
                    toast.success('已出图并插入（含 AI 标识）')
                    await refresh()
                  } catch (e) { toast.error(errorMessage(e)) }
                  finally { setImgBusy(false) }
                }}>用此出图</Button>
              </div>
            </div>
          ))}
        </div>
      </Dialog>
    </div>
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
      if ((e as Error).name !== 'AbortError') toast.error(errorMessage(e))
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
  const [titles, setTitles] = useState<{ text: string; style: string }[]>([])
  const [titleRefs, setTitleRefs] = useState<AIRefs | null>(null)
  const [busy, setBusy] = useState<'t' | 's' | null>(null)
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
      const r = await post<{ titles: { text: string; style: string }[]; refs: AIRefs }>(`/works/${work.id}/titles`)
      setTitles(r.titles)
      setTitleRefs(r.refs)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }
  const genSummary = async () => {
    setBusy('s')
    try {
      const r = await post<{ summary: string; truncated: boolean }>(`/works/${work.id}/summary`)
      setSummary(r.summary)
      if (r.truncated) toast.info('AI 写的摘要超过 120 字，已截断，请检查结尾')
      await save({ summary: r.summary })
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }
  const pickTitle = (t: string) => {
    setTitle(t)
    save({ title: t })
  }
  return (
    <Card id="step-title" className="scroll-mt-24 p-5">
      <h2 className="mb-4 font-display text-[17px] font-bold text-mist-900">标题{wx ? '与摘要' : '与话题'}</h2>
      <div className="space-y-4">
        <Field label="标题" counter={{ value: runeLen(title), max: titleMax }} hint={wx ? '公众号标题不超过 32 字' : '小红书标题字数上限待核实（V-012），暂按 20 字提示'}>
          <div className="flex gap-2">
            <Input value={title} disabled={readOnly} onChange={(e) => setTitle(e.target.value)} invalid={wx && runeLen(title) > 32}
              onBlur={() => title !== work.title && !(wx && runeLen(title) > 32) && save({ title })} className="font-display text-[15px] font-semibold" />
            {!readOnly && <Button icon={<Sparkles className="size-4" />} loading={busy === 't'} onClick={genTitles}>候选</Button>}
          </div>
        </Field>
        {titles.length > 0 && (
          <div className="grid gap-2 sm:grid-cols-2">
            {titles.map((t, i) => (
              <button key={i} onClick={() => pickTitle(t.text)}
                className={cn('cursor-pointer rounded-lg border px-3 py-2 text-left transition hover:border-ink-300 hover:bg-ink-50/40', title === t.text ? 'border-ink-400 bg-ink-50' : 'border-mist-200')}>
                <div className="text-[13.5px] font-medium text-mist-800">{t.text}</div>
                <div className="mt-0.5 flex items-center gap-2 text-xs text-mist-400">{t.style}<span className={cn(wx && runeLen(t.text) > 32 && 'text-danger')}>{runeLen(t.text)} 字</span></div>
              </button>
            ))}
            <RefsNote refs={titleRefs} className="sm:col-span-2" />
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
  const setCover = (a: Asset) => setCropFor(a)
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
        {!readOnly && <Button size="sm" className="ml-auto" icon={<ImagePlus className="size-3.5" />} loading={uploading > 0} onClick={() => input.current?.click()}>上传图片</Button>}
      </div>
      {!readOnly && (
        <div className="mb-4 flex flex-wrap gap-2">
          <Input className="h-9 min-w-[220px] flex-1" value={aiPrompt} onChange={(e) => setAiPrompt(e.target.value)} placeholder="AI 出图提示词（生成图带「AI 生成」标识）" />
          <Button size="sm" variant="secondary" icon={<Sparkles className="size-3.5" />} loading={aiBusy} disabled={!aiPrompt.trim()} onClick={async () => {
            setAiBusy(true)
            try {
              const a = await post<Asset>(`/works/${work.id}/generate-image`, { prompt: aiPrompt.trim() })
              setWork({ ...work, assets: [...work.assets, a] })
              setAiPrompt('')
              toast.success('已出图（含 AI 标识）')
            } catch (e) { toast.error(errorMessage(e)) }
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
              {!readOnly && <Button size="sm" variant="ghost" className="ml-auto" icon={<Crop className="size-3.5" />} onClick={() => setCropFor(cover)}>调整裁剪</Button>}
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
                    {wx && <button onClick={() => setCover(a)} className="cursor-pointer rounded px-1.5 py-1 text-[11px] text-white hover:bg-white/20">设为封面</button>}
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
          initial={cropFor.id === work.cover_asset_id && work.cover_crops ? work.cover_crops : defaultCrops(cropFor.width, cropFor.height)} onSave={saveCrop} />
      )}
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

// ---------- 页面 ----------

export default function Editor() {
  const { work } = useWork()
  if (work.content_format === 'comic') return <ComicEditor />
  return <ArticleEditor />
}

function ArticleEditor() {
  const { work, setWork, patchWork, refresh } = useWork()
  const nav = useNavigate()
  const canWrite = useCanWrite()
  const readOnly = work.locked || !canWrite
  const [save, setSave] = useState<SaveState>({ pending: 0, offline: false, last: null })
  const onSave = useCallback((d: number, offline = false) => {
    setSave((s) => ({ pending: Math.max(0, s.pending + d), offline, last: d < 0 && !offline ? new Date().toISOString() : s.last }))
  }, [])
  const setWorkStable = setWork
  useEffect(() => {
    if (!location.hash) return
    const t = window.setTimeout(() => document.getElementById(location.hash.slice(1))?.scrollIntoView({ behavior: 'smooth' }), 300)
    return () => window.clearTimeout(t)
  }, [])

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
    const ids = work.sections.map((s) => s.id)
    const j = i + d
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
    setWork(await put<Work>(`/works/${work.id}/sections/order`, { ids }))
  }
  const removeSection = async (s: Section) => {
    if (!(await confirm({ title: '删除这一段？', desc: '删除前的内容会保存在版本历史中。', confirmText: '删除', danger: true }))) return
    setWork(await del<Work>(`/sections/${s.id}`))
  }
  const drafted = work.sections.filter((s) => s.content_md.trim()).length
  const steps = [
    { id: 'step-viewpoint', label: '核心观点', done: !!work.viewpoint.trim() },
    { id: 'step-outline', label: '大纲', done: !!work.outline_confirmed_at },
    { id: 'step-sections', label: '分段起稿', done: work.sections.length > 0 && drafted === work.sections.length, extra: work.sections.length ? `${drafted}/${work.sections.length}` : '' },
    { id: 'step-title', label: work.platform === 'wechat_mp' ? '标题与摘要' : '标题与话题', done: !!work.title.trim() },
    { id: 'step-images', label: work.platform === 'wechat_mp' ? '配图与封面' : '笔记图片', done: work.platform === 'wechat_mp' ? !!work.cover_asset_id : work.assets.length > 0 },
  ]
  const toCheck = () => nav(work.platform === 'wechat_mp' ? `/works/${work.id}/preview?next=check` : `/works/${work.id}/check?start=1`)

  return (
    <div className="mx-auto flex w-full max-w-[1280px] gap-8 px-6 py-8 2xl:max-w-[1480px]">
      <aside className="sticky top-24 hidden h-fit w-52 shrink-0 lg:block">
        <div className="mb-3 text-[11px] font-semibold tracking-wider text-mist-400">创作步骤</div>
        <ol className="space-y-0.5">
          {steps.map((s) => (
            <li key={s.id}>
              <a href={`#${s.id}`} onClick={(e) => { e.preventDefault(); document.getElementById(s.id)?.scrollIntoView({ behavior: 'smooth' }) }}
                className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13.5px] text-mist-600 hover:bg-mist-100 hover:text-mist-900">
                {s.done ? <CheckCircle2 className="size-4 text-ink-500" /> : <Circle className="size-4 text-mist-300" />}
                <span className="flex-1">{s.label}</span>
                {s.extra && <span className="font-mono text-xs text-mist-400">{s.extra}</span>}
              </a>
            </li>
          ))}
        </ol>
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

      <div className="min-w-0 flex-1 space-y-5">
        <OrganizeNotesCard work={work} setWork={setWorkStable} readOnly={readOnly} />
        <ViewpointCard work={work} setWork={setWorkStable} readOnly={readOnly} />
        <OutlineCard work={work} setWork={setWorkStable} readOnly={readOnly} />
        <section id="step-sections" className="scroll-mt-24 space-y-4">
          <div className="flex items-center gap-2 pt-2">
            <h2 className="font-display text-[17px] font-bold text-mist-900">正文</h2>
            <span className="text-xs text-mist-400">每一段单独起草，没有「全部起草」</span>
          </div>
          {!work.outline_confirmed_at ? (
            <HumanGate code="H-03">确认大纲后，这里会按大纲生成段落块，然后你可以逐段起草和修改。</HumanGate>
          ) : (
            <>
              {work.sections.map((s, i) => (
                <SectionBlock key={s.id} section={s} index={i} total={work.sections.length} work={work} patchWork={patchWork} refresh={refresh} readOnly={readOnly}
                  onSave={onSave} onMove={(d) => moveSection(i, d)} onRemove={() => removeSection(s)} onUploadImage={upload} />
              ))}
              {!readOnly && (
                <button onClick={addSection} className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl border-2 border-dashed border-mist-200 py-3 text-[13px] text-mist-500 transition hover:border-ink-300 hover:text-ink-600">
                  <Plus className="size-4" />新增段落
                </button>
              )}
            </>
          )}
        </section>
        <TitleCard work={work} setWork={setWorkStable} readOnly={readOnly} />
        <ImagesCard work={work} setWork={setWorkStable} readOnly={readOnly} upload={upload} />
        {!readOnly && (
          <div className="flex justify-end pb-10 lg:hidden">
            <Button variant="primary" onClick={toCheck} disabled={drafted === 0}>{work.platform === 'wechat_mp' ? '排版并检查' : '提交检查'}</Button>
          </div>
        )}
        {work.locked && <Notice tone="gray">作品已发布，当前为只读模式。</Notice>}
      </div>
    </div>
  )
}
