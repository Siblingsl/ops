import { useQuery } from '@tanstack/react-query'
import { CalendarClock, Check, Copy, Inbox, Library, Link2, Pencil, Plus, Scissors, Search, Tag, Trash2, Wand2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { confirm, Dialog, Drawer } from '@/components/dialog'
import { AIFeedback, sendFeedback } from '@/components/refs'
import { aiError } from '@/lib/ai-error'
import { StarButton } from '@/components/star-button'
import { InboxPanel } from '@/components/inbox-panel'
import { Badge, Button, Card, cn, Empty, Field, IconButton, Input, Notice, PageHeader, PageLoading, Select, StatusBadge, Tabs, Textarea } from '@/components/ui'
import { VoiceButton } from '@/components/voice'
import { errorMessage, get, patch, post } from '@/lib/api'
import { relTime } from '@/lib/format'
import { deleteWithUndo } from '@/lib/undo'
import { useCanWrite, useCurrentAccount, useInvalidate } from '@/lib/session'
import type { AIJob, Material, MaterialPreview, MaterialKind, WorkStatus } from '@/lib/types'

export const kindMeta: Record<MaterialKind, { label: string; desc: string; tone: 'ink' | 'blue' | 'gamboge' | 'green' }> = {
  experience: { label: '经历', desc: '亲身经历、故事、见闻', tone: 'ink' },
  opinion: { label: '观点', desc: '你的判断和主张', tone: 'gamboge' },
  case: { label: '案例', desc: '可引用的他人案例', tone: 'blue' },
  data: { label: '数据', desc: '数字、研究结论（请注明来源）', tone: 'green' },
}

interface Candidate { kind: MaterialKind; content: string; source_hint: string; tags: string[] }
interface TagSuggestion { kind: MaterialKind; tags: string[]; source: 'rule' | 'ai'; ai_call_id?: string }

const runeCount = (s: string) => [...s].length
const materialHeadline = (content: string) => {
  const end = content.search(/[，。！？\n]/u)
  return end < 0 ? content.slice(0, 32) : content.slice(0, end + (content[end] === '\n' ? 0 : 1)).trim()
}
const materialPreview = (content: string) => content.slice(materialHeadline(content).length).trim()
const materialBody = (m: Material, p: Partial<Material> = {}) => {
  const x = { ...m, ...p }
  return { account_id: x.account_id, kind: x.kind, content: x.content, source: x.source, tags: x.tags, valid_until: x.valid_until || null }
}

function MaterialDialog({ open, onClose, accountId, editing }: { open: boolean; onClose: () => void; accountId: string; editing: Material | null }) {
  const [kind, setKind] = useState<MaterialKind>(editing?.kind ?? 'experience')
  const [content, setContent] = useState(editing?.content ?? '')
  const [source, setSource] = useState(editing?.source ?? '')
  const [tags, setTags] = useState(editing?.tags.join(' ') ?? '')
  const [validUntil, setValidUntil] = useState(editing?.valid_until ?? '')
  const [shared, setShared] = useState(editing ? editing.account_id === null : false)
  const [busy, setBusy] = useState(false)
  const [suggesting, setSuggesting] = useState(false)
  const inv = useInvalidate()
  const save = async () => {
    setBusy(true)
    const body = { account_id: shared ? null : accountId, kind, content, source, tags: tags.split(/[\s,，]+/).filter(Boolean), valid_until: validUntil || null }
    try {
      if (editing) await patch(`/materials/${editing.id}`, body)
      else await post('/materials', body)
      inv(['materials'])
      toast.success(editing ? '已保存' : '已加入素材库')
      onClose()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const [sug, setSug] = useState<TagSuggestion | null>(null)
  const tagList = tags.split(/[\s,，]+/).filter(Boolean)
  useEffect(() => {
    if (editing || runeCount(content.trim()) < 8) return
    const timer = window.setTimeout(() => {
      post<TagSuggestion>('/materials/tag-suggest', { content, ai: false }).then((r) => setSug((cur) => (cur?.source === 'ai' ? cur : r)), () => undefined)
    }, 600)
    return () => window.clearTimeout(timer)
  }, [content, editing])
  const suggest = async () => {
    setSuggesting(true)
    try {
      setSug(await post<TagSuggestion>('/materials/tag-suggest', { content }))
    } catch (e) {
      aiError(e, '建议类型与标签', suggest)
    } finally {
      setSuggesting(false)
    }
  }
  const addTag = (t: string) => setTags([...new Set([...tagList, t])].join(' '))
  return (
    <Dialog open={open} onClose={onClose} title={editing ? '编辑素材' : '添加素材'} width="max-w-xl"
      footer={<><Button variant="ghost" onClick={onClose}>取消</Button><Button variant="primary" loading={busy} disabled={!content.trim()} onClick={save}>保存</Button></>}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2">
          {(Object.keys(kindMeta) as MaterialKind[]).map((k) => (
            <button key={k} type="button" onClick={() => setKind(k)}
              className={cn('flex h-full cursor-pointer flex-col rounded-lg border px-2.5 py-2 text-left transition', kind === k ? 'border-ink-400 bg-ink-50 ring-3 ring-ink-100' : 'border-mist-200 hover:border-mist-300')}>
              <div className="text-[13.5px] font-semibold text-mist-800">{kindMeta[k].label}</div>
              <div className="mt-0.5 text-[11px] leading-snug text-mist-500">{kindMeta[k].desc}</div>
            </button>
          ))}
        </div>
        <Field label={<span className="flex items-center justify-between">内容<VoiceButton onText={(t) => setContent((v) => v + t)} /></span>} required>
          <Textarea autoFocus rows={5} value={content} onChange={(e) => setContent(e.target.value)} placeholder="写下具体的事实、经历或观点。AI 起草时只会引用你选中的素材。" />
        </Field>
        <Field label="来源" hint={kind === 'data' ? '数据类素材请写明出处，便于发布前核实' : undefined}><Input value={source} onChange={(e) => setSource(e.target.value)} placeholder="例如：2025 年某某报告第 3 页" /></Field>
        <Field label={<span className="flex items-center justify-between">标签
          <button type="button" disabled={!content.trim() || suggesting} onClick={suggest} className="inline-flex cursor-pointer items-center gap-1 text-[12px] font-normal text-ink-700 hover:underline disabled:opacity-40">
            <Wand2 className="size-3.5" />{suggesting ? '分析中…' : 'AI 建议类型与标签'}
          </button></span>}>
          <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="用空格分隔" />
          {sug && (sug.kind !== kind || sug.tags.some((t) => !tagList.includes(t))) && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[12px]">
              <span className="text-mist-400">建议（点击应用）：</span>
              {sug.kind !== kind && (
                <button type="button" onClick={() => setKind(sug.kind)} className="cursor-pointer rounded-full border border-ink-200 bg-ink-50 px-2 py-0.5 text-ink-700 hover:border-ink-400">类型：{kindMeta[sug.kind].label}</button>
              )}
              {sug.tags.filter((t) => !tagList.includes(t)).map((t) => (
                <button key={t} type="button" onClick={() => addTag(t)} className="cursor-pointer rounded-full border border-mist-200 px-2 py-0.5 text-mist-600 hover:border-ink-300 hover:text-ink-700">+ {t}</button>
              ))}
              {sug.ai_call_id && <AIFeedback callId={sug.ai_call_id} />}
            </div>
          )}
        </Field>
        <Field label="有效期（可选）" hint="例如政策、价格类数据会过时。过期后写作时会提醒你核实，不会自动删除。">
          <Input type="date" value={validUntil ?? ''} onChange={(e) => setValidUntil(e.target.value)} className="w-48" />
        </Field>
        <label className="flex items-center gap-2 text-[13px] text-mist-600"><input type="checkbox" className="accent-ink-600" checked={shared} onChange={(e) => setShared(e.target.checked)} />共享素材（所有账号都能引用）</label>
      </div>
    </Dialog>
  )
}

function ExtractDrawer({ open, onClose, accountId }: { open: boolean; onClose: () => void; accountId: string }) {
  const inv = useInvalidate()
  const [text, setText] = useState('')
  const [items, setItems] = useState<Candidate[]>([])
  const [saved, setSaved] = useState<Record<number, boolean>>({})
  const [dropped, setDropped] = useState<Record<number, boolean>>({})
  const [callId, setCallId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const jobs = useQuery({ queryKey: ['ai-jobs', 'extract'], queryFn: () => get<AIJob[]>('/ai-jobs'), enabled: open, staleTime: 0 })
  const lastJob = (jobs.data ?? []).find((j) => j.task_type === 'material_extract' && j.status === 'done')
  const run = async () => {
    setBusy(true)
    try {
      const r = await post<{ items?: Candidate[]; ai_call_id?: string; job_id?: string }>('/materials/extract', { account_id: accountId, text })
      if (r.job_id) {
        toast.success('文本较长，已转入后台提炼', { description: '完成后会通知你，回到这里即可逐条存入。' })
      } else {
        setItems(r.items ?? [])
        setCallId(r.ai_call_id ?? null)
        setSaved({})
        setDropped({})
      }
    } catch (e) {
      aiError(e, '提炼素材', run)
    } finally {
      setBusy(false)
    }
  }
  const save = async (i: number) => {
    const c = items[i]
    try {
      await post('/materials', { account_id: accountId, kind: c.kind, content: c.content, source: c.source_hint, tags: c.tags })
      setSaved((s) => ({ ...s, [i]: true }))
      inv(['materials'])
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const edit = (i: number, p: Partial<Candidate>) => setItems((l) => l.map((x, k) => (k === i ? { ...x, ...p } : x)))
  return (
    <Drawer open={open} onClose={onClose} title="从长文提炼素材" desc="粘贴你写过的文章、笔记或访谈稿，AI 只摘录原文中有的信息，拆成一条条素材供你逐条存入。" width="w-[600px]">
      <Textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder="粘贴原文（最多 2 万字，超过 6000 字会转入后台处理）" />
      <div className="mt-2 flex items-center gap-2">
        <Button variant="primary" icon={<Scissors className="size-4" />} loading={busy} disabled={!text.trim()} onClick={run}>开始提炼</Button>
        <span className="text-[12px] text-mist-400">{text.length} 字</span>
        {lastJob && items.length === 0 && (
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => {
            const r = lastJob.result as { items?: Candidate[]; ai_call_id?: string } | null
            setItems(r?.items ?? [])
            setCallId(r?.ai_call_id ?? null)
            setSaved({})
            setDropped({})
          }}>载入最近一次后台提炼结果</Button>
        )}
      </div>
      {items.length > 0 && (
        <>
          <Notice className="mt-4">每条都需要你单独确认存入，可以先改内容再存。没有「全部存入」。</Notice>
          {callId && <div className="mt-2"><AIFeedback callId={callId} /></div>}
          <div className="mt-3 space-y-3">
            {items.map((c, i) => dropped[i] ? (
              <div key={i} className="flex items-center gap-2 rounded-xl border border-dashed border-mist-200 px-3 py-2 text-[12.5px] text-mist-400">
                <span className="min-w-0 flex-1 truncate">已丢弃：{c.content}</span>
                <button type="button" className="cursor-pointer text-ink-700 hover:underline" onClick={() => setDropped((d) => ({ ...d, [i]: false }))}>撤销</button>
              </div>
            ) : (
              <div key={i} className={cn('rounded-xl border p-3', saved[i] ? 'border-ink-200 bg-ink-50/40' : 'border-mist-200')}>
                <div className="mb-2 flex items-center gap-2">
                  <Select value={c.kind} disabled={saved[i]} onChange={(e) => edit(i, { kind: e.target.value as MaterialKind })} className="h-7 w-24 text-[12.5px]">
                    {(Object.keys(kindMeta) as MaterialKind[]).map((k) => <option key={k} value={k}>{kindMeta[k].label}</option>)}
                  </Select>
                  <div className="flex flex-wrap gap-1">{c.tags.map((t) => <Badge key={t}>{t}</Badge>)}</div>
                  <div className="ml-auto flex items-center gap-1">
                    {saved[i] ? <Badge tone="ink"><Check className="size-3" />已存入</Badge> : <>
                      <Button size="sm" variant="ghost" onClick={() => setDropped((d) => ({ ...d, [i]: true }))}>丢弃</Button>
                      <Button size="sm" variant="outline" icon={<Plus className="size-3.5" />} onClick={() => save(i)}>存入</Button>
                    </>}
                  </div>
                </div>
                <Textarea rows={3} value={c.content} disabled={saved[i]} onChange={(e) => edit(i, { content: e.target.value })} />
                {c.source_hint && <p className="mt-1 text-[11.5px] text-mist-400">出处线索：{c.source_hint}</p>}
              </div>
            ))}
          </div>
        </>
      )}
    </Drawer>
  )
}

function DuplicatesDrawer({ open, onClose, accountId }: { open: boolean; onClose: () => void; accountId: string }) {
  const inv = useInvalidate()
  const { data, isLoading, refetch } = useQuery({ queryKey: ['material-dups', accountId], queryFn: () => get<Material[][]>(`/materials/duplicates?account_id=${accountId}`), enabled: open })
  const [keep, setKeep] = useState<Record<number, string>>({})
  const merge = async (gi: number, group: Material[]) => {
    const keepId = keep[gi] ?? group[0].id
    if (!(await confirm({ title: '合并这一组素材？', desc: '保留选中的一条，其余移到回收站；引用了被合并素材的作品会改为引用保留的那条。', confirmText: '合并' }))) return
    try {
      await post('/materials/merge', { keep_id: keepId, drop_ids: group.filter((m) => m.id !== keepId).map((m) => m.id) })
      toast.success('已合并')
      inv(['materials'])
      void refetch()
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  return (
    <Drawer open={open} onClose={onClose} title="相似素材" desc="内容高度相似的素材按组列出。每组单独确认合并。" width="w-[600px]">
      {isLoading ? <PageLoading /> : (data ?? []).length === 0 ? <Empty icon={<Copy className="size-5" />} title="没有发现相似素材" /> : (
        <div className="space-y-4">
          {data!.map((g, gi) => (
            <div key={gi} className="rounded-xl border border-mist-200 p-3">
              <div className="space-y-2">
                {g.map((m) => (
                  <label key={m.id} className={cn('flex cursor-pointer gap-2 rounded-lg border p-2 text-[13px]', (keep[gi] ?? g[0].id) === m.id ? 'border-ink-300 bg-ink-50/50' : 'border-mist-100')}>
                    <input type="radio" className="mt-1 accent-ink-600" checked={(keep[gi] ?? g[0].id) === m.id} onChange={() => setKeep((k) => ({ ...k, [gi]: m.id }))} />
                    <span className="min-w-0 flex-1">
                      <span className="line-clamp-3 text-mist-700">{m.content}</span>
                      <span className="mt-0.5 block text-[11.5px] text-mist-400">{kindMeta[m.kind].label} · 被引用 {m.usage_count ?? 0} 次 · {relTime(m.created_at)}</span>
                    </span>
                  </label>
                ))}
              </div>
              <div className="mt-2 flex justify-end"><Button size="sm" variant="outline" onClick={() => merge(gi, g)}>保留选中的，合并这一组</Button></div>
            </div>
          ))}
        </div>
      )}
    </Drawer>
  )
}

/** TagSuggestDrawer (EX-D-02): suggestions for the selected materials are shown one by one; each is accepted separately. */
function TagSuggestDrawer({ items, onClose }: { items: MaterialPreview[]; onClose: () => void }) {
  const inv = useInvalidate()
  const [sugs, setSugs] = useState<Record<string, TagSuggestion | 'error' | 'done' | 'skip'>>({})
  useEffect(() => {
    let alive = true
    void (async () => {
      for (const m of items) {
        if (!alive) return
        try {
          const full = await get<Material>(`/materials/${m.id}`)
          const r = await post<TagSuggestion>('/materials/tag-suggest', { content: full.content })
          if (alive) setSugs((s) => ({ ...s, [m.id]: r }))
        } catch {
          if (alive) setSugs((s) => ({ ...s, [m.id]: 'error' }))
        }
      }
    })()
    return () => { alive = false }
  }, [items])
  const accept = async (m: MaterialPreview, s: TagSuggestion) => {
    try {
      const full = await get<Material>(`/materials/${m.id}`)
      await patch(`/materials/${m.id}`, materialBody(full, { kind: s.kind, tags: [...new Set([...full.tags, ...s.tags])] }))
      setSugs((x) => ({ ...x, [m.id]: 'done' }))
      if (s.ai_call_id) void sendFeedback(s.ai_call_id, { outcome: 'accepted' })
      inv(['materials'])
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const skip = (m: MaterialPreview, s: TagSuggestion) => {
    setSugs((x) => ({ ...x, [m.id]: 'skip' }))
    if (s.ai_call_id) void sendFeedback(s.ai_call_id, { outcome: 'rejected' })
  }
  return (
    <Drawer open onClose={onClose} title={`为 ${items.length} 条素材建议标签`} desc="建议逐条显示，每条单独接受或跳过；没有「全部接受」。" width="w-[560px]">
      <div className="space-y-3">
        {items.map((m) => {
          const s = sugs[m.id]
          return (
            <div key={m.id} className={cn('rounded-xl border p-3', s === 'done' ? 'border-ink-200 bg-ink-50/40' : 'border-mist-200')}>
              <p className="line-clamp-3 text-[13px] text-mist-700">{m.content}</p>
              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[12px]">
                {s === undefined && <span className="text-mist-400">分析中…</span>}
                {s === 'error' && <span className="text-danger">这条没能给出建议，可以稍后再试</span>}
                {s === 'done' && <Badge tone="ink"><Check className="size-3" />已应用</Badge>}
                {s === 'skip' && <span className="text-mist-400">已跳过</span>}
                {typeof s === 'object' && <>
                  <Badge tone={kindMeta[s.kind].tone}>{kindMeta[s.kind].label}</Badge>
                  {s.tags.map((t) => <span key={t} className={cn('rounded px-1.5 py-0.5', m.tags.includes(t) ? 'bg-mist-100 text-mist-400' : 'bg-ink-50 text-ink-700')}>{t}</span>)}
                  <div className="ml-auto flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => skip(m, s)}>跳过</Button>
                    <Button size="sm" variant="outline" icon={<Check className="size-3.5" />} onClick={() => accept(m, s)}>接受</Button>
                  </div>
                </>}
              </div>
            </div>
          )
        })}
      </div>
    </Drawer>
  )
}

function UsagePopover({ m }: { m: Pick<Material, 'id' | 'usage_count'> }) {
  const [open, setOpen] = useState(false)
  const { data } = useQuery({
    queryKey: ['material-usage', m.id],
    queryFn: () => get<{ work_id: string; title: string; status: string; at: string }[]>(`/materials/${m.id}/usage`),
    enabled: open,
  })
  if (!m.usage_count) return <span className="text-mist-400">未被引用</span>
  return (
    <span className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)} className="inline-flex cursor-pointer items-center gap-1 text-ink-700 hover:underline">
        <Link2 className="size-3" />被引用 {m.usage_count} 次
      </button>
      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 w-64 rounded-lg border border-mist-200 bg-white p-1.5 shadow-pop" onMouseLeave={() => setOpen(false)}>
          {(data ?? []).map((u) => (
            <Link key={u.work_id} to={`/works/${u.work_id}`} className="flex items-center gap-2 rounded px-2 py-1.5 text-[12.5px] hover:bg-mist-50">
              <span className="min-w-0 flex-1 truncate text-mist-700">{u.title || '未命名作品'}</span>
              <StatusBadge status={u.status as WorkStatus} />
            </Link>
          ))}
        </div>
      )}
    </span>
  )
}

export default function Materials() {
  const desktopPresentation = document.documentElement.dataset.presentation === 'ops-creative-desktop'
  const acc = useCurrentAccount()
  const canWrite = useCanWrite()
  const [params, setParams] = useSearchParams()
  const scope = (['account', 'shared'].includes(params.get('scope') ?? '') ? params.get('scope') : 'all') as 'all' | 'account' | 'shared'
  const requestedKind = params.get('kind') ?? ''
  const kind = Object.keys(kindMeta).includes(requestedKind) ? requestedKind as MaterialKind : ''
  const usage = (['used', 'unused', 'expired'].includes(params.get('usage') ?? '') ? params.get('usage') : '') as '' | 'used' | 'unused' | 'expired'
  const q = params.get('q') ?? ''
  const [visibleCount, setVisibleCount] = useState(50)
  const [selectedMaterialId, setSelectedMaterialId] = useState<string | null>(null)
  const focusedMaterial = useRef<string | null>(null)
  const updateFilter = (name: string, value: string | null) => {
    const next = new URLSearchParams(params)
    if (value === null) next.delete(name)
    else next.set(name, value)
    focusedMaterial.current = null
    setVisibleCount(50)
    setParams(next, { replace: true })
  }
  const [dialog, setDialog] = useState<{ editing: Material | null } | null>(null)
  const [detail, setDetail] = useState<Material | null>(null)
  const [reading, setReading] = useState(false)
  const [extract, setExtract] = useState(params.get('extract') === '1')
  const [inboxOpen, setInboxOpen] = useState(false)
  const [dups, setDups] = useState(false)
  const tag = params.get('tag')
  const [selecting, setSelecting] = useState(false)
  const [picked, setPicked] = useState<string[]>([])
  const [tagging, setTagging] = useState<MaterialPreview[] | null>(null)
  const focus = params.get('focus')
  const focusRef = useRef<HTMLDivElement>(null)
  const inv = useInvalidate()
  const { data, isLoading } = useQuery({
    queryKey: ['materials', acc?.id, scope, q, usage],
    queryFn: () => get<MaterialPreview[]>(`/materials?account_id=${acc!.id}${scope !== 'all' ? `&scope=${scope}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}${usage ? `&usage=${usage}` : ''}`),
    enabled: !!acc,
  })
  const dupGroups = useQuery({
    queryKey: ['material-dups', acc?.id],
    queryFn: () => get<Material[][]>(`/materials/duplicates?account_id=${acc!.id}`),
    enabled: !!acc,
    staleTime: 5 * 60_000,
  })
  useEffect(() => {
    if (!data?.length) {
      setSelectedMaterialId(null)
      return
    }
    setSelectedMaterialId((current) => current && data.some((m) => m.id === current) ? current : data[0].id)
  }, [data])
  useEffect(() => {
    if (params.get('extract')) {
      const n = new URLSearchParams(params)
      n.delete('extract')
      setParams(n, { replace: true })
    }
  }, [params, setParams])
  useEffect(() => {
    if (!focus || !data) return
    const index = data.filter((m) => (!kind || m.kind === kind) && (tag === null || (tag === '' ? m.tags.length === 0 : m.tags.includes(tag))))
      .findIndex((m) => m.id === focus)
    if (index < 0) return
    if (index >= visibleCount) {
      setVisibleCount(index + 1)
      return
    }
    if (focusedMaterial.current !== focus) {
      focusRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      focusedMaterial.current = focus
    }
  }, [focus, data, kind, tag, visibleCount])
  if (!acc) return <PageLoading />
  const tagCounts = new Map<string, number>()
  for (const m of data ?? []) for (const t of m.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1)
  const cloud = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24)
  const maxCount = cloud[0]?.[1] ?? 1
  const untagged = (data ?? []).filter((m) => m.tags.length === 0).length
  const list = (data ?? []).filter((m) => (!kind || m.kind === kind) && (tag === null || (tag === '' ? m.tags.length === 0 : m.tags.includes(tag))))
  const selectedMaterial = list.find((m) => m.id === selectedMaterialId) ?? list[0] ?? null
  // MT-01：删除前先说明这条素材被哪些作品引用。素材进回收站后引用关系还在，但正文里的事实依据会变成不可见，
  // 所以有引用时必须先让用户看到影响面再决定，而不是一句「已引用它的作品不受影响」。
  const remove = async (m: Pick<Material, 'id' | 'usage_count'>) => {
    let note = '已引用它的作品不受影响。'
    if ((m.usage_count ?? 0) > 0) {
      let used: { work_id: string; title: string; status: string; at: string }[] = []
      try {
        used = await get<{ work_id: string; title: string; status: string; at: string }[]>(`/materials/${m.id}/usage`)
      } catch { /* 取不到引用清单时仍然让用户知道数量，不阻断删除 */ }
      const names = used.slice(0, 5).map((u) => `《${u.title || '未命名作品'}》`).join('、')
      const more = used.length > 5 ? ` 等 ${used.length} 篇` : ''
      const okToDelete = await confirm({
        title: `这条素材正被 ${m.usage_count} 篇作品引用`,
        desc: `${names ? `涉及 ${names}${more}。` : ''}删除后素材进入回收站，作品里的引用会显示为不可见；需要保留事实依据的话，建议先改完正文再删。`,
        confirmText: '仍然删除',
        danger: true,
      })
      if (!okToDelete) return
      note = `有 ${m.usage_count} 篇作品引用了它，请核对正文。`
    }
    await deleteWithUndo('material', m.id, '这条素材', () => inv(['materials']), note)
  }
  const read = async (id: string, edit = false) => {
    setReading(true)
    try {
      const full = await get<Material>(`/materials/${id}`)
      if (edit) setDialog({ editing: full })
      else setDetail(full)
    } catch (e) { toast.error(errorMessage(e)) } finally { setReading(false) }
  }
  const togglePick = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= 10 ? (toast.info('一次最多选 10 条'), p) : [...p, id]))
  const dupCount = dupGroups.data?.length ?? 0
  return (
    <div className={cn('animate-fade-in', desktopPresentation && 'desktop-materials-page')}>
      <PageHeader title="素材库" desc={desktopPresentation ? '保留事实与真实经历，让表达有自己的来处。' : 'AI 只把这里的内容当作事实来源。素材越具体，初稿越像你自己写的。'}
        action={canWrite ? desktopPresentation ? <>
          <Button className="desktop-material-action" icon={<Inbox className="size-4" />} onClick={() => setInboxOpen(true)}>收件箱整理</Button>
          <Button className="desktop-material-action" variant="primary" icon={<Plus className="size-4" />} onClick={() => setDialog({ editing: null })}>添加素材</Button>
        </> : <>
          <Button icon={<Copy className="size-4" />} onClick={() => setDups(true)}>相似素材</Button>
          <Button icon={<Scissors className="size-4" />} onClick={() => setExtract(true)}>从长文提炼</Button>
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setDialog({ editing: null })}>添加素材</Button>
        </> : undefined} />
      {desktopPresentation && <Tabs role="tablist" ariaLabel="素材类型" className="desktop-material-type-tabs"
        value={kind || 'all'} onChange={(value) => updateFilter('kind', value === 'all' ? null : value)}
        items={[{ value: 'all', label: '全部' }, ...Object.entries(kindMeta).map(([value, meta]) => ({ value, label: meta.label }))]} />}
      <div className={cn('mb-5 flex flex-wrap items-center gap-3', desktopPresentation && 'desktop-materials-filterbar')}>
        {!desktopPresentation && <Tabs value={scope} onChange={value => updateFilter('scope', value === 'all' ? null : value)} items={[{ value: 'all', label: '全部' }, { value: 'account', label: '本账号' }, { value: 'shared', label: '共享' }]} />}
        {!desktopPresentation && <Select value={kind} onChange={(e) => updateFilter('kind', e.target.value || null)} className="w-32">
          <option value="">全部类型</option>
          {(Object.keys(kindMeta) as MaterialKind[]).map((k) => <option key={k} value={k}>{kindMeta[k].label}</option>)}
        </Select>}
        {!desktopPresentation && <Select value={usage} onChange={(e) => updateFilter('usage', e.target.value || null)} className="w-36">
          <option value="">引用情况不限</option>
          <option value="unused">从未被引用</option>
          <option value="used">已被引用</option>
          <option value="expired">已过有效期</option>
        </Select>}
        {canWrite && (
          <Button size="sm" variant={selecting ? 'secondary' : 'ghost'} onClick={() => { setSelecting(!selecting); setPicked([]) }}>{selecting ? '退出多选' : '多选'}</Button>
        )}
        <div className={cn('relative w-full sm:ml-auto sm:w-72', desktopPresentation && 'desktop-materials-search')}>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-mist-400" />
          <Input aria-label={desktopPresentation ? '搜索素材' : '搜索素材内容、来源和标签'} value={q} onChange={(e) => updateFilter('q', e.target.value || null)} placeholder={desktopPresentation ? '搜索素材内容与来源' : '搜索内容、来源、标签'} className="pl-9" />
        </div>
        {desktopPresentation ? <Select aria-label="素材范围" className="desktop-material-scope" value={scope === 'all' ? '' : scope} onChange={(e) => updateFilter('scope', e.target.value || null)}>
          <option value="">本账号 + 工作区共享</option>
          <option value="account">本账号</option>
          <option value="shared">工作区共享</option>
        </Select> : null}
      </div>
      {dupCount > 0 && canWrite && (
        <Notice tone="gamboge" icon={<Copy className="size-4" />} className="mb-4">
          发现 {dupCount} 组可能重复的素材。
          <button type="button" className="ml-1 cursor-pointer font-medium underline" onClick={() => setDups(true)}>逐组查看</button>
        </Notice>
      )}
      {!desktopPresentation && (cloud.length > 0 || untagged > 0) && (
        <div className="mb-4 flex flex-wrap items-center gap-1.5">
          <Tag className="size-3.5 text-mist-400" />
          <button type="button" onClick={() => updateFilter('tag', null)} className={cn('cursor-pointer rounded-full px-2.5 py-0.5 text-[12px]', tag === null ? 'bg-ink-600 text-white' : 'bg-mist-100 text-mist-600 hover:bg-mist-200')}>全部标签</button>
          {untagged > 0 && (
            <button type="button" onClick={() => updateFilter('tag', tag === '' ? null : '')} className={cn('cursor-pointer rounded-full px-2.5 py-0.5 text-[12px]', tag === '' ? 'bg-ink-600 text-white' : 'border border-dashed border-mist-300 text-mist-500 hover:border-ink-300')}>未打标签 {untagged}</button>
          )}
          {cloud.map(([t, n]) => (
            <button key={t} type="button" onClick={() => updateFilter('tag', tag === t ? null : t)} style={{ fontSize: `${11.5 + Math.round((n / maxCount) * 3)}px` }}
              className={cn('cursor-pointer rounded-full px-2.5 py-0.5', tag === t ? 'bg-ink-600 text-white' : 'bg-mist-100 text-mist-600 hover:bg-mist-200')}>
              {t}<span className="ml-1 opacity-60">{n}</span>
            </button>
          ))}
        </div>
      )}
      {selecting && (
        <div className={cn('sticky top-16 z-10 mb-4 flex items-center gap-3 rounded-xl border border-ink-200 bg-white/95 px-4 py-2 text-[13px] shadow-sm backdrop-blur', desktopPresentation && 'desktop-materials-pickbar')}>
          <span className="text-mist-600">已选 {picked.length} 条（最多 10 条）</span>
          <Button size="sm" variant="primary" icon={<Wand2 className="size-3.5" />} disabled={picked.length === 0}
            onClick={() => setTagging((data ?? []).filter((m) => picked.includes(m.id)))}>为选中的建议标签</Button>
        </div>
      )}
      {desktopPresentation ? <div className="desktop-materials-layout" data-testid="desktop-materials-layout">
        <section className="desktop-material-list" data-testid="desktop-material-list" aria-label="素材列表">
          {isLoading ? <PageLoading /> : list.length === 0 ? (
            <Empty className="desktop-material-empty" icon={<Library className="size-5" />} title={q || kind || usage || tag !== null ? '没有符合条件的素材' : '素材库还是空的'}
              desc="把你的经历、观点、案例和数据存进来。也可以粘贴过去写的长文，让 AI 拆成一条条素材。"
              action={!q && canWrite && <div className="flex gap-2"><Button icon={<Scissors className="size-4" />} onClick={() => setExtract(true)}>从长文提炼</Button><Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setDialog({ editing: null })}>添加第一条素材</Button></div>} />
          ) : <>
            {list.slice(0, visibleCount).map((m) => {
              const headline = materialHeadline(m.content)
              const preview = materialPreview(m.content)
              return <article key={m.id} ref={m.id === focus ? focusRef : undefined}
                className={cn('desktop-material-row', preview && 'has-preview', selectedMaterial?.id === m.id && 'selected', m.id === focus && 'focused', m.expired && 'expired')}>
                <div className="desktop-material-row-meta">
                  {selecting && <input type="checkbox" aria-label="选择这条素材" className="accent-ink-600" checked={picked.includes(m.id)} onChange={() => togglePick(m.id)} />}
                  <Badge tone={kindMeta[m.kind].tone}>{kindMeta[m.kind].label}</Badge>
                  {desktopPresentation ? <small>{m.shared ? '工作区共享' : acc.name}</small> : <>
                    {m.shared && <Badge>共享</Badge>}
                    {m.expired ? <Badge tone="red"><CalendarClock className="size-3" />已过期</Badge> : m.valid_until && <Badge><CalendarClock className="size-3" />有效至 {m.valid_until}</Badge>}
                    <span>{relTime(m.created_at)}</span>
                    <StarButton type="material" id={m.id} className="ml-auto" />
                  </>}
                </div>
                <button type="button" className="desktop-material-select" aria-pressed={selectedMaterial?.id === m.id} onClick={() => setSelectedMaterialId(m.id)}>
                  <strong>{headline}</strong>
                  {preview && <span>{preview.slice(0, 150)}{preview.length > 150 ? '…' : ''}</span>}
                </button>
                <div className="desktop-material-row-footer">
                  <span>{m.source || '未记录来源'}</span>
                  {!desktopPresentation && <span>{m.usage_count ?? 0} 次引用</span>}
                  <span className="desktop-material-row-actions">
                    <button type="button" onClick={() => void read(m.id, true)} disabled={reading}>{desktopPresentation ? '查看与编辑' : '查看全文'}</button>
                    {canWrite && !desktopPresentation && <IconButton label="编辑" disabled={reading} onClick={() => void read(m.id, true)}><Pencil className="size-3.5" /></IconButton>}
                    {canWrite && !desktopPresentation && <IconButton label="删除" className="hover:text-danger" onClick={() => remove(m)}><Trash2 className="size-3.5" /></IconButton>}
                  </span>
                </div>
                {!desktopPresentation && m.tags.length > 0 && <div className="desktop-material-tags">{m.tags.map((t) => <button key={t} type="button" onClick={() => updateFilter('tag', t)}>{t}</button>)}</div>}
              </article>
            })}
            {list.length > visibleCount && <div className="desktop-material-load-more"><Button variant="outline" onClick={() => setVisibleCount((count) => Math.min(count + 50, list.length))}>加载更多素材</Button></div>}
          </>}
        </section>
        <aside className="desktop-material-details" data-testid="desktop-material-details" aria-label="素材详情">
          {selectedMaterial ? <>
            <div className="desktop-material-eyebrow">素材详情</div>
            <div className="desktop-material-detail-badges"><Badge tone={kindMeta[selectedMaterial.kind].tone}>{kindMeta[selectedMaterial.kind].label}</Badge>{selectedMaterial.shared && <Badge>工作区共享</Badge>}{selectedMaterial.expired && <Badge tone="red">已过期</Badge>}</div>
            <h2>{materialHeadline(selectedMaterial.content)}</h2>
            <p className="desktop-material-detail-content">{selectedMaterial.content}</p>
            <div className="desktop-material-divider" />
            <h3>引用与关联</h3>
            <dl><div><dt>素材来源</dt><dd>{selectedMaterial.source || '未记录'}</dd></div><div><dt>标签</dt><dd>{selectedMaterial.tags.length ? selectedMaterial.tags.join('、') : '暂无标签'}</dd></div><div><dt>引用次数</dt><dd><UsagePopover m={selectedMaterial} /></dd></div><div><dt>最近引用</dt><dd>{selectedMaterial.last_used_at ? relTime(selectedMaterial.last_used_at) : '尚未引用'}</dd></div></dl>
            <p className="desktop-material-detail-hint">素材只会作为事实来源；引用前仍请核对来源和有效期。</p>
            <div className="desktop-material-detail-actions">
              {canWrite && <Button size="sm" onClick={() => void read(selectedMaterial.id, true)} disabled={reading}>编辑这条素材</Button>}
              {canWrite && <Button size="sm" variant="ghost" className="hover:text-danger" onClick={() => remove(selectedMaterial)}>删除这条素材</Button>}
            </div>
          </> : <Empty className="desktop-material-detail-empty" icon={<Library className="size-5" />} title="素材详情" desc="选择一条素材，在这里查看来源、标签与引用情况。" />}
        </aside>
      </div> : isLoading ? <PageLoading /> : list.length === 0 ? (
        <Card><Empty icon={<Library className="size-5" />} title={q || kind || usage || tag !== null ? '没有符合条件的素材' : '素材库还是空的'}
          desc="把你的经历、观点、案例和数据存进来。也可以粘贴过去写的长文，让 AI 拆成一条条素材。"
          action={!q && canWrite && <div className="flex gap-2"><Button icon={<Scissors className="size-4" />} onClick={() => setExtract(true)}>从长文提炼</Button><Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setDialog({ editing: null })}>添加第一条素材</Button></div>} /></Card>
      ) : (
        <div className="columns-1 gap-4 md:columns-2 xl:columns-3 2xl:columns-4">
          {list.slice(0, visibleCount).map((m) => (
            <div key={m.id} ref={m.id === focus ? focusRef : undefined}>
              <Card className={cn('group mb-4 break-inside-avoid p-4', m.id === focus && 'ring-2 ring-ink-300', m.expired && 'border-orange-200')}>
                <div className="mb-2 flex items-center gap-2">
                  {selecting && <input type="checkbox" aria-label="选择这条素材" className="accent-ink-600" checked={picked.includes(m.id)} onChange={() => togglePick(m.id)} />}
                  <Badge tone={kindMeta[m.kind].tone}>{kindMeta[m.kind].label}</Badge>
                  {m.shared && <Badge>共享</Badge>}
                  {m.expired ? <Badge tone="red"><CalendarClock className="size-3" />已过期</Badge> : m.valid_until && <Badge><CalendarClock className="size-3" />有效至 {m.valid_until}</Badge>}
                  <span className="text-xs text-mist-400">{relTime(m.created_at)}</span>
                  <StarButton type="material" id={m.id} className="ml-auto" />
                  {canWrite && (
                    <div className="flex opacity-60 transition group-hover:opacity-100">
                      <IconButton label="编辑" disabled={reading} onClick={() => void read(m.id, true)}><Pencil className="size-3.5" /></IconButton>
                      <IconButton label="删除" className="hover:text-danger" onClick={() => remove(m)}><Trash2 className="size-3.5" /></IconButton>
                    </div>
                  )}
                </div>
                <p className="whitespace-pre-wrap text-[14px] leading-relaxed text-mist-700">{m.content}</p>
                <Button size="sm" variant="ghost" disabled={reading} onClick={() => void read(m.id)}>查看全文</Button>
                <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-mist-100 pt-2.5 text-xs text-mist-400">
                  <UsagePopover m={m} />
                  {m.last_used_at && <span>· 最近 {relTime(m.last_used_at)}</span>}
                  {m.source && <span className="ml-1">来源：{m.source}</span>}
                  {m.tags.map((t) => <button key={t} type="button" onClick={() => updateFilter('tag', t)} className="cursor-pointer rounded bg-mist-100 px-1.5 py-0.5 text-mist-500 hover:bg-mist-200">{t}</button>)}
                </div>
              </Card>
            </div>
          ))}
        </div>
      )}
      {!desktopPresentation && !isLoading && list.length > visibleCount && (
        <div className="mt-5 flex justify-center">
          <Button variant="outline" onClick={() => setVisibleCount((count) => Math.min(count + 50, list.length))}>加载更多素材</Button>
        </div>
      )}
      {inboxOpen && <Drawer open onClose={() => setInboxOpen(false)} title="从收件箱整理" desc="逐条确认灵感，可选择转为选题或存为素材。">
        <InboxPanel accountId={acc.id} />
      </Drawer>}
      {dialog && <MaterialDialog open onClose={() => setDialog(null)} accountId={acc.id} editing={dialog.editing} />}
      <Drawer open={!!detail} onClose={() => setDetail(null)} title="素材全文">
        <p className="whitespace-pre-wrap">{detail?.content}</p>
      </Drawer>
      <ExtractDrawer open={extract} onClose={() => setExtract(false)} accountId={acc.id} />
      <DuplicatesDrawer open={dups} onClose={() => { setDups(false); void dupGroups.refetch() }} accountId={acc.id} />
      {tagging && <TagSuggestDrawer items={tagging} onClose={() => { setTagging(null); setPicked([]) }} />}
    </div>
  )
}
