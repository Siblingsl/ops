import { Copy } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button, Notice } from '@/components/ui'
import { Dialog } from '@/components/dialog'
import type { DesktopUpdateStatus } from '@/lib/desktop-presentation.js'

// OPT-E02（docs/43 §5）：更新详情弹窗只在用户主动点击底栏提示或设置页「查看更新」时打开，
// 绝不自动弹出打断写稿。下载按钮只调用主进程固定意图，不直接 window.open 任意 URL。
export default function DesktopUpdateDialog({ open, onClose, status }: {
  open: boolean
  onClose: () => void
  status: DesktopUpdateStatus | null
}) {
  const [opening, setOpening] = useState(false)
  const currentVersion = status?.currentVersion || '未知'
  const latestVersion = status?.latestVersion || '未知'
  const notes = status?.releaseNotes?.trim() || ''
  const downloadUrl = status?.downloadUrl || ''
  const sha256 = status?.sha256 || ''

  const openDownload = async () => {
    const ui = window.opsDesktopUI
    if (!ui?.openUpdateDownload) {
      toast.error('当前环境不支持打开下载链接')
      return
    }
    setOpening(true)
    try {
      const result = await ui.openUpdateDownload()
      if (!result.ok) toast.error(result.message)
    } catch {
      toast.error('打开下载链接失败，请稍后重试')
    } finally {
      setOpening(false)
    }
  }

  const copySHA = async () => {
    if (!sha256) return
    try {
      await navigator.clipboard.writeText(sha256)
      toast.success('SHA-256 已复制', { duration: 1200 })
    } catch {
      toast.error('复制失败，请手动选中复制')
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="客户端版本更新"
      desc="更新由你决定；检查与下载都不会中断正在编辑的稿件。"
      width="max-w-xl"
      ariaLabel="客户端版本更新"
      footer={<>
        <Button variant="ghost" onClick={onClose}>稍后</Button>
        {downloadUrl && <Button variant="primary" loading={opening} onClick={openDownload}>前往下载</Button>}
      </>}
    >
      <div className="space-y-4 text-[13px] leading-relaxed text-mist-600" data-testid="desktop-update-dialog">
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg border border-line/70 px-3 py-2">
            <div className="text-[12px] text-mist-400">当前版本</div>
            <div className="mt-0.5 font-medium text-mist-800">v{currentVersion}</div>
          </div>
          <div className="rounded-lg border border-line/70 px-3 py-2">
            <div className="text-[12px] text-mist-400">最新版本</div>
            <div className="mt-0.5 font-medium text-mist-800">v{latestVersion}</div>
          </div>
        </div>
        <div>
          <div className="mb-1 text-[12.5px] font-medium text-mist-700">更新说明</div>
          {notes
            ? <p className="whitespace-pre-wrap">{notes}</p>
            : <p className="text-mist-400">暂无详细更新说明</p>}
        </div>
        {sha256 && <div>
          <div className="mb-1 text-[12.5px] font-medium text-mist-700">SHA-256 校验值</div>
          <div className="flex items-start gap-2">
            <code className="min-w-0 break-all rounded-md bg-mist-50 px-2 py-1 font-mono text-[12px] text-mist-600">{sha256}</code>
            <Button size="sm" variant="ghost" icon={<Copy className="size-3.5" />} onClick={copySHA}>复制</Button>
          </div>
        </div>}
        {!downloadUrl && <Notice tone="gamboge">
          服务端未配置下载链接，请联系管理员获取最新安装包。
        </Notice>}
      </div>
    </Dialog>
  )
}
