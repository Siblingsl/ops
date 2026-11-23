import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { Badge, Button, Card, CardHeader, Empty, Notice, PageHeader, PageState } from '@/components/ui'
import { errorMessage, get, post, put } from '@/lib/api'
import { useInvalidate, useMe } from '@/lib/session'

// REF41 F3（docs/41 §F3）：系统-任务页。job_run 台账最近状态、耗时、补跑标记；
// 手动“立即补跑”只对白名单任务；agent_routine 的 missed 语义不变（24 文档）。

interface JobRun {
  id: string
  workspace_id: string | null
  job_key: string
  scheduled_at: string
  started_at: string | null
  finished_at: string | null
  status: string
  catch_up: boolean
  duration_ms: number | null
  error_code: string
  error_message: string
}

const CATCHABLE = new Set(['daily-brief', 'weekly-digest', 'metric-reminder', 'publish-patrol', 'memory-decay', 'benchmark-monitor'])

function statusBadge(status: string) {
  if (status === 'succeeded') return <Badge>成功</Badge>
  if (status === 'failed') return <Badge>失败</Badge>
  if (status === 'skipped') return <Badge>跳过（幂等）</Badge>
  return <Badge>运行中</Badge>
}

export default function JobRunsSettings() {
  const me = useMe()
  const queryClient = useQueryClient()
  const runs = useQuery({ queryKey: ['job-runs', me.data?.workspace.id], queryFn: ({ signal }) => get<{ items: JobRun[] }>('/job-runs', { signal }) })
  const [busyKey, setBusyKey] = useState('')
  const runNow = async (jobKey: string) => {
    setBusyKey(jobKey)
    try {
      await post('/job-runs/run-now', { job_key: jobKey })
      toast.success(`${jobKey} 已补跑`)
      await queryClient.invalidateQueries({ queryKey: ['job-runs'] })
    } catch (e) { toast.error(errorMessage(e)) } finally { setBusyKey('') }
  }
  const isOwner = me.data?.role === 'owner'
  return (
    <div className="max-w-3xl animate-fade-in">
      <PageHeader title="系统任务" desc="定时任务执行台账：最近状态、耗时与补跑记录。每日/每周任务错过窗口且 7 天内自动补跑一次；高频任务不补跑。" />
      {!isOwner && <Notice>只有工作区所有者可以查看系统任务台账与手动补跑。</Notice>}
      {(runs.isPending || runs.error) && <PageState loading={runs.isPending} error={runs.error} onRetry={() => void runs.refetch()} />}
      {runs.data?.items.length === 0 && <Empty title="还没有任务执行记录" desc="调度器运行后这里会出现 job_run 台账。" />}
      {isOwner && <AlertRulesCard />}
      <Card data-testid="job-runs-card">
        <CardHeader title="最近执行（最新 50 条）" />
        <div className="divide-y divide-mist-100">
          {runs.data?.items.map(run => <div key={run.id} data-testid={`job-run-${run.id}`} className="flex items-start gap-3 px-5 py-3 text-[13px]">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-ink-800">{run.job_key}</span>
                {statusBadge(run.status)}
                {run.catch_up && <Badge>补跑</Badge>}
                {run.workspace_id ? <span className="text-mist-400">工作区任务</span> : <span className="text-mist-400">系统任务</span>}
              </div>
              <p className="mt-0.5 text-mist-500">计划 {new Date(run.scheduled_at).toLocaleString()}
                {run.duration_ms !== null && <> · 耗时 {run.duration_ms}ms</>}
                {run.error_message && <> · {run.error_message}</>}</p>
            </div>
            {isOwner && CATCHABLE.has(run.job_key) &&
              <Button variant="ghost" size="sm" loading={busyKey === run.job_key} data-testid={`job-run-now-${run.job_key}`}
                onClick={() => void runNow(run.job_key)}>立即补跑</Button>}
          </div>)}
        </div>
      </Card>
    </div>
  )
}

// REF41 F1-N1：健康页告警卡——四规则阈值/窗口/启停编辑 + 最近 20 条事件；
// 消息只含计数与规则（服务端 redact 兜底）。
type AlertRule = { id: string; key: string; threshold: number; window_minutes: number; enabled: boolean }
type AlertEvent = { id: string; rule_id: string; dedupe_key: string; message: string; state: 'firing' | 'resolved'; created_at: string; resolved_at?: string | null }

