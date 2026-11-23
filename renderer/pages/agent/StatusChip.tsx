import { cn } from '@/components/ui'
import type { StatusTone } from '@/lib/agent-ui.js'

const toneClass: Record<string, string> = {
  running: 'desktop-agent-chip-running',
  waiting: 'desktop-agent-chip-waiting',
  paused: 'desktop-agent-chip-paused',
  blocked: 'desktop-agent-chip-blocked',
  done: 'desktop-agent-chip-done',
  failed: 'desktop-agent-chip-failed',
  muted: 'desktop-agent-chip-muted',
  unread: 'desktop-agent-chip-muted',
}

export function StatusChip({ tone = 'muted', label, count, className, title }: { tone?: StatusTone | string; label: string; count?: number; className?: string; title?: string }) {
  if (!label) return null
  const text = typeof count === 'number' && count > 0 && !label.includes(String(count)) ? `${label} ${count}` : label
  return <span className={cn('desktop-agent-chip', toneClass[tone] || toneClass.muted, className)} title={title} data-tone={tone}>
    <span className="desktop-agent-chip-dot" aria-hidden="true" />{text}
  </span>
}

export function InlineDot({ tone = 'muted' }: { tone?: StatusTone | string }) {
  return <span className={cn('desktop-agent-row-dot', `desktop-agent-row-dot-${tone}`)} aria-hidden="true" />
}
