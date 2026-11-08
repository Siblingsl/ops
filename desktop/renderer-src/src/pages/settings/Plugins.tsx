import { useCallback, useEffect, useState } from 'react'
import { Button, Notice } from '@/components/ui'
import { api } from '@/lib/api'

// DEV-AI27-14 第二批（W14b）：插件/MCP 管理页（27 §11.2.1）。
// 连接列表/添加（stdio/http）/状态机操作（enable/disable/revoke）/目录/最近错误。
// 状态：draft/ready_disabled/enabled/disabled/revoked——安装与启用分离（红线）。

interface PluginConnection {
  id: string
  name: string
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  cwd?: string
  env_keys?: string[]
  url?: string
  protocol_version?: string
  server_name?: string
  server_version?: string
  catalog_revision?: string
  state: string
  revision: number
  last_error?: string
}

const stateLabels: Record<string, string> = {
  draft: '待配置',
  ready_disabled: '已验证 · 未启用',
  enabled: '已启用',
  disabled: '已停用',
  revoked: '已撤销',
  error: '连接异常',
}

export default function Plugins() {
  const [connections, setConnections] = useState<PluginConnection[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  const [draft, setDraft] = useState({
    name: '', transport: 'stdio' as 'stdio' | 'http',
    command: '', argsText: '', url: '',
  })

  const reload = useCallback(async () => {
    try {
      const data = await api('GET', '/agent/plugin-connections')
      setConnections((data as { connections: PluginConnection[] }).connections)
      setError('')
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err))
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  const create = async () => {
    setBusy(true)
    try {
      const args = draft.argsText.split('\n').map((a) => a.trim()).filter(Boolean)
      await api('POST', '/agent/plugin-connections', {
        name: draft.name, transport: draft.transport,
        command: draft.command, args,
        url: draft.url,
      })
      setDraft({ name: '', transport: 'stdio', command: '', argsText: '', url: '' })
      setShowAdd(false)
      await reload()
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err))
    } finally {
      setBusy(false)
    }
  }

  const action = async (id: string, act: string, revision: number) => {
    setBusy(true)
    try {
      await api('POST', `/agent/plugin-connections/${id}/actions`, {
        action: act, expected_revision: revision,
      })
      await reload()
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err))
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (id: string) => {
    setBusy(true)
    try {
      await api('DELETE', `/agent/plugin-connections/${id}`)
      await reload()
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err))
    } finally {
      setBusy(false)
    }
  }

  return <div className="mx-auto max-w-3xl space-y-6 p-6" data-testid="settings-plugins-page">
    <header className="flex items-center justify-between">
      <div>
        <h1 className="text-lg font-semibold text-ink-800">插件与工具</h1>
        <p className="mt-1 text-[13px] text-mist-600">MCP 连接注册与调用。安装与启用分离；启用前需验证连接。</p>
      </div>
      <Button size="sm" variant="primary" onClick={() => setShowAdd(!showAdd)}>{showAdd ? '取消' : '添加连接'}</Button>
    </header>

    {error && <Notice tone="gamboge">{error}</Notice>}

    {showAdd && <section className="space-y-3 rounded-xl border border-mist-200 bg-white p-4" data-testid="plugin-add-form">
      <h2 className="text-sm font-semibold text-ink-700">添加 MCP 连接</h2>
      <label className="block">
        <span className="text-xs text-mist-600">连接名称</span>
        <input className="mt-1 w-full rounded-md border border-mist-200 px-3 py-2 text-[13px]" value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="例如：文档检索" />
      </label>
      <label className="block">
        <span className="text-xs text-mist-600">传输方式</span>
        <select className="mt-1 w-full rounded-md border border-mist-200 px-3 py-2 text-[13px]"
          value={draft.transport} onChange={(e) => setDraft({ ...draft, transport: e.target.value as 'stdio' | 'http' })}>
          <option value="stdio">本机 stdio</option>
          <option value="http">远程 HTTP (https)</option>
        </select>
      </label>
      {draft.transport === 'stdio' && <>
        <label className="block">
          <span className="text-xs text-mist-600">命令（不拼接 shell）</span>
          <input className="mt-1 w-full rounded-md border border-mist-200 px-3 py-2 text-[13px] font-mono" value={draft.command}
            onChange={(e) => setDraft({ ...draft, command: e.target.value })} placeholder="例如：node /path/to/server.js" />
        </label>
        <label className="block">
          <span className="text-xs text-mist-600">参数（每行一个）</span>
          <textarea className="mt-1 w-full rounded-md border border-mist-200 px-3 py-2 text-[13px] font-mono" rows={3}
            value={draft.argsText} onChange={(e) => setDraft({ ...draft, argsText: e.target.value })}
            placeholder={'--port\n8080'} />
        </label>
      </>}
      {draft.transport === 'http' && <label className="block">
        <span className="text-xs text-mist-600">HTTPS 地址</span>
        <input className="mt-1 w-full rounded-md border border-mist-200 px-3 py-2 text-[13px] font-mono" value={draft.url}
          onChange={(e) => setDraft({ ...draft, url: e.target.value })} placeholder="https://mcp.example.com/v1" />
      </label>}
      <Button size="sm" variant="primary" disabled={busy || !draft.name.trim()} onClick={() => void create()}>
        创建（待配置）
      </Button>
    </section>}

    <section className="space-y-3" data-testid="plugin-connection-list">
      <h2 className="text-sm font-semibold text-ink-700">连接列表（{connections.length}）</h2>
      {connections.length === 0 && <p className="text-xs text-mist-500">还没有已注册的 MCP 连接。</p>}
      {connections.map((conn) => <div key={conn.id} className="rounded-lg border border-mist-200 bg-white p-4" data-testid={`plugin-conn-${conn.id}`}>
        <div className="flex items-center justify-between">
          <div>
            <span className="text-[13px] font-medium text-ink-700">{conn.name}</span>
            <span className="ml-2 rounded px-1.5 py-0.5 text-[11px] bg-mist-100 text-mist-600">{conn.transport}</span>
            <span className="ml-2 rounded px-1.5 py-0.5 text-[11px] bg-mist-100 text-mist-600">{stateLabels[conn.state] ?? conn.state}</span>
          </div>
        </div>
        {conn.server_name && <p className="mt-1 text-xs text-mist-500">
          服务器：{conn.server_name} v{conn.server_version} · 协议 {conn.protocol_version}
        </p>}
        {conn.last_error && <p className="mt-1 text-xs text-danger" role="alert">{conn.last_error}</p>}
        <div className="mt-2 flex flex-wrap gap-2">
          {(conn.state === 'draft' || conn.state === 'error') &&
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void action(conn.id, 'validate', conn.revision)}>验证连接</Button>}
          {(conn.state === 'ready_disabled' || conn.state === 'disabled') &&
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void action(conn.id, 'enable', conn.revision)}>启用</Button>}
          {conn.state === 'enabled' &&
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void action(conn.id, 'disable', conn.revision)}>停用</Button>}
          {conn.state !== 'revoked' &&
            <Button size="sm" variant="ghost" className="text-danger" disabled={busy} onClick={() => void revoke(conn.id)}>撤销</Button>}
        </div>
      </div>)}
    </section>
  </div>
}
