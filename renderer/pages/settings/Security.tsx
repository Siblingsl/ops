import { useQuery } from '@tanstack/react-query'
import { KeyRound, Mail, Terminal } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Badge, Button, Card, CardHeader, Field, Input, Notice, PageHeader, Select } from '@/components/ui'
import { errorMessage, get, patch, post, put } from '@/lib/api'
import { fmtBytes, fmtTime, runeLen } from '@/lib/format'
import { useInvalidate, useMe, useSystemInfo } from '@/lib/session'
import type { AILimit, SMTPSettings } from '@/lib/types'
import { useSettingsDraft } from '@/lib/desktop-settings'

export default function Security({ section = 'all' }: { section?: 'all' | 'password' | 'smtp' }) {
  const { data: me } = useMe()
  const { data: sys } = useSystemInfo()
  const inv = useInvalidate()
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () => get<{ ai_limit: AILimit; smtp: SMTPSettings }>('/settings'),
    enabled: me?.role === 'owner' && section !== 'password',
  })
  const [old, setOld] = useState('')
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const [smtp, setSmtp] = useState({ host: '', port: '587', username: '', from: '', password: '' })
  const savedSMTP = settings.data?.smtp
  const smtpDirty = !!smtp.password || !!savedSMTP && (smtp.host !== (savedSMTP.host || '') || smtp.port !== String(savedSMTP.port || 587) || smtp.username !== (savedSMTP.username || '') || smtp.from !== (savedSMTP.from || ''))
  useSettingsDraft(section === 'smtp' ? smtpDirty : !!(old || pw || pw2), busy)
  useEffect(() => {
    const s = settings.data?.smtp
    if (!s) return
    setSmtp((prev) => ({
      ...prev,
      host: s.host || '',
      port: String(s.port || 587),
      username: s.username || '',
      from: s.from || '',
    }))
  }, [settings.data])
  const short = pw.length > 0 && runeLen(pw) < 12
  const mismatch = pw2.length > 0 && pw !== pw2
  const submit = async () => {
    setBusy(true)
    try {
      await put('/auth/password', { old_password: old, new_password: pw })
      toast.success('密码已修改，其他设备上的登录已失效')
      setOld('')
      setPw('')
      setPw2('')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="mx-auto max-w-2xl animate-fade-in space-y-6">
      <PageHeader title={section === 'smtp' ? '邀请邮件' : '登录与安全'} />
      {me?.role === 'owner' && <MCPTokenCard />}
      {me?.role === 'owner' && <BrowserPolicyCard />}
      {section !== 'smtp' && me?.prev_login_at && (
        <Notice tone="ink">上次登录：{fmtTime(me.prev_login_at, true)}{me.prev_login_ip && `，IP ${me.prev_login_ip}`}。如果不是你本人，请立即修改密码。</Notice>
      )}
      {section !== 'smtp' && <Card>
        <CardHeader title="修改登录密码" desc="修改后，除当前会话外的所有登录都会失效。" />
        <div className="space-y-4 p-5">
          <Field label="当前密码"><Input type="password" value={old} onChange={(e) => setOld(e.target.value)} autoComplete="current-password" /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="新密码" error={short ? '至少 12 位' : undefined}><Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" invalid={short} /></Field>
            <Field label="再输入一次" error={mismatch ? '两次输入不一致' : undefined}><Input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" invalid={mismatch} /></Field>
          </div>
          <Button variant="primary" loading={busy} disabled={!old || runeLen(pw) < 12 || pw !== pw2} onClick={submit} icon={<KeyRound className="size-4" />}>修改密码</Button>
        </div>
      </Card>}
      {section !== 'password' && me?.role === 'owner' && (
        <Card>
          <CardHeader title="邀请邮件 SMTP" desc="配置后可在「成员与邀请」里把邀请码发到邮箱。密码加密存储；留空则保留原密码。" />
          <div className="space-y-4 p-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="SMTP 主机"><Input value={smtp.host} onChange={(e) => setSmtp({ ...smtp, host: e.target.value })} placeholder="smtp.example.com" /></Field>
              <Field label="端口"><Input value={smtp.port} onChange={(e) => setSmtp({ ...smtp, port: e.target.value })} placeholder="587" /></Field>
              <Field label="用户名"><Input value={smtp.username} onChange={(e) => setSmtp({ ...smtp, username: e.target.value })} /></Field>
              <Field label="发件人 From"><Input value={smtp.from} onChange={(e) => setSmtp({ ...smtp, from: e.target.value })} placeholder="ops@example.com" /></Field>
              <Field label="密码" className="sm:col-span-2">
                <Input type="password" value={smtp.password} onChange={(e) => setSmtp({ ...smtp, password: e.target.value })} placeholder={settings.data?.smtp?.has_password ? '已配置，留空不改' : 'SMTP 密码'} />
              </Field>
            </div>
            <Button
              variant="primary"
              icon={<Mail className="size-4" />}
              loading={busy}
              onClick={async () => {
                setBusy(true)
                try {
                  await put('/settings', {
                    smtp: {
                      host: smtp.host.trim(),
                      port: Number(smtp.port) || 587,
                      username: smtp.username.trim(),
                      from: smtp.from.trim(),
                      password: smtp.password,
                    },
                  })
                  toast.success('SMTP 已保存')
                  setSmtp((s) => ({ ...s, password: '' }))
                  await inv(['settings'])
                } catch (e) {
                  toast.error(errorMessage(e))
                } finally {
                  setBusy(false)
                }
              }}
            >
              保存 SMTP
            </Button>
          </div>
        </Card>
      )}
      {section === 'smtp' && me?.role !== 'owner' && <Notice>邀请邮件配置仅工作区所有者可查看与修改。</Notice>}
      {section === 'password' && <Notice>忘记密码时请联系服务管理员重置。修改密码会使其他设备上的登录失效。</Notice>}
      {section === 'all' && <Card>
        <CardHeader title="忘记密码" />
        <div className="space-y-3 p-5 text-[13.5px] leading-relaxed text-mist-600">
          <p>界面不提供「忘记密码」。忘记时在服务器上按用户名重置：</p>
          <pre className="flex items-center gap-2 overflow-x-auto rounded-lg bg-mist-900 px-4 py-3 font-mono text-[13px] text-mist-100"><Terminal className="size-4 shrink-0 text-mist-400" />docker compose exec app ops reset-password &lt;username&gt;</pre>
          <p className="text-xs text-mist-400">本地：<code className="rounded bg-mist-100 px-1">go run ./cmd/ops reset-password &lt;username&gt;</code>。重置后该用户所有登录失效。</p>
        </div>
      </Card>}
      {section === 'all' && sys && (
        <Card className="p-5 text-[13px] text-mist-600">
          <div className="grid gap-2 sm:grid-cols-3">
            <div><span className="text-mist-400">版本 </span>{sys.version}</div>
            <div><span className="text-mist-400">数据占用 </span>{fmtBytes(sys.data_bytes)}</div>
            <div><span className="text-mist-400">运行模式 </span>{sys.dev ? '本地开发（模拟接口）' : '生产'}</div>
          </div>
        </Card>
      )}
    </div>
  )
}

