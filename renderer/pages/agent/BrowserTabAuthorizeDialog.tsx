import { useCallback, useEffect, useState } from 'react'
import { Globe, Loader2, Lock, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog } from '@/components/dialog'
import { Button, cn } from '@/components/ui'
import { ApiError, errorMessage, post } from '@/lib/api'
import type { DesktopBrowserTab } from '@/lib/desktop-presentation'

// DEV-AI27-A30：浏览器标签授权弹窗（浏览器侧镜像 A12 选窗器，27 §13 发送时序）。
// 决策 A：模型请求标签时才弹窗——租约只有 30 秒，发消息前预创建会在模型真正操作前过期。
// C09：枚举完全在本机（桥 → 扩展 tabs_list）；上送服务端的只有选中标签的 origin 与 tab_handle。
// origins 默认只授权顶层页面源；第三方 frame origin 由 observe_frames 发现后另行追加授权（A7）。
// 桥未启动/未配对时如实展示原因与指引，不伪造标签列表。

type Scope = 'observe' | 'act'
type LoadState = 'idle' | 'loading' | 'ready' | 'unsupported' | 'failed'

export const BROWSER_TAB_PICKER_TESTID = 'browser-tab-picker'
export const BROWSER_TAB_OPTION_TESTID = 'browser-tab-option'
export const BROWSER_TAB_AUTHORIZE_TESTID = 'browser-tab-authorize'

const OBSERVE_ACTIONS = ['observe', 'extract', 'screenshot']
const ACT_ACTIONS = ['observe', 'navigate', 'click', 'type', 'extract', 'screenshot']

interface BindingSummary {
  id: string
  state: string
}

