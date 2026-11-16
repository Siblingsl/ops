import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Switch } from '@/components/ui'
import { errorMessage, get, patch } from '@/lib/api'

// CF-P2-MEM-03（27 §11.1.1 / docs/34 §14.1）：Web 端本会话记忆覆盖，
// 挂在「对话设置」Dialog。契约与桌面端 MemoryOverrideSwitch 相同：
// GET/PATCH /agent/memory-settings，会话覆盖值 on/off/''；
// 全局关闭后会话不能自行越过（如实显示）。无「全部确认」。

interface MemorySettings {
  use_enabled: boolean
  capture_enabled: boolean
  global_use_enabled: boolean
  global_capture_enabled: boolean
  revision: number
  overrides: Record<string, string>
}

export function MemoryOverrideSection({ conversationId }: { conversationId: string }) {
  const [settings, setSettings] = useState<MemorySettings | null>(null)
  const [busy, setBusy] = useState(false)
  const [loadError, setLoadError] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoadError('')
    void get<MemorySettings>(`/agent/memory-settings?conversation_id=${conversationId}`)
      .then((data) => { if (!cancelled) setSettings(data) })
      .catch((error) => { if (!cancelled) setLoadError(errorMessage(error)) })
    return () => { cancelled = true }
  }, [conversationId])

  const overrideUse = settings?.overrides.memory_use_override ?? ''
  const effectiveUse = overrideUse === 'off' ? false : overrideUse === 'on' ? (settings?.global_use_enabled ?? true) : (settings?.use_enabled ?? false)
  const overrideCapture = settings?.overrides.memory_capture_override ?? ''
  const effectiveCapture = overrideCapture === 'off' ? false : overrideCapture === 'on' ? (settings?.global_capture_enabled ?? true) : (settings?.capture_enabled ?? false)

  // PATCH 会话覆盖按整行写入：必须携带另一字段当前值，否则会清空它。
  const setOverride = async (field: 'memory_use_override' | 'memory_capture_override', value: string) => {
    setBusy(true)
    try {
      const body = { conversation_id: conversationId }
      if (field === 'memory_use_override') Object.assign(body, { memory_use_override: value, memory_capture_override: settings?.overrides.memory_capture_override ?? '' })
      else Object.assign(body, { memory_use_override: settings?.overrides.memory_use_override ?? '', memory_capture_override: value })
      await patch('/agent/memory-settings', body)
      setSettings(await get<MemorySettings>(`/agent/memory-settings?conversation_id=${conversationId}`))
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  if (loadError) return <p className="text-xs text-gamboge-700" data-testid="web-memory-override-error">记忆覆盖状态读取失败：{loadError}</p>
  if (!settings) return null

  return <div className="space-y-2 rounded-lg border border-mist-200 p-3" data-testid="web-memory-override">
    <p className="text-[13px] font-medium text-mist-700">本会话记忆覆盖</p>
    <div className="flex items-center justify-between gap-4">
      <span className="text-xs text-mist-600">使用已确认记忆（仅本会话）</span>
      <Switch label="本会话使用记忆" checked={effectiveUse} disabled={busy} onChange={(value) => void setOverride('memory_use_override', value ? 'on' : 'off')} />
    </div>
    <div className="flex items-center justify-between gap-4">
      <span className="text-xs text-mist-600">允许本会话提炼候选</span>
      <Switch label="本会话允许提炼记忆" checked={effectiveCapture} disabled={busy} onChange={(value) => void setOverride('memory_capture_override', value ? 'on' : 'off')} />
    </div>
    {overrideUse === 'on' && !settings.global_use_enabled && <p className="text-xs text-gamboge-700">全局「使用记忆」已关闭，本会话无法自行开启；请在 设置→个性化 里打开全局开关。</p>}
    <p className="text-xs text-mist-500">只影响当前会话；全局默认在 设置→个性化 里改。关闭使用不删除任何已保存记忆。</p>
  </div>
}
