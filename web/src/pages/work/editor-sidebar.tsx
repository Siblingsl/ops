import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Activity, AlertCircle, BookOpenCheck, Bot, Check, ChevronsRight, History, Library, MessageSquare, Plus, Send, Sparkles, Square, Stethoscope, Trash2,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { confirm } from '@/components/dialog'
import { AIFeedback } from '@/components/refs'
import { Badge, Button, cn, Select, Spinner, Textarea } from '@/components/ui'
import { aiError } from '@/lib/ai-error'
import { del, errorMessage, get, patch, post, put, stream } from '@/lib/api'
import { fmtTime } from '@/lib/format'
import { useCanWrite, useMe } from '@/lib/session'
import type { ActivityItem, Comment, PolishIssue, RetrieveHit, Section, Work, WorkspaceMember } from '@/lib/types'
import { usePendingMemories, usePrefs, waitJob } from '@/lib/v3'
import { emitEditor, findPending, scrollToSection, type SidebarTab, useEditorEvents } from './editor-tools'

interface Props {
  work: Work
  setWork: (w: Work) => void
  active: Section | null
  selection: string
  tab: SidebarTab
  onTab: (t: SidebarTab) => void
  onClose: () => void
}

const tabs: { id: SidebarTab; label: string; icon: React.ReactNode }[] = [
  { id: 'materials', label: '素材', icon: <Library className="size-3.5" /> },
  { id: 'copilot', label: '副驾驶', icon: <Bot className="size-3.5" /> },
  { id: 'polish', label: '体检', icon: <Stethoscope className="size-3.5" /> },
  { id: 'readthrough', label: '通读', icon: <BookOpenCheck className="size-3.5" /> },
  { id: 'pending', label: '待核实', icon: <AlertCircle className="size-3.5" /> },
  { id: 'comments', label: '批注', icon: <MessageSquare className="size-3.5" /> },
  { id: 'activity', label: '动态', icon: <Activity className="size-3.5" /> },
]

export function EditorSidebar({ work, setWork, active, selection, tab, onTab: setTab, onClose }: Props) {
  const pendingCount = work.sections.reduce((n, s) => n + findPending(s.content_md).length, 0)
  const comments = useQuery({ queryKey: ['comments', work.id], queryFn: () => get<Comment[]>(`/works/${work.id}/comments`), refetchInterval: 60_000 })
  const openComments = (comments.data ?? []).filter((c) => !c.resolved_at).length
  const pendingMemories = usePendingMemories(work.account_id)
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-0.5 border-b border-mist-200 px-1.5 py-1.5">
        <div className="scrollbar-thin flex flex-1 gap-0.5 overflow-x-auto">
          {tabs.map((t) => {
            const n = t.id === 'pending' ? pendingCount : t.id === 'comments' ? openComments : 0
            return (
              <button key={t.id} type="button" onClick={() => setTab(t.id)} title={t.label}
                className={cn('flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-[12px] transition', tab === t.id ? 'bg-ink-50 font-medium text-ink-800' : 'text-mist-500 hover:bg-mist-100')}>
                {t.icon}{t.label}{n > 0 && <span className="rounded-full bg-gamboge-400 px-1 text-[10px] font-bold text-mist-900">{n}</span>}
              </button>
            )
          })}
        </div>
        <button type="button" onClick={onClose} title="收起侧栏" className="cursor-pointer rounded p-1 text-mist-400 hover:bg-mist-100"><ChevronsRight className="size-4" /></button>
      </div>
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-3">
        {tab === 'materials' && <MaterialsTab work={work} setWork={setWork} active={active} />}
        {tab === 'copilot' && <CopilotTab work={work} active={active} selection={selection} />}
        {tab === 'polish' && <PolishTab work={work} />}
        {tab === 'readthrough' && <ReadThroughTab work={work} active={active} />}
        {tab === 'pending' && <PendingTab work={work} />}
        {tab === 'comments' && <CommentsTab work={work} active={active} selection={selection} list={comments.data ?? []} refetch={() => comments.refetch()} />}
        {tab === 'activity' && <ActivityTab work={work} />}
      </div>
      {pendingMemories > 0 && (
        <Link to={`/a/${work.account_id}/profile?tab=memory`} className="flex items-center gap-2 border-t border-mist-200 px-3 py-2 text-[12px] text-mist-500 hover:bg-mist-50 hover:text-ink-700">
          <span className="size-2 shrink-0 rounded-full bg-gamboge-400" />
          AI 学到了 {pendingMemories} 条新偏好，去逐条确认
        </Link>
      )}
    </div>
  )
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="rounded-lg border border-dashed border-mist-200 px-3 py-4 text-center text-[12.5px] leading-relaxed text-mist-400">{children}</p>
}

