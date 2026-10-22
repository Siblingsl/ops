import { ArrowDown, ArrowRight, ArrowUp, ImagePlus, RefreshCw, Sparkles } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Badge, Button, Card, cn, HumanGate, Input } from '@/components/ui'
import { confirm } from '@/components/dialog'
import { aiError } from '@/lib/ai-error'
import { ApiError, errorMessage, patch, post, put } from '@/lib/api'
import { useCanWrite } from '@/lib/session'
import type { Section, Work, WorkCard } from '@/lib/types'
import { SectionConflictDialog, WorkConflictDialog } from './section-save-dialogs'
import { nextStepFor, useWork, WorkHeaderAction } from './WorkLayout'

// D-048 图文卡片编辑器：每张卡片 = 段落标题与正文 + 逐卡 AI 配图。
// 卡片清单由大纲确认生成；增删通过「修改大纲」，排序同步段落、大纲和卡片。
export default function CardEditor() {
  const { work, refresh, setWork } = useWork()
  const nav = useNavigate()
  const [orderConflict, setOrderConflict] = useState<{ server: Work; ids: string[] } | null>(null)
  const canWrite = useCanWrite()
  const readOnly = work.locked
  const cards = work.cards ?? []
  const bySection = new Map(cards.map((c) => [c.section_id, c]))
  const ordered = work.sections.map((s) => ({ sec: s, card: bySection.get(s.id) }))
  const [busy, setBusy] = useState<string | null>(null)

  const gen = async (sectionId: string, prompt: string) => {
    setBusy(sectionId)
    try {
      await post(`/works/${work.id}/cards/${sectionId}/generate-image`, { prompt: prompt.trim() })
      await refresh()
      toast.success('卡片配图已生成')
    } catch (e) {
      aiError(e, '生成卡片配图')
    } finally {
      setBusy(null)
    }
  }

  const move = async (index: number, offset: number) => {
    const ids = work.sections.map(s => s.id)
    const target = index + offset
    if (target < 0 || target >= ids.length || busy) return
    ;[ids[index], ids[target]] = [ids[target], ids[index]]
    setBusy('order')
    try {
      await put(`/works/${work.id}/sections/order`, { ids, base_revision: work.revision })
      await refresh()
      toast.success('卡片顺序已更新')
    } catch (e) {
      if (e instanceof ApiError && e.code === 'version_conflict') setOrderConflict({ server: (e.detail as { server: Work }).server, ids })
      else toast.error(errorMessage(e))
    } finally { setBusy(null) }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 animate-fade-in">
      {/* ED-03：卡片编辑器也要在页头给下一步（原来完全没有提交入口）。 */}
      {!readOnly && <WorkHeaderAction>
        {(() => {
          const next = nextStepFor(work.status, work.platform === 'wechat_mp')
          if (!next) return null
          return <Button size="sm" variant="primary" onClick={() => nav(next.to)}>{next.label}<ArrowRight className="size-4" /></Button>
        })()}
      </WorkHeaderAction>}
      {orderConflict && <WorkConflictDialog server={orderConflict.server} mine={{ ...work, sections: orderConflict.ids.map(id => work.sections.find(section => section.id === id)!) }} onClose={() => setOrderConflict(null)} onResolve={async keepMine => {
        if (!keepMine) { setWork(orderConflict.server); setOrderConflict(null); return }
        try { setWork(await put<Work>(`/works/${work.id}/sections/order`, { ids: orderConflict.ids, base_revision: orderConflict.server.revision })); setOrderConflict(null) }
        catch (e) {
          if (e instanceof ApiError && e.code === 'version_conflict') setOrderConflict({ ...orderConflict, server: (e.detail as { server: Work }).server })
          else toast.error(errorMessage(e))
        }
      }} />}
      <Card id="step-cards" className="scroll-mt-24 p-5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-display text-[17px] font-bold text-mist-900">卡片清单</h2>
          {work.outline_confirmed_at ? <Badge tone="green">已确认</Badge> : <Badge tone="gamboge">H-03 确认大纲后生成卡片</Badge>}
          <div className="ml-auto">
            <a href="#step-outline" className="text-[13px] text-ink-600 hover:underline">修改大纲</a>
          </div>
        </div>
        {!work.outline_confirmed_at && (
          <HumanGate code="H-03" className="mt-3">确认大纲后，每一条就是一张卡片；再逐卡填写文案并生成配图。</HumanGate>
        )}
      </Card>
      {ordered.map(({ sec, card }, i) => (
        <CardRow key={sec.id} sectionId={sec.id} index={i + 1} card={card} heading={sec.heading} body={sec.content_md} revision={sec.revision}
          readOnly={readOnly || !work.outline_confirmed_at} canWrite={canWrite} busy={busy === sec.id} blocked={!!busy}
          total={ordered.length} onMove={offset => move(i, offset)} onGenerate={prompt => gen(sec.id, prompt)} onChanged={refresh} />
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

function CardRow({ sectionId, index, card, heading, body, revision, readOnly, canWrite, busy, blocked, total, onMove, onGenerate, onChanged }: {
  sectionId: string
  index: number
  card?: WorkCard
  heading: string
  body: string
  revision: number
  readOnly: boolean
  canWrite: boolean
  busy: boolean
  blocked: boolean
  total: number
  onMove: (offset: number) => void
  onGenerate: (prompt: string) => void
  onChanged: () => Promise<unknown>
}) {
  const [h, setH] = useState(heading)
  const [b, setB] = useState(body)
  const [prompt, setPrompt] = useState('')
  const [conflict, setConflict] = useState<Section | null>(null)
  const base = useRef(revision)
  const resolving = useRef(false)
  useEffect(() => { setH(heading); setB(body); base.current = revision }, [heading, body, revision])
  const editable = canWrite && !readOnly && !blocked
  const save = async (keepMine = false) => {
    if (!editable || (conflict && !keepMine)) return
    if (!conflict && h === heading && b === body) return
    try {
      const result = await patch<{ section: Section }>(`/sections/${sectionId}`, { heading: h, content_md: b, base_revision: keepMine ? conflict!.revision : base.current })
      base.current = result.section.revision
      setConflict(null)
      await onChanged()
    } catch (e) {
      if (e instanceof ApiError && e.code === 'version_conflict') setConflict((e.detail as { server: Section }).server)
      else toast.error(errorMessage(e))
    }
  }
  const resolveConflict = async (keepMine: boolean) => {
    if (!conflict || resolving.current) return
    resolving.current = true
    try {
      if (keepMine) { await save(true); return }
      setH(conflict.heading)
      setB(conflict.content_md)
      base.current = conflict.revision
      setConflict(null)
      await onChanged()
    } finally { resolving.current = false }
  }
  const image = card?.image_url
  const generate = async () => {
    if (image && !(await confirm({ title: '重新生成这张卡片配图？', desc: '仅替换这张卡片的当前配图，旧图保留在图片库和作品资产中；相同图片会去重，不额外创建副本。', confirmText: '重新生成这一张' }))) return
    onGenerate(prompt)
  }
  return (
    <Card className="p-5" data-card-section={sectionId}>
      <SectionConflictDialog server={conflict} heading={h} content={b} onClose={() => setConflict(null)} onResolve={resolveConflict} />
      <div className="mb-3 flex items-center gap-2">
        <Badge tone="ink">卡 {index}</Badge>
        <Button size="sm" variant="ghost" aria-label={`上移卡片 ${index}`} disabled={!editable || index === 1} onClick={() => onMove(-1)} icon={<ArrowUp className="size-3.5" />} />
        <Button size="sm" variant="ghost" aria-label={`下移卡片 ${index}`} disabled={!editable || index === total} onClick={() => onMove(1)} icon={<ArrowDown className="size-3.5" />} />
        <Input className="h-8 flex-1 font-medium" value={h} placeholder="卡片标题（8 字以内）" disabled={!editable}
          onChange={(e) => setH(e.target.value)} onBlur={() => void save()} />
        {canWrite && !readOnly && (
          <Button size="sm" variant={image ? 'ghost' : 'secondary'} loading={busy} disabled={blocked} onClick={generate}
            icon={image ? <RefreshCw className="size-3.5" /> : <ImagePlus className="size-3.5" />}>
            {image ? '重新生成配图' : '生成配图'}
          </Button>
        )}
      </div>
      <textarea rows={3} value={b} placeholder="卡片正文：两三行以内，可直接照做或收藏" disabled={!editable}
        className={cn('w-full resize-y rounded-lg border border-mist-200 bg-white px-3 py-2 text-[13.5px] leading-relaxed focus:border-ink-300 focus:outline-none',
          !editable && 'bg-mist-50 text-mist-500')}
        onChange={(e) => setB(e.target.value)} onBlur={() => void save()} />
      {canWrite && !readOnly && <label className="mt-3 block text-xs text-mist-500">
        配图提示词（可选）
        <Input className="mt-1" value={prompt} disabled={blocked} onChange={e => setPrompt(e.target.value)} placeholder="留空则按卡片文案生成；例如：绿色书桌与笔记本，保持留白" />
      </label>}
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
