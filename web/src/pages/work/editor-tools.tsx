import { useQuery } from '@tanstack/react-query'
import { Check, History, Library, Plus, RotateCcw, Search, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Dialog } from '@/components/dialog'
import { Badge, Button, cn, Spinner, Textarea } from '@/components/ui'
import { aiError } from '@/lib/ai-error'
import { ApiError, errorMessage, get, post, put } from '@/lib/api'
import { fmtTime } from '@/lib/format'
import type { LintHit, Material, MaterialPreview, RetrieveHit, Section, SectionRevision, Variant, Work } from '@/lib/types'
import { SectionConflictDialog } from './section-save-dialogs'

// ---------- 编辑器内部事件（侧栏 ↔ 段落） ----------

export type EditorEvent =
  | { type: 'apply'; sectionId: string; text: string; target: 'section' | 'selection' | 'end'; original?: string; callId?: string | null }
  | { type: 'fix-sentence'; sectionId: string; sentence: string }
  | { type: 'insert'; sectionId: string; text: string }
  | { type: 'open-pending'; sectionId: string; index: number }
  | { type: 'sidebar'; tab: SidebarTab }
  | { type: 'comment'; sectionId: string | null; anchor: string }
  | { type: 'focus'; sectionId: string }
  | { type: 'focus-draft'; sectionId: string }
  /** Every mounted section pushes its pending save into wait. */
  | { type: 'flush'; wait: Promise<unknown>[] }

export type SidebarTab = 'materials' | 'copilot' | 'polish' | 'readthrough' | 'pending' | 'comments' | 'activity'

export function emitEditor(e: EditorEvent) {
  window.dispatchEvent(new CustomEvent<EditorEvent>('ops:editor', { detail: e }))
}

export function useEditorEvents(handler: (e: EditorEvent) => void) {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => {
    const h = (e: Event) => ref.current((e as CustomEvent<EditorEvent>).detail)
    window.addEventListener('ops:editor', h)
    return () => window.removeEventListener('ops:editor', h)
  }, [])
}

export function scrollToSection(id: string) {
  const el = document.getElementById(`sec-${id}`)
  if (!el) return
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  el.classList.remove('flash')
  void el.offsetWidth
  el.classList.add('flash')
}

// ---------- 待核实占位（EX-E-04） ----------

export const pendingRe = /【待核实[：:]?([^】]*)】/g

export interface PendingMark { marker: string; need: string; index: number }

export function findPending(text: string): PendingMark[] {
  return [...text.matchAll(pendingRe)].map((m, index) => ({ marker: m[0], need: m[1].trim(), index }))
}

/** replaceNth replaces the n-th occurrence of needle in text. */
export function replaceNth(text: string, needle: string, n: number, replacement: string): string {
  let at = -1
  for (let i = 0; i <= n; i++) {
    at = text.indexOf(needle, at + 1)
    if (at < 0) return text
  }
  return text.slice(0, at) + replacement + text.slice(at + needle.length)
}

/** removeSentenceAt deletes the sentence containing the n-th occurrence of needle. */
export function removeSentenceAt(text: string, needle: string, n: number): string {
  let at = -1
  for (let i = 0; i <= n; i++) {
    at = text.indexOf(needle, at + 1)
    if (at < 0) return text
  }
  const stops = '。！？!?\n'
  let start = at
  while (start > 0 && !stops.includes(text[start - 1])) start--
  let end = at + needle.length
  while (end < text.length && !stops.includes(text[end])) end++
  if (end < text.length && text[end] !== '\n') end++
  return (text.slice(0, start) + text.slice(end)).replace(/\n{3,}/g, '\n\n')
}

