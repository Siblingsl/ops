import { Lock, PanelRight } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { isEnterWithoutComposition } from '@/lib/keyboard'
import { formatTokens, type StatusTone } from '@/lib/agent-ui.js'
import { StatusChip } from './StatusChip'

export type ConversationHeaderState = {
  title: string
  empty: boolean
  accountLine: string
  modeLabel: string
  status: { tone: StatusTone | string; label: string; count?: number }
  usage: { tokens: number; label: string; prompt: number; completion: number } | null
  panel: { open: boolean; count: number; label: string }
  observer: boolean
  modelMissing: boolean
  modelReason: string
}

export function ConversationHeader({
  state, editable, onRename, onTogglePanel, onOpenModels, onPrivacySeen, leading, sideChat, onOpenMainConversation,
}: {
  state: ConversationHeaderState
  editable: boolean
  onRename?: (title: string) => void
  onTogglePanel: () => void
  onOpenModels: () => void
  onPrivacySeen: () => void
  leading?: ReactNode
  sideChat?: boolean
  onOpenMainConversation?: () => void
}) {
  const [privacyOpen, setPrivacyOpen] = useState(false)
  const [usageOpen, setUsageOpen] = useState(false)
  const privacyRef = useRef<HTMLDivElement>(null)
  const usageRef = useRef<HTMLDivElement>(null)

  // Esc 先关候选/菜单，再关面板；这里只处理本组件的两个轻浮层。
  useEffect(() => {
    if (!privacyOpen && !usageOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPrivacyOpen(false)
        setUsageOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [privacyOpen, usageOpen])

  const subtitle = [state.accountLine, state.modeLabel].filter(Boolean).join(' · ')

  return <div className="desktop-agent-header">
    {leading}
    <div className="desktop-agent-header-lines">
      <div className="desktop-agent-header-title-row">
        {editable
          ? <input key={state.title} aria-label="对话标题" defaultValue={state.title} className="desktop-agent-header-title-input" maxLength={60}
            onBlur={(event) => { const value = event.target.value.trim(); if (value && value !== state.title) onRename?.(value) }}
            onKeyDown={(event) => {
              if (isEnterWithoutComposition(event.nativeEvent)) { event.preventDefault(); (event.target as HTMLInputElement).blur() }
            }} />
          : <span className="desktop-agent-header-title">{state.title}</span>}
        <div className="desktop-agent-header-privacy" ref={privacyRef}>
          <button type="button" className="desktop-agent-privacy-tag" aria-expanded={privacyOpen} aria-controls="agent-privacy-popover"
            aria-label="仅本人可见，查看隐私说明" onClick={() => { setPrivacyOpen((value) => !value); setUsageOpen(false) }}>
            <Lock aria-hidden="true" /><span>仅本人可见</span>
          </button>
          {privacyOpen && <div id="agent-privacy-popover" role="dialog" aria-label="智能体隐私说明" className="desktop-agent-header-popover">
            <p>此对话仅你可见；团队成员不能读取消息、附件与产物。卡片执行仍按业务权限校验。</p>
            <p className="desktop-agent-header-popover-note">不要在对话或附件中发送 API 密钥、平台密钥、密码或邀请码。</p>
            <button type="button" className="desktop-agent-header-popover-action" onClick={() => { setPrivacyOpen(false); onPrivacySeen() }}>我知道了</button>
          </div>}
        </div>
      </div>
      <div className="desktop-agent-header-sub">
        <span className="desktop-agent-header-account" title={state.accountLine}>{subtitle}</span>
        {state.status.label && <StatusChip tone={state.status.tone} label={state.status.label} count={state.status.count} />}
        {sideChat && <span className="desktop-agent-header-flag" data-testid="agent-side-chat-badge">旁问 · 只读</span>}
        {sideChat && onOpenMainConversation && <button type="button" className="desktop-agent-header-link" onClick={onOpenMainConversation}>回到主对话</button>}
        {state.observer && <span className="desktop-agent-header-flag">观察者 · 只读</span>}
        {state.modelMissing && <button type="button" className="desktop-agent-header-model-warning" onClick={onOpenModels}>{state.modelReason === 'not_tested' ? '模型未自检 · 去自检' : '未配置模型 · 去设置'}</button>}
      </div>
    </div>
    <div className="desktop-agent-header-actions">
      {state.usage && <div className="desktop-agent-usage" ref={usageRef}>
        <button type="button" className="desktop-agent-usage-chip" aria-label={`本轮用量 ${formatTokens(state.usage.tokens)} tokens`} aria-expanded={usageOpen}
          title={`输入 ${state.usage.prompt} tokens · 输出 ${state.usage.completion} tokens`} onClick={() => { setUsageOpen((value) => !value); setPrivacyOpen(false) }}>
          {state.usage.label}
        </button>
        {usageOpen && <div className="desktop-agent-header-popover desktop-agent-usage-popover" role="dialog" aria-label="用量明细">
          <div className="desktop-agent-usage-row"><span>输入</span><strong>{state.usage.prompt.toLocaleString('zh-CN')}</strong></div>
          <div className="desktop-agent-usage-row"><span>输出</span><strong>{state.usage.completion.toLocaleString('zh-CN')}</strong></div>
          <div className="desktop-agent-usage-row"><span>合计（本轮累计）</span><strong>{state.usage.tokens.toLocaleString('zh-CN')}</strong></div>
          <p className="desktop-agent-header-popover-note">按服务端记账；供应商迟报时以实际回执为准。</p>
        </div>}
      </div>}
      <button type="button" className="desktop-agent-panel-button" aria-expanded={state.panel.open} aria-controls="agent-workbench-panel"
        aria-label={state.panel.open ? '关闭任务面板' : '打开任务面板'} onClick={onTogglePanel}>
        <PanelRight aria-hidden="true" /><span>{state.panel.label}</span>
        {state.panel.count > 0 && <span className="desktop-agent-panel-count" aria-label={`待你处理 ${state.panel.count} 项`}>{state.panel.count > 99 ? '99+' : state.panel.count}</span>}
      </button>
    </div>
  </div>
}
