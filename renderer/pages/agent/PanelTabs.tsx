import { type KeyboardEvent, useRef } from 'react'
import { tabCountLabel } from '@/lib/agent-ui.js'

export interface PanelTabItem { id: string; label: string; count?: number; disabledReason?: string }

// UI-03：四个页签、下划线选中态、键盘可切换；满 5 个会变成“第五个入口”，必须由守卫拦下。
export function PanelTabs({ tabs, tab, setTab }: { tabs: PanelTabItem[]; tab: string; setTab: (tab: string) => void }) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({})
  const move = (event: KeyboardEvent, index: number) => {
    let next = index
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = tabs.length - 1
    else return
    event.preventDefault()
    const target = tabs[next]
    setTab(target.id)
    refs.current[target.id]?.focus()
  }
  return <div role="tablist" aria-label="任务面板切换" className="desktop-agent-panel-tabs">
    {tabs.map((item, index) => <button key={item.id} ref={(node) => { refs.current[item.id] = node }} type="button" role="tab"
      id={`agent-panel-tab-${item.id}`} aria-selected={tab === item.id} aria-controls={`agent-panel-${item.id}`}
      tabIndex={tab === item.id ? 0 : -1} onClick={() => setTab(item.id)} onKeyDown={(event) => move(event, index)}>
      {item.label}{tabCountLabel(item.count) && <span className="desktop-agent-panel-tab-count">{tabCountLabel(item.count)}</span>}
    </button>)}
  </div>
}
