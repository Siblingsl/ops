import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, Loader2 } from 'lucide-react'
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { errorMessage, get, post } from '@/lib/api'
import { apiUrl } from '@/lib/api-base'
import { isElectronDesktop } from '@/lib/desktop-presentation.js'
import { useMe } from '@/lib/session'
import type { AIJob, AppNotification } from '@/lib/types'
import { usePageVisible } from '@/lib/visibility'
import { cn } from './ui'

type NotiList = { items: AppNotification[]; unread: number; active_jobs: number; next_cursor: string | null }
const NotificationPanel = lazy(() => import('./notification-panel'))

/** useNotificationStream refetches notifications whenever the server pushes "changed" (S3：通知改 SSE); returns whether the stream is live. */
function useNotificationStream(active: boolean, keepInBackground: boolean) {
  const qc = useQueryClient()
  const [live, setLive] = useState(false)
  useEffect(() => {
    if (!active || typeof EventSource === 'undefined') return
    let alive = true
    let es: EventSource | null = null
    let retry: number | undefined
    let retryAttempt = 0
    let retriedImmediately = false
    const open = () => {
      if (!alive || document.hidden && !keepInBackground) return
      // EventSource 不能带自定义头，跨源部署时只能靠 withCredentials 携带会话 Cookie（D-153）。
      const source = new EventSource(apiUrl('/notifications/stream'), { withCredentials: true })
      es = source
      source.onopen = () => {
        if (!alive || es !== source) return
        retryAttempt = 0
        retriedImmediately = false
        setLive(true)
      }
      source.addEventListener('changed', () => {
        if (!alive || es !== source) return
        void qc.invalidateQueries({ queryKey: ['notifications'] })
        void qc.invalidateQueries({ queryKey: ['ai-jobs'] })
      })
      source.onerror = () => {
        if (!alive || es !== source) return
        setLive(false)
        source.close()
        es = null
        if (document.hidden && !keepInBackground) return
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
      if (!alive || document.hidden && !keepInBackground) return
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
  }, [active, keepInBackground, qc])
  return live
}

export function NotificationBell({ sidebar = false, children }: { sidebar?: boolean; children?: (unread: number) => ReactNode }) {
  const visible = usePageVisible()
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<'noti' | 'jobs'>('noti')
  const ref = useRef<HTMLDivElement>(null)
  const nav = useNavigate()
  const location = useLocation()
  const qc = useQueryClient()
  const me = useMe()
  const nativeSupported = isElectronDesktop(navigator.userAgent) && typeof window !== 'undefined' && 'Notification' in window
  const notificationKey = me.data?.user_id && me.data.workspace.id
    ? `ops.agent-native-notifications.v1:${me.data.user_id}:${me.data.workspace.id}` : ''
  const [nativeEnabled, setNativeEnabled] = useState(false)
  useEffect(() => {
    setNativeEnabled(!!notificationKey && localStorage.getItem(notificationKey) === '1')
  }, [notificationKey])
  const live = useNotificationStream(visible || nativeEnabled, nativeEnabled)
  const noti = useInfiniteQuery({
    queryKey: ['notifications'],
    queryFn: ({ pageParam }) => get<NotiList>(`/notifications${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ''}`),
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: visible || nativeEnabled,
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
  const newestNotifications = useMemo(() => noti.data?.pages[0]?.items ?? [], [noti.data?.pages[0]?.items])
  const nativeSeen = useRef<{ key: string; ids: Set<string> } | null>(null)
  useEffect(() => {
    if (!noti.isSuccess) return
    const ids = newestNotifications.map((item) => item.id)
    if (nativeSeen.current === null || nativeSeen.current.key !== notificationKey) {
      nativeSeen.current = { key: notificationKey, ids: new Set(ids) }
      return
    }
    const previous = nativeSeen.current.ids
    for (const item of newestNotifications) {
      if (previous.has(item.id)) continue
      previous.add(item.id)
      if (!nativeEnabled || !nativeSupported || Notification.permission !== 'granted' || item.kind !== 'agent_goal') continue
      if (document.hasFocus() && location.pathname === item.link) continue
      const notice = new Notification('AI 对话有结果', { body: 'AI 对话有结果或需要处理' })
      notice.onclick = () => {
        window.focus()
        if (item.link) nav(item.link)
        notice.close()
      }
    }
  }, [location.pathname, nav, nativeEnabled, nativeSupported, newestNotifications, noti.isSuccess, notificationKey, visible])
  const unread = noti.data?.pages[0]?.unread ?? 0
  const active = noti.data?.pages[0]?.active_jobs ?? 0
  const go = async (n: AppNotification) => {
    if (!n.read_at) await post(`/notifications/${n.id}/read`).catch(() => undefined)
    void qc.invalidateQueries({ queryKey: ['notifications'] })
    setOpen(false)
    if (n.link) nav(n.link)
  }
  const enableNativeNotifications = async () => {
    if (!nativeSupported || !notificationKey) return
    const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission
    if (permission !== 'granted') {
      toast.info(permission === 'denied' ? '系统已阻止通知，请到应用权限设置中开启。' : '未开启桌面提示。')
      return
    }
    localStorage.setItem(notificationKey, '1')
    setNativeEnabled(true)
  }
  const disableNativeNotifications = () => {
    if (notificationKey) localStorage.removeItem(notificationKey)
    setNativeEnabled(false)
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
    <div ref={ref} className={cn('relative', sidebar && 'desktop-sidebar-notifications')}>
      {children ? children(unread) : <button type="button" onClick={() => setOpen((v) => { if (!v) window.dispatchEvent(new CustomEvent('ops:overlay', { detail: 'notifications' })); return !v })} title="通知与 AI 任务" aria-label="通知与 AI 任务" aria-expanded={open}
        className={cn('relative flex size-9 cursor-pointer items-center justify-center rounded-full border bg-white text-mist-600 transition hover:text-mist-900',
          open ? 'border-ink-300 shadow-card' : 'border-mist-200 hover:border-mist-300')}>
        {active > 0 ? <Loader2 className="size-4 animate-spin text-ink-600" /> : <Bell className="size-4" />}
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-xhs px-1 text-[10px] font-bold text-white">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>}
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
            nativeSupported={nativeSupported}
            nativePermission={nativeSupported ? Notification.permission : 'unsupported'}
            nativeEnabled={nativeEnabled}
            onEnableNative={() => void enableNativeNotifications()}
            onDisableNative={disableNativeNotifications}
          />
        </Suspense>
      )}
    </div>
  )
}
