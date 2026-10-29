import { useState } from 'react'
import { KeyRound, LogIn } from 'lucide-react'
import { toast } from 'sonner'
import { Button, Input, cn } from '@/components/ui'
import { Dialog } from '@/components/dialog'
import { post, errorMessage } from '@/lib/api'
import { fmtTime } from '@/lib/format'
import { flushWork } from '@/pages/work/work-save'

/**
 * GL-06：为即将到期的会话提供两个明确出口。
 * - 立即续期：显式输入密码，当前 session 的固定期限重置为 7 天；
 * - 保存并重新登录：先 flush 当前作品，再注销并回到带 next 的登录页。
 * `/auth/reauth` 仍只负责 5 分钟敏感操作确认，不在这里复用。
 */
export function SessionExpiryBanner({
  expiresAt,
  onRenewed,
  onBeforeLogout,
  onLogoutFailure,
}: {
  expiresAt: string
  onRenewed: () => void
  onBeforeLogout?: () => Promise<boolean>
  onLogoutFailure?: () => void
}) {
  const [renewOpen, setRenewOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [logoutBusy, setLogoutBusy] = useState(false)
  const [error, setError] = useState('')
  const [logoutError, setLogoutError] = useState('')
  const remaining = Date.parse(expiresAt) - Date.now()
  const urgent = remaining > 0 && remaining <= 60 * 60 * 1000

  const renew = async () => {
    setBusy(true)
    setError('')
    try {
      await post('/auth/renew', { password })
      setRenewOpen(false)
      setPassword('')
      toast.success('会话已续期 7 天。')
      onRenewed()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const saveAndLogin = async () => {
    setLogoutBusy(true)
    setLogoutError('')
    try {
      if (onBeforeLogout && !(await onBeforeLogout())) return
      const workId = window.location.pathname.match(/^\/works\/([^/?#]+)/)?.[1]
      if (workId) await flushWork(workId)
      await post('/auth/logout')
      const next = window.location.pathname + window.location.search + window.location.hash
      window.location.assign('/login?next=' + encodeURIComponent(next))
    } catch (e) {
      onLogoutFailure?.()
      setLogoutError(`保存或退出失败，请处理后重试：${errorMessage(e)}`)
    } finally {
      setLogoutBusy(false)
    }
  }

  return (
    <>
      <div role="status" className={cn('flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-gamboge-200 bg-gamboge-50 px-4 py-2 text-center text-[12.5px] text-gamboge-800')}>
        <span>{urgent ? '会话将在 1 小时内到期，请先保存内容。' : `会话将于 ${fmtTime(expiresAt, true)} 到期，请先保存内容。`}</span>
        <Button variant="ghost" size="sm" className="h-6 px-2 text-[12px] text-gamboge-900" icon={<KeyRound className="size-3.5" />} onClick={() => { setError(''); setRenewOpen(true) }}>立即续期</Button>
        <Button variant="ghost" size="sm" loading={logoutBusy} className="h-6 px-2 text-[12px] text-gamboge-900" icon={<LogIn className="size-3.5" />} onClick={() => void saveAndLogin()}>保存并重新登录</Button>
        {logoutError && <span role="alert" className="w-full text-danger">{logoutError}</span>}
      </div>
      {renewOpen && (
        <Dialog open onClose={() => setRenewOpen(false)} title="续期当前会话" width="max-w-sm"
          footer={<>
            <Button variant="ghost" onClick={() => setRenewOpen(false)}>取消</Button>
            <Button variant="primary" loading={busy} onClick={() => void renew()} disabled={!password}>续期 7 天</Button>
          </>}>
          <p className="mb-3 text-[13px] leading-relaxed text-mist-500">输入登录密码后，会话有效期将从现在起延长 7 天。此操作也会确认你本人身份。</p>
          <Input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !busy && password) void renew() }} placeholder="登录密码" invalid={!!error} />
          {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
        </Dialog>
      )}
    </>
  )
}
