import { AlertTriangle, Inbox, LoaderCircle, Lock } from 'lucide-react'
import { type ReactNode } from 'react'

export type StateTone = 'empty' | 'loading' | 'error' | 'disabled'

// UI-10：空/加载/失败/禁用四态统一。禁用保留文字，45% 透明度，原因写在 tooltip 与说明里。
export function StateBlock({ tone, title, desc, action, requestId, disabledReason }: {
  tone: StateTone
  title: string
  desc?: string
  action?: ReactNode
  requestId?: string
  disabledReason?: string
}) {
  const icon = tone === 'loading' ? <LoaderCircle className="size-5 animate-spin" aria-hidden="true" />
    : tone === 'error' ? <AlertTriangle className="size-5" aria-hidden="true" />
      : tone === 'disabled' ? <Lock className="size-5" aria-hidden="true" />
        : <Inbox className="size-5" aria-hidden="true" />
  return <div className={`desktop-agent-state desktop-agent-state-${tone}`} role={tone === 'error' ? 'alert' : 'status'} title={tone === 'disabled' ? disabledReason || desc : undefined}>
    <span className="desktop-agent-state-icon">{icon}</span>
    <div className="desktop-agent-state-text">
      <strong>{title}</strong>
      {desc && <p>{desc}</p>}
      {requestId && <p className="desktop-agent-state-request">请求 ID：<code>{requestId}</code></p>}
    </div>
    {action && <div className="desktop-agent-state-action">{action}</div>}
  </div>
}
