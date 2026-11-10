import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui'
import { ApiError, errorMessage, post } from '@/lib/api'
import type { DesktopBrowserPairingSnapshot } from '@/lib/desktop-presentation'

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
  // A30b：配对向导完成后立即刷新（window 事件），不等 5s 轮询周期。
  const [refreshSignal, setRefreshSignal] = useState(0)
  useEffect(() => {
    const onPairingDone = () => setRefreshSignal((s) => s + 1)
    window.addEventListener(PAIRING_DONE_EVENT, onPairingDone)
    return () => window.removeEventListener(PAIRING_DONE_EVENT, onPairingDone)
  }, [])
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
  }, [enabled, refreshSignal])
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
    // A30b（用户拍板：一次动作两产物）：配对统一向导——OPS 显示桥短码（与 Chrome
    // 扩展弹窗同源），核对一致后点"确认配对"一次完成本机会话与服务端绑定。
    // 步骤如实标注，不伪造"已连接"。
    return <div className="desktop-agent-browser-status" data-testid="desktop-agent-browser-status" data-state="unpaired">
      <h4>尚未连接 Google Chrome</h4>
      <p>连接需要在本人日常 Chrome 中安装 OPS 自有扩展并与本机 OPS 桌面端配对（短码核对）。</p>
      <ol>
        <li>运行 <code>node desktop/src/native-host/register.cjs</code> 注册本机宿主；</li>
        <li>Chrome 开发者模式加载 OPS 扩展（chrome://extensions → 开发者模式 → 加载已解压）；</li>
        <li>下方显示桥短码后，在 Chrome 扩展弹窗核对短码一致；</li>
        <li>点击"确认配对"，一次完成本机会话与服务端绑定。</li>
      </ol>
      <PairingWizard />
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


// A30b（用户拍板：一次动作两产物）：配对统一向导。短码来自桥（桥在扩展 hello 后
// 自动生成，Chrome 扩展弹窗显示同一短码），核对一致后点"确认配对"一次完成：
// ① 桥 confirmPairing 建 HMAC 会话（本机链路）；② 渲染器持扩展实例 ID 调服务端
// pairings+confirm 落绑定（服务端账本）。各失败路径如实显示，不伪造已连接。
const PAIRING_DONE_EVENT = 'ops-browser-pairing-done'
const DEVICE_ID_STORAGE_KEY = 'ops-browser-device-id'
const CONNECTION_NAME = '工作Chrome'

function stableDeviceId(): string {
  // 服务端不校验 device 归属（w04ConfirmBody 契约）；持久化让同一桌面设备 ID 稳定，
  // 重装扩展不换设备。localStorage 不可用时降级为一次性 ID（如实，不影响配对）。
  try {
    const existing = window.localStorage.getItem(DEVICE_ID_STORAGE_KEY)
    if (existing) return existing
    const id = crypto.randomUUID()
    window.localStorage.setItem(DEVICE_ID_STORAGE_KEY, id)
    return id
  } catch {
    return crypto.randomUUID()
  }
}

type PairingPhase = 'loading' | 'unsupported' | 'bridge-down' | 'waiting-extension' | 'code' | 'confirming' | 'bridge-paired' | 'done'

