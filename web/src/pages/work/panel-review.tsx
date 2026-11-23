import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronUp, LoaderCircle, RefreshCw, Users } from 'lucide-react'
import { Badge, Button, Notice, cn } from '@/components/ui'
import { ApiError, errorMessage, get, post } from '@/lib/api'
import { fmtTime } from '@/lib/format'

// REF41 C1：智囊团（默认五席）多角色独立审稿。
// 只展示服务端返回的席位意见与聚合摘要；不自动改稿、不写 review_report。
// 采纳/忽略只做本机记录，不触发任何写入接口。

type SeatResult = {
  audience: string
  verdict: string
  strengths?: string[]
  risks?: string[]
  questions?: string[]
  suggestions?: string[]
  failed?: boolean
  error?: string
}

type PanelSummary = {
  consensus?: string[]
  conflicts?: Array<{ topic: string; views: string[] }>
  top_risks?: string[]
}

type PanelReview = {
  id: string
  work_id: string
  work_revision: number
  audiences: string[]
  status: 'queued' | 'running' | 'partial' | 'done' | 'failed'
  results?: unknown
  summary?: unknown
  model: string
  prompt_version: string
  created_at: string
  finished_at?: string
}

type Decision = 'adopt' | 'ignore'
type CostPrompt = { tokens: number; audiences: number }

const statusText: Record<PanelReview['status'], string> = {
  queued: '排队中', running: '评审中', partial: '部分完成', done: '已完成', failed: '失败',
}

function seatsOf(review: PanelReview): SeatResult[] {
  if (!Array.isArray(review.results)) return []
  return review.results.filter((item): item is SeatResult => !!item && typeof item === 'object' && typeof (item as SeatResult).audience === 'string')
}

function summaryOf(review: PanelReview): PanelSummary {
  if (!review.summary || typeof review.summary !== 'object' || Array.isArray(review.summary)) return {}
  return review.summary as PanelSummary
}

function decisionKey(reviewID: string, seat: number, suggestion: number) {
  return `${reviewID}:${seat}:${suggestion}`
}

function readDecisions(reviewID: string): Record<string, Decision> {
  try {
    const raw = window.localStorage.getItem(`ops.panel-decisions.v1:${reviewID}`)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: Record<string, Decision> = {}
    for (const [key, value] of Object.entries(parsed)) if (value === 'adopt' || value === 'ignore') out[key] = value
    return out
  } catch {
    return {}
  }
}

function SeatCard({ reviewID, seat, index, decisions, onDecision }: {
  reviewID: string
  seat: SeatResult
  index: number
  decisions: Record<string, Decision>
  onDecision: (key: string, value: Decision) => void
}) {
  const [expanded, setExpanded] = useState(false)
  if (seat.failed) {
    return <article data-testid={`panel-seat-${index}`} className="rounded-xl border border-red-200 bg-red-50/60 p-3">
      <div className="flex items-center gap-2"><strong className="text-[13px] text-red-800">{seat.audience}</strong><Badge tone="red">本席未完成</Badge></div>
      <p className="mt-1 text-[11.5px] text-red-700">{seat.error || '该席调用失败，未生成意见。'}</p>
    </article>
  }
  const lists = [
    ['优点', seat.strengths],
    ['风险', seat.risks],
    ['疑问', seat.questions],
  ] as const
  return <article data-testid={`panel-seat-${index}`} className="rounded-xl border border-mist-200 bg-white p-3">
    <div className="flex flex-wrap items-start gap-2">
      <div className="min-w-0 flex-1">
        <strong className="text-[13px] text-mist-900">{seat.audience}</strong>
        <p className="mt-1 text-[12px] leading-relaxed text-mist-700">{seat.verdict}</p>
      </div>
      <Button size="sm" variant="ghost" onClick={() => setExpanded((value) => !value)}
        icon={expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}>
        {expanded ? '收起' : '展开详情'}
      </Button>
    </div>
    {expanded && <div className="mt-3 space-y-2 border-t border-mist-100 pt-3">
      {lists.map(([label, items]) => (items?.length ?? 0) > 0 && <div key={label}>
        <p className="text-[11px] font-medium text-mist-500">{label}</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[12px] leading-relaxed text-mist-700">{items!.map((item, itemIndex) => <li key={itemIndex}>{item}</li>)}</ul>
      </div>)}
      {(seat.suggestions?.length ?? 0) > 0 && <div>
        <p className="text-[11px] font-medium text-mist-500">建议（只记录，不改稿）</p>
        <div className="mt-1 space-y-1.5">{seat.suggestions!.map((item, suggestionIndex) => {
          const key = decisionKey(reviewID, index, suggestionIndex)
          const decision = decisions[key]
          return <div key={suggestionIndex} data-testid={`panel-suggestion-${index}-${suggestionIndex}`} className={cn('flex flex-wrap items-center gap-2 rounded-lg border px-2.5 py-2', decision === 'adopt' ? 'border-emerald-200 bg-emerald-50/60' : decision === 'ignore' ? 'border-mist-200 bg-mist-50' : 'border-mist-200')}>
            <span className="min-w-0 flex-1 text-[12px] text-mist-700">{item}</span>
            <Button size="sm" variant={decision === 'adopt' ? 'primary' : 'ghost'} onClick={() => onDecision(key, 'adopt')}>采纳</Button>
            <Button size="sm" variant={decision === 'ignore' ? 'primary' : 'ghost'} onClick={() => onDecision(key, 'ignore')}>忽略</Button>
          </div>
        })}</div>
      </div>}
    </div>}
  </article>
}

