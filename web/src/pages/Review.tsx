import { DailyStatsCard } from './ops/DailyStats'
import { useQuery } from '@tanstack/react-query'
import { BarChart3, Brain, Check, ClipboardPaste, Lightbulb, Pencil, Plus, Sparkles, Trash2, Upload } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { confirm, Dialog, Drawer } from '@/components/dialog'
import { Badge, Button, Card, CardHeader, cn, Empty, Field, HumanGate, IconButton, Input, PageHeader, PageLoading, Select, StatusBadge, Textarea } from '@/components/ui'
import { aiError } from '@/lib/ai-error'
import { del, errorMessage, get, patch, post, rawRequest } from '@/lib/api'
import { waitJob } from '@/lib/v3'
import { describeRefs, fmtNum, fmtTime, toLocalInput } from '@/lib/format'
import { useCurrentAccount, useInvalidate } from '@/lib/session'
import type { BoardRow, Metric, MetricSource, Platform, ReviewReport } from '@/lib/types'
import { AttributionCard, DigestsCard, TopWorksCard } from './review-insights'

const metricSourceLabel: Record<MetricSource, string> = {
  manual: '手动录入', paste: '粘贴回填', file: '表格导入', wechat_api: '公众号接口', screenshot: '截图识别',
}

const nodeLabel = (m: Pick<Metric, 'day_offset'>) => (m.day_offset == null ? '发布时间未知' : `发布后第 ${m.day_offset} 天`)

function NodeDots({ nodes }: { nodes: number[] }) {
  return (
    <span className="inline-flex items-center gap-1" title="第 1 / 3 / 7 天数据是否已录入">
      {[1, 3, 7].map((n) => (
        <span key={n} className={cn('inline-flex size-[18px] items-center justify-center rounded-full text-[10px] tabular-nums',
          nodes.includes(n) ? 'bg-ink-600 text-white' : 'border border-mist-200 text-mist-400')}>{n}</span>
      ))}
    </span>
  )
}

type ImportPreviewRow = {
  title: string; work_id: string | null; matched: boolean; match_type?: 'exact' | 'fuzzy' | 'none'; similarity?: number
  estimated?: boolean; error?: string
  reads: number | null; likes: number | null; wows?: number | null; favorites?: number | null
  comments?: number | null; shares?: number | null; follows_gained?: number | null
}

const num = (v: number | null | undefined) => (v == null ? '—' : fmtNum(v))

