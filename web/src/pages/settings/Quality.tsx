import { useQuery } from '@tanstack/react-query'
import { ClipboardList, FlaskConical, Plus, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { Badge, Button, Card, CardHeader, cn, Empty, Field, PageHeader, PageLoading, Select, Tabs, Textarea } from '@/components/ui'
import { confirm } from '@/components/dialog'
import { del, errorMessage, get, patch, post } from '@/lib/api'
import { relTime } from '@/lib/format'
import { useMe } from '@/lib/session'
import { waitJob } from '@/lib/v3'
import type { EvalCase, EvalRun } from '@/lib/types'

// DEV-U107（12 文档）：提示词用例按当前模型与模板批量重放，输出 JSON 合规率与逐条结果。
interface BatchTaskSummary { task_type: string; cases: number; json_ok: number; failed: number; avg_chars: number }
interface BatchCaseRow {
  case_id: string; name: string; task_type: string; ok: boolean; json_ok: boolean | null
  chars: number; latency_ms: number; error: string; output: string
}
interface BatchResult { tasks: BatchTaskSummary[]; rows: BatchCaseRow[] }

function BatchReplay({ cases, label }: { cases: EvalCase[]; label: (t: string) => string }) {
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<BatchResult | null>(null)
  const counts = useMemo(() => {
    const m: Record<string, number> = {}
    for (const c of cases) m[c.task_type] = (m[c.task_type] ?? 0) + 1
    return m
  }, [cases])
  const toggle = (t: string) => setSelected((list) => (list.includes(t) ? list.filter((x) => x !== t) : [...list, t]))
  const start = async () => {
    setBusy(true)
    try {
      const r = await post<{ job_id: string; total: number }>('/prompt-eval/batch', { task_types: selected })
      const res = await waitJob<BatchResult>(r.job_id)
      setResult(res)
      toast.success(`批量重放完成：${res.rows.length} 条用例`)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const types = Object.keys(counts).sort()
  return (
    <Card className="p-5">
      <CardHeader title="批量重放（当前模型）" desc="把保存的用例用当前模型与模板逐条重跑，检验真实输出质量与 JSON 合规率。调用计入 AI 用量（标记为对比测试）；不会自动修改提示词。"
        action={<Button size="sm" variant="primary" icon={<ClipboardList className="size-4" />} loading={busy} disabled={!types.length} onClick={start}>开始重放</Button>} />
      {types.length === 0 ? <p className="text-[13px] text-mist-400">还没有测试用例。先在左侧保存用例。</p> : (
        <div className="flex flex-wrap gap-2">
          {types.map((t) => (
            <button key={t} type="button" onClick={() => toggle(t)}
              className={cn('cursor-pointer rounded-full px-3 py-1 text-[12.5px] transition',
                selected.includes(t) ? 'bg-ink-600 text-white' : 'bg-mist-100 text-mist-600 hover:bg-mist-200')}>
              {label(t)} · {counts[t]}
            </button>
          ))}
          {!selected.length && <span className="self-center text-[12px] text-mist-400">不勾选则重放全部任务类型</span>}
        </div>
      )}
      {result && (
        <div className="mt-4 space-y-3">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {result.tasks.map((t) => (
              <div key={t.task_type} className="rounded-lg border border-mist-100 bg-mist-50/60 p-3 text-[12.5px]">
                <div className="font-semibold text-mist-800">{label(t.task_type)}</div>
                <div className="mt-1 text-mist-500">
                  {t.cases} 条 · JSON 合规 {t.json_ok}/{t.cases - t.failed} · 失败 {t.failed} · 平均 {t.avg_chars} 字
                </div>
              </div>
            ))}
          </div>
          <div className="scrollbar-thin max-h-80 divide-y divide-mist-100 overflow-y-auto rounded-lg border border-mist-100">
            {result.rows.map((r) => (
              <div key={r.case_id} className="px-3 py-2.5 text-[12.5px]">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium text-mist-800">{r.name}</span>
                  <Badge tone={r.ok ? 'green' : 'red'}>{r.ok ? '成功' : '失败'}</Badge>
                  {r.json_ok != null && <Badge tone={r.json_ok ? 'green' : 'red'}>{r.json_ok ? 'JSON 合规' : 'JSON 不合规'}</Badge>}
                  <span className="ml-auto font-mono text-[11px] text-mist-400">{r.chars} 字 · {r.latency_ms}ms</span>
                </div>
                {r.error && <p className="mt-0.5 text-danger">{r.error}</p>}
                <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap text-mist-500">{r.output}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  )
}

interface TaskRow {
  task_type: string
  label: string
  calls: number
  with_feedback: number
  adopted: number
  regenerated: number
  thumbs_down: number
  avg_edit_ratio: number | null
  adoption_rate: number | null
  retry_rate: number | null
  down_reasons: Record<string, number>
  fallback_calls: number
}
interface Metrics {
  first_accept_rate: number | null
  retry_rate: number | null
  avg_edit_ratio: number | null
  first_draft_hours: number | null
  first_draft_works: number
  section_ai_calls: number
  feedback_samples: number
}
interface Board { days: number; tasks: TaskRow[]; trend: { week: string; calls: number; adoption_rate: number | null }[]; avg_pending_per_work: number; ux_events: Record<string, number>; metrics: Metrics }

const hours = (h: number | null) => (h == null ? '—' : h < 1 ? `${Math.round(h * 60)} 分钟` : h < 48 ? `${h.toFixed(1)} 小时` : `${(h / 24).toFixed(1)} 天`)

function MetricCards({ m, pending }: { m: Metrics; pending: number }) {
  const items = [
    { label: '首次采纳率', value: pct(m.first_accept_rate), def: `AI 结果被直接采用（没有重新生成）的次数 / 有反馈的次数 · 样本 ${m.feedback_samples}` },
    { label: '重试率', value: pct(m.retry_rate), def: `同一段落 5 分钟内重复起草或改写的调用 / 全部段落起草与改写调用 · 样本 ${m.section_ai_calls}` },
    { label: '人工修改比例', value: pct(m.avg_edit_ratio), def: '改后采纳时，最终正文相对 AI 结果的平均改动比例' },
    { label: '待核实密度', value: pending.toFixed(1), def: '近期更新过的作品平均每篇仍有的「待核实」数量' },
    { label: '从选题到首稿', value: hours(m.first_draft_hours), def: `作品创建到所有段落第一次都有内容的时间（中位数）· 样本 ${m.first_draft_works} 篇` },
  ]
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      {items.map((x) => (
        <Card key={x.label} className="p-4">
          <div className="text-xs text-mist-500">{x.label}</div>
          <div className="mt-1 font-display text-[24px] font-bold tabular-nums text-mist-900">{x.value}</div>
          <div className="mt-1.5 text-[11.5px] leading-snug text-mist-400">{x.def}</div>
        </Card>
      ))}
    </div>
  )
}
interface CallRow { id: string; at: string; model: string; latency_ms: number; tokens: number; outcome: string; rating: number | null; reasons: string[]; note: string; edit_ratio: number | null; account: string }

const pct = (v: number | null) => (v == null ? '—' : `${Math.round(v * 100)}%`)
const outcomeLabel: Record<string, string> = { accepted: '直接采纳', edited: '改后采纳', regenerated: '重新生成', rejected: '放弃', '': '无反馈' }

export function QualityBoard() {
  const [days, setDays] = useState('30')
  const [drill, setDrill] = useState<string | null>(null)
  const [trendTask, setTrendTask] = useState('')
  const { data, isLoading } = useQuery({ queryKey: ['quality', days, trendTask], queryFn: () => get<Board>(`/quality?days=${days}&task_type=${trendTask}`), placeholderData: (prev) => prev })
  const calls = useQuery({ queryKey: ['quality-calls', drill], queryFn: () => get<CallRow[]>(`/quality/calls?task_type=${drill}`), enabled: !!drill })
  if (isLoading || !data) return <PageLoading />
  const maxCalls = Math.max(1, ...data.trend.map((t) => t.calls))
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Tabs value={days} onChange={setDays} items={[{ value: '7', label: '近 7 天' }, { value: '30', label: '近 30 天' }, { value: '90', label: '近 90 天' }]} />
        <span className="text-[12.5px] text-mist-500">提示词对比测试的调用不计入这里的统计</span>
      </div>
      {data.metrics && <MetricCards m={data.metrics} pending={data.avg_pending_per_work} />}
      <Card>
        <CardHeader title="各任务效果" desc="采纳率 = 直接采纳或改后采纳 / 有反馈的次数；改动比例越低说明生成结果越接近你最终想要的。点一行查看最近调用。" />
        {data.tasks.length === 0 ? <Empty title="这段时间还没有 AI 调用" /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="bg-mist-50/60 text-left text-[11.5px] text-mist-500">
                <tr>
                  <th className="px-5 py-2 font-medium">任务</th><th className="px-3 py-2 font-medium">调用</th><th className="px-3 py-2 font-medium">采纳率</th>
                  <th className="px-3 py-2 font-medium">重来率</th><th className="px-3 py-2 font-medium">平均改动</th><th className="px-3 py-2 font-medium">👎</th>
                  <th className="px-3 py-2 font-medium">备用模型</th><th className="px-3 py-2 font-medium">主要原因</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-mist-100">
                {data.tasks.map((t) => (
                  <tr key={t.task_type} onClick={() => setDrill(drill === t.task_type ? null : t.task_type)}
                    className={cn('cursor-pointer hover:bg-mist-50', drill === t.task_type && 'bg-ink-50/50')}>
                    <td className="px-5 py-2.5 font-medium text-mist-800">{t.label}</td>
                    <td className="px-3 py-2.5 tabular-nums">{t.calls}</td>
                    <td className="px-3 py-2.5 tabular-nums">{pct(t.adoption_rate)}</td>
                    <td className="px-3 py-2.5 tabular-nums">{pct(t.retry_rate)}</td>
                    <td className="px-3 py-2.5 tabular-nums">{pct(t.avg_edit_ratio)}</td>
                    <td className="px-3 py-2.5 tabular-nums">{t.thumbs_down}</td>
                    <td className="px-3 py-2.5 tabular-nums">{t.fallback_calls || '—'}</td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap gap-1">
                        {Object.entries(t.down_reasons).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => <Badge key={k}>{k} {n}</Badge>)}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {drill && (
        <Card>
          <CardHeader title="最近调用" desc="反馈只保存结果和原因标签，不保存正文。" />
          <ul className="divide-y divide-mist-100 text-[12.5px]">
            {(calls.data ?? []).map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-2">
                <span className="w-20 text-mist-400">{relTime(c.at)}</span>
                <span className="w-28 truncate text-mist-600">{c.account || '—'}</span>
                <span className="w-44 truncate font-mono text-[11.5px] text-mist-500">{c.model}</span>
                <span className="tabular-nums text-mist-500">{c.tokens} token · {(c.latency_ms / 1000).toFixed(1)}s</span>
                <Badge tone={c.outcome === 'accepted' || c.outcome === 'edited' ? 'green' : c.outcome ? 'gamboge' : 'gray'}>{outcomeLabel[c.outcome] ?? c.outcome}</Badge>
                {c.rating === -1 && <Badge tone="red">👎 {c.reasons.join('、')}</Badge>}
                {c.edit_ratio != null && <span className="text-mist-400">改动 {pct(c.edit_ratio)}</span>}
              </li>
            ))}
          </ul>
        </Card>
      )}
      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="p-5">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="text-[14px] font-semibold text-mist-900">每周趋势</h3>
            <Select value={trendTask} onChange={(e) => setTrendTask(e.target.value)} className="h-8 w-40 text-[12.5px]">
              <option value="">全部任务</option>
              {data.tasks.map((t) => <option key={t.task_type} value={t.task_type}>{t.label}</option>)}
            </Select>
          </div>
          <div className="flex h-40 items-end gap-2">
            {data.trend.map((t) => (
              <div key={t.week} className="flex flex-1 flex-col items-center gap-1" title={`${t.week}：${t.calls} 次，采纳率 ${pct(t.adoption_rate)}`}>
                <span className="text-[10.5px] tabular-nums text-mist-500">{pct(t.adoption_rate)}</span>
                <div className="w-full rounded-t bg-ink-400" style={{ height: `${(t.calls / maxCalls) * 110}px` }} />
                <span className="text-[10px] text-mist-400">{t.week.slice(5)}</span>
              </div>
            ))}
          </div>
        </Card>
        <Card className="p-5">
          <h3 className="mb-1 text-[14px] font-semibold text-mist-900">体验事件</h3>
          <p className="mb-3 text-[12px] text-mist-500">只统计在「偏好设置」里主动开启记录的成员；只有事件名，没有内容。</p>
          {Object.keys(data.ux_events).length === 0 ? <p className="text-[12.5px] text-mist-400">暂无数据</p> : (
            <ul className="space-y-1 text-[12.5px]">
              {Object.entries(data.ux_events).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, n]) => (
                <li key={k} className="flex justify-between"><span className="font-mono text-mist-600">{k}</span><span className="tabular-nums text-mist-500">{n}</span></li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  )
}

export function PromptEval({ initialTask = '', candidate }: { initialTask?: string; candidate?: string }) {
  const { data: me } = useMe()
  const owner = me?.role === 'owner'
  const tpls = useQuery({ queryKey: ['prompt-templates'], queryFn: () => get<{ task_type: string; label: string; content: string }[]>('/prompt-templates') })
  const cases = useQuery({ queryKey: ['eval-cases'], queryFn: () => get<EvalCase[]>('/prompt-eval/cases') })
  const [task, setTask] = useState(initialTask)
  const [sel, setSel] = useState<EvalCase | null>(null)
  const [tplB, setTplB] = useState('')
  const [busy, setBusy] = useState(false)
  const runs = useQuery({ queryKey: ['eval-runs', sel?.id], queryFn: () => get<EvalRun[]>(`/prompt-eval/cases/${sel!.id}/runs`), enabled: !!sel })
  const label = (t: string) => tpls.data?.find((x) => x.task_type === t)?.label ?? t
  const addCase = async () => {
    try {
      await post('/prompt-eval/cases', { task_type: task || tpls.data?.[0]?.task_type })
      toast.success('已把最近一次调用的上下文保存为测试用例')
      void cases.refetch()
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const run = async () => {
    if (!sel) return
    setBusy(true)
    try {
      await post('/prompt-eval/runs', { case_id: sel.id, template_b: tplB })
      void runs.refetch()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const verdict = async (r: EvalRun, v: NonNullable<EvalRun['verdict']>) => {
    await patch(`/prompt-eval/runs/${r.id}`, { verdict: v }).catch((e) => toast.error(errorMessage(e)))
    void runs.refetch()
  }
  return (
    <div className="grid gap-5 lg:grid-cols-[320px_1fr]">
      <Card className="p-4">
        <p className="mb-3 text-[12.5px] leading-relaxed text-mist-500">改提示词前，先把真实的调用上下文存成测试用例，再用新旧两版各跑一次，人工对比哪版更好。</p>
        {owner && (
          <div className="mb-4 flex gap-2">
            <Select value={task} onChange={(e) => setTask(e.target.value)} className="min-w-0 flex-1">
              {(tpls.data ?? []).map((t) => <option key={t.task_type} value={t.task_type}>{t.label}</option>)}
            </Select>
            <Button icon={<Plus className="size-4" />} onClick={addCase}>保存用例</Button>
          </div>
        )}
        {(cases.data ?? []).length === 0 ? <p className="py-6 text-center text-[12.5px] text-mist-400">还没有测试用例</p> : (
          <ul className="space-y-1">
            {cases.data!.map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => { setSel(c); setTplB(candidate && c.task_type === initialTask ? candidate : tpls.data?.find((x) => x.task_type === c.task_type)?.content ?? '') }}
                  className={cn('flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px]', sel?.id === c.id ? 'bg-ink-50 text-ink-800' : 'hover:bg-mist-50')}>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{c.name}</span>
                    <span className="text-[11.5px] text-mist-400">{label(c.task_type)} · {relTime(c.created_at)}</span>
                  </span>
                  {owner && (
                    <Trash2 className="size-3.5 shrink-0 text-mist-300 hover:text-danger" onClick={async (e) => {
                      e.stopPropagation()
                      if (!(await confirm({ title: '删除这个测试用例？', danger: true, confirmText: '删除' }))) return
                      await del(`/prompt-eval/cases/${c.id}`)
                      if (sel?.id === c.id) setSel(null)
                      void cases.refetch()
                    }} />
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {owner && <BatchReplay cases={cases.data ?? []} label={label} />}
      {sel ? (
        <div className="space-y-4">
          {owner && (
            <Card className="p-4">
              <Field label="候选提示词（B）" hint="A 为当前正在使用的版本。对比满意后，到「提示词模板」里保存为新版本。">
                <Textarea rows={8} value={tplB} onChange={(e) => setTplB(e.target.value)} />
              </Field>
              <div className="mt-3 flex justify-end"><Button variant="primary" icon={<FlaskConical className="size-4" />} loading={busy} disabled={!tplB.trim()} onClick={run}>新旧各跑一次</Button></div>
            </Card>
          )}
          {(runs.data ?? []).map((r) => (
            <Card key={r.id} className="p-4">
              <div className="mb-2 flex items-center justify-between text-[12px] text-mist-500">
                <span>{relTime(r.created_at)} · A=v{r.template_version_a}，B=候选</span>
                <div className="flex gap-1">
                  {([['a_better', 'A 更好'], ['same', '差不多'], ['b_better', 'B 更好']] as const).map(([v, l]) => (
                    <Button key={v} size="sm" variant={r.verdict === v ? 'primary' : 'ghost'} onClick={() => verdict(r, v)}>{l}</Button>
                  ))}
                </div>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                {[['A（当前）', r.output_a], ['B（候选）', r.output_b]].map(([t, o]) => (
                  <div key={t} className="rounded-lg border border-mist-100 bg-mist-50/50 p-3">
                    <div className="mb-1 text-[11.5px] font-semibold text-mist-500">{t}</div>
                    <pre className="scrollbar-thin max-h-72 overflow-y-auto whitespace-pre-wrap font-sans text-[12.5px] leading-relaxed text-mist-800">{o}</pre>
                  </div>
                ))}
              </div>
            </Card>
          ))}
        </div>
      ) : <Card><Empty icon={<FlaskConical className="size-5" />} title="选一个测试用例" desc="左侧选择用例后，可以用候选提示词和当前版本对比输出。" /></Card>}
    </div>
  )
}

/** Quality board (EX-P-01 / EX-P-02). The same panels also appear as tabs on the usage and prompt template pages. */
export default function Quality() {
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') === 'eval' ? 'eval' : 'board'
  return (
    <div className="animate-fade-in">
      <PageHeader title="AI 质量看板" desc="看看 AI 在哪些任务上帮得好、在哪些任务上总被重来，再有针对性地调整提示词或模型。"
        action={<Tabs value={tab} onChange={(v) => setParams(v === 'eval' ? { tab: 'eval' } : {}, { replace: true })} items={[{ value: 'board', label: '效果统计' }, { value: 'eval', label: '提示词回归' }]} />} />
      {tab === 'board' ? <QualityBoard /> : <PromptEval initialTask={params.get('task') ?? ''} />}
    </div>
  )
}
