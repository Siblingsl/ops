import { useQueryClient } from '@tanstack/react-query'
import {
  Activity, BarChart3, Bot, BookOpen, CalendarDays, ChevronLeft, FileText, Images, Inbox, LayoutDashboard, Lightbulb, Menu, Search, Send, UserCircle2, X,
} from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, Outlet, useLocation } from 'react-router-dom'
import { toast } from 'sonner'
import { CommandPaletteHost } from '@/components/command-palette-host'
import { CreateWorkPanel } from '@/components/create-work-panel'
import { ErrorBoundary } from '@/components/error-boundary'
import { NotificationBell } from '@/components/notifications'
import { QuickCollect } from '@/components/quick-collect'
import { cn, Kbd } from '@/components/ui'
import { post, errorMessage } from '@/lib/api'
import { isElectronDesktop } from '@/lib/desktop-presentation.js'
import { releaseDesktopLeaveGuard, requestDesktopLeaveGuard } from '@/lib/desktop-settings'
import { commonSettingsPaths, settingsEntries } from '@/lib/settings-registry'
import { useCurrentAccount, useMe } from '@/lib/session'
import { setUXEnabled, usePrefs } from '@/lib/v3'
import { useAgentBootstrap } from '@/lib/agent'
import { SessionExpiryBanner } from './session-expiry-banner'
import { TodayUsage, useChromeMeta } from './today-usage'
import DesktopStatusBar from './DesktopStatusBar'
import { Brand, NavItem, RecentWorks, UserMenu } from './ShellChrome'
import { WorkspaceAccountTree } from './WorkspaceAccountTree'

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

// OPT-U04（docs/43 §4）：桌面侧栏固定主入口 3 组——AI 对话升到第一组，
// 创作只留 工作台/选题池/作品/内容日历；「运营」保留在资产与复盘组，不得丢入口。
const desktopNavGroups = [
  { label: 'AI 助手', items: [{ to: '/agent', icon: Bot, label: 'AI 对话' }] },
  { label: '创作', items: [nav[0], nav[1], nav[4], nav[3]] },
  { label: '资产与复盘', items: [nav[5], { to: '/images', icon: Images, label: '图片库' }, nav[2], nav[6], nav[7]] },
]

// GL-01：移动端底部导航只放 4 个主入口，其余一级页收进「更多」抽屉。
// 过去底部导航只有 4 项 + 通知，手机用户到不了素材库/复盘/运营/日历/图片库/设置。
const mobileNav: { path: string; icon: typeof LayoutDashboard; label: string }[] = [
  { path: '', icon: LayoutDashboard, label: '工作台' },
  { path: '/topics?tab=inbox', icon: Inbox, label: '收件箱' },
  { path: '/works', icon: FileText, label: '作品' },
  { path: '/works?status=ready', icon: Send, label: '待发布' },
]

// GL-07：「发布」原本落到筛选列表且行点击进编辑器；改称「待发布」，并在 ready 行提供「去发布」直达推送/发布包。

type MobileMoreItem = { path: string; icon: typeof LayoutDashboard; label: string; scoped?: boolean }
const mobileMoreGroups: { label: string; items: MobileMoreItem[] }[] = [
  {
    label: '创作', items: [
      { path: '/topics', icon: Lightbulb, label: '选题池', scoped: true },
      { path: '/calendar', icon: CalendarDays, label: '内容日历', scoped: true },
      { path: '/agent', icon: Bot, label: 'AI 对话' },
    ],
  },
  {
    label: '资源', items: [
      { path: '/materials', icon: BookOpen, label: '素材库', scoped: true },
      { path: '/images', icon: Images, label: '图片库' },
      { path: '/profile', icon: UserCircle2, label: '账号档案', scoped: true },
    ],
  },
  {
    label: '运营', items: [
      { path: '/ops', icon: Activity, label: '运营', scoped: true },
      { path: '/review', icon: BarChart3, label: '复盘', scoped: true },
    ],
  },
]

// GL-02：用户菜单只列 Web 可见项（D-224 软冻结项同样不列）；桌面端点击"设置…"打开设置窗，不走这里的分组。
const settingsItems = settingsEntries
  .filter((entry) => !entry.webHidden && !entry.frozenHidden)
  .map((entry) => ({ to: entry.path, icon: <entry.icon />, label: entry.label, adminOnly: entry.adminOnly }))
