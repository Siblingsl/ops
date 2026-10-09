import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Button, Field, Input, Notice } from '@/components/ui'
import { ApiError, get, post } from '@/lib/api'

export function AuthFrame({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="flex min-h-full">
      <div className="paper relative hidden w-[46%] flex-col justify-between overflow-hidden border-r border-mist-200 p-12 lg:flex">
        <div className="flex items-center gap-2.5">
          <div className="flex size-9 items-center justify-center rounded-xl bg-ink-600 text-white">
            <svg viewBox="0 0 32 32" className="size-6"><path d="M9 22V10h6.5a4.5 4.5 0 010 9H12" stroke="currentColor" strokeWidth="2.6" fill="none" strokeLinecap="round" /><circle cx="22.5" cy="21.5" r="2.6" fill="#E0A526" /></svg>
          </div>
          <span className="font-display text-lg font-bold text-mist-900">内容运营助手</span>
        </div>
        <div className="relative max-w-md">
          <p className="font-display text-[40px] font-bold leading-[1.25] text-mist-900">
            观点是你的，<br />
            <span className="text-ink-600">文字一起打磨。</span>
          </p>
          <p className="mt-5 text-[15px] leading-relaxed text-mist-600">
            从选题、起稿到两个平台的改写与发布前检查，AI 只做辅助。每一个关键决定——观点、大纲、检查确认、推送和发布——都由你来按下。
          </p>
          {aside}
        </div>
        <div className="flex items-center gap-4 text-xs text-mist-400">
          <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-wechat" />公众号</span>
          <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-xhs" />小红书</span>
          <span>只使用官方接口</span>
        </div>
      </div>
      <div className="flex flex-1 items-center justify-center bg-white px-6 py-12">{children}</div>
    </div>
  )
}

export default function Login() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<ApiError | null>(null)
  const [busy, setBusy] = useState(false)
  const nav = useNavigate()
  const [params] = useSearchParams()
  const qc = useQueryClient()

  useEffect(() => {
    get<{ needs_setup: boolean }>('/auth/status').then((s) => s.needs_setup && nav('/setup', { replace: true })).catch(() => undefined)
  }, [nav])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await post('/auth/login', { username, password })
      await qc.invalidateQueries()
      nav(params.get('next') || '/', { replace: true })
    } catch (err) {
      setError(err as ApiError)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthFrame>
      <form onSubmit={submit} className="w-full max-w-[360px] animate-fade-in">
        <h1 className="font-display text-[28px] font-bold text-mist-900">登录</h1>
        <p className="mt-1.5 text-sm text-mist-500">欢迎回来，继续今天的写作。</p>
        <div className="mt-8 space-y-4">
          <Field label="用户名">
            <Input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} className="h-10" />
          </Field>
          <Field label="密码">
            <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className="h-10" />
          </Field>
          {error && (
            <Notice tone="red">
              {error.message}
              {error.code === 'login_locked' && (
                <div className="mt-1.5 text-xs">
                  在服务器上执行 <code className="rounded bg-white/70 px-1 font-mono">docker compose exec app ops reset-password</code> 可以重置密码。
                </div>
              )}
            </Notice>
          )}
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} disabled={!username || !password}>
            登录
          </Button>
          <p className="text-center text-xs text-mist-400">忘记密码？这是单用户系统，请在服务器上执行重置命令（见部署文档）。</p>
        </div>
      </form>
    </AuthFrame>
  )
}