function ImportMetrics({ accountId, works, onDone }: { accountId: string; works: BoardRow[]; onDone: () => void }) {
  const [open, setOpen] = useState(false)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [rows, setRows] = useState<ImportPreviewRow[]>([])
  const [source, setSource] = useState<'paste' | 'file'>('paste')
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const applyPreview = (preview: ImportPreviewRow[], from: 'paste' | 'file') => {
    setRows((preview ?? []).map((r) => ({ ...r, work_id: r.work_id ?? null })))
    setSource(from)
    setOpen(true)
  }
  const upload = async (file: File) => {
    setBusy(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await rawRequest('POST', `/accounts/${accountId}/metrics/import`, fd)
      const data = await res.json() as { preview: ImportPreviewRow[] }
      applyPreview(data.preview ?? [], 'file')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  // DEV-U106（12 文档）：粘贴平台后台复制的表格文本，批量解析并匹配作品。
  const paste = async () => {
    if (!pasteText.trim()) return
    setBusy(true)
    try {
      const data = await post<{ preview: ImportPreviewRow[] }>(`/accounts/${accountId}/metrics/import`, { text: pasteText })
      applyPreview(data.preview ?? [], 'paste')
      setPasteOpen(false)
      setPasteText('')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const confirmImport = async () => {
    const payload = rows.filter((r) => r.work_id).map((r) => ({
      title: r.title, work_id: r.work_id!, reads: r.reads, likes: r.likes, wows: r.wows,
      favorites: r.favorites, comments: r.comments, shares: r.shares, follows_gained: r.follows_gained,
    }))
    if (!payload.length) {
      toast.error('请至少为一行指定作品')
      return
    }
    setBusy(true)
    try {
      const r = await post<{ imported: number }>(`/accounts/${accountId}/metrics/import`, { source, rows: payload })
      toast.success(`已导入 ${r.imported} 行`)
      setOpen(false)
      onDone()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <Button size="sm" variant="secondary" icon={<ClipboardPaste className="size-3.5" />} onClick={() => setPasteOpen(true)}>粘贴回填</Button>
      <Button size="sm" variant="ghost" icon={<Upload className="size-3.5" />} loading={busy && !open && !pasteOpen} onClick={() => input.current?.click()}>导入表格（CSV）</Button>
      <input ref={input} type="file" accept=".csv,text/csv" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) upload(f) }} />
      <Dialog open={pasteOpen} onClose={() => setPasteOpen(false)} title="粘贴数据回填" width="max-w-2xl"
        footer={<><Button variant="ghost" onClick={() => setPasteOpen(false)}>取消</Button><Button variant="primary" loading={busy} disabled={!pasteText.trim()} onClick={paste}>解析并匹配</Button></>}>
        <Field label="表格文本" hint="每行一篇：标题 + 各项数据，用 Tab、竖线或两个以上空格分隔；首行可以是表头（标题/阅读/点赞/在看/收藏/评论/分享/涨粉）。「10万+」按 100000 计入并标注为估计值。">
          <Textarea rows={7} value={pasteText} onChange={(e) => setPasteText(e.target.value)}
            placeholder={'标题\t阅读\t点赞\t在看\t收藏\t评论\t分享\t涨粉\n谈谈内容运营的三个习惯\t1,234\t56\t7\t8\t9\t10\t2'} className="font-mono text-[12.5px]" />
        </Field>
        <p className="text-xs text-mist-400">数据完全来自你粘贴的内容；解析后逐行确认匹配的作品，不会自动访问任何平台。</p>
      </Dialog>
      <Dialog open={open} onClose={() => setOpen(false)} title="确认作品匹配" desc="按标题自动匹配（高相似度为模糊匹配，请确认）；未匹配的行请人工指定作品后再导入。" width="max-w-3xl"
        footer={<><Button variant="ghost" onClick={() => setOpen(false)}>取消</Button><Button variant="primary" loading={busy} onClick={confirmImport}>确认导入</Button></>}>
        <div className="scrollbar-thin max-h-[55vh] space-y-2 overflow-y-auto">
          {rows.map((r, i) => (
            <div key={i} className={cn('rounded-lg border p-3', r.error ? 'border-danger bg-orange-50/60' : 'border-mist-200')}>
              <div className="grid gap-2 sm:grid-cols-[1fr_180px]">
                <div className="min-w-0">
                  <div className="truncate text-[13.5px] font-medium text-mist-800">{r.title}</div>
                  <div className="text-xs text-mist-400">
                    {r.error ? <span className="text-danger">{r.error}</span> : r.match_type === 'exact' ? '已精确匹配'
                      : r.match_type === 'fuzzy' ? `模糊匹配 ${Math.round((r.similarity ?? 0) * 100)}%，请确认` : '未匹配，请选择作品或跳过'}
                  </div>
                </div>
                <Select value={r.work_id ?? ''} onChange={(e) => setRows((list) => list.map((x, j) => j === i ? { ...x, work_id: e.target.value || null, matched: !!e.target.value } : x))}>
                  <option value="">跳过此行</option>
                  {works.map((w) => <option key={w.id} value={w.id}>{w.title || '未命名'}</option>)}
                </Select>
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-mist-500">
                <span>阅读 {num(r.reads)}{r.estimated && r.reads != null && <Badge>≥ 估计</Badge>}</span>
                <span>点赞 {num(r.likes)}</span>
                <span>在看 {num(r.wows)}</span>
                <span>收藏 {num(r.favorites)}</span>
                <span>评论 {num(r.comments)}</span>
                <span>分享 {num(r.shares)}</span>
                <span>涨粉 {num(r.follows_gained)}</span>
              </div>
            </div>
          ))}
        </div>
      </Dialog>
    </>
  )
}

type MetricKey = 'reads' | 'likes' | 'wows' | 'favorites' | 'comments' | 'shares' | 'follows_gained'
const metricFields: Record<Platform, { key: MetricKey; label: string }[]> = {
  wechat_mp: [
    { key: 'reads', label: '阅读' }, { key: 'likes', label: '点赞' }, { key: 'wows', label: '在看' },
    { key: 'shares', label: '分享' }, { key: 'comments', label: '留言' }, { key: 'follows_gained', label: '新增关注' },
  ],
  xhs: [
    { key: 'reads', label: '观看' }, { key: 'likes', label: '点赞' }, { key: 'favorites', label: '收藏' },
    { key: 'comments', label: '评论' }, { key: 'shares', label: '分享' }, { key: 'follows_gained', label: '涨粉' },
  ],
}

const localDay = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000

// 合理性提示（DEV-DR04）：只提醒，不阻止保存。
function metricWarnings(platform: Platform, vals: Record<string, string>, at: string, publishedAt: string | null | undefined, history: Metric[], editingId?: string) {
  const fields = metricFields[platform]
  const val = (k: MetricKey) => (vals[k] === '' || vals[k] == null ? null : Number(vals[k]))
  const out: string[] = []
  const reads = val('reads')
  const readsLabel = fields[0].label
  for (const f of fields) {
    const v = val(f.key)
    if (f.key !== 'reads' && f.key !== 'follows_gained' && reads != null && v != null && v > reads) out.push(`${f.label}比${readsLabel}还多，请确认没有填错格`)
  }
  if (publishedAt && at) {
    const offset = localDay(new Date(at)) - localDay(new Date(publishedAt))
    const prev = history.filter((m) => m.id !== editingId && m.day_offset != null && m.day_offset < offset)
      .sort((a, b) => (b.day_offset ?? 0) - (a.day_offset ?? 0))[0]
    if (prev) {
      for (const f of fields) {
        const v = val(f.key)
        const p = prev[f.key]
        if (f.key !== 'follows_gained' && v != null && p != null && v < p) out.push(`${f.label}比第 ${prev.day_offset} 天的 ${fmtNum(p)} 还少，累计数一般不会变少`)
      }
    }
  }
  return out
}

function MetricForm({ workId, platform, editing, prefill, publishedAt, history, onDone, onNext }: {
  workId: string
  platform: Platform
  editing: Metric | null
  prefill?: Metric | null
  publishedAt?: string | null
  history: Metric[]
  onDone: () => void
  onNext?: () => void
}) {
  const base = editing ?? prefill ?? null
  const [at, setAt] = useState(toLocalInput(editing?.captured_at))
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(metricFields[platform].map((f) => [f.key, base?.[f.key]?.toString() ?? ''])))
  const [note, setNote] = useState(editing?.note ?? '')
  const [busy, setBusy] = useState(false)
  const inputs = useRef<(HTMLInputElement | null)[]>([])
  useEffect(() => { inputs.current[0]?.focus() }, [])
  const warnings = metricWarnings(platform, vals, at, publishedAt, history, editing?.id)
  const save = async (next = false) => {
    const body: Record<string, unknown> = { captured_at: new Date(at).toISOString(), note }
    for (const f of metricFields[platform]) body[f.key] = vals[f.key] === '' ? null : Number(vals[f.key])
    setBusy(true)
    try {
      if (editing) {
        await patch(`/metrics/${editing.id}`, body)
        toast.success('数据已保存')
      } else {
        const res = await post<Metric & { merged: boolean }>(`/works/${workId}/metrics`, body)
        toast.success(res.merged ? `已合并到${nodeLabel(res)}的同一条记录` : '数据已保存')
      }
      if (next && onNext) onNext()
      else onDone()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-4 rounded-xl border border-mist-200 bg-mist-50/50 p-4">
      <Field label="数据采集时间" hint="按发布后第几天记录，例如第 1、3、7 天；同一天再次录入会合并到同一条"><Input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} /></Field>
      {!editing && prefill && <p className="text-[12px] text-mist-500">已预填上次录入的数值，改成平台后台的最新数字即可。</p>}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {metricFields[platform].map((f, i) => (
          <Field key={f.key} label={f.label}>
            <Input ref={(el) => { inputs.current[i] = el }} type="number" min={0} inputMode="numeric" enterKeyHint={i === metricFields[platform].length - 1 ? 'done' : 'next'}
              value={vals[f.key]} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
                e.preventDefault()
                const next = inputs.current[i + 1]
                if (next) next.focus()
                else void save()
              }} />
          </Field>
        ))}
      </div>
      {warnings.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] leading-relaxed text-amber-800">
          {warnings.map((w) => <div key={w}>{w}</div>)}
          <div className="text-amber-700/70">只是提醒，确认无误可以直接保存。</div>
        </div>
      )}
      <Field label="备注"><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="例如：被某大号转载" /></Field>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>取消</Button>
        {onNext && !editing && <Button variant="secondary" loading={busy} onClick={() => save(true)}>保存，录下一篇</Button>}
        <Button variant="primary" loading={busy} onClick={() => save()}>保存</Button>
      </div>
    </div>
  )
}

