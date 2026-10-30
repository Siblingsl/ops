import { ArrowUpRight, ChevronDown, ChevronRight, Search, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Routes, useLocation, useNavigate, type Location } from 'react-router-dom'
import { toast } from 'sonner'
import { confirm } from '@/components/dialog'
import { ErrorBoundary } from '@/components/error-boundary'
import { currentAccountSettingsPath, DESKTOP_ACCOUNT_CREATE_READY, DESKTOP_ACCOUNT_CREATE_REQUEST, DESKTOP_ACCOUNT_SWITCHER_FROM_SETTINGS_REQUEST, DESKTOP_ACCOUNT_SWITCHER_READY, DESKTOP_ACCOUNT_SWITCHER_REQUEST, DESKTOP_LEAVE_GUARD_RELEASE, DESKTOP_LEAVE_GUARD_REQUEST, DESKTOP_LOCAL_SETTINGS_REQUEST, DesktopSettingsContext, desktopSettingsEntries, desktopSettingsEntryLabel, desktopSettingsPanel, requestDesktopLeaveGuard, settingsGroupOf, type SettingsGroupName } from '@/lib/desktop-settings'
import { isElectronDesktop } from '@/lib/desktop-presentation.js'
import { rememberAccount, useCurrentAccountSelection, useMe } from '@/lib/session'
import type { Platform } from '@/lib/types'
import { platformLabel } from '@/components/ui'
import DesktopSettingsContent from './DesktopSettingsContent'

const locationPath = (location: Location) => location.pathname + location.search + location.hash

