import { ArrowDown, ArrowUp, Check, Pencil, RefreshCw, Sparkles, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button, Card, Notice } from '@/components/ui'
import { errorMessage, get, patch, post } from '@/lib/api'
import type { Asset, CXVisualDNAVersion, Section, Work } from '@/lib/types'
import { ManualVisualCards } from './ManualVisualCards'
import { VisualCardsPreview } from './VisualCardsPreview'

type CompareBody = { left: string; right: string }
type CardBody = string | CompareBody

interface VisualPlanCard {
  card_id: string
  type: 'cover' | 'point' | 'quote' | 'compare' | 'end'
  section_ids: string[]
  headline: string
  body: CardBody
  asset_ids: string[]
  source_refs: string[]
  confirmed: boolean
  edited: boolean
}

interface VisualPlanSource {
  ref: string
  kind: string
  id: string
  revision: number | null
  as_of_at: string | null
  state: string
  purpose: string
}

interface VisualPlanReport {
  diagnosis_id: string
  work_id: string
  input_hash: string
  template: 'editorial' | 'swiss'
  ratio: '1:1' | '3:4' | '9:16'
  dna_version: number | null
  visual_dna: { version: number; tokens_hash: string } | null
  section_ids: string[]
  asset_ids: string[]
  cards: VisualPlanCard[]
  coverage: { state: string; selected_sections: number; covered_sections: number; uncovered_sections: string[] }
  missing_assets: string[]
  warnings: string[]
  cx_basis: { work_revision: number | null; assembled_at: string; input_hash: string; sources: VisualPlanSource[]; omitted: { ref: string; reason: string }[] }
  plan_complete: boolean
  ai_call_id?: string
  task_type: string
  model: string
  prompt_version: string
  stale: boolean
  reused: boolean
  created_at: string
  result_revision: number
}

interface VisualPlanPage { items: VisualPlanReport[]; next_cursor: string | null }

interface VisualPlanBuildPreview {
  source_hash: string
  params_hash: string
  basis_revision: number
  template: 'editorial' | 'swiss'
  ratio: '1:1' | '3:4' | '9:16'
  dna_version: number | null
  template_version: string
  cards: Array<Omit<VisualPlanCard, 'confirmed' | 'edited'>>
  warnings: string[]
}

function cloneCards(cards: VisualPlanCard[]) {
  return cards.map((card) => ({ ...card, section_ids: [...card.section_ids], asset_ids: [...card.asset_ids], source_refs: [...card.source_refs], body: typeof card.body === 'string' ? card.body : { ...card.body } }))
}

function cardTitle(type: VisualPlanCard['type']) {
  return ({ cover: '封面', point: '要点', quote: '引用', compare: '对照', end: '结尾' })[type]
}

function sourceName(ref: string, sections: Section[], assets: Asset[]) {
  if (ref.startsWith('section:')) return sections.find((section) => section.id === ref.slice('section:'.length))?.heading || `段落 ${ref.slice('section:'.length, 8)}`
  if (ref.startsWith('asset:')) return assets.find((asset) => asset.id === ref.slice('asset:'.length))?.alt_text || `图片 ${ref.slice('asset:'.length, 8)}`
  return ref
}

