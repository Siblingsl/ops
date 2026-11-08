import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, RotateCw, X, Globe } from 'lucide-react'

// DEV-AI27-08（W08，D-172）：工作视图"应用内"浏览 UI（27 §7.8 功能表第一批）。
// 固定意图经 window.opsDesktopUI?.invokeInBrowse（preload 桥），渲染器无 view 对象。
// 状态来源为主进程快照推送（inbrowse-snapshot），UI 不伪造加载/URL 状态。
// 导航代数与 detach 状态由主进程维护；detached 时显示"已被浮层遮蔽"如实状态。

interface InBrowseSnapshot {
  bounds: { x: number; y: number; width: number; height: number } | null
  url: string
  title: string
  loading: boolean
  navigationGeneration: number
}

const EMPTY: InBrowseSnapshot = { bounds: null, url: '', title: '', loading: false, navigationGeneration: 0 }

type InvokeFn = (channel: string, payload?: unknown) => Promise<unknown>

function useInBrowseInvoke(): InvokeFn | null {
  // desktop-presentation.d.ts 声明的桥；Web 端无此对象（T-AI27-22：Web 无本机能力）。
  const bridge = (window as unknown as { opsDesktopUI?: { invokeInBrowse?: InvokeFn } }).opsDesktopUI
  return bridge?.invokeInBrowse ?? null
}

export function InBrowsePanel({ visible }: { visible: boolean }) {
  const invoke = useInBrowseInvoke()
  const [snapshot, setSnapshot] = useState<InBrowseSnapshot>(EMPTY)
  const [addressInput, setAddressInput] = useState('')
  const [editingAddress, setEditingAddress] = useState(false)
  const lastGenRef = useRef(0)

  useEffect(() => {
    if (!invoke || !visible) return
    // 订阅主进程快照推送。
    const off = (window as unknown as { opsDesktopUI?: { onInBrowseSnapshot?: (cb: (s: InBrowseSnapshot) => void) => () => void } })
      .opsDesktopUI?.onInBrowseSnapshot
    if (off) {
      return off((s) => setSnapshot(s))
    }
  }, [invoke, visible])

  // URL 变化时同步地址栏（非编辑态）。
  useEffect(() => {
    if (!editingAddress) setAddressInput(snapshot.url)
  }, [snapshot.url, editingAddress])

  const refreshSnapshot = useCallback(async () => {
    if (!invoke) return
    try {
      const s = await invoke('inbrowse:snapshot')
      setSnapshot(s as InBrowseSnapshot)
    } catch { /* 未挂载时保持 EMPTY */ }
  }, [invoke])

  useEffect(() => {
    if (visible && invoke) void refreshSnapshot()
  }, [visible, invoke, refreshSnapshot])

  // 导航代数变化时刷新快照（主进程也会推送，双保险）。
  useEffect(() => {
    if (snapshot.navigationGeneration !== lastGenRef.current) {
      lastGenRef.current = snapshot.navigationGeneration
    }
  }, [snapshot.navigationGeneration])

  if (!invoke) {
    // Web 端或旧宿主：如实显示无本机能力（T-AI27-22），不伪造。
    return <div className="desktop-agent-browser-status" data-testid="inbrowse-unavailable">
      <h4>应用内浏览需要 OPS 桌面端</h4>
      <p>当前环境不支持应用内浏览。请在 OPS 桌面端使用，或通过 Google Chrome 扩展协作。</p>
    </div>
  }

  const navigateTo = async (raw: string) => {
    const url = raw.trim()
    if (!url) return
    // 地址栏便捷处理：无 scheme 时补 https://。
    const target = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`
    setEditingAddress(false)
    await invoke('inbrowse:navigate', target).catch(() => undefined)
  }

  const btn = 'inline-flex size-8 items-center justify-center rounded-md text-mist-500 hover:bg-mist-100 hover:text-mist-800 disabled:opacity-40 disabled:pointer-events-none'

  return <div className="flex h-full flex-col" data-testid="inbrowse-panel">
    <div className="flex shrink-0 items-center gap-1.5 border-b border-mist-200 bg-white px-2 py-1.5">
      <button type="button" className={btn} aria-label="后退" onClick={() => void invoke('inbrowse:back')}><ArrowLeft className="size-4" /></button>
      <button type="button" className={btn} aria-label="前进" onClick={() => void invoke('inbrowse:forward')}><ArrowRight className="size-4" /></button>
      <button type="button" className={btn} aria-label={snapshot.loading ? '停止加载' : '刷新'} onClick={() => void invoke(snapshot.loading ? 'inbrowse:stop' : 'inbrowse:reload')}>
        {snapshot.loading ? <X className="size-4" /> : <RotateCw className="size-4" />}
      </button>
      <form className="flex min-w-0 flex-1 items-center" onSubmit={(event) => { event.preventDefault(); void navigateTo(addressInput) }}>
        <div className="flex w-full items-center gap-1.5 rounded-lg border border-mist-200 bg-mist-50 px-2 py-1">
          <Globe className="size-3.5 shrink-0 text-mist-400" />
          <input
            value={addressInput}
            onChange={(event) => { setAddressInput(event.target.value); setEditingAddress(true) }}
            onBlur={() => { setEditingAddress(false); setAddressInput(snapshot.url) }}
            aria-label="地址栏"
            placeholder="输入网址，回车访问"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-ink-700 outline-none"
          />
        </div>
      </form>
      <button type="button" className={btn} aria-label="关闭页面" onClick={() => void invoke('inbrowse:close')}><X className="size-4" /></button>
    </div>
    <div className="flex shrink-0 items-center gap-2 border-b border-mist-100 bg-mist-50 px-3 py-1 text-[12px] text-mist-500">
      <span data-testid="inbrowse-title">{snapshot.title || '空白页'}</span>
      {snapshot.loading && <span className="text-mist-400">加载中…</span>}
    </div>
    {/* bounds 区域由主进程 WebContentsView 覆盖（原生层）；此处 div 仅占位测量。 */}
    <div className="min-h-0 flex-1" data-testid="inbrowse-viewport" data-url={snapshot.url} />
  </div>
}
