import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, FlaskConical, RefreshCw } from 'lucide-react'
import { Badge, Button, Card, CardHeader, Field, Input, Select, Textarea } from '@/components/ui'
import { errorMessage, get, post } from '@/lib/api'
import { fmtTime } from '@/lib/format'
import type { BoardRow, CXReviewAnalysisV2, CXReviewWindow, Platform } from '@/lib/types'
import { toast } from 'sonner'

type MetricKey = 'favorite_rate' | 'follow_rate' | 'interaction_rate'
type WindowResponse = {
  publication_basis: { published_at: string | null; publish_revision: number; work_id: string }
  windows: CXReviewWindow[]
  sampling: { mode: string; retained_snapshot_count: number; coverage: Record<string, { retained_snapshots: number; formal_snapshots: number }> }
}
type CompareItem = {
  work_id: string; title: string; content_format: string; published_at: string; window: string; target_at: string
  metric_ref: CXReviewWindow['metric_ref']; ratios: CXReviewWindow['ratios']; missing_reasons: string[]; read_unit?: string; share_unit?: string
}
type ExperimentSnapshot = {
  interpretation: string; window: string; metric_key: MetricKey; read_unit: string; share_unit: string
  baseline: { work_id: string; work_revision: number; publish_revision: number; metric_id: string; metric_revision: number; source: string; captured_at: string; value: number }[]
  result: { work_id: string; work_revision: number; publish_revision: number; metric_id: string; metric_revision: number; source: string; captured_at: string; value: number }[]
  baseline_median: number | null; result_median: number | null; median_delta: number | null
  baseline_sample_size: number; result_sample_size: number; baseline_excluded_count: number; result_excluded_count: number
}
type Experiment = {
  id: string; account_id: string; hypothesis: string; variable: string; metric_key: MetricKey; window: string
  selection_basis: { schema_version: number; timezone: string; platform: string; content_format?: string; baseline_content_format?: string; result_content_format?: string; read_unit: string; share_unit: string; sampling: string; eligibility: string }
  baseline_from: string; baseline_to: string; result_from: string; result_to: string; status: 'running' | 'concluded' | 'abandoned'
  conclusion: 'support' | 'reject' | 'inconclusive' | null; result_snapshot: ExperimentSnapshot | null; note: string
  revision: number; created_at: string; concluded_at: string | null; stale: boolean
}
type ExperimentList = { items: Experiment[]; next_cursor: string | null }
type ExperimentProposal = CXReviewAnalysisV2['experiments'][number]

const windowNames: Record<string, string> = { T1: '发布后约 1 天', T3: '发布后约 3 天', T7: '发布后约 7 天', T30: '发布后约 30 天' }
const metricNames: Record<MetricKey, string> = { favorite_rate: '收藏率', follow_rate: '涨粉率', interaction_rate: '严格互动率' }
const variableNames: Record<string, string> = { title: '标题', cover: '封面', topic: '选题', format: '内容形态', posting_time: '发布时间' }
const unitNames: Record<string, string> = { users: '阅读人数', times: '阅读次数', count: '计数', unknown: '未知' }
const missingNames: Record<string, string> = {
  missing_metric: '没有合格指标', missing_published_at: '作品缺少发布时间', reads_missing: '缺少阅读分母', reads_not_positive: '阅读量为零或负数',
  favorites_missing: '缺少收藏数', follows_gained_missing: '缺少涨粉数', likes_missing: '缺少点赞数', comments_missing: '缺少评论数', shares_missing: '缺少分享数',
  share_unit_incompatible: '分享单位不兼容', read_unit_unknown: '阅读单位未知',
}

const pct = (value: number | null | undefined) => value == null ? '—' : new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 2 }).format(value)
const rateFor = (item: Pick<CompareItem, 'ratios'>, key: MetricKey) => item.ratios[key]
const dateISO = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
const offsetDate = (offset: number) => { const date = new Date(); date.setDate(date.getDate() + offset); return dateISO(date) }
const metricUnitLabel = (readUnit?: string, shareUnit?: string, key?: MetricKey) => key === 'interaction_rate'
  ? `${unitNames[readUnit ?? 'unknown'] ?? readUnit} · 分享${unitNames[shareUnit ?? 'unknown'] ?? shareUnit}`
  : unitNames[readUnit ?? 'unknown'] ?? readUnit ?? '单位未知'

