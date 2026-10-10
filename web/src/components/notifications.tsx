import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, CheckCheck, Loader2, Square } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { errorMessage, get, post } from '@/lib/api'
import { relTime } from '@/lib/format'
import type { AIJob, AppNotification } from '@/lib/types'
import { Badge, cn, Tabs } from './ui'

type NotiList = { items: AppNotification[]; unread: number; active_jobs: number }

const jobStatus: Record<AIJob['status'], { label: string; tone: 'gray' | 'ink' | 'green' | 'red' | 'gamboge' }> = {
  queued: { label: '排队中', tone: 'gray' },
  running: { label: '进行中', tone: 'ink' },
  done: { label: '已完成', tone: 'green' },
  failed: { label: '失败', tone: 'red' },
  cancelled: { label: '已取消', tone: 'gray' },
  interrupted: { label: '已中断', tone: 'gamboge' },
}

/** useNotificationStream refetches notifications whenever the server pushes "changed" (S3：通知改 SSE); returns whether the stream is live. */
function useNotificationStream() {
  const qc = useQueryClient()
  const [live, setLive] = useState(false)
  useEffect(() => {
    if (typeof EventSource === 'undefined') return
    let es: EventSource | null = null
    let retry: number | undefined
    const open = () => {
      es = new EventSource('/api/v1/notifications/stream')
      es.onopen = () => setLive(true)
      es.addEventListener('changed', () => {
        void qc.invalidateQueries({ queryKey: ['notifications'] })
        void qc.invalidateQueries({ queryKey: ['ai-jobs'] })
      })
      es.onerror = () => {
        setLive(false)
        es?.close()
        retry = window.setTimeout(open, 15_000)
      }
    }
    open()
    return () => {
      es?.close()
      window.clearTimeout(retry)
    }
  }, [qc])
  return live
}

function elapsed(from: string | null, now: number) {
  if (!from) return ''
  const s = Math.max(0, Math.round((now - new Date(from).getTime()) / 1000))
  return s < 60 ? `已运行 ${s} 秒` : `已运行 ${Math.floor(s / 60)} 分 ${s % 60} 秒`
}

export function NotificationBell() {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<'noti' | 'jobs'>('noti')
  const ref = useRef<HTMLDivElement>(null)
  const nav = useNavigate()
  const qc = useQueryClient()
  const live = useNotificationStream()
  const noti = useQuery({ queryKey: ['notifications'], queryFn: () => get<NotiList>('/notifications'), refetchInterval: live ? 120_000 : 30_000 })
  const jobs = useQuery({
    queryKey: ['ai-jobs'],
    queryFn: () => get<AIJob[]>('/ai-jobs'),
    enabled: open && tab === 'jobs',
    refetchInterval: open && tab === 'jobs' ? 4000 : false,
  })
  const [now, setNow] = useState(() => Date.now())
  const ticking = open && tab === 'jobs' && (jobs.data ?? []).some((j) => j.status === 'running' || j.status === 'queued')
  useEffect(() => {
    if (!ticking) return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [ticking])
  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false)
    const show = () => { setTab('noti'); setOpen(true) }
    document.addEventListener('mousedown', h)
    window.addEventListener('ops:notifications', show)
    return () => {
      document.removeEventListener('mousedown', h)
      window.removeEventListener('ops:notifications', show)
    }
  }, [])
  const unread = noti.data?.unread ?? 0
  const active = noti.data?.active_jobs ?? 0
  const go = async (n: AppNotification) => {
    if (!n.read_at) await post(`/notifications/${n.id}/read`).catch(() => undefined)
    void qc.invalidateQueries({ queryKey: ['notifications'] })
    setOpen(false)
    if (n.link) nav(n.link)
  }
  const cancel = async (j: AIJob) => {
    try {
      await post(`/ai-jobs/${j.id}/cancel`)
      void jobs.refetch()
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)} title="通知与 AI 任务"
        className={cn('relative flex size-9 cursor-pointer items-center justify-center rounded-full border bg-white text-mist-600 transition hover:text-mist-900',
          open ? 'border-ink-300 shadow-card' : 'border-mist-200 hover:border-mist-300')}>
        {active > 0 ? <Loader2 className="size-4 animate-spin text-ink-600" /> : <Bell className="size-4" />}
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-xhs px-1 text-[10px] font-bold text-white">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-[calc(100%+8px)] z-40 w-[360px] max-w-[92vw] animate-fade-in rounded-xl border border-mist-200 bg-white shadow-pop">
          <div className="flex items-center justify-between border-b border-mist-100 px-3 py-2">
            <Tabs value={tab} onChange={setTab} items={[{ value: 'noti', label: '通知', count: unread || undefined }, { value: 'jobs', label: 'AI 任务', count: active || undefined }]} />
            {tab === 'noti' && unread > 0 && (
              <button type="button" className="inline-flex cursor-pointer items-center gap-1 text-[12px] text-mist-500 hover:text-ink-700"
                onClick={async () => { await post('/notifications/read-all'); void noti.refetch() }}>
                <CheckCheck className="size-3.5" />全部标为已读
              </button>
            )}
          </div>
          <div className="scrollbar-thin max-h-[60vh] overflow-y-auto p-1.5">
            {tab === 'noti' ? (
              (noti.data?.items ?? []).length === 0 ? <p className="py-10 text-center text-[13px] text-mist-400">暂无通知</p> : (
                noti.data!.items.map((n) => (
                  <button key={n.id} type="button" onClick={() => go(n)}
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
              (jobs.data ?? []).length === 0 ? <p className="py-10 text-center text-[13px] text-mist-400">最近没有 AI 任务。关闭页面不会中断正在生成的内容，完成后会在这里和通知里提醒你。</p> : (
                jobs.data!.map((j) => (
                  <div key={j.id} className="flex items-start gap-2.5 rounded-lg px-2.5 py-2 hover:bg-mist-50">
                    <div className="min-w-0 flex-1">
                      <button type="button" disabled={!j.link} onClick={() => { setOpen(false); nav(j.link) }}
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
                      <button type="button" title="停止" onClick={() => cancel(j)} className="cursor-pointer rounded p-1 text-mist-400 hover:bg-mist-100 hover:text-danger">
                        <Square className="size-3.5" />
                      </button>
                    )}
                  </div>
                ))
              )
            )}
          </div>
        </div>
      )}
    </div>
  )
}
