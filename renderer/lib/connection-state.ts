import { useEffect, useState } from 'react'

// UI-09（docs/38）：全局底栏由真实连接态驱动，替代“操作状态由当前页面反馈”开发文案。
// 状态来源：navigator.onLine + online/offline 事件 + /healthz 轻量探测（2s 超时）。
// 只读消费，不参与业务鉴权；探测失败不弹窗，只在底栏显示“离线，点击重试”。

export type ConnectionState = 'online' | 'checking' | 'offline'

let probing: Promise<boolean> | null = null

async function probe(): Promise<boolean> {
  if (probing) return probing
  probing = (async () => {
    try {
      const controller = new AbortController()
      const timer = window.setTimeout(() => controller.abort(), 2_000)
      const response = await fetch('/api/v1/healthz', { signal: controller.signal, cache: 'no-store' })
      window.clearTimeout(timer)
      return response.ok
    } catch {
      return false
    } finally {
      probing = null
    }
  })()
  return probing
}

export function useConnectionState(): { state: ConnectionState; retry: () => void } {
  const [state, setState] = useState<ConnectionState>(() => (navigator.onLine ? 'checking' : 'offline'))

  useEffect(() => {
    let alive = true
    const run = () => {
      if (!navigator.onLine) {
        if (alive) setState('offline')
        return
      }
      if (alive) setState('checking')
      void probe().then((ok) => {
        if (alive) setState(ok ? 'online' : 'offline')
      })
    }
    run()
    window.addEventListener('online', run)
    window.addEventListener('offline', run)
    return () => {
      alive = false
      window.removeEventListener('online', run)
      window.removeEventListener('offline', run)
    }
  }, [])

  return { state, retry: () => {
    setState('checking')
    void probe().then((ok) => setState(ok ? 'online' : 'offline'))
  } }
}
