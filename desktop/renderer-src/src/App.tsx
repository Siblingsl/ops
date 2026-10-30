import { useQuery } from '@tanstack/react-query'
import { lazy, Suspense } from 'react'
import { Navigate, Outlet, Route, Routes } from 'react-router-dom'
import { PageSkeleton } from './components/error-boundary'
import { Button, Card, PageLoading, Spinner } from './components/ui'
import { ApiError, errorMessage, get } from './lib/api'
import { DESKTOP_ACCOUNT_SWITCHER_REQUEST } from './lib/desktop-settings'
import { isElectronDesktop } from './lib/desktop-presentation.js'
import { rememberedAccount, useAccounts, useCurrentAccountSelection, useMe } from './lib/session'
import DesktopSettingsHost from './layout/DesktopSettingsHost'

const Shell = lazy(() => import('./layout/Shell'))
const Dashboard = lazy(() => import('./pages/Dashboard'))
const Topics = lazy(() => import('./pages/Topics'))
const CalendarPage = lazy(() => import('./pages/Calendar'))
const Works = lazy(() => import('./pages/Works'))
const Materials = lazy(() => import('./pages/Materials'))
const Review = lazy(() => import('./pages/Review'))
const ProfilePage = lazy(() => import('./pages/Profile'))
const Ops = lazy(() => import('./pages/Ops'))
const SearchPage = lazy(() => import('./pages/Search'))
const SharePage = lazy(() => import('./pages/Share'))
const ImagesPage = lazy(() => import('./pages/Images'))
const Agent = lazy(() => import('./pages/Agent'))
const SettingsAccounts = lazy(() => import('./pages/settings/Accounts'))
const AgentSettings = lazy(() => import('./pages/settings/Agent'))
const Logs = lazy(() => import('./pages/settings/Logs'))
const Members = lazy(() => import('./pages/settings/Members'))
const Models = lazy(() => import('./pages/settings/Models'))
const Security = lazy(() => import('./pages/settings/Security'))
const Trash = lazy(() => import('./pages/settings/Trash'))
const Usage = lazy(() => import('./pages/settings/Usage'))
const Words = lazy(() => import('./pages/settings/Words'))
const Prompts = lazy(() => import('./pages/settings/Prompts'))
const ExportPage = lazy(() => import('./pages/settings/Export'))
const SettingsAdmin = lazy(() => import('./pages/settings/Admin'))
const DailySettings = lazy(() => import('./pages/settings/Daily'))
const CrawlSettings = lazy(() => import('./pages/settings/Crawl'))
const HotSources = lazy(() => import('./pages/settings/Crawl').then((m) => ({ default: m.HotSources })))
const Quality = lazy(() => import('./pages/settings/Quality'))
const Preferences = lazy(() => import('./pages/settings/Preferences'))
const Skills = lazy(() => import('./pages/settings/Skills'))
const WorkLayout = lazy(() => import('./pages/work/WorkLayout'))
const Editor = lazy(() => import('./pages/work/Editor'))
const Compare = lazy(() => import('./pages/work/Compare'))
const Preview = lazy(() => import('./pages/work/Preview'))
const Check = lazy(() => import('./pages/work/Check'))
const CheckReport = lazy(() => import('./pages/work/CheckReport'))
const Push = lazy(() => import('./pages/work/Push'))
const Pack = lazy(() => import('./pages/work/Pack'))
const PublicPreview = lazy(() => import('./pages/PublicPreview'))
const Login = lazy(() => import('./pages/Login'))
const Register = lazy(() => import('./pages/Register'))
const Setup = lazy(() => import('./pages/Setup'))
const DesktopPolicy = lazy(() => import('./pages/settings/DesktopPolicy'))

function Home() {
  const me = useMe()
  const { data: accounts, isLoading } = useAccounts()
  const selection = useCurrentAccountSelection()
  const desktop = isElectronDesktop(navigator.userAgent)
  if (isLoading || me.isLoading || (desktop && selection.isLoading)) return <PageLoading />
  const active = accounts?.filter((a) => a.status === 'active') ?? []
  if (desktop) {
    if (!selection.account) return <Navigate to="/settings/accounts" replace />
    return <Navigate to={`/a/${selection.account.id}`} replace />
  }
  // 无平台账号：所有者去添加；编辑者去成员页等待
  if (active.length === 0) {
    return <Navigate to={me.data?.role === 'owner' ? '/settings/accounts?new=1' : '/settings/members'} replace />
  }
  const id = active.find((a) => a.id === rememberedAccount())?.id ?? active[0].id
  return <Navigate to={`/a/${id}`} replace />
}

function DesktopAccountStatusGate() {
  const selection = useCurrentAccountSelection()
  if (!isElectronDesktop(navigator.userAgent)) return <Outlet />
  if (selection.isLoading) return <PageLoading />
  if (!selection.account) return (
    <Card className="mx-auto mt-8 max-w-xl space-y-3 p-6" role="status">
      <h1 className="text-lg font-semibold text-mist-900">当前账号不可用</h1>
      <p className="text-[13px] leading-relaxed text-mist-600">此账号不属于当前工作区或已无法访问，未显示其他账号内容。请从头像菜单选择有效账号。</p>
      <div>
        <Button variant="primary" onClick={() => window.dispatchEvent(new Event(DESKTOP_ACCOUNT_SWITCHER_REQUEST))}>打开账号选择器</Button>
      </div>
    </Card>
  )
  if (selection.account.status !== 'disabled') return <Outlet />
  const account = selection.account
  return (
    <Card className="mx-auto mt-8 max-w-xl space-y-3 p-6" role="status">
      <h1 className="text-lg font-semibold text-mist-900">当前账号已停用</h1>
      <p className="text-[13px] leading-relaxed text-mist-600">“{account.name}”已停用，不能创作、读取作品或回填数据。请从头像菜单选择其他账号，或在已停用列表中重新启用。</p>
      <div>
        <Button variant="primary" onClick={() => window.dispatchEvent(new Event(DESKTOP_ACCOUNT_SWITCHER_REQUEST))}>打开账号选择器</Button>
      </div>
    </Card>
  )
}

