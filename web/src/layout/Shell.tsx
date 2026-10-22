import { useQueryClient } from '@tanstack/react-query'
import {
  Activity, BarChart3, Bell, BookOpen, Bot, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronsUpDown, Clock, Cpu, Eye, FileText, Gauge, Images, Inbox, KeyRound,
  LayoutDashboard, Lightbulb, LogOut, PanelLeft, Pencil, Plus, Power, ScrollText, Search, Send, Settings2, Shield, ShieldAlert, SlidersHorizontal, Sparkles, Trash2,
  UserCircle2, UserPlus, Users,
} from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { confirm } from '@/components/dialog'
import AccountCreateHost from './AccountCreateHost'
import { CommandPaletteHost } from '@/components/command-palette-host'
import { CreateWorkPanel } from '@/components/create-work-panel'
import { ErrorBoundary } from '@/components/error-boundary'
import { NotificationBell } from '@/components/notifications'
import { QuickCollect } from '@/components/quick-collect'
import { ThemeToggle } from '@/components/theme-toggle'
import { cn, Kbd, PlatformMark, platformLabel } from '@/components/ui'
import { del, errorMessage, post } from '@/lib/api'
import { isElectronDesktop } from '@/lib/desktop-presentation.js'
import { currentAccountSettingsPath, DESKTOP_ACCOUNT_CREATE_READY, DESKTOP_ACCOUNT_CREATE_REQUEST, DESKTOP_ACCOUNT_SWITCHER_READY, DESKTOP_ACCOUNT_SWITCHER_REQUEST, releaseDesktopLeaveGuard, requestDesktopLeaveGuard } from '@/lib/desktop-settings'
import { fmtTime } from '@/lib/format'
import { TodayUsage, useChromeMeta } from './today-usage'
import DesktopStatusBar from './DesktopStatusBar'
import { rememberAccount, useAccounts, useCurrentAccount, useInvalidate, useMe } from '@/lib/session'
import type { Account, Platform } from '@/lib/types'
import { setUXEnabled, usePrefs, useRecentWorks } from '@/lib/v3'
import { useAgentBootstrap } from '@/lib/agent'

const nav: { end?: boolean; path: string; icon: typeof LayoutDashboard; label: string; mobile?: string }[] = [
  { end: true, path: '', icon: LayoutDashboard, label: '工作台', mobile: '工作台' },
  { path: '/topics', icon: Lightbulb, label: '选题池', mobile: '选题' },
  { path: '/ops', icon: Activity, label: '运营' },
  { path: '/calendar', icon: CalendarDays, label: '内容日历', mobile: '日历' },
  { path: '/works', icon: FileText, label: '作品', mobile: '作品' },
  { path: '/materials', icon: BookOpen, label: '素材库', mobile: '素材' },
  { path: '/review', icon: BarChart3, label: '复盘' },
  { path: '/profile', icon: UserCircle2, label: '账号档案' },
]

const desktopNavGroups = [
  { label: '创作', items: [nav[0], nav[4], nav[1], nav[3]] },
  { label: '资源', items: [nav[5], { to: '/images', icon: Images, label: '图片库' }] },
  { label: '运营', items: [nav[2], nav[6], nav[7]] },
]

const mobileNav: { path: string; icon: typeof LayoutDashboard; label: string }[] = [
  { path: '', icon: LayoutDashboard, label: '工作台' },
  { path: '/topics?tab=inbox', icon: Inbox, label: '收件箱' },
  { path: '/works', icon: FileText, label: '作品' },
  { path: '/works?status=ready', icon: Send, label: '发布' },
]

const settingsItems: { to: string; icon: ReactNode; label: string; adminOnly?: boolean }[] = [
  { to: '/settings/preferences', icon: <SlidersHorizontal />, label: '偏好设置' },
  { to: '/settings/accounts', icon: <Users />, label: '平台账号与凭证' },
  { to: '/settings/members', icon: <Users />, label: '成员与邀请' },
  { to: '/settings/models', icon: <Cpu />, label: '模型配置' },
  { to: '/settings/agent', icon: <Bot />, label: '智能体设置' },
  { to: '/settings/usage', icon: <Gauge />, label: 'AI 用量与成本' },
  { to: '/settings/quality', icon: <Activity />, label: 'AI 质量看板' },
  { to: '/settings/words', icon: <ShieldAlert />, label: '敏感词库' },
  { to: '/settings/prompts', icon: <ScrollText />, label: '提示词模板' },
  { to: '/settings/export', icon: <Gauge />, label: '数据导出' },
  { to: '/settings/logs', icon: <ScrollText />, label: '操作日志' },
  { to: '/settings/trash', icon: <Trash2 />, label: '回收站' },
  { to: '/settings/security', icon: <KeyRound />, label: '登录与安全' },
  { to: '/settings/admin', icon: <Shield />, label: '系统管理', adminOnly: true },
  { to: '/settings/crawl', icon: <Activity />, label: '热点采集与日志', adminOnly: true },
  { to: '/settings/hot-sources', icon: <Activity />, label: '热点来源' },
 { to: '/settings/daily', icon: <Activity />, label: '每日推荐设置' },
]

const commonSettings = new Set(['/settings/accounts', '/settings/models', '/settings/members', '/settings/preferences'])

function Brand({ desktop }: { desktop: boolean }) {
  if (desktop) {
    // 品牌从标题栏下移到侧栏顶部：折叠态竖排（图标 + 文字），展开态横排，两态共用同一槽位居中。
    return (
      <div className="desktop-rail-brand">
        <span className="desktop-rail-brand-mark"><Sparkles aria-hidden="true" /></span>
        <span className="desktop-rail-brand-text">
          <span className="desktop-rail-brand-ops">OPS</span>
          <span className="desktop-rail-brand-name">灵感空间</span>
        </span>
      </div>
    )
  }
  return (
    <div className="flex h-14 shrink-0 items-center px-5">
      <div className="flex items-center gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-[14px] bg-ink-600 text-white shadow-[0_8px_20px_-10px_rgb(47_93_98/0.85)]">
          <svg viewBox="0 0 32 32" className="size-[22px]" aria-hidden>
            <path d="M9 22V10h6.5a4.5 4.5 0 010 9H12" stroke="currentColor" strokeWidth="2.6" fill="none" strokeLinecap="round" />
            <circle cx="22.5" cy="21.5" r="2.6" fill="#E0A526" />
          </svg>
        </div>
        <div className="min-w-0">
          <div className="font-display text-[17px] font-bold leading-tight tracking-tight text-mist-900">内容运营助手</div>
          <div className="mt-0.5 text-[11px] text-mist-400">写得清楚，发得合规</div>
        </div>
      </div>
    </div>
  )
}

