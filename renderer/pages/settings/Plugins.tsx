import { useCallback, useEffect, useState } from 'react'
import { KeyRound, Loader2 } from 'lucide-react'
import { Button, Notice } from '@/components/ui'
import { api } from '@/lib/api'
import type { DesktopMcpOAuthInput, DesktopMcpOAuthStatus } from '@/lib/desktop-presentation'

// DEV-AI27-14 第二批（W14b）：插件/MCP 管理页（27 §11.2.1）。
// 连接列表/添加（stdio/http）/状态机操作（enable/disable/revoke）/目录/最近错误。
// 状态：draft/ready_disabled/enabled/disabled/revoked——安装与启用分离（红线）。
// DEV-AI27-A3 第二片：http 连接的 OAuth 三态（无授权/已授权/需重新授权）——授权走
// 系统浏览器，状态来自主进程 statusView；client_id/scopes 非秘密，本机 localStorage
// 记忆；client_secret 不支持 UI 录入（public client PKCE 是 MCP 推荐路径，秘密录入
// 需专门安全设计）。

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

const oauthStateLabels: Record<string, string> = {
  unauthorized: '未授权',
  authorizing: '正在等待浏览器授权…',
  authorized: '已授权',
  needs_reauth: '需要重新授权',
}

/** OAuth 配置本机记忆（client_id/scopes 非秘密；client_secret 不落任何本机存储）。 */
function readStoredOAuth(connectionId: string): { client_id: string; scopes: string } {
  try {
    const raw = localStorage.getItem(`ops-mcp-oauth-${connectionId}`)
    if (raw) {
      const parsed = JSON.parse(raw) as { client_id?: unknown; scopes?: unknown }
      return {
        client_id: typeof parsed.client_id === 'string' ? parsed.client_id : '',
        scopes: typeof parsed.scopes === 'string' ? parsed.scopes : '',
      }
    }
  } catch { /* 损坏即视作未配置 */ }
  return { client_id: '', scopes: '' }
}

function writeStoredOAuth(connectionId: string, client_id: string, scopes: string): void {
  try { localStorage.setItem(`ops-mcp-oauth-${connectionId}`, JSON.stringify({ client_id, scopes })) } catch { /* 存不了就不记 */ }
}

function oauthInput(conn: PluginConnection, client_id: string, scopes: string): DesktopMcpOAuthInput {
  return {
    connection_id: conn.id,
    server_url: conn.url ?? '',
    ...(client_id ? { client_id } : {}),
    ...(scopes.trim() ? { scopes: scopes.trim().split(/\s+/) } : {}),
  }
}

