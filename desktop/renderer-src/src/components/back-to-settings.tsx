import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui'
import { requestOpenSettings, useEmbeddedSettings } from '@/lib/desktop-settings'
import { isElectronDesktop } from '@/lib/desktop-presentation.js'

/**
 * 独立工具页的「返回设置」入口（ST-06）。
 * 桌面端从设置窗跳出到主窗口的工具页时，用户需要一条回到设置窗的路；
 * Web 端与设置窗内嵌渲染都不显示，避免无意义入口。
 */
export function BackToSettings({ label = '返回设置' }: { label?: string }) {
  const embedded = useEmbeddedSettings()
  if (!isElectronDesktop(navigator.userAgent) || embedded) return null
  return (
    <Button variant="ghost" size="sm" icon={<ArrowLeft className="size-3.5" />} onClick={() => void requestOpenSettings()}>{label}</Button>
  )
}
