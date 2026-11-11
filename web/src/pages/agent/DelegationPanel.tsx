import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, LoaderCircle, Square } from 'lucide-react'
import { Button } from '@/components/ui'
import { get, post } from '@/lib/api'
import { usePageVisible } from '@/lib/visibility'

// DEV-AI27-15 第二批（W15b UI）：工作视图"任务"页协作区（27 §11.3.1）。
// 折叠态：仅显示"N 项进行中 / M 项完成"；展开态：子任务名称/状态/单项停止。
// 数据来自 GET /agent/conversations/{id}/delegation-groups（DEV-A13 新增：按会话取组，
// 父 run 已结束时仍能看到待承接的结果）；无委派组时不渲染（不伪造协作状态）。
// DEV-A13：组处于 waiting_user/completed 且结果未被消费时，提供"汇总结果"按钮
// （POST /agent/delegation-groups/{id}/adopt），汇总只消费一次，服务端负责幂等。

export interface DelegationItem {
  id: string
  group_id: string
  parent_run_id: string
  child_run_id: string
  task: string
  state: string
  generation: number
  result_summary?: string
  error_code?: string
  result_artifact_id?: string
}

export interface DelegationBudgetView {
  rounds_limit: number
  rounds_reserved: number
  rounds_used: number
  rounds_remaining: number
  seconds_limit: number
  seconds_remaining: number
}

export interface DelegationGroupView {
  id: string
  conversation_id: string
  root_run_id: string
  current_parent_run_id: string
  state: string
  cancel_generation: number
  parent_ended_at?: string
  adopted_run_id?: string
  results_consumed_at?: string
  adoption_count?: number
  budget?: DelegationBudgetView
  delegations: DelegationItem[]
}

const stateLabels: Record<string, string> = {
  queued: '排队中',
  running: '进行中',
  waiting_user: '等待你处理',
  succeeded: '已完成',
  failed: '失败',
  cancelling: '正在停止',
  cancelled: '已停止',
  expired: '已过期',
}

const stateTone: Record<string, string> = {
  running: 'text-ink-700',
  waiting_user: 'text-gamboge-700',
  succeeded: 'text-mint-700',
  failed: 'text-danger',
  cancelling: 'text-mist-500',
  cancelled: 'text-mist-500',
}

const groupStateLabels: Record<string, string> = {
  active: '进行中',
  waiting_user: '等待你处理',
  completed: '子任务已结束',
  cancelled: '已取消',
  failed: '失败',
}

// 可汇总：子任务已全终态、结果还没被任何 run 消费。
function adoptable(group: DelegationGroupView): boolean {
  if (group.results_consumed_at) return false
  if (!['waiting_user', 'completed'].includes(group.state)) return false
  return group.delegations.every((d) => ['succeeded', 'failed', 'cancelled', 'expired'].includes(d.state))
}

