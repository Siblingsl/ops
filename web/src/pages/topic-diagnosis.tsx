import { useInfiniteQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Badge, Button, cn } from '@/components/ui'
import { errorMessage, get, post } from '@/lib/api'
import type { Topic } from '@/lib/types'

interface TopicDiagnosisDimension {
  key: string
  score: number
  evidence: string
  message: string
}

interface TopicDiagnosisAlternative { key: 'question' | 'result'; angle: string }

interface TopicDiagnosisReport {
  title: string
  angle: string
  rules_version: string
  rule_score: number
  rule_max: number
  rule_dimensions: { dimensions: Record<string, { score: number | null; max: number; state: string }> }
  ai_score: number | null
  ai_max: number
  score: number | null
  ai_status: string
  ai_error_code?: string
  coverage: { rules: string; ai: string }
  ai_dimensions: TopicDiagnosisDimension[]
  alternatives: TopicDiagnosisAlternative[]
  sources: {
    platform: string
    topic_updated_at: string
    positioning_updated_at?: string
    history_available: boolean
    history_count: number
    history_candidates: Array<{ id: string; title: string; kind: string; similarity: number }>
    assembled_at: string
    missing: string[]
  }
}

interface TopicDiagnosis {
  diagnosis_id: string
  topic_id: string
  ai_call_id?: string
  result: TopicDiagnosisReport
  model: string
  prompt_version: string
  stale: boolean
  reused: boolean
  created_at: string
}

interface TopicDiagnosisPage { items: TopicDiagnosis[]; next_cursor: string | null }

const ruleLabels: Record<string, string> = {
  keywords: '定位关键词', length: '拟议标题长度', differentiation: '账号内差异化',
}
const aiLabels: Record<string, string> = { specificity: '具体性', curiosity: '模拟读者好奇心' }
const missingAIReasons: Record<string, string> = {
  basis_incomplete: '账号定位标签缺失，AI 语义体检未运行。',
  ai_output_invalid: '模型输出未通过格式校验，保留规则层结果。',
  ai_context_too_long: '输入超过模型上下文限制，保留规则层结果。',
  ai_upstream_error: '模型调用失败，保留规则层结果。',
  ai_provider_unavailable: '当前没有可用模型，保留规则层结果。',
}