function PairingWizard() {
  const [phase, setPhase] = useState<PairingPhase>('loading')
  const [snapshot, setSnapshot] = useState<DesktopBrowserPairingSnapshot | null>(null)
  const [error, setError] = useState('')
  // 确认流程接管状态后停止桥状态轮询（否则 done/bridge-paired 会被 tick 拉回短码态）。
  const pollingStoppedRef = useRef(false)
  // 确认失败回到原状态时重启轮询（短码可能已过期，需要盯扩展重连生成的新短码）。
  const [pollEpoch, setPollEpoch] = useState(0)

  const readState = useCallback(async (): Promise<
    { kind: 'unsupported' } | { kind: 'bridge-down' } | { kind: 'ok'; snapshot: DesktopBrowserPairingSnapshot }
  > => {
    const bridge = window.opsDesktopUI
    if (!bridge?.getBrowserPairingState) return { kind: 'unsupported' }
    const result = await bridge.getBrowserPairingState()
    if (!result.ok) return { kind: 'bridge-down' }
    return { kind: 'ok', snapshot: result.snapshot }
  }, [])

  // 桥状态轮询：无有效短码时每 2s 重读（扩展连接/唤醒后产生新短码）；有短码时 5s
  // 慢轮询盯过期。确认中/完成后停止。桥未运行同样重试（等待产品路径桥起来）。
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      if (cancelled || pollingStoppedRef.current) return
      const r = await readState()
      if (cancelled) return
      if (r.kind === 'unsupported') {
        setPhase('unsupported')
        return
      }
      if (r.kind === 'bridge-down') {
        setPhase('bridge-down')
        timer = setTimeout(() => void tick(), 3000)
        return
      }
      setSnapshot(r.snapshot)
      if (r.snapshot.state === 'paired') {
        // 桥已配对：本机链路已建立；服务端绑定可能尚未落（如 SW 唤醒重配对），给补登记入口。
        setPhase('bridge-paired')
        return
      }
      const live = r.snapshot.state === 'pairing' && r.snapshot.pairing !== null && !r.snapshot.pairing.expired
      setPhase(live ? 'code' : 'waiting-extension')
      timer = setTimeout(() => void tick(), live ? 5000 : 2000)
    }
    void tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [readState, pollEpoch])

  const confirm = async () => {
    const previous = phase
    pollingStoppedRef.current = true
    setPhase('confirming')
    setError('')
    try {
      const r = await readState()
      if (r.kind !== 'ok') throw new Error('浏览器桥状态不可用；请重试。')
      let extensionId = r.snapshot.extension_instance_id
      if (r.snapshot.state === 'pairing') {
        const bridge = window.opsDesktopUI
        if (!bridge?.confirmBrowserPairing) throw new Error('需要 OPS Desktop 客户端。')
        const confirmed = await bridge.confirmBrowserPairing()
        if (!confirmed.ok) throw new Error(confirmed.message || '桥侧配对确认失败；短码可能已过期，等待扩展重连后重试。')
        extensionId = confirmed.extension_instance_id
      } else if (r.snapshot.state !== 'paired') {
        throw new Error('Chrome 扩展尚未连接到 OPS；请确认 Chrome 已打开且 OPS 扩展已启用。')
      }
      if (!extensionId) throw new Error('未取得 Chrome 扩展实例标识；请重启 Chrome 后重试。')
      // 服务端一半：创建配对事务拿 revision，confirm 以 CAS 落绑定（27 §13.4）。
      const pairing = await post<{ id: string; revision: number }>('/agent/browser/pairings', { request_id: crypto.randomUUID() })
      try {
        await post(`/agent/browser/pairings/${pairing.id}/confirm`, {
          expected_revision: pairing.revision,
          extension_instance_id: extensionId,
          device_id: stableDeviceId(),
          connection_name: CONNECTION_NAME,
          browser_kind: 'chrome',
          protocol_range: '1',
        })
      } catch (err) {
        const code = err instanceof ApiError ? err.code : ''
        if (code === 'browser_binding_conflict') throw new Error('该 Chrome 扩展实例已绑定；请先在旧工作区解绑后再连接。')
        throw err
      }
      setPhase('done')
      window.dispatchEvent(new Event(PAIRING_DONE_EVENT))
    } catch (err) {
      setError(err instanceof Error ? err.message : errorMessage(err))
      setPhase(previous === 'confirming' ? 'loading' : previous)
      pollingStoppedRef.current = false
      setPollEpoch((e) => e + 1)
    }
  }

  if (phase === 'loading') {
    return <div className="mt-2 rounded-lg border border-mist-200 bg-white p-3" data-testid="pairing-wizard">
      <p className="text-[12px] text-mist-500">正在读取浏览器桥状态…</p>
    </div>
  }
  if (phase === 'unsupported') {
    return <div className="mt-2 rounded-lg border border-mist-200 bg-white p-3" data-testid="pairing-wizard">
      <p className="text-[12px] text-mist-600">需要 OPS Desktop 客户端：桥短码只在本机生成，浏览器版无法配对。</p>
    </div>
  }
  if (phase === 'bridge-down') {
    return <div className="mt-2 rounded-lg border border-mist-200 bg-white p-3" data-testid="pairing-wizard">
      <p className="text-[12px] text-gamboge-700">浏览器桥未在本会话运行；OPS 桌面端重启后会自动重试。</p>
    </div>
  }
  if (phase === 'done') {
    return <div className="mt-2 rounded-lg border border-mist-200 bg-white p-3" data-testid="pairing-wizard">
      <p className="text-[12px] text-primary">配对完成：本机会话与服务端绑定均已建立，连接状态将自动刷新。</p>
    </div>
  }
  if (phase === 'waiting-extension') {
    return <div className="mt-2 rounded-lg border border-mist-200 bg-white p-3" data-testid="pairing-wizard">
      <p className="text-[12px] text-mist-600">等待 Chrome 扩展连接 OPS…请确认 Chrome 已打开、扩展已启用，且本机宿主已注册。</p>
      {snapshot?.pairing?.expired && <p className="mt-1 text-[11px] text-gamboge-700">上一枚短码已过期（5 分钟有效）；扩展重连后会自动生成新短码。</p>}
      {error && <p className="mt-1 text-[12px] text-gamboge-700" role="alert">{error}</p>}
    </div>
  }
  const pairing = snapshot?.pairing ?? null
  return <div className="mt-2 rounded-lg border border-mist-200 bg-white p-3" data-testid="pairing-wizard">
    {phase === 'bridge-paired'
      ? <p className="text-[12px] text-mist-600">本机桥已与扩展配对；点击下方按钮完成服务端绑定登记。</p>
      : <>
        <p className="text-[12px] text-mist-600">请核对 Chrome 扩展弹窗中显示的短码是否与下方一致：</p>
        <p className="my-2 text-center text-2xl font-bold tracking-[0.5em] text-primary" data-testid="pairing-code">{pairing?.code ?? '------'}</p>
      </>}
    {error && <p className="mb-1 text-[12px] text-gamboge-700" role="alert">{error}</p>}
    <Button size="sm" variant="primary" aria-label={phase === 'bridge-paired' ? '完成服务端绑定' : '确认配对'} disabled={phase === 'confirming'} onClick={() => void confirm()}>
      {phase === 'confirming' ? '确认中…' : phase === 'bridge-paired' ? '完成服务端绑定' : '确认配对'}
    </Button>
    {phase === 'code' && <p className="mt-1 text-[11px] text-mist-500">短码仅用于人工核对，不是认证凭据。确认后 OPS 与扩展建立本机会话，并在服务端登记绑定。</p>}
  </div>
}
