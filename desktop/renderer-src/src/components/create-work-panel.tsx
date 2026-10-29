import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Lightbulb, PenLine } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Dialog } from '@/components/dialog'
import { Button, cn, Field, Input, Select } from '@/components/ui'
import { api, errorMessage, get } from '@/lib/api'
import { currentWorkQueryKey, useCurrentAccount, useMe } from '@/lib/session'
import type { ContentFormat, CreationTemplate, Topic, Work } from '@/lib/types'
import { platformFormatLabel } from '@/components/ui'

// NW-A1/A4/A5/A6：所有"新建作品"入口都打开同一个面板；创建只有一个前端实现、一个 HTTP 契约。
export interface CreateWorkIntent {
  accountId?: string
  platform?: 'wechat_mp' | 'xhs' | 'toutiao'
  format?: ContentFormat
  title?: string
  topicId?: string
  templateId?: string
}

export function openCreateWork(intent: CreateWorkIntent = {}) {
  // 用模块级 store 而不是纯事件：入口页的 effect 可能先于面板的监听器注册，
  // 事件会丢；pending 保证打开请求一定被消费。
  pendingIntent = intent
  for (const listener of listeners) listener(intent)
}

let pendingIntent: CreateWorkIntent | null = null
const listeners = new Set<(intent: CreateWorkIntent) => void>()

const FORMATS: { value: ContentFormat; label: string; hint: string }[] = [
  { value: 'long_article', label: '文章', hint: '分段撰写，有发布标题，可选正文配图。' },
  { value: 'micro_post', label: '微头条', hint: '短观点分段，系统内名称不作为发布标题，可无图发布。' },
]

