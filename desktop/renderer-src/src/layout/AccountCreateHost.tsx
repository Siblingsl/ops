import { AccountCreateForm } from '@/components/account-forms'
import { Dialog } from '@/components/dialog'
import { toast } from 'sonner'
import { releaseDesktopLeaveGuard, requestDesktopLeaveGuard } from '@/lib/desktop-settings'
import { useMe } from '@/lib/session'
import type { Account, Platform } from '@/lib/types'
import { useState } from 'react'

export default function AccountCreateHost({ platform, expectedContext, onClose, onCreated }: {
  platform: Platform | null
  expectedContext: { userId: string; workspaceId: string } | null
  onClose: () => void
  onCreated: (account: Account) => void
}) {
  const { data: me } = useMe()
  const [busy, setBusy] = useState(false)
  const close = () => {
    if (busy) { toast.info('账号创建正在提交，请稍候再关闭。'); return }
    onClose()
  }
  const beforeSubmit = async () => {
    if (expectedContext && me?.workspace.id === expectedContext.workspaceId && (me.user_id ?? me.username) === expectedContext.userId) {
      return requestDesktopLeaveGuard(true)
    }
    toast.error('登录用户或工作区已变化，请关闭窗口后重新打开。')
    return false
  }

  return (
    <Dialog open={!!platform} onClose={close} title="添加平台账号" width="max-w-lg">
      {platform && <AccountCreateForm
        key={platform}
        defaultPlatform={platform}
        fixedPlatform
        beforeSubmit={beforeSubmit}
        onSubmitFinished={(success) => { if (!success) releaseDesktopLeaveGuard() }}
        onBusyChange={setBusy}
        onCreated={onCreated}
      />}
    </Dialog>
  )
}
