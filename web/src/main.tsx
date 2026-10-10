import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { Toaster } from 'sonner'
import App from './App'
import { PasswordPrompt } from './components/dialog'
import { ApiError, post, registerReauthPrompt, registerUnauthenticated } from './lib/api'
import './styles.css'

const queryClient = new QueryClient({
  queryCache: new QueryCache(),
  defaultOptions: {
    queries: {
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
    }),
)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
      <Toaster position="top-center" richColors closeButton toastOptions={{ style: { fontFamily: 'var(--font-sans)' } }} />
    </QueryClientProvider>
  </React.StrictMode>,
)
