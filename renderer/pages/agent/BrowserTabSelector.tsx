import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui'
import type { DesktopBrowserTab } from '@/lib/desktop-presentation'
import { hasDesktopBridgeMethod, listDesktopBrowserTabs } from '@/lib/platform-bridge'

// DEV-AI27-07 第二批（W07b）：浏览器页签内容——连接实例列表+标签选择器（27 §7.3）。
// BR-01：标签枚举走桌面桥真实 IPC（browser:list-tabs），不再误用只属于 Agent run
// 的服务端命令账本；桥未就绪/未配对时如实报错，不伪造列表。
// BR-05：已连接但无标签时给出“刷新标签”出口。

interface BrowserBinding {
  id: string
  connection_name: string
  browser_kind: string
  state: string
}

interface BrowserTabSelectorProps {
  bindings: BrowserBinding[]
  onTabSelected: (tab: DesktopBrowserTab) => void
}

export function BrowserTabSelector({ bindings, onTabSelected }: BrowserTabSelectorProps) {
  const [tabs, setTabs] = useState<DesktopBrowserTab[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const loadTabs = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      if (!hasDesktopBridgeMethod('listBrowserTabs')) {
        setTabs([])
        setError('需要 OPS 桌面端才能读取 Chrome 标签；浏览器版不会伪造标签列表。')
        return
      }
      const result = await listDesktopBrowserTabs()
      if (!result.ok) {
        setTabs([])
        setError(result.message || '标签枚举失败；请确认 Chrome 与 OPS 扩展正在运行后重试。')
        return
      }
      setTabs(result.tabs)
    } catch (err) {
      setTabs([])
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
    {error && <p className="text-xs text-danger" role="alert" data-testid="desktop-agent-browser-tabs-error">{error}</p>}
    {loading && <p className="text-xs text-mist-500">正在读取标签列表…</p>}
    {!loading && !error && tabs.length === 0 && <p className="text-xs text-mist-500" data-testid="desktop-agent-browser-tabs-empty">
      已连接，但 Chrome 里没有可读取的标签。打开一个网页后刷新。
    </p>}
    <ul className="mt-2 space-y-1">
      {tabs.map((tab) => <li key={tab.tab_id}>
        <button
          type="button"
          data-testid={`desktop-agent-browser-tab-${tab.tab_id}`}
          className="w-full rounded-md border border-mist-200 px-3 py-2 text-left text-[13px] text-ink-700 hover:bg-mist-50 hover:border-ink-300 transition-colors"
          onClick={() => onTabSelected(tab)}
        >
          <span className="block truncate font-medium">{tab.title || '无标题'}</span>
          <span className="block text-xs text-mist-500">{tab.origin}</span>
        </button>
      </li>)}
    </ul>
    <div className="mt-2 flex items-center justify-between gap-2">
      <p className="text-xs text-mist-500">未获准的标签不会被读取；选择只用于本次任务授权。</p>
      <Button type="button" size="sm" variant="ghost" disabled={loading} onClick={() => void loadTabs()}>刷新标签</Button>
    </div>
  </div>
}
