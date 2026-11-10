import { useCallback, useEffect, useState } from 'react'
import { AppWindow, Loader2, Lock, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog } from '@/components/dialog'
import { Button, cn } from '@/components/ui'
import { ApiError, errorMessage, post } from '@/lib/api'

// DEV-AI27-17（W17b，A12）：本机选窗器。
// 决策 A：模型请求前台时才弹窗——租约只有 30 秒，发消息前预创建会在模型真正操作前过期。
// C09：枚举完全在本机；上送服务端的只有选中项的必要摘要与不透明 handle，没有窗口全集。

type WindowItem = { handle: string; process: string; title: string; forbidden: boolean }
type Scope = 'observe' | 'act'
type LoadState = 'idle' | 'loading' | 'ready' | 'unsupported' | 'failed'

export const COMPUTER_WINDOW_PICKER_TESTID = 'computer-window-picker'
export const COMPUTER_WINDOW_OPTION_TESTID = 'computer-window-option'
export const COMPUTER_WINDOW_AUTHORIZE_TESTID = 'computer-window-authorize'

/** windowSummary 是上送服务端的脱敏摘要：应用名 + 窗口标题，截断到服务端 200 字上限以内。 */
function windowSummary(item: WindowItem): string {
  const text = `${item.process} · ${item.title}`.trim()
  return text.length > 160 ? `${text.slice(0, 159)}…` : text
}

