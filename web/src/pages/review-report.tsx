import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Brain, Check, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Badge, Button, Card, CardHeader, cn, Input, Select, Textarea } from '@/components/ui'
import { errorMessage, patch, post } from '@/lib/api'
import { fmtNum, fmtTime } from '@/lib/format'
import type { ReviewReport } from '@/lib/types'
export type ReviewExperimentProposal = NonNullable<ReviewReport['content']['analysis_v2']>['experiments'][number]

const contentFormatName = (format: string) => format === 'micro_post' ? '微头条' : format === 'long_article' ? '文章' : format

export function ReportCard({ report, accountId, canWrite, onAdopted, onUseExperiment }: { report: ReviewReport; accountId: string; canWrite: boolean; onAdopted: () => void; onUseExperiment: (proposal: ReviewExperimentProposal) => void }) {
  const [busy, setBusy] = useState<number | null>(null)
  const [remembering, setRemembering] = useState<number | null>(null)
  const [remembered, setRemembered] = useState<number[]>(report.remembered ?? [])
  const [ignored, setIgnored] = useState<number[]>(report.ignored ?? [])
  const [editDraft, setEditDraft] = useState<ReviewReport['content'] | null>(null)
  const [savingEdit, setSavingEdit] = useState(false)
  // OP-05：采纳后要能直接到刚生成的选题，而不是让用户回选题池自己找。
  const [adoptedTopic, setAdoptedTopic] = useState<Record<number, string>>({})
  const insights = report.content.writing_insights ?? []
  const analysis = report.content.analysis_v2
  const basis = report.content.cx_basis
  const edit = (update: (current: ReviewReport['content']) => ReviewReport['content']) => setEditDraft((current) => current ? update(current) : current)
  const saveEdit = async () => {
    if (!editDraft) return
    setSavingEdit(true)
    try {
      await patch<ReviewReport>(`/review-reports/${report.id}/content`, { base_revision: report.content_revision, content: editDraft })
      setEditDraft(null)
      toast.success('复盘内容已保存')
      onAdopted()
    } catch (e) { toast.error(errorMessage(e)) } finally { setSavingEdit(false) }
  }
  const ignore = async (i: number) => {
    setIgnored((x) => [...x, i])
    try {
      await post(`/review-reports/${report.id}/insights/${i}/ignore`)
    } catch (e) {
      setIgnored((x) => x.filter((k) => k !== i))
      toast.error(errorMessage(e))
    }
  }
  const remember = async (i: number) => {
    setRemembering(i)
    try {
      await post(`/review-reports/${report.id}/insights/${i}/remember`)
      setRemembered((r) => [...r, i])
      toast.success('已记住，之后生成标题和正文时会参考')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setRemembering(null)
    }
  }
  const adopt = async (i: number) => {
    setBusy(i)
    try {
      const r = await post<{ topic_id?: string }>(`/review-reports/${report.id}/suggestions/${i}/adopt`)
      toast.success('已加入选题池')
      onAdopted()
      if (r?.topic_id) setAdoptedTopic((x) => ({ ...x, [i]: r.topic_id as string }))
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }
  return (
    <Card data-testid={`cx-review-report-${report.id}`}>
      <CardHeader title={`${report.origin === 'weekly_draft' ? '每周复盘草稿' : '复盘报告'}${report.content.content_format ? ` · ${contentFormatName(report.content.content_format)}` : ''} · ${fmtTime(report.created_at)}`}
        desc={report.origin === 'weekly_draft'
          ? `后台按第 7 天数据自动生成，覆盖 ${report.work_ids.length} 篇作品；建议要你逐条采纳，不采纳不影响任何东西`
          : `覆盖 ${report.work_ids.length} 篇作品`}
        action={canWrite ? editDraft
          ? <div className="flex gap-2"><Button size="sm" variant="ghost" onClick={() => setEditDraft(null)}>取消</Button><Button size="sm" variant="primary" loading={savingEdit} onClick={() => void saveEdit()}>保存修改</Button></div>
          : <Button size="sm" variant="outline" onClick={() => setEditDraft(JSON.parse(JSON.stringify(report.content)) as ReviewReport['content'])}>编辑报告</Button> : undefined} />
      <div className="space-y-5 p-5">
        {analysis ? <section className="rounded-lg border border-ink-100 bg-ink-50/40 p-3" data-testid="cx-review-v2-evidence">
          <div className="flex flex-wrap items-center gap-2"><Badge tone="ink">增强复盘 v{basis?.analysis_version ?? 2}</Badge>
            <Badge>{basis?.task_type ?? 'review_analysis'}</Badge><Badge>{basis?.prompt_version ?? '提示词版本未知'}</Badge>
            <Badge>{basis?.model ?? '模型未记录'}</Badge><Badge>覆盖 {basis?.work_ids.length ?? report.work_ids.length} 篇作品 · {basis?.sources.length ?? 0} 项来源</Badge>
          </div>
          <p className="mt-2 text-xs text-mist-500">依据生成于 {basis?.assembled_at ? fmtTime(basis.assembled_at) : '未知时间'} · 上下文版本 {basis?.context_hash?.slice(0, 12) ?? '未知'} · 仅使用当前保留的正式指标快照</p>
          {basis?.followers && <p className="mt-1 text-xs text-mist-500">账号粉丝快照：{fmtNum(basis.followers.cumulate)} {basis.followers.unit === 'users' ? '人' : basis.followers.unit} · {basis.followers.source} · {basis.followers.date} · 引用 {basis.followers.source_ref}</p>}
          {!!basis?.missing.length && <div className="mt-2 rounded-md bg-amber-50 p-2 text-xs text-amber-800"><strong>本次缺失与覆盖限制</strong><ul className="mt-1 list-disc pl-4">{basis.missing.map((item, i) => <li key={`${item.code}-${i}`}>{item.code}：{item.message}</li>)}</ul></div>}
          {analysis.limitations.length > 0 && <div className="mt-2 text-xs text-mist-600"><strong>模型限制说明</strong>{analysis.limitations.map((item, i) => <p key={`${item.code}-${i}`}>{item.code}：{item.message}</p>)}</div>}
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <div><div className="mb-1 text-xs font-semibold text-mist-700">观察事实</div>{analysis.observations.length ? analysis.observations.map((item, i) => <div key={i} className="mb-2 rounded-md bg-white p-2 text-sm">
              {editDraft?.analysis_v2 ? <Textarea aria-label={`观察事实 ${i + 1}`} rows={2} value={editDraft.analysis_v2.observations[i]?.finding ?? item.finding} onChange={(event) => edit((current) => ({ ...current, analysis_v2: current.analysis_v2 && { ...current.analysis_v2, observations: current.analysis_v2.observations.map((entry, index) => index === i ? { ...entry, finding: event.target.value } : entry) } }))} /> : item.finding}
              <div className="mt-1 break-all text-[10px] text-mist-400">来源：{item.source_refs.join(' · ')}</div>
            </div>) : <p className="text-xs text-mist-400">没有可引用的观察事实。</p>}</div>
            <div><div className="mb-1 text-xs font-semibold text-mist-700">可能解释（含反例与混杂）</div>{analysis.hypotheses.length ? analysis.hypotheses.map((item, i) => {
              const hypothesis = editDraft?.analysis_v2?.hypotheses[i] ?? item
              return <div key={i} className="mb-2 rounded-md bg-white p-2 text-sm">
              {editDraft?.analysis_v2 ? <>
                <Textarea aria-label={`可能解释 ${i + 1}`} rows={2} value={hypothesis.explanation} onChange={(event) => edit((current) => ({ ...current, analysis_v2: current.analysis_v2 && { ...current.analysis_v2, hypotheses: current.analysis_v2.hypotheses.map((entry, index) => index === i ? { ...entry, explanation: event.target.value } : entry) } }))} />
                <div className="mt-2 grid gap-2 md:grid-cols-2"><div><span className="text-xs text-mist-500">反例</span>{hypothesis.counterevidence.map((value, j) => <Input key={j} className="mt-1" aria-label={`可能解释 ${i + 1} 反例 ${j + 1}`} maxLength={200} value={value} onChange={(event) => edit((current) => ({ ...current, analysis_v2: current.analysis_v2 && { ...current.analysis_v2, hypotheses: current.analysis_v2.hypotheses.map((entry, index) => index === i ? { ...entry, counterevidence: entry.counterevidence.map((text, n) => n === j ? event.target.value : text) } : entry) } }))} />)}</div>
                  <div><span className="text-xs text-mist-500">混杂因素</span>{hypothesis.confounders.map((value, j) => <Input key={j} className="mt-1" aria-label={`可能解释 ${i + 1} 混杂因素 ${j + 1}`} maxLength={200} value={value} onChange={(event) => edit((current) => ({ ...current, analysis_v2: current.analysis_v2 && { ...current.analysis_v2, hypotheses: current.analysis_v2.hypotheses.map((entry, index) => index === i ? { ...entry, confounders: entry.confounders.map((text, n) => n === j ? event.target.value : text) } : entry) } }))} />)}</div></div>
              </> : <><p>{item.explanation}</p><p className="mt-1 text-xs text-mist-500">反例：{item.counterevidence.join('；') || '未提供'} · 混杂因素：{item.confounders.join('；') || '未提供'}</p></>}
              <div className="mt-1 break-all text-[10px] text-mist-400">来源：{item.source_refs.join(' · ')}</div>
            </div>}) : <p className="text-xs text-mist-400">没有足够来源支持可能解释。</p>}</div>
          </div>
          {analysis.experiments.length > 0 && <div className="mt-3"><div className="mb-1 text-xs font-semibold text-mist-700">下一次单变量行动草案</div><div className="space-y-2">{analysis.experiments.map((item, i) => {
            const draftItem = editDraft?.analysis_v2?.experiments[i] ?? item
            return <div key={i} className="flex flex-wrap items-center gap-2 rounded-md bg-white p-2 text-sm">
              {editDraft?.analysis_v2 ? <>
                <Input aria-label={`实验建议 ${i + 1} 假设`} className="min-w-56 flex-1" maxLength={300} value={draftItem.hypothesis} onChange={(event) => edit((current) => ({ ...current, analysis_v2: current.analysis_v2 && { ...current.analysis_v2, experiments: current.analysis_v2.experiments.map((entry, index) => index === i ? { ...entry, hypothesis: event.target.value } : entry) } }))} />
                <Select aria-label={`实验建议 ${i + 1} 变量`} value={draftItem.variable} onChange={(event) => edit((current) => ({ ...current, analysis_v2: current.analysis_v2 && { ...current.analysis_v2, experiments: current.analysis_v2.experiments.map((entry, index) => index === i ? { ...entry, variable: event.target.value as typeof entry.variable } : entry) } }))}><option value="title">标题</option><option value="cover">封面</option><option value="topic">选题</option><option value="format">内容形态</option><option value="posting_time">发布时间</option></Select>
                <Select aria-label={`实验建议 ${i + 1} 指标`} value={draftItem.metric_key} onChange={(event) => edit((current) => ({ ...current, analysis_v2: current.analysis_v2 && { ...current.analysis_v2, experiments: current.analysis_v2.experiments.map((entry, index) => index === i ? { ...entry, metric_key: event.target.value as typeof entry.metric_key } : entry) } }))}><option value="favorite_rate">收藏率</option><option value="interaction_rate">严格互动率</option><option value="follow_rate">涨粉率</option></Select>
                <Select aria-label={`实验建议 ${i + 1} 窗口`} value={draftItem.window} onChange={(event) => edit((current) => ({ ...current, analysis_v2: current.analysis_v2 && { ...current.analysis_v2, experiments: current.analysis_v2.experiments.map((entry, index) => index === i ? { ...entry, window: event.target.value as typeof entry.window } : entry) } }))}><option value="T1">T1</option><option value="T3">T3</option><option value="T7">T7</option><option value="T30">T30</option></Select>
                <Input aria-label={`实验建议 ${i + 1} 方案`} className="min-w-56 flex-1" maxLength={300} value={draftItem.selection_proposal} onChange={(event) => edit((current) => ({ ...current, analysis_v2: current.analysis_v2 && { ...current.analysis_v2, experiments: current.analysis_v2.experiments.map((entry, index) => index === i ? { ...entry, selection_proposal: event.target.value } : entry) } }))} />
              </> : <span className="min-w-0 flex-1">{item.hypothesis} · {item.variable} / {item.metric_key} / {item.window} · {item.selection_proposal}</span>}
              {canWrite && !editDraft && <Button size="sm" variant="outline" onClick={() => onUseExperiment(item)}>填入实验表单</Button>}
            </div>
          })}</div><p className="mt-1 text-[11px] text-mist-400">建议不会自动创建实验；仍需逐项检查变量、指标、窗口和日期。</p></div>}
          <details className="mt-3 text-xs"><summary className="cursor-pointer text-ink-700">查看全部来源修订</summary>
            <div className="mt-2 space-y-1">{basis?.sources.map((source) => <div key={source.source_ref} className="break-all text-mist-500">{source.kind} · {source.source_ref}{source.captured_at ? ` · ${fmtTime(source.captured_at)}` : ''}{source.revision ? ` · 修订 ${source.revision}` : ''}</div>)}</div>
          </details>
        </section> : <p className="rounded-md bg-mist-50 p-3 text-xs text-mist-500">旧版复盘，无新增证据结构。</p>}
        {editDraft && <section className="space-y-4 rounded-lg border border-mist-200 p-3" data-testid="cx-review-edit-form">
          <p className="text-xs text-mist-500">编辑会保留来源引用、数组数量和旧版采用索引。保存使用版本校验；若报告已变化，请刷新后重试。</p>
          <div><div className="mb-2 text-xs font-semibold">结论</div>{editDraft.conclusions.map((item, i) => <Textarea key={i} className="mb-2" rows={2} value={item} onChange={(event) => edit((current) => ({ ...current, conclusions: current.conclusions.map((value, index) => index === i ? event.target.value : value) }))} />)}</div>
          <div><div className="mb-2 text-xs font-semibold">选题建议</div>{editDraft.topic_suggestions.map((item, i) => <div key={i} className="mb-2 grid gap-2 rounded-md bg-mist-50 p-2 md:grid-cols-3">
            <Input aria-label={`选题 ${i + 1} 标题`} maxLength={64} value={item.title} onChange={(event) => edit((current) => ({ ...current, topic_suggestions: current.topic_suggestions.map((value, index) => index === i ? { ...value, title: event.target.value } : value) }))} />
            <Input aria-label={`选题 ${i + 1} 角度`} maxLength={300} value={item.angle} onChange={(event) => edit((current) => ({ ...current, topic_suggestions: current.topic_suggestions.map((value, index) => index === i ? { ...value, angle: event.target.value } : value) }))} />
            <Input aria-label={`选题 ${i + 1} 依据`} maxLength={300} value={item.reason} onChange={(event) => edit((current) => ({ ...current, topic_suggestions: current.topic_suggestions.map((value, index) => index === i ? { ...value, reason: event.target.value } : value) }))} />
          </div>)}</div>
          <div><div className="mb-2 text-xs font-semibold">写作结论</div>{(editDraft.writing_insights ?? []).map((item, i) => <Textarea key={i} className="mb-2" rows={2} value={item} onChange={(event) => edit((current) => ({ ...current, writing_insights: (current.writing_insights ?? []).map((value, index) => index === i ? event.target.value : value) }))} />)}</div>
          {editDraft.analysis_v2 && <div><div className="mb-2 text-xs font-semibold">数据限制说明</div>{editDraft.analysis_v2.limitations.map((item, i) => <Textarea key={i} className="mb-2" rows={2} aria-label={`数据限制 ${i + 1}`} maxLength={200} value={item.message} onChange={(event) => edit((current) => ({ ...current, analysis_v2: current.analysis_v2 && { ...current.analysis_v2, limitations: current.analysis_v2.limitations.map((value, index) => index === i ? { ...value, message: event.target.value } : value) } }))} />)}</div>}
        </section>}
        {!editDraft && <>
        <div>
          <div className="mb-2 text-[13px] font-semibold text-mist-700">结论</div>
          <ul className="space-y-1.5">
            {report.content.conclusions.map((c, i) => (
              <li key={i} className="flex gap-2 text-[14px] leading-relaxed text-mist-700"><span className="mt-2 size-1.5 shrink-0 rounded-full bg-ink-500" />{c}</li>
            ))}
          </ul>
        </div>
        {insights.length > 0 && (
          <div>
            <div className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-mist-700"><Brain className="size-4" />写作层面的结论</div>
            <ul className="space-y-1.5">
              {insights.map((t, i) => ignored.includes(i) ? null : (
                <li key={i} className={cn('flex items-start gap-2 rounded-lg border p-2.5 text-[13.5px]', remembered.includes(i) ? 'border-ink-200 bg-ink-50/40' : 'border-mist-200')}>
                  <span className="flex-1 leading-relaxed text-mist-700">{t}</span>
                  {remembered.includes(i) ? <Badge tone="ink"><Check className="size-3" />已记住</Badge> : canWrite ? (
                    <>
                      <Button size="sm" variant="outline" loading={remembering === i} onClick={() => remember(i)}>记住</Button>
                      <Button size="sm" variant="ghost" onClick={() => ignore(i)}>忽略</Button>
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div>
          <div className="mb-2 text-[13px] font-semibold text-mist-700">选题建议</div>
          <div className="space-y-2">
            {report.content.topic_suggestions.map((s, i) => {
              const adopted = report.adopted.includes(i)
              return (
                <div key={i} className={cn('flex items-start gap-3 rounded-lg border p-3', adopted ? 'border-ink-200 bg-ink-50/40' : 'border-mist-200')}>
                  <div className="min-w-0 flex-1">
                    <div className="font-display text-[15px] font-semibold text-mist-900">{s.title}</div>
                    <div className="mt-1 text-[13px] text-mist-600"><span className="text-mist-400">角度 · </span>{s.angle}</div>
                    <div className="text-[13px] text-mist-500"><span className="text-mist-400">依据 · </span>{s.reason}</div>
                  </div>
                  {adopted ? <span className="flex shrink-0 items-center gap-1.5">
                    <Badge tone="ink"><Check className="size-3" />已采纳</Badge>
                    <Link to={adoptedTopic[i] ? `/a/${accountId}/topics?focus=${adoptedTopic[i]}` : `/a/${accountId}/topics`}
                      className="whitespace-nowrap text-[12.5px] text-ink-700 underline underline-offset-2">
                      {adoptedTopic[i] ? '去创作这条选题' : '去选题池查看'}
                    </Link>
                  </span>
                    : canWrite && <Button size="sm" variant="outline" loading={busy === i} onClick={() => adopt(i)} icon={<Plus className="size-3.5" />}>采纳</Button>}
                </div>
              )
            })}
          </div>
        </div>
        </>}
      </div>
    </Card>
  )
}

