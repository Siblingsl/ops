import { useCallback, useEffect, useState } from 'react'

// DEV-AI27-07 第二批（W07b）：浏览器页签内容——连接实例列表+标签选择器（27 §7.3）。
// 已连接时显示实例与可选标签（脱敏标题/域名）；选中后生成 Chrome 筹码回调给父组件。
// 未连接时保持 BrowserStatusBlock 的如实状态展示。

interface BrowserBinding {
  id: string
  connection_name: string
  browser_kind: string
  state: string
}

interface BrowserTab {
  tab_id: number
  title: string
  origin: string
}

interface BrowserTabSelectorProps {
  bindings: BrowserBinding[]
  onTabSelected: (tab: BrowserTab) => void
}

export function BrowserTabSelector({ bindings, onTabSelected }: BrowserTabSelectorProps) {
  const [tabs, setTabs] = useState<BrowserTab[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const loadTabs = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      // 通过服务端账本派发 tabs_list 命令；实际执行由桌面桥完成。
      // 本 API 是 W04 命令账本的 POST /agent/browser/commands。
      const response = await fetch('/api/v1/agent/browser/commands', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'tabs_list',
          payload: {},
        }),
      })
      if (!response.ok) {
        const body = await response.text()
        throw new Error(`HTTP ${response.status}: ${body.slice(0, 100)}`)
      }
      const data = await response.json() as { payload?: { tabs?: BrowserTab[] } }
      setTabs(data.payload?.tabs ?? [])
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void loadTabs() }, [loadTabs])

  return <div className="desktop-agent-browser-tabs" data-testid="desktop-agent-browser-tabs">
    <h4 className="text-sm font-semibold text-ink-700">选择标签</h4>
    {bindings.length > 0 && <p className="text-xs text-mist-500">
      已连接 {bindings.length} 个实例：{bindings.map((b) => b.connection_name || '未命名').join('、')}
    </p>}
    {error && <p className="text-xs text-danger" role="alert">{error}</p>}
    {loading && <p className="text-xs text-mist-500">正在读取标签列表…</p>}
    {!loading && tabs.length === 0 && !error && <p className="text-xs text-mist-500">没有可用的浏览器标签。</p>}
    <ul className="mt-2 space-y-1">
      {tabs.map((tab) => <li key={tab.tab_id}>
        <button
          type="button"
          className="w-full rounded-md border border-mist-200 px-3 py-2 text-left text-[13px] text-ink-700 hover:bg-mist-50 hover:border-ink-300 transition-colors"
          onClick={() => onTabSelected(tab)}
        >
          <span className="block truncate font-medium">{tab.title || '无标题'}</span>
          <span className="block text-xs text-mist-500">{tab.origin}</span>
        </button>
      </li>)}
    </ul>
    <p className="mt-2 text-xs text-mist-500">
      选择标签后生成引用筹码；未获准的标签不会被读取。标签选择器 p95≤500ms（27 §15.2）。
    </p>
  </div>
}
