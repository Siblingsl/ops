import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, LoaderCircle, Square } from 'lucide-react'
import { Button } from '@/components/ui'
import { get } from '@/lib/api'

// DEV-AI27-15 第二批（W15b UI）：工作视图"任务"页协作区（27 §11.3.1）。
// 折叠态：仅显示"N 项进行中 / M 项完成"；展开态：子任务名称/状态/单项停止。
// 数据来自 GET /agent/runs/{root_run_id}/delegations（本人过滤已由服务端保证）；
// 无活动委派组时不渲染（不伪造协作状态）。主消息流的分工摘要与汇总不在本组件范围。

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
}

export interface DelegationGroupView {
  id: string
  conversation_id: string
  root_run_id: string
  current_parent_run_id: string
  state: string
  cancel_generation: number
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

export function DelegationPanel({ conversationId, onStopped }: { conversationId: string; onStopped?: () => void }) {
  const [groups, setGroups] = useState<DelegationGroupView[]>([])
  const [expanded, setExpanded] = useState(false)
  const [stopping, setStopping] = useState('')
  const [error, setError] = useState('')

  const reload = useCallback(async () => {
    try {
      // 按会话全部活动 run 找委派组：服务端按 root/current_parent_run 查询，这里
      // 直接用最近委派组查询入口（runs/{id} 需 run id；会话维度用列表页面的委派快照）。
      // 简化：取当前会话活动 run（detail.active_run）由父组件传入 is limited；
      // 本组件直接轮询 bootstrap 后最近 run——由调用方保证 conversationId 有效。
      const detail = await get<{ active_run?: { id: string } | null }>(`/agent/conversations/${conversationId}`)
      const runID = detail.active_run?.id
      if (!runID) {
        setGroups([])
        return
      }
      const result = await get<{ groups: DelegationGroupView[] }>(`/agent/runs/${runID}/delegations`)
      setGroups(result.groups)
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [conversationId])

  useEffect(() => {
    if (!conversationId) return
    void reload()
    const timer = setInterval(() => void reload(), 5000)
    return () => clearInterval(timer)
  }, [conversationId, reload])

  const stopOne = useCallback(async (delegationID: string) => {
    setStopping(delegationID)
    try {
      await fetch(`/api/v1/agent/delegations/${delegationID}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }).then(async (r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`) })
      await reload()
      onStopped?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setStopping('')
    }
  }, [reload, onStopped])

  if (!groups.length) return null
  const all = groups.flatMap((g) => g.delegations)
  const active = all.filter((d) => ['queued', 'running', 'waiting_user', 'cancelling'].includes(d.state))
  const done = all.filter((d) => ['succeeded', 'failed', 'cancelled', 'expired'].includes(d.state))
  if (!all.length) return null

  return <section className="mt-4 rounded-xl border border-mist-200 bg-white p-3" data-testid="delegation-panel">
    <button type="button" className="flex w-full items-center justify-between text-left"
      aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
      <span className="text-[13px] font-semibold text-ink-700">
        协作任务（{active.length} 项进行中 / {done.length} 项完成）
      </span>
      {expanded ? <ChevronDown className="size-4 text-mist-400" /> : <ChevronRight className="size-4 text-mist-400" />}
    </button>
    {error && <p className="mt-1 text-xs text-danger" role="alert">{error}</p>}
    {expanded && <ul className="mt-2 space-y-2">
      {all.map((d) => <li key={d.id} className="rounded-lg border border-mist-100 p-2" data-testid={`delegation-${d.id}`} data-state={d.state}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-[13px] text-ink-700">{d.task}</p>
            <p className={`mt-0.5 text-xs ${stateTone[d.state] ?? 'text-mist-500'}`}>
              {stateLabels[d.state] ?? d.state}
              {d.state === 'running' && <LoaderCircle className="ml-1 inline size-3 animate-spin" aria-hidden="true" />}
              {d.state === 'succeeded' && d.result_summary && <span className="ml-1 text-mist-500">· {d.result_summary.slice(0, 80)}</span>}
              {d.error_code && <span className="ml-1 text-danger">· {d.error_code}</span>}
            </p>
          </div>
          {['queued', 'running', 'waiting_user'].includes(d.state) &&
            <Button size="sm" variant="ghost" disabled={stopping === d.id}
              aria-label={`停止子任务：${d.task}`}
              onClick={() => void stopOne(d.id)}>
              <Square className="size-3.5" />{stopping === d.id ? '停止中' : '停止'}
            </Button>}
        </div>
      </li>)}
    </ul>}
  </section>
}
