import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { Badge, Button, cn } from '@/components/ui'
import { errorMessage, get, post } from '@/lib/api'
import type { Topic } from '@/lib/types'

export interface TopicScoreDimension {
  key: string
  score: number | null
  max: number
  state: 'available' | 'missing'
  evidence: string
  message: string
  ai_score?: number | null
  ai_evidence?: string
  ai_message?: string
}

export interface TopicScoreResult {
  title: string
  angle: string
  platform: string
  rules_version: string
  rule_score: number
  rule_max: number
  threshold: number
  coverage: { rules: string; ai: string }
  dimensions: Record<string, TopicScoreDimension>
  ai_max: number
  ai_score: number | null
  ai_partial: boolean
  ai_status: string
  ai_skipped: boolean
  ai_skip_reason?: string
  ai_error_code?: string
  ai_dimensions: Array<{ key: string; score: number; evidence: string; message: string }>
  sources: {
    material_count: number
    recent_work_count: number
    comment_count: number
    metric_comments: number
    similarity_90d?: number
    planned_date?: string
    missing: string[]
    topic_updated_at: string
    positioning_updated_at?: string
    positioning_tags?: string[]
  }
}

export interface TopicScoreReport {
  score_id: string
  topic_id: string
  input_hash: string
  result: TopicScoreResult
  model: string
  prompt_version: string
  stale: boolean
  reused: boolean
  created_at: string
}

const dimensionOrder = ['demand', 'audience', 'material', 'differentiation', 'timeliness', 'deliverability'] as const
const dimensionLabels: Record<string, string> = {
  demand: '需求强度', audience: '人群匹配', material: '素材充足',
  differentiation: '差异化', timeliness: '时效性', deliverability: '可交付性',
}

export function TopicScoreBars({ topicId }: { topicId: string }) {
  const query = useQuery({
    queryKey: ['topic-score', topicId],
    queryFn: () => get<TopicScoreReport>(`/topics/${topicId}/score`),
    retry: false,
    staleTime: 30_000,
  })
  if (!query.data) return null
  const result = query.data.result
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-mist-500" data-testid="topic-score-bars">
      <span className="font-medium text-mist-700">六维总分 {result.rule_score}/{result.rule_max}</span>
      <div className="flex items-end gap-1" aria-label="六维选题评分柱">
        {dimensionOrder.map((key) => {
          const value = result.dimensions[key]?.score
          const pct = value == null ? 0 : Math.max(0, Math.min(100, (value / 20) * 100))
          return (
            <span key={key} className="flex h-5 w-2 items-end rounded-sm bg-mist-100" title={`${dimensionLabels[key]}：${value == null ? '缺失' : `${value}/20`}`}>
              <span className={cn('w-full rounded-sm', value == null ? 'bg-mist-300' : 'bg-ink-500')} style={{ height: value == null ? 2 : Math.max(2, pct / 5) }} data-testid={`topic-score-bar-${key}`} />
            </span>
          )
        })}
      </div>
      {result.ai_skipped && <span className="text-gamboge-700">AI 已跳过</span>}
    </div>
  )
}