// REF41 E2-N1：MCP token 管理（创建只显示一次明文；列表无明文/哈希；撤销立即生效）。
type MCPTokenRow = { id: string; name: string; scopes: string[]; status: 'active' | 'revoked'; created_at: string; last_used_at?: string | null }

function MCPTokenCard() {
  const inv = useInvalidate()
  const tokens = useQuery({
    queryKey: ['mcp-tokens'],
    queryFn: () => get<{ tokens: MCPTokenRow[] }>('/mcp/tokens'),
  })
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<string[]>(['read:topics'])
  const [plain, setPlain] = useState('')
  const [busy, setBusy] = useState(false)
  const scopeOptions = [
    { id: 'read:topics', label: '选题（read:topics）' },
    { id: 'read:works', label: '作品（read:works）' },
    { id: 'read:reviews', label: '复盘（read:reviews）' },
    { id: 'read:metrics', label: '指标（read:metrics）' },
    { id: 'read:benchmark', label: '竞对（read:benchmark）' },
  ]
  const create = async () => {
    setBusy(true)
    try {
      const result = await post<{ token: string }>('/mcp/tokens', { name: name.trim(), scopes })
      setPlain(result.token)
      setName('')
      inv(['mcp-tokens'])
    } catch (error) {
      toast.error(errorMessage(error) || '创建失败')
    } finally {
      setBusy(false)
    }
  }
  return <Card data-testid="mcp-token-card">
    <CardHeader title="MCP 外部客户端令牌" desc="按工作区签发、只读 scope；明文仅在创建时显示一次，服务端只存哈希。撤销立即生效。" />
    <div className="space-y-4 p-5">
      {plain && <Notice tone="ink" data-testid="mcp-token-plain">
        新令牌（只显示这一次，请立即复制）：<code className="break-all">{plain}</code>
        <Button size="sm" variant="ghost" className="ml-2" onClick={() => setPlain('')}>我已保存</Button>
      </Notice>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="名称"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="外部看板 / 自动化脚本" maxLength={60} /></Field>
        <Field label="scope（至少一项）">
          <div className="flex flex-wrap gap-2">
            {scopeOptions.map((option) => <label key={option.id} className="inline-flex items-center gap-1 text-xs text-mist-700">
              <input type="checkbox" checked={scopes.includes(option.id)} onChange={(e) => setScopes((old) => e.target.checked ? [...old, option.id] : old.filter((id) => id !== option.id))} />{option.label}
            </label>)}
          </div>
        </Field>
      </div>
      <Button variant="primary" loading={busy} disabled={!name.trim() || scopes.length === 0} onClick={create}>创建令牌</Button>
      <div className="space-y-2" data-testid="mcp-token-list">
        {(tokens.data?.tokens ?? []).map((token) => <div key={token.id} className="flex items-center justify-between gap-2 rounded border border-mist-200 px-3 py-2 text-xs">
          <span className="font-medium text-mist-800">{token.name}</span>
          <span className="text-mist-500">{token.scopes.join('、')}</span>
          <Badge tone={token.status === 'active' ? 'green' : 'gray'}>{token.status === 'active' ? '启用' : '已撤销'}</Badge>
          <span className="text-mist-400">{token.last_used_at ? `最近使用 ${fmtTime(token.last_used_at, true)}` : '未使用'}</span>
          {token.status === 'active' && <button type="button" className="underline text-red-600"
            onClick={async () => {
              try {
                const { del } = await import('@/lib/api')
                await del(`/mcp/tokens/${token.id}`)
                toast.success('已撤销，立即生效')
                inv(['mcp-tokens'])
              } catch (error) {
                toast.error(errorMessage(error) || '撤销失败')
              }
            }}>撤销</button>}
        </div>)}
        {(tokens.data?.tokens ?? []).length === 0 && <p className="text-xs text-mist-500">还没有令牌。</p>}
      </div>
    </div>
  </Card>
}

// REF41 F5-N1：浏览器任务策略卡——策略列表/创建/续期/停用；全站模式拒绝；
// 过期即时失效（服务端 expires_at 判定 + browserPolicyExpireJob 归档）。
type BrowserPolicy = {
  id: string
  account_id?: string | null
  purpose: string
  url_patterns: string[]
  allowed_actions: string[]
  expires_at: string
  status: 'active' | 'disabled' | 'expired'
  created_at: string
}

const POLICY_PURPOSES = ['publish_fill', 'publish_health', 'publish_patrol', 'benchmark_observe', 'followers']
const POLICY_LABELS: Record<string, string> = {
  publish_fill: '发布填写',
  publish_health: '发布体检',
  publish_patrol: '发布巡检',
  benchmark_observe: '竞对采集',
  followers: '粉丝数据',
}

function BrowserPolicyCard() {
  const inv = useInvalidate()
  const policies = useQuery({
    queryKey: ['browser-task-policies'],
    queryFn: () => get<{ policies: BrowserPolicy[] }>('/browser-task-policies'),
  })
  const [purpose, setPurpose] = useState('publish_health')
  const [patterns, setPatterns] = useState('')
  const [minutes, setMinutes] = useState('60')
  const [busy, setBusy] = useState(false)
  const create = async () => {
    setBusy(true)
    try {
      await post('/browser-task-policies', {
        purpose,
        url_patterns: patterns.split("\n").map((line) => line.trim()).filter(Boolean),
        expires_in_minutes: Number(minutes) || 60,
      })
      toast.success('策略已创建')
      setPatterns('')
      inv(['browser-task-policies'])
    } catch (error) {
      toast.error(errorMessage(error) || '创建失败')
    } finally {
      setBusy(false)
    }
  }
  const setStatus = async (id: string, status: 'active' | 'disabled') => {
    try {
      await patch(`/browser-task-policies/${id}`, { status })
      inv(['browser-task-policies'])
    } catch (error) {
      toast.error(errorMessage(error) || '操作失败')
    }
  }
  const renew = async (id: string) => {
    try {
      await post(`/browser-task-policies/${id}/renew`, { expires_in_minutes: Number(minutes) || 60 })
      toast.success('已续期（从现在起 ≤48 小时）')
      inv(['browser-task-policies'])
    } catch (error) {
      toast.error(errorMessage(error) || '续期失败')
    }
  }
  return <Card data-testid="browser-policy-card">
    <CardHeader title="浏览器任务策略" desc="三道闸：策略存在未过期、URL 命中白名单、账号匹配且单标签页。URL 模式必须限定域名+路径前缀（不允许全站通配）；有效期最长 48 小时，不自动续期。" />
    <div className="space-y-4 p-5">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="目的">
          <Select value={purpose} onChange={(e) => setPurpose(e.target.value)}>
            {POLICY_PURPOSES.map((item) => <option key={item} value={item}>{POLICY_LABELS[item]}</option>)}
          </Select>
        </Field>
        <Field label="有效期（分钟，≤2880）"><Input value={minutes} onChange={(e) => setMinutes(e.target.value)} /></Field>
        <Field label="URL 模式（每行一条，https://域名/路径前缀）">
          <textarea className="w-full rounded border border-mist-200 p-2 text-xs" rows={3} value={patterns}
            onChange={(e) => setPatterns(e.target.value)} placeholder={"https://mp.weixin.qq.com/cgi-bin/home\nhttps://www.xiaohongshu.com/user/profile"} />
        </Field>
      </div>
      <Button variant="primary" loading={busy} disabled={!patterns.trim()} onClick={create} data-testid="browser-policy-create">创建策略</Button>
      <div className="space-y-2" data-testid="browser-policy-list">
        {(policies.data?.policies ?? []).map((policy) => <div key={policy.id} className="rounded border border-mist-200 px-3 py-2 text-xs" data-testid={`browser-policy-${policy.id}`}>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={policy.status === 'active' ? 'green' : policy.status === 'expired' ? 'gray' : 'gamboge'}>{policy.status === 'active' ? '生效' : policy.status === 'expired' ? '已过期' : '已停用'}</Badge>
            <span className="font-medium text-mist-800">{POLICY_LABELS[policy.purpose] ?? policy.purpose}</span>
            <span className="text-mist-400">到期 {policy.expires_at.slice(0, 19).replace('T', ' ')}</span>
            {policy.status === 'active' && <>
              <button type="button" className="underline" onClick={() => void renew(policy.id)}>续期</button>
              <button type="button" className="underline text-red-600" onClick={() => void setStatus(policy.id, 'disabled')}>停用</button>
            </>}
            {policy.status === 'disabled' && <button type="button" className="underline" onClick={() => void setStatus(policy.id, 'active')}>启用</button>}
          </div>
          <p className="mt-1 break-all text-mist-500">{policy.url_patterns.join('；')}</p>
        </div>)}
        {(policies.data?.policies ?? []).length === 0 && <p className="text-xs text-mist-500">还没有策略。没有生效策略时对应目的的浏览器任务会被拒绝。</p>}
      </div>
    </div>
  </Card>
}
