import { useCallback, useEffect, useState } from 'react'
import { Button, Input, Notice } from '@/components/ui'
import { api } from '@/lib/api'

// DEV-AI27-13（W13）：设置→个性化→记忆（27 §11.1.1）。
// 两个独立开关（使用已确认记忆 / 自动提炼候选）；候选逐项确认/修改/忽略；
// 启用中的记忆可停用/删除。没有"全部确认"，模型不能自行确认（红线）。

interface PersonalMemory {
  id: string
  text: string
  state: 'candidate' | 'active' | 'ignored' | 'disabled' | 'source_unavailable' | 'deleted'
  source_conversation_id?: string
  revision: number
  updated_at: string
}

interface MemorySettings {
  use_enabled: boolean
  capture_enabled: boolean
  revision: number
}

const stateLabels: Record<PersonalMemory['state'], string> = {
  candidate: '待确认候选',
  active: '使用中',
  ignored: '已忽略',
  disabled: '已停用',
  source_unavailable: '来源失效',
  deleted: '已删除',
}

export default function Memory() {
  const [settings, setSettings] = useState<MemorySettings | null>(null)
  const [items, setItems] = useState<PersonalMemory[]>([])
  const [error, setError] = useState('')
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState<{ id: string; text: string; revision: number } | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(async () => {
    try {
      const [s, list] = await Promise.all([
        api('GET', '/agent/memory-settings'),
        api('GET', '/agent/personal-memories'),
      ])
      setSettings(s as MemorySettings)
      setItems((list as { memories: PersonalMemory[] }).memories)
      setError('')
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err))
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  const patchSettings = async (patch: Record<string, unknown>) => {
    if (!settings) return
    setBusy(true)
    try {
      const next = await api('PATCH', '/agent/memory-settings', { ...patch, expected_revision: settings.revision })
      setSettings(next as MemorySettings)
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err))
    } finally {
      setBusy(false)
    }
  }

  const patchMemory = async (id: string, body: Record<string, unknown>) => {
    setBusy(true)
    try {
      await api('PATCH', '/agent/personal-memories/' + id, body)
      await reload()
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err))
    } finally {
      setBusy(false)
    }
  }

  const create = async () => {
    if (!draft.trim()) return
    setBusy(true)
    try {
      await api('POST', '/agent/personal-memories', { text: draft })
      setDraft('')
      await reload()
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err))
    } finally {
      setBusy(false)
    }
  }

  const candidates = items.filter((m) => m.state === 'candidate')
  const actives = items.filter((m) => m.state === 'active' || m.state === 'disabled' || m.state === 'source_unavailable')

  return <div className="mx-auto max-w-3xl space-y-6 p-6" data-testid="settings-memory-page">
    <header>
      <h1 className="text-lg font-semibold text-ink-800">个性化 · 记忆</h1>
      <p className="mt-1 text-[13px] text-mist-600">跨对话记忆只属于你本人，确认后才会注入后续对话。账号业务写作记忆在账号档案里单独管理，互不影响。</p>
    </header>

    {error && <Notice tone="gamboge">{error}</Notice>}

    <section className="space-y-3 rounded-xl border border-mist-200 bg-white p-4" data-testid="memory-settings">
      <h2 className="text-sm font-semibold text-ink-700">记忆开关</h2>
      <label className="flex items-center justify-between gap-4">
        <span>
          <span className="block text-[13px] text-ink-700">使用已确认记忆</span>
          <span className="block text-xs text-mist-500">关闭后新对话不再注入记忆，已保存内容不受影响。</span>
        </span>
        <input type="checkbox" role="switch" aria-label="使用已确认记忆" checked={settings?.use_enabled ?? false}
          disabled={busy || !settings} onChange={(event) => void patchSettings({ use_enabled: event.target.checked })} />
      </label>
      <label className="flex items-center justify-between gap-4">
        <span>
          <span className="block text-[13px] text-ink-700">自动提炼候选</span>
          <span className="block text-xs text-mist-500">AI 在任务完成阶段把你明确表达的稳定偏好整理成候选；候选不经确认不会生效。</span>
        </span>
        <input type="checkbox" role="switch" aria-label="自动提炼候选" checked={settings?.capture_enabled ?? false}
          disabled={busy || !settings} onChange={(event) => void patchSettings({ capture_enabled: event.target.checked })} />
      </label>
    </section>

    <section className="space-y-3 rounded-xl border border-mist-200 bg-white p-4" data-testid="memory-candidates">
      <h2 className="text-sm font-semibold text-ink-700">待确认候选（{candidates.length}）</h2>
      {candidates.length === 0 && <p className="text-xs text-mist-500">当前没有待确认的候选。</p>}
      <ul className="space-y-3">
        {candidates.map((m) => <li key={m.id} className="rounded-lg border border-mist-200 p-3">
          {editing?.id === m.id ? <div className="space-y-2">
            <Input value={editing.text} aria-label="修改记忆内容" onChange={(event) => setEditing({ ...editing, text: event.target.value })} />
            <div className="flex gap-2">
              <Button size="sm" variant="primary" disabled={busy} onClick={() => { void patchMemory(m.id, { action: 'edit', text: editing.text, expected_revision: m.revision }).then(() => setEditing(null)) }}>保存并启用</Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(null)}>取消</Button>
            </div>
          </div> : <>
            <p className="text-[13px] text-ink-700">{m.text}</p>
            <p className="mt-1 text-xs text-mist-500">状态：{stateLabels[m.state]} · 更新于 {m.updated_at}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" variant="primary" disabled={busy} onClick={() => void patchMemory(m.id, { action: 'confirm', expected_revision: m.revision })}>确认保存</Button>
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => setEditing({ id: m.id, text: m.text, revision: m.revision })}>修改后保存</Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void patchMemory(m.id, { action: 'ignore', expected_revision: m.revision })}>忽略</Button>
            </div>
          </>}
        </li>)}
      </ul>
    </section>

    <section className="space-y-3 rounded-xl border border-mist-200 bg-white p-4" data-testid="memory-active-list">
      <h2 className="text-sm font-semibold text-ink-700">已保存记忆（{actives.length}）</h2>
      {actives.length === 0 && <p className="text-xs text-mist-500">还没有已保存的记忆。</p>}
      <ul className="space-y-3">
        {actives.map((m) => <li key={m.id} className="rounded-lg border border-mist-200 p-3">
          <p className="text-[13px] text-ink-700">{m.text}</p>
          <p className="mt-1 text-xs text-mist-500">状态：{stateLabels[m.state]} · 更新于 {m.updated_at}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {m.state === 'active' && <Button size="sm" variant="secondary" disabled={busy} onClick={() => void patchMemory(m.id, { action: 'disable', expected_revision: m.revision })}>停用</Button>}
            <Button size="sm" variant="ghost" className="text-danger" disabled={busy} onClick={() => void api('DELETE', '/agent/personal-memories/' + m.id).then(reload)}>删除</Button>
          </div>
        </li>)}
      </ul>
    </section>

    <section className="space-y-2 rounded-xl border border-mist-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-ink-700">手动添加记忆</h2>
      <Input value={draft} aria-label="新记忆内容" placeholder="例如：报告里的数字必须标注来源时间" onChange={(event) => setDraft(event.target.value)} />
      <Button size="sm" variant="primary" disabled={busy || !draft.trim()} onClick={() => void create()}>保存为启用中的记忆</Button>
    </section>
  </div>
}
