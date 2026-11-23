import { Eye, Hand, Square } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { get } from '@/lib/api'

// BR-08 / 27 AI27-17：浏览器控制条（36 高）——目标、控制者、接管、停止。
// 状态全部来自真实运行与租约：没有活动租约时接管按钮禁用并说明原因，不伪造“已接管”。
export type BrowserControlActivity = { id: string; name: string; label: string }

const actionLabels: Record<string, string> = {
  browser_observe: '观察页面',
  browser_observe_frames: '观察子页面',
  browser_navigate: '打开网页',
  browser_click: '点击页面',
  browser_type: '输入内容',
  browser_extract: '读取页面',
  browser_screenshot: '截取页面',
  browser_get_context: '读取标签摘要',
}

export function BrowserControlBar({
  activity, step, paused, grantReady, busy, conversationId, onStop, onTakeOver, onHandBack,
}: {
  activity: BrowserControlActivity
  step: number
  paused: boolean
  grantReady: boolean
  busy: boolean
  conversationId?: string
  onStop: () => void
  onTakeOver: () => void
  onHandBack: () => void
}) {
  // BR-09：Agent 在后台标签操作时不抢前台。控制条只读展示“查看操作”，
  // 由用户点击后经本机桥 activate_tab 主动切换；模型没有这个动作入口。
  const [agentTabID, setAgentTabID] = useState<number | null>(null)
  useEffect(() => {
    let cancelled = false
    if (!conversationId || !grantReady) {
      setAgentTabID(null)
      return
    }
    void get<{ grant: { tab_handle?: string } | null }>(`/agent/conversations/${conversationId}/browser-grants`)
      .then((data) => {
        const handle = Number(data?.grant?.tab_handle)
        if (!cancelled) setAgentTabID(Number.isSafeInteger(handle) && handle > 0 ? handle : null)
      })
      .catch(() => { if (!cancelled) setAgentTabID(null) })
    return () => { cancelled = true }
  }, [conversationId, activity.id, grantReady])

  async function viewOperation() {
    if (agentTabID === null) return
    const result = await window.opsDesktopUI?.focusBrowserTab?.(agentTabID)
    if (!result) {
      toast.error('无法切换标签', { description: '需要 OPS 桌面端才能查看 Agent 正在操作的后台标签。' })
      return
    }
    if (!result.ok) toast.error('无法切换标签', { description: result.message })
  }

  const action = actionLabels[activity.name] ?? (activity.label || activity.name)
  return <div
    className="desktop-agent-browser-control flex h-9 shrink-0 items-center gap-2 border-b border-mist-200 bg-white px-3 text-[12px] text-mist-700"
    data-testid="browser-control-bar" role="status" aria-live="polite"
  >
    <span className="font-medium text-ink-800">{paused ? '你已接管' : 'Agent 控制中'}</span>
    <span className="min-w-0 flex-1 truncate">
      {paused ? 'Agent 已暂停，不会再操作这个标签。' : `正在操作获准标签 · ${action}${step > 0 ? ` · 第 ${step} 步` : ''}`}
    </span>
    {!paused && agentTabID !== null && <button
      type="button"
      className="shrink-0 rounded border border-mist-200 px-2 py-0.5 text-mist-700 hover:border-ink-300"
      data-testid="browser-control-view"
      title="把 Agent 正在操作的标签切到前台；不会改变 Agent 的操作目标"
      onClick={() => void viewOperation()}
    ><Eye className="mr-1 inline size-3" />查看操作</button>}
    {paused
      ? <button type="button" className="shrink-0 rounded border border-mist-200 px-2 py-0.5 text-mist-700 disabled:opacity-50"
        data-testid="browser-control-handback" onClick={onHandBack}>交回 Agent</button>
      : <button type="button" className="shrink-0 rounded border border-mist-200 px-2 py-0.5 text-mist-700 disabled:opacity-50"
        data-testid="browser-control-takeover" disabled={!grantReady}
        title={grantReady ? '暂停 Agent 并收回标签控制权' : '当前没有活动标签租约；先让 Agent 请求标签并授权'}
        onClick={onTakeOver}><Hand className="mr-1 inline size-3" />接管</button>}
    <button type="button" className="shrink-0 rounded border border-danger/40 px-2 py-0.5 text-danger"
      data-testid="browser-control-stop" aria-busy={busy} onClick={onStop}>
      <Square className="mr-1 inline size-3" />停止
    </button>
  </div>
}
