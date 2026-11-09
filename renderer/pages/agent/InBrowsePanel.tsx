import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, RotateCw, X, Globe } from 'lucide-react'

// DEV-AI27-08（W08，D-172）：工作视图"应用内"浏览 UI（27 §7.8 功能表第一批）。
// 固定意图经 window.opsDesktopUI?.invokeInBrowse（preload 桥），渲染器无 view 对象。
// 状态来源为主进程快照推送（inbrowse-snapshot），UI 不伪造加载/URL 状态。
// 导航代数与 detach 状态由主进程维护；detached 时显示"已被浮层遮蔽"如实状态。

interface InBrowseTabSnapshot {
  id: string
  url: string
  title: string
  loading: boolean
  navigationGeneration: number
}

interface InBrowseDownloadRecord {
  id: string
  filename: string
  state: 'completed' | 'interrupted' | 'cancelled'
  receivedBytes: number
  totalBytes: number
  sourceUrl: string
}

interface InBrowseBlockedPopup {
  url: string
  reason: 'new_window' | 'protocol_denied' | 'tab_limit' | 'cross_origin'
  at: number
}

interface InBrowseSnapshot {
  activeTabId: string | null
  tabs: InBrowseTabSnapshot[]
  bounds: { x: number; y: number; width: number; height: number } | null
  detached: boolean
  detachReason: string | null
  // 主进程按会话推送的下载记录；与页签状态相互独立，缺省视为空。
  downloads?: InBrowseDownloadRecord[]
  // 最近一次被拒绝的弹窗；缺省/旧宿主视为无提示。
  lastBlockedPopup?: InBrowseBlockedPopup | null
}

const EMPTY: InBrowseSnapshot = { activeTabId: null, tabs: [], bounds: null, detached: false, detachReason: null, downloads: [] }

const downloadStateLabel: Record<InBrowseDownloadRecord['state'], string> = { completed: '已完成', interrupted: '已中断', cancelled: '已取消' }

