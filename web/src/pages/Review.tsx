import { useQuery } from '@tanstack/react-query'
import { BarChart3, Check, Lightbulb, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { confirm, Drawer } from '@/components/dialog'
import { Badge, Button, Card, CardHeader, cn, Empty, Field, HumanGate, IconButton, Input, PageHeader, PageLoading, Select, StatusBadge, Textarea } from '@/components/ui'
import { del, errorMessage, get, patch, post } from '@/lib/api'
import { describeRefs, fmtNum, fmtTime, toLocalInput } from '@/lib/format'
import { useCurrentAccount, useInvalidate } from '@/lib/session'
import type { BoardRow, Metric, Platform, ReviewReport } from '@/lib/types'

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

function MetricForm({ workId, platform, editing, onDone }: { workId: string; platform: Platform; editing: Metric | null; onDone: () => void }) {
  const [at, setAt] = useState(toLocalInput(editing?.captured_at))
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(metricFields[platform].map((f) => [f.key, editing?.[f.key]?.toString() ?? ''])))
  const [note, setNote] = useState(editing?.note ?? '')
  const [busy, setBusy] = useState(false)
  const save = async () => {
    const body: Record<string, unknown> = { captured_at: new Date(at).toISOString(), note }
    for (const f of metricFields[platform]) body[f.key] = vals[f.key] === '' ? null : Number(vals[f.key])
    setBusy(true)
    try {
      if (editing) await patch(`/metrics/${editing.id}`, body)
      else await post(`/works/${workId}/metrics`, body)
      toast.success('数据已保存')
      onDone()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-4 rounded-xl border border-mist-200 bg-mist-50/50 p-4">
      <Field label="数据采集时间" hint="同一篇作品可以录入多次，例如发布后 1 天、7 天"><Input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} /></Field>
      <div className="grid grid-cols-3 gap-3">
        {metricFields[platform].map((f) => (
          <Field key={f.key} label={f.label}>
            <Input type="number" min={0} inputMode="numeric" value={vals[f.key]} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} />
          </Field>
        ))}
      </div>
      <Field label="备注"><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="例如：被某大号转载" /></Field>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>取消</Button>
        <Button variant="primary" loading={busy} onClick={save}>保存</Button>
      </div>
    </div>
  )
}

function MetricsDrawer({ row, platform, onClose }: { row: BoardRow; platform: Platform; onClose: () => void }) {
  const { data, refetch } = useQuery({ queryKey: ['metrics', row.id], queryFn: () => get<Metric[]>(`/works/${row.id}/metrics`) })
  const [form, setForm] = useState<{ editing: Metric | null } | null>(data && data.length === 0 ? { editing: null } : null)
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
    <Drawer open onClose={onClose} title={row.title || '未命名'} desc="数据需要你从平台后台手动抄录。" width="w-[560px]">
      {form ? <MetricForm workId={row.id} platform={platform} editing={form.editing} onDone={done} /> : (
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setForm({ editing: null })}>录入一次数据</Button>
      )}
      <div className="mt-5 space-y-2">
        {data?.map((m) => (
          <div key={m.id} className="group rounded-lg border border-mist-200 p-3">
            <div className="mb-2 flex items-center gap-2">
              <span className="text-[13px] font-medium text-mist-700">{fmtTime(m.captured_at)}</span>
              <div className="ml-auto flex opacity-0 transition group-hover:opacity-100">
                <IconButton label="编辑" onClick={() => setForm({ editing: m })}><Pencil className="size-3.5" /></IconButton>
                <IconButton label="删除" className="hover:text-danger" onClick={() => remove(m)}><Trash2 className="size-3.5" /></IconButton>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2 text-[13px]">
              {metricFields[platform].map((f) => (
                <div key={f.key}><span className="text-mist-400">{f.label} </span><span className="font-semibold tabular-nums text-mist-800">{fmtNum(m[f.key])}</span></div>
              ))}
            </div>
            {m.note && <p className="mt-2 text-xs text-mist-500">{m.note}</p>}
          </div>
        ))}
      </div>
    </Drawer>
  )
}

function ReportCard({ report, onAdopted }: { report: ReviewReport; onAdopted: () => void }) {
  const [busy, setBusy] = useState<number | null>(null)
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
  const inv = useInvalidate()
  const board = useQuery({ queryKey: ['board', acc?.id], queryFn: () => get<BoardRow[]>(`/accounts/${acc!.id}/board`), enabled: !!acc })
  const reports = useQuery({ queryKey: ['reviews', acc?.id], queryFn: () => get<ReviewReport[]>(`/accounts/${acc!.id}/reviews`), enabled: !!acc })
  if (!acc || board.isLoading) return <PageLoading />
  const rows = board.data ?? []
  const openRow = rows.find((r) => r.id === params.get('work'))
  const fields = metricFields[acc.platform].slice(0, 4)
  const runReview = async () => {
    setRunning(true)
    try {
      await post(`/accounts/${acc.id}/reviews`, selected.length ? { work_ids: selected } : { recent: Number(recent) })
      reports.refetch()
      const note = describeRefs({ works: selected.length || Number(recent) })
      toast.success(note ? `复盘报告已生成 · ${note}` : '复盘报告已生成')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setRunning(false)
    }
  }
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))
  return (
    <div className="animate-fade-in">
      <PageHeader title="数据复盘" desc="手动录入平台数据，让 AI 帮你找规律。复盘建议需要你逐条采纳。" />
      <Card className="mb-6 overflow-hidden">
        <CardHeader title="作品数据看板" desc="只列出已进入草稿箱、已生成发布包或已发布的作品" />
        {rows.length === 0 ? (
          <Empty icon={<BarChart3 className="size-5" />} title="还没有可以复盘的作品" desc="作品写入草稿箱或生成发布包后会出现在这里。" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13.5px]">
              <thead>
                <tr className="border-b border-mist-100 text-left text-xs text-mist-400">
                  <th className="w-10 py-2.5 pl-5" />
                  <th className="py-2.5 font-medium">作品</th>
                  <th className="py-2.5 font-medium">状态</th>
                  <th className="py-2.5 font-medium">发布时间</th>
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
                    {fields.map((f) => <td key={f.key} className="py-3 text-right tabular-nums text-mist-700">{fmtNum(r.latest?.[f.key])}</td>)}
                    <td className="py-3 pr-5 text-right">
                      <Button size="sm" variant={r.points ? 'ghost' : 'outline'} onClick={() => setParams({ work: r.id })}>{r.points ? `${r.points} 次 · 录入` : '录入数据'}</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

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
            : <Card><Empty icon={<Lightbulb className="size-5" />} title="还没有复盘报告" desc="录入几篇作品的数据后，生成第一份复盘报告。" /></Card>}
        </div>
      </div>
      {openRow && <MetricsDrawer row={openRow} platform={acc.platform} onClose={() => setParams({}, { replace: true })} />}
    </div>
  )
}
