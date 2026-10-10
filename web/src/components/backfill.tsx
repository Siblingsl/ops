import { BadgeCheck, ExternalLink } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { errorMessage, post, put } from '@/lib/api'
import { fmtTime, toLocalInput } from '@/lib/format'
import type { PostPushTodo, Work } from '@/lib/types'
import { Button, Card, cn, Field, HumanGate, Input, Select } from './ui'

/** PostPushTodos is the persisted "在平台还需要你完成" checklist (EX-I-01); ticking items never publishes anything. */
export function PostPushTodos({ work, setWork, className }: { work: Work; setWork: (w: Work) => void; className?: string }) {
  const todos = work.post_push_todos ?? []
  if (!todos.length) return null
  const toggle = async (t: PostPushTodo) => {
    const next = todos.map((x) => (x.key === t.key ? { ...x, done: !x.done } : x))
    setWork({ ...work, post_push_todos: next })
    try {
      setWork(await put<Work>(`/works/${work.id}/post-push-todos`, { todos: next }))
    } catch (e) {
      setWork(work)
      toast.error(errorMessage(e))
    }
  }
  const left = todos.filter((t) => !t.done).length
  return (
    <div className={className}>
      <div className="mb-2 text-[13px] font-semibold text-mist-700">在平台还需要你完成{left > 0 ? <span className="ml-1 font-normal text-mist-400">还剩 {left} 项</span> : <span className="ml-1 font-normal text-ink-600">都完成了</span>}</div>
      <ul className="space-y-2">
        {todos.map((t) => (
          <li key={t.key}>
            <label className="flex cursor-pointer items-start gap-2.5 text-[14px] text-mist-700">
              <input type="checkbox" className="mt-1 accent-ink-600" checked={t.done} onChange={() => toggle(t)} />
              <span className={cn(t.done && 'text-mist-400 line-through')}>{t.label}</span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** BackfillForm is the only way to mark a work as published (H-07). */
export function BackfillForm({ work, setWork }: { work: Work; setWork: (w: Work) => void }) {
  const [url, setUrl] = useState(work.published_url ?? '')
  const [at, setAt] = useState(toLocalInput(work.published_at ?? new Date().toISOString()))
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')
  const [platform, setPlatform] = useState<string>(work.platform)
  const parse = async (v: string) => {
    if (!v.trim()) return setHint('')
    try {
      const r = await post<{ platform: string; published_at: string | null; note: string }>('/publish-link/parse', { url: v.trim() })
      const name = r.platform === 'wechat_mp' ? '公众号' : r.platform === 'xhs' ? '小红书' : ''
      if (name) setPlatform(r.platform)
      if (r.published_at) setAt(toLocalInput(r.published_at))
      if (name && r.platform !== work.platform) setHint(`这是${name}的链接，和本作品的平台不一致，请确认没有贴错。`)
      else setHint(r.note || (name ? `已识别为${name}链接${r.published_at ? '，已按链接里的时间填好发布时间' : ''}。` : ''))
    } catch {
      setHint('')
    }
  }
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
    if (platform !== work.platform) return toast.error(`本作品发布在${work.platform === 'xhs' ? '小红书' : '公众号'}，请确认链接没有贴错，或把平台改回来`)
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
      <div className="grid gap-3 sm:grid-cols-[1fr_120px_200px]">
        <Field label="作品链接（可选）" hint={hint || '粘贴链接后会识别平台和发布时间，不会访问这个链接'}>
          <Input value={url} onChange={(e) => setUrl(e.target.value)} onBlur={(e) => void parse(e.target.value)} onPaste={(e) => void parse(e.clipboardData.getData('text'))} placeholder="https://" />
        </Field>
        <Field label="平台">
          <Select value={platform} onChange={(e) => setPlatform(e.target.value)} className={cn(platform !== work.platform && 'border-danger')}>
            <option value="wechat_mp">公众号</option>
            <option value="xhs">小红书</option>
          </Select>
        </Field>
        <Field label="发布时间"><Input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} /></Field>
      </div>
      <HumanGate code="H-07" className="mt-4">只有你确认已在平台发表后才能标记。标记后作品锁定为只读。</HumanGate>
      <Button variant="human" className="mt-4" loading={busy} onClick={submit} icon={<BadgeCheck className="size-4" />}>标记为已发布</Button>
    </Card>
  )
}