function WindowDetail({ window }: { window: CXReviewWindow }) {
  const metrics: [MetricKey, string][] = [['favorite_rate', '收藏率'], ['follow_rate', '涨粉率'], ['interaction_rate', '严格互动率']]
  return <div className="rounded-lg border border-mist-200 p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="font-semibold text-mist-800">{windowNames[window.window] ?? window.window}</div>
      <Badge>{window.window}</Badge>
    </div>
    <div className="mt-1 text-xs text-mist-500">目标 {window.target_at ? fmtTime(window.target_at) : '—'}{window.range ? ` · 允许范围 ${fmtTime(window.range.from)} 至 ${fmtTime(window.range.to)}` : ''}</div>
    {window.metric_ref ? <div className="mt-2 text-xs text-mist-600">
      快照 {window.metric_ref.metric_id} · 修订 {window.metric_ref.revision} · {window.metric_ref.source} · {fmtTime(window.metric_ref.captured_at)} · {window.metric_ref.quality}
      <div>阅读单位：{unitNames[window.metric_ref.read_unit] ?? window.metric_ref.read_unit}；分享单位：{unitNames[window.metric_ref.share_unit] ?? window.metric_ref.share_unit}</div>
    </div> : <div className="mt-2 text-sm text-mist-500">本窗口没有可用的正式指标快照。</div>}
    <div className="mt-3 grid gap-2 sm:grid-cols-3">
      {metrics.map(([key, label]) => {
        const ratio = window.ratios[key]
        const baseline = window.baseline[key]
        return <div key={key} className="rounded-md bg-mist-50 p-2.5">
          <div className="text-xs text-mist-500">{label}</div>
          <div className="mt-1 text-lg font-semibold tabular-nums text-mist-900">{pct(ratio.value)}</div>
          {ratio.value == null && ratio.missing_reasons.length > 0 && <div className="mt-1 text-[11px] text-mist-500">{ratio.missing_reasons.map((reason) => missingNames[reason] ?? reason).join('、')}</div>}
          <div className="mt-1 text-[11px] text-mist-500">同口径基准 {baseline.median == null ? '不足 5 个有效样本' : pct(baseline.median)} · {baseline.sample_size} 个有效 / 排除 {baseline.excluded_count}</div>
          {baseline.read_unit && <div className="text-[11px] text-mist-400">单位：{metricUnitLabel(baseline.read_unit, baseline.share_unit, key)}</div>}
        </div>
      })}
    </div>
    <div className="mt-2 text-[11px] text-mist-400">保留快照 {window.coverage.retained_snapshots} 条，正式质量快照 {window.coverage.formal_snapshots} 条；只使用当前保留记录。</div>
    {window.missing_reasons.length > 0 && <div className="mt-1 text-xs text-amber-700">缺失：{window.missing_reasons.map((reason) => missingNames[reason] ?? reason).join('、')}</div>}
  </div>
}

