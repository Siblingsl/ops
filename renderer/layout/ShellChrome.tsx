import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Bell, ChevronDown, ChevronRight, Clock, LayoutDashboard, LogOut, Search, Settings2, Sparkles, UserCircle2 } from 'lucide-react'
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'
import { ThemeToggle } from '@/components/theme-toggle'
import { cn, platformLabel } from '@/components/ui'
import { isElectronDesktop } from '@/lib/desktop-presentation.js'
import { DESKTOP_ACCOUNT_SWITCHER_REQUEST } from '@/lib/desktop-settings'
import { useCurrentAccount, useMe } from '@/lib/session'
import { useRecentWorks } from '@/lib/v3'

export type MenuItem = {
  label: string
  icon?: React.ReactNode
  danger?: boolean
  disabled?: boolean
  separator?: boolean
  onClick?: () => void
}

export type SettingsMenuItem = {
  to: string
  icon: React.ReactNode
  label: string
  adminOnly?: boolean
}

export function Brand({ desktop }: { desktop: boolean }) {
  if (desktop) {
    // 品牌从标题栏下移到侧栏顶部：折叠态竖排（图标 + 文字），展开态横排，两态共用同一槽位居中。
    return (
      <div className="desktop-rail-brand" title="OPS 灵感空间">
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

export function NavItem({ to, icon: Icon, children, end }: { to: string; icon: typeof LayoutDashboard; children: React.ReactNode; end?: boolean }) {
  const desktop = isElectronDesktop(navigator.userAgent)
  const label = typeof children === 'string' ? children : undefined
  const [hint, setHint] = useState<{ x: number; y: number } | null>(null)
  const showHint = (element: HTMLElement) => {
    if (!desktop || !label) return
    const rect = element.getBoundingClientRect()
    setHint({ x: rect.right + 10, y: rect.top + rect.height / 2 })
  }
  return (
    <>
    <NavLink
      to={to}
      end={end}
      title={desktop ? undefined : label}
      aria-label={label}
      onMouseEnter={(event) => showHint(event.currentTarget)}
      onMouseLeave={(event) => { if (document.activeElement !== event.currentTarget) setHint(null) }}
      onFocus={(event) => showHint(event.currentTarget)}
      onBlur={(event) => { if (!event.currentTarget.matches(':hover')) setHint(null) }}
      onClick={() => setHint(null)}
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
    {hint && createPortal(<span className="desktop-rail-tooltip" aria-hidden="true" style={{ left: hint.x, top: hint.y }}>{label}</span>, document.body)}
    </>
  )
}

export function RecentWorks() {
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

export function UserMenu({ username, onLogout, unread = 0, settingsItems, commonSettings, accountTree }: { username?: string; onLogout: () => void; unread?: number; settingsItems: SettingsMenuItem[]; commonSettings: Set<string>; accountTree?: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(() => localStorage.getItem('ops-settings-advanced-open') === '1')
  const navigate = useNavigate()
  const loc = useLocation()
  const { data: me } = useMe()
  const current = useCurrentAccount()
  const ref = useRef<HTMLDivElement>(null)
  const inSettings = loc.pathname.startsWith('/settings/')
  const desktop = isElectronDesktop(navigator.userAgent)
  const items = settingsItems.filter((item) => !item.adminOnly || me?.is_system_admin)
  const common = items.filter((item) => commonSettings.has(item.to))
  const advanced = items.filter((item) => !commonSettings.has(item.to))
  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false)
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !open) return
      setOpen(false)
      ref.current?.querySelector<HTMLButtonElement>('.desktop-user-trigger')?.focus()
    }
    document.addEventListener('mousedown', h)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', key) }
  }, [open])
  useEffect(() => { setOpen(false) }, [loc.pathname])
  return (
    <div ref={ref} className="desktop-user-menu relative">
      <button
        type="button"
        onClick={() => setOpen((v) => { if (!v && desktop) window.dispatchEvent(new CustomEvent('ops:overlay', { detail: 'user-menu' })); return !v })}
        aria-label={`用户菜单：${username || '用户'}`}
        aria-description={desktop && unread > 0 ? `${unread} 条未读通知` : undefined}
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
      {desktop && unread > 0 && <span data-testid="desktop-user-unread" aria-label={`${unread} 条未读通知`} className="pointer-events-none absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-xhs px-1 text-[10px] font-bold text-white">{unread > 99 ? '99+' : unread}</span>}
      {open && (
        <div role="menu" className={cn('absolute z-40 w-[260px] animate-fade-in rounded-xl border border-mist-200 bg-white p-1.5 shadow-pop', desktop ? 'desktop-user-popup' : 'right-0 top-[calc(100%+8px)]')}>
          {desktop ? <>
          <button type="button" role="menuitem" aria-label="切换工作区与账号" title={`${me?.workspace?.name ?? ''} / ${current ? `${platformLabel[current.platform]} · ${current.name}` : '选择账号'}`} onClick={() => { setOpen(false); window.dispatchEvent(new Event(DESKTOP_ACCOUNT_SWITCHER_REQUEST)) }} className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13.5px] text-mist-700 hover:bg-mist-50"><UserCircle2 className="size-4" /> 切换工作区与账号</button>
          <button type="button" role="menuitem" onClick={() => { setOpen(false); window.dispatchEvent(new Event('ops:notifications')) }} className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13.5px] text-mist-700 hover:bg-mist-50"><Bell className="size-4" />通知与 AI 任务 {unread > 0 && <span className="ml-auto text-xs text-xhs">{unread > 99 ? '99+' : unread}</span>}</button>
          <button type="button" role="menuitem" onClick={() => { setOpen(false); window.dispatchEvent(new Event('ops:palette')) }} className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13.5px] text-mist-700 hover:bg-mist-50"><Search className="size-4" />搜索与命令 <span className="ml-auto text-xs text-mist-400">Ctrl+K</span></button>
          <ThemeToggle onToggle={() => { setOpen(false); ref.current?.querySelector<HTMLButtonElement>('.desktop-user-trigger')?.focus() }} />
          <button type="button" role="menuitem" onClick={() => { setOpen(false); navigate('/settings/preferences') }} className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13.5px] text-mist-700 hover:bg-mist-50"><Settings2 className="size-4" /> 设置…</button>
          </> : <>
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
      {desktop && accountTree}
    </div>
  )
}

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
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

