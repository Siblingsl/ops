import { useCallback, useRef } from 'react'

// DEV-AI27-07（27 §5.6）：工作视图分隔条。
// 可聚焦（Tab）、左右方向键每次 16px、Enter 恢复默认宽度；拖拽为鼠标路径。
// 宽度由父组件持久化到既有布局偏好。

export const PANEL_WIDTH_MIN = 320
export const PANEL_WIDTH_DEFAULT = 360
export const PANEL_WIDTH_MAX = 760

export function clampPanelWidth(width: number): number {
  return Math.min(PANEL_WIDTH_MAX, Math.max(PANEL_WIDTH_MIN, Math.round(width)))
}

export function PanelResizer({
  width,
  onWidthChange,
}: {
  width: number
  onWidthChange: (width: number) => void
}) {
  const dragging = useRef<{ startX: number; startWidth: number } | null>(null)

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = { startX: event.clientX, startWidth: width }
    event.currentTarget.setPointerCapture(event.pointerId)
  }, [width])

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return
    // 向左拖 = 变宽（面板在右侧）。
    const next = dragging.current.startWidth + (dragging.current.startX - event.clientX)
    onWidthChange(clampPanelWidth(next))
  }, [onWidthChange])

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
  }, [])

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      onWidthChange(clampPanelWidth(width + 16))
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      onWidthChange(clampPanelWidth(width - 16))
    } else if (event.key === 'Enter' || event.key === 'Escape') {
      event.preventDefault()
      onWidthChange(PANEL_WIDTH_DEFAULT)
    }
  }, [width, onWidthChange])

  return <div
    role="separator"
    aria-orientation="vertical"
    aria-label={`调整工作视图宽度，当前 ${width} 像素；左右方向键每次 16 像素，回车恢复默认 ${PANEL_WIDTH_DEFAULT} 像素`}
    aria-valuenow={width}
    aria-valuemin={PANEL_WIDTH_MIN}
    aria-valuemax={PANEL_WIDTH_MAX}
    tabIndex={0}
    className="desktop-agent-panel-resizer"
    data-testid="desktop-agent-panel-resizer"
    onPointerDown={onPointerDown}
    onPointerMove={onPointerMove}
    onPointerUp={onPointerUp}
    onKeyDown={onKeyDown}
  />
}
