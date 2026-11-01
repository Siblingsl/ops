import { Loader2, Sparkles, Star } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { RefsNote, sendFeedback } from '@/components/refs'
import { Badge, Button, Card, cn, Field, Input, Notice, Textarea } from '@/components/ui'
import { aiError } from '@/lib/ai-error'
import { ApiError, errorMessage, get, patch, post, put } from '@/lib/api'
import { type AIRefs, parseTopics, runeLen } from '@/lib/format'
import type { Profile, Work } from '@/lib/types'
import { useWorkCmd } from '@/lib/v3'
import { TagSuggest } from './editor-tools'
import { WorkConflictDialog } from './section-save-dialogs'
import { scoreTitleRules, type TitleRuleResult } from './editor-title-diagnosis'
import { useFlushAll, useRegisterFlush } from './work-save'

interface TitleCand { text: string; style: string; chars: number; over_limit: boolean; features: string[]; strong_hits: string[]; call?: string; idx?: number }
interface TitleResp { titles: TitleCand[]; refs: AIRefs; ai_call_id: string; max_chars: number; strong_features: string[] }

interface TitleDiagnosisFinding { dimension: string; severity: string; evidence: string; span: { start: number; end: number; unit: string } | null; section_id?: string; message: string; suggestion: string }
interface TitleDiagnosis {
  title: string
  input_scope: 'saved' | 'unsaved'
  platform: string
  basis_revision: number
  rules_version: string
  rule_score: number
  rule_max: number
  rule_dimensions: { dimensions: TitleRuleResult['dimensions'] }
  ai_score: number | null
  ai_max: number
  score: number | null
  ai_partial: boolean
  ai_status: string
  coverage: { rules: string; ai: string }
  ai_dimensions: Array<{ key: string; score: number; evidence: string }>
  findings: TitleDiagnosisFinding[]
  candidates: string[]
  sources: { work_id: string; work_revision: number; work_updated_at?: string; assembled_at?: string; sections: Array<{ id: string; revision: number; updated_at?: string }>; positioning_hash: string; positioning_updated_at?: string; missing: string[] }
}
interface TitleDiagnosisReport { diagnosis_id: string; work_id: string; input_hash: string; result: TitleDiagnosis; ai_call_id?: string; model: string; prompt_version: string; stale: boolean; reused: boolean; created_at: string; result_revision: number }

// ---------- 标题与摘要 ----------

