import { useQuery } from '@tanstack/react-query'
import { marked } from 'marked'
import { ArrowRight, Loader2, RefreshCw, Square } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { confirm } from '@/components/dialog'
import { RefsNote } from '@/components/refs'
import { type EditorHandle, PlainEditor, RichEditor } from '@/components/section-editor'
import { Badge, Button, Card, cn, Field, Input, Notice, PageLoading, PlatformMark } from '@/components/ui'
import { ApiError, errorMessage, get, patch, stream } from '@/lib/api'
import { type AIRefs, parseTopics, runeLen } from '@/lib/format'
import type { Section, Work } from '@/lib/types'
import { useWork } from './WorkLayout'

function DerivedSection({ section, index, work, active, onFocus, patchWork, refresh }: {
  section: Section
  index: number
  work: Work
  active: boolean
  onFocus: () => void
  patchWork: (p: Partial<Work> | ((w: Work) => Partial<Work>)) => void
  refresh: () => Promise<unknown>
}) {
  const xhs = work.platform === 'xhs'
  const editor = useRef<EditorHandle>(null)
  const content = useRef(section.content_md)
  const revision = useRef(section.revision)
  const [resetKey, setResetKey] = useState(0)
  const [streaming, setStreaming] = useState<string | null>(null)
  const [len, setLen] = useState(runeLen(section.content_md))
  const [refs, setRefs] = useState<AIRefs | null>(null)
  const abort = useRef<AbortController | null>(null)
  const timer = useRef<number>()
  useEffect(() => () => window.clearTimeout(timer.current), [])

  const save = async () => {
    try {
      const r = await patch<{ section: Section; work_revision: number; work_status: Work['status'] }>(`/sections/${section.id}`, { content_md: content.current, base_revision: revision.current })
      revision.current = r.section.revision
      patchWork((w) => ({
        status: r.work_status,
        revision: r.work_revision,
        sections: w.sections.map((s) => (s.id === r.section.id ? r.section : s)),
      }))
    } catch (e) {
      if (e instanceof ApiError && e.code === 'version_conflict') {
        const server = (e.detail as { server: Section }).server
        if (await confirm({ title: '这一段在别处被修改过', desc: '选择「保留我的」会用当前内容覆盖；取消则载入另一处的版本。', confirmText: '保留我的' })) {
          revision.current = server.revision
          save()
        } else {
          revision.current = server.revision
          content.current = server.content_md
          setResetKey((k) => k + 1)
        }
      } else toast.error(errorMessage(e))
    }
  }
  const onChange = (md: string) => {
    content.current = md
    setLen(runeLen(md))
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(save, 1200)
  }
  const rewrite = async () => {
    if (content.current.trim() && !(await confirm({ title: '重新改写这一段？', desc: '当前内容会被替换，替换前的内容保存在版本历史中。', confirmText: '重新改写' }))) return
    window.clearTimeout(timer.current)
    abort.current = new AbortController()
    setStreaming('')
    try {
      const r = await stream<{ result: Section; refs: AIRefs }>(`/sections/${section.id}/rewrite`, {}, {
        signal: abort.current.signal,
        onDelta: (t) => setStreaming((s) => (s ?? '') + t),
      })
      setRefs(r.refs)
      content.current = r.result.content_md
      revision.current = r.result.revision
      setLen(runeLen(r.result.content_md))
      setResetKey((k) => k + 1)
      refresh()
    } catch (e) {
      if ((e as Error).name !== 'AbortError') toast.error(errorMessage(e))
    } finally {
      setStreaming(null)
    }
  }
  const Editor = xhs ? PlainEditor : RichEditor
  return (
    <div onFocusCapture={onFocus} onClick={onFocus}
      className={cn('group/sec rounded-xl border bg-white p-4 transition', active ? 'border-ink-300 ring-3 ring-ink-100' : 'border-mist-200')}>
      <div className="mb-2 flex items-center gap-2">
        <span className="font-mono text-xs text-mist-400">{String(index + 1).padStart(2, '0')}</span>
        <span className="text-[13.5px] font-semibold text-mist-800">{section.heading || section.key_point || `第 ${index + 1} 段`}</span>
        <span className="ml-auto text-xs text-mist-400">{len} 字</span>
        {streaming !== null ? (
          <Button size="sm" variant="ghost" icon={<Square className="size-3.5" />} onClick={() => abort.current?.abort()}>停止</Button>
        ) : (
          <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} disabled={work.locked || section.source_section_ids.length === 0} onClick={rewrite}>重新改写本段</Button>
        )}
      </div>
      {streaming !== null ? (
        <div className="min-h-[3em] whitespace-pre-wrap text-[15px] leading-[1.85] text-mist-700">
          {streaming || <span className="flex items-center gap-1.5 text-mist-400"><Loader2 className="size-3.5 animate-spin" />按目标账号的定位和风格改写中…</span>}
        </div>
      ) : (
        <>
          <Editor ref={editor} value={content.current} resetKey={resetKey} onChange={onChange} editable={!work.locked} />
          <RefsNote refs={refs} className="mt-2" />
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
  const [topics, setTopics] = useState(work.topics.map((t) => '#' + t).join(' '))
  const [title, setTitle] = useState(work.title)
  if (!work.source) return <div className="p-10"><Notice>这篇作品不是派生作品。</Notice></div>
  if (work.content_format === 'comic') {
    return (
      <div className="p-10">
        <Notice>漫画衍生作品在漫画编辑器中核对旁白与对白，不使用段落对照页。
          <button type="button" className="ml-2 cursor-pointer font-medium underline" onClick={() => nav(`/works/${work.id}/edit`)}>打开漫画编辑器</button>
        </Notice>
      </div>
    )
  }
  if (src.isLoading) return <PageLoading />
  const srcWork = src.data
  const srcById = new Map(srcWork?.sections.map((s) => [s.id, s]) ?? [])
  const activeSrc = new Set(work.sections.find((s) => s.id === active)?.source_section_ids ?? [])
  const xhs = work.platform === 'xhs'
  const total = runeLen(work.sections.map((s) => s.content_md).join(''))
  const saveField = async (body: Record<string, unknown>) => {
    try {
      setWork(await patch<Work>(`/works/${work.id}`, body))
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  return (
    <div className="mx-auto w-full max-w-[1480px] px-6 py-6 2xl:max-w-[1680px]">
      <div className="mb-4 grid grid-cols-2 gap-6">
        <div className="flex items-center gap-2 text-[13px] text-mist-500">
          {srcWork && <PlatformMark platform={srcWork.platform} size="sm" />}
          <span className="font-medium text-mist-700">源作品（只读）</span>
          {srcWork && <span className="truncate">{srcWork.account_name} ·《{srcWork.title || '未命名'}》</span>}
        </div>
        <div className="flex items-center gap-2 text-[13px] text-mist-500">
          <PlatformMark platform={work.platform} size="sm" />
          <span className="font-medium text-mist-700">衍生作品（可编辑）</span>
          <span>{work.account_name}</span>
          <Button size="sm" variant="primary" className="ml-auto" onClick={() => nav(xhs ? `/works/${work.id}#step-images` : `/works/${work.id}`)}>
            继续编辑<ArrowRight className="size-3.5" />
          </Button>
        </div>
      </div>
      {!srcWork && <Notice tone="gamboge" className="mb-4">源作品已删除，只能查看和编辑衍生作品。</Notice>}
      <div className="mb-4 grid grid-cols-2 gap-6">
        <Card className="bg-mist-50/60 p-4"><div className="text-xs text-mist-400">标题</div><div className="mt-1 font-display text-[16px] font-bold text-mist-800">{srcWork?.title}</div></Card>
        <Card className="p-4">
          <Field label="标题" counter={{ value: runeLen(title), max: xhs ? 20 : 32 }}>
            <Input value={title} disabled={work.locked} onChange={(e) => setTitle(e.target.value)} onBlur={() => title !== work.title && saveField({ title })} className="font-display font-semibold" />
          </Field>
        </Card>
      </div>
      <div className="space-y-3">
        {work.sections.map((s, i) => {
          const sources = s.source_section_ids.map((id) => srcById.get(id)).filter(Boolean) as Section[]
          const on = active === s.id
          return (
            <div key={s.id} className="grid grid-cols-2 items-start gap-6">
              <div onClick={() => setActive(s.id)}
                className={cn('cursor-pointer rounded-xl border p-4 transition', on || sources.some((x) => activeSrc.has(x.id)) ? 'border-gamboge-300 bg-gamboge-50/50' : 'border-transparent bg-mist-50/70 hover:bg-mist-100/70')}>
                {sources.length === 0 ? <p className="text-[13px] text-mist-400">（对应的源段落已删除）</p> : sources.map((x) => (
                  <div key={x.id}>
                    {x.heading && <div className="mb-1.5 text-[13.5px] font-semibold text-mist-700">{x.heading}</div>}
                    <div className="md text-[14px] leading-[1.85] text-mist-600" dangerouslySetInnerHTML={{ __html: marked.parse(x.content_md, { async: false }) as string }} />
                  </div>
                ))}
              </div>
              <DerivedSection section={s} index={i} work={work} active={on} onFocus={() => setActive(s.id)} patchWork={patchWork} refresh={refresh} />
            </div>
          )
        })}
      </div>
      <div className="sticky bottom-0 z-10 mt-6 -mx-6 border-t border-mist-200 bg-white/95 px-6 py-3 backdrop-blur">
        <div className="flex flex-wrap items-center gap-4">
          {xhs && (
            <div className="flex min-w-[320px] flex-1 items-center gap-2">
              <span className="shrink-0 text-[13px] text-mist-500">话题</span>
              <Input value={topics} disabled={work.locked} onChange={(e) => setTopics(e.target.value)} placeholder="#话题1 #话题2"
                onBlur={() => {
                  const list = parseTopics(topics)
                  if (list.join(' ') !== work.topics.join(' ')) saveField({ topics: list })
                }} />
            </div>
          )}
          <span className="text-[13px] text-mist-500">正文 <span className="font-semibold tabular-nums text-mist-800">{total}</span> 字{xhs && <span className="text-mist-400">（上限待核实 V-012，建议 1000 字以内）</span>}</span>
          <Badge tone={work.source_updated ? 'gamboge' : 'gray'} className="ml-auto">{work.source_updated ? '源稿已更新' : '与源稿同步时间一致'}</Badge>
        </div>
      </div>
    </div>
  )
}
