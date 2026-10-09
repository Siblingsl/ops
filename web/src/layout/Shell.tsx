import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BarChart3, BookOpen, Check, ChevronsUpDown, Cpu, FileText, Gauge, KeyRound, LayoutDashboard, Lightbulb, LogOut, Plus,
  ScrollText, Settings2, ShieldAlert, Trash2, UserCircle2, Users,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { cn, PlatformMark, formatLabel, platformLabel } from '@/components/ui'
import { get, post } from '@/lib/api'
import { fmtNum } from '@/lib/format'
import { useAccounts, useCurrentAccount, useMe } from '@/lib/session'

const nav: { end?: boolean; path: string; icon: typeof LayoutDashboard; label: string }[] = [
  { end: true, path: '', icon: LayoutDashboard, label: '工作台' },
  { path: '/topics', icon: Lightbulb, label: '选题池' },
  { path: '/works', icon: FileText, label: '作品' },
  { path: '/materials', icon: BookOpen, label: '素材库' },
  { path: '/review', icon: BarChart3, label: '复盘' },
  { path: '/profile', icon: UserCircle2, label: '账号档案' },
]

const settingsItems = [
  { to: '/settings/accounts', icon: <Users />, label: '平台账号与凭证' },
  { to: '/settings/models', icon: <Cpu />, label: '模型配置' },
  { to: '/settings/usage', icon: <Gauge />, label: 'AI 用量' },
  { to: '/settings/words', icon: <ShieldAlert />, label: '敏感词库' },
  { to: '/settings/logs', icon: <ScrollText />, label: '操作日志' },
  { to: '/settings/trash', icon: <Trash2 />, label: '回收站' },
  { to: '/settings/security', icon: <KeyRound />, label: '登录与安全' },
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

function UserMenu({ username, onLogout }: { username?: string; onLogout: () => void }) {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const loc = useLocation()
  const ref = useRef<HTMLDivElement>(null)
  const inSettings = loc.pathname.startsWith('/settings/')
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
          {settingsItems.map((item) => (
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

function AccountSwitcher({ compact }: { compact?: boolean }) {
  const current = useCurrentAccount()
  const { data: accounts } = useAccounts()
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const loc = useLocation()
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])
  const switchTo = (id: string) => {
    setOpen(false)
    const m = loc.pathname.match(/^\/a\/[^/]+(\/[^/]+)?/)
    // 在作品页切换账号时回到该账号工作台，避免带着别的账号的作品路径。
    if (loc.pathname.startsWith('/works/') || loc.pathname.startsWith('/settings/')) navigate(`/a/${id}`)
    else navigate(`/a/${id}${m?.[1] ?? ''}`)
  }
  const active = accounts?.filter((a) => a.status === 'active') ?? []
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={cn(
          'flex cursor-pointer items-center gap-2.5 rounded-full border bg-white text-left transition',
          compact ? 'h-9 max-w-[240px] pl-1.5 pr-2.5' : 'h-10 pl-1.5 pr-3',
          open ? 'border-ink-300 shadow-card' : 'border-mist-200 hover:border-mist-300',
        )}
      >
        {current ? <PlatformMark platform={current.platform} size="sm" /> : <span className="size-5 rounded bg-mist-100" />}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold text-mist-900">{current?.name ?? '选择账号'}</span>
        </span>
        {!compact && current && (
          <span className="hidden text-[11px] text-mist-400 lg:inline">{platformLabel[current.platform]}</span>
        )}
        <ChevronsUpDown className="size-3.5 shrink-0 text-mist-400" />
      </button>
      {open && (
        <div className="absolute left-0 top-[calc(100%+8px)] z-40 w-[280px] animate-fade-in rounded-xl border border-mist-200 bg-white p-1.5 shadow-pop">
          <div className="px-2.5 pb-1 pt-1.5 text-[11px] font-semibold tracking-wider text-mist-400">切换平台账号</div>
          {active.map((a) => (
            <button key={a.id} type="button" onClick={() => switchTo(a.id)}
              className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-mist-50">
              <PlatformMark platform={a.platform} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-medium text-mist-800">{a.name}</span>
                <span className="block text-[11.5px] text-mist-400">{platformLabel[a.platform]} · {formatLabel[a.content_format]}</span>
              </span>
              {a.id === current?.id && <Check className="size-3.5 text-ink-600" />}
            </button>
          ))}
          <div className="my-1 border-t border-mist-100" />
          <button type="button" onClick={() => { setOpen(false); navigate('/settings/accounts?new=1') }}
            className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-[13.5px] text-mist-600 hover:bg-mist-50">
            <Plus className="size-4" /> 添加平台账号
          </button>
        </div>
      )}
    </div>
  )
}

function useChromeMeta() {
  const loc = useLocation()
  const acc = useCurrentAccount()
  return useMemo(() => {
    const path = loc.pathname
    if (path.startsWith('/settings/')) {
      const hit = settingsItems.find((s) => path.startsWith(s.to))
      return { crumb: '设置', title: hit?.label ?? '设置' }
    }
    if (path.startsWith('/works/')) return { crumb: acc?.name ?? '作品', title: '创作中' }
    if (!acc) return { crumb: '运助', title: '选择账号' }
    const map: { test: RegExp; title: string }[] = [
      { test: /\/topics$/, title: '选题池' },
      { test: /\/works$/, title: '作品' },
      { test: /\/materials$/, title: '素材库' },
      { test: /\/review$/, title: '数据复盘' },
      { test: /\/profile$/, title: '账号档案' },
      { test: /\/a\/[^/]+$/, title: '工作台' },
    ]
    return { crumb: acc.name, title: map.find((m) => m.test.test(path))?.title ?? '工作台' }
  }, [loc.pathname, acc])
}

function TopBar({ username, onLogout, dense }: { username?: string; onLogout: () => void; dense?: boolean }) {
  const meta = useChromeMeta()
  const acc = useCurrentAccount()
  const navigate = useNavigate()
  const dash = useQuery({
    queryKey: ['dashboard', acc?.id],
    queryFn: () => get<{ tokens_today: number }>('/accounts/' + acc!.id + '/dashboard'),
    enabled: !!acc && !dense,
    staleTime: 60_000,
  })

  return (
    <header className={cn(
      'sticky top-0 z-20 flex shrink-0 items-center gap-3 border-b border-mist-200/80 bg-white/90 px-5 backdrop-blur xl:px-7',
      dense ? 'h-12' : 'h-14',
    )}>
      <AccountSwitcher compact={dense} />
      <div className="hidden h-4 w-px bg-mist-200 sm:block" />
      <nav className="hidden min-w-0 flex-1 items-center gap-2 text-[13px] sm:flex" aria-label="当前位置">
        <span className="truncate text-mist-400">{meta.crumb}</span>
        <span className="text-mist-300">/</span>
        <span className="truncate font-semibold text-mist-800">{meta.title}</span>
      </nav>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {!dense && (
          <button
            type="button"
            onClick={() => navigate('/settings/usage')}
            className="hidden h-9 cursor-pointer items-center gap-1.5 rounded-full border border-mist-200 bg-white px-3 text-[12.5px] text-mist-600 transition hover:border-mist-300 hover:text-mist-800 md:inline-flex"
            title="查看 AI 用量"
          >
            <Gauge className="size-3.5 text-ink-600" />
            {dash.data ? <>今日 {fmtNum(dash.data.tokens_today)} token</> : 'AI 用量'}
          </button>
        )}
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
  const logout = async () => {
    await post('/auth/logout').catch(() => undefined)
    qc.clear()
    location.href = '/login'
  }
  return (
    <div className="flex h-full">
      <aside className="flex w-[248px] shrink-0 flex-col border-r border-mist-200 bg-mist-50">
        <Brand />
        <nav className="scrollbar-thin flex-1 space-y-1 overflow-y-auto px-3 pb-4">
          <div className="mb-1.5 px-3 text-[11px] font-semibold tracking-[0.16em] text-mist-400">创作</div>
          {nav.map((item) => (
            <NavItem
              key={item.path || 'home'}
              to={`${base}${item.path}`}
              end={item.end}
              icon={item.icon}
            >
              {item.label}
            </NavItem>
          ))}
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
        <TopBar username={me?.username} onLogout={logout} dense={fullBleed} />
        <main className={cn('scrollbar-thin min-w-0 flex-1 overflow-y-auto', !fullBleed && 'px-8 py-7 sm:px-10 xl:px-12 2xl:px-14')}>
          {fullBleed ? <Outlet /> : <div className="mx-auto w-full max-w-[1400px] 2xl:max-w-[1680px]"><Outlet /></div>}
        </main>
      </div>
    </div>
  )
}