export function ComputerWindowPicker({
  open,
  conversationId,
  runId,
  onClose,
  onAuthorized,
}: {
  open: boolean
  conversationId?: string
  runId?: string
  onClose: () => void
  onAuthorized: (summary: string) => void
}) {
  const [items, setItems] = useState<WindowItem[]>([])
  const [state, setState] = useState<LoadState>('idle')
  const [message, setMessage] = useState('')
  const [selected, setSelected] = useState('')
  const [scope, setScope] = useState<Scope>('act')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const bridge = window.opsDesktopUI
    if (!bridge?.listComputerWindows) {
      setState('unsupported')
      setMessage('需要 OPS Desktop 客户端：窗口枚举只在本机进行，浏览器版无法读取本机窗口。')
      return
    }
    setState('loading')
    setMessage('')
    const result = await bridge.listComputerWindows()
    if (!result.ok) {
      setState('failed')
      setMessage(result.message)
      return
    }
    setItems(result.windows)
    setState('ready')
    setSelected(result.windows.find((item) => !item.forbidden)?.handle ?? '')
    if (result.windows.length === 0) setMessage('没有找到可操作的应用窗口；请先打开要操作的应用再刷新。')
  }, [])

  useEffect(() => {
    if (!open) {
      setItems([])
      setSelected('')
      setState('idle')
      setMessage('')
      setBusy(false)
      return
    }
    void load()
  }, [open, load])

  const target = items.find((item) => item.handle === selected)

  const authorize = async () => {
    if (!target || target.forbidden || !conversationId) return
    setBusy(true)
    try {
      await post(`/agent/conversations/${conversationId}/computer-grants`, {
        ...(runId ? { run_id: runId } : {}),
        target_handle: target.handle,
        target_summary: windowSummary(target),
        scope,
        request_id: crypto.randomUUID(),
      })
      const summary = windowSummary(target)
      toast.success(`已授权：${summary}`, {
        description: '授权 30 秒内有效；期间模型可以观察这个窗口，过期后需要重新选择。',
      })
      onAuthorized(summary)
      onClose()
    } catch (error) {
      const code = error instanceof ApiError ? error.code : ''
      const hint = code === 'computer_foreground_busy'
        ? '前台正被占用（浏览器协作进行中或已有前台租约）；先停止它再选择。'
        : code === 'computer_hard_forbidden'
          ? '该窗口命中硬禁区（系统登录、凭据、终端等），任何情况下都不可授权。'
          : code === 'agent_feature_unavailable'
            ? '电脑控制尚未在你的工作区开放。'
            : errorMessage(error)
      toast.error('授权失败', { description: hint })
    } finally {
      setBusy(false)
    }
  }

  return <Dialog
    open={open}
    onClose={onClose}
    title="选择要操作的应用窗口"
    desc="窗口列表只在你本机读取。选中后授权 30 秒内有效，模型只能观察或操作这一个窗口。"
    width="max-w-2xl"
    ariaLabel="选择要操作的应用窗口"
    footer={<>
      <Button variant="ghost" icon={<RefreshCw className="size-4" />} onClick={() => void load()} disabled={busy || state === 'loading'}>
        刷新
      </Button>
      <span className="flex-1" />
      <Button variant="ghost" onClick={onClose} disabled={busy}>取消</Button>
      <Button
        variant="human"
        data-testid={COMPUTER_WINDOW_AUTHORIZE_TESTID}
        loading={busy}
        disabled={!target || target.forbidden || !conversationId || state !== 'ready'}
        disabledHint={!conversationId ? '当前没有进行中的会话' : '先选择一个可操作的窗口'}
        onClick={() => void authorize()}
      >
        {scope === 'act' ? '授权操作' : '授权观察'}
      </Button>
    </>}
  >
    <div data-testid={COMPUTER_WINDOW_PICKER_TESTID}>
      {state === 'loading' && <p className="flex items-center gap-2 py-6 text-[13px] text-mist-500">
        <Loader2 className="size-4 animate-spin" />正在本机读取窗口列表…
      </p>}

      {(state === 'unsupported' || state === 'failed') && <p className="py-6 text-[13px] leading-relaxed text-mist-600">{message}</p>}

      {state === 'ready' && items.length > 0 && <div className="space-y-1.5" role="radiogroup" aria-label="可操作窗口">
        {items.map((item) => {
          const active = item.handle === selected
          return <button
            key={item.handle}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={item.forbidden}
            data-testid={COMPUTER_WINDOW_OPTION_TESTID}
            onClick={() => setSelected(item.handle)}
            className={cn(
              'flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors',
              item.forbidden
                ? 'cursor-not-allowed border-mist-100 bg-mist-50/60 opacity-60'
                : active
                  ? 'cursor-pointer border-ink-300 bg-ink-50'
                  : 'cursor-pointer border-mist-100 hover:border-mist-200 hover:bg-mist-50',
            )}
          >
            <span className={cn('rounded-md p-1.5', active ? 'bg-white text-ink-600' : 'bg-mist-100 text-mist-500')}>
              {item.forbidden ? <Lock className="size-4" /> : <AppWindow className="size-4" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-mist-800">{item.title || '(无标题窗口)'}</span>
              <span className="block truncate text-xs text-mist-400">{item.process}</span>
            </span>
            {item.forbidden && <span className="shrink-0 text-xs text-mist-400">系统受限，不可选</span>}
          </button>
        })}
      </div>}

      {state === 'ready' && items.length === 0 && <p className="py-6 text-[13px] leading-relaxed text-mist-600">{message}</p>}

      {state === 'ready' && <div className="mt-4 space-y-1.5 border-t border-mist-100 pt-3">
        <p className="text-xs font-medium text-mist-500">授权范围</p>
        <div className="flex gap-2">
          {([['act', '可操作', '可以点击、输入；保存/发送等影响仍逐项确认'], ['observe', '仅观察', '只读取界面内容，不输入']] as const).map(([value, label, hint]) =>
            <button
              key={value}
              type="button"
              onClick={() => setScope(value)}
              aria-pressed={scope === value}
              className={cn(
                'flex-1 cursor-pointer rounded-lg border px-3 py-2 text-left transition-colors',
                scope === value ? 'border-ink-300 bg-ink-50' : 'border-mist-100 hover:border-mist-200',
              )}
            >
              <span className="block text-[13px] font-medium text-mist-800">{label}</span>
              <span className="mt-0.5 block text-xs leading-relaxed text-mist-400">{hint}</span>
            </button>,
          )}
        </div>
      </div>}
    </div>
  </Dialog>
}
