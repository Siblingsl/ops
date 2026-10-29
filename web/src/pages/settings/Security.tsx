import { useQuery } from '@tanstack/react-query'
import { KeyRound, Mail, Terminal } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button, Card, CardHeader, Field, Input, Notice, PageHeader } from '@/components/ui'
import { errorMessage, get, put } from '@/lib/api'
import { fmtBytes, fmtTime, runeLen } from '@/lib/format'
import { useInvalidate, useMe, useSystemInfo } from '@/lib/session'
import type { AILimit, SMTPSettings } from '@/lib/types'

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
