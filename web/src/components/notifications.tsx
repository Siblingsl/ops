import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, Loader2 } from 'lucide-react'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { errorMessage, get, post } from '@/lib/api'
import type { AIJob, AppNotification } from '@/lib/types'
import { usePageVisible } from '@/lib/visibility'
import { cn } from './ui'

type NotiList = { items: AppNotification[]; unread: number; active_jobs: number; next_cursor: string | null }
const NotificationPanel = lazy(() => import('./notification-panel'))

/** useNotificationStream refetches notifications whenever the server pushes "changed" (S3：通知改 SSE); returns whether the stream is live. */
function useNotificationStream(visible: boolean) {
  const qc = useQueryClient()
  const [live, setLive] = useState(false)
  useEffect(() => {
    if (!visible || typeof EventSource === 'undefined') return
    let alive = true
    let es: EventSource | null = null
    let retry: number | undefined
    let retryAttempt = 0
    let retriedImmediately = false
    const open = () => {
      if (!alive || document.hidden) return
      const source = new EventSource('/api/v1/notifications/stream')
      es = source
      source.onopen = () => {
        if (!alive || document.hidden || es !== source) return
        retryAttempt = 0
        retriedImmediately = false
        setLive(true)
      }
      source.addEventListener('changed', () => {
        if (!alive || document.hidden || es !== source) return
        void qc.invalidateQueries({ queryKey: ['notifications'] })
        void qc.invalidateQueries({ queryKey: ['ai-jobs'] })
      })
      source.onerror = () => {
        if (!alive || es !== source) return
        setLive(false)
        source.close()
        es = null
        if (document.hidden) return
        if (!retriedImmediately) {
          retriedImmediately = true
          open()
          return
        }
        const delay = Math.min(60_000, 1000 * 2 ** retryAttempt)
        retryAttempt = Math.min(retryAttempt + 1, 6)
        retry = window.setTimeout(() => {
          retry = undefined
          open()
        }, Math.floor(delay * (0.8 + Math.random() * 0.2)))
      }
    }
    const online = () => {
      if (!alive || document.hidden) return
      window.clearTimeout(retry)
      retry = undefined
      if (es) {
        es.onopen = null
        es.onerror = null
        es.close()
        es = null
      }
      retryAttempt = 0
      retriedImmediately = false
      setLive(false)
      open()
    }
    window.addEventListener('online', online)
    open()
    return () => {
      alive = false
      window.removeEventListener('online', online)
      if (es) { es.onopen = null; es.onerror = null }
      es?.close()
      window.clearTimeout(retry)
      setLive(false)
    }
  }, [qc, visible])
  return live
}

export function NotificationBell() {
  const visible = usePageVisible()
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<'noti' | 'jobs'>('noti')
  const ref = useRef<HTMLDivElement>(null)
  const nav = useNavigate()
  const qc = useQueryClient()
  const live = useNotificationStream(visible)
  const noti = useInfiniteQuery({
    queryKey: ['notifications'],
    queryFn: ({ pageParam }) => get<NotiList>(`/notifications${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ''}`),
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: visible,
    staleTime: 0,
    refetchInterval: visible ? (live ? 120_000 : 30_000) : false,
  })
  const jobs = useQuery({
    queryKey: ['ai-jobs'],
    queryFn: () => get<AIJob[]>('/ai-jobs'),
    enabled: visible && open && tab === 'jobs',
    staleTime: 0,
    refetchInterval: visible && open && tab === 'jobs' ? 4000 : false,
  })
  useEffect(() => {
    if (visible) {
      void noti.refetch({ cancelRefetch: false })
      if (open && tab === 'jobs') void jobs.refetch({ cancelRefetch: false })
    }
  }, [visible, noti.refetch, jobs.refetch])
  const [now, setNow] = useState(() => Date.now())
  const ticking = visible && open && tab === 'jobs' && (jobs.data ?? []).some((j) => j.status === 'running' || j.status === 'queued')
  useEffect(() => {
    if (!ticking) return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [ticking])
  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false)
    const show = () => { setTab('noti'); setOpen(true); window.dispatchEvent(new CustomEvent('ops:overlay', { detail: 'notifications' })) }
    const exclusive = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== 'notifications') setOpen(false)
    }
    document.addEventListener('mousedown', h)
    window.addEventListener('ops:notifications', show)
    window.addEventListener('ops:overlay', exclusive)
    return () => {
      document.removeEventListener('mousedown', h)
      window.removeEventListener('ops:notifications', show)
      window.removeEventListener('ops:overlay', exclusive)
    }
  }, [])
  const notificationItems = noti.data?.pages.flatMap((page) => page.items) ?? []
  const unread = noti.data?.pages[0]?.unread ?? 0
  const active = noti.data?.pages[0]?.active_jobs ?? 0
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
  const markAllRead = async () => {
    await post('/notifications/read-all')
    void noti.refetch()
  }
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((v) => { if (!v) window.dispatchEvent(new CustomEvent('ops:overlay', { detail: 'notifications' })); return !v })} title="通知与 AI 任务"
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
        <Suspense fallback={null}>
          <NotificationPanel
            tab={tab}
            onTabChange={setTab}
            unread={unread}
            active={active}
            notifications={notificationItems}
            jobs={jobs.data ?? []}
            now={now}
            onMarkAllRead={() => void markAllRead()}
            onNotificationClick={(notification) => void go(notification)}
            onJobClick={(job) => { setOpen(false); nav(job.link) }}
            onCancel={(job) => void cancel(job)}
            hasNextPage={noti.hasNextPage}
            isFetchingNextPage={noti.isFetchingNextPage}
            onLoadMore={() => { void noti.fetchNextPage() }}
          />
        </Suspense>
      )}
    </div>
  )
}
