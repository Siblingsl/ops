import { ImagePlus, RefreshCw, Sparkles } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { Badge, Button, Card, cn, HumanGate, Input } from '@/components/ui'
import { aiError } from '@/lib/ai-error'
import { errorMessage, patch, post } from '@/lib/api'
import { useCanWrite } from '@/lib/session'
import type { WorkCard } from '@/lib/types'
import { useWork } from './WorkLayout'

// D-048 图文卡片编辑器：每张卡片 = 段落标题与正文 + 逐卡 AI 配图。
// 卡片清单由大纲确认生成；增删与排序通过「修改大纲」完成，与文字作品一致。
export default function CardEditor() {
  const { work, refresh } = useWork()
  const canWrite = useCanWrite()
  const readOnly = work.locked
  const cards = work.cards ?? []
  const bySection = new Map(cards.map((c) => [c.section_id, c]))
  const ordered = work.sections.map((s) => ({ sec: s, card: bySection.get(s.id) }))
  const [busy, setBusy] = useState<string | null>(null)

  const gen = async (sectionId: string) => {
    setBusy(sectionId)
    try {
      await post(`/works/${work.id}/cards/${sectionId}/generate-image`)
      await refresh()
      toast.success('卡片配图已生成')
    } catch (e) {
      aiError(e, '生成卡片配图')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 animate-fade-in">
      <Card id="step-outline" className="scroll-mt-24 p-5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-display text-[17px] font-bold text-mist-900">卡片清单</h2>
          {work.outline_confirmed_at ? <Badge tone="green">已确认</Badge> : <Badge tone="gamboge">H-03 确认大纲后生成卡片</Badge>}
          <div className="ml-auto">
            <Link to={`/works/${work.id}`} className="text-[13px] text-ink-600 hover:underline">回创作页修改大纲</Link>
          </div>
        </div>
        {!work.outline_confirmed_at && (
          <HumanGate code="H-03" className="mt-3">确认大纲后，每一条就是一张卡片；再逐卡填写文案并生成配图。</HumanGate>
        )}
      </Card>
      {ordered.map(({ sec, card }, i) => (
        <CardRow key={sec.id} index={i + 1} card={card} heading={sec.heading} body={sec.content_md} revision={sec.revision}
          readOnly={readOnly || !work.outline_confirmed_at} canWrite={canWrite} busy={busy === sec.id} onGenerate={() => gen(sec.id)} onChanged={refresh} />
      ))}
      {ordered.length === 0 && (
        <Card className="p-8 text-center text-[13px] text-mist-400">还没有卡片：先在创作页写下核心观点并生成大纲。</Card>
      )}
      <p className="text-center text-xs text-mist-400">
        配图由 AI 生成并标注；公众号写入图片消息草稿需要每张卡片都有配图，小红书发布包含卡片图与文案。
      </p>
    </div>
  )
}

function CardRow({ index, card, heading, body, revision, readOnly, canWrite, busy, onGenerate, onChanged }: {
  index: number
  card?: WorkCard
  heading: string
  body: string
  revision: number
  readOnly: boolean
  canWrite: boolean
  busy: boolean
  onGenerate: () => void
  onChanged: () => Promise<unknown>
}) {
  const [h, setH] = useState(heading)
  const [b, setB] = useState(body)
  const base = useRef(revision)
  useEffect(() => { setH(heading); setB(body); base.current = revision }, [heading, body, revision])
  const editable = canWrite && !readOnly
  const save = async () => {
    if (!editable) return
    if (h === heading && b === body) return
    try {
      await patch(`/sections/${card?.section_id}`, { heading: h, content_md: b, base_revision: base.current })
      await onChanged()
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const image = card?.image_url
  return (
    <Card className="p-5">
      <div className="mb-3 flex items-center gap-2">
        <Badge tone="ink">卡 {index}</Badge>
        <Input className="h-8 flex-1 font-medium" value={h} placeholder="卡片标题（8 字以内）" disabled={!editable}
          onChange={(e) => setH(e.target.value)} onBlur={save} />
        {editable && (
          <Button size="sm" variant={image ? 'ghost' : 'secondary'} loading={busy} onClick={onGenerate}
            icon={image ? <RefreshCw className="size-3.5" /> : <ImagePlus className="size-3.5" />}>
            {image ? '重新生成配图' : '生成配图'}
          </Button>
        )}
      </div>
      <textarea rows={3} value={b} placeholder="卡片正文：两三行以内，可直接照做或收藏" disabled={!editable}
        className={cn('w-full resize-y rounded-lg border border-mist-200 bg-white px-3 py-2 text-[13.5px] leading-relaxed focus:border-ink-300 focus:outline-none',
          !editable && 'bg-mist-50 text-mist-500')}
        onChange={(e) => setB(e.target.value)} onBlur={save} />
      {image ? (
        <div className="mt-3 overflow-hidden rounded-lg border border-mist-100 bg-mist-50">
          <img src={image} alt={`卡片 ${index} 配图`} className="max-h-80 w-full object-contain" />
          <div className="flex items-center gap-1 px-3 py-1.5 text-[11.5px] text-mist-400"><Sparkles className="size-3" />AI 生成配图</div>
        </div>
      ) : (
        <div className="mt-3 rounded-lg border border-dashed border-mist-200 px-3 py-6 text-center text-[12.5px] text-mist-400">
          这张卡片还没有配图
        </div>
      )}
    </Card>
  )
}
