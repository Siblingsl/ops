import {
  ArrowDown, ArrowUp, BookmarkPlus, Check, History, ImagePlus, Loader2, MessageSquare, Minimize2, Mic, Quote, Repeat2, Sparkles, Square, Trash2, Wand2,
} from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { confirm, Dialog } from '@/components/dialog'
import { RefsNote, sendFeedback } from '@/components/refs'
import { type EditorHandle, PlainEditor, RichEditor } from '@/components/section-editor'
import { Badge, Button, cn, IconButton, MoreMenu, Notice } from '@/components/ui'
import { VoiceButton, voiceSupported } from '@/components/voice'
import { aiError } from '@/lib/ai-error'
import { ApiError, errorMessage, get, post, put, stream } from '@/lib/api'
import { type AIRefs, copyText, runeLen } from '@/lib/format'
import { writeDraft } from '@/lib/local-draft'
import { isEnterWithoutComposition } from '@/lib/keyboard'
import type { Asset, LintHit, Section, UserPrefs, Variant, Work } from '@/lib/types'
import { matchGhostKey, waitJob } from '@/lib/v3'
import {
  emitEditor, findPending, highlightAt, lintCategoryLabel, PendingDialog, type PendingMark, removeSentenceAt, replaceNth, RevisionsDialog, SectionMaterials, setHighlights,
  useEditorEvents, useLint, VariantsCard,
} from './editor-tools'
import { AIConflictPanel, type AIConflict, SaveToMaterial, SectionConflictDialog } from './section-save-dialogs'
import { useSectionSave } from './use-section-save'
import { useSectionUndo } from './use-section-undo'

const originMeta = { ai: { label: 'AI 生成', tone: 'ink' as const }, human: { label: '手写', tone: 'gray' as const }, mixed: { label: 'AI + 人工修改', tone: 'blue' as const } }

const toneChips = ['更口语', '更严谨', '少用比喻', '加过渡句'] as const

/** How an accepted suggestion is written back: whole section, current selection, one exact sentence, or added at the start / end. */
type ApplyMode = 'whole' | 'selection' | 'excerpt' | 'prepend' | 'append'

interface Proposal { original: string; text: string; mode: ApplyMode; callId?: string | null; range?: { from: number; to: number } | null }
type Stage = 'context' | 'generating'
interface VariantState {
  title: string
  original?: string
  list: Variant[]
  callId: string | null
  mode: ApplyMode | 'copy'
  rerun?: () => Promise<void>
}

/** edgeText picks the opening / closing paragraph that a hook candidate replaces; long paragraphs give up only their first / last sentence. */
function edgeText(md: string, at: 'first' | 'last'): string {
  const paras = md.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  const p = at === 'first' ? paras[0] : paras[paras.length - 1]
  if (!p || p.startsWith('#') || p.startsWith('![')) return ''
  if (runeLen(p) <= 120) return p
  const sents = p.match(/[^。！？!?]+[。！？!?]*/g)?.map((s) => s.trim()).filter(Boolean) ?? []
  return (at === 'first' ? sents[0] : sents[sents.length - 1]) ?? ''
}

export interface SectionBlockProps {
  section: Section
  index: number
  total: number
  work: Pick<Work, 'id' | 'platform' | 'outline_confirmed_at' | 'account_id' | 'title'>
  prefs: UserPrefs
  patchWork: (p: Partial<Work> | ((w: Work) => Partial<Work>)) => void
  setWork: (w: Work) => void
  refresh: () => Promise<unknown>
  readOnly: boolean
  dim?: boolean
  othersHere?: string[]
  /** members typing in this section in the last 15 seconds (EX-L-04 软锁) */
  othersEditing?: string[]
  onEditing?: (sectionId: string) => void
  onSave: (d: number, offline?: boolean) => void
  onMove: (id: string, d: number) => void
  onRemove: (id: string) => void
  onUploadImage: (f: File) => Promise<Asset | null>
  onDrafted?: (sectionId: string) => void
  onActive?: (sectionId: string, selection: string) => void
  onLint?: (sectionId: string, n: number) => void
  /** id of a drafting job for this section that was started before the page loaded */
  resumeJob?: string
  desktopPresentation?: boolean
  active?: boolean
}

