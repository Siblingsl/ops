import { useQuery } from '@tanstack/react-query'
import { Brain, CalendarRange, Check, FileSearch, LayoutList, Sparkles, TrendingUp } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { Dialog } from '@/components/dialog'
import { AIFeedback } from '@/components/refs'
import { aiError } from '@/lib/ai-error'
import { Badge, Button, Card, CardHeader, Empty, Field, Input, Notice } from '@/components/ui'
import { errorMessage, get, post, put } from '@/lib/api'
import { fmtNum, fmtTime } from '@/lib/format'

interface AttrGroup { value: string; n: number; avg_reads: number; avg_interactions: number }
interface AttrFeature { feature: string; label: string; groups: AttrGroup[] }
interface AttrResp {
  enough: boolean
  samples: number
  need?: number
  message?: string
  features: AttrFeature[]
  conclusions?: { text: string; confidence: string }[]
  ai_call_id?: string
  ai_error?: string
}

interface DataPreferenceView {
  id: string
  feature: string
  conclusion: string
  basis: string
  sample_size: number
  applicable: boolean
  applicability: 'current' | 'stale' | 'insufficient_samples' | 'unverified'
  basis_sample_count: number
  computed_at: string | null
}

const preferenceApplicability: Record<DataPreferenceView['applicability'], { label: string; tone: 'green' | 'gamboge' | 'gray' }> = {
  current: { label: '当前可用', tone: 'green' },
  stale: { label: '数据已变化，等待重算', tone: 'gamboge' },
  insufficient_samples: { label: '样本不足，暂停注入', tone: 'gamboge' },
  unverified: { label: '旧记录未验证', tone: 'gray' },
}

