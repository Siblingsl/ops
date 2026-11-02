import { Activity } from 'lucide-react'
import { useLocation } from 'react-router-dom'
import { isElectronDesktop } from '@/lib/desktop-presentation.js'

export default function DesktopStatusBar({ workspaceName, accountName }: { workspaceName?: string; accountName?: string }) {
  const desktop = isElectronDesktop(navigator.userAgent)
  const location = useLocation()
  if (!desktop) return null

  const editorRoute = /^\/works\/[^/]+$/.test(location.pathname)

  return (
    <footer className="desktop-statusbar" aria-label="工作区状态栏" data-testid="desktop-statusbar">
      <span className="desktop-statusbar-context" title={[workspaceName, accountName].filter(Boolean).join(' · ')}>
        <span className="desktop-statusbar-dot" aria-hidden="true" />
        <span>{workspaceName || '工作区状态未知'}</span>
        {accountName && <><span className="desktop-statusbar-separator" aria-hidden="true">·</span><span>{accountName}</span></>}
      </span>
      <span className="desktop-statusbar-spacer" />
      {/* 编辑器里字数和保存状态都在编辑器自己的底部条与左栏，这里再写一遍只是重复。 */}
      {!editorRoute && (
        <span className="desktop-statusbar-save" aria-live="polite">
          <Activity aria-hidden="true" />
          操作状态由当前页面反馈
        </span>
      )}
    </footer>
  )
}
