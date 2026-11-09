import { ArrowDown, ArrowUp, Check, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button, Card, Notice } from '@/components/ui'
import { errorMessage, post } from '@/lib/api'
import type { Section, Work } from '@/lib/types'
import { VisualCardsPreview } from './VisualCardsPreview'
import type { CXVisualCard, CXVisualCardPreview } from './cx-visual-cards-render'

type CompareBody = { left: string; right: string }
type ManualCardType = CXVisualCard['type']
type ManualCard = Omit<CXVisualCard, 'source_refs'> & { confirmed: boolean }
type ManualPreview = CXVisualCardPreview & {
  source_hash: string
  params_hash: string
  template_version: string
  warnings: string[]
}

function takeCodePoints(value: string, limit: number) {
  return Array.from(value).slice(0, limit).join('')
}

function sectionText(section: Section | undefined) {
  if (!section) return ''
  return takeCodePoints(section.key_point.trim() || section.content_md.trim(), 300)
}

function initialCards(sections: Section[], work: Work, selectedAssets: string[]): ManualCard[] {
  if (sections.length === 0) return []
  const accountForWorkImages = new Set(work.assets.filter((asset) => asset.mime.startsWith('image/')).map((asset) => asset.id))
  const validSelectedAssets = selectedAssets.filter((id) => accountForWorkImages.has(id)).slice(0, 20)
  const source = (section: Section) => [section.id]
  const card = (type: ManualCardType, section: Section, headline: string, body: string, asset_ids: string[] = []): ManualCard => ({
    card_id: `manual-${crypto.randomUUID()}`,
    type,
    section_ids: source(section),
    headline: takeCodePoints(headline.trim() || section.heading || '未命名卡片', 60),
    body,
    asset_ids,
    confirmed: false,
  })
  const first = sections[0]
  const last = sections[sections.length - 1]
  return [
    card('cover', first, work.title || first.heading || '封面', sectionText(first), validSelectedAssets),
    ...sections.map((section, index) => card('point', section, section.heading || `第 ${index + 1} 个要点`, sectionText(section))),
    card('end', last, '接下来', sectionText(last)),
  ]
}

function previewCard(card: ManualCard) {
  const { confirmed: _confirmed, ...value } = card
  return {
    ...value,
    source_refs: [
      ...card.section_ids.map((id) => `section:${id}`),
      ...card.asset_ids.map((id) => `asset:${id}`),
    ],
  }
}

function titleOf(type: ManualCardType) {
  return ({ cover: '封面', point: '要点', quote: '引用', compare: '对照', end: '结尾' })[type]
}

function cardIssue(card: ManualCard, work: Work, selectedSections: Section[]) {
  if (!card.headline.trim() || Array.from(card.headline).length > 60) return '标题须为 1–60 个 Unicode 码点。'
  if (card.asset_ids.some((id) => !work.assets.some((asset) => asset.id === id && asset.mime.startsWith('image/')))) return '图片来源已变化，请重新开始手工计划。'
  if (card.type === 'compare') {
    if (card.section_ids.length !== 2 || card.section_ids[0] === card.section_ids[1]) return '对照卡需要选择两个不同的来源段落。'
    if (typeof card.body === 'string' || !card.body.left.trim() || !card.body.right.trim()
      || Array.from(card.body.left).length > 150 || Array.from(card.body.right).length > 150) return '对照卡左右摘录各须为 1–150 个 Unicode 码点。'
    const left = selectedSections.find((section) => section.id === card.section_ids[0])
    const right = selectedSections.find((section) => section.id === card.section_ids[1])
    if (!left?.content_md.includes(card.body.left) || !right?.content_md.includes(card.body.right)) return '左右摘录必须分别逐字来自对应来源段落。'
    return ''
  }
  if (typeof card.body !== 'string' || !card.body.trim() || Array.from(card.body).length > 300) return '文案须为 1–300 个 Unicode 码点。'
  if (card.type === 'point' || card.type === 'quote') {
    if (card.section_ids.length !== 1) return '该卡片需要一个来源段落。'
    const source = selectedSections.find((section) => section.id === card.section_ids[0])
    if (!source) return '卡片来源不在本次选中的段落内。'
    if (card.type === 'quote' && !source.content_md.includes(card.body)) return '引用卡文案必须逐字来自来源段落。'
  } else if (card.section_ids.length < 1 || card.section_ids.some((id) => !selectedSections.some((section) => section.id === id))) {
    return '卡片来源不在本次选中的段落内。'
  }
  return ''
}

function snippet(section: Section | undefined, limit: number) {
  return takeCodePoints(section?.content_md.trim() ?? '', limit)
}

