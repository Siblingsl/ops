import { KeyRound, Terminal } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button, Card, CardHeader, Field, Input, Notice, PageHeader } from '@/components/ui'
import { errorMessage, put } from '@/lib/api'
import { fmtBytes, fmtTime, runeLen } from '@/lib/format'
import { useMe, useSystemInfo } from '@/lib/session'

export default function Security() {
  const { data: me } = useMe()
  const { data: sys } = useSystemInfo()
  const [old, setOld] = useState('')
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)
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
      <PageHeader title="登录与安全" />
      {me?.prev_login_at && (
        <Notice tone="ink">上次登录：{fmtTime(me.prev_login_at, true)}{me.prev_login_ip && `，IP ${me.prev_login_ip}`}。如果不是你本人，请立即修改密码。</Notice>
      )}
      <Card>
        <CardHeader title="修改登录密码" desc="修改后，除当前会话外的所有登录都会失效。" />
        <div className="space-y-4 p-5">
          <Field label="当前密码"><Input type="password" value={old} onChange={(e) => setOld(e.target.value)} autoComplete="current-password" /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="新密码" error={short ? '至少 12 位' : undefined}><Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" invalid={short} /></Field>
            <Field label="再输入一次" error={mismatch ? '两次输入不一致' : undefined}><Input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" invalid={mismatch} /></Field>
          </div>
          <Button variant="primary" loading={busy} disabled={!old || runeLen(pw) < 12 || pw !== pw2} onClick={submit} icon={<KeyRound className="size-4" />}>修改密码</Button>
        </div>
      </Card>
      <Card>
        <CardHeader title="忘记密码" />
        <div className="space-y-3 p-5 text-[13.5px] leading-relaxed text-mist-600">
          <p>系统只有你一个用户，没有邮件找回。忘记密码时，在服务器上执行下面的命令，按提示输入两次新密码：</p>
          <pre className="flex items-center gap-2 overflow-x-auto rounded-lg bg-mist-900 px-4 py-3 font-mono text-[13px] text-mist-100"><Terminal className="size-4 shrink-0 text-mist-400" />docker compose exec app ops reset-password</pre>
          <p className="text-xs text-mist-400">本地开发时执行 <code className="rounded bg-mist-100 px-1">go run ./cmd/ops reset-password</code>。重置后所有登录失效，并记录在操作日志中。</p>
        </div>
      </Card>
      {sys && (
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