const S = ({ children }: { children: React.ReactNode }) => <Suspense fallback={<PageSkeleton />}>{children}</Suspense>

function Authed() {
  const status = useQuery({ queryKey: ['auth-status'], queryFn: () => get<{ needs_setup: boolean }>('/auth/status') })
  const me = useMe()
  if (status.isLoading || (me.isLoading && !status.data?.needs_setup)) {
    return <div className="flex h-full items-center justify-center paper"><Spinner /></div>
  }
  if (status.data?.needs_setup) return <Navigate to="/setup" replace />
  if (me.error instanceof ApiError && me.error.status === 401) return <Navigate to={'/login?next=' + encodeURIComponent(location.pathname + location.search)} replace />
  if (me.isError && !me.data) return <div className="flex h-full items-center justify-center paper"><Card className="space-y-3 p-6" role="alert"><p>无法确认登录状态</p><p>{errorMessage(me.error)}</p><Button onClick={() => void me.refetch()}>重试</Button></Card></div>
  if (!me.data) return <Navigate to={'/login?next=' + encodeURIComponent(location.pathname + location.search)} replace />
  return (
    <Routes>
      <Route path="works/:workId/check/report" element={<S><CheckReport /></S>} />
      <Route element={<S><Shell /></S>}>
        <Route index element={<Home />} />
        <Route path="a/:accountId" element={<S><DesktopAccountStatusGate /></S>}>
          <Route index element={<S><Dashboard /></S>} />
          <Route path="topics" element={<S><Topics /></S>} />
          <Route path="calendar" element={<S><CalendarPage /></S>} />
          <Route path="works" element={<S><Works /></S>} />
          <Route path="materials" element={<S><Materials /></S>} />
          <Route path="review" element={<S><Review /></S>} />
          <Route path="profile" element={<S><ProfilePage /></S>} />
          <Route path="ops" element={<S><Ops /></S>} />
        </Route>
        <Route path="search" element={<S><SearchPage /></S>} />
        <Route path="share" element={<S><SharePage /></S>} />
        <Route path="images" element={<S><ImagesPage /></S>} />
        <Route path="agent" element={<S><Agent /></S>} />
        <Route path="agent/c/:conversationId" element={<S><Agent /></S>} />
        <Route path="works/:workId" element={<S><WorkLayout /></S>}>
          <Route index element={<S><Editor /></S>} />
          <Route path="compare" element={<S><Compare /></S>} />
          <Route path="preview" element={<S><Preview /></S>} />
          <Route path="check" element={<S><Check /></S>} />
          <Route path="push" element={<S><Push /></S>} />
          <Route path="pack" element={<S><Pack /></S>} />
        </Route>
        <Route path="settings">
          <Route index element={<Navigate to="accounts" replace />} />
          <Route path="preferences" element={<S><Preferences /></S>} />
          <Route path="accounts" element={<S><SettingsAccounts /></S>} />
          <Route path="members" element={<S><Members /></S>} />
          <Route path="models" element={<S><Models /></S>} />
          <Route path="words" element={<S><Words /></S>} />
          <Route path="usage" element={<S><Usage /></S>} />
          <Route path="quality" element={<S><Quality /></S>} />
          <Route path="logs" element={<S><Logs /></S>} />
          <Route path="trash" element={<S><Trash /></S>} />
          <Route path="prompts" element={<S><Prompts /></S>} />
          <Route path="export" element={<S><ExportPage /></S>} />
          <Route path="security" element={<S><Security /></S>} />
          <Route path="admin" element={<S><SettingsAdmin /></S>} />
          <Route path="crawl" element={<S><CrawlSettings /></S>} />
          <Route path="hot-sources" element={<S><HotSources /></S>} />
 <Route path="daily" element={<S><DailySettings /></S>} />
          <Route path="agent" element={<S><AgentSettings /></S>} />
          <Route path="skills" element={<S><Skills /></S>} />
          <Route path="desktop-ai" element={<S><DesktopPolicy /></S>} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}

export default function App() {
  return (
    <DesktopSettingsHost backdrop={<div className="min-h-full" />}>
      <Route path="login" element={<S><Login /></S>} />
      <Route path="register" element={<S><Register /></S>} />
      <Route path="setup" element={<S><Setup /></S>} />
      <Route path="preview/:token" element={<S><PublicPreview /></S>} />
      <Route path="settings/local" element={<Navigate to="/settings/local/connection" replace />} />
      <Route path="settings/local/:panel" element={<LocalSettingsLanding />} />
      <Route path="*" element={<Authed />} />
    </DesktopSettingsHost>
  )
}

function LocalSettingsLanding() {
  return <div className="flex min-h-full items-center justify-center text-sm text-mist-500" role="status">正在打开本机设置…</div>
}