export function TopicScorePanel({ topic, canWrite }: { topic: Topic; canWrite: boolean }) {
  const qc = useQueryClient()
  const query = useQuery({
    queryKey: ['topic-score', topic.id],
    queryFn: () => get<TopicScoreReport>(`/topics/${topic.id}/score`),
    retry: false,
    staleTime: 30_000,
  })
  const [busy, setBusy] = useState(false)
  const report = query.data
  const result = report?.result

  const run = async (mode: 'two_stage' | 'ai') => {
    setBusy(true)
    try {
      const next = await post<TopicScoreReport>(`/topics/${topic.id}/score`, { mode })
      qc.setQueryData(['topic-score', topic.id], next)
      if (next.result.ai_skipped) toast.info(next.result.ai_skip_reason ?? '规则分未达阈值，未调用 AI')
      else toast.success('六维评分已保存')
    } catch (error) {
      toast.error(errorMessage(error))
      await query.refetch()
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mt-4 rounded-xl border border-mist-200 bg-white p-3" data-testid="topic-score-panel">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-mist-800">六维选题评分</h3>
          <p className="mt-0.5 text-[11px] text-mist-500">规则分 {result?.rule_score ?? '—'}/{result?.rule_max ?? 120}，阈值 {result?.threshold ?? 60}；不改变选题状态，也不替你做采纳决定。</p>
        </div>
        <div className="flex items-center gap-1.5">
          {result && <Badge tone={result.ai_skipped ? 'gamboge' : result.ai_status === 'complete' ? 'green' : 'gray'}>
            {result.ai_skipped ? 'AI 已跳过' : result.ai_score != null ? `AI 复核 ${result.ai_score}/${result.ai_max}` : 'AI 未运行'}
          </Badge>}
          {canWrite && <Button size="sm" variant="outline" loading={busy} disabled={busy} onClick={() => void run('two_stage')}>{result ? '重新评分' : '六维评分'}</Button>}
        </div>
      </div>

      {query.isLoading && <p className="mt-3 text-xs text-mist-500">正在读取六维评分…</p>}
      {!query.isLoading && !query.isError && !result && <p className="mt-3 text-xs text-mist-500">还没有六维评分。规则分会先算；达到 60 分才调用 AI 复核。</p>}
      {query.isError && <p className="mt-3 text-xs text-mist-500">尚未评分；{canWrite ? '点击“六维评分”开始。' : '请联系可写成员评分。'}</p>}

      {result && <>
        {report?.stale && <p className="mt-2 rounded-lg bg-gamboge-50 px-2.5 py-2 text-xs text-gamboge-800">依据已变化，本报告已过期。重新评分会保留旧报告。</p>}
        {result.ai_skipped && <div className="mt-2 rounded-lg bg-gamboge-50 px-2.5 py-2 text-xs text-gamboge-800" data-testid="topic-score-ai-skipped">
          <p>{result.ai_skip_reason ?? '规则分未达阈值，未调用 AI（省成本）'}</p>
          {canWrite && <Button size="sm" variant="ghost" className="mt-1 px-0 text-gamboge-800" loading={busy} disabled={busy} onClick={() => void run('ai')}>仍要 AI 复核</Button>}
        </div>}
        {result.ai_partial && <p className="mt-2 rounded-lg bg-gamboge-50 px-2.5 py-2 text-xs text-gamboge-800">AI 复核失败（{result.ai_error_code ?? 'unknown'}），已保留规则分。</p>}

        <div className="mt-3 grid gap-2" data-testid="topic-score-dimensions">
          {dimensionOrder.map((key) => {
            const dimension = result.dimensions[key]
            if (!dimension) return null
            return <div key={key} className="rounded-lg bg-mist-50 p-2.5 text-xs" data-testid={`topic-score-dim-${key}`}>
              <div className="flex justify-between gap-2 font-medium text-mist-700">
                <span>{dimensionLabels[key]}</span>
                <span>{dimension.score == null ? '缺失' : `${dimension.score}/20`}{dimension.ai_score != null ? ` · AI ${dimension.ai_score}/20` : ''}</span>
              </div>
              <p className="mt-1 text-mist-500">依据：{dimension.evidence}</p>
              <p className="mt-0.5 text-mist-600">为什么不是更高：{dimension.message}</p>
              {dimension.ai_message && <p className="mt-0.5 text-mist-500">AI 说明：{dimension.ai_evidence}；{dimension.ai_message}</p>}
            </div>
          })}
        </div>

        <p className="mt-2 text-[10px] leading-relaxed text-mist-400">规则分为主，AI 只复核差异化与时效性并做解释；六维总分不替代既有契合度/素材/新颖度评分。</p>
      </>}
    </section>
  )
}
