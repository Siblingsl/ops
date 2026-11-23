import { ChevronDown } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui'
import type { AgentAction, AgentQuestion } from '@/lib/agent'

// FN-02：待你处理中心——任务页顶部的统一待处理列表（卡片/问题/权限请求），
// 每条可“定位”到消息并高亮 1.5s；空时不渲染该块；最多 5 条 + 查看全部。
export type PendingEntry = {
  id: string
  kind: 'action' | 'question'
  label: string
  detail: string
  expired: boolean
}

export function collectPendingEntries(actions: AgentAction[], questions: AgentQuestion[]): PendingEntry[] {
  const now = Date.now()
  const entries: PendingEntry[] = []
  for (const action of actions) {
    if (action.status !== 'pending' && action.status !== 'needs_input') continue
    entries.push({
      id: action.id,
      kind: 'action',
      label: action.title || action.tool_name,
      detail: action.status === 'needs_input' ? '需要补充信息' : action.gate ? '需要人工确认' : '等待审阅',
      expired: Boolean(action.expires_at && now >= new Date(action.expires_at).getTime()),
    })
  }
  for (const question of questions) {
    if (question.status !== 'pending') continue
    entries.push({
      id: question.id,
      kind: 'question',
      label: question.items[0]?.title || '待回答问题',
      detail: question.items.length > 1 ? `${question.items.length} 个小项` : question.items[0]?.required ? '必答' : '可跳过',
      expired: now >= new Date(question.expires_at).getTime(),
    })
  }
  return entries
}

export function PendingList({ entries }: { entries: PendingEntry[] }) {
  const [expanded, setExpanded] = useState(false)
  if (!entries.length) return null
  const visible = expanded ? entries : entries.slice(0, 5)
  return <section className="desktop-agent-pending" aria-label={`待你处理 ${entries.length} 项`} data-testid="agent-pending-list">
    <h4>待你处理 {entries.length}</h4>
    <ul>
      {visible.map((entry) => <li key={`${entry.kind}:${entry.id}`} className={entry.expired ? 'is-expired' : ''}>
        <span className="desktop-agent-pending-kind" data-kind={entry.kind}>{entry.kind === 'action' ? '卡片' : '问题'}</span>
        <span className="desktop-agent-pending-label" title={entry.label}>{entry.label}</span>
        <span className="desktop-agent-pending-detail">{entry.expired ? '已过期，只能关闭' : entry.detail}</span>
        {entry.kind === 'action' && !entry.expired && <button type="button" className="desktop-agent-pending-locate" onClick={() => {
          const card = document.getElementById(`agent-action-${entry.id}`)
          card?.scrollIntoView({ behavior: 'smooth', block: 'center' })
          card?.focus({ preventScroll: true })
          card?.setAttribute('data-highlight', '1.5s')
          window.setTimeout(() => card?.removeAttribute('data-highlight'), 1_500)
        }}>定位</button>}
      </li>)}
    </ul>
    {entries.length > 5 && <Button type="button" size="sm" variant="ghost" onClick={() => setExpanded((value) => !value)}>
      {expanded ? '收起' : `查看全部 ${entries.length} 条`} <ChevronDown className={`size-3.5 ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" />
    </Button>}
  </section>
}