export function BrowserTabAuthorizeDialog({
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
  const [tabs, setTabs] = useState<DesktopBrowserTab[]>([])
  const [bindings, setBindings] = useState<BindingSummary[]>([])
  const [state, setState] = useState<LoadState>('idle')
  const [message, setMessage] = useState('')
  const [selected, setSelected] = useState(0)
  const [scope, setScope] = useState<Scope>('observe')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const bridge = window.opsDesktopUI
    if (!bridge?.listBrowserTabs) {
      setState('unsupported')
      setMessage('需要 OPS Desktop 客户端：标签列表只在本机读取，浏览器版无法枚举本机 Chrome 标签。')
      return
    }
    setState('loading')
    setMessage('')
    // 绑定归属由服务端判定（W04 API）；弹窗只取本人绑定的 id 与状态供授权时引用。
    let readyBindings: BindingSummary[] = []
    try {
      const res = await fetch('/api/v1/agent/browser/bindings', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      if (res.ok) {
        const data = await res.json() as { bindings?: BindingSummary[] }
        readyBindings = (data.bindings ?? []).filter((item) => item.state === 'ready')
      }
    } catch { /* 绑定读取失败留给授权时报错，不阻断标签枚举 */ }
    setBindings(readyBindings)
    const result = await bridge.listBrowserTabs()
    if (!result.ok) {
      setState('failed')
      setMessage(result.message)
      return
    }
    const usable = result.tabs.filter((tab) => tab.origin.startsWith('http://') || tab.origin.startsWith('https://'))
    setTabs(usable)
    setState('ready')
    setSelected(usable[0]?.tab_id ?? 0)
    if (usable.length === 0) setMessage('没有可授权的网页标签（http/https）；请先在 Chrome 打开要操作的页面再刷新。')
  }, [])

  useEffect(() => {
    if (!open) {
      setTabs([])
      setSelected(0)
      setState('idle')
      setMessage('')
      setBusy(false)
      return
    }
    void load()
  }, [open, load])

  const target = tabs.find((tab) => tab.tab_id === selected)

  const authorize = async () => {
    if (!target || !conversationId || !runId) return
    const binding = bindings.find((item) => item.state === 'ready')
    if (!binding) {
      toast.error('授权失败', { description: '没有可用的浏览器绑定；请先在工作台完成浏览器配对。' })
      return
    }
    setBusy(true)
    try {
      await post(`/agent/conversations/${conversationId}/browser-grants`, {
        binding_id: binding.id,
        run_id: runId,
        tab_handle: String(target.tab_id),
        origins: [target.origin],
        actions: scope === 'act' ? ACT_ACTIONS : OBSERVE_ACTIONS,
        policy_version: '1',
      })
      const summary = target.title ? `${target.title}（${target.origin}）` : target.origin
      toast.success(`已授权标签：${summary}`, {
        description: '授权 30 秒内有效；期间模型只能观察或操作这一个标签的已授权来源，过期后需要重新选择。',
      })
      onAuthorized(summary)
      onClose()
    } catch (error) {
      const code = error instanceof ApiError ? error.code : ''
      const hint = code === 'browser_lease_conflict'
        ? '前台正被电脑控制占用；先停止电脑控制再授权标签。'
        : code === 'browser_binding_not_found'
          ? '浏览器绑定已失效；请重新配对后再试。'
          : code === 'browser_run_not_active'
            ? '任务已经结束，授权随任务失效；请让模型重新发起请求。'
            : code === 'agent_feature_unavailable'
              ? '浏览器协作尚未在你的工作区开放。'
              : errorMessage(error)
      toast.error('授权失败', { description: hint })
    } finally {
      setBusy(false)
    }
  }

  return <Dialog
    open={open}
    onClose={onClose}
    title="选择要操作的浏览器标签"
    desc="标签列表只在你本机读取。选中后授权 30 秒内有效，模型只能观察或操作这一个标签；未获准的标签不会被读取。"
    width="max-w-2xl"
    ariaLabel="选择要操作的浏览器标签"
    footer={<>
      <Button variant="ghost" icon={<RefreshCw className="size-4" />} onClick={() => void load()} disabled={busy || state === 'loading'}>
        刷新
      </Button>
      <span className="flex-1" />
      <Button variant="ghost" onClick={onClose} disabled={busy}>取消</Button>
      <Button
        variant="human"
        data-testid={BROWSER_TAB_AUTHORIZE_TESTID}
        loading={busy}
        disabled={!target || !conversationId || !runId || state !== 'ready'}
        disabledHint={!conversationId || !runId ? '当前没有进行中的会话任务' : '先选择一个要授权的标签'}
        onClick={() => void authorize()}
      >
        {scope === 'act' ? '授权操作' : '授权观察'}
      </Button>
    </>}
  >
    <div data-testid={BROWSER_TAB_PICKER_TESTID}>
      {state === 'loading' && <p className="flex items-center gap-2 py-6 text-[13px] text-mist-500">
        <Loader2 className="size-4 animate-spin" />正在本机读取标签列表…
      </p>}

      {(state === 'unsupported' || state === 'failed') && <p className="py-6 text-[13px] leading-relaxed text-mist-600">{message}</p>}

      {state === 'ready' && tabs.length > 0 && <div className="max-h-72 space-y-1.5 overflow-y-auto" role="radiogroup" aria-label="可授权标签">
        {tabs.map((tab) => {
          const active = tab.tab_id === selected
          return <button
            key={tab.tab_id}
            type="button"
            role="radio"
            aria-checked={active}
            data-testid={BROWSER_TAB_OPTION_TESTID}
            onClick={() => setSelected(tab.tab_id)}
            className={cn(
              'flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors',
              active
                ? 'cursor-pointer border-ink-300 bg-ink-50'
                : 'cursor-pointer border-mist-100 hover:border-mist-200 hover:bg-mist-50',
            )}
          >
            <span className={cn('rounded-md p-1.5', active ? 'bg-white text-ink-600' : 'bg-mist-100 text-mist-500')}>
              <Globe className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-mist-800">{tab.title || '(无标题标签)'}</span>
              <span className="block truncate text-xs text-mist-400">{tab.origin}</span>
            </span>
            {tab.active && <span className="shrink-0 text-xs text-mist-400">当前标签</span>}
          </button>
        })}
      </div>}

      {state === 'ready' && tabs.length === 0 && <p className="py-6 text-[13px] leading-relaxed text-mist-600">{message}</p>}

      {state === 'ready' && <div className="mt-4 space-y-1.5 border-t border-mist-100 pt-3">
        <p className="text-xs font-medium text-mist-500">授权范围</p>
        <div className="flex gap-2">
          {([['observe', '仅观察', '只读取页面内容，不点击不输入'], ['act', '可操作', '可以点击、输入与导航；提交类影响仍逐项确认']] as const).map(([value, label, hint]) =>
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
              <span className="flex items-center gap-1.5 text-[13px] font-medium text-mist-800">
                {value === 'observe' ? <Lock className="size-3.5" /> : null}{label}
              </span>
              <span className="mt-0.5 block text-xs leading-relaxed text-mist-400">{hint}</span>
            </button>,
          )}
        </div>
        <p className="text-xs leading-relaxed text-mist-400">
          页面内嵌的第三方内容（如广告框架）不在本次授权内；模型发现后需要你单独确认才会读取。
        </p>
      </div>}
    </div>
  </Dialog>
}