function ExperimentCard({ item, refresh }: { item: Experiment; refresh: () => void }) {
  const [conclusion, setConclusion] = useState<'support' | 'reject' | 'inconclusive'>('inconclusive')
  const [note, setNote] = useState(item.note ?? '')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const snapshot = item.result_snapshot
  const conclude = async () => {
    setBusy(true)
    try {
      await post(`/experiments/${item.id}/conclude`, { base_revision: item.revision, conclusion, note })
      toast.success('实验已人工结案')
      refresh()
    } catch (error) { toast.error(errorMessage(error)) } finally { setBusy(false) }
  }
  const abandon = async () => {
    if (!reason.trim()) { toast.error('请写明放弃原因'); return }
    setBusy(true)
    try {
      await post(`/experiments/${item.id}/abandon`, { base_revision: item.revision, reason })
      toast.success('实验已放弃，账号可以开始下一项实验')
      refresh()
    } catch (error) { toast.error(errorMessage(error)) } finally { setBusy(false) }
  }
  const resultMessage = snapshot?.interpretation === 'observational' ? '这是观察性比较，不能证明因果关系。' : ''
  return <article className="rounded-xl border border-mist-200 p-4" data-testid={`cx-review-experiment-${item.id}`}>
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div><div className="font-semibold text-mist-900">{item.hypothesis}</div>
        <div className="mt-1 text-xs text-mist-500">变量：{variableNames[item.variable] ?? item.variable} · {metricNames[item.metric_key]} · {windowNames[item.window] ?? item.window}</div>
        <div className="text-xs text-mist-500">基线 {item.baseline_from} 至 {item.baseline_to}；结果 {item.result_from} 至 {item.result_to}（{item.selection_basis.timezone}）</div>
        <div className="text-xs text-mist-500">形态：{item.selection_basis.baseline_content_format && item.selection_basis.result_content_format
          ? `${item.selection_basis.baseline_content_format} → ${item.selection_basis.result_content_format}` : item.selection_basis.content_format} · 阅读单位：{unitNames[item.selection_basis.read_unit] ?? item.selection_basis.read_unit}</div>
      </div>
      <Badge tone={item.status === 'running' ? 'gamboge' : item.status === 'concluded' ? 'ink' : 'gray'}>{item.status === 'running' ? '进行中' : item.status === 'concluded' ? '已结案' : '已放弃'}</Badge>
    </div>
    {item.status === 'concluded' && <div className="mt-3 rounded-lg bg-mist-50 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2"><strong>人工结论：{item.conclusion === 'support' ? '支持假设' : item.conclusion === 'reject' ? '不支持假设' : '暂不确定'}</strong>
        {item.stale && <Badge tone="gamboge">依据已变化，历史结论未改写</Badge>}</div>
      <div className="mt-1 text-xs text-mist-500">{resultMessage} 单位：{metricUnitLabel(snapshot?.read_unit, snapshot?.share_unit, item.metric_key)}</div>
      {snapshot && <div className="mt-2 grid gap-2 sm:grid-cols-3">
        <div>基线：{pct(snapshot.baseline_median)} · {snapshot.baseline_sample_size} 个有效，排除 {snapshot.baseline_excluded_count}</div>
        <div>结果：{pct(snapshot.result_median)} · {snapshot.result_sample_size} 个有效，排除 {snapshot.result_excluded_count}</div>
        <div>中位数变化：{snapshot.median_delta == null ? '—' : `${snapshot.median_delta > 0 ? '+' : ''}${pct(snapshot.median_delta)}`}</div>
      </div>}
      {item.note && <div className="mt-2 text-xs text-mist-600">备注：{item.note}</div>}
      {snapshot && <details className="mt-2 text-xs"><summary className="cursor-pointer text-ink-700">查看样本来源与修订</summary>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          {([['基线', snapshot.baseline], ['结果', snapshot.result]] as const).map(([label, samples]) => <div key={label}>
            <strong>{label}样本</strong>
            {samples.map((sample) => <div key={`${sample.work_id}:${sample.metric_id}`} className="mt-1 break-all text-mist-500">作品 {sample.work_id} · 作品修订 {sample.work_revision}/{sample.publish_revision} · 指标 {sample.metric_id} 修订 {sample.metric_revision} · {sample.source} · {fmtTime(sample.captured_at)}</div>)}
          </div>)}
        </div>
      </details>}
    </div>}
    {item.status === 'running' && <div className="mt-3 border-t border-mist-100 pt-3">
      <p className="mb-2 text-xs text-mist-500">结案时重新核算正式样本。基线与结果各至少 3 个有效同口径样本才能选择“支持”或“不支持”；不足时只可记为“暂不确定”。</p>
      <details><summary className="cursor-pointer text-sm font-medium text-ink-700">人工结案</summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-[180px_1fr]">
          <Select aria-label="实验结论" value={conclusion} onChange={(event) => setConclusion(event.target.value as typeof conclusion)}>
            <option value="inconclusive">暂不确定</option><option value="support">支持假设</option><option value="reject">不支持假设</option>
          </Select>
          <Input aria-label="结案备注" value={note} maxLength={2000} onChange={(event) => setNote(event.target.value)} placeholder="可写样本限制、反例和解释" />
        </div>
        <Button className="mt-2" size="sm" variant="human" loading={busy} onClick={() => void conclude()}>确认结案</Button>
      </details>
      <details className="mt-2"><summary className="cursor-pointer text-sm text-mist-600">放弃实验</summary>
        <div className="mt-2 flex flex-wrap gap-2"><Input aria-label="放弃原因" value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} placeholder="填写放弃原因" />
          <Button size="sm" variant="outline" loading={busy} disabled={!reason.trim()} onClick={() => void abandon()}>放弃并释放账号实验位</Button></div>
      </details>
    </div>}
  </article>
}

