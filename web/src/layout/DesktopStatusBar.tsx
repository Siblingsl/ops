import { Activity, Bot, Waves } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { isElectronDesktop, setDesktopMotion } from '@/lib/desktop-presentation.js'

export default function DesktopStatusBar({ workspaceName, accountName }: { workspaceName?: string; accountName?: string }) {
  const desktop = isElectronDesktop(navigator.userAgent)
  const location = useLocation()
  const [reducedMotion, setReducedMotion] = useState(() => document.documentElement.dataset.reducedMotion === 'true')

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
