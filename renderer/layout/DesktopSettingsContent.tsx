import { lazy, Suspense } from 'react'
import { Route, Routes, type Location } from 'react-router-dom'
import { PageLoading } from '@/components/ui'
import { BudgetSettings } from '@/pages/settings/DesktopPanels'
import DesktopPolicy from '@/pages/settings/DesktopPolicy'

const Preferences = lazy(() => import('@/pages/settings/Preferences'))
const Accounts = lazy(() => import('@/pages/settings/Accounts'))
const Members = lazy(() => import('@/pages/settings/Members'))
const Models = lazy(() => import('@/pages/settings/Models'))
const Agent = lazy(() => import('@/pages/settings/Agent'))
const Words = lazy(() => import('@/pages/settings/Words'))
const Security = lazy(() => import('@/pages/settings/Security'))
const Export = lazy(() => import('@/pages/settings/Export'))
const Daily = lazy(() => import('@/pages/settings/Daily'))
const HotSources = lazy(() => import('@/pages/settings/Crawl').then((module) => ({ default: module.HotSources })))

export default function DesktopSettingsContent({ location }: { location: Location }) {
  return <Suspense fallback={<PageLoading />}><Routes location={location}>
    <Route path="settings">
      <Route index element={<Preferences />} />
      <Route path="preferences" element={<Preferences />} />
      <Route path="accounts" element={<Accounts />} />
      <Route path="members" element={<Members />} />
      <Route path="models" element={<Models />} />
      <Route path="agent" element={<Agent />} />
      <Route path="words" element={<Words />} />
      <Route path="security" element={<Security section="password" />} />
      <Route path="mail" element={<Security section="smtp" />} />
      <Route path="export" element={<Export />} />
      <Route path="hot-sources" element={<HotSources />} />
      <Route path="daily" element={<Daily />} />
      <Route path="budget" element={<BudgetSettings />} />
      <Route path="desktop-ai" element={<DesktopPolicy />} />
      <Route path="local/connection" element={<LocalSettingsFallback panel="connection" />} />
      <Route path="local/ai" element={<LocalSettingsFallback panel="ai" />} />
      <Route path="local/account-device" element={<LocalSettingsFallback panel="account-device" />} />
      <Route path="local/diagnostics" element={<LocalSettingsFallback panel="diagnostics" />} />
    </Route>
  </Routes></Suspense>
}

function LocalSettingsFallback({ panel }: { panel: string }) {
  return <div className="flex min-h-48 items-center justify-center text-sm text-mist-500" data-local-settings-panel={panel} role="status">本机设置正在加载…</div>
}