export function TitleCard({ work, setWork, readOnly, hidden = false }: { work: Work; setWork: (w: Work) => void; readOnly: boolean; hidden?: boolean }) {
  const [conflict, setConflict] = useState<{ server: Work; body: Record<string, unknown> } | null>(null)
  const wx = work.platform === 'wechat_mp'
  const toutiao = work.platform === 'toutiao'
  const internalName = toutiao && work.content_format === 'micro_post'
  const titleMax = wx ? 32 : toutiao ? 0 : 20
  const [title, setTitle] = useState(work.title)
  const [summary, setSummary] = useState(work.summary)
  const [topics, setTopics] = useState(work.topics.map((t) => '#' + t).join(' '))
  const [titles, setTitles] = useState<TitleCand[]>([])
  const [titleDiagnosis, setTitleDiagnosis] = useState<TitleDiagnosisReport | null>(null)
  const [titleHistory, setTitleHistory] = useState<TitleDiagnosisReport[]>([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const [diagnosisUndo, setDiagnosisUndo] = useState<string | null>(null)
  const [localRules, setLocalRules] = useState<TitleRuleResult | null>(null)
  const [titleRefs, setTitleRefs] = useState<AIRefs | null>(null)
  const [titleCall, setTitleCall] = useState<string | null>(null)
  const [strong, setStrong] = useState<string[]>([])
  const toCand = (f: { text: string; style: string }): TitleCand => ({ ...f, chars: runeLen(f.text), over_limit: titleMax > 0 && runeLen(f.text) > titleMax, features: [], strong_hits: [] })
  const favs = (work.title_favorites ?? []).map(toCand)
  const [rewriting, setRewriting] = useState<string | null>(null)
  const [busy, setBusy] = useState<'t' | 's' | 'd' | null>(null)
  const titleDiagnosisAbort = useRef<AbortController | null>(null)
  const titleDiagnosisFocus = useRef(false)
  const titleBlurTimer = useRef<number>()
  const diagnosisBusy = busy === 'd'
  const flushAll = useFlushAll()
  const profileQuery = useQuery({ queryKey: ['account-profile', work.account_id], queryFn: () => get<Profile>(`/accounts/${work.account_id}/profile`) })
  const positioningTags = profileQuery.data?.positioning_tags ?? []
  const titleRuleLabels: Record<string, string> = { length: '平台长度', keywords: '定位关键词', specificity: '具体性', curiosity: '好奇心', cleanliness: '标题干净度', structure: '结构' }
  const titleInput = useRef(title)
  titleInput.current = title
  const saveFavs = async (items: { text: string; style: string }[]) => {
    try {
      const list = await put<{ text: string; style: string }[]>(`/works/${work.id}/title-favorites`, { items })
      setWork({ ...work, title_favorites: list })
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  useEffect(() => {
    const key = `ops.title-favs.${work.id}`
    const old = localStorage.getItem(key)
    if (!old || readOnly) return
    localStorage.removeItem(key)
    const items = (JSON.parse(old) as TitleCand[]).map((t) => ({ text: t.text, style: t.style }))
    if (items.length && !(work.title_favorites ?? []).length) void saveFavs(items)
  }, [work.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const toggleFav = (t: TitleCand) => {
    const cur = work.title_favorites ?? []
    void saveFavs(cur.some((f) => f.text === t.text) ? cur.filter((f) => f.text !== t.text) : [...cur, { text: t.text, style: t.style }])
  }
  const rewriteOne = async (base: string) => {
    setRewriting(base)
    try {
      const r = await post<TitleResp>(`/works/${work.id}/titles`, { base })
      setTitles((prev) => {
        const i = prev.findIndex((x) => x.text === base)
        const extra = r.titles.map((x, k) => ({ ...x, call: r.ai_call_id, idx: k })).filter((x) => !prev.some((p) => p.text === x.text))
          .map((x) => ({ ...x, style: `${x.style}（改写自候选）` }))
        return i < 0 ? [...prev, ...extra] : [...prev.slice(0, i + 1), ...extra, ...prev.slice(i + 1)]
      })
      setStrong(r.strong_features ?? [])
    } catch (e) {
      aiError(e, '改写标题', () => rewriteOne(base))
    } finally {
      setRewriting(null)
    }
  }
  useEffect(() => { setTitle(work.title); setSummary(work.summary); setTopics(work.topics.map((t) => '#' + t).join(' ')) }, [work.title, work.summary, work.topics])
  useEffect(() => {
    if (!title.trim() || internalName) { setLocalRules(null); return }
    const timer = window.setTimeout(() => setLocalRules(scoreTitleRules(work.platform, title, positioningTags)), 800)
    return () => window.clearTimeout(timer)
  }, [title, work.platform, positioningTags, internalName])
  useEffect(() => () => {
    window.clearTimeout(titleBlurTimer.current)
    titleDiagnosisAbort.current?.abort()
  }, [])
  const save = async (body: Record<string, unknown>, base = work.revision): Promise<boolean> => {
    try {
      setWork(await patch<Work>(`/works/${work.id}`, { ...body, base_revision: base }))
      setConflict(null)
      return true
    } catch (e) {
      if (e instanceof ApiError && e.code === 'version_conflict') setConflict({ server: (e.detail as { server: Work }).server, body })
      else toast.error(errorMessage(e))
      return false
    }
  }
  // NW-C4：标题、摘要和话题只在 blur 保存；跨步骤动作前一并提交，避免并行请求争用 revision。
  const titleRef = useRef(title)
  titleRef.current = title
  const summaryRef = useRef(summary)
  summaryRef.current = summary
  const topicsRef = useRef(topics)
  topicsRef.current = topics
  const saveRef = useRef(save)
  saveRef.current = save
  const flush = useCallback(async () => {
    const body: Record<string, unknown> = {}
    const nextTitle = titleRef.current
    if (nextTitle !== work.title) {
      if (wx && runeLen(nextTitle) > 32) {
        toast.error('公众号标题不能超过 32 字，请先调整标题再继续')
        throw new Error('公众号标题超过 32 字')
      }
      body.title = nextTitle
    }
    const nextSummary = summaryRef.current
    if (wx && nextSummary !== work.summary) {
      if (runeLen(nextSummary) > 120) {
        toast.error('摘要不能超过 120 字，请先调整摘要再继续')
        throw new Error('摘要超过 120 字')
      }
      body.summary = nextSummary
    }
    if (!wx) {
      const nextTopics = parseTopics(topicsRef.current)
      if (nextTopics.join(' ') !== work.topics.join(' ')) body.topics = nextTopics
    }
    if (Object.keys(body).length === 0) return
    if (!(await saveRef.current(body))) throw new Error('标题、摘要或话题未能保存，请处理冲突后重试')
  }, [work.title, work.summary, work.topics, wx])
  useRegisterFlush('title', flush)
  const genTitles = async () => {
    setBusy('t')
    try {
      const r = await post<TitleResp>(`/works/${work.id}/titles`)
      setTitles(r.titles.map((x, k) => ({ ...x, call: r.ai_call_id, idx: k })))
      setTitleRefs(r.refs)
      setTitleCall(r.ai_call_id)
      setStrong(r.strong_features ?? [])
    } catch (e) {
      aiError(e, '生成标题', genTitles)
    } finally {
      setBusy(null)
    }
  }
  const runTitleDiagnosis = async () => {
    if (titleDiagnosisAbort.current) { titleDiagnosisAbort.current.abort(); return }
    const requestedTitle = titleInput.current.trim()
    if (!requestedTitle || busy !== null) return
    const controller = new AbortController()
    titleDiagnosisAbort.current = controller
    setBusy('d')
    try {
      await flushAll(['title'])
      const current = await get<Work>(`/works/${work.id}`)
      setWork(current)
      const report = await post<TitleDiagnosisReport>(`/works/${work.id}/diagnose-title`, {
        basis_revision: current.revision, title: requestedTitle,
      }, controller.signal)
      setTitleDiagnosis(report)
      setHistoryOpen(false)
    } catch (e) {
      if (controller.signal.aborted) return
      if (e instanceof ApiError && e.code === 'version_conflict') toast.error('作品或定位已变化，刷新后再诊断。')
      else if (e instanceof ApiError && e.code === 'ai_task_in_progress') toast.message('相同依据正在诊断，请稍后查看历史。')
      else aiError(e, '诊断标题', () => void runTitleDiagnosis())
    } finally {
      if (titleDiagnosisAbort.current === controller) titleDiagnosisAbort.current = null
      setBusy(current => current === 'd' ? null : current)
    }
  }
  const loadTitleHistory = async () => {
    try {
      const history = await get<{ items: TitleDiagnosisReport[]; next_cursor: string | null }>(`/works/${work.id}/diagnoses?kind=title`)
      setTitleHistory(history.items)
      if (!titleDiagnosis && history.items[0]) setTitleDiagnosis(history.items[0])
      setHistoryOpen(true)
      if (history.items.length === 0) toast.message('还没有标题诊断历史。')
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  useEffect(() => {
    const generate = () => { void genTitles() }
    window.addEventListener('ops:generate-titles', generate)
    return () => {
      window.removeEventListener('ops:generate-titles', generate)
    }
  })
  useWorkCmd((c) => {
    if (c.cmd !== 'titles' || readOnly) return
    document.getElementById('step-title')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    void genTitles()
  })
  const genSummary = async () => {
    setBusy('s')
    try {
      const r = await post<{ summary: string; truncated: boolean }>(`/works/${work.id}/summary`)
      setSummary(r.summary)
      if (r.truncated) toast.info('AI 写的摘要超过 120 字，已截断，请检查结尾')
      await save({ summary: r.summary })
    } catch (e) {
      aiError(e, '生成摘要', genSummary)
    } finally {
      setBusy(null)
    }
  }
  const picked = useRef<TitleCand | null>(null)
  const pickTitle = (t: string) => {
    setTitle(t)
    save({ title: t })
    const c = titles.find((x) => x.text === t)
    picked.current = c ?? null
    if (c?.call) sendFeedback(c.call, { outcome: 'accepted', choice_index: c.idx, sample_text: c.text })
  }
  // 标题候选"是否改写后使用"（10 文档 3.3）：选用后又手改，记为 edited。
  const titleEdited = (next: string) => {
    const c = picked.current
    if (!c?.call || next === c.text) return
    sendFeedback(c.call, { outcome: 'edited', choice_index: c.idx })
    picked.current = null
  }
  const groups = [...new Set(titles.map((t) => t.style.replace('（改写自候选）', '')))]
  const titleRow = (t: TitleCand) => {
    const fav = favs.some((f) => f.text === t.text)
    return (
      <div key={t.text} className={cn('group flex items-start gap-2 rounded-lg border px-3 py-2 transition hover:border-ink-300', title === t.text ? 'border-ink-400 bg-ink-50' : 'border-mist-200')}>
        <button type="button" onClick={() => pickTitle(t.text)} className="min-w-0 flex-1 cursor-pointer text-left">
          <div className="text-[13.5px] font-medium text-mist-800">{t.text}</div>
          <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-mist-400">
            <span className={cn(t.over_limit && 'font-medium text-danger')}>{t.chars} 字{t.over_limit ? '（超出）' : ''}</span>
            {(t.features ?? []).map((f) => (
              <span key={f} className={cn('rounded px-1', t.strong_hits?.includes(f) ? 'bg-gamboge-100 text-gamboge-800' : 'bg-mist-100')}
                title={t.strong_hits?.includes(f) ? '你过去表现较好的标题也常有这个特征' : undefined}>{f}</span>
            ))}
          </div>
        </button>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <button type="button" title={fav ? '取消收藏' : '收藏这个候选'} onClick={() => toggleFav(t)} className={cn('cursor-pointer', fav ? 'text-gamboge-500' : 'text-mist-300 hover:text-gamboge-500')}>
            <Star className="size-3.5" fill={fav ? 'currentColor' : 'none'} />
          </button>
          {!readOnly && (
            <button type="button" disabled={!!rewriting} onClick={() => rewriteOne(t.text)} className="cursor-pointer text-[11px] text-mist-400 opacity-0 transition hover:text-ink-600 group-hover:opacity-100 disabled:opacity-50">
              {rewriting === t.text ? <Loader2 className="size-3 animate-spin" /> : '再改写 3 个'}
            </button>
          )}
        </div>
      </div>
    )
  }
  const extras = <>
    {favs.length > 0 && (
      <div>
        <div className="mb-1.5 text-[12px] font-medium text-mist-600">收藏的候选</div>
        <div className="grid gap-2 sm:grid-cols-2">{favs.map(titleRow)}</div>
      </div>
    )}
    {titles.length > 0 && (
      <div className="space-y-3 rounded-xl bg-mist-50/70 p-3">
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-mist-500">
          {internalName ? '内部名称工作台' : '标题工作台'}
          {strong.length > 0 && <span>· 你过去表现较好的标题常见特征：{strong.map((s) => <Badge key={s} tone="gamboge" className="ml-1">{s}</Badge>)}</span>}
          <span className="text-mist-400">只展示可解释的特征，不做热度预测</span>
        </div>
        {groups.map((g) => (
          <div key={g}>
            <div className="mb-1 text-[11.5px] font-medium text-mist-500">{g}</div>
            <div className="grid gap-2 sm:grid-cols-2">{titles.filter((t) => t.style.replace('（改写自候选）', '') === g).map(titleRow)}</div>
          </div>
        ))}
        <RefsNote refs={titleRefs} callId={titleCall} sampleText={titles.map((t) => t.text).join('\n')} onRetry={readOnly ? undefined : genTitles} />
      </div>
    )}
    {wx ? (
      <Field label="摘要" counter={{ value: runeLen(summary), max: 120 }} hint="留空时微信会自动抓取正文前 54 个字">
        <div className="flex gap-2">
          <Textarea rows={2} value={summary} disabled={readOnly} onChange={(e) => setSummary(e.target.value)} invalid={runeLen(summary) > 120}
            onBlur={() => summary !== work.summary && runeLen(summary) <= 120 && save({ summary })} />
          {!readOnly && <Button icon={<Sparkles className="size-4" />} loading={busy === 's'} onClick={genSummary}>生成</Button>}
        </div>
      </Field>
    ) : (
      <Field label="话题标签" hint={toutiao
        ? '用空格分隔，例如：#职场 #效率。发布前在头条话题选择器中核对添加；纯文本 #话题 不保证已关联活动。'
        : '用空格分隔，例如：#职场 #效率。发布时在小红书里用话题选择器添加。'}>
        <Input value={topics} disabled={readOnly} onChange={(e) => setTopics(e.target.value)}
          onBlur={() => {
            const list = parseTopics(topics)
            if (list.join(' ') !== work.topics.join(' ')) save({ topics: list })
          }} />
        <div className="mt-2">
          <TagSuggest workId={work.id} current={parseTopics(topics)} disabled={readOnly} onAdd={(t) => {
            const list = [...parseTopics(topics), t]
            setTopics(list.map((x) => '#' + x).join(' '))
            save({ topics: list })
          }} />
        </div>
      </Field>
    )}
  </>
  return (
    <Card id="step-title" className={cn('scroll-mt-24 p-5', hidden && 'hidden')}>
      <h2 className="mb-4 font-display text-[17px] font-bold text-mist-900">{internalName ? '内部名称与话题' : wx ? '标题与摘要' : '标题与话题'}</h2>
      <div className="space-y-4">
        <Field label={internalName ? '内部名称（仅系统内使用）' : '标题'} counter={titleMax > 0 ? { value: runeLen(title), max: titleMax } : undefined}
          hint={internalName ? '用于系统识别、检索和数据匹配，不会作为微头条发布标题或导出正文。' : toutiao ? '今日头条文章发布标题；平台字数上限待实测（V-025）。' : wx ? '公众号标题不超过 32 字' : '小红书标题字数上限待核实（V-012），暂按 20 字提示'}>
          <div className="flex gap-2">
            <Input value={title} disabled={readOnly} onChange={(e) => { setTitle(e.target.value); setDiagnosisUndo(null) }} invalid={wx && runeLen(title) > 32}
              placeholder={internalName ? '未命名微头条 · 仅系统内使用' : '未命名作品 · 标题可以最后再定'}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.blur() } }}
              onBlur={() => {
                window.clearTimeout(titleBlurTimer.current)
                titleBlurTimer.current = window.setTimeout(() => {
                  if (titleDiagnosisFocus.current) { titleDiagnosisFocus.current = false; return }
                  const value = titleInput.current
                  if (value !== work.title && !(wx && runeLen(value) > 32)) { titleEdited(value); void save({ title: value }) }
                }, 0)
              }} className="font-display text-[15px] font-semibold" />
            {!readOnly && <Button icon={<Sparkles className="size-4" />} loading={busy === 't'} onClick={genTitles}>候选</Button>}
            {!readOnly && !internalName && <Button variant="secondary" icon={diagnosisBusy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
              disabled={!title.trim() || busy !== null && !diagnosisBusy} onFocus={() => { titleDiagnosisFocus.current = true }}
              onClick={() => void runTitleDiagnosis()}>{diagnosisBusy ? '取消诊断' : '诊断标题'}</Button>}
          </div>
        </Field>
        {readOnly && !internalName && <Button size="sm" variant="ghost" onClick={() => void loadTitleHistory()}>查看历史诊断</Button>}
        {localRules && <div className="rounded-lg border border-mist-200 bg-mist-50/60 px-3 py-2 text-[11.5px] text-mist-500" data-testid="title-rule-preview">
          本地规则预览 {localRules.ruleScore}/{localRules.ruleMax}{localRules.coverage === 'partial' ? ' · 部分依据' : ''} · 只按规则计算，不调用 AI
        </div>}
        {titleDiagnosis && <div className="rounded-xl border border-mist-200 bg-white p-3" data-testid="title-diagnosis-report" onFocusCapture={() => { titleDiagnosisFocus.current = true }}>
          {(() => {
            const report = titleDiagnosis.result
            const stale = titleDiagnosis.stale || report.title !== title || report.basis_revision !== work.revision
            return <>
              <div className="flex flex-wrap items-center gap-2 text-[12px]">
                <span className="font-semibold text-mist-800">标题诊断</span>
                <Badge tone={report.input_scope === 'unsaved' ? 'gamboge' : 'ink'}>{report.input_scope === 'unsaved' ? '临时标题' : '已保存标题'}</Badge>
                <span className="text-mist-500">规则 {report.rule_score}/{report.rule_max}</span>
                <span className="text-mist-500">{report.ai_score === null ? '语义评分未完成' : `语义 ${report.ai_score}/${report.ai_max}`}</span>
                {report.score === null ? <span className="font-medium text-mist-500">总分未完成</span> : <span className="font-semibold text-ink-700">总分 {report.score}/100</span>}
                <span className="ml-auto text-[10.5px] text-mist-400">{report.rules_version} · 第 {report.basis_revision} 版</span>
              </div>
              {stale && <Notice tone="gamboge" className="mt-2">报告基于更早的标题或作品版本，保留为历史结果。</Notice>}
              {(report.sources.missing.length > 0 || report.ai_partial) && <Notice tone="gray" className="mt-2">
                {report.ai_partial && 'AI 语义层未完成；'}{report.sources.missing.join('；') || '本次不完整结果不计总分。'}
              </Notice>}
              <div className="mt-3 grid gap-1.5 sm:grid-cols-2">
                {Object.entries(report.rule_dimensions.dimensions).map(([key, dimension]) => <div key={key} className="flex justify-between rounded-md bg-mist-50 px-2 py-1 text-[11px]">
                  <span className="text-mist-500">{titleRuleLabels[key] ?? key}</span><span className="font-medium text-mist-700">{dimension.score === null ? '不可用' : `${dimension.score}/${dimension.max}`}</span>
                </div>)}
              </div>
              {report.ai_dimensions.length > 0 && <div className="mt-3 space-y-1">
                {report.ai_dimensions.map(item => <p key={item.key} className="text-[11.5px] text-mist-600"><span className="font-medium">{item.key} {item.score}</span> · {item.evidence}</p>)}
              </div>}
              {report.findings.length > 0 && <div className="mt-3 space-y-2">
                {report.findings.map((finding, index) => <div key={`${finding.dimension}:${index}`} className="rounded-md border border-mist-100 p-2 text-[11.5px]">
                  <p className="font-medium text-mist-700">{finding.section_id ? `正文 · ${work.sections.find(section => section.id === finding.section_id)?.heading ?? '段落'}` : '标题'} · {finding.message}</p>
                  <p className="mt-1 text-mist-500">依据：{finding.evidence}{finding.span && ` · 码点 ${finding.span.start}–${finding.span.end}`}</p>
                  <p className="mt-1 text-mist-500">建议：{finding.suggestion}</p>
                </div>)}
              </div>}
              {report.candidates.length > 0 && <div className="mt-3 space-y-1">
                <p className="text-[11px] font-medium text-mist-500">候选标题（逐项采用后仍需手动保存）</p>
                {report.candidates.map(candidate => <Button key={candidate} size="sm" variant="secondary" disabled={readOnly} onClick={() => { setDiagnosisUndo(title); setTitle(candidate) }}>采用候选：{candidate}</Button>)}
                {diagnosisUndo !== null && <Button size="sm" variant="ghost" onClick={() => { setTitle(diagnosisUndo); setDiagnosisUndo(null) }}>撤销采用</Button>}
              </div>}
              <div className="mt-3 flex items-center gap-2 text-[10.5px] text-mist-400">
                <span>依据哈希 {titleDiagnosis.input_hash.slice(0, 12)} · 模型 {titleDiagnosis.model || '未调用'} · 快照 {report.sources.assembled_at ? new Date(report.sources.assembled_at).toLocaleString() : '时间未记录'} · 作品更新 {report.sources.work_updated_at ? new Date(report.sources.work_updated_at).toLocaleString() : '时间未记录'} · 定位更新 {report.sources.positioning_updated_at ? new Date(report.sources.positioning_updated_at).toLocaleString() : '未配置/未记录'}</span>
                <Button size="sm" variant="ghost" onClick={() => void loadTitleHistory()}>查看历史</Button>
              </div>
              {historyOpen && <div className="mt-2 space-y-1 border-t border-mist-100 pt-2">
                {titleHistory.length === 0 ? <p className="text-[11px] text-mist-400">还没有标题诊断历史。</p> : titleHistory.map(item => <button key={item.diagnosis_id} type="button" onClick={() => setTitleDiagnosis(item)} className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[11.5px] hover:bg-mist-50">
                  <span className="min-w-0 flex-1 truncate text-mist-700">{item.result.title}</span><span className="text-mist-400">{item.stale ? '已过期' : item.result.input_scope === 'unsaved' ? '临时标题' : '已保存'}</span>
                </button>)}
              </div>}
            </>
          })()}
        </div>}
        {extras}
      </div>
      <WorkConflictDialog server={conflict?.server ?? null} mine={{ ...work, title, summary }} onClose={() => setConflict(null)} onResolve={keepMine => {
        if (!conflict) return
        if (keepMine) void save(conflict.body, conflict.server.revision)
        else { setWork(conflict.server); setConflict(null) }
      }} />
    </Card>
  )
}
