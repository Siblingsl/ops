import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Button, Field, Input, Notice } from '@/components/ui'
import { ApiError, post } from '@/lib/api'
import { AuthFrame } from './Login'

export default function Register() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [invite, setInvite] = useState('')
  const [error, setError] = useState<ApiError | null>(null)
  const [busy, setBusy] = useState(false)
  const nav = useNavigate()
  const qc = useQueryClient()

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await post('/auth/register', {
        username,
        password,
        invite_code: invite.trim() || undefined,
      })
      await qc.invalidateQueries()
      nav('/settings/accounts?new=1', { replace: true })
    } catch (err) {
      setError(err as ApiError)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthFrame>
      <form onSubmit={submit} className="w-full max-w-[360px] animate-fade-in">
        <h1 className="font-display text-[28px] font-bold text-mist-900">注册</h1>
        <p className="mt-1.5 text-sm text-mist-500">创建账号后会自动创建你的工作区。有邀请码可一并填入。</p>
        <div className="mt-8 space-y-4">
          <Field label="用户名">
            <Input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} className="h-10" />
          </Field>
          <Field label="密码（至少 12 位）">
            <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className="h-10" />
          </Field>
          <Field label="邀请码（可选）">
            <Input value={invite} onChange={(e) => setInvite(e.target.value.toUpperCase())} className="h-10 font-mono tracking-wider" placeholder="加入他人工作区" />
          </Field>
          {error && <Notice tone="red">{error.message}</Notice>}
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} disabled={!username || password.length < 12}>
            创建账号
          </Button>
          <p className="text-center text-sm text-mist-500">
            已有账号？{' '}
            <Link to="/login" className="font-medium text-ink-600 hover:underline">去登录</Link>
          </p>
        </div>
      </form>
    </AuthFrame>
  )
}
