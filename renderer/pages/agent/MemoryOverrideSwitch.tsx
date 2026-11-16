import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { errorMessage, get, patch } from '@/lib/api'

// CF-P2-MEM-01（27 §11.1.1）：本会话记忆覆盖开关，挂在上下文页。
// 服务端契约：GET/PATCH /agent/memory-settings，会话覆盖值 on/off/''；
// 全局关闭后会话不能自行越过（off→on 不生效时如实显示）。无「全部确认」。

interface MemorySettings {
  use_enabled: boolean
  capture_enabled: boolean
  global_use_enabled: boolean
  global_capture_enabled: boolean
  revision: number
  overrides: Record<string, string>
}

export function MemoryOverrideSwitch({ conversationId, enabled }: { conversationId: string; enabled: boolean }) {
  const [settings, setSettings] = useState<MemorySettings | null>(null)
  const [busy, setBusy] = useState(false)
  const [loadError, setLoadError] = useState('')

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    setLoadError('')
    void get<MemorySettings>(`/agent/memory-settings?conversation_id=${conversationId}`)
      .then((data) => { if (!cancelled) setSettings(data) })
      .catch((error) => { if (!cancelled) setLoadError(errorMessage(error)) })
    return () => { cancelled = true }
  }, [conversationId, enabled])

  if (!enabled) return null

  const overrideUse = settings?.overrides.memory_use_override ?? ''
  // 全局关 + 会话 on：服务端 effectiveUse 仍为 false（全局关闭后会话不能越过）。
  const effectiveUse = overrideUse === 'off' ? false : overrideUse === 'on' ? (settings?.global_use_enabled ?? true) : (settings?.use_enabled ?? false)
  const overrideCapture = settings?.overrides.memory_capture_override ?? ''

  // PATCH 会话覆盖时两个字段都会整行写入（服务端语义），必须带上另一字段的当前值，
  // 否则切一个开关会把另一个覆盖清空。
  const setOverride = async (field: 'memory_use_override' | 'memory_capture_override', value: string) => {
    setBusy(true)
    try {
      const body = { conversation_id: conversationId }
      if (field === 'memory_use_override') Object.assign(body, { memory_use_override: value, memory_capture_override: settings?.overrides.memory_capture_override ?? '' })
      else Object.assign(body, { memory_use_override: settings?.overrides.memory_use_override ?? '', memory_capture_override: value })
      await patch('/agent/memory-settings', body)
      const next = await get<MemorySettings>(`/agent/memory-settings?conversation_id=${conversationId}`)
      setSettings(next)
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  if (loadError) return <p className="text-xs text-gamboge-700" data-testid="memory-override-error">记忆覆盖状态读取失败：{loadError}</p>
  if (!settings) return null

  return <section className="mt-4 rounded-lg border border-mist-200 p-3" data-testid="memory-override">
    <h4 className="text-xs font-semibold text-mist-700">本会话记忆覆盖</h4>
    <label className="mt-2 flex items-center justify-between gap-3">
      <span className="text-xs text-mist-600">使用已确认记忆（仅本会话）</span>
      <input type="checkbox" role="switch" aria-label="本会话使用记忆" data-testid="memory-override-use"
        checked={effectiveUse} disabled={busy}
        onChange={(event) => void setOverride('memory_use_override', event.target.checked ? 'on' : 'off')} />
    </label>
    <label className="mt-1 flex items-center justify-between gap-3">
      <span className="text-xs text-mist-600">允许本会话提炼候选</span>
      <input type="checkbox" role="switch" aria-label="本会话允许提炼记忆" data-testid="memory-override-capture"
        checked={overrideCapture === 'off' ? false : overrideCapture === 'on' ? (settings.global_capture_enabled ?? true) : (settings.capture_enabled ?? false)} disabled={busy}
        onChange={(event) => void setOverride('memory_capture_override', event.target.checked ? 'on' : 'off')} />
    </label>
    {overrideUse === 'on' && !settings.global_use_enabled && <p className="mt-1 text-xs text-gamboge-700">全局「使用记忆」已关闭，本会话无法自行开启；请在 设置→个性化→记忆 打开全局开关。</p>}
    <p className="mt-2 text-xs text-mist-500">只影响当前会话；要改全局默认请到 设置→个性化→记忆。关闭使用不删除任何已保存记忆。</p>
  </section>
}
