import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Button, Field, Input } from '@/components/ui'
import { errorMessage, get, post, setCsrf } from '@/lib/api'
import { runeLen } from '@/lib/format'
import type { Me } from '@/lib/types'
import { AuthFrame } from './Login'

function PasswordStep({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState('')
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const short = pw.length > 0 && runeLen(pw) < 12
  const mismatch = pw2.length > 0 && pw !== pw2
  const submit = async () => {
    setBusy(true)
    try {
      await post('/auth/setup', { username: username.trim(), password: pw })
      const me = await get<Me>('/auth/me')
      setCsrf(me.csrf_token)
      onDone()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-4">
      <Field label="用户名"><Input autoFocus value={username} onChange={(e) => setUsername(e.target.value)} /></Field>
      <Field label="登录密码" error={short ? '密码至少需要 12 位' : undefined} hint="至少 12 位。系统只有你一个用户，忘记密码需要在服务器上执行重置命令。">
        <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" invalid={short} />
      </Field>
      <Field label="再输入一次" error={mismatch ? '两次输入不一致' : undefined}>
        <Input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" invalid={mismatch} />
      </Field>
      <Button variant="primary" size="lg" className="w-full" loading={busy} disabled={!username.trim() || runeLen(pw) < 12 || pw !== pw2} onClick={submit}>
        创建账号并进入
      </Button>
      <p className="text-center text-[12.5px] leading-relaxed text-mist-400">
        平台账号、公众号凭证、定位档案、风格样本和模型，登录后在设置与账号档案中配置。
      </p>
    </div>
  )
}

export default function Setup() {
  const nav = useNavigate()
  const qc = useQueryClient()
  const status = useQuery({ queryKey: ['auth-status'], queryFn: () => get<{ needs_setup: boolean }>('/auth/status') })
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => get<Me>('/auth/me'),
    retry: false,
    enabled: status.data?.needs_setup === false,
  })

  useEffect(() => {
    if (status.data?.needs_setup === false) {
      if (me.isError) nav('/login', { replace: true })
      else if (me.data) nav('/', { replace: true })
    }
  }, [status.data, me.data, me.isError, nav])

  if (status.isLoading || (status.data?.needs_setup === false && me.isLoading)) {
    return <div className="flex h-full items-center justify-center paper" />
  }

  return (
    <AuthFrame>
      <div className="w-full max-w-[400px] animate-fade-in">
        <div className="mb-1 text-xs font-medium text-ink-600">首次使用</div>
        <h1 className="mb-2 font-display text-[26px] font-bold text-mist-900">设置登录账号</h1>
        <p className="mb-6 text-sm leading-relaxed text-mist-500">
          只需创建用户名和密码。其余配置在登录后完成，可随时跳过或后补。
        </p>
        <PasswordStep onDone={async () => {
          await qc.invalidateQueries()
          nav('/settings/accounts?new=1', { replace: true })
        }} />
      </div>
    </AuthFrame>
  )
}