export const SectionBlock = memo(function SectionBlock({
  section, index, total, work, prefs, patchWork, setWork, refresh, readOnly, dim, othersHere, othersEditing, onEditing, onSave, onMove, onRemove, onUploadImage, onDrafted,
  onActive, onLint, resumeJob, desktopPresentation = false, active = false,
}: SectionBlockProps) {
  const warnedConflict = useRef(false)
  const xhs = work.platform === 'xhs'
  const editor = useRef<EditorHandle>(null)
  const draftButton = useRef<HTMLButtonElement>(null)
  const { heading, setHeading, headingRef, resetKey, content, revision, origin, dirty, applied, conflict, setConflict, persist, schedule, flush, resolveConflict, load } = useSectionSave({
    section, index, patchWork, onSave, onLoaded: text => { setIsEmpty(!text.trim()); setLintText(text) },
  })
  const [aiConflict, setAIConflict] = useState<AIConflict | null>(null)
  const [streaming, setStreaming] = useState<{ kind: 'draft' | 'edit'; text: string; stage?: Stage; resumed?: boolean } | null>(null)
  const jobId = useRef<string | null>(null)
  const [proposal, setProposal] = useState<Proposal | null>(null)
  const [variants, setVariants] = useState<VariantState | null>(null)
  const [moreBusy, setMoreBusy] = useState(false)
  const [refs, setRefs] = useState<AIRefs | null>(null)
  const [callId, setCallId] = useState<string | null>(null)
  const lastRun = useRef<(() => void) | null>(null)
  const [selection, setSelection] = useState('')
  const [toMaterial, setToMaterial] = useState<string | null>(null)
  const [imgSuggest, setImgSuggest] = useState<{ description: string; prompt: string }[] | null>(null)
  const [imgBusy, setImgBusy] = useState(false)
  const [hookBusy, setHookBusy] = useState<string | null>(null)
  const [isEmpty, setIsEmpty] = useState(!section.content_md.trim())
  const [instruction, setInstruction] = useState('')
  const [chipsOpen, setChipsOpen] = useState(false)
  const [tier, setTier] = useState<'' | 'economy' | 'standard' | 'quality'>('')
  const [ghost, setGhost] = useState<{ text: string; loading: boolean; callId?: string | null } | null>(null)
  const [revOpen, setRevOpen] = useState(false)
  const [pendingOpen, setPendingOpen] = useState<PendingMark | null>(null)
  const [lintText, setLintText] = useState(section.content_md)
  // DEV-A105：起草自检前置的修正记录（可还原）。
  const [selfCheck, setSelfCheck] = useState<{ fixes: { from: string; to: string; count: number }[]; original: string; sectionId: string } | null>(null)
  const [showHits, setShowHits] = useState(false)
  const abort = useRef<AbortController | null>(null)
  const ghostAbort = useRef<AbortController | null>(null)
  const lintTimer = useRef<number>()
  const fileInput = useRef<HTMLInputElement>(null)
  const { available: canUndoAI, clearUndo, restoreBefore, undoToast } = useSectionUndo({ index, editor, content, applied, setLintText, disabled: readOnly || !!streaming })
  const hits = useLint(work.id, lintText, prefs.live_lint && !readOnly)
  const pending = useMemo(() => findPending(lintText), [lintText])
  useEffect(() => () => window.clearTimeout(lintTimer.current), [])

  const onChange = (md: string) => {
    clearUndo()
    content.current = md
    dirty.current = true
    onEditing?.(section.id)
    if (othersEditing?.length && !warnedConflict.current) {
      warnedConflict.current = true
      toast.warning(`${othersEditing.join('、')} 正在编辑这一段`, { description: '你仍然可以修改，但同时保存可能产生冲突；冲突时会让你选择保留哪一版。' })
    }
    setIsEmpty(!md.trim())
    if (ghost) {
      ghostAbort.current?.abort()
      setGhost(null)
    }
    void writeDraft(section.id, { content: md, heading: headingRef.current, revision: revision.current, at: Date.now() })
    schedule()
    window.clearTimeout(lintTimer.current)
    lintTimer.current = window.setTimeout(() => setLintText(md), 1500)
  }
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onRichChange = useCallback((md: string) => onChangeRef.current(md), [])
  const selectionRef = useRef({ onActive, sectionId: section.id, setSelection })
  selectionRef.current = { onActive, sectionId: section.id, setSelection }
  const onRichSelection = useCallback((text: string) => {
    const current = selectionRef.current
    current.setSelection(text)
    current.onActive?.(current.sectionId, text)
  }, [])

  // 实时提示与待核实高亮（不改动编辑器内容）。
  useEffect(() => {
    const root = editor.current?.root() ?? null
    setHighlights('ops-lint', section.id, root, hits.filter((h) => h.category === 'sensitive' || h.category === 'ad_law').map((h) => h.word))
    setHighlights('ops-lint-memory', section.id, root, hits.filter((h) => h.category === 'memory').map((h) => h.word))
    setHighlights('ops-pending', section.id, root, pending.map((p) => p.marker))
  }, [hits, pending, resetKey, section.id])
  useEffect(() => () => {
    for (const n of ['ops-lint', 'ops-lint-memory', 'ops-pending']) setHighlights(n, section.id, null, [])
  }, [section.id])
  const wordHits = hits.filter((h) => h.category !== 'pending')
  const [hoverHit, setHoverHit] = useState<{ x: number; y: number; hit: LintHit } | null>(null)
  const onEditorHover = (e: React.MouseEvent<HTMLDivElement>) => {
    e.currentTarget.style.cursor = !readOnly && highlightAt('ops-pending', section.id, e.clientX, e.clientY) ? 'pointer' : ''
    if (wordHits.length === 0) return hoverHit && setHoverHit(null)
    const w = highlightAt('ops-lint', section.id, e.clientX, e.clientY) ?? highlightAt('ops-lint-memory', section.id, e.clientX, e.clientY)
    const hit = w ? wordHits.find((h) => h.word === w) : undefined
    setHoverHit(hit ? { x: e.clientX, y: e.clientY, hit } : null)
  }
  const onEditorClick = (e: React.MouseEvent) => {
    if (readOnly) return
    const marker = highlightAt('ops-pending', section.id, e.clientX, e.clientY)
    const p = marker ? findPending(content.current).find((x) => x.marker === marker) : undefined
    if (p) setPendingOpen(p)
  }
  useEffect(() => onLint?.(section.id, wordHits.length), [wordHits.length, section.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const onStreamEvent = (name: string, data: { id?: string; stage?: Stage }) => {
    if (name === 'job' && data.id) jobId.current = data.id
    if (name === 'stage' && data.stage) setStreaming((s) => (s ? { ...s, stage: data.stage } : s))
  }
  /** stop cancels the server-side job too; aborting the fetch alone would let the draft still be written. */
  const stop = () => {
    const id = jobId.current
    jobId.current = null
    if (id) post(`/ai-jobs/${id}/cancel`).catch(() => undefined)
    abort.current?.abort()
  }

  const draft = async () => {
    if (readOnly || streaming || !work.outline_confirmed_at) return
    const prev = content.current
    if (prev.trim() && !(await confirm({ title: '重新起草这一段？', desc: '当前内容会被替换，替换前的内容保存在段落历史中，也可以马上撤销。', confirmText: '重新起草' }))) return
    if (!(await flush())) return
    lastRun.current = () => void draft()
    abort.current = new AbortController()
    jobId.current = null
    setStreaming({ kind: 'draft', text: '', stage: 'context' })
    try {
      const body = { ...(instruction.trim() ? { instruction: instruction.trim() } : {}), ...(tier ? { tier } : {}) }
      const r = await stream<{ result: { section: Section; self_check?: { fixes: { from: string; to: string; count: number }[]; original: string } }; refs: AIRefs; ai_call_id: string }>(`/sections/${section.id}/draft`, body, {
        signal: abort.current.signal,
        onDelta: (t) => setStreaming((s) => (s ? { ...s, text: s.text + t } : s)),
        onEvent: onStreamEvent,
      })
      setRefs(r.refs)
      setCallId(r.ai_call_id)
      const sec0 = r.result.section
      load(sec0)
      await refresh()
      onDrafted?.(section.id)
      // DEV-A105：起草自检前置——展示自动修正并支持还原到 AI 原始输出。
      if (r.result.self_check?.fixes?.length) {
        setSelfCheck({ ...r.result.self_check, sectionId: section.id })
      } else {
        setSelfCheck(null)
      }
      if (prev.trim()) undoToast('已重新起草', prev, r.ai_call_id)
    } catch (e) {
      if (e instanceof ApiError && e.code === 'version_conflict') {
        const detail = e.detail as AIConflict
        setRefs(detail.refs ?? null); setCallId(detail.ai_call_id ?? null)
        load(detail.server)
        setAIConflict(detail)
        await refresh()
      } else aiError(e, `第 ${index + 1} 段起草`, draft)
    } finally {
      jobId.current = null
      setStreaming(null)
    }
  }

  // 刷新前开始的起草仍在后台进行（EX-N-01）：显示生成中并轮询，完成后取回结果。
  useEffect(() => {
    if (!resumeJob || streaming) return
    jobId.current = resumeJob
    setStreaming({ kind: 'draft', text: '', resumed: true })
    let alive = true
    const tick = async () => {
      if (!alive) return
      try {
        const j = await get<{ status: string; error: string }>(`/ai-jobs/${resumeJob}`)
        if (j.status === 'queued' || j.status === 'running') {
          window.setTimeout(tick, 1500)
          return
        }
        if (!alive) return
        jobId.current = null
        setStreaming(null)
        if (j.status === 'done') {
          await refresh()
          toast.success(`第 ${index + 1} 段的起草已完成`)
        } else if (j.status === 'failed') toast.error(`第 ${index + 1} 段起草失败：${j.error || '请重试'} · 你的内容没有被改动`)
      } catch {
        if (alive) window.setTimeout(tick, 3000)
      }
    }
    void tick()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeJob])

  /** edit asks for 1 or 3 candidates (prefs.default_variants); sentence forces an exact-sentence rewrite (表达体检). */
  const edit = async (mode: 'rewrite' | 'expand' | 'shorten', opts: { sentence?: string; count?: 1 | 3 } = {}) => {
    const sel = opts.sentence ?? (editor.current?.selectedText() || '')
    const original = sel || content.current
    if (!original.trim()) return toast.info('这一段还没有内容')
    const applyMode: ApplyMode = opts.sentence ? 'excerpt' : sel ? 'selection' : 'whole'
    const count = opts.count ?? prefs.default_variants
    lastRun.current = () => void edit(mode, opts)
    if (!(await flush())) return
    const body = { mode, selection: sel, ...(instruction.trim() ? { instruction: instruction.trim() } : {}), ...(tier ? { tier } : {}) }
    const modeName = { rewrite: '改写', expand: '扩写', shorten: '缩写' }[mode]
    if (count === 3) {
      const run = async () => {
        abort.current = new AbortController()
        const r = await post<{ variants: Variant[]; ai_call_id: string; refs: AIRefs }>(`/sections/${section.id}/edit`, { ...body, variants: 3 }, abort.current.signal)
        setRefs(r.refs)
        setCallId(r.ai_call_id)
        setVariants({ title: `${modeName}候选`, original, list: r.variants, callId: r.ai_call_id, mode: applyMode, rerun: run })
      }
      setStreaming({ kind: 'edit', text: '', stage: 'generating' })
      try {
        await run()
      } catch (e) {
        aiError(e, modeName, () => edit(mode, opts))
      } finally {
        setStreaming(null)
      }
      return
    }
    abort.current = new AbortController()
    jobId.current = null
    setStreaming({ kind: 'edit', text: '', stage: 'context' })
    try {
      const r = await stream<{ text: string; refs: AIRefs; ai_call_id: string }>(`/sections/${section.id}/edit`, body, {
        signal: abort.current.signal,
        onDelta: (t) => setStreaming((s) => (s ? { ...s, text: s.text + t } : s)),
        onEvent: onStreamEvent,
      })
      setRefs(r.refs)
      setCallId(r.ai_call_id)
      // ED-13：记住生成时的选区位置；应用时用来发现"选区已经变了"。
      setProposal({ original, text: r.text.trim(), mode: applyMode, callId: r.ai_call_id, range: applyMode === 'selection' ? editor.current?.selectionRange() ?? null : null })
    } catch (e) {
      aiError(e, modeName, () => edit(mode, opts))
    } finally {
      setStreaming(null)
    }
  }

  const hooks = async (kind: 'opening' | 'ending' | 'quote') => {
    const sel = editor.current?.selectedText() || ''
    if (kind === 'quote' && !sel.trim()) return toast.info('先选中要提炼的文字')
    const title = { opening: '开头候选', ending: '结尾候选', quote: '金句候选' }[kind]
    const target = !sel && kind !== 'quote' ? edgeText(content.current, kind === 'opening' ? 'first' : 'last') : ''
    const mode: VariantState['mode'] = kind === 'quote' ? 'copy' : sel ? 'selection' : target ? 'excerpt' : kind === 'opening' ? 'prepend' : 'append'
    const run = async () => {
      const r = await post<{ variants: Variant[]; ai_call_id: string; refs: AIRefs }>(`/sections/${section.id}/hooks`, { kind, selection: sel })
      setRefs(r.refs)
      setVariants({ title: target ? `${title} · 替换${kind === 'opening' ? '开头' : '结尾'}` : title, original: sel || target || undefined, list: r.variants, callId: r.ai_call_id, mode, rerun: run })
    }
    lastRun.current = () => void hooks(kind)
    if (!(await flush())) return
    setHookBusy(kind)
    try {
      await run()
    } catch (e) {
      aiError(e, title, () => hooks(kind))
    } finally {
      setHookBusy(null)
    }
  }

  // ED-13/14/16：应用前必须能回答"原文现在在哪、是不是只有一处"。
  const locateOriginal = (original: string) => {
    const cur = section.content_md || content.current
    if (!original) return { ok: false, reason: 'empty', hits: 0 }
    const hits = cur.split(original).length - 1
    if (hits === 0) return { ok: false, reason: 'gone', hits }
    if (hits > 1) return { ok: false, reason: 'many', hits }
    return { ok: true, reason: '', hits }
  }
  // ED-16：三种失败原因给三种提示，不再共用一句"已经改动过"。
  const locateHint = (original: string) => {
    const { reason } = locateOriginal(original)
    if (reason === 'gone') return '原文已经不在这一段里了，请重新生成建议'
    if (reason === 'many') return '原文在这段里出现多次，请手动选中要改的那一处再应用'
    return '这句话已经改动过，请手动选中后改写'
  }

  const applyText = (mode: ApplyMode, original: string, text: string, range?: { from: number; to: number } | null): boolean => {
    const cur = section.content_md || content.current
    switch (mode) {
      case 'whole':
        if (cur !== original) { toast.info(locateHint(original)); return false }
        editor.current?.setMarkdown(text)
        break
      case 'selection':
        // ED-13：当前选区必须和生成建议时完全一致（文本 + 位置），否则会把建议写到别处。
        const selected = editor.current?.selectedText()
        const now = editor.current?.selectionRange() ?? null
        if (selected) {
          const moved = !range || !now || now.from !== range.from || now.to !== range.to || selected !== original
          if (moved) {
            toast.info('选区已经变了，请重新选中原文再应用', {
              description: '建议是针对生成时选中的文字给的，现在选中的是别的内容。',
            })
            return false
          }
          editor.current?.replaceSelection(text)
          break
        }
        // ED-14：没有选区时按原文替换，要求唯一，否则会改到第一处。
        if (locateOriginal(original).ok) editor.current?.setMarkdown(cur.replace(original, text))
        else { toast.info(locateHint(original)); return false }
        break
      case 'excerpt':
        if (!locateOriginal(original).ok) { toast.info(locateHint(original)); return false }
        editor.current?.setMarkdown(cur.replace(original, text))
        break
      case 'prepend':
        editor.current?.setMarkdown(cur.trim() ? `${text}\n\n${cur}` : text)
        break
      case 'append':
        editor.current?.setMarkdown(cur.trim() ? `${cur}\n\n${text}` : text)
        break
    }
    return true
  }

  const accept = () => {
    if (!proposal) return
    const before = content.current
    applied.current = { kind: 'rewrite', ai_call_id: proposal.callId }
    if (applyText(proposal.mode, proposal.original, proposal.text, proposal.range)) {
      sendFeedback(proposal.callId, { outcome: 'accepted' })
      setProposal(null)
      undoToast('已替换', before, proposal.callId)
    } else applied.current = null
  }
  const discard = () => {
    sendFeedback(proposal?.callId, { outcome: 'rejected' })
    setProposal(null)
  }
  const pickVariant = async (i: number) => {
    if (!variants) return
    const v = variants.list[i]
    const before = content.current
    if (variants.mode === 'copy') {
      await copyText(v.text)
      const saved = await post(`/works/${work.id}/golden-sentences`, { text: v.text }).then(() => true, () => false)
      toast.success(saved ? '已复制并收藏为金句' : '已复制，可以粘贴为小标题或加粗句', {
        description: saved ? '粘贴进正文后，预览页的「排版建议」会提示把它加粗。' : undefined,
      })
    } else {
      applied.current = { kind: 'rewrite', ai_call_id: variants.callId }
      if (!applyText(variants.mode, variants.original ?? '', v.text)) {
        applied.current = null
        return
      }
    }
    sendFeedback(variants.callId, { outcome: 'accepted', choice_index: i })
    if (variants.mode !== 'copy') undoToast(`已用候选 ${i + 1}`, before, variants.callId)
    setVariants(null)
  }

  // 行内续写（EX-E-02）：只在按下 Alt+/ 时请求一句，Tab 接受，Esc 或继续输入放弃。
  const requestGhost = async () => {
    const { before, after } = editor.current?.textAround() ?? { before: '', after: '' }
    if (!before.trim()) return toast.info('先写几个字，再让 AI 接半句')
    ghostAbort.current?.abort()
    ghostAbort.current = new AbortController()
    setGhost({ text: '', loading: true })
    try {
      const r = await stream<{ result: { sentence: string }; ai_call_id?: string }>(`/sections/${section.id}/continue`, { before, after }, {
        signal: ghostAbort.current.signal,
        onDelta: (t) => setGhost((g) => (g ? { ...g, text: g.text + t } : g)),
      })
      setGhost(r.result?.sentence ? { text: r.result.sentence, loading: false, callId: r.ai_call_id } : null)
    } catch (e) {
      setGhost(null)
      aiError(e, '续写建议', requestGhost)
    }
  }
  const acceptGhost = () => {
    if (!ghost || ghost.loading) return
    const t = ghost.text
    applied.current = { kind: 'continue', ai_call_id: ghost.callId }
    sendFeedback(ghost.callId, { outcome: 'accepted' })
    setGhost(null)
    editor.current?.insertAtCursor(t)
  }

  useEffect(() => {
    if (readOnly) return
    const root = document.getElementById(`sec-${section.id}`)
    if (!root) return
    const onKey = (e: KeyboardEvent) => {
      if (ghost && e.key === 'Tab' && !ghost.loading) {
        e.preventDefault()
        acceptGhost()
        return
      }
      if (ghost && e.key === 'Escape') {
        e.preventDefault()
        ghostAbort.current?.abort()
        sendFeedback(ghost.callId, { outcome: 'rejected' })
        setGhost(null)
        return
      }
      if (streaming && e.key === 'Escape') {
        e.preventDefault()
        stop()
        return
      }
      if (prefs.ghost_text && matchGhostKey(e, prefs.ghost_key)) {
        e.preventDefault()
        if (!streaming) void requestGhost()
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'r') {
        e.preventDefault()
        if (!streaming && !isEmpty) void edit('rewrite')
        return
      }
      if (!(e.metaKey || e.ctrlKey) || !isEnterWithoutComposition(e)) return
      if (streaming) return
      e.preventDefault()
      void draft()
    }
    root.addEventListener('keydown', onKey)
    return () => root.removeEventListener('keydown', onKey)
  })

  useEditorEvents((e) => {
    if (e.type === 'flush') {
      if (!readOnly) e.wait.push(flush().then(saved => { if (!saved) throw new Error('请先保存或处理段落冲突') }))
      return
    }
    if (!('sectionId' in e) || e.sectionId !== section.id) return
    if (e.type === 'focus') {
      editor.current?.focus()
      return
    }
    if (readOnly) return
    if (e.type === 'focus-draft') {
      draftButton.current?.focus({ preventScroll: true })
      return
    }
    if (e.type === 'apply') {
      if (streaming) return toast.info('当前段仍在生成，请稍后应用建议')
      if (e.original !== undefined && e.target !== 'end') {
        if (e.target === 'section' && content.current !== e.original) return toast.info('原文已改动，请重新生成建议')
        if (e.target === 'selection' && (!e.original || content.current.split(e.original).length !== 2)) return toast.info('目标原文已改动或不唯一，请重新生成建议')
        setProposal({ original: e.original, text: e.text, mode: e.target === 'selection' ? 'excerpt' : 'whole', callId: e.callId })
      } else if (e.target === 'end') {
        setProposal({ original: '', text: e.text, mode: 'append', callId: e.callId })
      } else {
        const sel = e.target === 'selection' ? editor.current?.selectedText() || '' : ''
        setProposal({ original: sel || content.current, text: e.text, mode: sel ? 'selection' : 'whole', callId: e.callId, range: sel ? editor.current?.selectionRange() ?? null : null })
      }
    } else if (e.type === 'insert') {
      editor.current?.insertAtCursor(e.text)
    } else if (e.type === 'fix-sentence') {
      void edit('rewrite', { sentence: e.sentence, count: 1 })
    } else if (e.type === 'open-pending') {
      const p = findPending(content.current)[e.index] ?? findPending(content.current)[0]
      if (p) setPendingOpen(p)
    }
  })

  const pickImage = () => fileInput.current?.click()
  const pickImageRef = useRef(pickImage)
  pickImageRef.current = pickImage
  const onRichPickImage = useCallback(() => pickImageRef.current(), [])
  const suggestImages = async () => {
    setImgBusy(true)
    try {
      const r = await post<{ suggestions: { description: string; prompt: string }[] }>(`/sections/${section.id}/image-suggest`)
      setImgSuggest(r.suggestions)
    } catch (e) { aiError(e, '配图建议') }
    finally { setImgBusy(false) }
  }
  const Editor = xhs ? PlainEditor : RichEditor
  const busy = !!streaming
  const bubbleActions = useRef({ edit, hooks, setToMaterial })
  bubbleActions.current = { edit, hooks, setToMaterial }
  const bubble = useMemo(() => (
    <div className="flex items-center gap-0.5 rounded-lg border border-mist-200 bg-white p-1 shadow-pop">
      <Button size="sm" variant="ghost" icon={<Repeat2 className="size-3.5" />} onClick={() => bubbleActions.current.edit('rewrite')}>改写选中部分</Button>
      <Button size="sm" variant="ghost" icon={<Quote className="size-3.5" />} onClick={() => bubbleActions.current.hooks('quote')}>提炼金句</Button>
      <Button size="sm" variant="ghost" icon={<MessageSquare className="size-3.5" />} onClick={() => emitEditor({ type: 'comment', sectionId: section.id, anchor: editor.current?.selectedText() || '' })}>批注</Button>
      <Button size="sm" variant="ghost" icon={<BookmarkPlus className="size-3.5" />} onClick={() => bubbleActions.current.setToMaterial(editor.current?.selectedText() || '')}>存入素材库</Button>
    </div>
  ), [])
  const reportActive = () => onActive?.(section.id, editor.current?.selectedText() || '')

  return (
    <div id={`sec-${section.id}`} onFocus={reportActive} onMouseUp={reportActive} onKeyUp={reportActive}
      className={cn('group/sec relative scroll-mt-24 rounded-xl border border-mist-200/80 bg-white shadow-card transition focus-within:border-ink-200 focus-within:shadow-pop', dim && 'focus-dim', readOnly && 'read-only', desktopPresentation && active && 'desktop-active')}>
      <div className={cn('absolute bottom-3 left-0 top-3 w-[3px] rounded-r', origin === 'ai' ? 'bg-ink-300' : origin === 'mixed' ? 'bg-sky-300' : 'bg-mist-200')} />
      <div className="desktop-section-heading flex items-center gap-2 border-b border-mist-100 px-4 py-2.5 sm:px-5">
        <span className="font-mono text-xs text-mist-400">{String(index + 1).padStart(2, '0')}</span>
        {xhs ? (
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-mist-600">{section.key_point || `第 ${index + 1} 段`}</span>
        ) : (
          <input value={heading} disabled={readOnly} onChange={(e) => {
            clearUndo()
            setHeading(e.target.value)
            void writeDraft(section.id, { content: content.current, heading: e.target.value, revision: revision.current, at: Date.now() })
          }} onBlur={() => heading !== section.heading && persist({ heading })}
            placeholder="段落小标题" className="min-w-0 flex-1 bg-transparent font-display text-[16px] font-bold text-mist-900 outline-none placeholder:text-mist-300" />
        )}
        {othersEditing && othersEditing.length > 0 ? (
          <span className="shrink-0 rounded-full bg-danger/10 px-2 py-0.5 text-[11px] text-danger" title="仍可编辑，但同时修改可能产生冲突">{othersEditing.join('、')} 正在编辑</span>
        ) : othersHere && othersHere.length > 0 && <span className="shrink-0 rounded-full bg-gamboge-100 px-2 py-0.5 text-[11px] text-gamboge-800">{othersHere.join('、')} 正在看这段</span>}
        <div className="desktop-section-header-tools flex items-center gap-2">
          <SectionMaterials work={work} section={section} readOnly={readOnly} onWork={setWork}
            triggerEvent={desktopPresentation ? `ops:section-materials:${section.id}` : undefined} />
          <IconButton label="段落历史" onClick={async () => { if (await flush()) setRevOpen(true) }}><History className="size-3.5" /></IconButton>
          <Badge tone={originMeta[origin].tone}>{originMeta[origin].label}</Badge>
          {!readOnly && (
            <div className="flex items-center opacity-0 transition group-hover/sec:opacity-100">
              <IconButton label="上移" disabled={index === 0} onClick={() => onMove(section.id, -1)}><ArrowUp className="size-3.5" /></IconButton>
              <IconButton label="下移" disabled={index === total - 1} onClick={() => onMove(section.id, 1)}><ArrowDown className="size-3.5" /></IconButton>
              <IconButton label="删除段落" className="hover:text-danger" onClick={() => onRemove(section.id)}><Trash2 className="size-3.5" /></IconButton>
            </div>
          )}
        </div>
      </div>
      {section.key_point && !xhs && <div className="px-4 pt-2.5 text-[12.5px] text-mist-400 sm:px-5">要点：{section.key_point}</div>}
      <div className="px-4 py-3 sm:px-5">
        {selfCheck && selfCheck.sectionId === section.id && !readOnly && (
          <Notice tone="ink" className="mb-3">
            <span>
              AI 自检修正了 {selfCheck.fixes.length} 处绝对化表达：
              {selfCheck.fixes.map((f) => `${f.from}→${f.to}`).join('、')}。
            </span>
            <button type="button" className="ml-1.5 cursor-pointer text-ink-600 underline" onClick={async () => {
              content.current = selfCheck.original
              editor.current?.setMarkdown(selfCheck.original)
              setLintText(selfCheck.original)
              setSelfCheck(null)
              await flush()
            }}>还原 AI 原文</button>
          </Notice>
        )}
        {streaming?.kind === 'draft' ? (
          <div className="min-h-[4em] whitespace-pre-wrap text-[15px] leading-[1.9] text-mist-700">
            {streaming.text}<span className="ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 animate-pulse bg-ink-500" />
            {!streaming.text && (
              <span className="text-mist-400">
                {streaming.resumed ? '刷新前开始的起草仍在进行，完成后会自动写入这一段…'
                  : streaming.stage === 'generating' ? '正在生成…' : '正在组织上下文（观点、大纲、素材、记忆）…'}
              </span>
            )}
          </div>
        ) : (
          <div onMouseMove={onEditorHover} onMouseLeave={() => setHoverHit(null)} onClick={onEditorClick}>
            <Editor ref={editor} value={content.current} resetKey={resetKey} onChange={onRichChange} editable={!readOnly && !busy}
              placeholder={isEmpty ? '点「起草本段」让 AI 写初稿，或者直接自己写。' : ''} onSelection={onRichSelection}
              bubble={xhs ? undefined : bubble} onPickImage={xhs ? undefined : onRichPickImage} />
          </div>
        )}
        {hoverHit && (
          <div className="pointer-events-none fixed z-50 max-w-72 rounded-lg border border-orange-200 bg-white px-3 py-2 text-[12px] shadow-pop"
            style={{ left: hoverHit.x + 12, top: hoverHit.y + 16 }}>
            <div className="font-medium text-orange-700">「{hoverHit.hit.word}」{lintCategoryLabel[hoverHit.hit.category] ?? hoverHit.hit.category}</div>
            {hoverHit.hit.reason && <div className="mt-0.5 text-mist-600">{hoverHit.hit.reason}</div>}
            {hoverHit.hit.suggestion && <div className="mt-0.5 text-mist-500">建议：{hoverHit.hit.suggestion}</div>}
          </div>
        )}
        {ghost && (
          <div className="mt-1 flex items-start gap-2 rounded-md bg-mist-50 px-2.5 py-1.5 text-[14px] leading-relaxed">
            <span className="flex-1 text-mist-400">{ghost.text || (ghost.loading ? '正在想下一句…' : '')}</span>
            <span className="shrink-0 pt-0.5 text-[11px] text-mist-400">{ghost.loading ? <Loader2 className="size-3 animate-spin" /> : 'Tab 接受 · Esc 放弃'}</span>
          </div>
        )}
        {streaming?.kind === 'edit' && (
          <div className="mt-3 rounded-lg border border-ink-100 bg-ink-50/50 p-3 text-[14px] leading-relaxed text-mist-700">
            <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-ink-600"><Loader2 className="size-3 animate-spin" />{streaming.stage === 'context' ? '正在组织上下文…' : '正在生成…'}</div>
            {streaming.text}
          </div>
        )}
        {proposal && (
          <div className="mt-3 animate-fade-in rounded-lg border border-ink-200 bg-ink-50/40 p-3">
            {/* ED-15/16：把"原文在这段的第几处、前后是什么"显示出来，错位才可能被发现。 */}
            {(() => {
              const live = section.content_md || content.current
              const hits = proposal.original ? live.split(proposal.original).length - 1 : 0
              if (hits === 0) return <p className="mb-2 text-[12px] font-medium text-danger">原文已经不在这一段里，应用前会要求你重新生成。</p>
              if (hits > 1) return <p className="mb-2 text-[12px] font-medium text-gamboge-700">原文在这段里出现 {hits} 处；没有选区时会改第一处，建议先手动选中要改的那一处。</p>
              const at = live.indexOf(proposal.original)
              const before = live.slice(Math.max(0, at - 20), at)
              const after = live.slice(at + proposal.original.length, at + proposal.original.length + 20)
              return <p className="mb-2 text-[12px] text-mist-500">…{before}<span className="font-medium text-mist-700">【此处】</span>{after}…</p>
            })()}
            <div className="grid gap-3 text-[13.5px] leading-relaxed md:grid-cols-2">
              <div><div className="mb-1 text-xs font-medium text-mist-400">原文</div><p className="whitespace-pre-wrap text-mist-500 line-through decoration-mist-300">{proposal.original}</p></div>
              <div><div className="mb-1 text-xs font-medium text-ink-600">建议</div><p className="whitespace-pre-wrap text-mist-800">{proposal.text || '（删除以上原文）'}</p></div>
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={discard}>放弃</Button>
              <Button size="sm" variant={proposal.text ? 'primary' : 'danger'} onClick={accept} icon={<Check className="size-3.5" />}>{proposal.text ? '替换' : '确认删除这一处'}</Button>
            </div>
          </div>
        )}
        {variants && (
          <VariantsCard title={variants.title} original={variants.original} variants={variants.list} onPick={pickVariant}
            onClose={() => { sendFeedback(variants.callId, { outcome: 'rejected' }); setVariants(null) }}
            more={moreBusy} onMore={variants.rerun ? async () => {
              setMoreBusy(true)
              sendFeedback(variants.callId, { outcome: 'regenerated' })
              try { await variants.rerun!() } catch (e) { aiError(e, variants.title) } finally { setMoreBusy(false) }
            } : undefined} />
        )}
        {!desktopPresentation && !streaming && (refs || callId) && (
          <div className="mt-2 rounded-lg border border-mist-100 bg-mist-50/80 px-2.5 py-1.5">
            <RefsNote refs={refs} callId={callId} onRetry={readOnly || !lastRun.current ? undefined : lastRun.current} />
          </div>
        )}
        {(pending.length > 0 || (showHits && wordHits.length > 0)) && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {pending.map((p) => (
              <button key={p.index} type="button" disabled={readOnly} onClick={() => setPendingOpen(p)} title="点击处理：选素材替换、手动填写或删掉这句"
                className="pending-mark cursor-pointer text-[12px] hover:brightness-95">{p.need || '待核实'}</button>
            ))}
          </div>
        )}
        {showHits && wordHits.length > 0 && (
          <ul className="mt-2 space-y-1 rounded-lg border border-orange-100 bg-orange-50/40 p-2 text-[12px]">
            {wordHits.map((h, i) => (
              <li key={i} className="flex flex-wrap gap-x-2">
                <span className="font-medium text-orange-700">「{h.word}」</span>
                <span className="text-mist-500">{lintCategoryLabel[h.category] ?? h.category} · {h.reason}</span>
                <span className="text-mist-400">建议：{h.suggestion}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {!readOnly && (
        <div className="desktop-section-footer space-y-2 border-t border-mist-100 px-3 py-2">
          {!busy && (
            <div className="desktop-section-instruction space-y-1.5">
              <div className="flex gap-1.5">
                <input
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  onFocus={() => setChipsOpen(true)}
                  placeholder="本段临时指令（可选），起草/改写/扩写/缩写都会带上"
                  className="h-8 min-w-0 flex-1 rounded-md border border-mist-200 bg-white px-2.5 text-[12.5px] text-mist-800 outline-none placeholder:text-mist-400 focus:border-ink-300"
                />
                <select value={tier} onChange={(e) => setTier(e.target.value as typeof tier)} title="只对这一段的下一次生成生效；默认跟随偏好设置"
                  className="h-8 shrink-0 cursor-pointer rounded-md border border-mist-200 bg-white px-1.5 text-[12px] text-mist-600 outline-none focus:border-ink-300">
                  <option value="">档位：跟随偏好</option>
                  <option value="economy">经济</option>
                  <option value="standard">标准</option>
                  <option value="quality">高质量</option>
                </select>
              </div>
              {(chipsOpen || instruction.trim() !== '') && <div className="flex flex-wrap gap-1">
                {toneChips.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setInstruction((prev) => (prev.includes(c) ? prev : prev.trim() ? `${prev.trim()}，${c}` : c))}
                    className="cursor-pointer rounded-md border border-mist-200 bg-mist-50 px-2 py-0.5 text-[11.5px] text-mist-600 hover:border-ink-200 hover:bg-ink-50 hover:text-ink-700"
                  >{c}</button>
                ))}
              </div>}
            </div>
          )}
          <div className="desktop-section-actions flex flex-wrap items-center gap-1">
            {canUndoAI && <Button size="sm" variant="ghost" disabled={busy} onClick={restoreBefore}>恢复改写前</Button>}
            {busy ? (
              <Button size="sm" variant="ghost" icon={<Square className="size-3.5" />} onClick={stop}>停止生成</Button>
            ) : (
              <>
                {isEmpty ? (
                  <Button size="sm" variant="primary" icon={<Sparkles className="size-3.5" />} onClick={draft} ref={draftButton}
                    disabled={!work.outline_confirmed_at} title="Ctrl/⌘+Enter">起草本段</Button>
                ) : (
                  <>
                    <Button className="desktop-section-rewrite" size="sm" variant="ghost" icon={<Repeat2 className="size-3.5" />} onClick={() => edit('rewrite')}>{selection ? '改写选中' : '改写本段'}</Button>
                    <Button className="desktop-section-expand" size="sm" variant="ghost" icon={<Wand2 className="size-3.5" />} onClick={() => edit('expand')}>扩写</Button>
                    <Button className="desktop-section-shorten" size="sm" variant="ghost" icon={<Minimize2 className="size-3.5" />} onClick={() => edit('shorten')}>缩写</Button>
                    <Button className="desktop-section-redraft" size="sm" variant="ghost" icon={<Sparkles className="size-3.5" />} onClick={draft} ref={draftButton}
                      disabled={!work.outline_confirmed_at} title="按大纲重写这一段（Ctrl/⌘+Enter）">重新起草</Button>
                    {desktopPresentation && <>
                      <Button size="sm" variant="ghost" onClick={() => { editor.current?.focus(); void requestGhost() }}>续写</Button>
                      <Button size="sm" variant="ghost" onClick={() => void hooks(index === 0 ? 'opening' : index === total - 1 ? 'ending' : 'quote')}>查看候选</Button>
                    </>}
                  </>
                )}
                <MoreMenu className="desktop-section-more" items={[
                  ...(index === 0 ? [{ label: '开头候选', loading: hookBusy === 'opening', onClick: () => void hooks('opening') }] : []),
                  ...(index === total - 1 && total > 1 ? [{ label: '结尾候选', loading: hookBusy === 'ending', onClick: () => void hooks('ending') }] : []),
                  ...(xhs && selection ? [{ label: '提炼金句', icon: <Quote />, loading: hookBusy === 'quote', onClick: () => void hooks('quote') }] : []),
                  ...(!isEmpty ? [{ label: '配图建议', icon: <ImagePlus />, loading: imgBusy, onClick: () => void suggestImages() }] : []),
                  ...(!xhs ? [{ label: '插入图片', icon: <ImagePlus />, onClick: pickImage }] : []),
                  ...(desktopPresentation ? [
                    ...(!isEmpty ? [
                      { label: '扩写本段', icon: <Wand2 />, onClick: () => void edit('expand') },
                      { label: '缩写本段', icon: <Minimize2 />, onClick: () => void edit('shorten') },
                      { label: '重新起草这一段', icon: <Sparkles />, onClick: () => void draft() },
                    ] : []),
                    { label: '本段素材', icon: <BookmarkPlus />, onClick: () => window.dispatchEvent(new Event(`ops:section-materials:${section.id}`)) },
                    ...(!isEmpty ? [{ label: '整段存入素材库', icon: <BookmarkPlus />, onClick: () => setToMaterial(content.current) }] : []),
                    { label: '段落历史', icon: <History />, onClick: async () => { if (await flush()) setRevOpen(true) } },
                    { label: '上移段落', icon: <ArrowUp />, disabled: index === 0, onClick: () => onMove(section.id, -1) },
                    { label: '下移段落', icon: <ArrowDown />, disabled: index === total - 1, onClick: () => onMove(section.id, 1) },
                    { label: '删除段落', icon: <Trash2 />, onClick: () => onRemove(section.id) },
                    ...(voiceSupported() ? [{ label: '语音输入', icon: <Mic />, onClick: () => window.dispatchEvent(new Event(`ops:section-voice:${section.id}`)) }] : []),
                  ] : []),
                ]} />
                <div className="desktop-section-voice">
                  <VoiceButton onText={(t) => editor.current?.insertAtCursor(t)}
                    triggerEvent={desktopPresentation ? `ops:section-voice:${section.id}` : undefined} />
                </div>
              </>
            )}
            <div className="ml-auto flex items-center gap-2 pr-2 text-xs text-mist-400">
              {pending.length > 0 && <button type="button" className="pending-mark cursor-pointer font-medium" onClick={() => setPendingOpen(pending[0])}>{pending.length} 处待核实</button>}
              {wordHits.length > 0 && <button type="button" className="cursor-pointer font-medium text-danger hover:underline" onClick={() => setShowHits((v) => !v)}>{wordHits.length} 处提示</button>}
              <span className="hidden sm:inline">{prefs.ghost_text ? `${prefs.ghost_key} 续写 · ` : ''}Ctrl/⌘+Enter 起草</span>
              <span>{runeLen(content.current)} 字</span>
            </div>
          </div>
        </div>
      )}
      {desktopPresentation && !streaming && (refs || callId) && (
        <div className="desktop-section-reference">
          <RefsNote refs={refs} callId={callId} onRetry={readOnly || !lastRun.current ? undefined : lastRun.current} />
        </div>
      )}
      <input ref={fileInput} type="file" accept="image/*" hidden onChange={async (e) => {
        const f = e.target.files?.[0]
        e.target.value = ''
        if (!f) return
        const a = await onUploadImage(f)
        if (a) editor.current?.insertImage(a.url)
      }} />
      <SectionConflictDialog server={conflict} heading={heading} content={content.current} onClose={() => setConflict(null)} onResolve={resolveConflict} />
      {aiConflict && <AIConflictPanel conflict={aiConflict} onKeep={() => { sendFeedback(aiConflict.ai_call_id, { outcome: 'rejected' }); setAIConflict(null) }} onReplace={async () => {
        const value = aiConflict
        const before = value.server.content_md
        load(value.server)
        applied.current = { kind: 'draft', ai_call_id: value.ai_call_id, ...(value.source_revisions ? { source_revisions: value.source_revisions } : {}) }
        content.current = value.candidate
        editor.current?.setMarkdown(value.candidate)
        setLintText(value.candidate)
        setIsEmpty(!value.candidate.trim())
        if (await persist()) { setAIConflict(null); setSelfCheck(value.self_check ? { ...value.self_check, sectionId: section.id } : null); await refresh(); undoToast('已替换', before, value.ai_call_id) }
      }} />}
      {toMaterial !== null && <SaveToMaterial text={toMaterial} work={work} onClose={() => setToMaterial(null)} />}
      {revOpen && <RevisionsDialog section={{ ...section, revision: revision.current }} workId={work.id} onClose={() => setRevOpen(false)} onRestored={setWork} />}
      {pendingOpen && (
        <PendingDialog work={work} section={section} mark={pendingOpen} onClose={() => setPendingOpen(null)}
          onReplace={async (text, materialId) => {
            editor.current?.setMarkdown(replaceNth(content.current, pendingOpen.marker, pendingOpen.index, text))
            setLintText(content.current)
            setPendingOpen(null)
            if (materialId && !(section.material_ids ?? []).includes(materialId)) {
              try {
                setWork(await put<Work>(`/sections/${section.id}/materials`, { material_ids: [...(section.material_ids ?? []), materialId] }))
              } catch (e) { toast.error(errorMessage(e)) }
            }
          }}
          onDelete={() => {
            editor.current?.setMarkdown(removeSentenceAt(content.current, pendingOpen.marker, pendingOpen.index))
            setLintText(content.current)
            setPendingOpen(null)
          }} />
      )}
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
                    const { job_id } = await post<{ job_id: string }>(`/works/${work.id}/generate-image`, { prompt: s.prompt, background: true })
                    const a = await waitJob<Asset>(job_id)
                    editor.current?.insertImage(a.url)
                    toast.success('已出图并插入（含 AI 标识）')
                    await refresh()
                  } catch (e) { aiError(e, '文生图') }
                  finally { setImgBusy(false) }
                }}>用此出图</Button>
              </div>
            </div>
          ))}
        </div>
      </Dialog>
    </div>
  )
// ED-16：正文被别处修改后必须重新渲染，否则建议卡拿旧正文判断"原文在哪"，然后静默覆盖别人刚写的内容。
}, (previous, next) => previous.section.revision === next.section.revision && previous.section.content_md === next.section.content_md
  && previous.index === next.index && previous.total === next.total && previous.work === next.work && previous.prefs === next.prefs
  && previous.patchWork === next.patchWork && previous.setWork === next.setWork && previous.refresh === next.refresh
  && previous.readOnly === next.readOnly && previous.dim === next.dim && previous.othersHere === next.othersHere
  && previous.othersEditing === next.othersEditing && previous.onEditing === next.onEditing && previous.onSave === next.onSave
  && previous.onMove === next.onMove && previous.onRemove === next.onRemove && previous.onUploadImage === next.onUploadImage
  && previous.onDrafted === next.onDrafted && previous.onActive === next.onActive && previous.onLint === next.onLint
  && previous.resumeJob === next.resumeJob && previous.desktopPresentation === next.desktopPresentation && previous.active === next.active)
