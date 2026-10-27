import { useQuery } from '@tanstack/react-query'
import { marked } from 'marked'
import { ArrowRight, Loader2, RefreshCw, Square } from 'lucide-react'
import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { confirm } from '@/components/dialog'
import { RefsNote } from '@/components/refs'
import { type EditorHandle, PlainEditor, RichEditor } from '@/components/section-editor'
import { Badge, Button, Card, cn, Field, Input, Notice, PageLoading, platformFormatLabel, platformLabel, PlatformMark } from '@/components/ui'
import { aiError } from '@/lib/ai-error'
import { ApiError, errorMessage, get, patch, stream } from '@/lib/api'
import { assetHtml } from '@/lib/api-base'
import { type AIRefs, parseTopics, runeLen } from '@/lib/format'
import type { Section, Work } from '@/lib/types'
import { TagSuggest } from './editor-tools'
import { useWork } from './WorkLayout'
import { AIConflictPanel, type AIConflict, SectionConflictDialog, WorkConflictDialog } from './section-save-dialogs'
import { useSectionSave } from './use-section-save'

interface SourceChange { source_id: string; heading: string; changed: boolean; deleted: boolean; old_content: string; new_content: string }
interface SourceDiffItem { section_id: string; changed: boolean; sources: SourceChange[] }

function sentences(s: string): string[] {
  return s.match(/[^。！？!?\n]+[。！？!?]?|\n/g)?.filter((x) => x.trim()) ?? []
}

/** diffSentences is a sentence-level LCS diff, enough to show what changed in a source paragraph. */
function diffSentences(a: string, b: string): { t: string; k: 'same' | 'add' | 'del' }[] {
  const x = sentences(a)
  const y = sentences(b)
  const dp = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0))
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out: { t: string; k: 'same' | 'add' | 'del' }[] = []
  let i = 0
  let j = 0
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { out.push({ t: x[i], k: 'same' }); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ t: x[i++], k: 'del' })
    else out.push({ t: y[j++], k: 'add' })
  }
  while (i < x.length) out.push({ t: x[i++], k: 'del' })
  while (j < y.length) out.push({ t: y[j++], k: 'add' })
  return out
}

function SourceDiffNote({ item }: { item: SourceDiffItem }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mt-2 rounded-lg border border-gamboge-200 bg-gamboge-50/60 p-2 text-[12.5px]">
      <button type="button" onClick={() => setOpen((v) => !v)} className="cursor-pointer font-medium text-gamboge-800">
        源段已修改 · {open ? '收起差异' : '查看差异'}
      </button>
      {open && item.sources.filter((s) => s.changed).map((s) => (
        <div key={s.source_id} className="mt-2 leading-relaxed">
          {s.deleted ? <p className="text-mist-500">对应的源段已删除。</p> : !s.old_content ? <p className="text-mist-500">找不到改写时的源段版本，以下为最新源段：{s.new_content}</p> : (
            <p>
              {diffSentences(s.old_content, s.new_content).map((d, i) => (
                <span key={i} className={cn(d.k === 'add' && 'bg-ink-100 text-ink-900', d.k === 'del' && 'text-mist-400 line-through')}>{d.t}</span>
              ))}
            </p>
          )}
        </div>
      ))}
      <p className="mt-1.5 text-[11.5px] text-mist-500">需要同步时点右侧「按新源段重新改写本段」，每次只改这一段。</p>
    </div>
  )
}

