import { CheckCheck, Square } from 'lucide-react'
import { relTime } from '@/lib/format'
import type { AIJob, AppNotification } from '@/lib/types'
import { Badge, Button, cn, Tabs } from './ui'

const jobStatus: Record<AIJob['status'], { label: string; tone: 'gray' | 'ink' | 'green' | 'red' | 'gamboge' }> = {
  queued: { label: '排队中', tone: 'gray' },
  running: { label: '进行中', tone: 'ink' },
  done: { label: '已完成', tone: 'green' },
  failed: { label: '失败', tone: 'red' },
  cancelled: { label: '已取消', tone: 'gray' },
  interrupted: { label: '已中断', tone: 'gamboge' },
}

function elapsed(from: string | null, now: number) {
  if (!from) return ''
  const s = Math.max(0, Math.round((now - new Date(from).getTime()) / 1000))
  return s < 60 ? `已运行 ${s} 秒` : `已运行 ${Math.floor(s / 60)} 分 ${s % 60} 秒`
}

export default function NotificationPanel({
  tab,
  onTabChange,
  unread,
  active,
  notifications,
  jobs,
  now,
  onMarkAllRead,
  onNotificationClick,
  onJobClick,
  onCancel,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
}: {
  tab: 'noti' | 'jobs'
  onTabChange: (tab: 'noti' | 'jobs') => void
  unread: number
  active: number
  notifications: AppNotification[]
  jobs: AIJob[]
  now: number
  onMarkAllRead: () => void
  onNotificationClick: (notification: AppNotification) => void
  onJobClick: (job: AIJob) => void
  onCancel: (job: AIJob) => void
  hasNextPage: boolean
  isFetchingNextPage: boolean
  onLoadMore: () => void
}) {
  return (
    <div className="absolute right-0 top-[calc(100%+8px)] z-40 w-[360px] max-w-[92vw] animate-fade-in rounded-xl border border-mist-200 bg-white shadow-pop">
      <div className="flex items-center justify-between border-b border-mist-100 px-3 py-2">
        <Tabs value={tab} onChange={onTabChange} items={[{ value: 'noti', label: '通知', count: unread || undefined }, { value: 'jobs', label: 'AI 任务', count: active || undefined }]} />
        {tab === 'noti' && unread > 0 && (
          <button type="button" className="inline-flex cursor-pointer items-center gap-1 text-[12px] text-mist-500 hover:text-ink-700"
            onClick={onMarkAllRead}>
            <CheckCheck className="size-3.5" />全部标为已读
          </button>
        )}
      </div>
      <div className="scrollbar-thin max-h-[60vh] overflow-y-auto p-1.5">
        {tab === 'noti' ? (
          notifications.length === 0 ? <p className="py-10 text-center text-[13px] text-mist-400">暂无通知</p> : (
            notifications.map((n) => (
              <button key={n.id} type="button" onClick={() => onNotificationClick(n)}
                className={cn('flex w-full cursor-pointer gap-2.5 rounded-lg px-2.5 py-2 text-left transition hover:bg-mist-50', !n.read_at && 'bg-ink-50/40')}>
                <span className={cn('mt-1.5 size-1.5 shrink-0 rounded-full', n.read_at ? 'bg-transparent' : 'bg-ink-500')} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium text-mist-800">{n.title}</span>
                  {n.body && <span className="mt-0.5 block text-[12px] leading-relaxed text-mist-500">{n.body}</span>}
                  <span className="mt-0.5 block text-[11px] text-mist-400">{relTime(n.created_at)}</span>
                </span>
              </button>
            ))
          )
        ) : (
          jobs.length === 0 ? <p className="py-10 text-center text-[13px] text-mist-400">最近没有 AI 任务。关闭页面不会中断正在生成的内容，完成后会在这里和通知里提醒你。</p> : (
            jobs.map((j) => (
              <div key={j.id} className="flex items-start gap-2.5 rounded-lg px-2.5 py-2 hover:bg-mist-50">
                <div className="min-w-0 flex-1">
                  <button type="button" disabled={!j.link} onClick={() => onJobClick(j)}
                    className="block max-w-full cursor-pointer truncate text-left text-[13px] font-medium text-mist-800 hover:text-ink-700 disabled:cursor-default">
                    {j.label}
                  </button>
                  <div className="mt-0.5 flex items-center gap-2 text-[11px] text-mist-400">
                    <Badge tone={jobStatus[j.status].tone}>{jobStatus[j.status].label}</Badge>
                    {j.status === 'running' ? elapsed(j.started_at, now) : relTime(j.created_at)}
                  </div>
                  {(j.status === 'running' || j.status === 'queued') && (
                    <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-mist-100">
                      <div className={cn('h-full rounded-full', j.status === 'running' ? 'w-1/3 animate-[progress_1.6s_ease-in-out_infinite] bg-ink-500' : 'w-full bg-mist-200')} />
                    </div>
                  )}
                  {j.error && <p className="mt-0.5 text-[11.5px] text-orange-600">{j.error}</p>}
                </div>
                {(j.status === 'running' || j.status === 'queued') && (
                  <button type="button" title="停止" onClick={() => onCancel(j)} className="cursor-pointer rounded p-1 text-mist-400 hover:bg-mist-100 hover:text-danger">
                    <Square className="size-3.5" />
                  </button>
                )}
              </div>
            ))
          )
        )}
      </div>
      {tab === 'noti' && hasNextPage && <div className="border-t border-mist-100 p-2 text-center"><Button size="sm" variant="ghost" loading={isFetchingNextPage} onClick={onLoadMore}>加载更多</Button></div>}
    </div>
  )
}