function MetricsDrawer({ row, platform, node, onClose, onNext }: { row: BoardRow; platform: Platform; node?: number; onClose: () => void; onNext?: () => void }) {
  const { data, refetch } = useQuery({ queryKey: ['metrics', row.id], queryFn: () => get<Metric[]>(`/works/${row.id}/metrics`) })
  const [form, setForm] = useState<{ editing: Metric | null } | null>(node || (data && data.length === 0) ? { editing: null } : null)
  const inv = useInvalidate()
  useEffect(() => {
    if (data && data.length === 0) setForm({ editing: null })
  }, [data])
  const done = () => {
    setForm(null)
    refetch()
    inv(['board'])
  }
  const remove = async (m: Metric) => {
    if (!(await confirm({ title: '删除这条数据？', confirmText: '删除', danger: true }))) return
    await del(`/metrics/${m.id}`)
    done()
  }
  return (
    <Drawer open onClose={onClose} title={row.title || '未命名'} width="w-[560px]"
      desc={node ? `发布满 ${node} 天 · 快速录入：照着平台数据页填数字，回车跳到下一格` : '照着平台数据页抄录数字；也可以用粘贴回填一次补多篇。'}>
      {form ? <MetricForm key={`${row.id}-${form.editing?.id ?? 'new'}-${data?.length ?? 0}`} workId={row.id} platform={platform} editing={form.editing} prefill={data?.[data.length - 1] ?? null}
        publishedAt={row.published_at} history={data ?? []} onDone={done}
        onNext={onNext && (() => { inv(['board']); onNext() })} /> : (
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setForm({ editing: null })}>录入一次数据</Button>
      )}
      <div className="mt-5 space-y-2">
        {data?.map((m) => (
          <div key={m.id} className="group rounded-lg border border-mist-200 p-3">
            <div className="mb-2 flex items-center gap-2">
              <span className="text-[13px] font-medium text-mist-700">{nodeLabel(m)}</span>
              <span className="text-xs text-mist-400">{fmtTime(m.captured_at)}</span>
              <Badge>{metricSourceLabel[m.source] ?? m.source}</Badge>
              <div className="ml-auto flex opacity-0 transition group-hover:opacity-100">
                <IconButton label="编辑" onClick={() => setForm({ editing: m })}><Pencil className="size-3.5" /></IconButton>
                <IconButton label="删除" className="hover:text-danger" onClick={() => remove(m)}><Trash2 className="size-3.5" /></IconButton>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2 text-[13px]">
              {metricFields[platform].map((f) => (
                <div key={f.key}><span className="text-mist-400">{f.label} </span><span className="font-semibold tabular-nums text-mist-800">{num(m[f.key])}</span></div>
              ))}
            </div>
            {m.note && <p className="mt-2 text-xs text-mist-500">{m.note}</p>}
          </div>
        ))}
      </div>
    </Drawer>
  )
}