const blockedPopupReasonLabel: Record<NonNullable<InBrowseSnapshot['lastBlockedPopup']>['reason'], string> = {
  new_window: '不允许弹出独立窗口',
  protocol_denied: '仅支持 http/https 链接',
  tab_limit: '页签已达上限（8 个）',
  cross_origin: '已拦截跨站弹窗',
}

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

  useEffect(() => {
    if (!invoke || !visible) return
    // 订阅主进程快照推送。
    const off = (window as unknown as { opsDesktopUI?: { onInBrowseSnapshot?: (cb: (s: InBrowseSnapshot) => void) => () => void } })
      .opsDesktopUI?.onInBrowseSnapshot
    if (off) {
      return off((s) => setSnapshot(s))
    }
  }, [invoke, visible])

  // 活动 URL 变化时同步地址栏（非编辑态）。
  const activeTab = snapshot.tabs.find((t) => t.id === snapshot.activeTabId) ?? null
  const activeUrl = activeTab?.url ?? ''
  const activeLoading = activeTab?.loading ?? false
  useEffect(() => {
    if (!editingAddress) setAddressInput(activeUrl)
  }, [activeUrl, editingAddress])

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

  // DEV-AI27-08e（深化）：多页签拖拽排序（HTML5 DnD，主进程 reorder-tab 意图）。
  const [dragOverTabID, setDragOverTabID] = useState<string | null>(null)
  const draggedTabRef = useRef<string | null>(null)

  const onTabDragStart = (tabId: string) => { draggedTabRef.current = tabId }
  const onTabDragOver = (event: React.DragEvent, tabId: string) => {
    event.preventDefault()
    if (draggedTabRef.current && draggedTabRef.current !== tabId) setDragOverTabID(tabId)
  }
  const onTabDrop = (tabId: string) => {
    const from = draggedTabRef.current
    setDragOverTabID(null)
    draggedTabRef.current = null
    if (from && from !== tabId && invoke) void invoke('inbrowse:reorder-tab', { from, to: tabId })
  }

  return <div className="flex h-full flex-col" data-testid="inbrowse-panel">
    {snapshot.tabs.length > 0 && <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-mist-200 bg-mist-50 px-2 py-1" data-testid="inbrowse-tabs">
      {snapshot.tabs.map((tab) => <button key={tab.id} type="button"
        data-testid={`inbrowse-tab-${tab.id}`}
        draggable
        onDragStart={() => onTabDragStart(tab.id)}
        onDragOver={(e) => onTabDragOver(e, tab.id)}
        onDragLeave={() => { if (dragOverTabID === tab.id) setDragOverTabID(null) }}
        onDrop={() => onTabDrop(tab.id)}
        aria-current={tab.id === snapshot.activeTabId}
        onClick={() => void invoke('inbrowse:switch-tab', tab.id)}
        className={`max-w-40 shrink-0 truncate rounded-md px-2 py-1 text-[12px] ${tab.id === snapshot.activeTabId ? 'bg-white text-ink-700 shadow-sm' : 'text-mist-500 hover:bg-white/60'} ${dragOverTabID === tab.id ? 'border border-primary' : 'border border-transparent'}`}>
        {tab.title || tab.url || '空白页'}
      </button>)}
      <button type="button" className={btn} aria-label="新建页签" data-testid="inbrowse-new-tab"
        onClick={() => void invoke('inbrowse:open-tab')}>+</button>
    </div>}
    <div className="flex shrink-0 items-center gap-1.5 border-b border-mist-200 bg-white px-2 py-1.5">
      <button type="button" className={btn} aria-label="后退" onClick={() => void invoke('inbrowse:back')}><ArrowLeft className="size-4" /></button>
      <button type="button" className={btn} aria-label="前进" onClick={() => void invoke('inbrowse:forward')}><ArrowRight className="size-4" /></button>
      <button type="button" className={btn} aria-label={activeLoading ? '停止加载' : '刷新'} onClick={() => void invoke(activeLoading ? 'inbrowse:stop' : 'inbrowse:reload')}>
        {activeLoading ? <X className="size-4" /> : <RotateCw className="size-4" />}
      </button>
      <form className="flex min-w-0 flex-1 items-center" onSubmit={(event) => { event.preventDefault(); void navigateTo(addressInput) }}>
        <div className="flex w-full items-center gap-1.5 rounded-lg border border-mist-200 bg-mist-50 px-2 py-1">
          <Globe className="size-3.5 shrink-0 text-mist-400" />
          <input
            value={addressInput}
            onChange={(event) => { setAddressInput(event.target.value); setEditingAddress(true) }}
            onBlur={() => { setEditingAddress(false); setAddressInput(activeUrl) }}
            aria-label="地址栏"
            placeholder="输入网址，回车访问"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-ink-700 outline-none"
          />
        </div>
      </form>
      <button type="button" className={btn} aria-label="关闭页面" data-testid="inbrowse-close" onClick={() => { const active = snapshot.activeTabId; if (active) void invoke('inbrowse:close-tab', active) }}><X className="size-4" /></button>
    </div>
    <div className="flex shrink-0 items-center gap-2 border-b border-mist-100 bg-mist-50 px-3 py-1 text-[12px] text-mist-500">
      <span data-testid="inbrowse-title">{activeTab?.title || '空白页'}</span>
      {activeLoading && <span className="text-mist-400">加载中…</span>}
    </div>
    {/* 27 §14.5：下载逐文件确认后才落盘，这里只如实展示结果，不提供自动打开/上传。 */}
    {!!snapshot.downloads?.length && <div className="shrink-0 border-b border-mist-100 bg-white px-3 py-1 text-[11px] text-mist-500" data-testid="inbrowse-downloads">
      <span data-testid="inbrowse-download-latest">最近下载：{snapshot.downloads[0].filename} · {downloadStateLabel[snapshot.downloads[0].state]}</span>
      {snapshot.downloads.length > 1 && <span className="ml-1">（共 {snapshot.downloads.length} 条）</span>}
      <span className="ml-1 text-mist-400">不会自动打开或上传</span>
    </div>}
    {/* 27 §7.8 弹窗处理：deny 不静默——主进程回执 lastBlockedPopup，这里给可读提示。 */}
    {snapshot.lastBlockedPopup && <div className="shrink-0 border-b border-mist-100 bg-amber-50 px-3 py-1 text-[11px] text-amber-700" data-testid="inbrowse-blocked-popup">
      <span data-testid="inbrowse-blocked-popup-reason">{blockedPopupReasonLabel[snapshot.lastBlockedPopup.reason]}</span>
      <span className="ml-1 text-amber-500/80" title={snapshot.lastBlockedPopup.url}>{snapshot.lastBlockedPopup.url.slice(0, 60)}</span>
    </div>}
    {/* bounds 区域由主进程 WebContentsView 覆盖（原生层）；此处 div 仅占位测量。 */}
    <div className="min-h-0 flex-1" data-testid="inbrowse-viewport" data-url={activeUrl} />
  </div>
}