export function CreateWorkPanel() {
  const acc = useCurrentAccount()
  const { data: me } = useMe()
  const nav = useNavigate()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [format, setFormat] = useState<ContentFormat>('long_article')
  const [topicId, setTopicId] = useState('')
  const [templateId, setTemplateId] = useState('')
  const [busy, setBusy] = useState(false)
  const key = useRef<string | null>(null)
  const [accountId, setAccountId] = useState<string | undefined>(acc?.id)
  const platform = (accountId && accountId === acc?.id ? acc.platform : undefined) ?? undefined

  useEffect(() => {
    const show = (d: CreateWorkIntent) => {
      setAccountId(d.accountId ?? acc?.id)
      setTitle(d.title ?? '')
      setFormat(d.format ?? (acc?.content_format === 'micro_post' ? 'micro_post' : 'long_article'))
      setTopicId(d.topicId ?? '')
      setTemplateId(d.templateId ?? '')
      key.current = null
      setOpen(true)
    }
    listeners.add(show)
    if (pendingIntent) { show(pendingIntent); pendingIntent = null }
    return () => { listeners.delete(show) }
  }, [acc?.id, acc?.content_format])

  const topics = useQuery({
    queryKey: ['create-work-topics', accountId],
    queryFn: async () => (await get<Topic[]>(`/accounts/${accountId}/topics`)).filter((t) => t.status === 'pending' && !t.work_id),
    enabled: open && !!accountId,
    staleTime: 15_000,
  })
  // DEV-416 / D-140：模板是唯一决策点；只列当前形态的模板。
  const templateFormat = platform === 'toutiao' ? format : (acc?.content_format ?? 'long_article')
  const templates = useQuery({
    queryKey: ['creation-templates', templateFormat],
    queryFn: () => get<CreationTemplate[]>(`/creation-templates?content_format=${templateFormat}`),
    enabled: open && !!accountId,
    staleTime: 60_000,
  })

  const close = () => { if (!busy) setOpen(false) }
  const create = async () => {
    if (!accountId || busy) return
    setBusy(true)
    key.current ??= crypto.randomUUID()
    try {
      const w = await api<Work>('POST', `/accounts/${accountId}/works`, {
        title: title.trim(),
        ...(platform === 'toutiao' ? { content_format: format } : {}),
        ...(topicId ? { topic_id: topicId } : {}),
        ...(templateId ? { template_id: templateId } : {}),
      }, { headers: { 'Idempotency-Key': key.current } })
      key.current = null
      qc.setQueryData(currentWorkQueryKey(w.id, me?.user_id ?? me?.username ?? '', me?.workspace.id ?? ''), w)
      qc.setQueryData(['work', w.id], w)
      void qc.invalidateQueries({ queryKey: ['works', accountId] })
      setOpen(false)
      nav(`/works/${w.id}`)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const toutiao = platform === 'toutiao'
  const pendingTopics = topics.data ?? []
  const fromTopic = pendingTopics.find((t) => t.id === topicId)

  return (
    <Dialog open={open} onClose={close} title="新建作品" width="max-w-xl"
      desc="先决定从哪来、写什么形态；标题可以稍后再定。"
      footer={<>
        <Button variant="ghost" disabled={busy} onClick={close}>取消</Button>
        <Button variant="primary" loading={busy} onClick={() => void create()} icon={<PenLine className="size-4" />}>开始创作</Button>
      </>}>
      <div className="space-y-4">
        <Field label="作品标题" hint="最多64字；可留空，作品会先显示为「未命名作品」，也可以到第 4 步再定。">
          <Input autoFocus value={title} maxLength={64} placeholder="未命名作品" onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void create() }} />
        </Field>

        {toutiao && (
          <Field label="作品形态" hint="只影响这篇头条作品；账号默认形态已预选。">
            <div className="grid gap-2 sm:grid-cols-2">
              {FORMATS.map((f) => (
                <label key={f.value} className={cn('flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition', format === f.value ? 'border-ink-400 bg-ink-50' : 'border-mist-200 hover:border-mist-300')}>
                  <input type="radio" name="create-content-format" value={f.value} checked={format === f.value} onChange={() => setFormat(f.value)} aria-label={f.label} className="mt-1 accent-ink-600" />
                  <span><strong className="block text-[13.5px] text-mist-900">{f.label}</strong><span className="mt-0.5 block text-[12px] leading-relaxed text-mist-500">{f.hint}</span></span>
                </label>
              ))}
            </div>
          </Field>
        )}

        <Field label="模板（可选）" hint="模板决定结构、语气与段落数；不选就按账号类型的通用写法。">
          <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)} disabled={!accountId}>
            <option value="">不用模板</option>
            {(templates.data ?? []).map((t) => (
              <option key={t.id} value={t.id}>{t.name}{t.builtin ? '（内置）' : ''}</option>
            ))}
          </Select>
          {(() => {
            const t = (templates.data ?? []).find((x) => x.id === templateId)
            if (!t) return null
            const structure = t.structure.map((s) => s.heading).filter(Boolean).join(' → ')
            return <p className="mt-2 rounded-lg bg-mist-50 px-3 py-2 text-[12.5px] text-mist-600">
              {structure || '结构由你决定'}
              {t.tone && <> · 语气：{t.tone}</>}
              {t.section_min > 0 && t.section_max > 0 && <> · {t.section_min}–{t.section_max} 段</>}
            </p>
          })()}
        </Field>

        <Field label="从选题开始（可选）" hint="选题的角度会作为观点提示，观点仍要你自己写。">
          <div className="flex gap-2">
            <Select value={topicId} onChange={(e) => { setTopicId(e.target.value); const t = pendingTopics.find((x) => x.id === e.target.value); if (t && !title.trim()) setTitle(t.title) }} disabled={!accountId}>
              <option value="">空白开始</option>
              {pendingTopics.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
            </Select>
            <Button variant="ghost" icon={<Lightbulb className="size-4" />} onClick={() => { setOpen(false); if (accountId) nav(`/a/${accountId}/topics`) }}>选题池</Button>
          </div>
          {fromTopic?.angle && <p className="mt-2 rounded-lg bg-mist-50 px-3 py-2 text-[12.5px] text-mist-600">选题角度：{fromTopic.angle}</p>}
          {pendingTopics.length === 0 && <p className="mt-2 text-[12px] text-mist-400">暂无待定选题；可以先空白开始，或去选题池记一个想法。</p>}
        </Field>

        {platform && <p className="text-[12px] text-mist-400">将创建：{platformFormatLabel(platform, toutiao ? format : (acc?.content_format ?? 'long_article'))} · {acc?.name}</p>}
      </div>
    </Dialog>
  )
}
