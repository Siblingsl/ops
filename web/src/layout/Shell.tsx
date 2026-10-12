import { useQueryClient } from '@tanstack/react-query'
import {
  Activity, BarChart3, Bell, BookOpen, CalendarDays, Check, ChevronDown, ChevronRight, ChevronsUpDown, Clock, Cpu, Eye, FileText, Gauge, Images, Inbox, KeyRound,
  LayoutDashboard, Lightbulb, LogOut, Pencil, Plus, Power, ScrollText, Search, Send, Settings2, Shield, ShieldAlert, SlidersHorizontal, Trash2,
  UserCircle2, UserPlus, Users,
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { CommandPalette, openPalette } from '@/components/command-palette'
import { confirm } from '@/components/dialog'
import { ErrorBoundary } from '@/components/error-boundary'
import { NotificationBell } from '@/components/notifications'
import { QuickCollect } from '@/components/quick-collect'
import { cn, Kbd, PlatformMark, platformLabel } from '@/components/ui'
import { del, errorMessage, post } from '@/lib/api'
import { TodayUsage, useChromeMeta } from './today-usage'
import { useAccounts, useCurrentAccount, useInvalidate, useMe } from '@/lib/session'
import type { Account, Platform } from '@/lib/types'
import { setUXEnabled, usePrefs, useRecentWorks } from '@/lib/v3'

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

function Brand() {
  return (
    <div className="px-5 pb-5 pt-5">
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
  const navigate = useNavigate()
  const loc = useLocation()
  const { data: me } = useMe()
  const ref = useRef<HTMLDivElement>(null)
  const inSettings = loc.pathname.startsWith('/settings/')
  const items = settingsItems.filter((item) => !item.adminOnly || me?.is_system_admin)
  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])
  useEffect(() => { setOpen(false) }, [loc.pathname])
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className={cn(
          'flex h-9 cursor-pointer items-center gap-2 rounded-full border bg-white pl-1 pr-2.5 text-left transition',
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
          <div className="px-2.5 pb-1.5 pt-1.5 text-[11px] font-semibold tracking-wider text-mist-400">工作区设置</div>
          {items.map((item) => (
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

const PLATFORMS: Platform[] = ['wechat_mp', 'xhs']
const PLATFORM_EXPAND_KEY = 'ops.topbar.platforms'

function loadPlatformExpanded(): Record<Platform, boolean> {
  try {
    const raw = localStorage.getItem(PLATFORM_EXPAND_KEY)
    if (raw) return { wechat_mp: true, xhs: true, ...JSON.parse(raw) }
  } catch { /* ignore */ }
  return { wechat_mp: true, xhs: true }
}

/** 顶栏：工作区为根，下拉内展开公众号 / 小红书账号树 */
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
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState(loadPlatformExpanded)
  const [busy, setBusy] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)

  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])
  useEffect(() => { setOpen(false) }, [loc.pathname])

  if (!me?.workspace) return null

  const switchAccount = (id: string, sub = '') => {
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
    try {
      await post(`/workspaces/${id}/switch`, {})
      qc.clear()
      setOpen(false)
      navigate('/', { replace: true })
      window.location.reload()
    } catch {
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
    try {
      await post('/workspaces', { name: '新工作区', switch: true })
      qc.clear()
      window.location.assign('/')
    } catch (e) {
      toast.error(errorMessage(e))
      setBusy(false)
    }
  }

  const workspaceMenu = (): MenuItem[] => [
    {
      label: '成员与邀请',
      icon: <UserPlus />,
      onClick: () => { setOpen(false); navigate('/settings/members') },
    },
    {
      label: '创建工作区',
      icon: <Plus />,
      onClick: () => { setOpen(false); void createAndSwitchWorkspace() },
    },
    {
      label: '添加账号',
      icon: <Plus />,
      disabled: !canManage,
      onClick: () => { setOpen(false); navigate('/settings/accounts?new=1') },
    },
    {
      label: '管理平台账号',
      icon: <Settings2 />,
      onClick: () => { setOpen(false); navigate('/settings/accounts') },
    },
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
    {
      label: expanded[p] ? '收起' : '展开',
      icon: expanded[p] ? <ChevronDown /> : <ChevronRight />,
      onClick: () => togglePlatform(p),
    },
    { separator: true, label: '' },
    {
      label: '添加账号',
      icon: <Plus />,
      disabled: !canManage,
      onClick: () => { setOpen(false); navigate(`/settings/accounts?new=1&platform=${p}`) },
    },
    {
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
    },
  ]

  const accountMenu = (a: Account): MenuItem[] => [
    {
      label: '打开 / 选中',
      icon: <Check />,
      onClick: () => switchAccount(a.id),
    },
    {
      label: '查看资料',
      icon: <Eye />,
      onClick: () => { setOpen(false); navigate(`/settings/accounts?id=${a.id}`) },
    },
    {
      label: '编辑账号',
      icon: <Pencil />,
      disabled: !canManage,
      onClick: () => { setOpen(false); navigate(`/settings/accounts?id=${a.id}`) },
    },
    {
      label: '添加同平台账号',
      icon: <Plus />,
      disabled: !canManage,
      onClick: () => { setOpen(false); navigate(`/settings/accounts?new=1&platform=${a.platform}`) },
    },
    {
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
    },
  ]

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onContextMenu={(e) => openMenu(e, workspaceMenu())}
        className={cn(
          'flex h-9 cursor-pointer items-center gap-2 rounded-full border bg-white text-left transition',
          compact ? 'max-w-[240px] pl-2.5 pr-2' : 'max-w-[340px] pl-3 pr-2.5',
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
      </button>

      {open && (
        <div className="absolute left-0 top-[calc(100%+8px)] z-40 w-[300px] animate-fade-in rounded-xl border border-mist-200 bg-white p-1.5 shadow-pop">
          <div className="flex items-center gap-1 px-2 pb-1 pt-1.5">
            <span className="min-w-0 flex-1 truncate text-[11px] font-semibold tracking-wider text-mist-400">{me.workspace.name}</span>
            {canManage && (
              <button
                type="button"
                title="添加账号"
                onClick={() => { setOpen(false); navigate('/settings/accounts?new=1') }}
                className="inline-flex size-5 cursor-pointer items-center justify-center rounded text-mist-400 hover:bg-mist-100 hover:text-mist-700"
              >
                <Plus className="size-3.5" />
              </button>
            )}
          </div>

          <div className="space-y-0.5">
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
                          onClick={() => { if (canManage) { setOpen(false); navigate(`/settings/accounts?new=1&platform=${p}`) } }}
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
          </div>

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

          <div className="mt-1 border-t border-mist-100 pt-1">
            <button
              type="button"
              onClick={() => { setOpen(false); navigate('/settings/members') }}
              className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] text-mist-600 hover:bg-mist-50"
            >
              <UserPlus className="size-3.5" /> 成员与邀请
            </button>
          </div>
        </div>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  )
}

function TopBar({ username, onLogout, dense }: { username?: string; onLogout: () => void; dense?: boolean }) {
  const meta = useChromeMeta(settingsItems)
  const acc = useCurrentAccount()

  return (
    <header className={cn(
      'sticky top-0 z-20 flex shrink-0 items-center gap-2 border-b border-mist-200/80 bg-white/90 px-3 backdrop-blur sm:gap-3 sm:px-5 xl:px-7',
      dense ? 'h-12' : 'h-14',
    )}>
      <WorkspaceAccountTree compact={dense} />
      <div className="hidden h-4 w-px bg-mist-200 lg:block" />
      <nav className="hidden min-w-0 flex-1 items-center gap-2 text-[13px] lg:flex" aria-label="当前位置">
        <span className="truncate text-mist-400">{meta.crumb}</span>
        <span className="text-mist-300">/</span>
        <span className="truncate font-semibold text-mist-800">{meta.title}</span>
      </nav>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={openPalette}
          title="搜索与命令（Ctrl+K）"
          className="flex h-9 cursor-pointer items-center gap-2 rounded-full border border-mist-200 bg-white px-2.5 text-[12.5px] text-mist-500 transition hover:border-mist-300 hover:text-mist-800 sm:px-3"
        >
          <Search className="size-3.5" />
          <span className="hidden md:inline">搜索</span>
          <span className="hidden md:inline"><Kbd>Ctrl K</Kbd></span>
        </button>
        {!dense && <TodayUsage enabled={!!acc} />}
        <NotificationBell />
        <UserMenu username={username} onLogout={onLogout} />
      </div>
    </header>
  )
}

export default function Shell() {
  const acc = useCurrentAccount()
  const { data: me } = useMe()
  const qc = useQueryClient()
  const loc = useLocation()
  const fullBleed = loc.pathname.startsWith('/works/')
  const base = acc ? `/a/${acc.id}` : '/'
  const prefs = usePrefs()
  useEffect(() => setUXEnabled(prefs.ux_events), [prefs.ux_events])
  const [focusMode, setFocusMode] = useState(false)
  useEffect(() => {
    const h = (e: Event) => setFocusMode(!!(e as CustomEvent<boolean>).detail)
    window.addEventListener('ops:focus', h)
    return () => window.removeEventListener('ops:focus', h)
  }, [])
  const focus = focusMode && fullBleed
  const logout = async () => {
    await post('/auth/logout').catch(() => undefined)
    qc.clear()
    location.href = '/login'
  }
  return (
    <div className="flex h-full">
      <aside className={cn('hidden w-[248px] shrink-0 flex-col border-r border-mist-200 bg-mist-50', !focus && 'md:flex')}>
        <Brand />
        <nav className="scrollbar-thin flex-1 space-y-1 overflow-y-auto px-3 pb-4">
          <div className="mb-1.5 px-3 text-[11px] font-semibold tracking-[0.16em] text-mist-400">创作</div>
          {nav.map((item) => (
            <NavItem
              key={item.path || 'home'}
              to={acc ? `${base}${item.path}` : '/settings/accounts'}
              end={item.end}
              icon={item.icon}
            >
              {item.label}
            </NavItem>
          ))}
          <div className="mb-1.5 px-3 pt-4 text-[11px] font-semibold tracking-[0.16em] text-mist-400">工作区</div>
          <NavItem to="/images" icon={Images}>图片库</NavItem>
          <RecentWorks />
        </nav>
        {me?.dev && (
          <div className="px-4 pb-4">
            <div className="rounded-2xl border border-gamboge-200/80 bg-gamboge-50/70 px-3 py-2.5 text-[11.5px] leading-relaxed text-gamboge-700">
              本地开发 · 模拟接口
            </div>
          </div>
        )}
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        {!focus && <TopBar username={me?.username} onLogout={logout} dense={fullBleed} />}
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
        <main className={cn('scrollbar-thin min-w-0 flex-1 overflow-y-auto pb-16 md:pb-0', !fullBleed && 'px-4 py-5 sm:px-8 sm:py-7 md:px-10 xl:px-12 2xl:px-14 md:pb-7')}>
          <ErrorBoundary resetKey={loc.pathname}>
            {fullBleed ? <Outlet /> : <div className="mx-auto w-full max-w-[1400px] 2xl:max-w-[1680px]"><Outlet /></div>}
          </ErrorBoundary>
        </main>
      </div>
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
      <CommandPalette />
      {me?.role !== 'viewer' && <QuickCollect />}
    </div>
  )
}
