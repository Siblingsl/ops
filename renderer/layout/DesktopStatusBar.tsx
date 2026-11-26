import { useEffect, useState } from 'react'
import { useConnectionState } from '@/lib/connection-state'
import { isElectronDesktop, type DesktopUpdateStatus } from '@/lib/desktop-presentation.js'
import { getDesktopUpdateStatus, hasDesktopBridgeMethod, subscribeDesktopUpdateStatus } from '@/lib/platform-bridge'
import { CloudOff, LoaderCircle } from 'lucide-react'
import DesktopUpdateDialog from '@/components/desktop-update-dialog'

// UI-09（docs/38 §10）：底栏只显示“已连接 / 连接中… / 离线，点击重试”，
// 不出现“操作状态由当前页面反馈”之类的开发文案；状态由真实连接探测驱动。
const stateLabels = { online: '已连接', checking: '连接中…', offline: '离线，点击重试' } as const

export default function DesktopStatusBar({ workspaceName, accountName }: { workspaceName?: string; accountName?: string }) {
  const desktop = isElectronDesktop(navigator.userAgent)
  if (!desktop) return null

  const { state, retry } = useConnectionState()
  // OPT-E02（docs/43 §5）：只在有新版本时于连接态之前插入温和提示；
  // 无新版本时底栏 DOM 与改造前完全一致。更新弹窗只由用户点击打开，绝不自动弹出。
  const [updateStatus, setUpdateStatus] = useState<DesktopUpdateStatus | null>(null)
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false)

  useEffect(() => {
    if (!hasDesktopBridgeMethod('onUpdateStatus')) return
    let alive = true
    const unsubscribe = subscribeDesktopUpdateStatus(setUpdateStatus)
    void getDesktopUpdateStatus().then((result) => {
      if (alive && result.ok) setUpdateStatus(result.status)
    }).catch(() => undefined)
    return () => { alive = false; unsubscribe() }
  }, [])

  return (
    <>
      <footer className="desktop-statusbar" aria-label="工作区状态栏" data-testid="desktop-statusbar">
        <span className="desktop-statusbar-context" title={[workspaceName, accountName].filter(Boolean).join(' · ')}>
          <span className="desktop-statusbar-dot" aria-hidden="true" />
          <span>{workspaceName || '工作区状态未知'}</span>
          {accountName && <><span className="desktop-statusbar-separator" aria-hidden="true">·</span><span>{accountName}</span></>}
        </span>
        <span className="desktop-statusbar-spacer" />
        {updateStatus?.updateAvailable && updateStatus.latestVersion && (
          <button type="button" className="desktop-statusbar-action" data-testid="desktop-update-pill" onClick={() => setUpdateDialogOpen(true)}>
            发现新版本 v{updateStatus.latestVersion}
          </button>
        )}
        {state === 'offline'
          ? <button type="button" className="desktop-statusbar-save desktop-statusbar-retry" aria-live="polite" onClick={retry}>
              <CloudOff aria-hidden="true" />
              {stateLabels.offline}
            </button>
          : <span className="desktop-statusbar-save" aria-live="polite" data-state={state}>
              {state === 'checking' && <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />}
              {stateLabels[state]}
            </span>}
      </footer>
      <DesktopUpdateDialog open={updateDialogOpen} onClose={() => setUpdateDialogOpen(false)} status={updateStatus} />
    </>
  )
}