function DerivedSection({ section, index, work, active, onFocus, patchWork, refresh, changed, onRewritten }: {
  section: Section
  index: number
  work: Work
  active: boolean
  onFocus: () => void
  patchWork: (p: Partial<Work> | ((w: Work) => Partial<Work>)) => void
  refresh: () => Promise<unknown>
  changed?: boolean
  onRewritten?: () => void
}) {
  const xhs = work.platform === 'xhs'
  const editor = useRef<EditorHandle>(null)
  const [streaming, setStreaming] = useState<string | null>(null)
  const [len, setLen] = useState(runeLen(section.content_md))
  const [refs, setRefs] = useState<AIRefs | null>(null)
  const [aiConflict, setAIConflict] = useState<AIConflict | null>(null)
  const abort = useRef<AbortController | null>(null)
  const { content, resetKey, dirty, applied, conflict, heading, setConflict, persist, schedule, flush, resolveConflict, load } = useSectionSave({
    section, index, patchWork, onSave: () => undefined, onLoaded: text => setLen(runeLen(text)),
  })
  const onChange = (md: string) => { content.current = md; dirty.current = true; setLen(runeLen(md)); schedule() }

  const rewrite = async () => {
    if (content.current.trim() && !(await confirm({ title: '重新改写这一段？', desc: '当前内容会被替换，替换前的内容保存在版本历史中。', confirmText: '重新改写' }))) return
    if (!(await flush())) return
    abort.current = new AbortController()
    setStreaming('')
    try {
      const r = await stream<{ result: Section; refs: AIRefs }>(`/sections/${section.id}/rewrite`, {}, {
        signal: abort.current.signal,
        onDelta: (t) => setStreaming((s) => (s ?? '') + t),
      })
      setRefs(r.refs)
      load(r.result)
      refresh()
      onRewritten?.()
    } catch (e) {
      if (e instanceof ApiError && e.code === 'version_conflict') { const detail = e.detail as AIConflict; load(detail.server); setRefs(detail.refs ?? null); setAIConflict(detail); await refresh() }
      else aiError(e, '改写本段', rewrite)
    } finally {
      setStreaming(null)
    }
  }
  const Editor = xhs ? PlainEditor : RichEditor
  return (
    <div onFocusCapture={onFocus} onClick={onFocus}
      className={cn('group/sec rounded-xl border bg-white p-4 transition', active ? 'border-ink-300 ring-3 ring-ink-100' : 'border-mist-200')}>
      <SectionConflictDialog server={conflict} heading={heading} content={content.current} onClose={() => setConflict(null)} onResolve={resolveConflict} />
      {aiConflict && <AIConflictPanel conflict={aiConflict} onKeep={() => setAIConflict(null)} onReplace={async () => {
        const value = aiConflict
        load(value.server)
        applied.current = { kind: 'draft', ai_call_id: value.ai_call_id, ...(value.source_revisions ? { source_revisions: value.source_revisions } : {}) }
        content.current = value.candidate
        editor.current?.setMarkdown(value.candidate)
        setLen(runeLen(value.candidate))
        if (await persist()) { setAIConflict(null); await refresh(); onRewritten?.() }
      }} />}
      <div className="mb-2 flex items-center gap-2">
        <span className="font-mono text-xs text-mist-400">{String(index + 1).padStart(2, '0')}</span>
        <span className="text-[13.5px] font-semibold text-mist-800">{section.heading || section.key_point || `第 ${index + 1} 段`}</span>
        <span className="ml-auto text-xs text-mist-400">{len} 字</span>
        {streaming !== null ? (
          <Button size="sm" variant="ghost" icon={<Square className="size-3.5" />} onClick={() => abort.current?.abort()}>停止</Button>
        ) : (
          <Button size="sm" variant={changed ? 'secondary' : 'ghost'} icon={<RefreshCw className="size-3.5" />} disabled={work.locked || section.source_section_ids.length === 0} onClick={rewrite}>
            {changed ? '按新源段重新改写本段' : '重新改写本段'}
          </Button>
        )}
      </div>
      {streaming !== null ? (
        <div className="min-h-[3em] whitespace-pre-wrap text-[15px] leading-[1.85] text-mist-700">
          {streaming || <span className="flex items-center gap-1.5 text-mist-400"><Loader2 className="size-3.5 animate-spin" />按目标账号的定位和风格改写中…</span>}
        </div>
      ) : (
        <>
          <Editor ref={editor} value={content.current} resetKey={resetKey} onChange={onChange} editable={!work.locked} />
          <RefsNote refs={refs} className="mt-2" onRetry={rewrite} />
        </>
      )}
    </div>
  )
}