/** 拥有路由离开保护与客户端设置呈现，业务表单/权限仍由既有页面和 API 拥有。 */
export default function DesktopSettingsHost({ children, backdrop }: { children: ReactNode; backdrop: ReactNode }) {
  const location = useLocation()
  const navigate = useNavigate()
  const desktop = isElectronDesktop(navigator.userAgent)
  const accountSelection = useCurrentAccountSelection()
  const [shown, setShown] = useState(location)
  const background = useRef<Location | null>(null)
  const [drafts, setDrafts] = useState<Record<string, { dirty: boolean; busy: boolean }>>({})
  const [localState, setLocalState] = useState({ dirty: false, busy: false })
  const [pendingAccountCreate, setPendingAccountCreate] = useState<Platform | null>(null)
  const dispatchedAccountCreate = useRef<Platform | null>(null)
  const draftRef = useRef(drafts)
  const localStateRef = useRef(localState)
  const confirmation = useRef<Promise<boolean> | null>(null)
  const leavePermit = useRef(false)
  const legacyHandled = useRef<string | null>(null)
  const openSwitcherAfterClose = useRef(false)
  const panel = desktop ? desktopSettingsPanel(shown.pathname) : undefined
  const selectedAccountId = accountSelection.account?.id
  const updateDraft = useCallback((id: string, dirty: boolean, busy: boolean) => {
    const next = { ...draftRef.current }
    if (!dirty && !busy) delete next[id]
    else next[id] = { dirty, busy }
    draftRef.current = next
    setDrafts(next)
  }, [])
  const context = useMemo(() => ({ updateDraft, isBusy: () => Object.values(draftRef.current).some((draft) => draft.busy) }), [updateDraft])

  const askBeforeLeaving = useCallback(async () => {
    const states = Object.values(draftRef.current)
    if (states.some((state) => state.busy) || localStateRef.current.busy) {
      toast.info('正在保存设置，请稍候再离开')
      return false
    }
    if (!states.some((state) => state.dirty) && !localStateRef.current.dirty) return true
    confirmation.current ??= confirm({ title: '放弃未保存的设置？', desc: '当前输入尚未保存，离开后将丢弃这些修改。', confirmText: '放弃修改', danger: true }).finally(() => { confirmation.current = null })
    return confirmation.current
  }, [])

  useEffect(() => {
    if (!desktop || !window.opsDesktopUI) return
    const unsubscribeOpen = window.opsDesktopUI.onOpenSettings(() => {
      if (panel?.localPanel) {
        navigate(background.current ? locationPath(background.current) : selectedAccountId ? `/a/${selectedAccountId}` : '/login', { replace: true })
      } else {
        navigate('/settings/local/connection')
      }
    })
    const unsubscribeState = window.opsDesktopUI.onLocalSettingsState((state) => {
      localStateRef.current = state
      setLocalState(state)
    })
    return () => {
      unsubscribeOpen()
      unsubscribeState()
    }
  }, [desktop, panel?.localPanel, navigate, selectedAccountId])

  useEffect(() => {
    if (!desktop) return
    const requestLocal = (event: Event) => {
      const requested = (event as CustomEvent<{ panel?: unknown }>).detail?.panel
      if (requested === 'connection' || requested === 'ai' || requested === 'account-device' || requested === 'diagnostics') {
        navigate(`/settings/local/${requested}`)
      }
    }
    window.addEventListener(DESKTOP_LOCAL_SETTINGS_REQUEST, requestLocal)
    return () => window.removeEventListener(DESKTOP_LOCAL_SETTINGS_REQUEST, requestLocal)
  }, [desktop, navigate])

  const previousLocalPanel = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!desktop) return
    if (panel?.localPanel) {
      window.open(`ops-desktop://ui/settings/${panel.localPanel}`, '_blank', 'noopener,noreferrer')
    } else if (previousLocalPanel.current) {
      window.open(`ops-desktop://ui/settings/${panel ? 'detach' : 'close'}`, '_blank', 'noopener,noreferrer')
    }
    previousLocalPanel.current = panel?.localPanel
  }, [desktop, panel?.path, panel?.localPanel])

  useEffect(() => {
    if (!desktop) return
    const request = (event: Event) => {
      const detail = (event as CustomEvent<{
        reserveNavigation?: boolean
        register?: (check: () => Promise<boolean> | boolean) => void
        grant?: (onAllow: () => void) => void
      }>).detail
      detail?.register?.(askBeforeLeaving)
      if (detail?.reserveNavigation && panel) detail.grant?.(() => { leavePermit.current = true })
    }
    const release = () => { leavePermit.current = false }
    window.addEventListener(DESKTOP_LEAVE_GUARD_REQUEST, request)
    window.addEventListener(DESKTOP_LEAVE_GUARD_RELEASE, release)
    return () => {
      window.removeEventListener(DESKTOP_LEAVE_GUARD_REQUEST, request)
      window.removeEventListener(DESKTOP_LEAVE_GUARD_RELEASE, release)
    }
  }, [desktop, askBeforeLeaving, panel])

  useEffect(() => {
    if (!desktop) return
    const openPicker = async () => {
      if (!(await requestDesktopLeaveGuard(true))) return
      openSwitcherAfterClose.current = true
      const returnTo = background.current
        ? locationPath(background.current)
        : selectedAccountId ? `/a/${selectedAccountId}` : '/images'
      navigate(returnTo, { replace: true })
    }
    window.addEventListener(DESKTOP_ACCOUNT_SWITCHER_FROM_SETTINGS_REQUEST, openPicker)
    return () => window.removeEventListener(DESKTOP_ACCOUNT_SWITCHER_FROM_SETTINGS_REQUEST, openPicker)
  }, [desktop, navigate, selectedAccountId])

  useEffect(() => {
    if (!desktop || panel || !openSwitcherAfterClose.current) return
    openSwitcherAfterClose.current = false
    const dispatch = () => window.dispatchEvent(new Event(DESKTOP_ACCOUNT_SWITCHER_REQUEST))
    if (document.documentElement.dataset.desktopAccountSwitcherReady === 'true') {
      dispatch()
      return
    }
    window.addEventListener(DESKTOP_ACCOUNT_SWITCHER_READY, dispatch, { once: true })
    return () => window.removeEventListener(DESKTOP_ACCOUNT_SWITCHER_READY, dispatch)
  }, [desktop, panel, location.pathname])

  useEffect(() => {
    if (!desktop || shown.pathname !== '/settings/accounts' || !selectedAccountId) return
    const params = new URLSearchParams(shown.search)
    if (params.has('id') || params.has('new') || params.has('q')) return
    navigate(currentAccountSettingsPath(selectedAccountId), { replace: true, state: shown.state })
  }, [desktop, shown, selectedAccountId, navigate])

  useEffect(() => {
    if (!desktop || shown.pathname !== '/settings/accounts') return
    const params = new URLSearchParams(shown.search)
    if (!params.has('new') && !params.has('q')) return
    if (accountSelection.isLoading) return
    const token = locationPath(shown)
    if (legacyHandled.current === token) return
    legacyHandled.current = token
    if (params.get('q') === '1') {
      requestAnimationFrame(() => window.dispatchEvent(new Event(DESKTOP_ACCOUNT_SWITCHER_FROM_SETTINGS_REQUEST)))
      return
    }
    const requestedPlatform = params.get('platform')
    const isPlatform = requestedPlatform === 'wechat_mp' || requestedPlatform === 'xhs' || requestedPlatform === 'toutiao'
    if (requestedPlatform && !isPlatform) toast.error('历史账号创建链接中的平台参数无效，请从头像菜单选择平台后添加。')
    if (!isPlatform && !selectedAccountId) {
      if (!background.current || ['/login', '/register', '/setup'].includes(background.current.pathname)) {
        background.current = { ...shown, pathname: '/images', search: '', hash: '' }
      }
      requestAnimationFrame(() => window.dispatchEvent(new Event(DESKTOP_ACCOUNT_SWITCHER_FROM_SETTINGS_REQUEST)))
      return
    }
    const platform = isPlatform ? requestedPlatform : accountSelection.account?.platform
    if (!background.current) background.current = { ...shown, pathname: selectedAccountId ? `/a/${selectedAccountId}` : '/images', search: '', hash: '' }
    navigate(currentAccountSettingsPath(selectedAccountId), { replace: true, state: shown.state })
    if (platform) setPendingAccountCreate(platform)
  }, [desktop, shown, selectedAccountId, accountSelection.account?.platform, accountSelection.isLoading, navigate])

  useEffect(() => {
    if (!desktop) return
    if (!pendingAccountCreate) {
      dispatchedAccountCreate.current = null
      return
    }
    if (dispatchedAccountCreate.current === pendingAccountCreate) return
    const dispatch = () => {
      if (document.documentElement.dataset.desktopAccountCreateReady !== 'true' || dispatchedAccountCreate.current === pendingAccountCreate) return
      dispatchedAccountCreate.current = pendingAccountCreate
      window.dispatchEvent(new CustomEvent(DESKTOP_ACCOUNT_CREATE_REQUEST, { detail: { platform: pendingAccountCreate } }))
      setPendingAccountCreate(null)
    }
    if (document.documentElement.dataset.desktopAccountCreateReady === 'true') {
      dispatch()
      return
    }
    window.addEventListener(DESKTOP_ACCOUNT_CREATE_READY, dispatch)
    return () => window.removeEventListener(DESKTOP_ACCOUNT_CREATE_READY, dispatch)
  }, [desktop, pendingAccountCreate])

  useEffect(() => {
    if (!desktop || panel || !accountSelection.account || !accountSelection.userId || !accountSelection.workspaceId) return
    if (!/^\/a\/[^/]+(?:\/|$)/.test(location.pathname) && !/^\/works\/[^/]+(?:\/|$)/.test(location.pathname)) return
    rememberAccount(accountSelection.account.id, accountSelection.userId, accountSelection.workspaceId)
  }, [desktop, panel, accountSelection.account?.id, accountSelection.userId, accountSelection.workspaceId, location.pathname])

  useEffect(() => {
    if (locationPath(location) === locationPath(shown)) return
    let cancelled = false
    if (!desktop) {
      // 在确认结束前继续渲染 shown，浏览器后退也不能先卸载未保存表单。
      void requestDesktopLeaveGuard(false, true).then(allowed => {
        if (cancelled) return
        if (allowed) setShown(location)
        else navigate(locationPath(shown), { replace: true, state: shown.state })
      })
      return () => { cancelled = true }
    }
    const nextPanel = desktopSettingsPanel(location.pathname)
    const accept = async () => {
      const requestedAccountId = (location.state as { opsAccountSwitchId?: unknown } | null)?.opsAccountSwitchId
      if (nextPanel?.scope === '当前账号' && !panel && typeof requestedAccountId === 'string'
        && requestedAccountId !== selectedAccountId && accountSelection.accounts?.some((account) => account.id === requestedAccountId)) {
        const saved = await requestDesktopLeaveGuard()
        if (cancelled) return
        if (!saved) {
          navigate(locationPath(shown), { replace: true, state: shown.state })
          return
        }
      }
      const currentTarget = new URLSearchParams(shown.search).get('id') ?? selectedAccountId ?? ''
      const nextTarget = new URLSearchParams(location.search).get('id') ?? selectedAccountId ?? ''
      const leavingPanel = !!panel && panel.path !== nextPanel?.path
      const changingAccount = panel?.scope === '当前账号' && nextPanel?.path === panel.path && currentTarget !== nextTarget
      if (panel && (leavingPanel || changingAccount)) {
        if (panel.localPanel) window.open('ops-desktop://ui/settings/detach', '_blank', 'noopener,noreferrer')
        const allowed = leavePermit.current ? (leavePermit.current = false, true) : await askBeforeLeaving()
        if (cancelled) return
        if (!allowed) {
          navigate(locationPath(shown), { replace: true, state: shown.state })
          if (panel.localPanel) window.open(`ops-desktop://ui/settings/${panel.localPanel}`, '_blank', 'noopener,noreferrer')
          return
        }
        if (panel.localPanel) {
          localStateRef.current = { dirty: false, busy: false }
          setLocalState(localStateRef.current)
        }
      }
      if (cancelled) return
      if (nextPanel && !panel) background.current = shown
      if (!nextPanel) background.current = null
      if (typeof requestedAccountId === 'string'
        && accountSelection.accounts?.some((account) => account.id === requestedAccountId)
        && accountSelection.userId && accountSelection.workspaceId) {
        rememberAccount(requestedAccountId, accountSelection.userId, accountSelection.workspaceId)
        if (nextPanel && !panel) background.current = { ...shown, pathname: `/a/${requestedAccountId}`, search: '', hash: '' }
      }
      setShown(location)
    }
    void accept()
    return () => { cancelled = true }
  }, [desktop, location, shown, panel, selectedAccountId, accountSelection.accounts, accountSelection.userId, accountSelection.workspaceId, askBeforeLeaving, navigate])

  useEffect(() => {
    if (!panel) return
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (leavePermit.current) { leavePermit.current = false; return }
      const hasLocalChanges = localStateRef.current.dirty || localStateRef.current.busy
      const hasReactChanges = !!accountSelection.userId && !!accountSelection.workspaceId
        && Object.values(draftRef.current).some((draft) => draft.dirty || draft.busy)
      if (!hasLocalChanges && !hasReactChanges) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [panel, accountSelection.userId, accountSelection.workspaceId])

  if (!desktop) return <Routes location={shown}>{children}</Routes>
  return <>
    {panel && !background.current ? backdrop : <Routes location={panel ? background.current! : shown}>{children}</Routes>}
    {panel && <DesktopSettingsContext.Provider value={context}>
      <SettingsWindow path={panel.path} onClose={() => navigate(background.current ? locationPath(background.current) : selectedAccountId ? '/' : '/images')} dirty={Object.values(drafts).some((draft) => draft.dirty) || localState.dirty}>
        <ErrorBoundary resetKey={shown.pathname}><DesktopSettingsContent location={shown} /></ErrorBoundary>
      </SettingsWindow>
    </DesktopSettingsContext.Provider>}
  </>
}