const commonSettings = commonSettingsPaths


function TopBar({ username, onLogout, dense, showAgent, agentMode, homeTo }: { username?: string; onLogout: () => void; dense?: boolean; showAgent?: boolean; agentMode?: boolean; homeTo: string }) {
  const meta = useChromeMeta()
  const acc = useCurrentAccount()
  const desktopPresentation = isElectronDesktop(navigator.userAgent)

  return (
    <header className={cn(
      // GL-05：顶栏自带账号/工作区下拉，必须高于页面级粘性头（作品页 .work-header 同为 z-20，
      // 且 DOM 更靠后，会把下拉整段压住导致账号点不到）。desktop-creative.css 的侧边栏注释
      // 也按「顶栏为 30」对齐，这里补上缺的 10。
      'desktop-global-header sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-mist-200/80 bg-white/90 px-3 backdrop-blur sm:gap-3 sm:px-5 xl:px-7', dense && 'work-topbar',
    )}>
      {!desktopPresentation && <WorkspaceAccountTree compact={dense} />}
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
        {!desktopPresentation && <button
          type="button"
          onClick={() => window.dispatchEvent(new Event('ops:palette'))}
          title="搜索与命令（Ctrl+K）"
          className="desktop-command-search flex h-9 cursor-pointer items-center gap-2 rounded-full border border-mist-200 bg-white px-2.5 text-[12.5px] text-mist-500 transition hover:border-mist-300 hover:text-mist-800 sm:px-3"
        >
          <Search className="size-3.5" />
          <span className="hidden md:inline">搜索</span>
          <span className="hidden md:inline"><Kbd>Ctrl K</Kbd></span>
        </button>}
        {!dense && !desktopPresentation && <TodayUsage enabled={!!acc} />}
        {!desktopPresentation && <NotificationBell />}
        {!desktopPresentation && <UserMenu username={username} onLogout={onLogout} settingsItems={settingsItems} commonSettings={commonSettings} />}
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
  const [timeNow, setTimeNow] = useState(() => Date.now())
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false)
  // GL-01：更多菜单既覆盖账号页，也覆盖全局页；全局入口不能错误拼到 /a/:id 下。
  const mobileMoreActive = mobileMoreGroups.some((group) => group.items.some((item) => {
    if (item.path === '/agent' && !showAgent) return false
    const href = item.scoped ? `${base}${item.path}` : item.path
    return loc.pathname === href
  })) || loc.pathname.startsWith('/settings/')

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
    if (!(await requestDesktopLeaveGuard(true, !desktopPresentation))) {
      releaseDesktopLeaveGuard()
      return
    }
    await post('/auth/logout').catch(() => undefined)
    qc.clear()
    location.href = '/login'
  }
  return (
    <div className="flex h-full">
      <aside id="main-navigation" aria-label="主导航" className={cn('hidden w-[248px] shrink-0 flex-col border-r border-mist-200 bg-mist-50', desktopPresentation && focus && !agentMode && 'desktop-focus-nav-hidden', (!focus || agentMode) && 'md:flex')}>
        <Brand desktop={desktopPresentation} />
        <div className="desktop-nav-content relative min-h-0 flex-1 overflow-hidden">
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
          {!desktopPresentation && (agentMode
            ? <Link to={base} className="group flex items-center gap-3 rounded-2xl px-3 py-2.5 text-[14.5px] font-medium text-mist-600 transition-all hover:bg-mist-100/90 hover:text-mist-900"><ChevronLeft className="size-[18px] shrink-0 text-mist-400 group-hover:text-mist-600" strokeWidth={1.8} />返回工作台</Link>
            : showAgent && <NavItem to="/agent" icon={Bot}>AI 对话</NavItem>)}
          {desktopPresentation && <NotificationBell sidebar>{(unread) => <UserMenu username={me?.username} onLogout={logout} unread={unread} settingsItems={settingsItems} commonSettings={commonSettings} accountTree={<WorkspaceAccountTree />} />}</NotificationBell>}
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        {!focus && !desktopPresentation && <TopBar username={me?.username} onLogout={logout} dense={loc.pathname.startsWith('/works/')} showAgent={showAgent} agentMode={agentMode} homeTo={base} />}
        {me?.session_expires_at && Date.parse(me.session_expires_at) > timeNow && Date.parse(me.session_expires_at) - timeNow < 24 * 60 * 60 * 1000 && (
          <SessionExpiryBanner
            expiresAt={me.session_expires_at}
            onRenewed={() => qc.invalidateQueries({ queryKey: ['me'] })}
            onBeforeLogout={async () => {
              const allowed = await requestDesktopLeaveGuard(true, !desktopPresentation)
              if (!allowed) releaseDesktopLeaveGuard()
              return allowed
            }}
            onLogoutFailure={() => releaseDesktopLeaveGuard()}
          />
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
            const workRoute = n.path === '/works' && loc.pathname.startsWith('/works/')
            const active = workRoute || (
              loc.pathname === `${base}${path}`
              && (!query || loc.search.includes(query))
              && !(n.path === '/works' && loc.search.includes('status=ready'))
            )
            return (
              <Link key={n.path || 'home'} to={`${base}${n.path}`}
                className={cn('flex flex-col items-center gap-0.5 py-2 text-[10.5px]', active ? 'font-semibold text-ink-700' : 'text-mist-500')}>
                <n.icon className="size-5" strokeWidth={1.8} />
                {n.label}
              </Link>
            )
          })}
          <button type="button" onClick={() => setMobileMoreOpen(true)} aria-label="更多导航"
            className={cn('flex cursor-pointer flex-col items-center gap-0.5 py-2 text-[10.5px]', mobileMoreActive ? 'font-semibold text-ink-700' : 'text-mist-500')}>
            <Menu className="size-5" strokeWidth={1.8} />
            更多
          </button>
        </nav>
      )}
      {mobileMoreOpen && acc && (
        <div className="fixed inset-0 z-40 flex items-end md:hidden" role="dialog" aria-label="更多导航" aria-modal="true">
          <div className="absolute inset-0 bg-mist-900/30" onClick={() => setMobileMoreOpen(false)} />
          <div className="scrollbar-thin relative max-h-[76vh] w-full overflow-y-auto rounded-t-2xl border-t border-mist-200 bg-white pb-[calc(16px+env(safe-area-inset-bottom))]">
            <div className="flex items-center justify-between border-b border-mist-100 px-5 py-3">
              <h2 className="font-display text-[15px] font-bold text-mist-900">全部页面</h2>
              <button type="button" onClick={() => setMobileMoreOpen(false)} className="cursor-pointer rounded-md p-1.5 text-mist-400 hover:bg-mist-100" aria-label="关闭">
                <X className="size-4" />
              </button>
            </div>
            {mobileMoreGroups.map((group) => (
              <div key={group.label} className="px-5 pt-3">
                <div className="mb-1.5 text-[11px] font-semibold tracking-[0.16em] text-mist-400">{group.label}</div>
                <div className="grid grid-cols-4 gap-2">
                  {group.items.filter((item) => item.path !== '/agent' || showAgent).map((item) => {
                    const href = item.scoped ? `${base}${item.path}` : item.path
                    const active = loc.pathname === href
                    return (
                      <Link key={item.path} to={href} onClick={() => setMobileMoreOpen(false)}
                        className={cn('flex flex-col items-center gap-1 rounded-xl px-1 py-2.5 text-[11px]', active ? 'bg-ink-50 font-semibold text-ink-700' : 'text-mist-600')}>
                        <item.icon className="size-5" strokeWidth={1.8} />
                        <span className="truncate">{item.label}</span>
                      </Link>
                    )
                  })}
                </div>
              </div>
            ))}
            <div className="mt-3 border-t border-mist-100 px-5 pt-3">
              <div className="mb-1.5 text-[11px] font-semibold tracking-[0.16em] text-mist-400">设置</div>
              <div className="grid grid-cols-4 gap-2">
                {settingsItems.filter((item) => !item.adminOnly || me?.is_system_admin).map((item) => (
                  <Link key={item.to} to={item.to} onClick={() => setMobileMoreOpen(false)}
                    className={cn('flex flex-col items-center gap-1 rounded-xl px-1 py-2.5 text-[11px]', loc.pathname === item.to ? 'bg-ink-50 font-semibold text-ink-700' : 'text-mist-600')}>
                    {item.icon}
                    <span className="truncate">{item.label}</span>
                  </Link>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
      <CommandPaletteHost />
      <CreateWorkPanel />
      {me?.role !== 'viewer' && <QuickCollect />}
    </div>
  )
}