function NavItem({ to, icon: Icon, children, end }: { to: string; icon: typeof LayoutDashboard; children: React.ReactNode; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      title={typeof children === 'string' ? children : undefined}
      className={({ isActive }) =>
        cn(
          'group flex items-center gap-3 rounded-2xl px-3 py-2.5 text-[14.5px] transition-all',
          isActive
            ? 'bg-ink-600 font-semibold text-white shadow-[0_10px_24px_-12px_rgb(47_93_98/0.9)]'
            : 'font-medium text-mist-600 hover:bg-mist-100/90 hover:text-mist-900',
        )
      }
    >
      {({ isActive }) => (
        <>
          <Icon
            className={cn('size-[18px] shrink-0', isActive ? 'text-gamboge-300' : 'text-mist-400 group-hover:text-mist-600')}
            strokeWidth={isActive ? 2.25 : 1.8}
          />
          <span className="truncate">{children}</span>
        </>
      )}
    </NavLink>
  )
}

function RecentWorks() {
  const recent = useRecentWorks(5)
  const loc = useLocation()
  if (recent.length === 0) return null
  return (
    <div className="pt-5">
      <div className="mb-1.5 flex items-center gap-1.5 px-3 text-[11px] font-semibold tracking-[0.16em] text-mist-400"><Clock className="size-3" />最近打开</div>
      {recent.map((r) => (
        <Link key={r.link} to={r.link} title={r.title}
          className={cn('block truncate rounded-xl px-3 py-1.5 text-[13px] transition', loc.pathname.startsWith(r.link) ? 'bg-mist-100 font-medium text-mist-900' : 'text-mist-600 hover:bg-mist-100/90 hover:text-mist-900')}>
          {r.title}
        </Link>
      ))}
    </div>
  )
}

function UserMenu({ username, onLogout }: { username?: string; onLogout: () => void }) {
  const [open, setOpen] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(() => localStorage.getItem('ops-settings-advanced-open') === '1')
  const navigate = useNavigate()
  const loc = useLocation()
  const { data: me } = useMe()
  const ref = useRef<HTMLDivElement>(null)
  const inSettings = loc.pathname.startsWith('/settings/')
  const desktop = isElectronDesktop(navigator.userAgent)
  const items = settingsItems.filter((item) => !item.adminOnly || me?.is_system_admin)
  const common = items.filter((item) => commonSettings.has(item.to))
  const advanced = items.filter((item) => !commonSettings.has(item.to))
  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])
  useEffect(() => { setOpen(false) }, [loc.pathname])
  return (
    <div ref={ref} className="desktop-user-menu relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`用户菜单：${username || '用户'}`}
        aria-expanded={open}
        aria-haspopup="menu"
        className={cn(
          'desktop-user-trigger flex h-9 cursor-pointer items-center gap-2 rounded-full border bg-white pl-1 pr-2.5 text-left transition',
          open || inSettings ? 'border-ink-300 shadow-card' : 'border-mist-200 hover:border-mist-300',
        )}
      >
        <div className="flex size-7 items-center justify-center rounded-full bg-ink-700 text-[11px] font-bold text-white">
          {username?.[0]?.toUpperCase() || '?'}
        </div>
        <span className="hidden max-w-[6.5rem] truncate text-[13px] font-medium text-mist-800 sm:block">{username || '用户'}</span>
        <Settings2 className={cn('size-3.5 shrink-0 text-mist-400', (open || inSettings) && 'text-ink-600')} />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-[calc(100%+8px)] z-40 w-[260px] animate-fade-in rounded-xl border border-mist-200 bg-white p-1.5 shadow-pop">
          {desktop ? <button type="button" role="menuitem" onClick={() => { setOpen(false); navigate('/settings/preferences') }} className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13.5px] text-mist-700 hover:bg-mist-50"><Settings2 className="size-4" /> 设置…</button> : <>
          <div className="px-2.5 pb-1.5 pt-1.5 text-[11px] font-semibold tracking-wider text-mist-400">工作区设置</div>
          {common.map((item) => (
            <button
              key={item.to}
              type="button"
              role="menuitem"
              onClick={() => { setOpen(false); navigate(item.to) }}
              className={cn(
                'flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13.5px] transition',
                loc.pathname.startsWith(item.to) ? 'bg-ink-50 font-medium text-ink-700' : 'text-mist-700 hover:bg-mist-50',
              )}
            >
              <span className="[&>svg]:size-4 opacity-80">{item.icon}</span>
              {item.label}
            </button>
          ))}
          <button
            type="button"
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen((value) => {
              const next = !value
              localStorage.setItem('ops-settings-advanced-open', next ? '1' : '0')
              return next
            })}
            className="flex w-full cursor-pointer items-center justify-between rounded-lg px-2.5 py-2 text-left text-[13px] font-medium text-mist-500 hover:bg-mist-50"
          >
            高级设置
            {advancedOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </button>
          {advancedOpen && advanced.map((item) => (
            <button
              key={item.to}
              type="button"
              role="menuitem"
              onClick={() => { setOpen(false); navigate(item.to) }}
              className={cn(
                'flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13.5px] transition',
                loc.pathname.startsWith(item.to) ? 'bg-ink-50 font-medium text-ink-700' : 'text-mist-700 hover:bg-mist-50',
              )}
            >
              <span className="[&>svg]:size-4 opacity-80">{item.icon}</span>
              {item.label}
            </button>
          ))}
          </>}
          <div className="my-1 border-t border-mist-100" />
          <button
            type="button"
            role="menuitem"
            onClick={() => { setOpen(false); onLogout() }}
            className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13.5px] text-mist-600 transition hover:bg-mist-50 hover:text-danger"
          >
            <LogOut className="size-4 opacity-80" />
            退出登录
          </button>
        </div>
      )}
    </div>
  )
}

type MenuItem = {
  label: string
  icon?: React.ReactNode
  danger?: boolean
  disabled?: boolean
  separator?: boolean
  onClick?: () => void
}

