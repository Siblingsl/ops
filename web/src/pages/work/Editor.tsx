import { useQuery } from '@tanstack/react-query'
import { BookOpenCheck, CheckCircle2, Circle, Layers, PanelRightOpen, PenLine, Plus, Stethoscope, Wand2, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { confirm, Dialog, Drawer } from '@/components/dialog'
import { InboxPanel } from '@/components/inbox-panel'
import { Badge, Button, Card, cn, Field, HumanGate, Input, Notice, Textarea } from '@/components/ui'
import { aiError } from '@/lib/ai-error'
import { ApiError, del, errorMessage, get, patch, post, put, rawRequest, stream } from '@/lib/api'
import { runeLen } from '@/lib/format'
import { useCanWrite } from '@/lib/session'
import type { AIJob, Asset, LintHit, MaterialPreview, MaterialKind, SeriesContext, SeriesNeighbour, Work } from '@/lib/types'
import { usePrefs, useWorkCmd } from '@/lib/v3'
import CardEditor from './CardEditor'
import ComicEditor from './ComicEditor'
import { createSaveStatus, SaveStatus, SelectedSidebar } from './editor-state'
import { usePendingSections } from './editor-pending'
import { emitEditor, type EditorEvent, scrollToSection, type SidebarTab, useEditorEvents } from './editor-tools'
import { SectionBlock } from './section-block'
import { OutlineCard } from './editor-outline'
import { TitleCard } from './editor-title'
import { ImagesCard } from './editor-images'
import { WorkConflictDialog } from './section-save-dialogs'
import { useWork, WorkHeaderAction } from './WorkLayout'

const kindLabel: Record<MaterialKind, string> = { experience: '经历', opinion: '观点', case: '案例', data: '数据' }

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

function ViewpointCard({ work, setWork, readOnly, loadMaterials = false }: { work: Work; setWork: (w: Work) => void; readOnly: boolean; loadMaterials?: boolean }) {
  const [text, setText] = useState(work.viewpoint)
  const [picking, setPicking] = useState(false)
  const [inbox, setInbox] = useState(false)
  const [matQ, setMatQ] = useState('')
  const { data: materials } = useQuery({
    queryKey: ['materials', work.account_id, ''],
    queryFn: () => get<MaterialPreview[]>(`/materials?account_id=${work.account_id}`),
    enabled: picking || loadMaterials,
  })
  const search = useQuery({
    queryKey: ['materials', work.account_id, 'search', matQ.trim()],
    queryFn: () => get<MaterialPreview[]>(`/materials?account_id=${work.account_id}&q=${encodeURIComponent(matQ.trim())}`),
    enabled: picking && !!matQ.trim(),
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
  const filtered = matQ.trim() ? [...new Map([
    ...(search.data ?? []),
    ...(materials ?? []).filter(m => kindLabel[m.kind].includes(matQ.trim())),
  ].map(m => [m.id, m] as const)).values()].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)) : materials ?? []
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
          <p className="rounded-lg border border-dashed border-mist-200 px-3 py-3 text-[13px] text-mist-400">{ids.length ? `已关联 ${ids.length} 条素材，打开素材选择框可查看。` : '还没有选择素材。没有素材时，AI 遇到需要数据的地方会写成「【待核实：…】」让你补充。'}</p>
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
        {matQ.trim() && search.isFetching && <p className="mb-2 text-sm text-mist-400">正在搜索…</p>}
        {search.isError && <Notice tone="red">{errorMessage(search.error)}<Button size="sm" onClick={() => void search.refetch()}>重试</Button></Notice>}
        <div className="scrollbar-thin max-h-[50vh] space-y-2 overflow-y-auto">
          {(materials ?? []).length === 0 && <div className="space-y-3 py-8 text-center text-sm text-mist-400">
            <p>素材库是空的，可以先添加经历、观点、案例和数据。</p>
            <div className="flex justify-center gap-4">
              <Link className="text-ink-600 underline" to={`/a/${work.account_id}/materials`}>去素材库添加</Link>
              <button type="button" className="cursor-pointer text-ink-600 underline" onClick={() => { setPicking(false); setInbox(true) }}>从收件箱整理</button>
            </div>
          </div>}
          {(materials ?? []).length > 0 && filtered.length === 0 && <p className="py-6 text-center text-sm text-mist-400">没有匹配「{matQ}」的素材。</p>}
          {filtered.map((m) => (
            <label key={m.id} className={cn('flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition', ids.includes(m.id) ? 'border-ink-300 bg-ink-50/50' : 'border-mist-200 hover:border-mist-300')}>
              <input type="checkbox" className="mt-1 accent-ink-600" checked={ids.includes(m.id)} onChange={() => toggle(m.id)} />
              <div className="min-w-0">
                <div className="flex items-center gap-2"><Badge tone="ink">{kindLabel[m.kind]}</Badge>{m.shared && <Badge>共享</Badge>}</div>
                <p className="mt-1 text-[13px] leading-relaxed text-mist-700">{m.content}</p>
                {m.source && <p className="mt-0.5 text-xs text-mist-400">来源：{m.source}</p>}
              </div>
            </label>
          ))}
        </div>
      </Dialog>
      <Drawer open={inbox} onClose={() => setInbox(false)} title="从收件箱整理" desc="逐条确认素材，可选择同时关联到当前作品。">
        <InboxPanel accountId={work.account_id} work={work} onLinked={setWork} />
      </Drawer>
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

// ---------- 页面 ----------

export default function Editor() {
  const { work, setWork } = useWork()
  if (work.content_format === 'comic') return <ComicEditor />
  if (work.content_format === 'card_post') return <div className="mx-auto max-w-3xl space-y-4">
    <ViewpointCard work={work} setWork={setWork} readOnly={work.locked} />
    <OutlineCard work={work} setWork={setWork} readOnly={work.locked} />
    <CardEditor />
  </div>
  return <ArticleEditor key={work.id} />
}

const SIDEBAR_KEY = 'ops.editor.sidebar'
const SIDEBAR_WIDE_QUERY = '(min-width: 1280px)'

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
  const [orderConflict, setOrderConflict] = useState<{ server: Work; mine: Work; ids: string[] } | null>(null)
  const { work, setWork, patchWork, refresh, focus, presence, reportSection, reportEditing } = useWork()
  const nav = useNavigate()
  const route = useLocation()
  const canWrite = useCanWrite()
  const prefs = usePrefs()
  const readOnly = work.locked || !canWrite
  const saveStatus = useMemo(createSaveStatus, [])
  const positionKey = `ops.editor.position.${work.id}`
  const [position] = useState<{ sectionId?: string; tab?: SidebarTab }>(() => {
    try {
      const value = JSON.parse(localStorage.getItem(positionKey) || '{}')
      const tabs: SidebarTab[] = ['materials', 'copilot', 'polish', 'readthrough', 'pending', 'comments', 'activity']
      return { sectionId: typeof value?.sectionId === 'string' ? value.sectionId : undefined, tab: tabs.includes(value?.tab) ? value.tab : undefined }
    } catch { return {} }
  })
  const [activeId, setActiveId] = useState<string | null>(null)
  const [resumedSection, setResumedSection] = useState<number | null>(null)
  const selection = useRef('')
  const currentWork = useRef(work)
  currentWork.current = work
  const sectionWork = useMemo(() => ({ id: work.id, platform: work.platform, outline_confirmed_at: work.outline_confirmed_at, account_id: work.account_id, title: work.title }), [work.id, work.platform, work.outline_confirmed_at, work.account_id, work.title])
  const memberCache = useRef(new Map<string, { here: string[]; editing: string[] }>())
  const memberKey = JSON.stringify(presence.map(p => [p.section_id, p.username, !!p.editing]))
  const members = useMemo(() => {
    const grouped = new Map<string, { here: string[]; editing: string[] }>()
    for (const p of presence) {
      if (!p.section_id) continue
      const group = grouped.get(p.section_id) ?? { here: [], editing: [] }
      group.here.push(p.username)
      if (p.editing) group.editing.push(p.username)
      grouped.set(p.section_id, group)
    }
    for (const [id, group] of grouped) {
      const prev = memberCache.current.get(id)
      if (prev && JSON.stringify(prev) === JSON.stringify(group)) grouped.set(id, prev)
    }
    memberCache.current = grouped
    return grouped
  }, [memberKey])
  const fromMention = new URLSearchParams(location.search).has('comment')
  const [sidebar, setSidebar] = useState(() => fromMention || localStorage.getItem(SIDEBAR_KEY) !== '0')
  const [narrowSidebar, setNarrowSidebar] = useState(false)
  const [wide, setWide] = useState(() => window.matchMedia(SIDEBAR_WIDE_QUERY).matches)
  const [sideTab, setSideTab] = useState<SidebarTab>(fromMention ? 'comments' : position.tab ?? 'materials')
  const [materialsOpened, setMaterialsOpened] = useState(false)
  const selectSideTab = (tab: SidebarTab) => {
    setSideTab(tab)
    if (tab === 'materials') setMaterialsOpened(true)
  }
  const lintCounts = useRef<Record<string, number>>({})
  const resumeJobs = useQuery({
    queryKey: ['work-jobs', work.id],
    queryFn: () => get<AIJob[]>(`/ai-jobs?status=active&work_id=${work.id}`),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    select: (list) => Object.fromEntries(list.filter((j) => j.task_type === 'section_draft' && j.section_id).map((j) => [j.section_id!, j.id])),
  })
  const onSave = saveStatus.report
  const onLint = useCallback((id: string, n: number) => { lintCounts.current[id] = n }, [])
  const setWorkStable = setWork
  useEffect(() => {
    const media = window.matchMedia(SIDEBAR_WIDE_QUERY)
    const change = () => {
      setWide(media.matches)
      if (media.matches) setNarrowSidebar(false)
    }
    media.addEventListener('change', change)
    return () => media.removeEventListener('change', change)
  }, [])
  useEffect(() => {
    try { localStorage.setItem(positionKey, JSON.stringify({ sectionId: activeId ?? position.sectionId, tab: sideTab })) } catch {}
  }, [positionKey, activeId, sideTab, position.sectionId])
  useEffect(() => {
    setResumedSection(null)
    if (route.hash) {
      const t = window.setTimeout(() => document.getElementById(route.hash.slice(1).replace(/^section-/, 'sec-'))?.scrollIntoView({ behavior: 'smooth' }), 300)
      return () => window.clearTimeout(t)
    }
    const index = work.sections.findIndex(s => s.id === (activeId ?? position.sectionId))
    if (index < 0 || !work.outline_confirmed_at) return
    setActiveId(work.sections[index].id)
    setResumedSection(index + 1)
    const t = window.setTimeout(() => scrollToSection(work.sections[index].id), 300)
    return () => window.clearTimeout(t)
  }, [route.hash])
  const toggleSidebar = (v: boolean) => {
    if (wide) {
      setSidebar(v)
      localStorage.setItem(SIDEBAR_KEY, v ? '1' : '0')
    } else setNarrowSidebar(v)
    if (v && sideTab === 'materials') setMaterialsOpened(true)
  }
  useEditorEvents((e) => {
    if (e.type === 'sidebar') selectSideTab(e.tab)
    if (e.type === 'comment') setSideTab('comments')
    if (e.type === 'sidebar' || e.type === 'comment') toggleSidebar(true)
  })
  const onActive = useCallback((id: string, sel: string) => {
    setActiveId(id)
    selection.current = sel
    emitEditor({ type: 'selection', text: sel })
    reportSection(id)
  }, [reportSection])

  const upload = useCallback(async (f: File): Promise<Asset | null> => {
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
  }, [work.id, patchWork])
  const addSection = async () => {
    try {
      setWork(await post<Work>(`/works/${work.id}/sections`, { heading: '' }))
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const moveSection = useCallback(async (id: string, d: number) => {
    const before = currentWork.current
    const sections = [...before.sections]
    const i = sections.findIndex(s => s.id === id)
    const j = i + d
    ;[sections[i], sections[j]] = [sections[j], sections[i]]
    setWork({ ...before, sections })
    try {
      setWork(await put<Work>(`/works/${before.id}/sections/order`, { ids: sections.map((s) => s.id), base_revision: before.revision }))
    } catch (e) {
      setWork(before)
      if (e instanceof ApiError && e.code === 'version_conflict') setOrderConflict({ server: (e.detail as { server: Work }).server, mine: { ...before, sections }, ids: sections.map(s => s.id) })
      else toast.error(errorMessage(e))
    }
  }, [setWork])
  // 删除不再二次确认，改为可撤销（4.3 撤销体系）。
  const removeSection = useCallback(async (id: string) => {
    const n = currentWork.current.sections.findIndex((x) => x.id === id) + 1
    try {
      setWork(await del<Work>(`/sections/${id}`))
      toast(`已删除第 ${n} 段`, {
        duration: 10_000,
        action: {
          label: '撤销',
          onClick: async () => {
            try {
              setWork(await post<Work>(`/sections/${id}/restore`))
            } catch (e) {
              toast.error(errorMessage(e))
            }
          },
        },
      })
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }, [setWork])
  const drafted = work.sections.filter((s) => s.content_md.trim()).length
  const emptySections = work.sections.filter((s) => !s.content_md.trim())
  const allDrafted = !readOnly && !!work.outline_confirmed_at && work.sections.length > 0 && emptySections.length === 0
  const totalChars = work.sections.reduce((n, s) => n + runeLen(s.content_md.replace(/[#>*_`[\]()!-]/g, '')), 0)
  const target = work.target_chars ?? 0
  const pendingAll = usePendingSections(work.sections)
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
  const jumpNextEmpty = (afterId?: string, focusDraft = false) => {
    const go = (id: string) => {
      scrollTo(`sec-${id}`)
      if (focusDraft) {
        // 首次事件唤醒 LazyMount，渲染后再次把焦点交给单段按钮。
        emitEditor({ type: 'focus-draft', sectionId: id })
        window.setTimeout(() => emitEditor({ type: 'focus-draft', sectionId: id }), 100)
      }
    }
    const list = work.sections
    const isEmpty = (s: (typeof list)[number]) => s.id !== afterId && !s.content_md.trim()
    const last = list[list.length - 1]
    if (!afterId && prefs.write_ending_first && last && isEmpty(last) && list.length > 1) {
      go(last.id)
      return true
    }
    const start = afterId ? list.findIndex((s) => s.id === afterId) + 1 : 0
    const next = list.slice(Math.max(0, start)).find(isEmpty) ?? list.find(isEmpty)
    if (next) {
      go(next.id)
      return true
    }
    return false
  }
  const onOutlineConfirmed = () => {
    window.setTimeout(() => scrollTo('step-sections'), 80)
  }
  const draftedAction = useRef<(sectionId: string) => void>(() => {})
  draftedAction.current = (sectionId: string) => {
    if (!prefs.auto_jump_next_empty) return
    window.setTimeout(() => {
      if (jumpNextEmpty(sectionId, true)) toast.message('已聚焦下一段起草按钮，按 Ctrl/⌘+Enter 起草这一段')
    }, 120)
  }
  const onDrafted = useCallback((id: string) => draftedAction.current(id), [])
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
        if (wide ? showSidebar && sideTab === 'copilot' : narrowSidebar && sideTab === 'copilot') toggleSidebar(false)
        else {
          setSideTab('copilot')
          toggleSidebar(true)
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
      {!readOnly && <WorkHeaderAction>
        <Button size="sm" variant="primary" onClick={toCheck} disabled={drafted === 0} icon={<PenLine className="size-4" />}>
          {work.platform === 'wechat_mp' ? '排版并检查' : '提交检查'}
        </Button>
      </WorkHeaderAction>}
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
          {allDrafted && (
            <div className="mt-3 rounded-lg border border-ink-100 bg-ink-50/60 p-2.5 text-[12px] text-ink-800">
              <div className="font-medium">全文已起草，进入修改阶段</div>
              <div className="mt-0.5 text-mist-500">先通读看衔接，再体检挑表达问题。</div>
              <div className="mt-2 flex gap-1.5">
                <Button size="sm" variant="secondary" className="flex-1" icon={<BookOpenCheck className="size-3.5" />} onClick={() => emitEditor({ type: 'sidebar', tab: 'readthrough' })}>通读整篇</Button>
                <Button size="sm" variant="ghost" className="flex-1" icon={<Stethoscope className="size-3.5" />} onClick={() => emitEditor({ type: 'sidebar', tab: 'polish' })}>表达体检</Button>
              </div>
            </div>
          )}
          <SaveStatus store={saveStatus} />
        </aside>
      )}

      <div className="min-w-0 flex-1 space-y-5">
        {resumedSection !== null && <Notice tone="ink" className="fixed bottom-6 left-1/2 z-40 -translate-x-1/2 shadow-pop"><div className="flex items-center gap-3">
          <span>已回到上次编辑的第 {resumedSection} 段</span>
          <Button size="sm" variant="ghost" className="ml-auto" aria-label="关闭位置提示" onClick={() => setResumedSection(null)} icon={<X className="size-3.5" />} />
        </div></Notice>}
        {focus && (
          <div className="flex items-center gap-3 text-[12px] text-mist-500">
            <span>专注模式 · F11 退出</span>
            <span className="ml-auto">{totalChars} 字{target ? ` / ${target}` : ''}</span>
            {target > 0 && <div className="h-1 w-32 overflow-hidden rounded-full bg-mist-100"><div className="h-full bg-ink-500" style={{ width: `${Math.min(100, (totalChars / target) * 100)}%` }} /></div>}
          </div>
        )}
        {!focus && <OrganizeNotesCard work={work} setWork={setWorkStable} readOnly={readOnly} />}
        {!focus && <ViewpointCard work={work} setWork={setWorkStable} readOnly={readOnly} loadMaterials={materialsOpened && showSidebar && sideTab === 'materials'} />}
        {!focus && <OutlineCard work={work} setWork={setWorkStable} readOnly={readOnly} onConfirmed={onOutlineConfirmed} />}
        <section id="step-sections" className="scroll-mt-24 space-y-4">
          <div className="flex flex-wrap items-center gap-2 pt-2">
            <h2 className="font-display text-[17px] font-bold text-mist-900">正文</h2>
            <span className="text-xs text-mist-400">每一段单独起草，没有「全部起草」</span>
            {!readOnly && emptySections.length > 0 && work.outline_confirmed_at && (
              <Button size="sm" variant="ghost" className="ml-auto" onClick={() => jumpNextEmpty()}>跳到下一段空稿（{emptySections.length}）</Button>
            )}
            {allDrafted && (
              <Button size="sm" variant="ghost" className="ml-auto" icon={<BookOpenCheck className="size-3.5" />} onClick={() => emitEditor({ type: 'sidebar', tab: 'readthrough' })}>全文已起草，去通读</Button>
            )}
          </div>
          {!work.outline_confirmed_at ? (
            <HumanGate code="H-03">确认大纲后，这里会按大纲生成段落块，然后你可以逐段起草和修改。</HumanGate>
          ) : (
            <>
              {work.sections.map((s, i) => (
                <LazyMount key={s.id} id={s.id} enabled={work.sections.length > 30 && i > 3} preview={s.content_md}>
                <SectionBlock key={s.id} section={s} index={i} total={work.sections.length} work={sectionWork} prefs={prefs} patchWork={patchWork} setWork={setWorkStable}
                  refresh={refresh} readOnly={readOnly} dim={focus && activeIdx >= 0 && Math.abs(i - activeIdx) > 1}
                  othersHere={members.get(s.id)?.here}
                  othersEditing={members.get(s.id)?.editing} onEditing={reportEditing}
                  onSave={onSave} onMove={moveSection} onRemove={removeSection} onUploadImage={upload} onDrafted={onDrafted}
                  onActive={onActive} onLint={onLint} resumeJob={resumeJobs.data?.[s.id]} />
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
        {work.locked && <Notice tone="gray">作品已发布，当前为只读模式。</Notice>}
      </div>

      {showSidebar && (
        <aside className="sticky top-20 hidden h-[calc(100vh-6.5rem)] w-[320px] shrink-0 overflow-hidden rounded-xl border border-mist-200 bg-white shadow-card xl:block 2xl:w-[360px]">
          <SelectedSidebar work={work} setWork={setWorkStable} active={active} selectionRef={selection} tab={sideTab} onTab={selectSideTab} onClose={() => toggleSidebar(false)} />
        </aside>
      )}
      {!focus && !showSidebar && (
        <button type="button" onClick={() => toggleSidebar(true)} title="打开助手侧栏：素材推荐、副驾驶、体检、待核实、批注、动态"
          className="fixed right-4 top-1/2 z-20 hidden -translate-y-1/2 cursor-pointer flex-col items-center gap-1 rounded-xl border border-mist-200 bg-white px-2 py-3 text-[11px] text-mist-500 shadow-pop transition hover:text-ink-700 xl:flex">
          <PanelRightOpen className="size-4" />助手
          {pendingAll.length > 0 && <span className="rounded-full bg-gamboge-400 px-1 text-[10px] font-bold text-mist-900">{pendingAll.length}</span>}
        </button>
      )}
      {!focus && (
        <button type="button" onClick={() => toggleSidebar(true)} aria-label="打开助手工具"
          className="fixed right-4 top-1/2 z-20 flex -translate-y-1/2 cursor-pointer flex-col items-center gap-1 rounded-xl border border-mist-200 bg-white px-2 py-3 text-[11px] text-mist-500 shadow-pop transition hover:text-ink-700 xl:hidden">
          <PanelRightOpen className="size-4" />助手
          {pendingAll.length > 0 && <span className="rounded-full bg-gamboge-400 px-1 text-[10px] font-bold text-mist-900">{pendingAll.length}</span>}
        </button>
      )}
      <Drawer open={!wide && narrowSidebar && !focus} onClose={() => toggleSidebar(false)} title="作品工具" desc="素材、修改与协作工具">
        <div className="-mx-6 -my-5 h-full">
          <SelectedSidebar work={work} setWork={setWorkStable} active={active} selectionRef={selection} tab={sideTab} onTab={selectSideTab} onClose={() => toggleSidebar(false)} />
        </div>
      </Drawer>
      {orderConflict && <WorkConflictDialog server={orderConflict.server} mine={orderConflict.mine} onClose={() => setOrderConflict(null)} onResolve={async keepMine => {
        if (!keepMine) { setWork(orderConflict.server); setOrderConflict(null); return }
        try { setWork(await put<Work>(`/works/${work.id}/sections/order`, { ids: orderConflict.ids, base_revision: orderConflict.server.revision })); setOrderConflict(null) }
        catch (e) {
          if (e instanceof ApiError && e.code === 'version_conflict') setOrderConflict({ ...orderConflict, server: (e.detail as { server: Work }).server })
          else toast.error(errorMessage(e))
        }
      }} />}
    </div>
  )
}