export default function Compare() {
  const { work, setWork, patchWork, refresh } = useWork()
  const nav = useNavigate()
  const [active, setActive] = useState<string | null>(null)
  const src = useQuery({ queryKey: ['work', work.source?.id], queryFn: () => get<Work>(`/works/${work.source!.id}`), enabled: !!work.source && !work.source.deleted, retry: false })
  const diff = useQuery({ queryKey: ['source-diff', work.id], queryFn: () => get<SourceDiffItem[]>(`/works/${work.id}/source-diff`), enabled: !!work.source && !work.source.deleted && work.content_format !== 'comic' })
  const diffBy = new Map((diff.data ?? []).map((d) => [d.section_id, d]))
  const [topics, setTopics] = useState(work.topics.map((t) => '#' + t).join(' '))
  const [title, setTitle] = useState(work.title)
  const [fieldConflict, setFieldConflict] = useState<{ server: Work; body: Record<string, unknown> } | null>(null)
  if (!work.source) return <div className="p-10"><Notice>这篇作品不是派生作品。</Notice></div>
  if (work.content_format === 'comic') {
    return (
      <div className="p-10">
        <Notice>漫画衍生作品在漫画编辑器中核对旁白与对白，不使用段落对照页。
          <button type="button" className="ml-2 cursor-pointer font-medium underline" onClick={() => nav(`/works/${work.id}`)}>打开漫画编辑器</button>
        </Notice>
      </div>
    )
  }
  if (src.isLoading) return <PageLoading />
  const srcWork = src.data
  const srcById = new Map(srcWork?.sections.map((s) => [s.id, s]) ?? [])
  const activeSrc = new Set(work.sections.find((s) => s.id === active)?.source_section_ids ?? [])
  const xhs = work.platform === 'xhs'
  const toutiao = work.platform === 'toutiao'
  const internalName = toutiao && work.content_format === 'micro_post'
  const titleLabel = internalName ? '内部名称' : toutiao ? '发布标题' : '标题'
  const bodyReady = work.sections.length > 0 && work.sections.every(section => section.content_md.trim() !== '')
  const total = runeLen(work.sections.map((s) => s.content_md).join(''))
  // ED-02：标题/话题原来只在 blur 保存，"去检查"可能读到旧值。改为 blur 保存 + 跳转前显式 flush。
  const saveField = async (body: Record<string, unknown>, base = work.revision) => {
    try {
      setWork(await patch<Work>(`/works/${work.id}`, { ...body, base_revision: base }))
      setFieldConflict(null)
      return true
    } catch (e) {
      if (e instanceof ApiError && e.code === 'version_conflict') setFieldConflict({ server: (e.detail as { server: Work }).server, body })
      else toast.error(errorMessage(e))
      return false
    }
  }
  // ED-02：把尚未落库的标题/话题先写回服务端，全部成功才允许离开本页。
  const flushFields = async (): Promise<boolean> => {
    const body: Record<string, unknown> = {}
    if (title !== work.title) body.title = title
    const topicList = parseTopics(topics)
    if (topicList.join(' ') !== work.topics.join(' ')) body.topics = topicList
    if (Object.keys(body).length === 0) return true
    return saveField(body)
  }
  const goCheck = async () => {
    if (!(await flushFields())) { toast.error('标题/话题还有未保存的修改，请先处理冲突再继续'); return }
    nav(bodyReady ? `/works/${work.id}/check` : xhs ? `/works/${work.id}#step-images` : `/works/${work.id}`)
  }
  return (
    <div className="mx-auto w-full max-w-[1480px] px-6 py-6 2xl:max-w-[1680px]">
      <WorkConflictDialog server={fieldConflict?.server ?? null} mine={{ ...work, title }} onClose={() => setFieldConflict(null)} onResolve={keepMine => {
        if (!fieldConflict) return
        if (keepMine) void saveField(fieldConflict.body, fieldConflict.server.revision)
        else { setWork(fieldConflict.server); setFieldConflict(null) }
      }} />
      <div className="mb-4 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="flex items-center gap-2 text-[13px] text-mist-500">
          {srcWork && <PlatformMark platform={srcWork.platform} size="sm" />}
          <span className="font-medium text-mist-700">源作品（只读）</span>
          {srcWork && <span className="truncate">{srcWork.account_name} · {platformLabel[srcWork.platform]} · {platformFormatLabel(srcWork.platform, srcWork.content_format)} ·《{srcWork.title || '未命名'}》</span>}
        </div>
        <div className="flex items-center gap-2 text-[13px] text-mist-500">
          <PlatformMark platform={work.platform} size="sm" />
          <span className="font-medium text-mist-700">衍生作品（可编辑）</span>
          <span className="truncate">{work.account_name} · {platformLabel[work.platform]} · {platformFormatLabel(work.platform, work.content_format)}</span>
          <Button size="sm" variant="primary" className="ml-auto" onClick={goCheck}>
            {bodyReady ? '去检查' : '继续编辑'}<ArrowRight className="size-3.5" />
          </Button>
        </div>
      </div>
      {!srcWork && <Notice tone="gamboge" className="mb-4">源作品已删除，只能查看和编辑衍生作品。</Notice>}
      {/* ED-01：窄屏两栏各占一半正文不可读，改单栏纵向堆叠；宽屏仍并排对照。 */}
      <div className="mb-4 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card className="bg-mist-50/60 p-4"><div className="text-xs text-mist-400">源稿标题</div><div className="mt-1 font-display text-[16px] font-bold text-mist-800">{srcWork?.title}</div></Card>
        <Card className="p-4">
          <Field label={titleLabel} counter={!toutiao ? { value: runeLen(title), max: xhs ? 20 : 32 } : undefined}
            hint={internalName ? '仅供系统识别，不会写入微头条发布正文。' : toutiao ? '发布标题上限待实测（V-025）。' : undefined}>
            <Input value={title} disabled={work.locked} onChange={(e) => setTitle(e.target.value)} onBlur={() => title !== work.title && void saveField({ title })} className="font-display font-semibold" />
          </Field>
        </Card>
      </div>
      <div className="space-y-3">
        {work.sections.map((s, i) => {
          const sources = s.source_section_ids.map((id) => srcById.get(id)).filter(Boolean) as Section[]
          const on = active === s.id
          return (
            <div key={s.id} className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
              <div onClick={() => setActive(s.id)}
                className={cn('cursor-pointer rounded-xl border p-4 transition', on || sources.some((x) => activeSrc.has(x.id)) ? 'border-gamboge-300 bg-gamboge-50/50' : 'border-transparent bg-mist-50/70 hover:bg-mist-100/70')}>
                {sources.length === 0 ? <p className="text-[13px] text-mist-400">（对应的源段落已删除）</p> : sources.map((x) => (
                  <div key={x.id}>
                    {x.heading && <div className="mb-1.5 text-[13.5px] font-semibold text-mist-700">{x.heading}</div>}
                    <div className="md text-[14px] leading-[1.85] text-mist-600" dangerouslySetInnerHTML={{ __html: assetHtml(marked.parse(x.content_md, { async: false }) as string) }} />
                  </div>
                ))}
                {diffBy.get(s.id)?.changed && <SourceDiffNote item={diffBy.get(s.id)!} />}
              </div>
              <DerivedSection section={s} index={i} work={work} active={on} onFocus={() => setActive(s.id)} patchWork={patchWork} refresh={refresh}
                changed={diffBy.get(s.id)?.changed} onRewritten={() => void diff.refetch()} />
            </div>
          )
        })}
      </div>
      <div className="sticky bottom-0 z-10 mt-6 -mx-6 border-t border-mist-200 bg-white/95 px-6 py-3 backdrop-blur">
        <div className="flex flex-wrap items-center gap-4">
          {(xhs || toutiao) && (
            <div className="flex min-w-[320px] flex-1 items-center gap-2">
              <span className="shrink-0 text-[13px] text-mist-500">话题</span>
              <Input value={topics} disabled={work.locked} onChange={(e) => setTopics(e.target.value)} placeholder="#话题1 #话题2"
                onBlur={() => {
                  const list = parseTopics(topics)
                  if (list.join(' ') !== work.topics.join(' ')) void saveField({ topics: list })
                }} />
              <TagSuggest workId={work.id} current={parseTopics(topics)} disabled={work.locked} onAdd={(t) => {
                const list = [...parseTopics(topics), t]
                setTopics(list.map((x) => '#' + x).join(' '))
                saveField({ topics: list })
              }} />
            </div>
          )}
          <span className="text-[13px] text-mist-500">正文 <span className="font-semibold tabular-nums text-mist-800">{total}</span> 字{toutiao ? <span className="text-mist-400">（平台上限待实测 V-025）</span> : xhs ? <span className="text-mist-400">（上限待核实 V-012，建议 1000 字以内）</span> : null}</span>
          <Badge tone={work.source_updated ? 'gamboge' : 'gray'} className="ml-auto">
            {(diff.data ?? []).some((d) => d.changed) ? `${(diff.data ?? []).filter((d) => d.changed).length} 段的源段已修改` : work.source_updated ? '源稿已更新' : '与源稿同步时间一致'}
          </Badge>
        </div>
      </div>
    </div>
  )
}
