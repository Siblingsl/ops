import { useQuery } from '@tanstack/react-query'
import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { PageSkeleton } from './components/error-boundary'
import { PageLoading, Spinner } from './components/ui'
import Shell from './layout/Shell'
import { get } from './lib/api'
import { rememberedAccount, useAccounts, useMe } from './lib/session'
import Login from './pages/Login'
import Register from './pages/Register'
import Setup from './pages/Setup'

const Dashboard = lazy(() => import('./pages/Dashboard'))
const Topics = lazy(() => import('./pages/Topics'))
const CalendarPage = lazy(() => import('./pages/Calendar'))
const Works = lazy(() => import('./pages/Works'))
const Materials = lazy(() => import('./pages/Materials'))
const Review = lazy(() => import('./pages/Review'))
const ProfilePage = lazy(() => import('./pages/Profile'))
const SearchPage = lazy(() => import('./pages/Search'))
const SharePage = lazy(() => import('./pages/Share'))
const ImagesPage = lazy(() => import('./pages/Images'))
const SettingsAccounts = lazy(() => import('./pages/settings/Accounts'))
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
const Quality = lazy(() => import('./pages/settings/Quality'))
const Preferences = lazy(() => import('./pages/settings/Preferences'))
const WorkLayout = lazy(() => import('./pages/work/WorkLayout'))
const Editor = lazy(() => import('./pages/work/Editor'))
const Compare = lazy(() => import('./pages/work/Compare'))
const Preview = lazy(() => import('./pages/work/Preview'))
const Check = lazy(() => import('./pages/work/Check'))
const CheckReport = lazy(() => import('./pages/work/CheckReport'))
const Push = lazy(() => import('./pages/work/Push'))
const Pack = lazy(() => import('./pages/work/Pack'))

function Home() {
  const me = useMe()
  const { data: accounts, isLoading } = useAccounts()
  if (isLoading || me.isLoading) return <PageLoading />
  const active = accounts?.filter((a) => a.status === 'active') ?? []
  // 无平台账号：所有者去添加；编辑者去成员页等待
  if (active.length === 0) {
    return <Navigate to={me.data?.role === 'owner' ? '/settings/accounts?new=1' : '/settings/members'} replace />
  }
  const id = active.find((a) => a.id === rememberedAccount())?.id ?? active[0].id
  return <Navigate to={`/a/${id}`} replace />
}

const S = ({ children }: { children: React.ReactNode }) => <Suspense fallback={<PageSkeleton />}>{children}</Suspense>

function Authed() {
  const status = useQuery({ queryKey: ['auth-status'], queryFn: () => get<{ needs_setup: boolean }>('/auth/status') })
  const me = useMe()
  if (status.isLoading || (me.isLoading && !status.data?.needs_setup)) {
    return <div className="flex h-full items-center justify-center paper"><Spinner /></div>
  }
  if (status.data?.needs_setup) return <Navigate to="/setup" replace />
  if (me.isError || !me.data) return <Navigate to={'/login?next=' + encodeURIComponent(location.pathname + location.search)} replace />
  return (
    <Routes>
      <Route path="works/:workId/check/report" element={<S><CheckReport /></S>} />
      <Route element={<Shell />}>
        <Route index element={<Home />} />
        <Route path="a/:accountId">
          <Route index element={<S><Dashboard /></S>} />
          <Route path="topics" element={<S><Topics /></S>} />
          <Route path="calendar" element={<S><CalendarPage /></S>} />
          <Route path="works" element={<S><Works /></S>} />
          <Route path="materials" element={<S><Materials /></S>} />
          <Route path="review" element={<S><Review /></S>} />
          <Route path="profile" element={<S><ProfilePage /></S>} />
        </Route>
        <Route path="search" element={<S><SearchPage /></S>} />
        <Route path="share" element={<S><SharePage /></S>} />
        <Route path="images" element={<S><ImagesPage /></S>} />
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
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/setup" element={<Setup />} />
      <Route path="/*" element={<Authed />} />
    </Routes>
  )
}
