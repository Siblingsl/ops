import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Camera, Crosshair, Globe, MessageSquarePlus, RotateCw, X } from 'lucide-react'
import { toast } from 'sonner'

import { post } from '@/lib/api'
import { tabLabel } from '@/lib/agent-ui.js'
import { getDesktopInBrowseInvoker, subscribeDesktopInBrowseSnapshot } from '@/lib/platform-bridge'

// DEV-AI27-08（W08，D-172）：工作视图"应用内"浏览 UI（27 §7.8 功能表第一批）。
// 固定意图经平台桥的 invokeInBrowse（preload 桥），渲染器无 view 对象。
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
  // BR-10：最近一次被拦截的可执行文件下载。
  lastBlockedDownload?: { filename: string; sourceUrl: string; at: number } | null
  // BR-07：视图创建失败/渲染进程退出；null 表示正常。
  viewError?: { tabId: string; reason: string } | null
  // BR-03：元素选择进行中/最近选中元素/失败原因。
  pickerActive?: boolean
  pickedElement?: {
    title: string
    url: string
    selector: string
    text: string
    tag: string
    rect: { x: number; y: number; width: number; height: number }
  } | null
  pickerError?: string | null
}

const EMPTY: InBrowseSnapshot = { activeTabId: null, tabs: [], bounds: null, detached: false, detachReason: null, downloads: [] }

const downloadStateLabel: Record<InBrowseDownloadRecord['state'], string> = { completed: '已完成', interrupted: '已中断', cancelled: '已取消' }

const blockedPopupReasonLabel: Record<NonNullable<InBrowseSnapshot['lastBlockedPopup']>['reason'], string> = {
  new_window: '不允许弹出独立窗口',
  protocol_denied: '仅支持 http/https 链接',
  tab_limit: '页签已达上限（8 个）',
  cross_origin: '已拦截跨站弹窗',
}

// BR-03：把主进程的失败原因翻译成可读提示；cancelled 不打扰用户。
const pickerErrorLabel: Record<string, string> = {
  sensitive_control: '该元素不可选：密码框、文件选择或可编辑区域不会被读取。',
  iframe_not_selectable: '该区域不可选：跨域 iframe 无法读取，请在页面主体中选择。',
  hidden_element: '该元素不可见，无法选择。',
  page_reloaded: '页面已刷新，之前的选择已失效，请重新选择。',
  timeout: '选择超时，请重新点击“选择元素”。',
  picker_active: '已有一个元素选择正在进行。',
  no_active_tab: '先打开一个网页再选择元素。',
  tab_not_http: '只有 http/https 页面可以选择元素。',
  invalid_result: '没有读到有效元素，请重试。',
}