function desktopSettingsGroup(item: (typeof desktopSettingsEntries)[number]) {
  return settingsGroupOf(item)
}

function SettingsWindow({ path, onClose, dirty, children }: { path: string; onClose: () => void; dirty: boolean; children: ReactNode }) {
  const { data: me } = useMe()
  const { account } = useCurrentAccountSelection()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const entry = desktopSettingsPanel(path)!
  const visible = desktopSettingsEntries.filter((item) => (!item.adminOnly || me?.is_system_admin) && `${desktopSettingsEntryLabel(item)} ${desktopSettingsGroup(item)} ${item.group} ${item.scope} ${item.tool ? '独立工具' : ''} ${item.keywords ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()))
  const groups = [...new Set(visible.map(desktopSettingsGroup))]
  const currentGroup = desktopSettingsGroup(entry)
  const [expandedGroup, setExpandedGroup] = useState<SettingsGroupName | ''>(currentGroup)
  const searching = query.trim().length > 0

  useEffect(() => { setExpandedGroup(currentGroup) }, [path, currentGroup])

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    ref.current?.querySelector<HTMLElement>('input')?.focus()
    const onKey = (event: KeyboardEvent) => {
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"]'))
      if (dialogs.at(-1) !== ref.current) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRef.current(); return }
      if (event.key !== 'Tab') return
      const items = Array.from(ref.current!.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex]')).filter((item) => item.tabIndex >= 0 && !item.matches(':disabled') && item.getClientRects().length > 0)
      const first = items[0]
      const last = items.at(-1)
      if (event.shiftKey && (document.activeElement === first || !ref.current!.contains(document.activeElement))) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !ref.current!.contains(document.activeElement))) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      if (opener?.isConnected) { opener.focus(); return }
      // 桌面端设置入口在用户菜单里，菜单项关闭后已经脱离文档；回退到菜单按钮，
      // 否则键盘用户关掉设置窗口后焦点会掉到 body 上，后续 Tab 从页面开头重来。
      const fallback = document.querySelector<HTMLElement>('#main-navigation a[href="/settings/preferences"]')
        ?? document.querySelector<HTMLElement>('button[aria-label^="用户菜单"]')
        ?? document.querySelector<HTMLElement>('#main-navigation a')
      fallback?.focus()
    }
  }, [])

  return createPortal(<div className="desktop-settings-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="desktop-settings-title" className="desktop-settings-window" data-testid="desktop-settings-window">
      <aside className="desktop-settings-navigation">
        <div className="desktop-settings-search"><Search aria-hidden="true" /><input aria-label="搜索设置项" placeholder="搜索设置项" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
        <nav aria-label="设置分类">{groups.map((group, index) => {
          const expanded = searching || expandedGroup === group
          const groupId = `desktop-settings-group-${index}`
          return <div key={group} className="desktop-settings-group">
            <button type="button" className="desktop-settings-group-label" aria-expanded={expanded} aria-controls={groupId} onClick={() => setExpandedGroup(expandedGroup === group ? '' : group)}>
              <span>{group}</span>{expanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
            </button>
            <div id={groupId} className="desktop-settings-group-items" hidden={!expanded}>{visible.filter((item) => desktopSettingsGroup(item) === group).map((item) => <button key={item.path} type="button" aria-current={path === item.path ? 'page' : undefined} aria-description={item.tool ? '在主窗口打开' : undefined} onClick={() => navigate(item.path)} title={item.tool ? `${desktopSettingsEntryLabel(item)} · 在主窗口打开` : desktopSettingsEntryLabel(item)}><span>{desktopSettingsEntryLabel(item)}</span>{item.tool && <ArrowUpRight aria-hidden="true" />}</button>)}</div>
          </div>
        })}{!visible.length && <p className="desktop-settings-empty">没有匹配的设置项</p>}</nav>
      </aside>
      <section className="desktop-settings-pane">
        <header className="desktop-settings-heading"><div>
          {entry.scope === '当前账号' ? <>
            <span>{account ? `账号 · ${platformLabel[account.platform]} · ${account.name}` : '当前账号'}</span>
            <small>工作区 · {me?.workspace.name ?? ''}</small>
          </> : <span>{entry.scope === '工作区' ? `工作区 · ${me?.workspace.name ?? ''}` : entry.scope === '个人' ? '仅影响你的账号' : entry.scope === '此电脑' ? '仅在此电脑生效' : '服务信息'}</span>}
          <h1 id="desktop-settings-title">{desktopSettingsEntryLabel(entry)}</h1>
        </div><button type="button" aria-label="关闭设置" onClick={onClose}><X /></button></header>
        <div className="desktop-settings-body" key={path}>{children}</div>
        <footer className="desktop-settings-footer">{dirty ? '有未保存的修改' : '配置按各项说明保存；独立工具在主窗口打开'}</footer>
      </section>
    </div>
  </div>, document.body)
}