export function ReviewCX21({ accountId, platform, contentFormat, works, proposal, onProposalUsed }: {
  accountId: string; platform: Platform; contentFormat: string; works: BoardRow[]; proposal?: ExperimentProposal | null; onProposalUsed?: () => void
}) {
  const queryClient = useQueryClient()
  const publishedWorks = useMemo(() => works.filter((work) => work.status === 'published' && !!work.published_at), [works])
  const [workId, setWorkId] = useState('')
  const [windowKey, setWindowKey] = useState('T7')
  const [metricKey, setMetricKey] = useState<MetricKey>('favorite_rate')
  const [readUnit, setReadUnit] = useState('users')
  const [shareUnit, setShareUnit] = useState('times')
  const [createOpen, setCreateOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [draft, setDraft] = useState(() => ({
    hypothesis: '', variable: 'title', metric_key: 'favorite_rate' as MetricKey, window: 'T7',
    content_format: contentFormat, baseline_content_format: contentFormat, result_content_format: contentFormat,
    read_unit: 'users', share_unit: 'times', timezone: 'Asia/Shanghai',
    baseline_from: offsetDate(-27), baseline_to: offsetDate(-14), result_from: offsetDate(-13), result_to: offsetDate(0),
  }))
  useEffect(() => {
    if (!publishedWorks.some((work) => work.id === workId)) setWorkId(publishedWorks[0]?.id ?? '')
  }, [publishedWorks, workId])
  useEffect(() => {
    if (!proposal) return
    setDraft((current) => ({ ...current, hypothesis: proposal.hypothesis, variable: proposal.variable, metric_key: proposal.metric_key, window: proposal.window,
      content_format: contentFormat, baseline_content_format: contentFormat, result_content_format: contentFormat }))
    setCreateOpen(true)
    onProposalUsed?.()
  }, [proposal, contentFormat, onProposalUsed])
  const windows = useQuery({ queryKey: ['cx-review-windows', workId], queryFn: () => get<WindowResponse>(`/works/${workId}/metrics/windows`), enabled: !!workId })
  const compare = useInfiniteQuery({
    queryKey: ['cx-review-compare', accountId, windowKey, contentFormat], initialPageParam: '' as string,
    queryFn: ({ pageParam }) => get<{ items: CompareItem[]; next_cursor: string | null; sampling: string }>(
      `/accounts/${accountId}/metrics/compare?window=${windowKey}&content_format=${encodeURIComponent(contentFormat)}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`),
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined, enabled: !!accountId,
  })
  const experiments = useInfiniteQuery({
    queryKey: ['cx-review-experiments', accountId], initialPageParam: '' as string,
    queryFn: ({ pageParam }) => get<ExperimentList>(`/accounts/${accountId}/experiments${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ''}`),
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined, enabled: !!accountId,
  })
  const refreshExperiments = () => { void queryClient.invalidateQueries({ queryKey: ['cx-review-experiments', accountId] }) }
  const formats = platform === 'toutiao' ? ['long_article', 'micro_post'] : platform === 'xhs' ? ['image_note', 'list_note', 'card_post', 'script', 'comic'] : ['long_article', 'qa_article', 'briefing', 'card_post', 'script', 'comic']
  const createExperiment = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    const formatVariable = draft.variable === 'format'
    try {
      await post(`/accounts/${accountId}/experiments`, {
        hypothesis: draft.hypothesis, variable: draft.variable, metric_key: draft.metric_key, window: draft.window,
        selection_basis: { timezone: draft.timezone, platform, content_format: formatVariable ? '' : draft.content_format,
          baseline_content_format: formatVariable ? draft.baseline_content_format : '', result_content_format: formatVariable ? draft.result_content_format : '',
          read_unit: draft.read_unit, share_unit: draft.share_unit },
        baseline_from: draft.baseline_from, baseline_to: draft.baseline_to, result_from: draft.result_from, result_to: draft.result_to,
      })
      toast.success('实验已创建；纳入规则和时间范围已冻结')
      setCreateOpen(false)
      setDraft((current) => ({ ...current, hypothesis: '' }))
      refreshExperiments()
    } catch (error) { toast.error(errorMessage(error)) } finally { setSaving(false) }
  }
  const selectedRows = compare.data?.pages.flatMap((page) => page.items) ?? []
  const readUnits = [...new Set(selectedRows.map((item) => item.read_unit).filter((value): value is string => !!value))]
  const shareUnits = [...new Set(selectedRows.filter((item) => item.read_unit === readUnit).map((item) => item.share_unit).filter((value): value is string => !!value))]
  const comparisonRows = selectedRows.filter((item) => !item.metric_ref || (item.read_unit === readUnit && (metricKey !== 'interaction_rate' || item.share_unit === shareUnit)))
  const experimentItems = experiments.data?.pages.flatMap((page) => page.items) ?? []
  useEffect(() => { if (readUnits.length && !readUnits.includes(readUnit)) setReadUnit(readUnits[0]) }, [readUnits.join('|'), readUnit])
  useEffect(() => { if (shareUnits.length && !shareUnits.includes(shareUnit)) setShareUnit(shareUnits[0]) }, [shareUnits.join('|'), shareUnit])

  return <section className="my-6 space-y-4" data-testid="cx-review-multitime">
    <Card>
      <CardHeader title="多时点复盘" desc="按作品发布时间计算四个小时窗口；每个窗口只选一条正式快照，展示同账号、同形态、同单位的历史中位数。" />
      <div className="space-y-4 p-5">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="查看作品" className="min-w-64 flex-1">
            <Select value={workId} onChange={(event) => setWorkId(event.target.value)}>
              <option value="">请选择已发布作品</option>
              {publishedWorks.map((work) => <option key={work.id} value={work.id}>{work.title || '未命名'} · {work.published_at ? fmtTime(work.published_at) : ''}</option>)}
            </Select>
          </Field>
          {windows.data && <div className="text-xs text-mist-500">发布版本 {windows.data.publication_basis.publish_revision} · 采样 {windows.data.sampling.mode} · 当前保留 {windows.data.sampling.retained_snapshot_count} 条</div>}
          <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} loading={windows.isFetching} disabled={!workId} onClick={() => void windows.refetch()}>刷新窗口</Button>
        </div>
        {windows.isError && <p className="text-sm text-danger">读取窗口失败：{errorMessage(windows.error)}</p>}
        {!publishedWorks.length && <p className="text-sm text-mist-500">当前账号还没有带发布时间的已发布作品。</p>}
        {windows.data && <div className="grid gap-3 xl:grid-cols-2">{windows.data.windows.map((window) => <WindowDetail key={window.window} window={window} />)}</div>}
      </div>
    </Card>

    <Card>
      <CardHeader title="同口径作品比较" desc="先选指标和窗口；单位不同的样本分组展示，避免把人数与次数混在一起。" />
      <div className="space-y-3 p-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="时间窗口"><Select value={windowKey} onChange={(event) => setWindowKey(event.target.value)}>{['T1', 'T3', 'T7', 'T30'].map((key) => <option key={key} value={key}>{windowNames[key]}</option>)}</Select></Field>
          <Field label="比较指标"><Select value={metricKey} onChange={(event) => setMetricKey(event.target.value as MetricKey)}>{Object.entries(metricNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select></Field>
          <Field label="阅读单位"><Select value={readUnit} onChange={(event) => setReadUnit(event.target.value)}>{(readUnits.length ? readUnits : ['users', 'times']).map((unit) => <option key={unit} value={unit}>{unitNames[unit] ?? unit}</option>)}</Select></Field>
          {metricKey === 'interaction_rate' && <Field label="分享单位"><Select value={shareUnit} onChange={(event) => setShareUnit(event.target.value)}>{(shareUnits.length ? shareUnits : ['times', 'count']).map((unit) => <option key={unit} value={unit}>{unitNames[unit] ?? unit}</option>)}</Select></Field>}
        </div>
        {compare.isError && <p className="text-sm text-danger">读取比较失败：{errorMessage(compare.error)}</p>}
        {readUnits.length > 1 && <p className="text-xs text-mist-500">当前仅显示阅读单位为“{unitNames[readUnit] ?? readUnit}”{metricKey === 'interaction_rate' ? `、分享单位为“${unitNames[shareUnit] ?? shareUnit}”` : ''}的作品；其他单位留在各自组内，不参与本表比较。</p>}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead><tr className="border-b border-mist-200 text-xs text-mist-500"><th className="py-2">作品</th><th>发布</th><th>指标</th><th>单位</th><th>快照来源 / 时间</th><th>缺失原因</th></tr></thead>
            <tbody>{comparisonRows.map((item) => {
              const rate = rateFor(item, metricKey)
              return <tr key={item.work_id} className="border-b border-mist-100 align-top">
                <td className="py-2 font-medium text-mist-800">{item.title || '未命名'}</td><td className="py-2 text-xs text-mist-500">{fmtTime(item.published_at)}</td>
                <td className="py-2 tabular-nums">{pct(rate.value)}</td><td className="py-2 text-xs">{metricUnitLabel(item.read_unit, item.share_unit, metricKey)}</td>
                <td className="py-2 text-xs text-mist-500">{item.metric_ref ? `${item.metric_ref.source} · ${fmtTime(item.metric_ref.captured_at)} · 修订 ${item.metric_ref.revision}` : '—'}</td>
                <td className="py-2 text-xs text-mist-500">{rate.value == null ? (rate.missing_reasons.map((reason) => missingNames[reason] ?? reason).join('、') || '没有合格快照') : '—'}</td>
              </tr>
            })}</tbody>
          </table>
          {!selectedRows.length && <p className="py-4 text-sm text-mist-500">当前形态下没有已发布作品。</p>}
          {!!selectedRows.length && !comparisonRows.length && <p className="py-4 text-sm text-mist-500">所选单位组没有可比较的作品。</p>}
        </div>
        {compare.hasNextPage && <Button size="sm" variant="outline" loading={compare.isFetchingNextPage} onClick={() => void compare.fetchNextPage()}>加载更多作品</Button>}
        <p className="text-[11px] text-mist-400">服务端最多返回最近 20 篇；不包含未来作品或删除稿。所有比例以未舍入值计算，界面保留两位小数。</p>
      </div>
    </Card>

    <Card>
      <CardHeader title="单变量观察实验" desc="每个账号同时只能有一个进行中实验。实验只做观察比较，结论由你逐项确认。" action={<Button size="sm" variant="primary" icon={<FlaskConical className="size-3.5" />} onClick={() => setCreateOpen((open) => !open)}>{createOpen ? '收起表单' : '新建实验'}</Button>} />
      {createOpen && <form className="grid gap-3 border-b border-mist-100 p-5 md:grid-cols-2" onSubmit={(event) => void createExperiment(event)} data-testid="cx-review-experiment-form">
        <Field label="实验假设" className="md:col-span-2"><Textarea required minLength={1} maxLength={1000} rows={2} value={draft.hypothesis} onChange={(event) => setDraft({ ...draft, hypothesis: event.target.value })} placeholder="例如：在相近内容下，具体标题与收藏率可能同时变化" /></Field>
        <Field label="单一变量"><Select value={draft.variable} onChange={(event) => setDraft({ ...draft, variable: event.target.value })}>{Object.entries(variableNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select></Field>
        <Field label="指标口径"><Select value={draft.metric_key} onChange={(event) => setDraft({ ...draft, metric_key: event.target.value as MetricKey })}>{Object.entries(metricNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select></Field>
        <Field label="窗口"><Select value={draft.window} onChange={(event) => setDraft({ ...draft, window: event.target.value })}>{['T1', 'T3', 'T7', 'T30'].map((key) => <option key={key} value={key}>{windowNames[key]}</option>)}</Select></Field>
        <Field label="时区"><Input required value={draft.timezone} onChange={(event) => setDraft({ ...draft, timezone: event.target.value })} /></Field>
        {draft.variable === 'format' ? <>
          <Field label="基线形态"><Select value={draft.baseline_content_format} onChange={(event) => setDraft({ ...draft, baseline_content_format: event.target.value })}>{formats.map((format) => <option key={format}>{format}</option>)}</Select></Field>
          <Field label="结果形态"><Select value={draft.result_content_format} onChange={(event) => setDraft({ ...draft, result_content_format: event.target.value })}>{formats.map((format) => <option key={format}>{format}</option>)}</Select></Field>
        </> : <Field label="内容形态"><Select value={draft.content_format} onChange={(event) => setDraft({ ...draft, content_format: event.target.value })}>{formats.map((format) => <option key={format}>{format}</option>)}</Select></Field>}
        <Field label="阅读单位"><Select value={draft.read_unit} onChange={(event) => setDraft({ ...draft, read_unit: event.target.value })}><option value="users">阅读人数</option><option value="times">阅读次数</option><option value="count">计数</option></Select></Field>
        <Field label="分享单位"><Select value={draft.share_unit} onChange={(event) => setDraft({ ...draft, share_unit: event.target.value })}><option value="times">次数</option><option value="count">计数</option><option value="unknown">未知</option></Select></Field>
        <Field label="基线开始"><Input type="date" required value={draft.baseline_from} onChange={(event) => setDraft({ ...draft, baseline_from: event.target.value })} /></Field>
        <Field label="基线结束"><Input type="date" required value={draft.baseline_to} onChange={(event) => setDraft({ ...draft, baseline_to: event.target.value })} /></Field>
        <Field label="结果开始"><Input type="date" required value={draft.result_from} onChange={(event) => setDraft({ ...draft, result_from: event.target.value })} /></Field>
        <Field label="结果结束"><Input type="date" required value={draft.result_to} onChange={(event) => setDraft({ ...draft, result_to: event.target.value })} /></Field>
        <div className="flex flex-wrap items-center justify-between gap-2 md:col-span-2"><p className="text-xs text-mist-500">创建后会冻结时区、形态、单位、日期范围与纳入规则；形态变量必须显式选择两个不同形态。</p><Button type="submit" variant="human" loading={saving}>创建这一项实验</Button></div>
      </form>}
      <div className="space-y-3 p-5">
        {experiments.isError && <p className="text-sm text-danger">读取实验失败：{errorMessage(experiments.error)}</p>}
        {experimentItems.map((item) => <ExperimentCard key={item.id} item={item} refresh={refreshExperiments} />)}
        {experiments.hasNextPage && <Button size="sm" variant="outline" loading={experiments.isFetchingNextPage} onClick={() => void experiments.fetchNextPage()}>加载更多实验</Button>}
        {!experiments.isLoading && !experimentItems.length && <p className="text-sm text-mist-500">还没有实验记录。</p>}
      </div>
    </Card>
    <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"><Activity className="mt-0.5 size-4 shrink-0" />观察数据可能受发布时间、受众构成和内容差异等因素影响；此处的差值不是因果证明，也不承诺效果。</div>
  </section>
}