export function PendingDialog({ work, section, mark, onClose, onReplace, onDelete }: {
  work: Work
  section: Section
  mark: PendingMark
  onClose: () => void
  onReplace: (text: string, materialId?: string) => void
  onDelete: () => void
}) {
  const [text, setText] = useState('')
  const [save, setSave] = useState(false)
  const [busy, setBusy] = useState(false)
  const query = mark.need || `${section.heading} ${section.key_point}`
  const hits = useQuery({
    queryKey: ['retrieve', work.account_id, 'pending', query],
    queryFn: () => post<{ items: RetrieveHit[] }>(`/accounts/${work.account_id}/retrieve`, { query, types: ['material'], limit: 5 }),
  })
  const manual = async () => {
    if (!text.trim()) return
    setBusy(true)
    try {
      if (save) {
        const m = await post<Material>('/materials', { account_id: work.account_id, kind: 'data', content: text.trim(), source: `作品《${work.title || '未命名'}》` })
        onReplace(text.trim(), m.id)
        toast.success('已填写，并存入素材库')
      } else onReplace(text.trim())
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open onClose={onClose} title="处理待核实" desc={mark.need ? `AI 需要：${mark.need}` : 'AI 在这里缺少可靠的事实来源。'} width="max-w-lg"
      footer={<>
        <Button variant="ghost" className="mr-auto text-danger" icon={<Trash2 className="size-3.5" />} onClick={onDelete}>删掉这句</Button>
        <Button variant="ghost" onClick={onClose}>取消</Button>
        <Button variant="primary" loading={busy} disabled={!text.trim()} onClick={manual}>填入</Button>
      </>}>
      <div className="space-y-4">
        <div>
          <div className="mb-1.5 flex items-center gap-1.5 text-[12.5px] font-medium text-mist-600"><Search className="size-3.5" />素材库里可能相关的</div>
          {hits.isLoading ? <Spinner /> : (hits.data?.items ?? []).length === 0 ? (
            <p className="rounded-lg border border-dashed border-mist-200 px-3 py-3 text-[12.5px] text-mist-400">没有找到相关素材，可以在下面手动填写。</p>
          ) : (
            <div className="space-y-1.5">
              {hits.data!.items.map((h) => (
                <button key={h.id} type="button" onClick={() => onReplace(h.content ?? '', h.id)}
                  className="block w-full cursor-pointer rounded-lg border border-mist-200 p-2.5 text-left transition hover:border-ink-300 hover:bg-ink-50/40">
                  <p className="line-clamp-3 text-[13px] leading-relaxed text-mist-700">{h.content}</p>
                  <p className="mt-1 text-[11.5px] text-mist-400">{h.reason}{h.source ? ` · ${h.source}` : ''} · 点击替换并关联到本段</p>
                </button>
              ))}
            </div>
          )}
        </div>
        <div>
          <div className="mb-1.5 text-[12.5px] font-medium text-mist-600">手动填写</div>
          <Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="写下真实的数据、经历或出处" autoFocus />
          <label className="mt-2 flex items-center gap-2 text-[12.5px] text-mist-600">
            <input type="checkbox" className="accent-ink-600" checked={save} onChange={(e) => setSave(e.target.checked)} />同时存入素材库（来源记为本作品）
          </label>
        </div>
      </div>
    </Dialog>
  )
}

// ---------- 多候选（EX-E-03 / EX-E-08） ----------

export function VariantsCard({ title, original, variants, onPick, onClose, onMore, more }: {
  title: string
  original?: string
  variants: Variant[]
  onPick: (i: number) => void
  onClose: () => void
  onMore?: () => void
  more?: boolean
}) {
  const [tab, setTab] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => box.current?.focus({ preventScroll: true }), [variants])
  const onKey = (e: React.KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    const n = Number(e.key)
    if (n >= 1 && n <= variants.length) {
      e.preventDefault()
      onPick(n - 1)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }
  return (
    <div ref={box} tabIndex={-1} onKeyDown={onKey} className="mt-3 animate-fade-in rounded-lg border border-ink-200 bg-ink-50/40 p-3 outline-none focus:ring-2 focus:ring-ink-100">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-ink-700">
        {title}
        {variants.length > 1 && <span className="hidden font-normal text-mist-400 md:inline">按 1–{variants.length} 选择 · Esc 放弃</span>}
        <div className="ml-auto flex gap-1 md:hidden">
          {variants.map((v, i) => (
            <button key={i} type="button" onClick={() => setTab(i)} className={cn('cursor-pointer rounded px-2 py-0.5', tab === i ? 'bg-ink-600 text-white' : 'bg-white text-mist-600')}>{v.label || `候选 ${i + 1}`}</button>
          ))}
        </div>
      </div>
      {original && <p className="mb-2 line-clamp-2 text-[12.5px] text-mist-400 line-through decoration-mist-300">{original}</p>}
      <div className={cn('grid gap-2', variants.length > 1 && 'md:grid-cols-3')}>
        {variants.map((v, i) => (
          <div key={i} className={cn('flex flex-col rounded-lg border border-mist-200 bg-white p-2.5', i !== tab && 'hidden md:flex')}>
            <Badge tone="ink" className="mb-1.5 self-start">{v.label || `候选 ${i + 1}`}</Badge>
            <p className="flex-1 whitespace-pre-wrap text-[13.5px] leading-relaxed text-mist-800">{v.text}</p>
            {v.note && <p className="mt-1 text-[11.5px] text-mist-400">{v.note}</p>}
            <Button size="sm" variant="primary" className="mt-2 self-end" icon={<Check className="size-3.5" />} onClick={() => onPick(i)}>用这个</Button>
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-end gap-2">
        {onMore && <Button size="sm" variant="ghost" loading={more} onClick={onMore}>再来 3 个</Button>}
        <Button size="sm" variant="ghost" onClick={onClose}>放弃</Button>
      </div>
    </div>
  )
}

// ---------- 段落历史（EX-E-12） ----------

const revOrigin: Record<string, string> = { ai: 'AI 生成', human: '人工编辑', mixed: 'AI + 人工修改', rewrite: '改写替换' }

export function RevisionsDialog({ section, workId, onClose, onRestored }: { section: Section; workId: string; onClose: () => void; onRestored: (w: Work) => void }) {
  const q = useQuery({ queryKey: ['section-revisions', section.id], queryFn: () => get<SectionRevision[]>(`/sections/${section.id}/revisions`) })
  const [pick, setPick] = useState<SectionRevision | null>(null)
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState<Section | null>(null)
  useEffect(() => {
    if (!pick && q.data?.length) setPick(q.data[0])
  }, [q.data, pick])
  const restore = async (base = section.revision) => {
    if (!pick) return
    setBusy(true)
    try {
      onRestored(await post<Work>(`/sections/${section.id}/revisions/${pick.id}/restore`, { base_revision: base }))
      toast.success('已回退这一段，其他段落不受影响')
      onClose()
    } catch (e) {
      if (e instanceof ApiError && e.code === 'version_conflict') setConflict((e.detail as { server: Section }).server)
      else toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open onClose={onClose} title={`段落历史 · ${section.heading || section.key_point || '本段'}`} desc="最近 10 次变化。回退只影响这一段，整篇版本历史仍然保留。" width="max-w-3xl"
      footer={<><Button variant="ghost" onClick={onClose}>关闭</Button><Button variant="primary" loading={busy} disabled={!pick} icon={<RotateCcw className="size-3.5" />} onClick={() => restore()}>回退到这个版本</Button></>}>
      {q.isLoading ? <Spinner /> : (q.data ?? []).length === 0 ? <p className="py-8 text-center text-sm text-mist-400">这一段还没有历史记录。</p> : (
        <div className="grid gap-3 md:grid-cols-[200px_1fr]">
          <ul className="scrollbar-thin max-h-[50vh] space-y-1 overflow-y-auto">
            {q.data!.map((r) => (
              <li key={r.id}>
                <button type="button" onClick={() => setPick(r)}
                  className={cn('w-full cursor-pointer rounded-md px-2.5 py-2 text-left text-[12.5px] transition', pick?.id === r.id ? 'bg-ink-50 text-ink-800' : 'text-mist-600 hover:bg-mist-100')}>
                  <div className="flex items-center gap-1.5"><History className="size-3" />{fmtTime(r.created_at)}</div>
                  <div className="mt-0.5 text-[11.5px] text-mist-400">{revOrigin[r.origin] ?? r.origin}{r.created_by ? ` · ${r.created_by}` : ''}</div>
                </button>
              </li>
            ))}
          </ul>
          <div className="scrollbar-thin max-h-[50vh] overflow-y-auto whitespace-pre-wrap rounded-lg bg-mist-50 p-3 text-[13.5px] leading-relaxed text-mist-700">{pick?.content_md || '（空）'}</div>
        </div>
      )}
      <SectionConflictDialog server={conflict} heading={section.heading} content={pick?.content_md ?? ''} onClose={() => setConflict(null)} onResolve={async keepMine => {
        if (!conflict) return
        if (keepMine) await restore(conflict.revision)
        else { onRestored(await get<Work>(`/works/${workId}`)); onClose() }
      }} />
    </Dialog>
  )
}

// ---------- 段落级素材绑定（EX-E-05） ----------

export function SectionMaterials({ work, section, readOnly, onWork }: { work: Work; section: Section; readOnly: boolean; onWork: (w: Work) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const ids = section.material_ids ?? []
  const materials = useQuery({
    queryKey: ['materials', work.account_id, ''],
    queryFn: () => get<MaterialPreview[]>(`/materials?account_id=${work.account_id}`),
    enabled: open,
  })
  const query = `${section.heading} ${section.key_point} ${section.content_md.slice(0, 300)}`.trim()
  const rec = useQuery({
    queryKey: ['retrieve', work.account_id, 'section', section.id, query, ids.join(',')],
    queryFn: () => post<{ items: RetrieveHit[] }>(`/accounts/${work.account_id}/retrieve`, { query, types: ['material'], limit: 5, exclude_ids: ids }),
    enabled: open && !!query,
  })
  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])
  const setIds = async (next: string[]) => {
    try {
      onWork(await put<Work>(`/sections/${section.id}/materials`, { material_ids: next }))
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const bound = (materials.data ?? []).filter((m) => ids.includes(m.id))
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)} title="本段素材：起草时只使用本段绑定的素材，没有绑定时使用整篇素材"
        className={cn('inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] transition', ids.length ? 'bg-ink-50 text-ink-700' : 'text-mist-400 hover:bg-mist-100')}>
        <Library className="size-3" />{ids.length ? `素材 ${ids.length}` : '素材'}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-80 animate-fade-in rounded-xl border border-mist-200 bg-white p-3 shadow-pop">
          <div className="mb-1.5 text-[12px] font-medium text-mist-600">本段已绑定</div>
          {ids.length === 0 ? <p className="mb-2 text-[12px] text-mist-400">未绑定，起草时使用整篇的参考素材。</p> : (
            <ul className="mb-2 space-y-1">
              {(bound.length ? bound : ids.map((id) => ({ id, content: '…' }) as Material)).map((m) => (
                <li key={m.id} className="flex items-start gap-1.5 rounded-md bg-mist-50 px-2 py-1.5 text-[12px] text-mist-700">
                  <span className="line-clamp-2 flex-1">{m.content}</span>
                  {!readOnly && <button type="button" className="cursor-pointer text-mist-400 hover:text-danger" onClick={() => setIds(ids.filter((x) => x !== m.id))}><X className="size-3.5" /></button>}
                </li>
              ))}
            </ul>
          )}
          {!readOnly && (
            <>
              <div className="mb-1.5 mt-3 text-[12px] font-medium text-mist-600">推荐</div>
              {rec.isLoading ? <Spinner /> : (rec.data?.items ?? []).length === 0 ? <p className="text-[12px] text-mist-400">暂无相关素材。</p> : (
                <ul className="space-y-1">
                  {rec.data!.items.map((h) => (
                    <li key={h.id} className="flex items-start gap-1.5 rounded-md border border-mist-100 px-2 py-1.5 text-[12px] text-mist-700">
                      <div className="min-w-0 flex-1">
                        <p className="line-clamp-2">{h.content}</p>
                        <p className="text-[11px] text-mist-400">{h.reason}</p>
                      </div>
                      <button type="button" title="用于本段" className="cursor-pointer rounded p-0.5 text-ink-600 hover:bg-ink-50" onClick={() => setIds([...ids, h.id])}><Plus className="size-3.5" /></button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ---------- 话题标签推荐（EX-F-02） ----------

interface TagSug { text: string; reason: string; source: 'history' | 'ai' }

/** TagSuggest lists the account's past topics and AI suggestions; each click adds one tag. No站内热度 data is used. */
export function TagSuggest({ workId, current, onAdd, disabled }: { workId: string; current: string[]; onAdd: (tag: string) => void; disabled?: boolean }) {
  const [data, setData] = useState<{ history: TagSug[]; ai: TagSug[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const load = async () => {
    setBusy(true)
    try {
      setData(await post<{ history: TagSug[]; ai: TagSug[] }>(`/works/${workId}/tag-suggest`))
    } catch (e) {
      aiError(e, '话题建议', load)
    } finally {
      setBusy(false)
    }
  }
  const has = (t: string) => current.includes(t.replace(/^#/, ''))
  if (!data) {
    return <Button size="sm" variant="ghost" loading={busy} disabled={disabled} onClick={load}>推荐话题</Button>
  }
  const chip = (t: TagSug) => (
    <button key={t.source + t.text} type="button" disabled={disabled || has(t.text)} title={t.reason} onClick={() => onAdd(t.text.replace(/^#/, ''))}
      className={cn('cursor-pointer rounded-full border px-2 py-0.5 text-[12px] transition disabled:cursor-default disabled:opacity-40',
        t.source === 'history' ? 'border-gamboge-200 bg-gamboge-50 text-gamboge-800 hover:border-gamboge-400' : 'border-mist-200 text-mist-600 hover:border-ink-300 hover:text-ink-700')}>
      {t.text.startsWith('#') ? t.text : `#${t.text}`}
    </button>
  )
  return (
    <div className="space-y-1.5 text-[11.5px] text-mist-500">
      {data.history.length > 0 && <div className="flex flex-wrap items-center gap-1">本账号用过：{data.history.map(chip)}</div>}
      {data.ai.length > 0 && <div className="flex flex-wrap items-center gap-1">根据正文：{data.ai.map(chip)}</div>}
      {!data.history.length && !data.ai.length && <span>暂时没有推荐。</span>}
    </div>
  )
}

// ---------- 实时轻量检查（EX-E-09） ----------

/** useLint asks the server for word hits after the text has been stable for 1.5 s; never blocks typing. */
export function useLint(workId: string, text: string, enabled: boolean): LintHit[] {
  const [hits, setHits] = useState<LintHit[]>([])
  useEffect(() => {
    if (!enabled || !text.trim()) {
      setHits([])
      return
    }
    let alive = true
    const t = window.setTimeout(() => {
      post<{ hits: LintHit[] }>(`/works/${workId}/lint`, { text }).then((r) => alive && setHits(r.hits)).catch(() => undefined)
    }, 300)
    return () => {
      alive = false
      window.clearTimeout(t)
    }
  }, [workId, text, enabled])
  return hits
}

export const lintCategoryLabel: Record<string, string> = { sensitive: '敏感词', ad_law: '极限词', memory: '账号偏好', pending: '待核实' }

// CSS Custom Highlight API: underline words without touching the editor DOM. Unsupported browsers just skip it.
const registry = new Map<string, Map<string, Range[]>>()

/** highlightAt returns the highlighted text under a screen point, so CSS highlights can react to hover and click. */
export function highlightAt(name: string, key: string, x: number, y: number): string | null {
  for (const r of registry.get(name)?.get(key) ?? []) {
    for (const rect of r.getClientRects()) {
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return r.toString()
    }
  }
  return null
}

export function setHighlights(name: string, key: string, root: HTMLElement | null, words: string[]) {
  const css = CSS as unknown as { highlights?: Map<string, unknown> }
  const HL = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight
  if (!css.highlights || !HL) return
  const m = registry.get(name) ?? new Map<string, Range[]>()
  registry.set(name, m)
  const ranges: Range[] = []
  const uniq = [...new Set(words.filter(Boolean))]
  if (root && uniq.length) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const s = n.textContent ?? ''
      for (const w of uniq) {
        for (let i = s.indexOf(w); i >= 0 && ranges.length < 300; i = s.indexOf(w, i + w.length)) {
          const r = document.createRange()
          r.setStart(n, i)
          r.setEnd(n, i + w.length)
          ranges.push(r)
        }
      }
    }
  }
  if (ranges.length) m.set(key, ranges)
  else m.delete(key)
  const all = [...m.values()].flat()
  if (all.length) css.highlights.set(name, new HL(...all))
  else css.highlights.delete(name)
}
