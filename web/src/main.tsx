import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { Toaster } from 'sonner'
import App from './App'
import { ApiError, post, registerReauthPrompt, registerUnauthenticated } from './lib/api'
import './styles.css'
import './styles/desktop-creative.css'
import './styles/desktop-settings.css'
import { initializeDesktopPresentation, type DesktopTheme } from './lib/desktop-presentation.js'
import DesktopTitlebar from './layout/DesktopTitlebar'

const initialDesktopTheme = initializeDesktopPresentation(
  document,
  window.localStorage,
  navigator.userAgent,
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
)

const queryClient = new QueryClient({
  queryCache: new QueryCache(),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (count, err) => !(err instanceof ApiError && err.status > 0 && err.status < 500) && count < 2,
    },
  },
})

registerUnauthenticated(() => {
  queryClient.setQueryData(['me'], null)
  if (!location.pathname.startsWith('/login') && !location.pathname.startsWith('/setup')) {
    location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search)
  }
})

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => undefined))
}

registerReauthPrompt(
  () =>
    new Promise<boolean>((resolve) => {
      const host = document.createElement('div')
      document.body.appendChild(host)
      const root = createRoot(host)
      void import('./components/dialog').then(({ PasswordPrompt }) => {
        root.render(
          <PasswordPrompt
            submit={async (password) => {
              await post('/auth/reauth', { password })
            }}
            onDone={(ok) => {
              root.unmount()
              host.remove()
              resolve(ok)
            }}
          />,
        )
      }).catch(() => {
        root.unmount()
        host.remove()
        resolve(false)
      })
    }),
)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <DesktopTitlebar />
        <DesktopThemeSync />
        <App />
      </BrowserRouter>
      <DesktopThemeToaster />
    </QueryClientProvider>
  </React.StrictMode>,
)

function DesktopThemeToaster() {
  const [theme, setTheme] = React.useState<DesktopTheme>(() => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light')
  React.useEffect(() => {
    const update = (event: Event) => setTheme((event as CustomEvent<DesktopTheme>).detail)
    window.addEventListener('ops:desktop-theme', update)
    return () => window.removeEventListener('ops:desktop-theme', update)
  }, [])
  const desktop = document.documentElement.dataset.presentation === 'ops-creative-desktop'
  return <Toaster theme={desktop ? theme : 'system'} position="bottom-center" offset={{ bottom: desktop ? 34 : 24 }} mobileOffset={{ bottom: 'calc(72px + env(safe-area-inset-bottom))' }} richColors closeButton duration={8000} style={{ zIndex: desktop ? 60 : 30 }} toastOptions={{ style: { fontFamily: 'var(--font-sans)' } }} />
}

function DesktopThemeSync() {
  React.useEffect(() => {
    if (document.documentElement.dataset.presentation !== 'ops-creative-desktop') return
    const scheme = window.matchMedia('(prefers-color-scheme: dark)')
    const update = () => {
      const next: DesktopTheme = scheme.matches ? 'dark' : 'light'
      if (document.documentElement.dataset.theme === next) return
      document.documentElement.dataset.theme = next
      window.localStorage.setItem('ops-desktop-theme', next)
      window.dispatchEvent(new CustomEvent('ops:desktop-theme', { detail: next }))
    }
    scheme.addEventListener('change', update)
    return () => scheme.removeEventListener('change', update)
  }, [])
  return null
}

if (initialDesktopTheme) window.open(`ops-desktop://ui/theme/${initialDesktopTheme}`, '_blank', 'noopener,noreferrer')