export function TopicDiagnosisPanel({ topic, canWrite, onAdoptAngle }: {
  topic: Topic
  canWrite: boolean
  onAdoptAngle: (angle: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const history = useInfiniteQuery({
    queryKey: ['topic-diagnoses', topic.id],
    initialPageParam: '' as string,
    queryFn: ({ pageParam }) => get<TopicDiagnosisPage>(`/topics/${topic.id}/diagnoses${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ''}`),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: expanded,
  })
  const reports = history.data?.pages.flatMap((page) => page.items) ?? []
  const [selectedID, setSelectedID] = useState('')
  const [busy, setBusy] = useState(false)
  const selected = reports.find((report) => report.diagnosis_id === selectedID) ?? reports[0]
  const refetch = history.refetch
  const lastUpdatedAt = useRef(topic.updated_at)

  useEffect(() => {
    if (lastUpdatedAt.current !== topic.updated_at) {
      lastUpdatedAt.current = topic.updated_at
      void refetch()
    }
  }, [topic.updated_at, refetch])

  const diagnose = async () => {
    setBusy(true)
    try {
      const report = await post<TopicDiagnosis>(`/topics/${topic.id}/diagnose`, { basis_updated_at: topic.updated_at })
      setSelectedID(report.diagnosis_id)
      await refetch()
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mt-4 rounded-xl border border-mist-200 bg-white p-3" data-testid="topic-diagnosis">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-mist-800">选题体检</h3>
          <p className="mt-0.5 text-[11px] text-mist-500">查看单条诊断；不影响原有契合度、素材、新颖度评分和排序。</p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => setExpanded((value) => !value)}>{expanded ? '收起' : '查看体检'}</Button>
      </div>

      {expanded && <>
      {canWrite && <div className="mt-3"><Button size="sm" variant="outline" loading={busy} disabled={busy} onClick={() => void diagnose()}>体检选题</Button></div>}
      {history.isLoading && <p className="mt-3 text-xs text-mist-500">正在读取诊断历史…</p>}
      {history.isError && <p className="mt-3 text-xs text-danger" role="alert">诊断历史读取失败：{errorMessage(history.error)} <button className="underline" onClick={() => void history.refetch()}>重试</button></p>}
      {!history.isLoading && !history.isError && reports.length === 0 && <p className="mt-3 text-xs text-mist-500">还没有诊断报告。点击“体检选题”后会保存本次依据、规则版本和模型结果。</p>}

      {reports.length > 0 && <>
        <div className="mt-3 flex flex-wrap gap-1.5" aria-label="选题体检历史">
          {reports.map((report) => <button
            key={report.diagnosis_id}
            type="button"
            className={cn('rounded-full border px-2 py-1 text-[10px] transition', selected?.diagnosis_id === report.diagnosis_id ? 'border-ink-300 bg-ink-50 text-ink-800' : 'border-mist-200 text-mist-500 hover:bg-mist-50')}
            aria-pressed={selected?.diagnosis_id === report.diagnosis_id}
            onClick={() => setSelectedID(report.diagnosis_id)}
          >
            {new Date(report.created_at).toLocaleString()} {report.stale ? '· 已过期' : ''}
          </button>)}
          {history.hasNextPage && <Button size="sm" variant="ghost" loading={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>更多历史</Button>}
        </div>

        {selected && <div className="mt-3 space-y-3" data-testid="topic-diagnosis-report">
          {selected.stale && <p className="rounded-lg bg-gamboge-50 px-2.5 py-2 text-xs text-gamboge-800">依据已变化 · 本报告已过期。请重新诊断；旧报告仍保留供查看。</p>}
          <div className="rounded-lg bg-mist-50 p-2.5 text-xs">
            <p className="font-medium text-mist-700">本次诊断输入</p>
            <p className="mt-1 text-mist-600">选题：{selected.result.title}</p>
            <p className="mt-0.5 text-mist-600">切入角度：{selected.result.angle || '未填写'}</p>
            <p className="mt-0.5 text-[10px] text-mist-400">选题更新时间 {new Date(selected.result.sources.topic_updated_at).toLocaleString()}</p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Badge tone={selected.result.coverage.rules === 'complete' ? 'green' : 'gamboge'}>规则 {selected.result.rule_score}/55{selected.result.coverage.rules !== 'complete' ? ` · 部分覆盖，可用上限 ${selected.result.rule_max}` : ''}</Badge>
            <Badge tone={selected.result.ai_status === 'complete' ? 'ink' : 'gamboge'}>AI {selected.result.ai_score == null ? '未完成' : `${selected.result.ai_score}/${selected.result.ai_max}`}</Badge>
            {selected.model && <Badge tone="gray">{selected.model.startsWith('mock') ? '本地模拟模型' : '模型推断'}</Badge>}
            {selected.result.score != null ? <Badge tone="green">综合 {selected.result.score}/100</Badge> : <Badge tone="gray">综合分不可用</Badge>}
          </div>
          <dl className="space-y-1.5 text-xs">
            {Object.entries(selected.result.rule_dimensions.dimensions).map(([key, dimension]) => <div key={key} className="flex justify-between gap-2">
              <dt className="text-mist-500">{ruleLabels[key] ?? key}</dt>
              <dd className="text-right text-mist-700">{dimension.score == null ? '不可用' : `${dimension.score}/${dimension.max}`}</dd>
            </div>)}
          </dl>

          {selected.result.ai_dimensions.length > 0 ? <div className="space-y-2 border-t border-mist-100 pt-2">
            <p className="text-[11px] font-medium text-mist-600">AI 语义维度（模型判断；好奇心为模拟读者反应）</p>
            {selected.result.ai_dimensions.map((dimension) => <div key={dimension.key} className="rounded-lg bg-mist-50 p-2.5 text-xs">
              <div className="flex justify-between gap-2 font-medium text-mist-700"><span>{aiLabels[dimension.key] ?? dimension.key}</span><span>{dimension.score}/{dimension.key === 'specificity' ? 25 : 20}</span></div>
              <p className="mt-1 text-mist-500">依据：{dimension.evidence}</p>
              <p className="mt-0.5 text-mist-600">{dimension.message}</p>
            </div>)}
          </div> : <p className="rounded-lg bg-mist-50 px-2.5 py-2 text-xs text-mist-600">{missingAIReasons[selected.result.ai_error_code ?? ''] ?? 'AI 语义体检未完成，规则层结果仍可查看。'}</p>}

          {selected.result.alternatives.length > 0 && <div className="space-y-2 border-t border-mist-100 pt-2">
            <p className="text-[11px] text-mist-500">备选角度只会放入编辑框，不会直接修改或保存选题。</p>
            {selected.result.alternatives.map((alternative) => <div key={alternative.key} className="flex items-start justify-between gap-2 rounded-lg border border-mist-100 p-2.5">
              <div className="min-w-0"><p className="text-[10px] text-mist-400">{alternative.key === 'question' ? '问题角度' : '结果角度'}</p><p className="mt-0.5 text-xs text-mist-700">{alternative.angle}</p></div>
              {canWrite && <Button size="sm" variant="ghost" onClick={() => onAdoptAngle(alternative.angle)}>放入切入角度：{alternative.angle}</Button>}
            </div>)}
          </div>}

          <div className="border-t border-mist-100 pt-2 text-[10px] leading-relaxed text-mist-400">
            <p>依据：账号定位更新时间 {selected.result.sources.positioning_updated_at ? new Date(selected.result.sources.positioning_updated_at).toLocaleString() : '缺失'}；同账号可比较历史 {selected.result.sources.history_count} 条。</p>
            {selected.result.sources.history_candidates.length > 0 && <p>本次比较：{selected.result.sources.history_candidates.map((item) => item.title).join('、')}</p>}
            <p>组装于 {new Date(selected.result.sources.assembled_at).toLocaleString()} · 规则 {selected.result.rules_version} · 模型 {selected.model || '未调用'} · 提示词 {selected.prompt_version || '未记录'}</p>
            {selected.ai_call_id && <p>AI 调用记录：{selected.ai_call_id}</p>}
            {selected.result.sources.missing.map((reason) => <p key={reason}>缺失：{reason}</p>)}
          </div>
        </div>}
      </>}
      </>}
    </section>
  )
}
