import { useQueryClient } from '@tanstack/react-query'
import {
  Check, ChevronDown, ChevronRight, ChevronsUpDown, Eye, KeyRound, Pencil, Plus, Power, Search, Settings2, Trash2, UserCircle2, UserPlus,
} from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { confirm } from '@/components/dialog'
import { cn, PlatformMark, platformLabel } from '@/components/ui'
import { del, errorMessage, post } from '@/lib/api'
import { currentAccountSettingsPath, DESKTOP_ACCOUNT_CREATE_READY, DESKTOP_ACCOUNT_CREATE_REQUEST, DESKTOP_ACCOUNT_SWITCHER_READY, DESKTOP_ACCOUNT_SWITCHER_REQUEST, releaseDesktopLeaveGuard, requestDesktopLeaveGuard } from '@/lib/desktop-settings'
import { rememberAccount, useAccounts, useCurrentAccount, useInvalidate, useMe } from '@/lib/session'
import type { Account, Platform } from '@/lib/types'
import { setRecentOwner } from '@/lib/v3'
import { flushWork } from '@/pages/work/work-save'
import AccountCreateHost from './AccountCreateHost'
import { ContextMenu, type MenuItem } from './ShellChrome'

const PLATFORMS: Platform[] = ['wechat_mp', 'xhs', 'toutiao']
// OPT-S04：无头条账号的工作区默认只展示两个主推平台；今日头条折叠进「更多实验平台」。
const PRIMARY_PLATFORMS: Platform[] = ['wechat_mp', 'xhs']
const PLATFORM_EXPAND_KEY = 'ops.topbar.platforms'

function loadPlatformExpanded(): Record<Platform, boolean> {
  try {
    const raw = localStorage.getItem(PLATFORM_EXPAND_KEY)
    if (raw) return { wechat_mp: true, xhs: true, toutiao: true, ...JSON.parse(raw) }
  } catch { /* ignore */ }
  return { wechat_mp: true, xhs: true, toutiao: true }
}

