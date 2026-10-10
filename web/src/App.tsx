import { useQuery } from '@tanstack/react-query'
import { Navigate, Route, Routes } from 'react-router-dom'
import { PageLoading } from './components/ui'
import Shell from './layout/Shell'
import { get } from './lib/api'
import { rememberedAccount, useAccounts, useMe } from './lib/session'
import Dashboard from './pages/Dashboard'
import Login from './pages/Login'
import Materials from './pages/Materials'
import ProfilePage from './pages/Profile'
import Review from './pages/Review'
import Setup from './pages/Setup'
import Topics from './pages/Topics'
import Works from './pages/Works'
import Register from './pages/Register'
import SettingsAccounts from './pages/settings/Accounts'
import Logs from './pages/settings/Logs'
import Members from './pages/settings/Members'
import Models from './pages/settings/Models'
import Security from './pages/settings/Security'
import Trash from './pages/settings/Trash'
import Usage from './pages/settings/Usage'
import Words from './pages/settings/Words'
import Prompts from './pages/settings/Prompts'
import ExportPage from './pages/settings/Export'
import Check from './pages/work/Check'
import Compare from './pages/work/Compare'
import Editor from './pages/work/Editor'
import Pack from './pages/work/Pack'
import Preview from './pages/work/Preview'
import Push from './pages/work/Push'
import WorkLayout from './pages/work/WorkLayout'

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

function Authed() {
  const status = useQuery({ queryKey: ['auth-status'], queryFn: () => get<{ needs_setup: boolean }>('/auth/status') })
  const me = useMe()
  if (status.isLoading || (me.isLoading && !status.data?.needs_setup)) {
    return <div className="flex h-full items-center justify-center paper"><PageLoading /></div>
  }
  if (status.data?.needs_setup) return <Navigate to="/setup" replace />
  if (me.isError || !me.data) return <Navigate to={'/login?next=' + encodeURIComponent(location.pathname)} replace />
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Home />} />
        <Route path="a/:accountId">
          <Route index element={<Dashboard />} />
          <Route path="topics" element={<Topics />} />
          <Route path="works" element={<Works />} />
          <Route path="materials" element={<Materials />} />
          <Route path="review" element={<Review />} />
          <Route path="profile" element={<ProfilePage />} />
        </Route>
        <Route path="works/:workId" element={<WorkLayout />}>
          <Route index element={<Editor />} />
          <Route path="compare" element={<Compare />} />
          <Route path="preview" element={<Preview />} />
          <Route path="check" element={<Check />} />
          <Route path="push" element={<Push />} />
          <Route path="pack" element={<Pack />} />
        </Route>
        <Route path="settings">
          <Route index element={<Navigate to="accounts" replace />} />
          <Route path="accounts" element={<SettingsAccounts />} />
          <Route path="members" element={<Members />} />
          <Route path="models" element={<Models />} />
          <Route path="words" element={<Words />} />
          <Route path="usage" element={<Usage />} />
          <Route path="logs" element={<Logs />} />
          <Route path="trash" element={<Trash />} />
          <Route path="prompts" element={<Prompts />} />
          <Route path="export" element={<ExportPage />} />
          <Route path="security" element={<Security />} />
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