export function PanelReviewCard({ workId }: { workId: string }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [costPrompt, setCostPrompt] = useState<CostPrompt | null>(null)
  const [decisions, setDecisions] = useState<Record<string, Decision>>({})
  const list = useQuery({
    queryKey: ['panel-reviews', workId],
    queryFn: () => get<{ reviews: PanelReview[] }>(`/works/${workId}/panel-reviews`),
    refetchInterval: (query) => {
      const latest = query.state.data?.reviews?.[0]
      return latest && (latest.status === 'queued' || latest.status === 'running') ? 3000 : false
    },
  })
  const latest = list.data?.reviews?.[0]
  const latestID = latest?.id ?? ''
  useEffect(() => { setDecisions(latestID ? readDecisions(latestID) : {}) }, [latestID])

  const record = (key: string, value: Decision) => {
    if (!latestID) return
    const next = { ...decisions, [key]: value }
    setDecisions(next)
    try { window.localStorage.setItem(`ops.panel-decisions.v1:${latestID}`, JSON.stringify(next)) } catch { /* 本机记录失败不阻断评审 */ }
  }

  const run = async (confirm = false) => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await post<PanelReview>(`/works/${workId}/panel-review`, confirm ? { confirm: true } : {})
      setCostPrompt(null)
      await list.refetch()
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === 'panel_cost_confirm') {
        const detail = reason.detail as { estimated_tokens?: unknown; audiences?: unknown } | null
        setCostPrompt({
          tokens: typeof detail?.estimated_tokens === 'number' ? detail.estimated_tokens : 0,
          audiences: typeof detail?.audiences === 'number' ? detail.audiences : 5,
        })
      } else {
        setError(errorMessage(reason) || '智囊团评审发起失败')
      }
    } finally {
      setBusy(false)
    }
  }

  const seats = latest ? seatsOf(latest) : []
  const summary = latest ? summaryOf(latest) : {}
  const doneCount = seats.filter((seat) => !seat.failed).length
  const active = latest?.status === 'queued' || latest?.status === 'running'
  const summaryText = (summary.consensus?.length ?? 0) > 0 ? summary.consensus!.join('；') : '等待评审完成后聚合'

  return <section data-testid="panel-review-card" className="rounded-xl border border-mist-200 bg-white p-3.5">
    <div className="flex flex-wrap items-start gap-2">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="flex items-center gap-1.5 text-[13.5px] font-semibold text-mist-900"><Users className="size-4" />智囊团</h3>
          <span className="text-[11.5px] text-mist-400">默认五席 · 每席独立审稿 · 不改稿</span>
        </div>
        <p className="mt-1 text-[11.5px] leading-relaxed text-mist-400">目标读者、同行专家、平台运营、品牌方、新手读者分别给意见；汇总只聚合，冲突并列。</p>
      </div>
      <div className="flex items-center gap-1.5">
        <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} disabled={list.isFetching} onClick={() => void list.refetch()}>刷新</Button>
        <Button size="sm" variant="primary" loading={busy} disabled={active}
          onClick={() => void run()}>{active ? '评审进行中' : '发起五席评审'}</Button>
      </div>
    </div>

    {list.isError && <Notice tone="red">智囊团记录加载失败：{errorMessage(list.error)}</Notice>}
    {error && <Notice tone="red">{error}</Notice>}
    {costPrompt && <div data-testid="panel-cost-confirm" className="mt-3 rounded-lg border border-gamboge-200 bg-gamboge-50 p-2.5 text-[12px] text-gamboge-900">
      <p>本次评审预计消耗约 {costPrompt.tokens.toLocaleString()} tokens（{costPrompt.audiences} 席 × 作品长度），超过 20k 需要确认。</p>
      <div className="mt-2 flex gap-2"><Button size="sm" variant="primary" loading={busy} onClick={() => void run(true)}>确认并继续</Button><Button size="sm" variant="ghost" onClick={() => setCostPrompt(null)}>取消</Button></div>
    </div>}

    {!latest ? <div className="mt-3 rounded-lg bg-mist-50 px-3 py-4 text-center text-[12px] text-mist-500" data-testid="panel-review-empty">
      还没有智囊团记录。发起后会并行审稿，单席失败会保留其他席位意见。
    </div> : <>
      <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="panel-review-status">
        <Badge tone={latest.status === 'done' ? 'green' : latest.status === 'failed' ? 'red' : latest.status === 'partial' ? 'gamboge' : 'gray'}>
          {active && <LoaderCircle className="mr-1 inline size-3 animate-spin" />}{statusText[latest.status]}
        </Badge>
        {(latest.status === 'partial' || latest.status === 'done') && <span className="text-[11.5px] text-mist-600">已完成 {doneCount}/{latest.audiences.length} 席</span>}
        <span className="text-[11.5px] text-mist-400">第 {latest.work_revision} 版 · {fmtTime(latest.created_at)}</span>
        {latest.finished_at && <span className="text-[11.5px] text-mist-400">完成 {fmtTime(latest.finished_at)}</span>}
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5" data-testid="panel-audience-tags">
        {latest.audiences.map((audience) => {
          const seat = seats.find((item) => item.audience === audience)
          return <Badge key={audience} tone={seat?.failed ? 'red' : seat ? 'green' : 'gray'}>{audience}{seat?.failed ? ' · 未完成' : ''}</Badge>
        })}
      </div>

      {(latest.status === 'queued' || latest.status === 'running') && <p className="mt-3 text-[12px] text-mist-500" data-testid="panel-review-running">正在逐席审稿，完成后会自动刷新。</p>}
      {latest.status === 'failed' && <Notice tone="red">本次评审全部席位失败，未生成意见；请稍后重试。</Notice>}
      {(latest.status === 'done' || latest.status === 'partial') && <>
        <div className="mt-3 rounded-lg bg-mist-50 p-2.5" data-testid="panel-summary">
          <p className="text-[11.5px] font-medium text-mist-600">结论摘要</p>
          <p className="mt-1 text-[12px] text-mist-800">{summaryText}</p>
          {(summary.top_risks?.length ?? 0) > 0 && <p className="mt-2 text-[11.5px] text-mist-600">高风险：{summary.top_risks!.join('；')}</p>}
        </div>
        {(summary.conflicts?.length ?? 0) > 0 && <div className="mt-2" data-testid="panel-conflicts">
          <p className="text-[11.5px] font-medium text-mist-600">冲突意见（并列，不合并成单一结论）</p>
          <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
            {summary.conflicts!.map((conflict) => <div key={conflict.topic} className="rounded-lg border border-mist-200 p-2.5">
              <p className="text-[11.5px] font-medium text-mist-800">{conflict.topic}</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11.5px] leading-relaxed text-mist-600">{conflict.views.map((view, index) => <li key={index}>{view}</li>)}</ul>
            </div>)}
          </div>
        </div>}
        <div className="mt-3 space-y-2" data-testid="panel-seats">
          {seats.map((seat, index) => <SeatCard key={`${seat.audience}-${index}`} reviewID={latest.id} seat={seat} index={index} decisions={decisions} onDecision={record} />)}
        </div>
        {latest.status === 'partial' && <p className="mt-2 text-[11.5] text-gamboge-700" data-testid="panel-partial-copy">部分席位失败：仅显示成功席意见，失败席标为“本席未完成”，不补写空白意见。</p>}
        <p className="mt-2 text-[10px] text-mist-400">采纳/忽略只记录在本机，不会修改作品或写入复盘报告。</p>
      </>}
    </>}
  </section>
}
