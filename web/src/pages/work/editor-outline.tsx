import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Check, Plus, Sparkles, Stethoscope, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { confirm, Dialog } from '@/components/dialog'
import { RefsNote } from '@/components/refs'
import { Badge, Button, Card, cn, formatBriefHint, HumanGate, IconButton, Input, Select, Textarea } from '@/components/ui'
import { aiError } from '@/lib/ai-error'
import { ApiError, errorMessage, get, post, put } from '@/lib/api'
import { type AIRefs, runeLen } from '@/lib/format'
import type { OutlineItem, OutlineTemplate, Work } from '@/lib/types'
import { WorkConflictDialog } from './section-save-dialogs'
import { useFlushAll } from './work-save'

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

export function OutlineCard({ work, setWork, readOnly, onConfirmed }: { work: Work; setWork: (w: Work) => void; readOnly: boolean; onConfirmed?: () => void }) {
  const [conflict, setConflict] = useState<{ server: Work; confirm: boolean } | null>(null)
  const flushAll = useFlushAll()
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
      // NW-C3：观点可能还在 800ms 防抖里，先落库再让服务端读取。
      await flushAll()
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
  const save = async (confirmIt: boolean, base = work.revision) => {
    setBusy(confirmIt ? 'confirm' : 'save')
    try {
      // NW-C2：确认大纲同样受 H-02 约束。先把观点落库，服务端才能校验；失败则保留大纲不确认。
      if (confirmIt) await flushAll()
      const w = await put<Work>(`/works/${work.id}/outline`, { items, confirm: confirmIt, base_revision: base })
      setConflict(null)
      setWork(w)
      if (confirmIt) {
        setEditing(false)
        toast.success('大纲已确认，可以逐段起草了')
        onConfirmed?.()
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'version_conflict') setConflict({ server: (e.detail as { server: Work }).server, confirm: confirmIt })
      else toast.error(errorMessage(e))
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
      {noViewpoint && !confirmed && <HumanGate code="H-02" className="mb-3">先写下你的核心观点，才能生成或确认大纲。</HumanGate>}
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
              <Button size="sm" variant="human" loading={busy === 'confirm'} disabled={!items.some((x) => x.heading.trim()) || noViewpoint || readOnly} onClick={() => save(true)} icon={<Check className="size-3.5" />}
                title={noViewpoint ? '请先写下核心观点（H-02）' : undefined}>
                确认大纲
              </Button>
            </div>
          </div>
          {confirmed && <p className="mt-2 text-xs text-mist-400">重新确认后，修改过的大纲项会更新对应段落的小标题和要点，新增的大纲项会生成空段落。</p>}
        </>
      )}
      <WorkConflictDialog server={conflict?.server ?? null} mine={{ ...work, outline: items }} onClose={() => setConflict(null)} onResolve={keepMine => {
        if (!conflict) return
        if (keepMine) void save(conflict.confirm, conflict.server.revision)
        else { setWork(conflict.server); setConflict(null) }
      }} />
    </Card>
  )
}
