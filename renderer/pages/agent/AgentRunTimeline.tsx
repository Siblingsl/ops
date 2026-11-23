import { ChevronDown, LoaderCircle } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { AgentAction, AgentPlan, AgentToolCall } from '@/lib/agent'
import { buildRunTimeline, formatDuration } from '@/lib/agent-ui.js'

// FN-03：运行轨迹是业务步骤组，不是思维链；成功折叠、失败展开，不展示工具参数。
export function AgentRunTimeline({ toolCalls, actions, plan, runId }: {
  toolCalls: AgentToolCall[]
  actions: AgentAction[]
  plan?: AgentPlan | null
  runId: string
}) {
  const timeline = useMemo(() => buildRunTimeline({ plan, toolCalls, actions }), [plan, toolCalls, actions])
  const [open, setOpen] = useState<boolean | null>(null)
  if (!timeline) return null
  const expanded = open === null ? timeline.status !== 'done' : open
  const id = `agent-run-timeline-${runId}`
  return <div className={`desktop-agent-timeline is-${timeline.status}`}>
    <button type="button" className="desktop-agent-timeline-head" aria-expanded={expanded} aria-controls={id}
      onClick={() => setOpen((value) => !(value === null ? timeline.status !== 'done' : value))}>
      {timeline.status === 'running' ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
        : <ChevronDown className={`size-4 ${expanded ? '' : '-rotate-90'}`} aria-hidden="true" />}
      <span>{timeline.title}</span>
      {timeline.status === 'failed' && <em>有失败步骤</em>}
      {timeline.status === 'waiting' && <em>待你处理</em>}
    </button>
    <div id={id} aria-hidden={!expanded} className={`desktop-agent-timeline-body ${expanded ? 'is-open' : ''}`}>
      <div className="desktop-agent-timeline-inner">
        {timeline.rows.map((row, index) => <div key={row.id} className="desktop-agent-timeline-row" data-status={row.status}>
          <span className="desktop-agent-timeline-index" aria-hidden="true">{index + 1}</span>
          <span className="desktop-agent-timeline-title">{row.title}</span>
          {row.count > 0 && <span className="desktop-agent-timeline-count">{row.count} 项</span>}
          {row.durationMs > 0 && row.status !== 'running' && <span className="desktop-agent-timeline-time">{formatDuration(row.durationMs)}</span>}
          <span className="desktop-agent-timeline-state" data-status={row.status}>
            {{ running: '进行中', done: '完成', failed: '失败', waiting: '待你处理', pending: '未开始', completed: '完成', skipped: '已跳过', in_progress: '进行中', waiting_user: '待你处理' }[row.status] || row.status}
          </span>
          {expanded && row.objects.length > 0 && <span className="desktop-agent-timeline-objects">
            {row.objects.map((object) => <span key={`${object.domain || ''}:${object.id}`} className="desktop-agent-timeline-object">{object.label}</span>)}
          </span>}
        </div>)}
      </div>
    </div>
  </div>
}