function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    document.addEventListener('scroll', onClose, true)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('scroll', onClose, true)
    }
  }, [onClose])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const dx = Math.min(0, window.innerWidth - rect.right - 8)
    const dy = Math.min(0, window.innerHeight - rect.bottom - 8)
    if (dx || dy) {
      el.style.left = `${x + dx}px`
      el.style.top = `${y + dy}px`
    }
  }, [x, y])
  return createPortal(
    <div
      ref={ref}
      role="menu"
      className="fixed z-50 min-w-[188px] animate-fade-in rounded-xl border border-mist-200 bg-white p-1 shadow-pop"
      style={{ left: x, top: y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) =>
        item.separator ? (
          <div key={`sep-${i}`} className="my-1 border-t border-mist-100" />
        ) : (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => { onClose(); item.onClick?.() }}
            className={cn(
              'flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] transition',
              item.danger ? 'text-danger hover:bg-orange-50' : 'text-mist-700 hover:bg-mist-50',
              item.disabled && 'cursor-not-allowed opacity-40',
            )}
          >
            <span className="flex size-4 shrink-0 items-center justify-center text-mist-400 [&_svg]:size-3.5">
              {item.icon}
            </span>
            {item.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  )
}

const PLATFORMS: Platform[] = ['wechat_mp', 'xhs', 'toutiao']
const PLATFORM_EXPAND_KEY = 'ops.topbar.platforms'

function loadPlatformExpanded(): Record<Platform, boolean> {
  try {
    const raw = localStorage.getItem(PLATFORM_EXPAND_KEY)
    if (raw) return { wechat_mp: true, xhs: true, toutiao: true, ...JSON.parse(raw) }
  } catch { /* ignore */ }
  return { wechat_mp: true, xhs: true, toutiao: true }
}

/** 顶栏统一入口：客户端按平台 Tab 切换账号，Web 保留展开式账号树 */
function WorkspaceAccountTree({ compact }: { compact?: boolean }) {
  const current = useCurrentAccount()
  const { data: accounts } = useAccounts()
  const { data: me } = useMe()
  const qc = useQueryClient()
  const canManage = me?.role === 'owner'
  const inv = useInvalidate()
  const navigate = useNavigate()
  const loc = useLocation()
  const ref = useRef<HTMLDivElement>(null)
  const lastPathname = useRef(loc.pathname)
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState(loadPlatformExpanded)
  const [platform, setPlatform] = useState<Platform>('wechat_mp')
  const [busy, setBusy] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [createPlatform, setCreatePlatform] = useState<Platform | null>(null)
  const createContext = useRef<{ userId: string; workspaceId: string } | null>(null)
  const identityRef = useRef<{ userId: string; workspaceId: string } | null>(null)
  identityRef.current = me?.workspace ? { userId: me.user_id ?? me.username, workspaceId: me.workspace.id } : null
  const desktop = document.documentElement.dataset.presentation === 'ops-creative-desktop'

  const openAccountCreate = async (target: Platform) => {
    setOpen(false)
    if (!canManage || !identityRef.current) return
    const context = identityRef.current
    if (identityRef.current?.userId !== context.userId || identityRef.current?.workspaceId !== context.workspaceId) {
      toast.info('工作区已变化，请重新打开账号创建窗口')
      return
    }
    createContext.current = context
    setPlatform(target)
    setCreatePlatform(target)
  }

  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false)
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const restoreFocus = !!ref.current?.querySelector('#topbar-context-menu')
      setOpen(false)
      if (restoreFocus) ref.current?.querySelector('button')?.focus()
    }
    document.addEventListener('mousedown', h)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', h)
      document.removeEventListener('keydown', onKey)
    }
  }, [])
  useLayoutEffect(() => {
    if (lastPathname.current === loc.pathname) return
    lastPathname.current = loc.pathname
    setOpen(false)
  }, [loc.pathname])
  useEffect(() => {
    const openSwitcher = () => {
      setPlatform(current?.platform ?? 'wechat_mp')
      setOpen(true)
      requestAnimationFrame(() => ref.current?.querySelector('button')?.focus())
    }
    const openCreate = (event: Event) => {
      const requested = (event as CustomEvent<{ platform?: Platform }>).detail?.platform
      void openAccountCreate(PLATFORMS.includes(requested as Platform) ? requested as Platform : current?.platform ?? platform)
    }
    window.addEventListener(DESKTOP_ACCOUNT_SWITCHER_REQUEST, openSwitcher)
    window.addEventListener(DESKTOP_ACCOUNT_CREATE_REQUEST, openCreate)
    if (desktop) {
      document.documentElement.dataset.desktopAccountSwitcherReady = 'true'
      window.dispatchEvent(new Event(DESKTOP_ACCOUNT_SWITCHER_READY))
    }
    if (canManage && identityRef.current) {
      document.documentElement.dataset.desktopAccountCreateReady = 'true'
      window.dispatchEvent(new Event(DESKTOP_ACCOUNT_CREATE_READY))
    }
    return () => {
      if (desktop) delete document.documentElement.dataset.desktopAccountSwitcherReady
      delete document.documentElement.dataset.desktopAccountCreateReady
      window.removeEventListener(DESKTOP_ACCOUNT_SWITCHER_REQUEST, openSwitcher)
      window.removeEventListener(DESKTOP_ACCOUNT_CREATE_REQUEST, openCreate)
    }
  }, [current?.platform, platform, canManage, desktop, me?.user_id, me?.username, me?.workspace.id])

  if (!me?.workspace) return null

  const switchAccount = async (id: string, sub = '') => {
    const identity = identityRef.current
    if (!identity) return
    if (desktop && !(await requestDesktopLeaveGuard(true))) return
    if (identityRef.current?.userId !== identity.userId || identityRef.current?.workspaceId !== identity.workspaceId) {
      toast.info('登录用户或工作区已变化，请重新选择账号。')
      return
    }
    if (!accounts?.some((account) => account.id === id && account.status === 'active')) {
      toast.info('该账号当前不可用，请从顶部重新选择。')
      return
    }
    setOpen(false)
    if (loc.pathname.startsWith('/works/') || loc.pathname.startsWith('/settings/')) {
      navigate(`/a/${id}${sub}`)
      return
    }
    const m = loc.pathname.match(/^\/a\/[^/]+(\/[^/]+)?/)
    navigate(`/a/${id}${sub || m?.[1] || ''}`)
  }

  const switchWorkspace = async (id: string) => {
    if (id === me.workspace.id || busy) return
    setBusy(true)
    if (desktop && !(await requestDesktopLeaveGuard(true))) { setBusy(false); return }
    if (identityRef.current?.workspaceId !== me.workspace.id) { setBusy(false); return }
    try {
      await post(`/workspaces/${id}/switch`, {})
      qc.clear()
      setOpen(false)
      navigate('/', { replace: true })
      window.location.reload()
    } catch {
      if (desktop) releaseDesktopLeaveGuard()
      setBusy(false)
    }
  }

  const togglePlatform = (p: Platform) => {
    setExpanded((prev) => {
      const next = { ...prev, [p]: !prev[p] }
      localStorage.setItem(PLATFORM_EXPAND_KEY, JSON.stringify(next))
      return next
    })
  }

  const disableAccount = async (a: Account) => {
    if (!(await confirm({
      title: `停用「${a.name}」？`,
      desc: '停用后不会出现在账号列表中，也不能写入草稿。可随时重新启用。若要永久清除请用「删除」。',
      confirmText: '停用',
      danger: true,
    }))) return
    try {
      await post(`/accounts/${a.id}/disable`)
      inv(['accounts'])
      toast.success('已停用')
      if (current?.id === a.id) navigate('/settings/accounts')
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const deleteAccount = async (a: Account) => {
    if (!(await confirm({
      title: `删除「${a.name}」？`,
      desc: '将永久删除该平台账号及其作品、选题、档案、凭证等，无法恢复。',
      confirmText: '确认删除',
      danger: true,
    }))) return
    try {
      await del(`/accounts/${a.id}?confirm=true`)
      inv(['accounts'])
      toast.success('账号已删除')
      setOpen(false)
      if (current?.id === a.id) navigate('/settings/accounts')
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const openMenu = (e: React.MouseEvent, items: MenuItem[]) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, items })
  }

  const otherWorkspaces = (me.workspaces ?? []).filter((w) => w.id !== me.workspace.id)

  const createAndSwitchWorkspace = async () => {
    if (!(await confirm({
      title: '创建新工作区并切换？',
      desc: '你会成为所有者；当前工作区仍保留。可在「成员与邀请」里自定义名称。',
      confirmText: '创建并切换',
    }))) return
    setBusy(true)
    if (desktop && !(await requestDesktopLeaveGuard(true))) { setBusy(false); return }
    if (identityRef.current?.workspaceId !== me.workspace.id) { setBusy(false); return }
    try {
      await post('/workspaces', { name: '新工作区', switch: true })
      qc.clear()
      window.location.assign('/')
    } catch (e) {
      if (desktop) releaseDesktopLeaveGuard()
      toast.error(errorMessage(e))
      setBusy(false)
    }
  }

  const workspaceMenu = (): MenuItem[] => [
    ...(!desktop ? [{
      label: '成员与邀请',
      icon: <UserPlus />,
      onClick: () => { setOpen(false); navigate('/settings/members') },
    }] : []),
    {
      label: '创建工作区',
      icon: <Plus />,
      onClick: () => { setOpen(false); void createAndSwitchWorkspace() },
    },
    {
      label: '添加账号',
      icon: <Plus />,
      disabled: !canManage,
      onClick: () => { if (desktop) void openAccountCreate(platform); else { setOpen(false); navigate('/settings/accounts?new=1') } },
    },
    ...(!desktop ? [{
      label: '管理平台账号',
      icon: <Settings2 />,
      onClick: () => { setOpen(false); navigate('/settings/accounts') },
    }] : []),
    ...(otherWorkspaces.length
      ? [
          { separator: true, label: '' } as MenuItem,
          ...otherWorkspaces.map((w) => ({
            label: `切换到 ${w.name}`,
            icon: <ChevronsUpDown />,
            onClick: () => void switchWorkspace(w.id),
          })),
        ]
      : []),
  ]

  const platformMenu = (p: Platform): MenuItem[] => [
    ...(!desktop ? [{
      label: expanded[p] ? '收起' : '展开',
      icon: expanded[p] ? <ChevronDown /> : <ChevronRight />,
      onClick: () => togglePlatform(p),
    },
    { separator: true, label: '' } as MenuItem] : []),
    {
      label: '添加账号',
      icon: <Plus />,
      disabled: !canManage,
      onClick: () => { if (desktop) void openAccountCreate(p); else { setOpen(false); navigate(`/settings/accounts?new=1&platform=${p}`) } },
    },
    ...(!desktop ? [{
      label: '查看全部',
      icon: <Eye />,
      onClick: () => { setOpen(false); navigate('/settings/accounts') },
    },
    {
      label: '搜索账号',
      icon: <Search />,
      onClick: () => { setOpen(false); navigate('/settings/accounts?q=1') },
    },
    { separator: true, label: '' },
    {
      label: '邀请成员',
      icon: <UserPlus />,
      onClick: () => { setOpen(false); navigate('/settings/members') },
    }] : []),
  ]

  const accountMenu = (a: Account): MenuItem[] => [
    {
      label: '打开 / 选中',
      icon: <Check />,
      onClick: () => switchAccount(a.id),
    },
    ...(!desktop ? [{
      label: '查看资料',
      icon: <Eye />,
      onClick: () => { setOpen(false); navigate(`/settings/accounts?id=${a.id}`) },
    },
    {
      label: '编辑账号',
      icon: <Pencil />,
      disabled: !canManage,
      onClick: () => { setOpen(false); navigate(`/settings/accounts?id=${a.id}`) },
    }] : []),
    {
      label: '添加同平台账号',
      icon: <Plus />,
      disabled: !canManage,
      onClick: () => { if (desktop) void openAccountCreate(a.platform); else { setOpen(false); navigate(`/settings/accounts?new=1&platform=${a.platform}`) } },
    },
    ...(desktop ? [{
      label: '管理此账号',
      icon: <Settings2 />,
      onClick: () => {
        setOpen(false)
        navigate(currentAccountSettingsPath(a.id), { state: { opsAccountSwitchId: a.id } })
      },
    }] : []),
    ...(!desktop ? [{
      label: '停用账号',
      icon: <Power />,
      danger: true,
      disabled: !canManage,
      onClick: () => void disableAccount(a),
    },
    {
      label: '删除账号',
      icon: <Trash2 />,
      danger: true,
      disabled: !canManage,
      onClick: () => void deleteAccount(a),
    },
    { separator: true, label: '' },
    {
      label: '邀请成员',
      icon: <UserPlus />,
      onClick: () => { setOpen(false); navigate('/settings/members') },
    },
    {
      label: '账号档案',
      icon: <UserCircle2 />,
      onClick: () => switchAccount(a.id, '/profile'),
    },
    {
      label: a.platform === 'wechat_mp' ? '管理凭证' : '管理账号',
      icon: a.platform === 'wechat_mp' ? <KeyRound /> : <Settings2 />,
      onClick: () => { setOpen(false); navigate(`/settings/accounts?id=${a.id}`) },
    }] : []),
  ]

  return (
    <div ref={ref} className={cn('relative', desktop ? 'shrink-0' : 'min-w-0')}>
      {desktop ? <button type="button" className="desktop-context-trigger" aria-label="切换工作区与账号" aria-expanded={open} aria-controls="topbar-context-menu" title={`${me.workspace.name} / ${current?.name ?? '选择账号'}`} onClick={() => { setPlatform(current?.platform ?? 'wechat_mp'); setOpen((v) => !v) }} onContextMenu={(e) => openMenu(e, workspaceMenu())}>
          {current ? <PlatformMark platform={current.platform} size="sm" /> : <span className="size-5 rounded bg-mist-100" />}
          <span className="desktop-context-copy"><strong>{me.workspace.name}</strong><small>{current ? `${platformLabel[current.platform]} · ${current.name}` : '选择账号'}</small></span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-mist-400" />
      </button> : <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onContextMenu={(e) => openMenu(e, workspaceMenu())}
        className={cn(
          'flex h-9 w-full cursor-pointer items-center gap-2 rounded-full border bg-white text-left transition',
          compact ? 'workspace-account-compact max-w-[240px] pl-2.5 pr-2' : 'max-w-[340px] pl-3 pr-2.5',
          open ? 'border-ink-300 shadow-card' : 'border-mist-200 hover:border-mist-300',
        )}
      >
        {current ? <PlatformMark platform={current.platform} size="sm" /> : <span className="size-5 rounded bg-mist-100" />}
        <span className="min-w-0 flex-1 truncate text-[13px]">
          <span className="font-semibold text-mist-900">{me.workspace.name}</span>
          <span className="text-mist-300"> · </span>
          <span className="text-mist-500">{current?.name ?? '选择账号'}</span>
        </span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-mist-400" />
      </button>}

      {open && (
        <div id="topbar-context-menu" data-testid={desktop ? 'desktop-context-menu' : 'workspace-account-menu'} className={cn('absolute left-0 top-[calc(100%+8px)] z-40 animate-fade-in rounded-xl border border-mist-200 bg-white p-1.5 shadow-pop', desktop ? 'w-[320px] max-w-[calc(100vw-24px)] max-h-[calc(100vh-152px)] overflow-y-auto' : 'w-[300px]')}>
          <div className="flex items-center gap-1 px-2 pb-1 pt-1.5">
            <span className="min-w-0 flex-1 truncate text-[11px] font-semibold tracking-wider text-mist-400">{me.workspace.name}</span>
            {canManage && (
              <button
                type="button"
                title="添加账号"
                onClick={() => { if (desktop) void openAccountCreate(platform); else { setOpen(false); navigate('/settings/accounts?new=1') } }}
                className="inline-flex size-5 cursor-pointer items-center justify-center rounded text-mist-400 hover:bg-mist-100 hover:text-mist-700"
              >
                <Plus className="size-3.5" />
              </button>
            )}
          </div>

          {desktop ? <>
            <div role="tablist" aria-label="账号平台" className="desktop-platform-tabs">
              {PLATFORMS.map((p) => (
                <button key={p} type="button" role="tab" id={`topbar-platform-${p}`} aria-selected={platform === p} aria-controls={`topbar-accounts-${p}`} tabIndex={platform === p ? 0 : -1} onClick={() => setPlatform(p)} onContextMenu={(e) => openMenu(e, platformMenu(p))} onKeyDown={(e) => {
                  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
                  e.preventDefault()
                  const index = PLATFORMS.indexOf(p)
                  const next = e.key === 'Home' ? PLATFORMS[0] : e.key === 'End' ? PLATFORMS[PLATFORMS.length - 1] : PLATFORMS[(index + (e.key === 'ArrowRight' ? 1 : -1) + PLATFORMS.length) % PLATFORMS.length]
                  setPlatform(next)
                  document.getElementById(`topbar-platform-${next}`)?.focus()
                }}>
                  <PlatformMark platform={p} size="sm" />
                  <span>{platformLabel[p]}</span>
                  <span className="tabular-nums">{(accounts ?? []).filter((a) => a.platform === p && a.status === 'active').length}</span>
                </button>
              ))}
            </div>
            <div role="tabpanel" id={`topbar-accounts-${platform}`} aria-labelledby={`topbar-platform-${platform}`} className="space-y-0.5 py-1">
              {(accounts ?? []).filter((a) => a.platform === platform && a.status === 'active').map((a) => (
                <button key={a.id} type="button" onClick={() => switchAccount(a.id)} onContextMenu={(e) => openMenu(e, accountMenu(a))} className={cn('flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-left text-[13px] transition', a.id === current?.id ? 'bg-ink-50 font-semibold text-ink-800' : 'text-mist-600 hover:bg-mist-50 hover:text-mist-900')}>
                  <span className={cn('size-1.5 shrink-0 rounded-full', a.id === current?.id ? 'bg-ink-600' : 'bg-mist-300')} />
                  <span className="min-w-0 flex-1 truncate" title={a.name}>{a.name}</span>
                  {a.id === current?.id && <Check className="size-3.5 shrink-0 text-ink-600" />}
                </button>
              ))}
              {!(accounts ?? []).some((a) => a.platform === platform && a.status === 'active') && (
                <div className="px-2 py-3 text-center text-[12.5px] text-mist-400">
                  暂无{platformLabel[platform]}账号
                  {canManage && <button type="button" onClick={() => { if (desktop) void openAccountCreate(platform); else { setOpen(false); navigate(`/settings/accounts?new=1&platform=${platform}`) } }} className="mt-2 block w-full cursor-pointer text-ink-600 hover:text-ink-800">添加{platformLabel[platform]}账号</button>}
                </div>
              )}
              {(accounts ?? []).some((a) => a.platform === platform && a.status === 'disabled') && (
                <details className="mt-1 border-t border-mist-100 pt-1.5">
                  <summary className="cursor-pointer rounded-lg px-2 py-1.5 text-[12px] text-mist-500 hover:bg-mist-50">
                    已停用 {(accounts ?? []).filter((a) => a.platform === platform && a.status === 'disabled').length}
                  </summary>
                  <div className="space-y-0.5 py-1">
                    {(accounts ?? []).filter((a) => a.platform === platform && a.status === 'disabled').map((a) => (
                      <button key={a.id} type="button" onClick={() => {
                        setOpen(false)
                        navigate(currentAccountSettingsPath(a.id), { state: { opsAccountSwitchId: a.id } })
                      }} className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-left text-[12.5px] text-mist-500 hover:bg-mist-50 hover:text-mist-800">
                        <span className="size-1.5 shrink-0 rounded-full bg-mist-300" />
                        <span className="min-w-0 flex-1 truncate">{a.name}</span>
                        <span className="shrink-0 text-[11px]">已停用</span>
                      </button>
                    ))}
                  </div>
                </details>
              )}
            </div>
          </> : <div className="space-y-0.5">
            {PLATFORMS.map((p) => {
              const list = (accounts ?? []).filter((a) => a.platform === p && a.status === 'active')
              const platformOpen = expanded[p]
              return (
                <div key={p}>
                  <button
                    type="button"
                    onClick={() => togglePlatform(p)}
                    onContextMenu={(e) => openMenu(e, platformMenu(p))}
                    className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] font-medium text-mist-700 hover:bg-mist-50"
                  >
                    {platformOpen ? <ChevronDown className="size-3.5 shrink-0 text-mist-400" /> : <ChevronRight className="size-3.5 shrink-0 text-mist-400" />}
                    <PlatformMark platform={p} size="sm" />
                    <span className="min-w-0 flex-1 truncate">{platformLabel[p]}</span>
                    <span className="text-[11px] tabular-nums text-mist-400">{list.length}</span>
                  </button>
                  {platformOpen && (
                    <div className="ml-2 space-y-0.5 border-l border-mist-100 pl-1.5">
                      {list.length === 0 ? (
                        <button
                          type="button"
                          onClick={() => { if (canManage) { if (desktop) void openAccountCreate(p); else { setOpen(false); navigate(`/settings/accounts?new=1&platform=${p}`) } } }}
                          onContextMenu={(e) => openMenu(e, platformMenu(p))}
                          className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] text-mist-400 hover:bg-mist-50 hover:text-mist-600"
                        >
                          {canManage ? '右键或点击添加' : '暂无账号'}
                        </button>
                      ) : (
                        list.map((a) => {
                          const active = a.id === current?.id
                          return (
                            <button
                              key={a.id}
                              type="button"
                              onClick={() => switchAccount(a.id)}
                              onContextMenu={(e) => openMenu(e, accountMenu(a))}
                              className={cn(
                                'flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] transition',
                                active ? 'bg-ink-50 font-semibold text-ink-800' : 'text-mist-600 hover:bg-mist-50 hover:text-mist-900',
                              )}
                            >
                              <span className={cn('size-1.5 shrink-0 rounded-full', active ? 'bg-ink-600' : 'bg-mist-300')} />
                              <span className="min-w-0 flex-1 truncate">{a.name}</span>
                              {active && <Check className="size-3.5 shrink-0 text-ink-600" />}
                            </button>
                          )
                        })
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>}

          {otherWorkspaces.length > 0 && (
            <div className="mt-1 space-y-0.5 border-t border-mist-100 pt-1">
              <div className="px-2 pb-0.5 pt-1 text-[10.5px] font-semibold tracking-wider text-mist-400">其他工作区</div>
              {otherWorkspaces.map((w) => (
                <button
                  key={w.id}
                  type="button"
                  disabled={busy}
                  onClick={() => void switchWorkspace(w.id)}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] text-mist-500 hover:bg-mist-50 hover:text-mist-800 disabled:opacity-50"
                >
                  <ChevronRight className="size-3.5 shrink-0 text-mist-300" />
                  <span className="min-w-0 flex-1 truncate">{w.name}</span>
                </button>
              ))}
            </div>
          )}

          {desktop ? (
            <div className="mt-1 border-t border-mist-100 pt-1">
              <button type="button" disabled={busy} onClick={() => { setOpen(false); void createAndSwitchWorkspace() }} className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] text-mist-600 hover:bg-mist-50 disabled:opacity-50"><Plus className="size-3.5" /> 创建工作区</button>
            </div>
          ) : (
            <div className="mt-1 border-t border-mist-100 pt-1">
              <button type="button" onClick={() => { setOpen(false); navigate('/settings/members') }} className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] text-mist-600 hover:bg-mist-50"><UserPlus className="size-3.5" /> 成员与邀请</button>
            </div>
          )}
        </div>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {desktop && <AccountCreateHost
        platform={createPlatform}
        expectedContext={createContext.current}
        onClose={() => { createContext.current = null; setCreatePlatform(null) }}
        onCreated={(account) => {
          const target = createContext.current
          createContext.current = null
          setCreatePlatform(null)
          if (!target || identityRef.current?.userId !== target.userId || identityRef.current?.workspaceId !== target.workspaceId) {
            void inv(['accounts'])
            toast.warning('账号已创建，但当前工作区已变化；请在原工作区重新选择账号。')
            return
          }
          qc.setQueryData<Account[]>(['accounts', target.userId, target.workspaceId], (previous = []) => {
            const index = previous.findIndex((item) => item.id === account.id)
            if (index < 0) return [...previous, account]
            return previous.map((item, i) => i === index ? account : item)
          })
          void inv(['accounts'])
          rememberAccount(account.id, target.userId, target.workspaceId)
          toast.success(account.platform === 'wechat_mp' ? '账号已添加，先建档；公众号凭证可稍后配置' : '账号已添加，先来建档')
          navigate(`/a/${account.id}/profile?wizard=1`)
        }}
      />}
    </div>
  )
}

function TopBar({ username, onLogout, dense, showAgent, agentMode, homeTo, desktopNavExpanded, onToggleDesktopNav }: { username?: string; onLogout: () => void; dense?: boolean; showAgent?: boolean; agentMode?: boolean; homeTo: string; desktopNavExpanded: boolean; onToggleDesktopNav: () => void }) {
  const meta = useChromeMeta(settingsItems)
  const acc = useCurrentAccount()
  const navigate = useNavigate()
  const desktopPresentation = isElectronDesktop(navigator.userAgent)

  return (
    <header className={cn(
      'desktop-global-header sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b border-mist-200/80 bg-white/90 px-3 backdrop-blur sm:gap-3 sm:px-5 xl:px-7', dense && 'work-topbar',
    )}>
      {document.documentElement.dataset.presentation === 'ops-creative-desktop' && (
        <>
          <button type="button" className="desktop-nav-toggle" aria-label={desktopNavExpanded ? '收起导航文字' : '展开导航文字'} title={desktopNavExpanded ? '收起导航文字' : '展开导航文字'} aria-expanded={desktopNavExpanded} aria-controls="main-navigation" onClick={onToggleDesktopNav}>
            <PanelLeft aria-hidden="true" />
          </button>
          <button type="button" className="desktop-nav-back" aria-label="返回上一视图" title="返回" onClick={() => navigate(-1)}><ChevronLeft aria-hidden="true" /></button>
        </>
      )}
      <WorkspaceAccountTree compact={dense} />
      <div className="hidden h-4 w-px bg-mist-200 lg:block" />
      <nav className={cn('hidden min-w-0 flex-1 items-center gap-2 text-[13px] lg:flex', desktopPresentation && 'desktop-breadcrumb')} aria-label="当前位置">
        <span className="truncate text-mist-400">{meta.crumb}</span>
        <span className="text-mist-300">/</span>
        {agentMode
          ? <div id="agent-title-slot" className="min-w-0 flex-1 truncate font-semibold text-mist-800" />
          : <span className="truncate font-semibold text-mist-800">{meta.title}</span>}
      </nav>
      <div className="desktop-toolbar-actions ml-auto flex shrink-0 items-center gap-2">
        {agentMode && <div id="agent-toolbar-slot" className="hidden shrink-0 items-center lg:flex" />}
        {agentMode
          ? <Link to={homeTo} aria-label="返回工作台" title="返回工作台" className={cn('flex size-9 items-center justify-center rounded-full text-mist-500 hover:bg-mist-100 hover:text-ink-700', showAgent && 'md:hidden', !showAgent && 'md:w-auto md:gap-2 md:px-2.5')}><ChevronLeft className="size-4" /><span className={cn('hidden text-xs', !showAgent && 'md:inline')}>返回工作台</span></Link>
          : showAgent && <Link to="/agent" aria-label="打开 AI 对话" title="打开 AI 对话" className="flex size-9 items-center justify-center rounded-full text-mist-500 hover:bg-mist-100 hover:text-ink-700 md:hidden"><Bot className="size-4" /></Link>}
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event('ops:palette'))}
          title="搜索与命令（Ctrl+K）"
          aria-label={desktopPresentation ? '搜索与命令（Ctrl+K）' : undefined}
          className={cn(
            'desktop-command-search flex h-9 cursor-pointer items-center rounded-full border border-mist-200 bg-white transition hover:border-mist-300',
            desktopPresentation
              ? 'size-9 justify-center text-mist-600 hover:text-mist-900'
              : 'gap-2 px-2.5 text-[12.5px] text-mist-500 hover:text-mist-800 sm:px-3',
          )}
        >
          <Search className={desktopPresentation ? 'size-4' : 'size-3.5'} />
          {!desktopPresentation && <>
            <span className="hidden md:inline">搜索</span>
            <span className="hidden md:inline"><Kbd>Ctrl K</Kbd></span>
          </>}
        </button>
        {desktopPresentation && <ThemeToggle />}
        {!dense && !desktopPresentation && <TodayUsage enabled={!!acc} />}
        <NotificationBell />
        <UserMenu username={username} onLogout={onLogout} />
      </div>
    </header>
  )
}

export default function Shell() {
  const acc = useCurrentAccount()
  const { data: me } = useMe()
  const agentBootstrap = useAgentBootstrap()
  const qc = useQueryClient()
  const loc = useLocation()
  const agentMode = loc.pathname.startsWith('/agent')
  const previousAgentMode = useRef(agentMode)
  const [contentSlide, setContentSlide] = useState<'from-left' | 'from-right' | null>(null)
  const fullBleed = loc.pathname.startsWith('/works/') || loc.pathname.startsWith('/agent')
  const showAgent = !!agentBootstrap.data && (agentBootstrap.data.can_use || agentBootstrap.data.reason === 'no_model' || agentBootstrap.data.reason === 'not_tested')
  const base = acc ? `/a/${acc.id}` : '/'
  const prefs = usePrefs()
  useEffect(() => setUXEnabled(prefs.ux_events), [prefs.ux_events])
  const [focusMode, setFocusMode] = useState(false)
  const desktopPresentation = document.documentElement.dataset.presentation === 'ops-creative-desktop'
  const [desktopNavExpanded, setDesktopNavExpanded] = useState(() => desktopPresentation && localStorage.getItem('ops-desktop-nav') === 'expanded')
  const [timeNow, setTimeNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setTimeNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  useEffect(() => {
    const h = (e: Event) => setFocusMode(!!(e as CustomEvent<boolean>).detail)
    window.addEventListener('ops:focus', h)
    return () => window.removeEventListener('ops:focus', h)
  }, [])
  useLayoutEffect(() => {
    if (previousAgentMode.current === agentMode) return
    previousAgentMode.current = agentMode
    setContentSlide(agentMode ? 'from-right' : 'from-left')
    const timer = window.setTimeout(() => setContentSlide(null), 300)
    return () => window.clearTimeout(timer)
  }, [agentMode])
  const focus = focusMode && fullBleed
  const logout = async () => {
    if (desktopPresentation && !(await requestDesktopLeaveGuard(true))) return
    await post('/auth/logout').catch(() => undefined)
    qc.clear()
    location.href = '/login'
  }
  return (
    <div className="flex h-full">
      <aside id="main-navigation" aria-label="主导航" className={cn('hidden w-[248px] shrink-0 flex-col border-r border-mist-200 bg-mist-50', desktopPresentation && focus && !agentMode && 'desktop-focus-nav-hidden', desktopNavExpanded && 'desktop-nav-expanded', (!focus || agentMode) && 'md:flex')}>
        <Brand desktop={desktopPresentation} />
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <nav aria-hidden={agentMode && !desktopPresentation} className={cn('scrollbar-thin absolute inset-0 space-y-1 overflow-y-auto px-3 pb-4 pt-3', agentMode && !desktopPresentation && 'hidden')}>
            {desktopPresentation ? desktopNavGroups.map((group) => (
              <div key={group.label} className="desktop-nav-group">
                <div className="desktop-nav-group-label">{group.label}</div>
                {group.items.map((item) => <NavItem key={'to' in item ? item.to : item.path || 'home'} to={'to' in item ? item.to : acc ? `${base}${item.path}` : '/settings/accounts'} end={'end' in item ? item.end : undefined} icon={item.icon}>{item.label}</NavItem>)}
              </div>
            )) : <>
              <div className="mb-1.5 px-3 text-[11px] font-semibold tracking-[0.16em] text-mist-400">创作</div>
              {nav.map((item) => <NavItem key={item.path || 'home'} to={acc ? `${base}${item.path}` : '/settings/accounts'} end={item.end} icon={item.icon}>{item.label}</NavItem>)}
              <div className="mb-1.5 px-3 pt-4 text-[11px] font-semibold tracking-[0.16em] text-mist-400">工作区</div>
              <NavItem to="/images" icon={Images}>图片库</NavItem>
              <RecentWorks />
            </>}
          </nav>
          <div id="agent-sidebar-slot" aria-hidden={!agentMode || desktopPresentation} className={cn('absolute inset-0 flex flex-col overflow-hidden', (!agentMode || desktopPresentation) && 'hidden')}>
            {agentMode && !desktopPresentation && agentBootstrap.isLoading && <div className="px-4 py-3 text-sm text-mist-400">正在打开 AI 对话…</div>}
          </div>
        </div>
        <div className={cn('shrink-0 space-y-2 px-3 pb-4', desktopPresentation && 'desktop-sidebar-bottom')}>
          {me?.dev && (
            <div className="desktop-dev-note rounded-2xl border border-gamboge-200/80 bg-gamboge-50/70 px-3 py-2.5 text-[11.5px] leading-relaxed text-gamboge-700">
              本地开发 · 模拟接口
            </div>
          )}
          {desktopPresentation
            ? <NavItem to="/agent" icon={Bot}>AI 对话</NavItem>
            : agentMode
              ? <Link to={base} className="group flex items-center gap-3 rounded-2xl px-3 py-2.5 text-[14.5px] font-medium text-mist-600 transition-all hover:bg-mist-100/90 hover:text-mist-900"><ChevronLeft className="size-[18px] shrink-0 text-mist-400 group-hover:text-mist-600" strokeWidth={1.8} />返回工作台</Link>
              : showAgent && <NavItem to="/agent" icon={Bot}>AI 对话</NavItem>}
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        {!focus && <TopBar username={me?.username} onLogout={logout} dense={loc.pathname.startsWith('/works/')} showAgent={showAgent} agentMode={agentMode} homeTo={base} desktopNavExpanded={desktopNavExpanded} onToggleDesktopNav={() => setDesktopNavExpanded((expanded) => {
          const next = !expanded
          if (desktopPresentation) localStorage.setItem('ops-desktop-nav', next ? 'expanded' : 'collapsed')
          return next
        })} />}
        {me?.session_expires_at && Date.parse(me.session_expires_at) > timeNow && Date.parse(me.session_expires_at) - timeNow < 24 * 60 * 60 * 1000 && (
          <div role="status" className="border-b border-gamboge-200 bg-gamboge-50 px-4 py-2 text-center text-[12.5px] text-gamboge-800">
            会话将于 {fmtTime(me.session_expires_at, true)} 到期，请先保存后重新登录以续期。
          </div>
        )}
        {me?.admin_override && (
          <div className="flex items-center justify-center gap-3 border-b border-danger/30 bg-danger/10 px-5 py-2 text-[12.5px] text-danger">
            <span>正在以超级管理员访问「{me.workspace?.name}」</span>
            <button
              type="button"
              className="cursor-pointer font-medium underline"
              onClick={async () => {
                try {
                  await post('/admin/workspaces/exit', {})
                  qc.clear()
                  window.location.assign('/settings/admin')
                } catch (e) {
                  toast.error(errorMessage(e))
                }
              }}
            >
              退出
            </button>
          </div>
        )}
        {me?.role === 'viewer' && !me?.admin_override && (
          <div className="border-b border-gamboge-200 bg-gamboge-50 px-5 py-2 text-center text-[12.5px] text-gamboge-800">
            当前为观察者：可浏览内容，不能创建、编辑或推送。
          </div>
        )}
        <main className={cn('scrollbar-thin min-w-0 flex-1 overflow-y-auto pb-16 md:pb-0', contentSlide && 'overflow-x-hidden', !fullBleed && 'px-4 py-5 sm:px-8 sm:py-7 md:px-10 xl:px-12 2xl:px-14 md:pb-7', desktopPresentation && !fullBleed && 'desktop-workspace-main')}>
          <ErrorBoundary resetKey={loc.pathname}>
            <div
              key={agentMode ? 'agent' : 'workspace'}
              className={cn(
                fullBleed ? 'h-full min-h-0' : 'min-h-full',
                contentSlide === 'from-right' && 'shell-content-slide-from-right',
                contentSlide === 'from-left' && 'shell-content-slide-from-left',
              )}
            >
              {fullBleed ? <Outlet /> : <div data-testid={desktopPresentation ? 'desktop-page-frame' : undefined} className={cn('mx-auto w-full max-w-[1400px] 2xl:max-w-[1680px]', desktopPresentation && 'desktop-page-frame')}><Outlet /></div>}
            </div>
          </ErrorBoundary>
        </main>
      </div>
      {desktopPresentation && <DesktopStatusBar workspaceName={me?.workspace?.name} accountName={acc?.name} />}
      {acc && !focus && (
        <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-mist-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden" aria-label="底部导航">
          {mobileNav.map((n) => {
            const [path, query] = n.path.split('?')
            const active = loc.pathname === `${base}${path}` && (!query || loc.search.includes(query))
            return (
              <Link key={n.path || 'home'} to={`${base}${n.path}`}
                className={cn('flex flex-col items-center gap-0.5 py-2 text-[10.5px]', active ? 'font-semibold text-ink-700' : 'text-mist-500')}>
                <n.icon className="size-5" strokeWidth={1.8} />
                {n.label}
              </Link>
            )
          })}
          <button type="button" onClick={() => window.dispatchEvent(new Event('ops:notifications'))}
            className="flex cursor-pointer flex-col items-center gap-0.5 py-2 text-[10.5px] text-mist-500">
            <Bell className="size-5" strokeWidth={1.8} />
            通知
          </button>
        </nav>
      )}
      <CommandPaletteHost />
      <CreateWorkPanel />
      {me?.role !== 'viewer' && <QuickCollect />}
    </div>
  )
}
