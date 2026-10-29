import { BadgeCheck } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { ApiError, del, errorMessage, get, post, put } from '@/lib/api'
import { fmtTime, toLocalInput } from '@/lib/format'
import type { PostPushTodo, Work } from '@/lib/types'
import { Badge, Button, Card, cn, Field, HumanGate, Input, Notice, platformLabel, roleReadOnlyHint, Select, Textarea } from './ui'

interface PublishCorrectionPreview {
  mode: 'correction'
  publish_revision: number
  before: { url: string | null; published_at: string | null }
  after: { url: string | null; published_at: string | null }
  changed_fields: string[]
  changed: boolean
  metrics: { id: string; source: string; captured_at: string; before_day_offset: number | null; after_day_offset: number | null }[]
}

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
  const [at, setAt] = useState(work.published_at ? toLocalInput(work.published_at) : work.status === 'published' ? '' : toLocalInput())
  const [dateBaseline, setDateBaseline] = useState(work.published_at ? toLocalInput(work.published_at) : '')
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')
  const [platform, setPlatform] = useState<string>(work.platform)
  const [reason, setReason] = useState('')
  const [preview, setPreview] = useState<PublishCorrectionPreview | null>(null)
  const [previewKey, setPreviewKey] = useState('')
  // PB-05：回填成功后引导去复盘。
  const [justPublished, setJustPublished] = useState(false)
  const correctionBody = () => {
    const body: Record<string, unknown> = {
      mode: 'correction',
      base_publish_revision: work.publish_revision,
      reason: reason.trim(),
      url: url.trim(),
    }
    if (at && at !== dateBaseline) body.published_at = new Date(at).toISOString()
    return body
  }
  const invalidatePreview = () => {
    setPreview(null)
    setPreviewKey('')
  }
  const refreshAfterConflict = async (error: unknown) => {
    toast.error(errorMessage(error))
    invalidatePreview()
    if (error instanceof ApiError && error.status === 409) {
      try {
        const latest = await get<Work>(`/works/${work.id}`)
        setWork(latest)
        setDateBaseline(latest.published_at ? toLocalInput(latest.published_at) : '')
      } catch { /* Keep the correction fields available if the refresh also fails. */ }
    }
  }
  const parse = async (v: string) => {
    if (!v.trim()) return setHint('')
    try {
      const r = await post<{ platform: string; published_at: string | null; note: string }>('/publish-link/parse', { url: v.trim() })
      const name = r.platform in platformLabel ? platformLabel[r.platform as keyof typeof platformLabel] : ''
      if (name) setPlatform(r.platform)
      if (r.published_at) {
        setAt(toLocalInput(r.published_at))
        invalidatePreview()
      }
      if (name && r.platform !== work.platform) setHint(`这是${name}的链接，和本作品的平台不一致，请确认没有贴错。`)
      else setHint(r.note || (name ? `已识别为${name}链接${r.published_at ? '，已按链接里的时间填好发布时间' : ''}。` : ''))
    } catch {
      setHint('')
    }
  }
  if (work.status === 'published') {
    const currentKey = JSON.stringify(correctionBody())
    const previewCorrection = async () => {
      if (platform !== work.platform) return toast.error(`本作品平台是${platformLabel[work.platform]}，请确认链接没有贴错`)
      setBusy(true)
      try {
        const next = await post<PublishCorrectionPreview>(`/works/${work.id}/published?preview=true`, correctionBody())
        setPreview(next)
        setPreviewKey(currentKey)
      } catch (e) {
        await refreshAfterConflict(e)
      } finally {
        setBusy(false)
      }
    }
    const submitCorrection = async () => {
      if (!preview || previewKey !== currentKey) return toast.error('请先按当前输入重新预览影响')
      if (!preview.changed) return toast.message('发布记录没有变化，无需提交')
      if (platform !== work.platform) return toast.error(`本作品平台是${platformLabel[work.platform]}，请确认链接没有贴错`)
      setBusy(true)
      try {
        const updated = await post<Work>(`/works/${work.id}/published`, { ...correctionBody(), confirm_published: true })
        setWork(updated)
        setUrl(updated.published_url ?? '')
        setAt(updated.published_at ? toLocalInput(updated.published_at) : '')
        setDateBaseline(updated.published_at ? toLocalInput(updated.published_at) : '')
        setReason('')
        invalidatePreview()
        toast.success('发布记录已更正；平台内容没有变化')
      } catch (e) {
        await refreshAfterConflict(e)
      } finally {
        setBusy(false)
      }
    }
    return (
      <Card className="p-5">
        <div className="flex items-start gap-3">
          <BadgeCheck className="mt-0.5 size-5 text-emerald-600" />
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-mist-900">更正发布记录</div>
            <div className="mt-1 text-[13px] text-mist-500">当前记录：{fmtTime(work.published_at)}{work.published_url ? ` · ${work.published_url}` : ' · 未填写链接'}</div>
          </div>
          <Link to={`/a/${work.account_id}/review?work=${work.id}`}><Button size="sm">录入数据</Button></Link>
        </div>
        <div className="mt-4 grid gap-3">
          <Field label="更正后的作品链接" hint={work.platform === 'wechat_mp' ? '留空会清除链接；更换链接时系统会同步校正可识别的公众号文章 ID。' : '留空会清除链接；系统不会访问你填写的链接。'}>
            <Input value={url} onChange={(e) => { setUrl(e.target.value); invalidatePreview() }} onBlur={(e) => void parse(e.target.value)} onPaste={(e) => void parse(e.clipboardData.getData('text'))} placeholder="https://" />
          </Field>
          <Field label="更正后的发布时间" hint="留空或保持原值表示保留当前发布时间。">
            <Input type="datetime-local" value={at} onChange={(e) => { setAt(e.target.value); invalidatePreview() }} />
          </Field>
        </div>
        {hint && <p className="mt-2 text-[13px] text-mist-500">{hint}</p>}
        <Field label="更正原因" className="mt-3" hint="记录会进入现有操作审计，最多 500 字。">
          <Textarea value={reason} onChange={(e) => { setReason(e.target.value); invalidatePreview() }} rows={2} maxLength={500} placeholder="例如：核对平台原文后发现发布时间填写错误" />
        </Field>
        <HumanGate code="H-07" className="mt-4">这里只更正系统中的链接和发布时间，不会修改或下架平台内容。提交前先核对原值、拟改值和受影响的数据节点。</HumanGate>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="secondary" loading={busy} onClick={previewCorrection} disabled={!reason.trim()}>预览更正影响</Button>
          <Button variant="human" loading={busy} onClick={submitCorrection} disabled={!preview?.changed || previewKey !== currentKey}>确认更正</Button>
        </div>
        {preview && previewKey === currentKey && (
          <div className="mt-4 rounded-xl border border-mist-200 bg-mist-50 p-4 text-[13px]">
            <div className="font-semibold text-mist-800">更正预览</div>
            <div className="mt-2 text-mist-600">链接：{preview.before.url || '未填写'} → {preview.after.url || '未填写'}</div>
            <div className="text-mist-600">发布时间：{fmtTime(preview.before.published_at)} → {fmtTime(preview.after.published_at)}</div>
            {preview.metrics.length > 0 ? (
              <div className="mt-3">
                <div className="mb-1 font-medium text-mist-700">将调整 {preview.metrics.length} 条数据节点</div>
                <ul className="space-y-1 text-mist-600">
                  {preview.metrics.map((m) => <li key={m.id}>{fmtTime(m.captured_at)} · {m.source} · {m.before_day_offset ?? '未知'} → {m.after_day_offset ?? '未知'}</li>)}
                </ul>
              </div>
            ) : <div className="mt-2 text-mist-600">数据节点无需调整。</div>}
            {!preview.changed && <div className="mt-2 font-medium text-mist-700">没有实际变化，无需提交。</div>}
          </div>
        )}
      </Card>
    )
  }
  const submit = async () => {
    if (platform !== work.platform) return toast.error(`本作品发布在${platformLabel[work.platform]}，请确认链接没有贴错，或把平台改回来`)
    setBusy(true)
    try {
      const updated = await post<Work>(`/works/${work.id}/published`, { url: url.trim(), published_at: new Date(at).toISOString() })
      setWork(updated)
      setUrl(updated.published_url ?? '')
      setAt(updated.published_at ? toLocalInput(updated.published_at) : '')
      setDateBaseline(updated.published_at ? toLocalInput(updated.published_at) : '')
      // PB-05：回填成功后引导去复盘，避免用户回填完就断线。
      setJustPublished(true)
      toast.success('已标记为已发布，作品已锁定为只读')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card className="@container p-5">
      <h3 className="mb-1 font-display text-[16px] font-bold text-mist-900">回填已发布</h3>
      <p className="mb-4 text-[13px] text-mist-500">在平台上正式发表后回到这里回填。系统不会自动判断是否已发布。</p>
      {justPublished && (
        <Notice tone="ink" className="mb-4">
          已回填发布记录。接下来到复盘页录入这篇的数据，24/48 小时后再补一次指标，报告才有依据。
          <Link to={`/a/${work.account_id}/review?work=${work.id}`} className="ml-2 font-medium underline">去复盘</Link>
        </Notice>
      )}
      <div className="grid gap-3 @[640px]:grid-cols-[minmax(0,1fr)_120px_200px]">
        <Field label="作品链接（可选）" hint={hint || '粘贴链接后会识别平台和发布时间，不会访问这个链接'}>
          <Input value={url} onChange={(e) => setUrl(e.target.value)} onBlur={(e) => void parse(e.target.value)} onPaste={(e) => void parse(e.clipboardData.getData('text'))} placeholder="https://" />
        </Field>
        <Field label="平台">
          <Select value={platform} onChange={(e) => setPlatform(e.target.value)} className={cn(platform !== work.platform && 'border-danger')}>
            <option value="wechat_mp">公众号</option>
            <option value="xhs">小红书</option>
            <option value="toutiao">今日头条</option>
          </Select>
        </Field>
        <Field label="发布时间"><Input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} /></Field>
      </div>
      <HumanGate code="H-07" className="mt-4">只有你确认已在平台发表后才能标记。标记后作品锁定为只读。</HumanGate>
      <Button variant="human" className="mt-4" loading={busy} onClick={submit} icon={<BadgeCheck className="size-4" />}>标记为已发布</Button>
    </Card>
  )
}