export function InBrowsePanel({ visible, conversationId, onTabsChange }: { visible: boolean; conversationId?: string; onTabsChange?: (count: number) => void }) {
  const invoke = getDesktopInBrowseInvoker()
  const viewportRef = useRef<HTMLDivElement>(null)
  const [snapshot, setSnapshot] = useState<InBrowseSnapshot>(EMPTY)
  const [addressInput, setAddressInput] = useState('')
  const [editingAddress, setEditingAddress] = useState(false)
  // A10（27 §7.7）：浏览工具栏批注入口——批注绑定当前会话，保存后进入来源面板列表。
  const [annotateOpen, setAnnotateOpen] = useState(false)
  const [note, setNote] = useState('')
  const [savingNote, setSavingNote] = useState(false)
  const [annotateError, setAnnotateError] = useState('')
  // BR-11：选中元素后的一句话批注；只生成输入台引用，不自动发送。
  const [pickedNoteOpen, setPickedNoteOpen] = useState(false)
  const [pickedNote, setPickedNote] = useState('')
  // BR-07：原生视图不存在 DOM 像素，截图工具会得到空白；提供“截取当前页”兜底。
  const [capture, setCapture] = useState('')
  const [captureError, setCaptureError] = useState('')
  // BR-10：非 http/https 地址拒绝后给出可读原因，不静默。
  const [navigationError, setNavigationError] = useState('')

  useEffect(() => {
    if (!invoke || !visible) return
    // 订阅主进程快照推送。
    return subscribeDesktopInBrowseSnapshot<InBrowseSnapshot>((s) => setSnapshot(s))
  }, [invoke, visible])

  // BR-07：把 DOM 占位区同步给主进程 WebContentsView；rAF 合并 resize，宽度为 0 时跳过。
  useEffect(() => {
    if (!invoke || !visible) return
    let frame = 0
    const push = () => {
      frame = 0
      const element = viewportRef.current
      if (!element) return
      const rect = element.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      void invoke('inbrowse:set-bounds', {
        x: Math.round(rect.left), y: Math.round(rect.top),
        width: Math.round(rect.width), height: Math.round(rect.height),
      })
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(push) }
    const observer = new ResizeObserver(schedule)
    if (viewportRef.current) observer.observe(viewportRef.current)
    window.addEventListener('resize', schedule)
    schedule()
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', schedule)
      void invoke('inbrowse:visibility', false)
    }
  }, [invoke, visible])

  // BR-07：切换到其它页签/打开截图预览时移除原生视图，避免覆盖 DOM 内容。
  useEffect(() => {
    if (!invoke || !visible) return
    void invoke('inbrowse:visibility', !capture)
  }, [invoke, visible, capture])

  // 活动 URL 变化时同步地址栏（非编辑态）。
  const activeTab = snapshot.tabs.find((t) => t.id === snapshot.activeTabId) ?? null
  useEffect(() => { onTabsChange?.(snapshot.tabs.length) }, [onTabsChange, snapshot.tabs.length])
  const activeUrl = activeTab?.url ?? ''
  const activeLabel = activeTab ? tabLabel(activeTab) : null
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

  const capturePage = async () => {
    if (!invoke) return
    setCaptureError('')
    try {
      const result = await invoke('inbrowse:screenshot') as { ok?: boolean; reason?: string; data?: { base64?: string } }
      const base64 = result?.data?.base64
      if (!result?.ok || !base64) {
        setCaptureError(result?.reason ? `截图失败：${result.reason}` : '截图失败，请稍后重试。')
        return
      }
      setCapture(`data:image/jpeg;base64,${base64}`)
    } catch {
      setCaptureError('截图失败，请稍后重试。')
    }
  }

  const rebuildView = async () => {
    if (!invoke) return
    setCaptureError('')
    try {
      const next = await invoke('inbrowse:rebuild') as InBrowseSnapshot
      if (next) setSnapshot(next)
    } catch {
      setCaptureError('重建视图失败，请关闭面板后重试。')
    }
  }

  const picked = snapshot.pickedElement ?? null
  const pickErrorText = snapshot.pickerError && snapshot.pickerError !== 'cancelled'
    ? (pickerErrorLabel[snapshot.pickerError] ?? `选择失败：${snapshot.pickerError}`)
    : ''

  const pickElement = async () => {
    if (!invoke) return
    setCaptureError('')
    try {
      await invoke('inbrowse:pick-element')
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err)
      setCaptureError(raw.includes('picker_active') ? '已有一个元素选择正在进行。' : '无法开始元素选择，请稍后重试。')
    }
  }

  const clearPicked = () => { if (invoke) void invoke('inbrowse:pick-clear'); setPickedNoteOpen(false); setPickedNote('') }

  const usePicked = () => {
    if (!picked) return
    // P1 按 38 卡片“先作为文本附件”的允许路径：插入输入框文本块，不新增服务端引用类型。
    window.dispatchEvent(new CustomEvent('ops:agent-page-element', { detail: picked }))
    toast.success('已插入输入框', { description: '页面元素会作为文本上下文随下一条消息发送。' })
    clearPicked()
  }

  const annotatePicked = () => {
    if (!picked) return
    setPickedNote('')
    setPickedNoteOpen(true)
    setAnnotateError('')
  }

  const commitPickedAnnotation = () => {
    if (!picked || !pickedNote.trim()) return
    window.dispatchEvent(new CustomEvent('ops:agent-page-annotation', {
      detail: { ...picked, note: pickedNote.trim() },
    }))
    toast.success('已引用到输入台', { description: '页面元素和批注会随下一条消息发送，不会自动发送。' })
    setPickedNote('')
    setPickedNoteOpen(false)
    clearPicked()
    window.setTimeout(() => window.dispatchEvent(new CustomEvent('ops:agent-focus-composer')), 0)
  }

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
    setNavigationError('')
    try {
      await invoke('inbrowse:navigate', target)
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err)
      setNavigationError(raw.includes('protocol_denied')
        ? '仅支持 http/https 地址；file、data、javascript 等协议不会打开。'
        : '无法打开这个地址，请检查 URL 后重试。')
    }
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
      {snapshot.tabs.map((tab) => {
        const label = tabLabel(tab)
        return <button key={tab.id} type="button"
          data-testid={`inbrowse-tab-${tab.id}`}
          draggable
          onDragStart={() => onTabDragStart(tab.id)}
          onDragOver={(e) => onTabDragOver(e, tab.id)}
          onDragLeave={() => { if (dragOverTabID === tab.id) setDragOverTabID(null) }}
          onDrop={() => onTabDrop(tab.id)}
          aria-current={tab.id === snapshot.activeTabId}
          title={label.full || label.label}
          aria-label={label.full || label.label}
          onClick={() => void invoke('inbrowse:switch-tab', tab.id)}
          className={`max-w-[180px] shrink-0 truncate rounded-md px-2 py-1 text-[12px] ${tab.id === snapshot.activeTabId ? 'bg-white text-ink-700 shadow-sm' : 'text-mist-500 hover:bg-white/60'} ${dragOverTabID === tab.id ? 'border border-primary' : 'border border-transparent'}`}>
          {label.label}
        </button>
      })}
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
      <button type="button" className={btn} aria-label="批注当前页" data-testid="inbrowse-annotate"
        disabled={!conversationId || !activeTab} onClick={() => { setAnnotateOpen((value) => !value); setAnnotateError('') }}>
        <MessageSquarePlus className="size-4" />
      </button>
      <button type="button" className={btn} aria-label="选择元素" data-testid="inbrowse-pick-element"
        aria-pressed={Boolean(snapshot.pickerActive)}
        disabled={!activeTab || Boolean(snapshot.pickerActive)} onClick={() => void pickElement()}>
        <Crosshair className="size-4" />
      </button>
      <button type="button" className={btn} aria-label="截取当前页" data-testid="inbrowse-capture-button"
        disabled={!activeTab} onClick={() => void capturePage()}>
        <Camera className="size-4" />
      </button>
      <button type="button" className={btn} aria-label="关闭页面" data-testid="inbrowse-close" onClick={() => { const active = snapshot.activeTabId; if (active) void invoke('inbrowse:close-tab', active) }}><X className="size-4" /></button>
    </div>
    {captureError && <div className="shrink-0 border-b border-mist-100 bg-white px-3 py-1 text-[12px] text-danger" data-testid="inbrowse-capture-error" role="alert">{captureError}</div>}
    {navigationError && <div className="shrink-0 border-b border-mist-100 bg-amber-50 px-3 py-1 text-[12px] text-amber-700" data-testid="inbrowse-navigation-error" role="alert">{navigationError}</div>}
    {snapshot.pickerActive && <div className="shrink-0 border-b border-mist-200 bg-white px-3 py-1 text-[12px] text-mist-600" data-testid="inbrowse-picker-hint" role="status">
      在页面上点击要引用的元素；Esc 取消。
    </div>}
    {pickErrorText && <div className="shrink-0 border-b border-mist-100 bg-danger/5 px-3 py-1 text-[12px] text-danger" data-testid="inbrowse-picker-error" role="alert">{pickErrorText}</div>}
    {picked && <div className="shrink-0 border-b border-mist-200 bg-white px-3 py-2" data-testid="inbrowse-picked">
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-[12px] text-mist-500">已选择：{picked.tag} · {picked.title || picked.url}</p>
        <button type="button" className="text-[12px] text-mist-500 hover:text-mist-800" aria-label="关闭元素结果" onClick={clearPicked}>关闭</button>
      </div>
      <code className="mt-1 block break-all rounded bg-mist-50 px-2 py-1 text-[12px] text-ink-700" data-testid="inbrowse-picked-selector">{picked.selector}</code>
      {picked.text && <p className="mt-1 line-clamp-2 text-[12px] text-mist-600" data-testid="inbrowse-picked-text">{picked.text}</p>}
      <div className="mt-1.5 flex gap-2">
        <button type="button" className="rounded-md bg-primary px-2.5 py-1 text-[12px] text-white" data-testid="inbrowse-picked-use" onClick={usePicked}>加入上下文</button>
        <button type="button" className="rounded-md border border-mist-200 px-2.5 py-1 text-[12px] text-mist-600" data-testid="inbrowse-picked-annotate" onClick={annotatePicked} aria-expanded={pickedNoteOpen}>写批注</button>
      </div>
      {pickedNoteOpen && <div className="mt-2 rounded-lg border border-mist-200 bg-mist-50 p-2 shadow-sm" style={{ width: 280, maxWidth: '100%' }}
        data-testid="inbrowse-picked-annotation" role="dialog" aria-label="页面元素批注">
        <p className="text-[12px] text-mist-600">用一句话说明要 Agent 关注什么；保存后只生成输入台引用，不会自动发送。</p>
        <textarea aria-label="页面元素批注" data-testid="inbrowse-picked-note" value={pickedNote} maxLength={160} rows={2}
          onChange={(event) => setPickedNote(event.target.value)}
          placeholder="例如：只改标题，不要动正文"
          className="mt-1 w-full rounded-md border border-mist-200 bg-white p-1.5 text-[12px] text-ink-700" />
        <div className="mt-1 flex justify-end gap-1.5">
          <button type="button" className="rounded-md border border-mist-200 px-2 py-1 text-[12px] text-mist-600"
            data-testid="inbrowse-picked-annotate-cancel" onClick={() => { setPickedNoteOpen(false); setPickedNote('') }}>取消</button>
          <button type="button" className="rounded-md bg-primary px-2 py-1 text-[12px] text-white disabled:opacity-50"
            data-testid="inbrowse-picked-annotate-save" disabled={!pickedNote.trim()} onClick={commitPickedAnnotation}>引用到输入台</button>
        </div>
      </div>}
    </div>}
    {snapshot.lastBlockedDownload && <div className="shrink-0 border-b border-mist-100 bg-danger/5 px-3 py-1 text-[12px] text-danger" data-testid="inbrowse-blocked-download" role="alert">
      已拦截可执行文件下载：{snapshot.lastBlockedDownload.filename}
      <span className="ml-1 text-mist-600">为安全起见，不在内置浏览器保存或运行。</span>
    </div>}
    {annotateOpen && <div className="shrink-0 border-b border-mist-200 bg-white px-3 py-2" data-testid="inbrowse-annotate-form">
      <p className="mb-1 truncate text-[12px] text-mist-500">批注来源：{activeTab?.title || activeTab?.url || '当前页'}</p>
      <textarea aria-label="批注备注" value={note} onChange={(event) => setNote(event.target.value)} rows={2}
        placeholder="写下这页值得记的一点；保存后可在来源面板回查。"
        className="w-full rounded-lg border border-mist-200 p-2 text-[13px] text-ink-700" />
      {annotateError && <p className="mt-1 text-[12px] text-danger" role="alert">{annotateError}</p>}
      <div className="mt-1 flex gap-2">
        <button type="button" className="rounded-md bg-primary px-2.5 py-1 text-[12px] text-white disabled:opacity-50"
          disabled={!note.trim() || savingNote}
          onClick={() => {
            const origin = (() => { try { return activeTab?.url ? new URL(activeTab.url).origin : '' } catch { return '' } })()
            if (!conversationId || !note.trim()) return
            setSavingNote(true)
            setAnnotateError('')
            void post('/agent/browser/annotations', { conversation_id: conversationId, origin, note: note.trim() })
              .then(() => { toast.success('批注已保存到本会话来源面板'); setNote(''); setAnnotateOpen(false) })
              .catch((err) => setAnnotateError(err instanceof Error ? err.message : String(err)))
              .finally(() => setSavingNote(false))
          }}>{savingNote ? '保存中…' : '保存批注'}</button>
        <button type="button" className="rounded-md border border-mist-200 px-2.5 py-1 text-[12px] text-mist-600"
          onClick={() => { setAnnotateOpen(false); setAnnotateError('') }}>取消</button>
      </div>
    </div>}
    <div className="flex shrink-0 items-center gap-2 border-b border-mist-100 bg-mist-50 px-3 py-1 text-[12px] text-mist-500">
      <span data-testid="inbrowse-title" title={activeLabel?.full || undefined}>{activeLabel?.label || '空白页'}</span>
      {activeLoading && <span className="text-mist-400">加载中…</span>}
    </div>
    {/* 27 §14.5：下载逐文件确认后才落盘，这里只如实展示结果，不提供自动打开/上传。 */}
    {!!snapshot.downloads?.length && <div className="shrink-0 border-b border-mist-100 bg-white px-3 py-1 text-[12px] text-mist-500" data-testid="inbrowse-downloads">
      <span data-testid="inbrowse-download-latest">最近下载：{snapshot.downloads[0].filename} · {downloadStateLabel[snapshot.downloads[0].state]}</span>
      {snapshot.downloads.length > 1 && <span className="ml-1">（共 {snapshot.downloads.length} 条）</span>}
      <span className="ml-1 text-mist-400">不会自动打开或上传</span>
    </div>}
    {/* 27 §7.8 弹窗处理：deny 不静默——主进程回执 lastBlockedPopup，这里给可读提示。 */}
    {snapshot.lastBlockedPopup && <div className="shrink-0 border-b border-mist-100 bg-amber-50 px-3 py-1 text-[12px] text-amber-700" data-testid="inbrowse-blocked-popup">
      <span data-testid="inbrowse-blocked-popup-reason">{blockedPopupReasonLabel[snapshot.lastBlockedPopup.reason]}</span>
      <span className="ml-1 text-amber-500/80" title={snapshot.lastBlockedPopup.url}>{snapshot.lastBlockedPopup.url.slice(0, 60)}</span>
    </div>}
    {snapshot.viewError && <div className="shrink-0 border-b border-danger/30 bg-danger/5 px-3 py-2 text-[12px] text-danger" data-testid="inbrowse-view-error" role="alert">
      <p className="font-medium">内置浏览视图不可用</p>
      <p className="mt-0.5 text-mist-600">{snapshot.viewError.reason.startsWith('create_failed') ? '无法创建内置浏览视图。' : `页面渲染进程已退出（${snapshot.viewError.reason}），当前页面可能未保存。`}</p>
      <button type="button" className="mt-1.5 rounded-md border border-danger/40 bg-white px-2.5 py-1 text-danger" onClick={() => void rebuildView()}>重建视图</button>
    </div>}
    {/* bounds 区域由主进程 WebContentsView 覆盖（原生层）；此处 div 仅占位测量。 */}
    <div ref={viewportRef} className="relative min-h-0 flex-1" data-testid="inbrowse-viewport" data-url={activeUrl}>
      {capture && <div className="absolute inset-0 z-10 flex flex-col bg-white" data-testid="inbrowse-capture-preview">
        <div className="flex items-center justify-between border-b border-mist-200 px-3 py-1.5 text-[12px] text-mist-500">
          <span>当前页截图（原生视图无法被窗口截图捕获时的兜底）</span>
          <button type="button" className={btn} aria-label="关闭截图预览" onClick={() => setCapture('')}><X className="size-4" /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto bg-mist-100 p-2">
          <img data-testid="inbrowse-capture" src={capture} alt="当前页截图" className="mx-auto max-w-full border border-mist-200 bg-white" />
        </div>
      </div>}
    </div>
  </div>
}
