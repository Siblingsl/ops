import { GitBranch } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Dialog } from '@/components/dialog'
import { Button, cn, formatLabel, Notice, PlatformMark } from '@/components/ui'
import { errorMessage, post } from '@/lib/api'
import { useAccounts } from '@/lib/session'
import type { ContentFormat, Platform, Work } from '@/lib/types'

const textual: ContentFormat[] = ['long_article', 'image_note']

export function DeriveDialog({ open, onClose, workId, platform, format }: { open: boolean; onClose: () => void; workId: string; platform: Platform; format: ContentFormat }) {
  const { data: accounts } = useAccounts()
  const [target, setTarget] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const nav = useNavigate()
  const options = (accounts ?? []).filter((a) => a.status === 'active' && a.platform !== platform)
  const allowed = (f: ContentFormat) => textual.includes(format) && textual.includes(f)
  const go = async () => {
    setBusy(true)
    try {
      const w = await post<Work>(`/works/${workId}/derive`, { target_account_id: target })
      toast.success('已创建衍生作品，接下来逐段改写')
      onClose()
      nav(`/works/${w.id}/compare`)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onClose={onClose} title="派生到其他平台" desc="系统先规划段落对应关系，然后由你逐段改写，原作品不受影响。"
      footer={<><Button variant="ghost" onClick={onClose}>取消</Button><Button variant="primary" loading={busy} disabled={!target} onClick={go} icon={<GitBranch className="size-4" />}>开始派生</Button></>}>
      {options.length === 0 ? (
        <Notice tone="gamboge">没有可派生的目标账号。派生只能在不同平台之间进行（同平台派生容易造成同质内容），请先添加另一个平台的账号。</Notice>
      ) : (
        <div className="space-y-2">
          {options.map((a) => {
            const ok = allowed(a.content_format)
            return (
              <button key={a.id} disabled={!ok} onClick={() => setTarget(a.id)}
                className={cn('flex w-full cursor-pointer items-center gap-3 rounded-xl border p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-50',
                  target === a.id ? 'border-ink-400 bg-ink-50/60 ring-3 ring-ink-100' : 'border-mist-200 hover:border-mist-300')}>
                <PlatformMark platform={a.platform} />
                <div className="flex-1">
                  <div className="text-sm font-medium text-mist-900">{a.name}</div>
                  <div className="text-xs text-mist-500">{formatLabel[a.content_format]}{!ok && ' · 内容形态不支持派生'}</div>
                </div>
              </button>
            )
          })}
        </div>
      )}
    </Dialog>
  )
}
