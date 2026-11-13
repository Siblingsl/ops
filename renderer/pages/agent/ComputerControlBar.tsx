// DEV-CU P5-4：电脑控制条（AI 操作所选应用时的常驻状态与三个人工入口）。
// 状态来源：服务端租约（listGrants）+ 命令账本（commands）+ 能力快照（capabilities）；
// 不在前端臆造「已接管/已停止」——接管与停止都以服务端回包为准。
import { useEffect, useState } from 'react'
import { post } from '@/lib/api'
import {
  computerApi,
  computerErrorHint,
  type ComputerCapabilities,
  type ComputerGrantView,
} from '@/lib/computer-api'

export type ComputerControlPhase =
  | 'observing'
  | 'acting'
  | 'waiting_confirmation'
  | 'human_owned'
  | 'stopping'
  | 'disconnected'
  | 'unsupported'

const PHASE_COPY: Record<ComputerControlPhase, { label: string; detail: string }> = {
  observing: { label: '观察中', detail: 'AI 正在读取所选应用的可交互元素，不会写入。' },
  acting: { label: '正在操作', detail: 'AI 正在执行一条已确认的动作。' },
  waiting_confirmation: { label: '等待你确认', detail: '有一条电脑操作卡等待你逐张确认。' },
  human_owned: { label: '已由你接管', detail: '前台租约已撤销，AI 不再操作；需要时重新选择应用。' },
  stopping: { label: '正在停止', detail: '正在撤销租约并停止当前任务。' },
  disconnected: { label: '连接已断开', detail: '前台变化、锁屏或设备离线；已停止接收新输入。' },
  unsupported: { label: '当前界面不支持自动操作', detail: '可以人工接管后继续，不会把整个产品收缩为白名单应用。' },
}

/** 纯派生：优先级 = 不支持 > 人工覆盖 > 租约撤销 > 断线 > 待确认 > 操作中 > 观察。 */
export function computerControlPhase(input: {
  capabilities?: ComputerCapabilities
  grant?: ComputerGrantView
  acting?: boolean
  override?: 'human_owned' | 'stopping' | ''
}): ComputerControlPhase {
  if (input.capabilities && input.capabilities.available === false) return 'unsupported'
  if (input.override === 'stopping') return 'stopping'
  if (input.override === 'human_owned') return 'human_owned'
  if (input.grant?.state === 'revoking') return 'human_owned'
  const device = input.capabilities?.device_state ?? ''
  const foreground = input.capabilities?.foreground_state ?? ''
  if (['offline', 'disconnected', 'lost'].includes(device) || ['lost', 'background'].includes(foreground)) {
    return 'disconnected'
  }
  if (input.grant?.state === 'pending') return 'waiting_confirmation'
  if (input.acting) return 'acting'
  return 'observing'
}

export function ComputerControlBar({ enabled, conversationId, runId, onReturnChat }: {
  enabled: boolean
  conversationId?: string
  runId?: string
  onReturnChat: () => void
}) {
  const [capabilities, setCapabilities] = useState<ComputerCapabilities>()
  const [grant, setGrant] = useState<ComputerGrantView>()
  const [acting, setActing] = useState(false)
  const [override, setOverride] = useState<'human_owned' | 'stopping' | ''>('')
  const [reload, setReload] = useState(0)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!enabled || !conversationId) return
    let alive = true
    const load = async () => {
      try {
        const [caps, grants] = await Promise.all([
          computerApi.capabilities(),
          computerApi.listGrants(conversationId),
        ])
        if (!alive) return
        setCapabilities(caps)
        const candidates = grants.grants
          .filter((item) => item.scope === 'act' && ['pending', 'active', 'revoking'].includes(item.state))
          .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
        setGrant(candidates[0])
        if (runId && candidates[0]) {
          const commands = await computerApi.commands(runId)
          if (alive) setActing(commands.commands.some((item) => ['queued', 'dispatched'].includes(item.state)))
        } else if (alive) {
          setActing(false)
        }
      } catch (e) {
        if (alive) setError(computerErrorHint(e) || '无法读取电脑控制状态')
      }
    }
    void load()
    const timer = window.setInterval(() => { void load() }, 5000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [enabled, conversationId, runId, reload])

  if (!enabled || !conversationId || !grant) return null
  const phase = computerControlPhase({ capabilities, grant, acting, override })
  const copy = PHASE_COPY[phase]
  const reason = phase === 'unsupported' ? (capabilities?.reason || '') : ''

  const handoff = async () => {
    if (!grant || override) return
    setOverride('human_owned')
    setError('')
    try {
      await computerApi.handoff(grant.id)
      setReload((value) => value + 1)
    } catch (e) {
      setOverride('')
      setError(computerErrorHint(e) || '接管失败，请重试')
    }
  }

  const stop = async () => {
    if (override) return
    setOverride('stopping')
    setError('')
    try {
      // 取消任务与撤销租约是两件事：任务可能已结束（404），租约仍必须撤。
      if (runId) {
        try { await post(`/agent/runs/${runId}/cancel`, {}) } catch { /* 已结束的任务无须再取消 */ }
      }
      await computerApi.revoke(grant.id)
      setReload((value) => value + 1)
    } catch (e) {
      setOverride('')
      setError(computerErrorHint(e) || '停止失败，请重试')
    } finally {
      setOverride('')
    }
  }

  return <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm" data-testid="computer-control-bar">
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-medium">AI 正在操作所选应用</span>
      <span data-testid="computer-control-state" data-phase={phase}>{copy.label}</span>
      <span className="text-neutral-600">{grant.target_summary}</span>
    </div>
    <p className="mt-1 text-neutral-600" data-testid="computer-control-detail">
      {phase === 'unsupported' && reason ? `原因：${reason}。可人工接管后继续。` : copy.detail}
    </p>
    {error && <p className="mt-1 text-red-600" data-testid="computer-control-error">{error}</p>}
    <div className="mt-2 flex flex-wrap gap-2">
      <button type="button" className="rounded border px-2 py-1" onClick={() => void handoff()} disabled={!!override}>
        接管
      </button>
      <button type="button" className="rounded border px-2 py-1" onClick={() => void stop()} disabled={!!override}>
        停止任务
      </button>
      <button type="button" className="rounded border px-2 py-1" onClick={onReturnChat}>
        返回聊天
      </button>
    </div>
  </div>
}
