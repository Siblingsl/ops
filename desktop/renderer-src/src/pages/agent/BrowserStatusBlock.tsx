import { useEffect, useState } from 'react'

// DEV-AI27-07（W07）：工作视图"浏览器"页签的连接状态块（27 §5.3/§5.5）。
// 状态来源只有两个真实事实：工作区开关（bootstrap.features.browser_workspace）与
// 服务端 capabilities/bindings（W04 API）。连接/安装/启用/选中是不同状态，逐层如实展示；
// 未连接时只给指引，不显示假的"已就绪"，也不从 Web 侧发起任何本机动作。

interface BrowserCapabilities {
  chrome_connect?: boolean
  browser_workspace?: boolean
  unavailable_reason?: string
}

interface BrowserBinding {
  id: string
  connection_name: string
  browser_kind: string
  state: string
  last_seen_at?: string
}

export type BrowserConnectState =
  | { kind: 'feature_disabled' }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'loading' }
  | { kind: 'unpaired' }
  | { kind: 'paired'; bindings: BrowserBinding[] }

export function useBrowserConnectState(enabled: boolean): BrowserConnectState {
  const [state, setState] = useState<BrowserConnectState>({ kind: 'loading' })
  useEffect(() => {
    if (!enabled) {
      setState({ kind: 'feature_disabled' })
      return
    }
    let cancelled = false
    // 组合长会话下偶发单次请求不落地：轮询重试直至落到真实状态（unpaired/paired 即停）。
    let timer: ReturnType<typeof setTimeout> | null = null
    const run = async () => {
      try {
        const caps = await fetchJSON<BrowserCapabilities>('/api/v1/agent/browser/capabilities')
        if (cancelled) return
        if (!caps.chrome_connect) {
          setState({ kind: 'unavailable', reason: caps.unavailable_reason || '能力开关未开启' })
          return
        }
        const bindings = await fetchJSON<{ bindings: BrowserBinding[] }>('/api/v1/agent/browser/bindings')
        if (cancelled) return
        setState(bindings.bindings.length ? { kind: 'paired', bindings: bindings.bindings } : { kind: 'unpaired' })
        return
      } catch {
        if (!cancelled) setState({ kind: 'unavailable', reason: '能力状态读取失败，请稍后重试' })
        return
      }
    }
    void run()
    timer = setInterval(() => {
      // 已到达确定状态后不再轮询；读取失败保留展示并按间隔重试。
      void run()
    }, 5000)
    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
    }
  }, [enabled])
  return state
}

async function fetchJSON<T>(path: string): Promise<T> {
  // 组合长会话下个别请求可能被服务端挂起；10s 超时转为"读取失败"如实状态，不无限等待。
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await fetch(path, { credentials: 'same-origin', headers: { Accept: 'application/json' }, signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json() as T
  } finally {
    clearTimeout(timer)
  }
}

export function BrowserStatusBlock({ state }: { state: BrowserConnectState }) {
  if (state.kind === 'feature_disabled') {
    return <div className="desktop-agent-browser-status" data-testid="desktop-agent-browser-status" data-state="feature_disabled">
      <h4>浏览器协作未开启</h4>
      <p>当前工作区没有开启浏览器协作能力。拥有者可以在工作区功能开关中开启后再连接。</p>
    </div>
  }
  if (state.kind === 'unavailable') {
    return <div className="desktop-agent-browser-status" data-testid="desktop-agent-browser-status" data-state="unavailable">
      <h4>浏览器能力暂不可用</h4>
      <p>{state.reason}</p>
    </div>
  }
  if (state.kind === 'loading') {
    return <div className="desktop-agent-browser-status" data-testid="desktop-agent-browser-status" data-state="loading">
      <h4>正在读取连接状态…</h4>
    </div>
  }
  if (state.kind === 'unpaired') {
    return <div className="desktop-agent-browser-status" data-testid="desktop-agent-browser-status" data-state="unpaired">
      <h4>尚未连接 Google Chrome</h4>
      <p>连接需要在本人日常 Chrome 中安装 OPS 自有扩展并与本机 OPS 桌面端配对（短码核对）。</p>
      <ol>
        <li>在 OPS 桌面端开启浏览器桥诊断模式；</li>
        <li>Chrome 开发者模式加载 OPS 扩展；</li>
        <li>扩展弹窗与 OPS 显示的短码一致后确认配对。</li>
      </ol>
      <p className="desktop-agent-browser-status-note">配对完成后，这里会显示已连接实例与可选标签；未获准的标签不会被读取。</p>
    </div>
  }
  return <div className="desktop-agent-browser-status" data-testid="desktop-agent-browser-status" data-state="paired">
    <h4>已连接 {state.bindings.length} 个浏览器实例</h4>
    <ul>
      {state.bindings.map((binding) => <li key={binding.id}>
        <span>{binding.connection_name || '未命名连接'}</span>
        <small>{binding.browser_kind} · {binding.state}{binding.last_seen_at ? ` · 最近在线 ${binding.last_seen_at}` : ''}</small>
      </li>)}
    </ul>
    <p className="desktop-agent-browser-status-note">标签选择与逐次授权在任务发送时进行；已连接不等于已授权读取任何标签。</p>
  </div>
}