const RULE_LABELS: Record<string, string> = {
  job_failure_rate: '任务失败率',
  publish_failure_count: '发布失败数',
  model_5xx_count: '模型 5xx 数',
  health_failure_count: '体检失败数',
}

export function AlertRulesCard() {
  const inv = useInvalidate()
  const rules = useQuery({ queryKey: ['alert-rules'], queryFn: () => get<{ rules: AlertRule[] }>('/alert-rules') })
  const events = useQuery({ queryKey: ['alert-events'], queryFn: () => get<{ events: AlertEvent[] }>('/alert-events') })
  const [drafts, setDrafts] = useState<Record<string, { threshold: string; window_minutes: string }>>({})
  const save = async (key: string) => {
    const draft = drafts[key]
    if (!draft) return
    try {
      await put(`/alert-rules/${key}`, { threshold: Number(draft.threshold), window_minutes: Number(draft.window_minutes) || 60 })
      toast.success('规则已更新')
      inv(['alert-rules'])
    } catch (error) {
      toast.error(errorMessage(error) || '保存失败')
    }
  }
  const toggle = async (key: string, enabled: boolean) => {
    const rule = rules.data?.rules.find((item) => item.key === key)
    try {
      await put(`/alert-rules/${key}`, { threshold: rule?.threshold ?? 0, window_minutes: rule?.window_minutes ?? 60, enabled })
      toast.success(enabled ? '规则已启用' : '规则已停用')
      inv(['alert-rules'])
    } catch (error) {
      toast.error(errorMessage(error) || '操作失败')
    }
  }
  return <Card className="mb-4" data-testid="alert-rules-card">
    <CardHeader title="告警规则" desc="窗口内指标超阈值时通知所有者；同一窗口只通知一次，恢复后发“已恢复”。消息只含计数与规则，不含正文。" />
    <div className="divide-y divide-mist-100">
      {Object.keys(RULE_LABELS).map((key) => {
        const rule = rules.data?.rules.find((item) => item.key === key)
        const draft = drafts[key] ?? { threshold: String(rule?.threshold ?? 0), window_minutes: String(rule?.window_minutes ?? 60) }
        return <div key={key} className="flex flex-wrap items-center gap-3 px-5 py-3 text-[13px]" data-testid={`alert-rule-${key}`}>
          <span className="font-medium text-ink-800 w-28">{RULE_LABELS[key]}</span>
          <label className="text-xs text-mist-600">阈值
            <input className="ml-1 w-16 rounded border border-mist-200 px-2 py-1 text-xs" value={draft.threshold}
              onChange={(e) => setDrafts((old) => ({ ...old, [key]: { ...draft, threshold: e.target.value } }))} />
          </label>
          <label className="text-xs text-mist-600">窗口（分钟）
            <input className="ml-1 w-16 rounded border border-mist-200 px-2 py-1 text-xs" value={draft.window_minutes}
              onChange={(e) => setDrafts((old) => ({ ...old, [key]: { ...draft, window_minutes: e.target.value } }))} />
          </label>
          <Button size="sm" variant="outline" onClick={() => void save(key)}>保存</Button>
          <Button size="sm" variant="ghost" onClick={() => void toggle(key, !(rule?.enabled ?? true))}>{rule?.enabled ? '停用' : '启用'}</Button>
          {rule && <Badge tone={rule.enabled ? 'green' : 'gray'}>{rule.enabled ? '启用' : '停用'}</Badge>}
        </div>
      })}
    </div>
    <CardHeader title="最近告警（最新 20 条）" />
    <div className="divide-y divide-mist-100 max-h-64 overflow-y-auto" data-testid="alert-events">
      {(events.data?.events ?? []).map((event) => <div key={event.id} className="px-5 py-2 text-xs" data-testid={`alert-event-${event.id}`}>
        <div className="flex items-center gap-2">
          <Badge tone={event.state === 'firing' ? 'red' : 'green'}>{event.state === 'firing' ? '触发中' : '已恢复'}</Badge>
          <span className="text-mist-500">{event.created_at.slice(0, 19).replace('T', ' ')}</span>
        </div>
        <p className="mt-1 text-mist-600">{event.message}</p>
      </div>)}
      {(events.data?.events ?? []).length === 0 && <p className="px-5 py-3 text-xs text-mist-500">还没有告警事件。</p>}
    </div>
  </Card>
}