function changeType(card: ManualCard, type: ManualCardType, sections: Section[]): ManualCard {
  if (type === 'cover' || type === 'end') return card
  if (type === 'compare') {
    const selected = sections.slice(0, 2)
    return {
      ...card,
      type,
      section_ids: selected.map((section) => section.id),
      body: { left: snippet(selected[0], 100), right: snippet(selected[1], 100) },
      confirmed: false,
    }
  }
  const source = sections.find((section) => section.id === card.section_ids[0]) ?? sections[0]
  const body = type === 'quote' ? snippet(source, 120) : sectionText(source)
  return { ...card, type, section_ids: source ? [source.id] : [], body, confirmed: false }
}

function freshCard(sections: Section[]): ManualCard | null {
  const section = sections[0]
  if (!section) return null
  return {
    card_id: `manual-${crypto.randomUUID()}`,
    type: 'point',
    section_ids: [section.id],
    headline: section.heading || '新增要点',
    body: sectionText(section),
    asset_ids: [],
    confirmed: false,
  }
}

export function ManualVisualCards({
  work, selectedSections, selectedAssets, canWrite, template, ratio, dnaVersion,
}: {
  work: Work
  selectedSections: Section[]
  selectedAssets: string[]
  canWrite: boolean
  template: 'editorial' | 'swiss'
  ratio: '1:1' | '3:4' | '9:16'
  dnaVersion: number | null
}) {
  const [basisRevision, setBasisRevision] = useState(work.revision)
  const [cards, setCards] = useState(() => initialCards(selectedSections, work, selectedAssets))
  const [preview, setPreview] = useState<ManualPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const stale = basisRevision !== work.revision
  const assetCount = new Set(cards.flatMap((card) => card.asset_ids)).size
  const allConfirmed = cards.length >= 3 && cards.length <= 9 && cards.every((card) => card.confirmed && !cardIssue(card, work, selectedSections))

  useEffect(() => { setPreview(null) }, [template, ratio, dnaVersion])
  useEffect(() => { if (stale) setPreview(null) }, [stale])

  const editCard = (index: number, change: (card: ManualCard) => ManualCard) => {
    setCards((items) => items.map((card, cardIndex) => cardIndex === index ? { ...change(card), confirmed: false } : card))
    setPreview(null)
  }

  const moveCard = (index: number, offset: -1 | 1) => {
    const destination = index + offset
    if (destination < 1 || destination >= cards.length - 1) return
    const next = [...cards]
    const [moved] = next.splice(index, 1)
    next.splice(destination, 0, { ...moved, confirmed: false })
    setCards(next)
    setPreview(null)
  }

  const addCard = () => {
    if (cards.length >= 9) return
    const card = freshCard(selectedSections)
    if (!card) return
    setCards((items) => [...items.slice(0, -1), card, items[items.length - 1]])
    setPreview(null)
  }

  const previewManual = async () => {
    if (!canWrite || busy || stale || !allConfirmed) return
    setBusy(true)
    setError('')
    setPreview(null)
    try {
      const result = await post<ManualPreview>(`/works/${work.id}/cards/preview`, {
        basis_revision: basisRevision,
        template,
        ratio,
        dna_version: dnaVersion,
        cards: cards.map(previewCard),
      })
      if (result.basis_revision !== basisRevision || result.template !== template || result.ratio !== ratio || result.dna_version !== dnaVersion) {
        throw new Error('作品或组图参数已变化，未显示过期的手工预览。')
      }
      setPreview(result)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  const reset = () => {
    setCards(initialCards(selectedSections, work, selectedAssets))
    setBasisRevision(work.revision)
    setPreview(null)
    setError('')
  }

  return <div className="space-y-3 border-t border-mist-100 p-4" data-testid="manual-visual-plan">
    <div className="flex flex-wrap items-start gap-3">
      <div className="min-w-0 flex-1"><h3 className="text-[13px] font-semibold text-mist-800">手工组图计划</h3>
        <p className="mt-1 text-[10px] leading-relaxed text-mist-500">按当前选中的已保存段落生成封面、要点与结尾草稿。逐卡编辑并确认后只预览构建参数；此草稿只保存在当前界面，收起或离开页面后会清空，不保存到报告或作品。</p></div>
      <Button size="sm" variant="outline" icon={<RotateCcw className="size-3.5" />} disabled={!canWrite || busy} onClick={reset}>从当前作品重新开始</Button>
    </div>
    {selectedSections.length === 0 && <Notice tone="gamboge">请先选择至少一个已保存段落，再开始手工编排。</Notice>}
    {stale && <Notice tone="gamboge">作品修订已变化。为避免将旧内容当作当前来源，本次手工草稿已暂停预览；可重新开始以读取当前作品。</Notice>}
    <div className="flex items-center justify-between gap-2 text-[10px] text-mist-500"><span>{cards.length}/9 张 · {assetCount}/20 张图片 · 来源修订 {basisRevision}</span>
      <Button size="sm" variant="secondary" icon={<Plus className="size-3.5" />} disabled={!canWrite || busy || stale || cards.length >= 9 || selectedSections.length === 0} onClick={addCard}>新增要点卡</Button>
    </div>
    {cards.map((card, index) => {
      const issue = cardIssue(card, work, selectedSections)
      const sourceOptions = selectedSections
      const changeSource = (slot: 0 | 1, sectionId: string) => editCard(index, (current) => {
        if (current.type === 'compare') {
          const sectionIDs = [...current.section_ids]
          sectionIDs[slot] = sectionId
          const left = slot === 0 ? snippet(sourceOptions.find((section) => section.id === sectionId), 100) : current.body && typeof current.body !== 'string' ? current.body.left : ''
          const right = slot === 1 ? snippet(sourceOptions.find((section) => section.id === sectionId), 100) : current.body && typeof current.body !== 'string' ? current.body.right : ''
          return { ...current, section_ids: sectionIDs, body: { left, right } }
        }
        const source = sourceOptions.find((section) => section.id === sectionId)
        return { ...current, section_ids: [sectionId], body: current.type === 'quote' ? snippet(source, 120) : current.type === 'point' ? sectionText(source) : current.body }
      })
      return <Card key={card.card_id} className="p-3" data-testid={`manual-visual-card-${index}`}>
        <div className="mb-2 flex items-center gap-2"><span className="text-[11px] font-semibold">{index + 1}. {titleOf(card.type)}</span><span className="min-w-0 flex-1 truncate text-[10px] text-mist-400">{card.card_id}</span>
          {card.type !== 'cover' && card.type !== 'end' && <>
            <Button size="sm" variant="ghost" icon={<ArrowUp className="size-3.5" />} aria-label="上移卡片" disabled={!canWrite || busy || index <= 1} onClick={() => moveCard(index, -1)} />
            <Button size="sm" variant="ghost" icon={<ArrowDown className="size-3.5" />} aria-label="下移卡片" disabled={!canWrite || busy || index >= cards.length - 2} onClick={() => moveCard(index, 1)} />
            <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} aria-label="删除卡片" disabled={!canWrite || busy || cards.length <= 3} onClick={() => { setCards((items) => items.filter((_, cardIndex) => cardIndex !== index)); setPreview(null) }} />
          </>}
        </div>
        {card.type !== 'cover' && card.type !== 'end' && <label className="mb-2 block text-[10px] font-medium text-mist-500">卡片类型
          <select aria-label="卡片类型" className="mt-1 h-8 w-full rounded-md border border-mist-200 bg-white px-2" value={card.type}
            disabled={!canWrite || busy} onChange={(event) => editCard(index, (current) => changeType(current, event.target.value as ManualCardType, selectedSections))}>
            <option value="point">要点</option><option value="quote">引用</option><option value="compare" disabled={selectedSections.length < 2}>对照</option>
          </select>
        </label>}
        {card.type === 'compare' ? <div className="grid gap-2 sm:grid-cols-2">
          {([0, 1] as const).map((slot) => <label key={slot} className="block text-[10px] font-medium text-mist-500">{slot === 0 ? '左侧来源段落' : '右侧来源段落'}
            <select aria-label={slot === 0 ? '左侧来源段落' : '右侧来源段落'} value={card.section_ids[slot] ?? ''} disabled={!canWrite || busy} className="mt-1 h-8 w-full rounded-md border border-mist-200 bg-white px-2"
              onChange={(event) => changeSource(slot, event.target.value)}>{sourceOptions.map((section) => <option key={section.id} value={section.id}>{section.heading || `段落 ${section.position}`}</option>)}</select>
          </label>)}
        </div> : <label className="mb-2 block text-[10px] font-medium text-mist-500">来源段落
          <select aria-label="来源段落" value={card.section_ids[0] ?? ''} disabled={!canWrite || busy} className="mt-1 h-8 w-full rounded-md border border-mist-200 bg-white px-2"
            onChange={(event) => changeSource(0, event.target.value)}>{sourceOptions.map((section) => <option key={section.id} value={section.id}>{section.heading || `段落 ${section.position}`}</option>)}</select>
        </label>}
        <label className="block text-[10px] font-medium text-mist-500">标题
          <input aria-label="标题" value={card.headline} maxLength={120} disabled={!canWrite || busy} onChange={(event) => editCard(index, (current) => ({ ...current, headline: event.target.value }))} className="mt-1 h-8 w-full rounded-md border border-mist-200 px-2 text-[12px]" />
        </label>
        {typeof card.body === 'string' ? <label className="mt-2 block text-[10px] font-medium text-mist-500">{card.type === 'quote' ? '逐字摘录' : '文案'}
          <textarea aria-label={card.type === 'quote' ? '逐字摘录' : '文案'} rows={3} value={card.body} maxLength={600} disabled={!canWrite || busy} onChange={(event) => editCard(index, (current) => ({ ...current, body: event.target.value }))} className="mt-1 w-full resize-y rounded-md border border-mist-200 p-2 text-[12px]" />
        </label> : <div className="mt-2 grid gap-2 sm:grid-cols-2">{(['left', 'right'] as const).map((side) => <label key={side} className="block text-[10px] font-medium text-mist-500">{side === 'left' ? '左侧摘录' : '右侧摘录'}
          <textarea aria-label={side === 'left' ? '左侧摘录' : '右侧摘录'} rows={3} value={(card.body as CompareBody)[side]} maxLength={300} disabled={!canWrite || busy} onChange={(event) => editCard(index, (current) => ({ ...current, body: { ...(typeof current.body === 'string' ? { left: '', right: '' } : current.body), [side]: event.target.value } }))} className="mt-1 w-full resize-y rounded-md border border-mist-200 p-2 text-[12px]" />
        </label>)}</div>}
        <fieldset disabled={!canWrite || busy} className="mt-2 rounded-md border border-mist-100 p-2"><legend className="px-1 text-[10px] font-medium text-mist-500">使用本作品图片</legend>
          {work.assets.filter((asset) => asset.mime.startsWith('image/')).length === 0 ? <span className="text-[10px] text-mist-400">无本作品图片</span> : <div className="flex flex-wrap gap-x-3 gap-y-1">
            {work.assets.filter((asset) => asset.mime.startsWith('image/')).map((asset) => <label key={asset.id} className="flex items-center gap-1 text-[10px] text-mist-500">
              <input type="checkbox" checked={card.asset_ids.includes(asset.id)} disabled={!card.asset_ids.includes(asset.id) && assetCount >= 20} onChange={(event) => editCard(index, (current) => ({ ...current, asset_ids: event.target.checked ? [...current.asset_ids, asset.id] : current.asset_ids.filter((id) => id !== asset.id) }))} />
              {asset.alt_text || `${asset.width}×${asset.height} 图片`}
            </label>)}
          </div>}
        </fieldset>
        {issue && <p role="status" className="mt-2 text-[10px] text-amber-700">{issue}</p>}
        <div className="mt-3 flex justify-end"><Button size="sm" variant={card.confirmed ? 'outline' : 'human'} icon={<Check className="size-3.5" />} disabled={!canWrite || busy || !!issue} onClick={() => setCards((items) => items.map((item, cardIndex) => cardIndex === index ? { ...item, confirmed: !item.confirmed } : item))}>{card.confirmed ? '撤销确认' : '确认此卡'}</Button></div>
      </Card>
    })}
    <div className="flex flex-wrap items-center justify-end gap-2"><span className="mr-auto text-[10px] text-mist-500">每张卡分别确认；未确认、来源错误或作品已变化时不能预览。</span>
      <Button size="sm" variant="primary" loading={busy} disabled={!canWrite || busy || stale || !allConfirmed} onClick={() => void previewManual()}>预览手工计划</Button>
    </div>
    {error && <Notice tone="red">{error}</Notice>}
    {preview && <div data-testid="manual-cards-params-preview" className="space-y-3 rounded-lg border border-ink-200 bg-ink-50/40 p-3">
      <div><p className="text-[12px] font-semibold text-ink-800">手工计划构建参数预览</p><p className="mt-1 break-all text-[10px] text-mist-500">source {preview.source_hash} · params {preview.params_hash}</p></div>
      {preview.cards.map((card, index) => <div key={card.card_id} className="rounded-md border border-mist-200 bg-white p-2 text-[11px]"><strong>{index + 1}. {titleOf(card.type)} · {card.headline}</strong>
        <p className="mt-1 whitespace-pre-wrap">{typeof card.body === 'string' ? card.body : `${card.body.left} / ${card.body.right}`}</p>
        <p className="mt-1 text-[10px] text-mist-400">来源：{card.source_refs.join('、')}</p></div>)}
      {preview.warnings.map((warning, index) => <Notice key={index} tone="gamboge">{warning}</Notice>)}
      <Notice tone="gamboge">手工计划只保存在当前界面；本次只读预览不保存报告、作品或 build，也不生成文件、ZIP 或下载。</Notice>
      <VisualCardsPreview preview={preview} work={work} />
    </div>}
  </div>
}