type UnmatchedRow = { id: string; external_id: string; title: string; ref_date: string; reason: 'none' | 'ambiguous'; days: number; reads: number | null }

// DEV-DR03：接口同步中没对上作品的文章，逐条由人指定或忽略，不自动猜。
function UnmatchedCard({ accountId, works, onDone }: { accountId: string; works: BoardRow[]; onDone: () => void }) {
  const { data, refetch } = useQuery({ queryKey: ['unmatched', accountId], queryFn: () => get<UnmatchedRow[]>(`/accounts/${accountId}/metrics/unmatched`) })
  const [pick, setPick] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  if (!data?.length) return null
  const act = async (row: UnmatchedRow, kind: 'assign' | 'ignore') => {
    setBusy(row.id)
    try {
      if (kind === 'assign') {
        const r = await post<{ written: number }>(`/metrics/unmatched/${row.id}/assign`, { work_id: pick[row.id] })
        toast.success(`已对应到作品，写入 ${r.written} 天数据`)
        onDone()
      } else {
        await post(`/metrics/unmatched/${row.id}/ignore`)
      }
      void refetch()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }
  return (
    <Card className="mb-6">
      <CardHeader title={`待匹配的公众号文章（${data.length}）`} desc="数据接口里有这些文章，但没能确定对应哪篇作品。请逐条指定；不是用本工具写的文章可以忽略，以后同步会跳过。" />
      <div className="divide-y divide-mist-100">
        {data.map((row) => (
          <div key={row.id} className="grid items-center gap-2 px-5 py-3 sm:grid-cols-[1fr_220px_auto]">
            <div className="min-w-0">
              <div className="truncate text-[13.5px] font-medium text-mist-800">{row.title || '（无标题）'}</div>
              <div className="text-xs text-mist-400">
                {row.ref_date} 群发 · {row.reason === 'ambiguous' ? '有多篇同名作品' : '没有找到同名作品'} · {row.days} 天数据{row.reads != null && ` · 阅读 ${fmtNum(row.reads)}`}
              </div>
            </div>
            <Select value={pick[row.id] ?? ''} onChange={(e) => setPick({ ...pick, [row.id]: e.target.value })}>
              <option value="">选择对应的作品</option>
              {works.map((w) => <option key={w.id} value={w.id}>{w.title || '未命名'}{w.published_at ? `（${fmtTime(w.published_at)}）` : ''}</option>)}
            </Select>
            <div className="flex gap-1.5">
              <Button size="sm" variant="primary" disabled={!pick[row.id]} loading={busy === row.id} onClick={() => act(row, 'assign')}>指定</Button>
              <Button size="sm" variant="ghost" disabled={busy === row.id} onClick={() => act(row, 'ignore')}>忽略</Button>
            </div>
          </div>
        ))}
      </div>
    </Card>
  )
}

function ReportCard({ report, onAdopted }: { report: ReviewReport; onAdopted: () => void }) {
  const [busy, setBusy] = useState<number | null>(null)
  const [remembering, setRemembering] = useState<number | null>(null)
  const [remembered, setRemembered] = useState<number[]>(report.remembered ?? [])
  const [ignored, setIgnored] = useState<number[]>(report.ignored ?? [])
  const insights = report.content.writing_insights ?? []
  const ignore = async (i: number) => {
    setIgnored((x) => [...x, i])
    try {
      await post(`/review-reports/${report.id}/insights/${i}/ignore`)
    } catch (e) {
      setIgnored((x) => x.filter((k) => k !== i))
      toast.error(errorMessage(e))
    }
  }
  const remember = async (i: number) => {
    setRemembering(i)
    try {
      await post(`/review-reports/${report.id}/insights/${i}/remember`)
      setRemembered((r) => [...r, i])
      toast.success('已记住，之后生成标题和正文时会参考')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setRemembering(null)
    }
  }
  const adopt = async (i: number) => {
    setBusy(i)
    try {
      await post(`/review-reports/${report.id}/suggestions/${i}/adopt`)
      toast.success('已加入选题池')
      onAdopted()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }
  return (
    <Card>
      <CardHeader title={`复盘报告 · ${fmtTime(report.created_at)}`} desc={`覆盖 ${report.work_ids.length} 篇作品`} />
      <div className="space-y-5 p-5">
        <div>
          <div className="mb-2 text-[13px] font-semibold text-mist-700">结论</div>
          <ul className="space-y-1.5">
            {report.content.conclusions.map((c, i) => (
              <li key={i} className="flex gap-2 text-[14px] leading-relaxed text-mist-700"><span className="mt-2 size-1.5 shrink-0 rounded-full bg-ink-500" />{c}</li>
            ))}
          </ul>
        </div>
        {insights.length > 0 && (
          <div>
            <div className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-mist-700"><Brain className="size-4" />写作层面的结论</div>
            <ul className="space-y-1.5">
              {insights.map((t, i) => ignored.includes(i) ? null : (
                <li key={i} className={cn('flex items-start gap-2 rounded-lg border p-2.5 text-[13.5px]', remembered.includes(i) ? 'border-ink-200 bg-ink-50/40' : 'border-mist-200')}>
                  <span className="flex-1 leading-relaxed text-mist-700">{t}</span>
                  {remembered.includes(i) ? <Badge tone="ink"><Check className="size-3" />已记住</Badge> : (
                    <>
                      <Button size="sm" variant="outline" loading={remembering === i} onClick={() => remember(i)}>记住</Button>
                      <Button size="sm" variant="ghost" onClick={() => ignore(i)}>忽略</Button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div>
          <div className="mb-2 text-[13px] font-semibold text-mist-700">选题建议</div>
          <div className="space-y-2">
            {report.content.topic_suggestions.map((s, i) => {
              const adopted = report.adopted.includes(i)
              return (
                <div key={i} className={cn('flex items-start gap-3 rounded-lg border p-3', adopted ? 'border-ink-200 bg-ink-50/40' : 'border-mist-200')}>
                  <div className="min-w-0 flex-1">
                    <div className="font-display text-[15px] font-semibold text-mist-900">{s.title}</div>
                    <div className="mt-1 text-[13px] text-mist-600"><span className="text-mist-400">角度 · </span>{s.angle}</div>
                    <div className="text-[13px] text-mist-500"><span className="text-mist-400">依据 · </span>{s.reason}</div>
                  </div>
                  {adopted ? <Badge tone="ink"><Check className="size-3" />已采纳</Badge>
                    : <Button size="sm" variant="outline" loading={busy === i} onClick={() => adopt(i)} icon={<Plus className="size-3.5" />}>采纳</Button>}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </Card>
  )
}

export default function Review() {
  const acc = useCurrentAccount()
  const [params, setParams] = useSearchParams()
  const [selected, setSelected] = useState<string[]>([])
  const [recent, setRecent] = useState('10')
  const [running, setRunning] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const inv = useInvalidate()
  const board = useQuery({ queryKey: ['board', acc?.id], queryFn: () => get<BoardRow[]>(`/accounts/${acc!.id}/board`), enabled: !!acc })
  const reports = useQuery({ queryKey: ['reviews', acc?.id], queryFn: () => get<ReviewReport[]>(`/accounts/${acc!.id}/reviews`), enabled: !!acc })
  const wantDigest = params.get('tab') === 'digest'
  const loaded = !!acc && !board.isLoading
  useEffect(() => {
    if (wantDigest && loaded) document.getElementById('digests')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [wantDigest, loaded])
  if (!acc || board.isLoading) return <PageLoading />
  const rows = board.data ?? []
  const openRow = rows.find((r) => r.id === params.get('work'))
  const nextRow = openRow && rows[rows.indexOf(openRow) + 1]
  const fields = metricFields[acc.platform].slice(0, 4)
  const runReview = async () => {
    setRunning(true)
    try {
      const { job_id } = await post<{ job_id: string }>(`/accounts/${acc.id}/reviews`, { ...(selected.length ? { work_ids: selected } : { recent: Number(recent) }), background: true })
      toast.message('AI 正在复盘，可以先去做别的，完成后会通知你')
      await waitJob(job_id)
      void reports.refetch()
      const note = describeRefs({ works: selected.length || Number(recent) })
      toast.success(note ? `复盘报告已生成 · ${note}` : '复盘报告已生成')
    } catch (e) {
      aiError(e, '生成复盘报告', runReview)
    } finally {
      setRunning(false)
    }
  }
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))
  return (
    <div className="animate-fade-in">
      <PageHeader title="数据复盘" desc="手动录入平台数据，让 AI 帮你找规律。复盘建议需要你逐条采纳。" />
      <Card className="mb-6 overflow-hidden">
        <CardHeader title="作品数据看板" desc="只列出已进入草稿箱、已生成发布包或已发布的作品；数字统一取发布后第 7 天的数据，便于作品之间比较"
          action={<>
            {acc.platform === 'wechat_mp' && acc.datacube_state !== 'no_permission' && (
              <Button size="sm" variant="secondary" icon={<BarChart3 className="size-3.5" />} loading={syncing} onClick={async () => {
                setSyncing(true)
                try {
                  const r = await post<{ message: string }>(`/accounts/${acc.id}/metrics/sync-wechat`, {})
                  toast.success(r.message)
                } catch (e) {
                  toast.error(errorMessage(e))
                } finally {
                  setSyncing(false)
                  board.refetch()
                  inv(['board'])
                  inv(['unmatched', acc.id])
                  inv(['accounts'])
                }
              }}>同步公众号数据</Button>
            )}
            <ImportMetrics accountId={acc.id} works={rows} onDone={() => { board.refetch(); inv(['board']) }} />
          </>} />
        {rows.length === 0 ? (
          <Empty icon={<BarChart3 className="size-5" />} title="还没有可以复盘的作品" desc="作品写入草稿箱或生成发布包后会出现在这里。"
            action={<Link to={`/a/${acc.id}/works`}><Button variant="primary">去作品列表</Button></Link>} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13.5px]">
              <thead>
                <tr className="border-b border-mist-100 text-left text-xs text-mist-400">
                  <th className="w-10 py-2.5 pl-5" />
                  <th className="py-2.5 font-medium">作品</th>
                  <th className="py-2.5 font-medium">状态</th>
                  <th className="py-2.5 font-medium">发布时间</th>
                  <th className="py-2.5 font-medium">数据节点</th>
                  {fields.map((f) => <th key={f.key} className="py-2.5 text-right font-medium">{f.label}</th>)}
                  <th className="py-2.5 pr-5 text-right font-medium">记录</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-mist-50 hover:bg-mist-50/60">
                    <td className="py-3 pl-5"><input type="checkbox" className="accent-ink-600" disabled={!r.points} checked={selected.includes(r.id)} onChange={() => toggle(r.id)} title={r.points ? '加入本次复盘' : '先录入数据'} /></td>
                    <td className="max-w-xs py-3"><Link to={`/works/${r.id}`} className="line-clamp-1 font-medium text-mist-800 hover:text-ink-700">{r.title || '未命名'}</Link></td>
                    <td className="py-3"><StatusBadge status={r.status} /></td>
                    <td className="py-3 text-mist-500">{r.published_at ? fmtTime(r.published_at) : '—'}</td>
                    <td className="py-3">
                      <NodeDots nodes={r.nodes ?? []} />
                      {r.d7 && r.d7.day_offset !== 7 && <div className="mt-0.5 text-[11px] text-mist-400">按{r.d7.day_offset == null ? '发布时间未知的' : `第 ${r.d7.day_offset} 天`}数据</div>}
                    </td>
                    {fields.map((f) => <td key={f.key} className="py-3 text-right tabular-nums text-mist-700">{fmtNum(r.d7?.[f.key])}</td>)}
                    <td className="py-3 pr-5 text-right">
                      <Button size="sm" variant={r.points ? 'ghost' : 'outline'} onClick={() => setParams({ work: r.id })}>{r.points ? `${r.points} 次 · 录入` : '录入数据'}</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {acc.platform === 'wechat_mp' && acc.datacube_state === 'no_permission' && (
          <p className="border-t border-mist-100 px-5 py-3 text-xs text-mist-500">当前公众号没有数据统计接口权限（通常需要微信认证），数据请用截图识别、粘贴回填或手动录入。</p>
        )}
      </Card>
      {acc.platform === 'wechat_mp' && <UnmatchedCard accountId={acc.id} works={rows} onDone={() => { board.refetch(); inv(['board']) }} />}

      <div className="grid gap-6 lg:grid-cols-[340px_1fr] 2xl:grid-cols-[380px_1fr]">
        <Card className="h-fit p-5">
          <h3 className="mb-1 font-display text-[16px] font-bold text-mist-900">AI 复盘</h3>
          <p className="mb-4 text-[13px] text-mist-500">在看板中勾选作品，或按最近几篇有数据的作品分析。</p>
          {selected.length > 0 ? (
            <p className="mb-4 rounded-lg bg-ink-50 px-3 py-2 text-[13px] text-ink-800">已选 {selected.length} 篇 <button className="ml-2 cursor-pointer text-xs underline" onClick={() => setSelected([])}>清除</button></p>
          ) : (
            <Field label="分析范围" className="mb-4">
              <Select value={recent} onChange={(e) => setRecent(e.target.value)}>
                {['5', '10', '20'].map((n) => <option key={n} value={n}>最近 {n} 篇有数据的作品</option>)}
              </Select>
            </Field>
          )}
          <Button variant="primary" className="w-full" loading={running} onClick={runReview} icon={<Sparkles className="size-4" />}>生成复盘报告</Button>
          <HumanGate code="H-08" className="mt-4">AI 的选题建议不会自动进入选题池，需要你逐条采纳。</HumanGate>
        </Card>
        <div className="space-y-4">
          {reports.data?.length ? reports.data.map((r) => <ReportCard key={r.id} report={r} onAdopted={() => { reports.refetch(); inv(['topics', acc.id]) }} />)
            : <Card><Empty icon={<Lightbulb className="size-5" />} title="还没有复盘报告" desc="录入几篇作品的数据后，生成第一份复盘报告。"
              action={<Button variant="primary" icon={<Sparkles className="size-4" />} loading={running} onClick={runReview}>生成复盘报告</Button>} /></Card>}
        </div>
      </div>
      <div className="mt-6 space-y-6">
        <DailyStatsCard accountId={acc.id} />
 <AttributionCard accountId={acc.id} />
        <div className="grid gap-6 lg:grid-cols-2">
          <TopWorksCard accountId={acc.id} />
          <div id="digests" className={cn('rounded-xl transition', params.get('tab') === 'digest' && 'ring-2 ring-ink-300')}>
            <DigestsCard accountId={acc.id} />
          </div>
        </div>
      </div>
      {openRow && <MetricsDrawer key={openRow.id} row={openRow} platform={acc.platform} node={Number(params.get('node')) || undefined} onClose={() => setParams({}, { replace: true })}
        onNext={nextRow ? () => setParams({ work: nextRow.id }, { replace: true }) : undefined} />}
    </div>
  )
}