// ---------- 素材推荐 + 我以前怎么写过（EX-D-03 / EX-E-06） ----------

function MaterialsTab({ work, setWork, active }: { work: Work; setWork: (w: Work) => void; active: Section | null }) {
  const prefs = usePrefs()
  const canWrite = useCanWrite()
  const ids = active?.material_ids ?? []
  const query = active ? `${active.heading} ${active.key_point} ${active.content_md.slice(0, 400)}`.trim() : ''
  const q = useQuery({
    queryKey: ['retrieve', work.account_id, 'sidebar', active?.id, query, ids.join(','), prefs.use_history],
    queryFn: () => post<{ items: RetrieveHit[]; mode: string }>(`/accounts/${work.account_id}/retrieve`, {
      query, types: prefs.use_history ? ['material', 'history'] : ['material'], limit: 6, exclude_ids: ids, work_id: work.id,
    }),
    enabled: !!active && !!query,
    staleTime: 30_000,
  })
  const [open, setOpen] = useState<string | null>(null)
  if (!active) return <Hint>点一下任意段落，这里会推荐与这一段相关的素材，以及你以前写过的类似段落。</Hint>
  const mats = (q.data?.items ?? []).filter((h) => h.type === 'material').slice(0, 5)
  const cite = (h: RetrieveHit) => {
    const text = (h.content ?? '').trim()
    if (!text) return
    emitEditor({ type: 'insert', sectionId: active.id, text: h.source ? `${text}（来源：${h.source}）` : text })
    toast.success('已在光标处插入素材原文')
  }
  const hist = (q.data?.items ?? []).filter((h) => h.type === 'history')
  const use = async (id: string) => {
    try {
      setWork(await put<Work>(`/sections/${active.id}/materials`, { material_ids: [...ids, id] }))
      toast.success('已用于本段，起草时会参考它')
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  return (
    <div className="space-y-4">
      <div className="text-[12px] text-mist-500">当前段落：<span className="font-medium text-mist-700">{active.heading || active.key_point || '未命名段落'}</span></div>
      <section>
        <div className="mb-1.5 flex items-center gap-1.5 text-[12.5px] font-semibold text-mist-700">相关素材{q.data?.mode === 'text' && <Badge>关键词匹配</Badge>}</div>
        {q.isLoading ? <Spinner /> : mats.length === 0 ? <Hint>素材库里没有找到相关内容。</Hint> : (
          <ul className="space-y-2">
            {mats.map((h) => (
              <li key={h.id} className="rounded-lg border border-mist-200 p-2.5">
                <p className={cn('whitespace-pre-wrap text-[12.5px] leading-relaxed text-mist-700', open !== h.id && 'line-clamp-4')}>{h.content}</p>
                {open === h.id && (h.source || h.tags?.length) && (
                  <p className="mt-1 text-[11px] text-mist-400">{h.source && `来源：${h.source}`}{h.tags?.length ? ` · ${h.tags.join('、')}` : ''}</p>
                )}
                <div className="mt-1 truncate text-[11px] text-mist-400" title={h.reason}>{h.reason}</div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setOpen(open === h.id ? null : h.id)}>{open === h.id ? '收起' : '查看'}</Button>
                  {canWrite && !work.locked && <>
                    <Button size="sm" variant="ghost" onClick={() => cite(h)}>插入引用</Button>
                    <Button size="sm" variant="secondary" icon={<Plus className="size-3" />} className="ml-auto" onClick={() => use(h.id)}>用于本段</Button>
                  </>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      {prefs.use_history && (
        <section>
          <div className="mb-1.5 flex items-center gap-1.5 text-[12.5px] font-semibold text-mist-700"><History className="size-3.5" />我以前怎么写过</div>
          <p className="mb-1.5 text-[11.5px] text-mist-400">起草和改写时会参考这些段落的结构和语气，不复用其中的事实。可在偏好设置里关闭。</p>
          {hist.length === 0 ? <Hint>没有找到相似的历史段落。</Hint> : (
            <ul className="space-y-2">
              {hist.map((h) => (
                <li key={h.id} className="rounded-lg bg-mist-50 p-2.5">
                  <Link to={`/works/${h.work_id}`} className="text-[12px] font-medium text-ink-700 hover:underline">《{h.title || '未命名'}》{h.heading && ` · ${h.heading}`}</Link>
                  <p className="mt-1 line-clamp-4 text-[12px] leading-relaxed text-mist-600">{h.excerpt}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  )
}

// ---------- 副驾驶（EX-E-01，HC-17） ----------

interface CopilotMessage { id: string; role: 'user' | 'assistant'; content: string; context_scope: string; section_id: string | null; ai_call_id: string | null; created_at: string; suggestions?: CopilotSuggestion[] }

const quickAsks = ['这段论证够不够？', '给我几个举例方向', '这段读起来顺吗？', '结构有没有问题？', '读者可能会有什么疑问？']

// DEV-A104（13 文档）：副驾驶回复可含多条可执行建议（改写/补充/删除，含目标与理由），逐条应用。
interface CopilotSuggestion { kind: 'rewrite' | 'append' | 'delete'; text: string; reason?: string; target?: 'section' | 'selection' | 'end'; section_id?: string; original?: string }

// 流式 JSON 只展示 reply 文本，不把建议契约暴露到聊天气泡。
function copilotPreview(text: string): string {
  const raw = text.trimStart().replace(/^```(?:json)?\s*/, '')
  if (!raw.startsWith('{')) return text
  const reply = /"reply"\s*:\s*"((?:\\.|[^"\\])*)/.exec(raw)?.[1]
  if (reply === undefined) return ''
  try { return JSON.parse('"' + reply + '"') as string } catch { return '' }
}

function CopilotTab({ work, active, selection }: { work: Work; active: Section | null; selection: string }) {
  const qc = useQueryClient()
  const canWrite = useCanWrite()
  const list = useQuery({ queryKey: ['copilot', work.id], queryFn: () => get<CopilotMessage[]>(`/works/${work.id}/copilot`) })
  const [scope, setScope] = useState<'section' | 'selection' | 'work'>('section')
  const [text, setText] = useState('')
  const [pending, setPending] = useState<{ q: string; a: string } | null>(null)
  const abort = useRef<AbortController | null>(null)
  const bottom = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (selection && scope === 'section') setScope('selection')
    if (!selection && scope === 'selection') setScope('section')
  }, [selection]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }) }, [list.data, pending?.a])
  const ask = async (message: string) => {
    if (!message.trim() || pending) return
    setText('')
    setPending({ q: message, a: '' })
    abort.current = new AbortController()
    try {
      await stream(`/works/${work.id}/copilot`, { message, scope, section_id: active?.id ?? null, selection: scope === 'selection' ? selection : '' }, {
        signal: abort.current.signal,
        onDelta: (d) => setPending((p) => (p ? { ...p, a: p.a + d } : p)),
      })
    } catch (e) {
      aiError(e, '副驾驶', () => ask(message))
    } finally {
      setPending(null)
      void qc.invalidateQueries({ queryKey: ['copilot', work.id] })
    }
  }
  const clear = async () => {
    if (!(await confirm({ title: '清空这篇作品的副驾驶对话？', confirmText: '清空', danger: true }))) return
    await del(`/works/${work.id}/copilot`)
    void list.refetch()
  }
  const ctxLabel = scope === 'work' ? '整篇' : scope === 'selection' ? '选中的文字' : active ? `「${active.heading || active.key_point || '当前段落'}」` : '作品概况'
  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center gap-2 text-[12px] text-mist-500">
        当前上下文：
        <Select className="h-7 flex-1 text-[12px]" value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
          <option value="section">当前段落</option>
          {selection && <option value="selection">选中的文字</option>}
          <option value="work">整篇</option>
        </Select>
        {(list.data ?? []).length > 0 && <button type="button" title="清空对话" onClick={clear} className="cursor-pointer text-mist-400 hover:text-danger"><Trash2 className="size-3.5" /></button>}
      </div>
      <p className="-mt-1.5 truncate text-[11.5px] text-mist-400">{ctxLabel}</p>
      <div className="space-y-3">
        {(list.data ?? []).length === 0 && !pending && <Hint>像问同事一样提问。副驾驶只给分析和单处修改建议，不会写整篇。</Hint>}
        {(list.data ?? []).map((m) => <CopilotBubble key={m.id} m={m} canApply={canWrite && !work.locked} />)}
        {pending && (
          <>
            <div className="ml-6 rounded-lg bg-ink-600 px-3 py-2 text-[12.5px] text-white">{pending.q}</div>
            <div className="mr-4 whitespace-pre-wrap rounded-lg bg-mist-100 px-3 py-2 text-[12.5px] leading-relaxed text-mist-700">{copilotPreview(pending.a) || <Spinner />}</div>
          </>
        )}
        <div ref={bottom} />
      </div>
      <div className="flex flex-wrap gap-1">
        {quickAsks.map((q) => (
          <button key={q} type="button" disabled={!!pending} onClick={() => ask(q)}
            className="cursor-pointer rounded-full border border-mist-200 px-2 py-0.5 text-[11.5px] text-mist-600 hover:border-ink-200 hover:bg-ink-50 disabled:opacity-50">{q}</button>
        ))}
      </div>
      <div className="flex items-end gap-1.5">
        <Textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="问点什么…（Ctrl+Enter 发送）" className="text-[12.5px]"
          onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void ask(text) } }} />
        {pending ? <Button size="sm" variant="ghost" icon={<Square className="size-3.5" />} onClick={() => abort.current?.abort()} />
          : <Button size="sm" variant="primary" icon={<Send className="size-3.5" />} disabled={!text.trim()} onClick={() => ask(text)} />}
      </div>
    </div>
  )
}

function CopilotBubble({ m, canApply }: { m: CopilotMessage; canApply: boolean }) {
  if (m.role === 'user') return <div className="ml-6 whitespace-pre-wrap rounded-lg bg-ink-600 px-3 py-2 text-[12.5px] text-white">{m.content}</div>
  // 空数组也是服务端的有效判定；历史消息仅展示，不重建未校验动作。
  const suggestions = m.suggestions ?? []
  const target = m.section_id
  return (
    <div className="mr-4 rounded-lg bg-mist-100 px-3 py-2">
      <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-mist-700">{m.content}</p>
      {canApply && target && suggestions.length > 0 && (
        <div className="mt-2 space-y-1.5">
          {suggestions.map((s, i) => (
            <div key={i} className="flex flex-wrap items-center gap-1.5 rounded border border-mist-200 bg-white px-2 py-1.5">
              <Badge tone="ink">{s.kind === 'rewrite' ? '改写建议' : s.kind === 'delete' ? '删除建议' : '补充建议'}</Badge>
              <span className="min-w-0 flex-1 truncate text-[12px] text-mist-600" title={s.text}>{s.text || s.original || '删除原文'}</span>
              {s.reason && <p className="w-full text-[11.5px] text-mist-500">理由：{s.reason}</p>}
              {s.section_id && s.target && (s.kind === 'rewrite' || s.kind === 'delete') ? <Button size="sm" variant={s.kind === 'delete' ? 'danger' : 'secondary'} onClick={() => {
                scrollToSection(s.section_id!)
                emitEditor({ type: 'apply', sectionId: s.section_id!, text: s.text, target: s.target === 'selection' ? 'selection' : 'section', original: s.original, callId: m.ai_call_id })
              }}>{s.kind === 'delete' ? '预览删除这一处' : '预览修改这一处'}</Button> : null}
              {s.kind === 'append' && <Button size="sm" variant="secondary" onClick={() => emitEditor({ type: 'apply', sectionId: target, text: s.text, target: 'end', callId: m.ai_call_id })}>补充到段末</Button>}
            </div>
          ))}
          <p className="text-[10.5px] text-mist-400">建议逐条确认应用；应用前会显示改动对比。</p>
        </div>
      )}
      <div className="mt-1 flex items-center text-[10.5px] text-mist-400">{fmtTime(m.created_at)}<AIFeedback callId={m.ai_call_id} className="ml-auto" /></div>
    </div>
  )
}

// ---------- 表达体检（EX-E-10，不出现“检测”类字样） ----------

const ruleLabel: Record<string, string> = {
  long_sentence: '长句', long_paragraph: '长段', passive: '被动句', repeat: '重复用词', same_opening: '句式单调', catchphrase: '口头禅', ai: '逻辑与论据',
}

function PolishTab({ work }: { work: Work }) {
  const [issues, setIssues] = useState<PolishIssue[] | null>(null)
  const [busy, setBusy] = useState<'rule' | 'ai' | null>(null)
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [ignored, setIgnored] = useState(0)
  const ignore = async (k: string) => {
    setHidden(new Set(hidden).add(k))
    try {
      const r = await post<{ ignored: number }>(`/works/${work.id}/polish-ignore`, { key: k })
      setIgnored(r.ignored)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const restore = async () => {
    try {
      await post(`/works/${work.id}/polish-ignore`, { clear: true })
      setHidden(new Set())
      setIgnored(0)
      void run(false)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const run = async (ai: boolean) => {
    setBusy(ai ? 'ai' : 'rule')
    try {
      const r = await post<{ issues: PolishIssue[]; job_id?: string; ignored?: number }>(`/works/${work.id}/polish-check`, { ai })
      setIssues(r.issues)
      setIgnored(r.ignored ?? 0)
      if (r.job_id) {
        toast.message('AI 正在通读全文，可以继续写，完成后结果会出现在这里')
        const res = await waitJob<{ issues: PolishIssue[] }>(r.job_id)
        setIssues(res.issues)
      }
    } catch (e) {
      if (ai) aiError(e, 'AI 通读体检', () => run(true))
      else toast.error(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }
  useEffect(() => { void run(false) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const key = (i: PolishIssue) => `${i.section_id}|${i.rule}|${i.excerpt}`
  const visible = (issues ?? []).filter((i) => !hidden.has(key(i)))
  const bySection = work.sections.map((s) => ({ s, list: visible.filter((i) => i.section_id === s.id) })).filter((g) => g.list.length)
  return (
    <div className="space-y-3">
      <p className="text-[11.5px] leading-relaxed text-mist-400">从读者角度看可读性：长句、长段、重复用词、句式单调等。只是建议，不会自动修改。</p>
      <div className="flex gap-1.5">
        <Button size="sm" variant="secondary" loading={busy === 'rule'} onClick={() => run(false)}>重新体检</Button>
        <Button size="sm" variant="ghost" icon={<Sparkles className="size-3.5" />} loading={busy === 'ai'} onClick={() => run(true)}>AI 看逻辑与论据</Button>
      </div>
      {ignored > 0 && (
        <button type="button" disabled={work.locked} className="cursor-pointer text-[11.5px] text-mist-400 hover:text-ink-700" onClick={restore}>
          已忽略 {ignored} 条 · 恢复显示
        </button>
      )}
      {issues === null ? <Spinner /> : bySection.length === 0 ? <Hint>没有发现明显的可读性问题。</Hint> : bySection.map(({ s, list }) => (
        <div key={s.id}>
          <button type="button" onClick={() => scrollToSection(s.id)} className="mb-1 cursor-pointer text-[12px] font-semibold text-mist-700 hover:text-ink-700">
            {s.heading || s.key_point || `第 ${s.position + 1} 段`} <span className="font-normal text-mist-400">{list.length}</span>
          </button>
          <ul className="space-y-1.5">
            {list.map((i) => {
              const canFix = ['long_sentence', 'same_opening', 'ai'].includes(i.rule) && !i.excerpt.endsWith('…') && s.content_md.includes(i.excerpt)
              return (
                <li key={key(i)} className="rounded-lg border border-mist-200 p-2 text-[12px]">
                  <div className="flex items-center gap-1.5"><Badge tone={i.source === 'ai' ? 'ink' : 'gray'}>{ruleLabel[i.rule] ?? i.rule}</Badge></div>
                  <p className="mt-1 leading-relaxed text-mist-700">{i.message}</p>
                  {i.excerpt && <p className="mt-1 line-clamp-2 text-mist-400">「{i.excerpt}」</p>}
                  <div className="mt-1.5 flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => scrollToSection(s.id)}>定位</Button>
                    {canFix && !work.locked && <Button size="sm" variant="ghost" onClick={() => emitEditor({ type: 'fix-sentence', sectionId: s.id, sentence: i.excerpt })}>用 AI 改这一句</Button>}
                    <Button size="sm" variant="ghost" className="ml-auto" disabled={work.locked} onClick={() => void ignore(key(i))}>忽略</Button>
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </div>
  )
}

// ---------- 待核实（EX-E-04） ----------

function PendingTab({ work }: { work: Work }) {
  const all = work.sections.flatMap((s) => findPending(s.content_md).map((p) => ({ s, p })))
  if (all.length === 0) return <Hint>没有待核实的地方。</Hint>
  return (
    <div className="space-y-2">
      <p className="text-[11.5px] text-mist-400">共 {all.length} 处。点击逐个处理，或按 F8 跳到下一处。</p>
      {all.map(({ s, p }) => (
        <button key={`${s.id}-${p.index}`} type="button" disabled={work.locked} onClick={() => { scrollToSection(s.id); emitEditor({ type: 'open-pending', sectionId: s.id, index: p.index }) }}
          className="block w-full cursor-pointer rounded-lg border border-mist-200 p-2.5 text-left transition hover:border-gamboge-300 hover:bg-gamboge-50/40">
          <div className="text-[11.5px] text-mist-400">{s.heading || s.key_point || `第 ${s.position + 1} 段`}</div>
          <div className="pending-mark mt-1 inline-block text-[12.5px]">{p.need || '待核实'}</div>
        </button>
      ))}
    </div>
  )
}

// ---------- 批注（EX-L-02） ----------

function CommentsTab({ work, active, selection, list, refetch }: { work: Work; active: Section | null; selection: string; list: Comment[]; refetch: () => void }) {
  const { data: me } = useMe()
  const members = useQuery({ queryKey: ['members'], queryFn: () => get<WorkspaceMember[]>('/workspaces/current/members'), staleTime: 300_000 })
  const [body, setBody] = useState('')
  const [anchor, setAnchor] = useState('')
  const [sectionId, setSectionId] = useState<string>('')
  const [mentions, setMentions] = useState<string[]>([])
  const [showResolved, setShowResolved] = useState(false)
  const [busy, setBusy] = useState(false)
  useEditorEvents((e) => {
    if (e.type === 'comment') {
      setSectionId(e.sectionId ?? '')
      setAnchor(e.anchor)
    }
  })
  useEffect(() => {
    if (active && !sectionId) setSectionId(active.id)
  }, [active]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const id = new URLSearchParams(location.search).get('comment')
    const c = id && list.find((x) => x.id === id)
    if (c && c.section_id) scrollToSection(c.section_id)
  }, [list.length]) // eslint-disable-line react-hooks/exhaustive-deps
  const send = async () => {
    if (!body.trim()) return
    setBusy(true)
    try {
      await post(`/works/${work.id}/comments`, { section_id: sectionId || null, anchor_text: anchor || selection, body, mentions })
      setBody('')
      setAnchor('')
      setMentions([])
      refetch()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const resolve = async (c: Comment, v: boolean) => {
    try {
      await patch(`/comments/${c.id}`, { resolved: v })
      refetch()
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const shown = list.filter((c) => showResolved || !c.resolved_at)
  const secName = (id: string | null) => {
    const s = work.sections.find((x) => x.id === id)
    return s ? s.heading || s.key_point || `第 ${s.position + 1} 段` : '整篇'
  }
  const others = (members.data ?? []).filter((m) => m.status === 'active' && m.user_id !== me?.user_id && m.username !== me?.username)
  return (
    <div className="space-y-3">
      <div className="space-y-2 rounded-lg border border-mist-200 p-2.5">
        <Select className="h-7 text-[12px]" value={sectionId} onChange={(e) => setSectionId(e.target.value)}>
          <option value="">整篇</option>
          {work.sections.map((s) => <option key={s.id} value={s.id}>{s.heading || s.key_point || `第 ${s.position + 1} 段`}</option>)}
        </Select>
        {(anchor || selection) && <p className="line-clamp-2 border-l-2 border-gamboge-300 pl-2 text-[11.5px] text-mist-500">「{anchor || selection}」</p>}
        <Textarea rows={2} value={body} onChange={(e) => setBody(e.target.value)} placeholder="写批注，可以 @用户名 提醒同事。批注不会改动正文。" className="text-[12.5px]" />
        {others.length > 0 && (
          <div className="flex flex-wrap items-center gap-1 text-[11.5px] text-mist-500">
            提醒：
            {others.map((m) => (
              <button key={m.user_id} type="button" onClick={() => setMentions(mentions.includes(m.user_id) ? mentions.filter((x) => x !== m.user_id) : [...mentions, m.user_id])}
                className={cn('cursor-pointer rounded-full border px-1.5', mentions.includes(m.user_id) ? 'border-ink-300 bg-ink-50 text-ink-700' : 'border-mist-200')}>@{m.username}</button>
            ))}
          </div>
        )}
        <Button size="sm" variant="primary" loading={busy} disabled={!body.trim()} onClick={send}>发表批注</Button>
      </div>
      <label className="flex items-center gap-1.5 text-[11.5px] text-mist-500">
        <input type="checkbox" className="accent-ink-600" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />显示已解决
      </label>
      {shown.length === 0 ? <Hint>还没有批注。</Hint> : (
        <ul className="space-y-2">
          {shown.map((c) => (
            <li key={c.id} className={cn('rounded-lg border p-2.5 text-[12px]', c.resolved_at ? 'border-mist-100 opacity-60' : 'border-mist-200')}>
              <div className="flex items-center gap-1.5 text-[11.5px] text-mist-400">
                <span className="font-medium text-mist-700">{c.author_name}</span>{fmtTime(c.created_at)}
                <button type="button" onClick={() => c.section_id && scrollToSection(c.section_id)} className="ml-auto cursor-pointer truncate hover:text-ink-700">{secName(c.section_id)}</button>
              </div>
              {c.anchor_text && <p className="mt-1 line-clamp-2 border-l-2 border-gamboge-300 pl-2 text-mist-500">「{c.anchor_text}」</p>}
              <p className="mt-1 whitespace-pre-wrap leading-relaxed text-mist-700">{c.body}</p>
              <div className="mt-1.5 flex justify-end">
                <Button size="sm" variant="ghost" icon={<Check className="size-3" />} onClick={() => resolve(c, !c.resolved_at)}>{c.resolved_at ? '重新打开' : '解决'}</Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ---------- 作品动态（EX-L-03） ----------

function ActivityTab({ work }: { work: Work }) {
  const q = useQuery({ queryKey: ['activity', work.id], queryFn: () => get<ActivityItem[]>(`/works/${work.id}/activity`) })
  if (q.isLoading) return <Spinner />
  if (!(q.data ?? []).length) return <Hint>还没有动态。</Hint>
  return (
    <ol className="relative space-y-3 border-l border-mist-200 pl-3">
      {q.data!.map((a, i) => (
        <li key={i} className="text-[12px]">
          <span className="absolute -left-[4.5px] mt-1.5 size-2 rounded-full bg-mist-300" />
          <div className="text-mist-700"><span className="font-medium">{a.actor || '系统'}</span> {a.text}</div>
          {a.target && <div className="line-clamp-1 text-mist-400">{a.target}</div>}
          <div className="text-[11px] text-mist-400">{fmtTime(a.at)}</div>
        </li>
      ))}
    </ol>
  )
}

// ---------- 整篇通读（DEV-A107，13 文档） ----------

interface ReadThroughSuggestion { section_id: string; action: 'rewrite' | 'append'; text: string; reason: string }

function ReadThroughTab({ work, active }: { work: Work; active: Section | null }) {
  const canWrite = useCanWrite()
  const [sugs, setSugs] = useState<ReadThroughSuggestion[] | null>(null)
  const [busy, setBusy] = useState(false)
  const noViewpoint = !work.viewpoint.trim()
  const drafted = work.sections.some((s) => s.content_md.trim())
  const run = async () => {
    setBusy(true)
    try {
      const r = await post<{ suggestions: ReadThroughSuggestion[] }>(`/works/${work.id}/read-through`, {})
      setSugs(r.suggestions)
    } catch (e) {
      aiError(e, '整篇通读')
    } finally {
      setBusy(false)
    }
  }
  const secById = new Map(work.sections.map((s) => [s.id, s]))
  return (
    <div className="space-y-3">
      <Hint>AI 通读整篇后按段落给出可执行的改写或补充建议；每条由你确认应用，不会批量改写。</Hint>
      {noViewpoint ? (
        <p className="rounded-lg border border-dashed border-mist-200 px-3 py-4 text-center text-[12.5px] text-mist-400">先写下你的核心观点（H-02），AI 通读才有判断依据。</p>
      ) : !drafted ? (
        <p className="rounded-lg border border-dashed border-mist-200 px-3 py-6 text-center text-[12.5px] text-mist-400">先确认大纲并起草，才有可通读的内容。</p>
      ) : (
        <>
          <Button variant="primary" className="w-full" loading={busy} onClick={run} icon={<BookOpenCheck className="size-4" />}>让 AI 通读整篇</Button>
          {sugs != null && sugs.length === 0 && (
            <p className="rounded-lg border border-dashed border-mist-200 px-3 py-4 text-center text-[12.5px] text-mist-400">通读完成：这一稿结构完整，没有值得硬改的地方。</p>
          )}
          {sugs != null && sugs.length > 0 && canWrite && sugs.map((su, i) => {
            const sec = secById.get(su.section_id)
            const target = active?.id ?? su.section_id
            const applyTo = su.section_id
            return (
              <div key={i} className="rounded-lg border border-mist-200 p-3">
                <div className="flex items-center gap-1.5">
                  <Badge tone="ink">{su.action === 'rewrite' ? '改写' : '补充'} · {sec ? sec.heading || '未命名段' : '段落'}</Badge>
                </div>
                <p className="mt-1.5 whitespace-pre-wrap text-[12.5px] leading-relaxed text-mist-700">{su.text}</p>
                <p className="mt-1 text-[11.5px] text-mist-400">{su.reason}</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {su.action === 'rewrite' && (
                    <Button size="sm" variant="secondary" onClick={() => emitEditor({ type: 'apply', sectionId: applyTo, text: su.text, target: 'section', callId: null })}>应用到该段</Button>
                  )}
                  {su.action === 'append' && (
                    <Button size="sm" variant="secondary" onClick={() => emitEditor({ type: 'apply', sectionId: applyTo, text: su.text, target: 'end', callId: null })}>补充到段末</Button>
                  )}
                  {target !== applyTo && <span className="self-center text-[10.5px] text-mist-400">目标段落会自动滚动定位</span>}
                </div>
              </div>
            )
          })}
        </>
      )}
    </div>
  )
}