/** 平台作品绑定：逐篇确认稳定编号，不接受按标题猜测（20 文档 §7.2）。 */
export function PlatformBinding({ work, setWork, canManage }: { work: Work; setWork: (w: Work) => void; canManage: boolean }) {
  const [externalID, setExternalID] = useState(work.external_id ?? '')
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState<{ title?: string; work_id?: string } | null>(null)

  const bind = async () => {
    if (!externalID.trim()) return toast.error('请填写平台上的作品编号')
    setBusy(true)
    setConflict(null)
    try {
      await put(`/works/${work.id}/platform-binding`, {
        external_id: externalID.trim(),
        metric_binding_revision: work.metric_binding_revision,
        publish_revision: work.publish_revision,
        binding_source: 'user_link',
      })
      setWork(await get<Work>(`/works/${work.id}`))
      toast.success('已绑定这一篇；之后只会按这个编号回填')
    } catch (e) {
      // 409 时服务端会给出冲突作品摘要，逐篇处理，不静默覆盖。
      if (e instanceof ApiError && e.status === 409 && e.code === 'platform_binding_conflict') {
        const detail = e.detail as { title?: string; work_id?: string } | undefined
        setConflict(detail ?? {})
        toast.error('该平台作品已绑定到另一篇作品')
      } else {
        toast.error(errorMessage(e))
      }
    } finally {
      setBusy(false)
    }
  }

  const unbind = async () => {
    setBusy(true)
    try {
      await del(`/works/${work.id}/platform-binding`, {
        metric_binding_revision: work.metric_binding_revision,
        publish_revision: work.publish_revision,
      })
      setWork(await get<Work>(`/works/${work.id}`))
      setExternalID('')
      toast.success('已解除绑定；已采用的指标会保留来源')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const bound = Boolean(work.external_id)
  return (
    <Card className="p-5">
      <h3 className="mb-1 font-display text-[16px] font-bold text-mist-900">平台作品绑定</h3>
      <p className="mb-4 text-[13px] text-mist-500">
        填写平台上的作品编号后，系统只按这个编号回填数据；不会按标题或封面相似度自动匹配。
      </p>
      {bound ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-[13.5px] text-mist-700">
            <Badge tone="ink">{work.external_id}</Badge>
            {work.platform_binding_source && (
              <span className="text-mist-400">
                来源：{bindingSourceLabel[work.platform_binding_source] ?? work.platform_binding_source}
              </span>
            )}
            {work.platform_binding_verified_at && (
              <span className="text-mist-400">确认于 {fmtTime(work.platform_binding_verified_at)}</span>
            )}
          </div>
          {canManage && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={unbind}>解除绑定</Button>
          )}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
          <Field
            label="平台作品编号"
            hint={work.platform === 'xhs' ? '24 位十六进制编号' : '格式 <appmsgid>_<itemidx>，例如 2247480001_1'}
          >
            <Input value={externalID} disabled={!canManage} disabledHint={roleReadOnlyHint.writer} onChange={(e) => setExternalID(e.target.value)} placeholder={work.platform === 'xhs' ? '6f0000000000000000000001' : '2247480001_1'} />
          </Field>
          <div className="flex items-end">
            <Button variant="primary" disabled={!canManage} disabledHint={roleReadOnlyHint.writer} loading={busy} onClick={bind}>确认绑定</Button>
          </div>
        </div>
      )}
      {conflict && (
        <div className="mt-3 rounded border border-orange-200 bg-orange-50 px-3 py-2 text-[13px] text-orange-800">
          该编号已绑定到「{conflict.title ?? '另一篇作品'}」。
          {conflict.work_id && (
            <Link className="ml-1 underline" to={`/works/${conflict.work_id}`}>打开那一篇</Link>
          )}
          <span className="ml-1">先在那里解除绑定，再回到这里绑定。</span>
        </div>
      )}
    </Card>
  )
}

const bindingSourceLabel: Record<string, string> = {
  user_link: '用户提供的链接',
  user_confirm: '用户确认',
  official_exact: '官方精确匹配',
  legacy_title: '历史按标题匹配（待核对）',
}
