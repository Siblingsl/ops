import { Activity, Bot, Waves } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { isElectronDesktop, setDesktopMotion, type DesktopClientHealth } from '@/lib/desktop-presentation.js'

export default function DesktopStatusBar({ workspaceName, accountName }: { workspaceName?: string; accountName?: string }) {
  const desktop = isElectronDesktop(navigator.userAgent)
  const location = useLocation()
  const [reducedMotion, setReducedMotion] = useState(() => document.documentElement.dataset.reducedMotion === 'true')
  const [health, setHealth] = useState<DesktopClientHealth | null>(null)

  useEffect(() => {
    if (!desktop) return
    const subscribe = window.opsDesktopUI?.onClientHealth
    if (!subscribe) return
    return subscribe(setHealth)
  }, [desktop])

  useEffect(() => {
    if (!desktop) return
    setReducedMotion(document.documentElement.dataset.reducedMotion === 'true')
    const sync = (event: Event) => {
      setReducedMotion(Boolean((event as CustomEvent<boolean>).detail))
    }
    window.addEventListener('ops:desktop-motion', sync)
    return () => window.removeEventListener('ops:desktop-motion', sync)
  }, [desktop])

  if (!desktop) return null

  const toggleMotion = () => {
    const next = !reducedMotion
    if (setDesktopMotion(document, window.localStorage, next) === null) return
    setReducedMotion(next)
    window.open(`ops-desktop://ui/motion/${next ? 'reduce' : 'soft'}`, '_blank', 'noopener,noreferrer')
  }

  const editorRoute = /^\/works\/[^/]+$/.test(location.pathname)
  const channelLabel = health?.channelState === 'ready' ? '已连接'
    : health?.channelState === 'connecting' ? '连接中'
      : health?.channelState === 'error' ? '连接异常' : '未连接'
  const collectionNeedsAttention = health?.collection.status === 'partial' || health?.collection.status === 'failed'
  const platformLabel = collectionNeedsAttention ? '采集需处理'
    : health?.collection.status === 'running' ? '正在采集'
      : health?.presence.status === 'online' ? '平台在线'
        : health?.presence.status === 'error' ? '平台异常'
          : health?.presence.status === 'offline' ? '采集未启用' : '平台状态读取中'
  const platformHealthDetail = [health?.presence.message, health?.collection.message].filter(Boolean).join('；')

  return (
    <footer className="desktop-statusbar" aria-label="工作区状态栏" data-testid="desktop-statusbar">
      <span className="desktop-statusbar-context">
        <span className="desktop-statusbar-dot" aria-hidden="true" />
        <span>{workspaceName || '工作区状态未知'}</span>
        {accountName && <><span className="desktop-statusbar-separator" aria-hidden="true">·</span><span>{accountName}</span></>}
      </span>
      <button type="button" className="desktop-statusbar-action" aria-label="查看 AI 执行模式" title="查看客户端 AI 模式与连接状态" onClick={() => window.open('ops-desktop://ui/menu/client', '_blank', 'noopener,noreferrer')}>
        <Bot aria-hidden="true" />
        <span>AI 执行模式</span>
      </button>
      <button type="button" className="desktop-statusbar-action desktop-statusbar-health" data-status={health?.channelState ?? 'unknown'} aria-label={`本机 AI 通道：${channelLabel}`} title={health?.channelMessage || '等待客户端通道状态'} onClick={() => window.open('ops-desktop://ui/settings/connection', '_blank', 'noopener,noreferrer')}>
        <span className="desktop-statusbar-health-dot" aria-hidden="true" />
        <span>通道 {channelLabel}</span>
      </button>
      <button type="button" className="desktop-statusbar-action desktop-statusbar-health" data-status={collectionNeedsAttention ? health?.collection.status : health?.presence.status ?? 'unknown'} aria-label={`平台采集：${platformLabel}`} title={platformHealthDetail || '等待平台连接状态'} onClick={() => window.open('ops-desktop://ui/settings/connection', '_blank', 'noopener,noreferrer')}>
        <span className="desktop-statusbar-health-dot" aria-hidden="true" />
        <span>{platformLabel}</span>
      </button>
      <button type="button" className="desktop-statusbar-action" aria-pressed={reducedMotion} aria-label={reducedMotion ? '关闭手动减少动态效果' : '减少动态效果'} title={reducedMotion ? '动态效果已减少' : '减少动态效果'} onClick={toggleMotion}>
        <Waves aria-hidden="true" />
        <span>{reducedMotion ? '减少动态效果' : '轻快动效'}</span>
      </button>
      <span className="desktop-statusbar-spacer" />
      <span className="desktop-statusbar-save" aria-live="polite">
        <Activity aria-hidden="true" />
        {editorRoute ? '作品保存状态见编辑器' : '操作状态由当前页面反馈'}
      </span>
    </footer>
  )
}