/** Attribution groups the account's own data by simple features (EX-J-02); no prediction numbers. */
export function AttributionCard({ accountId, contentFormat }: { accountId: string; contentFormat?: string }) {
  const [data, setData] = useState<AttrResp | null>(null)
  const [busy, setBusy] = useState(false)
  const preferences = useQuery({
    queryKey: ['data-preferences', accountId, contentFormat],
    queryFn: () => get<DataPreferenceView[]>(`/accounts/${accountId}/data-preferences${contentFormat ? `?content_format=${contentFormat}` : ''}`),
    staleTime: 0,
    refetchOnMount: 'always',
  })
  const run = async () => {
    setBusy(true)
    try {
      setData(await post<AttrResp>(`/accounts/${accountId}/reviews/attribution`, contentFormat ? { content_format: contentFormat } : undefined))
      await preferences.refetch()
    } catch (e) {
      aiError(e, '归因分析', run)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card>
      <CardHeader title="什么在起作用" desc={contentFormat ? `仅分析${contentFormat === 'micro_post' ? '微头条' : '文章'}，按标题特征、发布时间、正文长度和话题分组` : '按标题特征、发布时间、正文长度和话题分组，对比本账号作品的平均阅读和互动'}
        action={<Button size="sm" variant="secondary" loading={busy} icon={<TrendingUp className="size-3.5" />} onClick={run}>{data ? '重新分析' : '开始分析'}</Button>} />
      <div className="p-5">
        <section className="mb-5 border-b border-mist-100 pb-5">
          <div className="mb-1 text-[13px] font-semibold text-mist-700">写作生成使用的统计偏好</div>
          <p className="mb-3 text-[12px] text-mist-500">只有标记为“当前可用”的偏好会进入指定生成任务；其他记录保留供查看，不会注入。</p>
          {preferences.isLoading ? <p className="text-[12px] text-mist-400">正在读取偏好依据…</p> : preferences.isError ? (
            <Notice tone="gamboge">读取偏好依据失败。<Button size="sm" variant="ghost" onClick={() => void preferences.refetch()}>重试</Button></Notice>
          ) : !preferences.data?.length ? (
            <p className="text-[12px] text-mist-400">暂无已保存的统计偏好；样本达到 10 篇后才会计算。</p>
          ) : (
            <ul className="space-y-2">
              {preferences.data.map((preference) => {
                const status = preferenceApplicability[preference.applicability]
                return (
                  <li key={preference.id} className="rounded-lg border border-mist-200 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="flex-1 text-[13px] font-medium text-mist-800">{preference.conclusion}</span>
                      <Badge tone={status.tone}>{status.label}</Badge>
                    </div>
                    <div className="mt-1 text-[12px] text-mist-500">
                      {preference.basis || '旧记录未保存对比依据'} · {preference.basis_sample_count || preference.sample_size} 篇样本
                      {preference.computed_at ? ` · 计算于 ${fmtTime(preference.computed_at)}` : ''}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
        {!data ? <p className="text-[13px] text-mist-500">只用你录入的数据做简单分组对比，不做预测。至少需要 10 篇有数据的作品。</p>
          : !data.enough ? <Notice tone="gamboge">{data.message}</Notice> : (
            <div className="space-y-5">
              {data.conclusions && data.conclusions.length > 0 && (
                <div>
                  <div className="mb-1 text-[13px] font-semibold text-mist-700">结论（基于 {data.samples} 篇）</div>
                  <p className="mb-2 text-[12px] text-mist-500">
                    {data.samples < 20 ? '样本还偏少，结论只能当作倾向；' : '样本量尚可；'}这些是本账号历史数据里的相关现象，不代表因果，也不预测下一篇的数据。
                  </p>
                  <ul className="space-y-2">
                    {data.conclusions.map((c, i) => (
                      <li key={i} className="rounded-lg bg-mist-50 p-3 text-[13.5px] leading-relaxed text-mist-700">
                        {c.text}
                        <div className="mt-1 text-[12px] text-mist-400">{c.confidence}</div>
                      </li>
                    ))}
                  </ul>
                  {data.ai_call_id && <AIFeedback callId={data.ai_call_id} className="mt-2" />}
                </div>
              )}
              {data.ai_error && <Notice tone="gamboge">AI 结论暂时没有生成：{data.ai_error}。下面的分组统计仍然可用。</Notice>}
              <div className="grid gap-4 md:grid-cols-2">
                {data.features.map((f) => {
                  const top = Math.max(1, ...f.groups.map((g) => g.avg_reads))
                  return (
                    <div key={f.feature} className="rounded-lg border border-mist-200 p-3">
                      <div className="mb-2 text-[13px] font-medium text-mist-700">{f.label}</div>
                      <ul className="space-y-1.5">
                        {f.groups.map((g) => (
                          <li key={g.value} className="text-[12px]">
                            <div className="flex items-center gap-2">
                              <span className="w-24 shrink-0 truncate text-mist-600">{g.value}</span>
                              <div className="h-2 flex-1 overflow-hidden rounded-full bg-mist-100">
                                <div className="h-full rounded-full bg-ink-500" style={{ width: `${(g.avg_reads / top) * 100}%` }} />
                              </div>
                              <span className="w-28 shrink-0 text-right tabular-nums text-mist-500">{fmtNum(Math.round(g.avg_reads))} 阅读 · {g.n} 篇</span>
                            </div>
                            {g.n < 3 && <div className="pl-26 text-[11px] text-mist-400">样本少于 3 篇，仅供参考</div>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
      </div>
    </Card>
  )
}

interface TopWork { work_id: string; title: string; content_format?: string; reads: number; interactions: number }
interface Breakdown {
  structure: string[]
  opening: string
  title_features: string[]
  angle: string
  reusable_rules: string[]
  outline_template: { heading: string; key_point: string }[]
}
interface OutlineTemplate { id: string; name: string; structure: string; builtin: boolean }

/** TopWorksCard lists the account's own best performers; only these can be broken down (EX-J-04). */
export function TopWorksCard({ accountId, contentFormat }: { accountId: string; contentFormat?: string }) {
  const top = useQuery({ queryKey: ['top-works', accountId, contentFormat], queryFn: () => get<TopWork[]>(`/accounts/${accountId}/top-works${contentFormat ? `?content_format=${contentFormat}` : ''}`) })
  const [busy, setBusy] = useState<string | null>(null)
  const [result, setResult] = useState<{ work: TopWork; bd: Breakdown; callId: string } | null>(null)
  const breakdown = async (w: TopWork) => {
    setBusy(w.work_id)
    try {
      const r = await post<{ breakdown: Breakdown; ai_call_id: string }>(`/works/${w.work_id}/breakdown`)
      setResult({ work: w, bd: r.breakdown, callId: r.ai_call_id })
    } catch (e) {
      aiError(e, '拆解作品', () => breakdown(w))
    } finally {
      setBusy(null)
    }
  }
  return (
    <Card>
      <CardHeader title="表现最好的作品" desc={contentFormat ? `${contentFormat === 'micro_post' ? '微头条' : '文章'}中阅读和互动排名前 10% 的作品` : '本账号阅读和互动排名前 10% 的作品，可以拆解它为什么有效'} />
      <div className="p-5">
        {top.isLoading ? null : !top.data?.length ? <Empty icon={<FileSearch className="size-5" />} title="还没有足够的数据" desc="录入作品数据后，这里会列出表现最好的作品。"
          action={<Button size="sm" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>去录入数据</Button>} /> : (
          <ul className="space-y-2">
            {top.data.map((w) => (
              <li key={w.work_id} className="flex items-center gap-3 rounded-lg border border-mist-200 p-3">
                <div className="min-w-0 flex-1">
                  <Link to={`/works/${w.work_id}`} className="line-clamp-1 text-[14px] font-medium text-mist-800 hover:text-ink-700">{w.title || '未命名'}</Link>
                  <div className="text-[12px] text-mist-400">阅读 {fmtNum(w.reads)} · 互动 {fmtNum(w.interactions)}</div>
                </div>
                <Button size="sm" variant="outline" loading={busy === w.work_id} disabled={!!busy} icon={<Sparkles className="size-3.5" />} onClick={() => breakdown(w)}>拆解这篇</Button>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-[12px] text-mist-400">只拆解本账号自己的作品。</p>
      </div>
      {result && <BreakdownDialog accountId={accountId} {...result} onClose={() => setResult(null)} />}
    </Card>
  )
}

function BreakdownDialog({ accountId, work, bd, callId, onClose }: { accountId: string; work: TopWork; bd: Breakdown; callId: string; onClose: () => void }) {
  const [remembered, setRemembered] = useState<number[]>([])
  const [name, setName] = useState(`拆解：${work.title}`.slice(0, 20))
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const remember = async (i: number) => {
    try {
      await post(`/accounts/${accountId}/memories`, { kind: 'structure', scope: 'all', text: bd.reusable_rules[i], source: 'breakdown' })
      setRemembered((r) => [...r, i])
      toast.success('已记住，之后写作时会参考')
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const saveTemplate = async () => {
    setSaving(true)
    try {
      const list = await get<OutlineTemplate[]>('/outline-templates')
      const structure = bd.outline_template.map((x) => `${x.heading}（${x.key_point}）`).join(' → ').slice(0, 500)
      await put('/outline-templates', { items: [...list.filter((t) => !t.builtin), { id: '', name: name.trim(), structure }] })
      setSaved(true)
      toast.success('已保存为大纲模板，生成大纲时可以选用')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setSaving(false)
    }
  }
  return (
    <Dialog open onClose={onClose} title={`拆解《${work.title || '未命名'}》`} width="max-w-2xl"
      footer={<Button variant="primary" onClick={onClose}>完成</Button>}>
      <div className="scrollbar-thin max-h-[65vh] space-y-4 overflow-y-auto text-[13.5px]">
        <section>
          <div className="mb-1 font-semibold text-mist-700">结构</div>
          <ol className="list-decimal space-y-0.5 pl-5 text-mist-600">{bd.structure.map((s, i) => <li key={i}>{s}</li>)}</ol>
        </section>
        <section className="grid gap-3 sm:grid-cols-2">
          <div><div className="mb-1 font-semibold text-mist-700">开头方式</div><p className="text-mist-600">{bd.opening}</p></div>
          <div><div className="mb-1 font-semibold text-mist-700">选题角度</div><p className="text-mist-600">{bd.angle}</p></div>
        </section>
        {bd.title_features.length > 0 && (
          <section>
            <div className="mb-1 font-semibold text-mist-700">标题特征</div>
            <div className="flex flex-wrap gap-1.5">{bd.title_features.map((t) => <Badge key={t} tone="gray">{t}</Badge>)}</div>
          </section>
        )}
        {bd.reusable_rules.length > 0 && (
          <section>
            <div className="mb-1 flex items-center gap-1.5 font-semibold text-mist-700"><Brain className="size-4" />可复用的写作规则</div>
            <ul className="space-y-1.5">
              {bd.reusable_rules.map((r, i) => (
                <li key={i} className="flex items-start gap-2 rounded-lg border border-mist-200 p-2">
                  <span className="flex-1 text-mist-700">{r}</span>
                  {remembered.includes(i) ? <Badge tone="ink"><Check className="size-3" />已记住</Badge>
                    : <Button size="sm" variant="ghost" onClick={() => remember(i)}>记住</Button>}
                </li>
              ))}
            </ul>
          </section>
        )}
        {bd.outline_template.length > 0 && (
          <section>
            <div className="mb-1 flex items-center gap-1.5 font-semibold text-mist-700"><LayoutList className="size-4" />大纲模板</div>
            <ol className="mb-2 list-decimal space-y-0.5 pl-5 text-mist-600">
              {bd.outline_template.map((x, i) => <li key={i}><span className="text-mist-800">{x.heading}</span><span className="text-mist-400"> · {x.key_point}</span></li>)}
            </ol>
            <div className="flex items-end gap-2">
              <Field label="模板名称" className="flex-1"><Input value={name} maxLength={20} onChange={(e) => setName(e.target.value)} /></Field>
              <Button variant="secondary" loading={saving} disabled={saved || !name.trim()} onClick={saveTemplate}>{saved ? '已保存' : '保存为大纲模板'}</Button>
            </div>
          </section>
        )}
        <AIFeedback callId={callId} />
      </div>
    </Dialog>
  )
}

interface Digest {
  id: string
  week_start: string
  stats: { published: number; planned: number; reads: number; interactions: number; avg_published_4w: number; titles: string[] }
  content: { summary?: string; highlights?: string[]; next_focus?: string[] }
  created_at: string
}

/** DigestsCard shows the history of weekly digests (EX-B-03). */
export function DigestsCard({ accountId }: { accountId: string }) {
  const q = useQuery({ queryKey: ['digests', accountId], queryFn: () => get<Digest[]>(`/accounts/${accountId}/digests`) })
  const [open, setOpen] = useState<string | null>(null)
  return (
    <Card>
      <CardHeader title="历史周报" desc="每周一根据上周数据生成；没有数据的周不生成" />
      <div className="p-5">
        {!q.data?.length ? <Empty icon={<CalendarRange className="size-5" />} title="还没有周报" desc="有作品发布并录入数据后，下周一会生成第一份周报。"
          action={<Button size="sm" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>去录入数据</Button>} /> : (
          <ul className="space-y-2">
            {q.data.map((d) => (
              <li key={d.id} className="rounded-lg border border-mist-200">
                <button className="flex w-full cursor-pointer items-center gap-3 p-3 text-left" onClick={() => setOpen(open === d.id ? null : d.id)}>
                  <span className="font-medium text-mist-800">{d.week_start} 这一周</span>
                  <span className="text-[12px] text-mist-500">发布 {d.stats.published} 篇 · 阅读 {fmtNum(d.stats.reads)} · 互动 {fmtNum(d.stats.interactions)}</span>
                  <span className="ml-auto text-[11.5px] text-mist-400">{fmtTime(d.created_at)}</span>
                </button>
                {open === d.id && (
                  <div className="space-y-2 border-t border-mist-100 p-3 text-[13px] text-mist-700">
                    <p className="text-[12px] text-mist-500">过去 4 周平均每周发布 {d.stats.avg_published_4w.toFixed(1)} 篇；本周计划 {d.stats.planned} 篇。</p>
                    {d.content.summary && <p className="leading-relaxed">{d.content.summary}</p>}
                    {!!d.content.highlights?.length && <div><div className="font-medium">亮点</div><ul className="list-disc pl-5">{d.content.highlights.map((h, i) => <li key={i}>{h}</li>)}</ul></div>}
                    {!!d.content.next_focus?.length && <div><div className="font-medium">下周关注</div><ul className="list-disc pl-5">{d.content.next_focus.map((h, i) => <li key={i}>{h}</li>)}</ul></div>}
                    {d.stats.titles?.length > 0 && <p className="text-[12px] text-mist-400">涉及作品：{d.stats.titles.map((t) => `《${t}》`).join('')}</p>}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  )
}