export function DelegationPanel({ conversationId, onStopped, onNavigateArtifact, onAdopted }: {
  conversationId: string
  onStopped?: () => void
  onNavigateArtifact?: (artifactId: string) => void
  onAdopted?: () => void
}) {
  const [groups, setGroups] = useState<DelegationGroupView[]>([])
  const [expanded, setExpanded] = useState(false)
  const [stopping, setStopping] = useState('')
  const [adopting, setAdopting] = useState('')
  const [error, setError] = useState('')
  const pageVisible = usePageVisible()

  const reload = useCallback(async () => {
    if (!conversationId) return
    try {
      const result = await get<{ groups: DelegationGroupView[] }>(`/agent/conversations/${conversationId}/delegation-groups`)
      setGroups(result.groups ?? [])
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [conversationId])

  // DEV-P08：隐藏页停 5s 轮询。
  useEffect(() => {
    if (!conversationId || !pageVisible) return
    void reload()
    const timer = setInterval(() => void reload(), 5000)
    return () => clearInterval(timer)
  }, [conversationId, reload, pageVisible])

  const stopOne = useCallback(async (delegationID: string) => {
    setStopping(delegationID)
    try {
      await post(`/agent/delegations/${delegationID}/cancel`)
      await reload()
      onStopped?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setStopping('')
    }
  }, [reload, onStopped])

  const adopt = useCallback(async (groupID: string) => {
    setAdopting(groupID)
    try {
      await post(`/agent/delegation-groups/${groupID}/adopt`)
      await reload()
      onAdopted?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setAdopting('')
    }
  }, [reload, onAdopted])

  if (!groups.length) return null
  const all = groups.flatMap((g) => g.delegations)
  if (!all.length) return null
  const active = all.filter((d) => ['queued', 'running', 'waiting_user', 'cancelling'].includes(d.state))
  const done = all.filter((d) => ['succeeded', 'failed', 'cancelled', 'expired'].includes(d.state))
  const pendingAdopt = groups.filter(adoptable)

  return <section className="mt-4 rounded-xl border border-mist-200 bg-white p-3" data-testid="delegation-panel">
    <button type="button" className="flex w-full items-center justify-between text-left"
      aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
      <span className="text-[13px] font-semibold text-ink-700">
        协作任务（{active.length} 项进行中 / {done.length} 项完成）
      </span>
      {expanded ? <ChevronDown className="size-4 text-mist-400" /> : <ChevronRight className="size-4 text-mist-400" />}
    </button>
    {error && <p className="mt-1 text-xs text-danger" role="alert">{error}</p>}
    {expanded && <div className="mt-2 space-y-3">
      {groups.map((group) => <div key={group.id} data-testid={`delegation-group-${group.id}`}>
        <div className="flex items-center justify-between gap-2 text-xs text-mist-500">
          <span>
            {groupStateLabels[group.state] ?? group.state}
            {group.results_consumed_at && ' · 结果已汇总'}
            {group.budget && ` · 剩余 ${group.budget.rounds_remaining} 轮`}
          </span>
          {adoptable(group) && <Button size="sm" variant="ghost" disabled={adopting === group.id}
            aria-label="汇总子任务结果"
            data-testid={`delegation-adopt-${group.id}`}
            onClick={() => void adopt(group.id)}>
            {adopting === group.id ? '汇总中' : '汇总结果'}
          </Button>}
        </div>
        <ul className="mt-1 space-y-2">
          {group.delegations.map((d) => <li key={d.id} className="rounded-lg border border-mist-100 p-2" data-testid={`delegation-${d.id}`} data-state={d.state}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-[13px] text-ink-700">{d.task}</p>
                <p className={`mt-0.5 text-xs ${stateTone[d.state] ?? 'text-mist-500'}`}>
                  {stateLabels[d.state] ?? d.state}
                  {d.state === 'running' && <LoaderCircle className="ml-1 inline size-3 animate-spin" aria-hidden="true" />}
                  {d.state === 'succeeded' && d.result_summary && <span className="ml-1 text-mist-500">· {d.result_summary.slice(0, 80)}</span>}
                  {d.error_code && <span className="ml-1 text-danger">· {d.error_code}</span>}
                </p>
                {/* 深化 4/5：委派结果产物跳转——succeeded 且有产物时显示链接。 */}
                {d.state === 'succeeded' && d.result_artifact_id && onNavigateArtifact &&
                  <button type="button" className="mt-1 text-xs underline text-primary"
                    onClick={() => onNavigateArtifact(d.result_artifact_id!)}>查看产物 →</button>}
              </div>
              {['queued', 'running', 'waiting_user'].includes(d.state) &&
                <Button size="sm" variant="ghost" disabled={stopping === d.id}
                  aria-label={`停止子任务：${d.task}`}
                  onClick={() => void stopOne(d.id)}>
                  <Square className="size-3.5" />{stopping === d.id ? '停止中' : '停止'}
                </Button>}
            </div>
          </li>)}
        </ul>
      </div>)}
      {pendingAdopt.length > 0 && <p className="text-xs text-mist-500">
        子任务已结束；点"汇总结果"让主对话读取这批结果（只计一次）。
      </p>}
    </div>}
  </section>
}