/** http 连接的 OAuth 三态区块（27 §11.2；状态只来自主进程 statusView，不推断）。 */
function OAuthSection({ conn, onRevoked }: { conn: PluginConnection; onRevoked: () => void }) {
  const [status, setStatus] = useState<DesktopMcpOAuthStatus | null>(null)
  const [stored, setStored] = useState(() => readStoredOAuth(conn.id))
  const [showForm, setShowForm] = useState(false)
  const [clientId, setClientId] = useState('')
  const [scopes, setScopes] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  const load = useCallback(async () => {
    const bridge = window.opsDesktopUI
    if (!bridge?.getMcpOAuthStatus || !conn.url) return
    const s = readStoredOAuth(conn.id)
    setStored(s)
    setStatus(await bridge.getMcpOAuthStatus(oauthInput(conn, s.client_id, s.scopes)))
  }, [conn.id, conn.url])

  useEffect(() => {
    if (conn.transport !== 'http' || !conn.url) return
    void load()
  }, [conn.transport, conn.url, load])

  if (conn.transport !== 'http' || !conn.url) return null

  const start = async () => {
    if (!clientId.trim()) {
      setMessage('请填写 client_id（该服务器不支持动态注册时需要在服务方后台创建客户端）。')
      return
    }
    setBusy(true)
    setMessage('')
    writeStoredOAuth(conn.id, clientId.trim(), scopes.trim())
    const bridge = window.opsDesktopUI
    if (!bridge?.startMcpOAuth) {
      setMessage('需要 OPS Desktop 客户端：授权只在桌面端进行。')
      setBusy(false)
      return
    }
    const result = await bridge.startMcpOAuth(oauthInput(conn, clientId.trim(), scopes.trim()))
    setBusy(false)
    if (result.ok) {
      setShowForm(false)
      setMessage('')
    } else {
      setMessage(result.reason ? `授权未完成：${result.reason}` : '授权未完成。')
    }
    await load()
  }

  const revoke = async () => {
    setBusy(true)
    const bridge = window.opsDesktopUI
    if (!bridge?.revokeMcpOAuth) {
      setBusy(false)
      return
    }
    await bridge.revokeMcpOAuth(oauthInput(conn, stored.client_id, stored.scopes))
    setBusy(false)
    setMessage('')
    await load()
    onRevoked()
  }

  return <div className="mt-2 rounded-lg border border-mist-100 bg-mist-50/60 p-2.5" data-testid={`plugin-oauth-${conn.id}`}>
    <div className="flex items-center gap-2 text-xs">
      <KeyRound className="size-3.5 text-mist-500" />
      <span className="font-medium text-mist-700">OAuth 授权</span>
      {status
        ? <span className={status.state === 'authorized' ? 'text-emerald-700' : status.state === 'needs_reauth' ? 'text-gamboge-700' : 'text-mist-500'}>
          {oauthStateLabels[status.state] ?? status.state}
        </span>
        : <span className="text-mist-500">读取中…</span>}
      {busy && <Loader2 className="size-3.5 animate-spin text-mist-400" />}
      <span className="flex-1" />
      {status?.state === 'authorized' && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void revoke()}>撤销授权</Button>}
      {(status?.state === 'unauthorized' || status?.state === 'needs_reauth') && !showForm &&
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => { setClientId(stored.client_id); setScopes(stored.scopes); setShowForm(true) }}>
          {status.state === 'needs_reauth' ? '重新授权' : '开始授权'}
        </Button>}
      {status?.state === 'authorized' && status.expires_at &&
        <span className="text-mist-400">令牌到期 {new Date(status.expires_at).toLocaleString()}</span>}
    </div>
    {status?.state === 'needs_reauth' && !showForm &&
      <p className="mt-1 text-xs leading-relaxed text-gamboge-700">令牌缺失或已失效；重新授权后连接恢复，验证失败原因见上方错误行。</p>}
    {showForm && <div className="mt-2 space-y-2" data-testid="plugin-oauth-form">
      <label className="block">
        <span className="text-xs text-mist-600">client_id（必填；在 MCP 服务方后台创建，非秘密）</span>
        <input className="mt-1 w-full rounded-md border border-mist-200 px-3 py-2 text-[13px] font-mono" value={clientId}
          onChange={(e) => setClientId(e.target.value)} placeholder="例如：ops-desktop" />
      </label>
      <label className="block">
        <span className="text-xs text-mist-600">scopes（可选，空格分隔）</span>
        <input className="mt-1 w-full rounded-md border border-mist-200 px-3 py-2 text-[13px] font-mono" value={scopes}
          onChange={(e) => setScopes(e.target.value)} placeholder="例如：read:docs" />
      </label>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="primary" loading={busy} onClick={() => void start()}>在系统浏览器中授权</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setShowForm(false)}>取消</Button>
      </div>
      <p className="text-xs leading-relaxed text-mist-400">
        授权在系统浏览器完成，OPS 通过本机回环端口接收结果；令牌经系统加密保存在本机，不会上传。需要 client_secret 的服务器暂不支持（public client 路径）。
      </p>
    </div>}
    {message && <p className="mt-1.5 text-xs leading-relaxed text-gamboge-700" role="alert">{message}</p>}
  </div>
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

  // DEV-AI27-A3 第一片：验证连接 = 本机真实握手（McpHostManager）→ 目录/错误上报服务端。
  // 成功：目录字段落库，状态推进 ready_disabled；失败：last_error 如实上报（服务端不推进
  // 状态——"已验证"必须对应真实握手成功）。桌面端缺失时如实提示，不伪造已验证。
  const validate = async (conn: PluginConnection) => {
    setBusy(true)
    try {
      const bridge = window.opsDesktopUI
      if (!bridge?.validateMcpConnection) {
        setError('需要 OPS Desktop 客户端：MCP 连接只在本机验证（stdio 子进程与远程握手都在桌面端进行）。')
        return
      }
      const result = await bridge.validateMcpConnection({
        connection_id: conn.id,
        transport: conn.transport,
        command: conn.command,
        args: conn.args,
        cwd: conn.cwd,
        url: conn.url,
      })
      if (result.ok) {
        await api('POST', `/agent/plugin-connections/${conn.id}/actions`, {
          action: 'validate', expected_revision: conn.revision,
          protocol_version: result.catalog.server_info.protocol_version,
          server_name: result.catalog.server_info.name,
          server_version: result.catalog.server_info.version,
          catalog_revision: result.catalog.catalog_revision,
          tools_catalog: result.catalog.tools,
        })
      } else {
        await api('POST', `/agent/plugin-connections/${conn.id}/actions`, {
          action: 'validate', expected_revision: conn.revision,
          last_error: result.message.slice(0, 200),
        })
      }
      setError('')
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
      // A3 第二片：撤销连接前先清本机 OAuth 令牌（连接删除即令牌零残留）。
      const bridge = window.opsDesktopUI
      const conn = connections.find((item) => item.id === id)
      if (bridge?.revokeMcpOAuth && conn?.transport === 'http' && conn.url) {
        const stored = readStoredOAuth(id)
        await bridge.revokeMcpOAuth(oauthInput(conn, stored.client_id, stored.scopes))
      }
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
        {conn.state !== 'revoked' && <OAuthSection conn={conn} onRevoked={() => void reload()} />}
        <div className="mt-2 flex flex-wrap gap-2">
          {(conn.state === 'draft' || conn.state === 'error') &&
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void validate(conn)}>验证连接</Button>}
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