export function VisualPlanPanel({ work, canWrite }: { work: Work; canWrite: boolean }) {
  const [selectedSections, setSelectedSections] = useState<string[]>(() => work.sections.slice(0, 7).map((section) => section.id))
  const [selectedAssets, setSelectedAssets] = useState<string[]>([])
  const [template, setTemplate] = useState<'editorial' | 'swiss'>('editorial')
  const [ratio, setRatio] = useState<'1:1' | '3:4' | '9:16'>('3:4')
  const [visualDNA, setVisualDNA] = useState<CXVisualDNAVersion | null>(null)
  const [selectedDNAVersion, setSelectedDNAVersion] = useState<number | null>(null)
  const [dnaLoadError, setDNALoadError] = useState('')
  const [report, setReport] = useState<VisualPlanReport | null>(null)
  const [candidate, setCandidate] = useState<VisualPlanReport | null>(null)
  const [history, setHistory] = useState<VisualPlanReport[]>([])
  const [cards, setCards] = useState<VisualPlanCard[]>([])
  const [buildPreview, setBuildPreview] = useState<VisualPlanBuildPreview | null>(null)
  const [manualOpen, setManualOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState('')
  const requestController = useRef<AbortController | null>(null)
  const initialized = useRef(work.sections.length > 0)

  useEffect(() => {
    const controller = new AbortController()
    void get<CXVisualDNAVersion>(`/accounts/${work.account_id}/visual-dna`, { signal: controller.signal })
      .then((current) => {
        setVisualDNA(current)
        setDNALoadError('')
        if (current.version > 0 && current.tokens) {
          setSelectedDNAVersion(current.version)
          setTemplate(current.tokens.card_template_default)
          setRatio(current.tokens.card_ratio_default)
        }
      })
      .catch((reason) => { if (!controller.signal.aborted) setDNALoadError(errorMessage(reason)) })
    return () => controller.abort()
  }, [work.account_id])

  useEffect(() => {
    if (!initialized.current && work.sections.length) {
      setSelectedSections(work.sections.slice(0, 7).map((section) => section.id))
      initialized.current = true
    }
  }, [work.sections])

  useEffect(() => {
    const controller = new AbortController()
    void get<VisualPlanPage>(`/works/${work.id}/diagnoses?kind=visual_plan`, { signal: controller.signal })
      .then((page) => {
        setHistory(page.items)
        if (page.items[0]) {
          setReport(page.items[0])
          setCards(cloneCards(page.items[0].cards))
        }
      })
      .catch((reason) => { if (!controller.signal.aborted) setError(errorMessage(reason)) })
    return () => controller.abort()
  }, [work.id])

  const saveCards = async (nextCards: VisualPlanCard[]) => {
    if (!report || saving || !canWrite) return
    setSaving(true)
    setError('')
    try {
      const saved = await patch<VisualPlanReport>(`/diagnoses/${report.diagnosis_id}/visual-plan`, {
        expected_revision: report.result_revision,
        cards: nextCards.map(({ card_id, type, section_ids, headline, body, asset_ids, source_refs, confirmed }) => ({
          card_id, type, section_ids, headline, body, asset_ids, source_refs, confirmed,
        })),
      })
      setReport(saved)
      setCards(cloneCards(saved.cards))
      setDirty(false)
      setCandidate(null)
      setBuildPreview(null)
      setHistory((items) => [saved, ...items.filter((item) => item.diagnosis_id !== saved.diagnosis_id)])
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setSaving(false)
    }
  }

  const generate = async (regenerate = false) => {
    if (!canWrite || busy || selectedSections.length === 0 || selectedSections.length > 7) return
    const controller = new AbortController()
    requestController.current = controller
    setBusy(true)
    setError('')
    try {
      const result = await post<VisualPlanReport>(`/works/${work.id}/cards/suggest`, {
        basis_revision: work.revision,
        section_ids: selectedSections,
        asset_ids: selectedAssets,
        template,
        ratio,
        dna_version: selectedDNAVersion,
        ...(regenerate ? { nonce: crypto.randomUUID() } : {}),
      }, controller.signal)
      setHistory((items) => [result, ...items.filter((item) => item.diagnosis_id !== result.diagnosis_id)])
      if (!report) {
        setReport(result)
        setCards(cloneCards(result.cards))
        setCandidate(null)
        setDirty(false)
        setBuildPreview(null)
      } else {
        // A new basis is still only a candidate; never replace the visible plan automatically.
        setCandidate(result)
      }
    } catch (reason) {
      if (!(reason instanceof DOMException && reason.name === 'AbortError')) setError(errorMessage(reason))
    } finally {
      if (requestController.current === controller) requestController.current = null
      setBusy(false)
    }
  }

  const editCard = (index: number, change: (card: VisualPlanCard) => VisualPlanCard) => {
    setCards((items) => items.map((card, i) => i === index ? { ...change(card), confirmed: false, edited: true } : card))
    setDirty(true)
    setBuildPreview(null)
  }

  const moveCard = (index: number, offset: -1 | 1) => {
    const target = index + offset
    if (target < 0 || target >= cards.length) return
    const next = [...cards]
    const [moved] = next.splice(index, 1)
    next.splice(target, 0, { ...moved, confirmed: false, edited: true })
    setCards(next)
    setDirty(true)
    setBuildPreview(null)
  }

  const deleteCard = (index: number) => {
    if (cards[index]?.type === 'cover' || cards[index]?.type === 'end') return
    setCards((items) => items.filter((_, i) => i !== index))
    setDirty(true)
    setBuildPreview(null)
  }

  const replaceWithCandidate = (index: number) => {
    if (!candidate || !report || index >= candidate.cards.length || cards[index]?.confirmed || cards[index]?.edited) return
    const fresh = candidate.cards[index]
    editCard(index, (current) => ({ ...fresh, card_id: current.card_id, confirmed: false, edited: true }))
  }

  const chooseHistory = (item: VisualPlanReport) => {
    if (dirty) return
    setReport(item)
    setCards(cloneCards(item.cards))
    setCandidate(null)
    setBuildPreview(null)
    setError('')
  }

  const previewBuildPlan = async () => {
    if (!report || !report.plan_complete || report.stale || dirty || saving || busy || !canWrite || cards.length === 0 || cards.some((card) => !card.confirmed)) return
    setError('')
    setBuildPreview(null)
    setSaving(true)
    try {
      const preview = await post<VisualPlanBuildPreview>(`/works/${work.id}/cards/preview`, {
        basis_revision: work.revision,
        template: report.template,
        ratio: report.ratio,
        dna_version: report.dna_version,
        visual_plan_id: report.diagnosis_id,
        expected_result_revision: report.result_revision,
      })
      setBuildPreview(preview)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setSaving(false)
    }
  }

  const bySection = (id: string) => work.sections.find((section) => section.id === id)

  return (
    <section className="mt-6" data-testid="visual-plan-panel">
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-start gap-3 border-b border-mist-100 p-4">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-ink-50 text-ink-700"><Sparkles className="size-4" /></div>
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-[15px] font-bold text-mist-900">AI 组图计划</h2>
            <p className="mt-1 text-[12px] leading-relaxed text-mist-500">只分析你选中的已保存段落与图片元数据；结果可编辑、逐卡确认，不会写入作品或生成图片。</p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant={manualOpen ? 'outline' : 'ghost'} icon={<Pencil className="size-3.5" />}
              disabled={!manualOpen && (!canWrite || selectedSections.length === 0)} onClick={() => setManualOpen((value) => !value)}>
              {manualOpen ? '收起手工编排' : '手工编排'}
            </Button>
            {busy
              ? <Button size="sm" variant="ghost" onClick={() => requestController.current?.abort()}>取消生成</Button>
              : <Button size="sm" variant="secondary" disabled={!canWrite || selectedSections.length === 0} loading={busy} icon={report ? <RefreshCw className="size-3.5" /> : <Sparkles className="size-3.5" />}
                  onClick={() => void generate(!!report)}> {report ? '重新生成候选' : 'AI 编排'} </Button>}
          </div>
        </div>

        <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(240px,0.7fr)]">
          <div className="space-y-4">
            <fieldset disabled={!canWrite || busy || saving || manualOpen} className="space-y-2">
              <legend className="mb-2 text-[12px] font-semibold text-mist-700">选择段落（最多 7 个）</legend>
              {work.sections.map((section) => (
                <label key={section.id} className="flex cursor-pointer items-start gap-2 rounded-lg border border-mist-100 p-2.5 text-[12px]">
                  <input type="checkbox" checked={selectedSections.includes(section.id)} disabled={!selectedSections.includes(section.id) && selectedSections.length >= 7}
                    onChange={(event) => setSelectedSections((items) => event.target.checked ? [...items, section.id] : items.filter((id) => id !== section.id))} />
                  <span><strong className="font-medium text-mist-800">{section.heading || `段落 ${section.position}`}</strong>
                    <span className="ml-2 text-mist-400">修订 {section.revision} · {section.content_md.trim().length} 字</span>
                  </span>
                </label>
              ))}
              {work.sections.length === 0 && <p className="text-xs text-mist-400">先保存至少一个段落，再生成组图计划。</p>}
            </fieldset>

            <fieldset disabled={!canWrite || busy || saving} className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <label className="text-[11px] font-medium text-mist-600">视觉 DNA
                <select aria-label="视觉 DNA" className="mt-1 h-9 w-full rounded-md border border-mist-200 bg-white px-2 text-[12px]"
                  value={selectedDNAVersion === null ? '' : String(selectedDNAVersion)} onChange={(event) => {
                    const version = event.target.value ? Number(event.target.value) : null
                    setSelectedDNAVersion(version)
                    if (version !== null && visualDNA?.version === version && visualDNA.tokens) {
                      setTemplate(visualDNA.tokens.card_template_default)
                      setRatio(visualDNA.tokens.card_ratio_default)
                    }
                  }}>
                  <option value="">普通模板，不使用视觉 DNA</option>
                  {visualDNA?.version && visualDNA.tokens && <option value={String(visualDNA.version)}>使用当前视觉 DNA v{visualDNA.version}</option>}
                </select>
              </label>
              <label className="text-[11px] font-medium text-mist-600">模板
                <select className="mt-1 h-9 w-full rounded-md border border-mist-200 bg-white px-2 text-[12px]" value={template} onChange={(event) => setTemplate(event.target.value as 'editorial' | 'swiss')}>
                  <option value="editorial">Editorial · 大标题</option><option value="swiss">Swiss · 网格数字</option>
                </select>
              </label>
              <label className="text-[11px] font-medium text-mist-600">比例
                <select className="mt-1 h-9 w-full rounded-md border border-mist-200 bg-white px-2 text-[12px]" value={ratio} onChange={(event) => setRatio(event.target.value as '1:1' | '3:4' | '9:16')}>
                  <option value="3:4">3:4 · 默认</option><option value="1:1">1:1</option><option value="9:16">9:16</option>
                </select>
              </label>
              <div className="text-[11px] font-medium text-mist-600">图片来源
                <div className="mt-1 max-h-24 space-y-1 overflow-y-auto rounded-md border border-mist-100 p-2">
                  {work.assets.length ? work.assets.map((asset) => <label key={asset.id} className="flex items-center gap-2 font-normal">
                    <input type="checkbox" checked={selectedAssets.includes(asset.id)} disabled={!canWrite || busy || saving || manualOpen || (!selectedAssets.includes(asset.id) && selectedAssets.length >= 20)}
                      onChange={(event) => setSelectedAssets((items) => event.target.checked ? [...items, asset.id] : items.filter((id) => id !== asset.id))} />
                    <span className="truncate">{asset.alt_text || `${asset.width}×${asset.height} 图片`}</span>
                  </label>) : <span className="text-mist-400">无图片资产</span>}
                </div>
              </div>
            </fieldset>
          </div>

          <div className="space-y-3">
            <div className="rounded-lg bg-mist-50 p-3 text-[11px] leading-relaxed text-mist-600">
              <p className="font-semibold text-mist-700">来源说明</p>
              <p className="mt-1">图片只提供 ID、alt、尺寸和格式；模型没有看图。{selectedDNAVersion === null ? '本次不使用视觉 DNA。' : `本次使用账号视觉 DNA v${selectedDNAVersion}；模型仅收到令牌文本，未收到 Logo 图片。`}quote 与 compare 会按原文精确校验。</p>
              {dnaLoadError && <p className="mt-1 text-amber-700">读取账号视觉 DNA 失败，仍可按普通模板生成：{dnaLoadError}</p>}
              {report && <p className="mt-2">模型：{report.model || '未记录'} · 提示词：{report.prompt_version} · 来源修订：{report.cx_basis.work_revision ?? '未知'}</p>}
            </div>
            {history.length > 0 && <div>
              <p className="mb-1 text-[11px] font-semibold text-mist-600">历史计划</p>
              <div className="flex flex-wrap gap-1.5">{history.slice(0, 8).map((item) => <button key={item.diagnosis_id} type="button" onClick={() => chooseHistory(item)} disabled={dirty}
                className={`rounded-full border px-2 py-1 text-[10px] ${report?.diagnosis_id === item.diagnosis_id ? 'border-ink-300 bg-ink-50 text-ink-700' : 'border-mist-200 text-mist-500'}`}>
                {new Date(item.created_at).toLocaleString()} {item.stale ? '· 已过期' : ''}
              </button>)}</div>
            </div>}
            {report && <div className="flex items-center gap-2 text-[10px] text-mist-400"><span className={report.stale ? 'text-amber-700' : 'text-emerald-700'}>{report.stale ? '来源已变化，历史保留' : '来源有效'}</span><span>·</span><span>{report.coverage.covered_sections}/{report.coverage.selected_sections} 段</span><span>·</span><span>{report.cards.length} 张</span></div>}
          </div>
        </div>

        {error && <div className="px-4 pb-3"><Notice tone="red">{error}</Notice></div>}
        {manualOpen && <ManualVisualCards work={work} selectedSections={work.sections.filter((section) => selectedSections.includes(section.id))}
          selectedAssets={selectedAssets} canWrite={canWrite} template={template} ratio={ratio} dnaVersion={selectedDNAVersion} />}
        {report && <div className="space-y-3 border-t border-mist-100 p-4" data-testid="visual-plan-report">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[13px] font-semibold text-mist-800">卡片计划</h3>
            <span className="text-[10px] text-mist-400">{report.plan_complete ? '内容覆盖完整' : '部分覆盖，只作编辑建议；构建仍受检查门禁限制'}</span>
            {report.visual_dna && <span className="text-[10px] text-ink-600">视觉 DNA v{report.visual_dna.version}</span>}
            {dirty && <span className="text-[10px] font-medium text-amber-700">未保存修改</span>}
            {dirty && <Button size="sm" variant="primary" className="ml-auto" loading={saving} disabled={!canWrite || saving} onClick={() => void saveCards(cards)}>保存计划</Button>}
            {!dirty && <Button size="sm" variant="outline" className="ml-auto" loading={saving} disabled={!canWrite || saving || busy || !report.plan_complete || report.stale || cards.length === 0 || cards.some((card) => !card.confirmed)} onClick={() => void previewBuildPlan()}>预览构建参数</Button>}
          </div>
          {report.warnings.map((warning, index) => <Notice key={index} tone="gamboge">{warning}</Notice>)}
          {report.missing_assets.length > 0 && <Notice tone="gamboge">缺图需求：{report.missing_assets.join('；')}</Notice>}
          {report.coverage.uncovered_sections.length > 0 && <Notice tone="gamboge">未覆盖段落：{report.coverage.uncovered_sections.map((id) => bySection(id)?.heading || id.slice(0, 8)).join('、')}</Notice>}
          {candidate && <div className="rounded-lg border border-ink-200 bg-ink-50/50 p-3" data-testid="visual-plan-candidate">
            <div className="flex items-center gap-2"><p className="text-[12px] font-semibold text-ink-800">新生成候选 · 逐卡比较</p><Button size="sm" variant="ghost" className="ml-auto" disabled={!canWrite || dirty || saving} onClick={() => { setReport(candidate); setCards(cloneCards(candidate.cards)); setCandidate(null); setDirty(false) }}>切换为新计划</Button></div>
            <div className="mt-2 space-y-2">{candidate.cards.map((fresh, index) => {
              const current = cards[index]
              const protectedCard = !!current && (current.confirmed || current.edited)
              return <div key={fresh.card_id} className="flex items-start gap-2 rounded-md border border-ink-100 bg-white p-2 text-[11px]">
                <div className="min-w-0 flex-1"><strong>{index + 1}. {fresh.headline}</strong><p className="mt-0.5 text-mist-500">{typeof fresh.body === 'string' ? fresh.body : `${fresh.body.left} / ${fresh.body.right}`}</p></div>
                <Button size="sm" variant="outline" disabled={!canWrite || !current || protectedCard || dirty || saving} onClick={() => replaceWithCandidate(index)}>{protectedCard ? '保留已确认/修改卡' : '替换当前卡'}</Button>
              </div>
            })}</div>
          </div>}
          {cards.map((card, index) => (
            <Card key={card.card_id} className="p-3" data-testid={`visual-plan-card-${index}`}>
              <div className="mb-2 flex items-center gap-2">
                <span className="rounded-full bg-mist-100 px-2 py-0.5 text-[10px] font-semibold text-mist-600">{index + 1} · {cardTitle(card.type)}</span>
                {card.confirmed && <span className="text-[10px] text-emerald-700">已逐卡确认</span>}
                {card.edited && <span className="text-[10px] text-amber-700">人工修改</span>}
                <div className="ml-auto flex gap-1">
                  <Button size="sm" variant="ghost" icon={<ArrowUp className="size-3.5" />} disabled={!canWrite || saving || index === 0 || card.type === 'cover'} onClick={() => moveCard(index, -1)} aria-label="上移卡片" />
                  <Button size="sm" variant="ghost" icon={<ArrowDown className="size-3.5" />} disabled={!canWrite || saving || index === cards.length - 1 || card.type === 'end'} onClick={() => moveCard(index, 1)} aria-label="下移卡片" />
                  {card.type !== 'cover' && card.type !== 'end' && <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} disabled={!canWrite || saving} onClick={() => deleteCard(index)} aria-label="删除卡片" />}
                </div>
              </div>
              <label className="block text-[10px] font-medium text-mist-500">标题
                <input value={card.headline} maxLength={60} disabled={!canWrite || saving} onChange={(event) => editCard(index, (current) => ({ ...current, headline: event.target.value }))}
                  className="mt-1 h-9 w-full rounded-md border border-mist-200 px-2 text-[12px] text-mist-800" />
              </label>
              {typeof card.body === 'string' ? <label className="mt-2 block text-[10px] font-medium text-mist-500">文案
                <textarea value={card.body} maxLength={300} rows={3} disabled={!canWrite || saving} onChange={(event) => editCard(index, (current) => ({ ...current, body: event.target.value }))}
                  className="mt-1 w-full resize-y rounded-md border border-mist-200 p-2 text-[12px] leading-relaxed text-mist-800" />
              </label> : <div className="mt-2 grid gap-2 sm:grid-cols-2">{(['left', 'right'] as const).map((side) => <label key={side} className="block text-[10px] font-medium text-mist-500">{side === 'left' ? '左侧摘录' : '右侧摘录'}
                <textarea value={(card.body as CompareBody)[side]} maxLength={150} rows={3} disabled={!canWrite || saving} onChange={(event) => editCard(index, (current) => ({ ...current, body: { ...(typeof current.body === 'string' ? { left: '', right: '' } : current.body), [side]: event.target.value } }))}
                  className="mt-1 w-full resize-y rounded-md border border-mist-200 p-2 text-[12px] leading-relaxed text-mist-800" />
              </label>)}</div>}
              <div className="mt-2 flex flex-wrap items-center gap-1 text-[10px] text-mist-400">
                <span>来源：</span>{card.source_refs.map((ref) => <span key={ref} className="rounded bg-mist-50 px-1.5 py-0.5">{sourceName(ref, work.sections, work.assets)}</span>)}
              </div>
              <div className="mt-3 flex justify-end">
                <Button size="sm" variant={card.confirmed ? 'outline' : 'human'} icon={<Check className="size-3.5" />} disabled={!canWrite || saving || dirty}
                  onClick={() => { const next = cloneCards(cards); next[index].confirmed = !next[index].confirmed; void saveCards(next) }}>
                  {card.confirmed ? '撤销确认' : '确认此卡'}
                </Button>
              </div>
            </Card>
          ))}
          {report.cards.some((card) => card.confirmed) && <Notice tone="ink">卡片确认只记录你的逐项审核；本阶段不会写入 options.cards，也不会触发构建或发布。</Notice>}
          <div className="text-[10px] text-mist-400">报告 {report.diagnosis_id} · input {report.input_hash.slice(0, 12)}… · 生成于 {new Date(report.created_at).toLocaleString()} · {report.ai_call_id ? `调用 ${report.ai_call_id}` : '无模型调用回执'}</div>
          {buildPreview && <div className="space-y-3 rounded-lg border border-ink-200 bg-ink-50/40 p-3" data-testid="cards-build-preview">
            <div><p className="text-[12px] font-semibold text-ink-800">构建参数预览</p><p className="mt-1 text-[10px] text-mist-500">{buildPreview.template} · {buildPreview.ratio} · {buildPreview.dna_version === null ? '未使用视觉 DNA' : `视觉 DNA v${buildPreview.dna_version}`} · {buildPreview.template_version}</p></div>
            {buildPreview.cards.map((card, index) => <div key={card.card_id} className="rounded-md border border-mist-200 bg-white p-2 text-[11px]">
              <strong>{index + 1}. {cardTitle(card.type)} · {card.headline}</strong><p className="mt-1 whitespace-pre-wrap text-mist-600">{typeof card.body === 'string' ? card.body : `${card.body.left} / ${card.body.right}`}</p>
              <p className="mt-1 text-[10px] text-mist-400">来源：{card.source_refs.map((ref) => sourceName(ref, work.sections, work.assets)).join('、')}</p>
            </div>)}
            {buildPreview.warnings.map((warning, index) => <Notice key={index} tone="gamboge">{warning}</Notice>)}
            <p className="break-all text-[10px] text-mist-400">source {buildPreview.source_hash} · params {buildPreview.params_hash}</p>
            <Notice tone="gamboge">这是只读构建输入预览；未创建构建任务或文件。组图渲染与隐私门禁通过前，仍不能导出 ZIP。</Notice>
            <VisualCardsPreview preview={buildPreview} work={work} />
          </div>}
        </div>}
      </Card>
    </section>
  )
}