/** 客户端侧栏和浏览器顶栏各保留一个统一账号入口。 */
export function WorkspaceAccountTree({ compact }: { compact?: boolean }) {
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
  const [showExperimental, setShowExperimental] = useState(false)
  const [busy, setBusy] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [createPlatform, setCreatePlatform] = useState<Platform | null>(null)
  const createContext = useRef<{ userId: string; workspaceId: string } | null>(null)
  const identityRef = useRef<{ userId: string; workspaceId: string } | null>(null)
  identityRef.current = me?.workspace ? { userId: me.user_id ?? me.username, workspaceId: me.workspace.id } : null
  const desktop = document.documentElement.dataset.presentation === 'ops-creative-desktop'
  // 含停用账号：历史上创建过头条账号的工作区仍保留完整头条 tab 与停用列表，避免历史号找不回。
  const hasToutiaoAccount = (accounts ?? []).some((a) => a.platform === 'toutiao')
  const visiblePlatforms: Platform[] = hasToutiaoAccount ? PLATFORMS : PRIMARY_PLATFORMS

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
      if (restoreFocus) (desktop ? document.querySelector<HTMLButtonElement>('.desktop-user-trigger') : ref.current?.querySelector('button'))?.focus()
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
      const preferred = current?.platform ?? 'wechat_mp'
      setPlatform(!hasToutiaoAccount && preferred === 'toutiao' ? 'wechat_mp' : preferred)
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
  }, [current?.platform, platform, canManage, desktop, me?.user_id, me?.username, me?.workspace.id, hasToutiaoAccount])
  // 无头条账号时，若选中态停在已隐藏的 toutiao tab，回落主推平台，避免提交到看不见的平台。
  useEffect(() => {
    if (!hasToutiaoAccount && platform === 'toutiao') setPlatform('wechat_mp')
  }, [hasToutiaoAccount, platform])

  if (!me?.workspace) return null

  const switchAccount = async (id: string, sub = '') => {
    const identity = identityRef.current
    if (!identity) return
    if (!(await requestDesktopLeaveGuard(true, !desktop))) {
      releaseDesktopLeaveGuard()
      return
    }
    if (identityRef.current?.userId !== identity.userId || identityRef.current?.workspaceId !== identity.workspaceId) {
      if (desktop) releaseDesktopLeaveGuard()
      toast.info('登录用户或工作区已变化，请重新选择账号。')
      return
    }
    if (!accounts?.some((account) => account.id === id && account.status === 'active')) {
      if (desktop) releaseDesktopLeaveGuard()
      toast.info(desktop ? '该账号当前不可用，请从头像菜单重新选择。' : '该账号当前不可用，请从顶部重新选择。')
      return
    }
    setOpen(false)
    const onWork = loc.pathname.startsWith('/works/')
    if (onWork) {
      const goList = await confirm({
        title: '切换账号？',
        desc: '当前作品属于原账号。切换后可以回到新账号的作品列表；也可以取消切换，继续编辑当前作品。',
        confirmText: '切换并回到作品列表',
        cancelText: '不切换，继续当前作品',
      })
      if (!goList) {
        if (desktop) releaseDesktopLeaveGuard()
        toast.info('账号未切换；当前作品仍属于原账号。')
        return
      }
      try {
        const workId = loc.pathname.match(/^\/works\/([^/?#]+)/)?.[1]
        if (workId) await flushWork(workId)
      } catch (e) {
        if (desktop) releaseDesktopLeaveGuard()
        toast.error(`保存当前作品失败，账号未切换：${errorMessage(e)}`)
        return
      }
      rememberAccount(id, identity.userId, identity.workspaceId)
      navigate(`/a/${id}/works`)
      return
    }
    // 设置页不依赖账号路由；更新记忆的账号即可保留当前设置子页。
    if (loc.pathname.startsWith('/settings/')) {
      rememberAccount(id, identity.userId, identity.workspaceId)
      if (desktop) releaseDesktopLeaveGuard()
      toast.success(`已切换到${accounts.find((account) => account.id === id)?.name ?? '所选账号'}，保留当前设置页。`)
      return
    }
    rememberAccount(id, identity.userId, identity.workspaceId)
    const m = loc.pathname.match(/^\/a\/[^/]+(\/[^/]+)?/)
    navigate(`/a/${id}${sub || m?.[1] || ''}`)
  }

  const switchWorkspace = async (id: string) => {
    if (id === me.workspace.id || busy) return
    setBusy(true)
    if (!(await requestDesktopLeaveGuard(true, !desktop))) {
      releaseDesktopLeaveGuard()
      setBusy(false)
      return
    }
    if (identityRef.current?.workspaceId !== me.workspace.id) {
      if (desktop) releaseDesktopLeaveGuard()
      setBusy(false)
      return
    }
    // GL-04：Web 端过去直接 window.location.reload()，会整页闪白并丢掉页面位置、
    // 筛选与未提交字段。现在先 flush 编辑器缓冲，再 qc.clear() + 路由跳转（SPA 内切换）。
    const workMatch = loc.pathname.match(/^\/works\/([^/?#]+)/)
    if (workMatch) {
      try {
        await flushWork(workMatch[1])
      } catch (e) {
        if (desktop) releaseDesktopLeaveGuard()
        toast.error(`切换前保存失败：${errorMessage(e)}`)
        setBusy(false)
        return
      }
    }
    try {
      await post(`/workspaces/${id}/switch`, {})
      setRecentOwner(me.user_id ?? me.username, id)
      setBusy(false)
      qc.clear()
      setOpen(false)
      navigate('/', { replace: true })
    } catch (e) {
      if (desktop) releaseDesktopLeaveGuard()
      toast.error(`切换工作区失败：${errorMessage(e)}`)
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
    if (!(await requestDesktopLeaveGuard(true, !desktop))) {
      releaseDesktopLeaveGuard()
      setBusy(false)
      return
    }
    if (identityRef.current?.workspaceId !== me.workspace.id) {
      if (desktop) releaseDesktopLeaveGuard()
      setBusy(false)
      return
    }
    try {
      const created = await post<{ id: string }>('/workspaces', { name: '新工作区', switch: true })
      setRecentOwner(me.user_id ?? me.username, created.id)
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
    <div ref={ref} className={cn(desktop ? 'desktop-context-switcher' : 'relative min-w-0')}>
      {!desktop && <button
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
        <div id="topbar-context-menu" data-testid={desktop ? 'desktop-context-menu' : 'workspace-account-menu'} className={cn('absolute z-40 animate-fade-in rounded-xl border border-mist-200 bg-white p-1.5 shadow-pop', desktop ? 'desktop-context-menu w-[320px] max-h-[calc(100vh-152px)] overflow-y-auto' : 'left-0 top-[calc(100%+8px)] w-[300px]')}>
          <div className="flex items-center gap-1 px-2 pb-1 pt-1.5">
            <span className={cn('min-w-0 flex-1 text-[11px] font-semibold tracking-wider text-mist-400', desktop ? 'break-words' : 'truncate')}>{me.workspace.name}</span>
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
              {visiblePlatforms.map((p) => (
                <button key={p} type="button" role="tab" id={`topbar-platform-${p}`} aria-selected={platform === p} aria-controls={`topbar-accounts-${p}`} tabIndex={platform === p ? 0 : -1} onClick={() => setPlatform(p)} onContextMenu={(e) => openMenu(e, platformMenu(p))} onKeyDown={(e) => {
                  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
                  e.preventDefault()
                  const index = visiblePlatforms.indexOf(p)
                  const next = e.key === 'Home' ? visiblePlatforms[0] : e.key === 'End' ? visiblePlatforms[visiblePlatforms.length - 1] : visiblePlatforms[(index + (e.key === 'ArrowRight' ? 1 : -1) + visiblePlatforms.length) % visiblePlatforms.length]
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
                  <span className="min-w-0 flex-1 break-words" title={a.name}>{a.name}</span>
                  {a.is_demo && <span className="shrink-0 rounded bg-gamboge-100 px-1.5 py-0.5 text-[10.5px] font-medium text-gamboge-700">示例</span>}
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
            {!hasToutiaoAccount && (
              <div className="mt-1 border-t border-mist-100 pt-1">
                <button
                  type="button"
                  data-testid="desktop-toggle-experimental-platforms"
                  aria-expanded={showExperimental}
                  onClick={() => setShowExperimental((v) => !v)}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-mist-500 hover:bg-mist-50 hover:text-mist-700"
                >
                  {showExperimental ? <ChevronDown className="size-3.5 shrink-0 text-mist-400" /> : <ChevronRight className="size-3.5 shrink-0 text-mist-400" />}
                  <span className="min-w-0 flex-1">{showExperimental ? '收起更多实验平台' : '显示更多实验平台（暂缓维护）'}</span>
                </button>
                {showExperimental && (
                  <div className="space-y-1.5 px-2 pb-1">
                    <p className="text-[11.5px] leading-relaxed text-mist-500">当前主推微信公众号与小红书；今日头条仅支持发布包与手动导入（暂缓维护）。</p>
                    {canManage && <button
                      type="button"
                      onClick={() => { void openAccountCreate('toutiao') }}
                      className="flex w-full cursor-pointer items-center gap-2 rounded-lg border border-mist-200 px-2 py-1.5 text-left text-[12.5px] text-mist-600 hover:border-mist-300 hover:text-mist-900"
                    >
                      <PlatformMark platform="toutiao" size="sm" />
                      <span className="min-w-0 flex-1">添加今日头条账号</span>
                    </button>}
                  </div>
                )}
              </div>
            )}
          </> : <div className="space-y-0.5">
            {visiblePlatforms.map((p) => {
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
                              {a.is_demo && <span className="shrink-0 rounded bg-gamboge-100 px-1.5 py-0.5 text-[10.5px] font-medium text-gamboge-700">示例</span>}
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
            {!hasToutiaoAccount && (
              <div className="mt-1 border-t border-mist-100 pt-1">
                <button
                  type="button"
                  data-testid="toggle-experimental-platforms"
                  aria-expanded={showExperimental}
                  onClick={() => setShowExperimental((v) => !v)}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-mist-500 hover:bg-mist-50 hover:text-mist-700"
                >
                  {showExperimental ? <ChevronDown className="size-3.5 shrink-0 text-mist-400" /> : <ChevronRight className="size-3.5 shrink-0 text-mist-400" />}
                  <span className="min-w-0 flex-1">{showExperimental ? '收起更多实验平台' : '显示更多实验平台（暂缓维护）'}</span>
                </button>
                {showExperimental && (
                  <div className="ml-2 space-y-0.5 border-l border-mist-100 pl-1.5">
                    <p className="px-2 pt-1 text-[11.5px] leading-relaxed text-mist-400">当前主推微信公众号与小红书；今日头条仅支持发布包与手动导入（暂缓维护）。</p>
                    <button
                      type="button"
                      onClick={() => { if (canManage) { setOpen(false); navigate('/settings/accounts?new=1&platform=toutiao') } }}
                      className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-mist-500 hover:bg-mist-50 hover:text-mist-800"
                    >
                      <PlatformMark platform="toutiao" size="sm" />
                      <span className="min-w-0 flex-1 truncate">{platformLabel.toutiao}</span>
                      {canManage && <Plus className="size-3.5 shrink-0 text-mist-400" />}
                    </button>
                  </div>
                )}
              </div>
            )}
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
                  <span className={cn('min-w-0 flex-1', desktop ? 'break-words' : 'truncate')}>{w.name}</span>
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
          toast.success(account.platform === 'wechat_mp' ? '账号已添加，先建档；公众号凭证可稍后配置' : '账号已添加，先来建档', { id: 'account-create-success' })
          navigate(`/a/${account.id}/profile?wizard=1`)
        }}
      />}
    </div>
  )
}

