import { BadgeCheck, ExternalLink } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { errorMessage, post } from '@/lib/api'
import { fmtTime, toLocalInput } from '@/lib/format'
import type { Work } from '@/lib/types'
import { Button, Card, Field, HumanGate, Input } from './ui'

/** BackfillForm is the only way to mark a work as published (H-07). */
export function BackfillForm({ work, setWork }: { work: Work; setWork: (w: Work) => void }) {
  const [url, setUrl] = useState(work.published_url ?? '')
  const [at, setAt] = useState(toLocalInput(work.published_at ?? new Date().toISOString()))
  const [busy, setBusy] = useState(false)
  if (work.status === 'published') {
    return (
      <Card className="p-5">
        <div className="flex items-start gap-3">
          <BadgeCheck className="mt-0.5 size-5 text-emerald-600" />
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-mist-900">已发布</div>
            <div className="mt-0.5 text-[13px] text-mist-500">发布时间：{fmtTime(work.published_at)}</div>
            {work.published_url && (
              <a href={work.published_url} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 break-all text-[13px] text-ink-600 hover:underline">
                {work.published_url}<ExternalLink className="size-3 shrink-0" />
              </a>
            )}
          </div>
          <Link to={`/a/${work.account_id}/review?work=${work.id}`}><Button size="sm">录入数据</Button></Link>
        </div>
      </Card>
    )
  }
  const submit = async () => {
    setBusy(true)
    try {
      setWork(await post<Work>(`/works/${work.id}/published`, { url: url.trim(), published_at: new Date(at).toISOString() }))
      toast.success('已标记为已发布，作品已锁定为只读')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card className="p-5">
      <h3 className="mb-1 font-display text-[16px] font-bold text-mist-900">回填已发布</h3>
      <p className="mb-4 text-[13px] text-mist-500">在平台上正式发表后回到这里回填。系统不会自动判断是否已发布。</p>
      <div className="grid gap-3 sm:grid-cols-[1fr_200px]">
        <Field label="作品链接（可选）"><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" /></Field>
        <Field label="发布时间"><Input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} /></Field>
      </div>
      <HumanGate code="H-07" className="mt-4">只有你确认已在平台发表后才能标记。标记后作品锁定为只读。</HumanGate>
      <Button variant="human" className="mt-4" loading={busy} onClick={submit} icon={<BadgeCheck className="size-4" />}>标记为已发布</Button>
    </Card>
  )
}
