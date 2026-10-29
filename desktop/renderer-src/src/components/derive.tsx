import { GitBranch } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Dialog } from '@/components/dialog'
import { Button, cn, formatLabel, Notice, PlatformMark, Select } from '@/components/ui'
import { errorMessage, post } from '@/lib/api'
import { useAccounts } from '@/lib/session'
import type { ContentFormat, Platform, Work } from '@/lib/types'

function allowedTargets(sourcePlatform: Platform, sourceFormat: ContentFormat, targetPlatform: Platform): ContentFormat[] {
  if (sourcePlatform === targetPlatform) return []
  if (sourceFormat === 'comic' && (sourcePlatform === 'wechat_mp' || sourcePlatform === 'xhs') && targetPlatform !== 'toutiao') return ['comic']
  if (sourcePlatform === 'wechat_mp' && sourceFormat === 'long_article' && targetPlatform === 'xhs') return ['image_note']
  if (sourcePlatform === 'xhs' && sourceFormat === 'image_note' && targetPlatform === 'wechat_mp') return ['long_article']
  if ((sourcePlatform === 'wechat_mp' && sourceFormat === 'long_article' || sourcePlatform === 'xhs' && sourceFormat === 'image_note') && targetPlatform === 'toutiao') return ['long_article', 'micro_post']
  if (sourcePlatform === 'toutiao' && sourceFormat === 'long_article' && targetPlatform === 'wechat_mp') return ['long_article']
  if (sourcePlatform === 'toutiao' && sourceFormat === 'long_article' && targetPlatform === 'xhs') return ['image_note']
  return []
}

const formatName = (format: ContentFormat) => format === 'micro_post' ? '微头条' : formatLabel[format]

export function DeriveDialog({ open, onClose, workId, platform, format }: { open: boolean; onClose: () => void; workId: string; platform: Platform; format: ContentFormat }) {
  const { data: accounts } = useAccounts()
  const [target, setTarget] = useState<string>('')
  const [targetFormat, setTargetFormat] = useState<ContentFormat>('long_article')
  const [busy, setBusy] = useState(false)
  const nav = useNavigate()
  const options = (accounts ?? []).filter((a) => a.status === 'active' && a.platform !== platform).map((a) => ({
    account: a,
    formats: allowedTargets(platform, format, a.platform),
  }))
  const comic = format === 'comic'
  const selected = options.find((option) => option.account.id === target)
  const selectTarget = (accountId: string) => {
    const option = options.find((item) => item.account.id === accountId)
    if (!option) return
    setTarget(accountId)
    const preferred = option.account.content_format
    setTargetFormat(option.formats.includes(preferred) ? preferred : option.formats[0] ?? 'long_article')
  }
  const go = async () => {
    setBusy(true)
    try {
      const body: { target_account_id: string; target_content_format?: ContentFormat } = { target_account_id: target }
      if (selected?.account.platform === 'toutiao') body.target_content_format = targetFormat
      const w = await post<Work>(`/works/${workId}/derive`, body)
      toast.success(comic ? '已创建衍生漫画，分格与图片已复用，旁白对白已按目标平台改写' : `已创建${selected ? formatName(selected.account.platform === 'toutiao' ? targetFormat : selected.account.content_format) : '衍生'}作品，接下来逐段改写`)
      onClose()
      nav(comic ? `/works/${w.id}` : `/works/${w.id}/compare`)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onClose={onClose} title="派生到其他平台"
      desc={comic ? '复用分格、角色引用和图片，只改写旁白与对白的平台表达；原作品不受影响。' : '系统先规划段落对应关系，然后由你逐段改写，原作品不受影响。'}
      footer={<><Button variant="ghost" onClick={onClose}>取消</Button><Button variant="primary" loading={busy} disabled={!target} onClick={go} icon={<GitBranch className="size-4" />}>开始派生</Button></>}>
      {options.length === 0 ? (
        <Notice tone="gamboge">没有可派生的目标账号。派生只能在不同平台之间进行（同平台派生容易造成同质内容），请先添加另一个平台的账号。</Notice>
      ) : (
        <div className="space-y-2">
          {options.map(({ account: a, formats }) => {
            const ok = formats.length > 0
            return (
              <div key={a.id} className={cn('rounded-xl border transition', target === a.id ? 'border-ink-400 bg-ink-50/40 ring-3 ring-ink-100' : 'border-mist-200', !ok && 'opacity-55')}>
                <button type="button" disabled={!ok} onClick={() => selectTarget(a.id)}
                  className="flex w-full cursor-pointer items-center gap-3 p-3 text-left disabled:cursor-not-allowed">
                  <PlatformMark platform={a.platform} />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-mist-900">{a.name}</div>
                    <div className="text-xs text-mist-500">{a.platform === 'toutiao' ? `默认 ${formatName(a.content_format)}` : formatLabel[a.content_format]}{!ok && ' · 当前源稿不支持派生到此平台'}</div>
                  </div>
                </button>
                {target === a.id && a.platform === 'toutiao' && <div className="border-t border-mist-200 px-3 pb-3 pt-2">
                  <label className="mb-1 block text-xs font-medium text-mist-600" htmlFor="derive-toutiao-format">目标作品形态</label>
                  <Select id="derive-toutiao-format" value={targetFormat} onChange={(event) => setTargetFormat(event.target.value as ContentFormat)}>
                    {formats.map((f) => <option key={f} value={f}>{formatName(f)}{a.content_format === f ? '（账号默认）' : ''}</option>)}
                  </Select>
                  <p className="mt-1 text-[11px] leading-relaxed text-mist-500">新作品使用所选形态；不会改变头条账号默认形态。</p>
                </div>}
              </div>
            )
          })}
        </div>
      )}
    </Dialog>
  )
}
