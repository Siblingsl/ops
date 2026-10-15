import { Loader2, Sparkles, Star } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { RefsNote, sendFeedback } from '@/components/refs'
import { Badge, Button, Card, cn, Field, Input, Textarea } from '@/components/ui'
import { aiError } from '@/lib/ai-error'
import { ApiError, errorMessage, patch, post, put } from '@/lib/api'
import { type AIRefs, parseTopics, runeLen } from '@/lib/format'
import type { Work } from '@/lib/types'
import { useWorkCmd } from '@/lib/v3'
import { TagSuggest } from './editor-tools'
import { WorkConflictDialog } from './section-save-dialogs'

interface TitleCand { text: string; style: string; chars: number; over_limit: boolean; features: string[]; strong_hits: string[]; call?: string; idx?: number }
interface TitleResp { titles: TitleCand[]; refs: AIRefs; ai_call_id: string; max_chars: number; strong_features: string[] }

// ---------- 标题与摘要 ----------

export function TitleCard({ work, setWork, readOnly }: { work: Work; setWork: (w: Work) => void; readOnly: boolean }) {
  const [conflict, setConflict] = useState<{ server: Work; body: Record<string, unknown> } | null>(null)
  const wx = work.platform === 'wechat_mp'
  const [title, setTitle] = useState(work.title)
  const [summary, setSummary] = useState(work.summary)
  const [topics, setTopics] = useState(work.topics.map((t) => '#' + t).join(' '))
  const [titles, setTitles] = useState<TitleCand[]>([])
  const [titleRefs, setTitleRefs] = useState<AIRefs | null>(null)
  const [titleCall, setTitleCall] = useState<string | null>(null)
  const [strong, setStrong] = useState<string[]>([])
  const toCand = (f: { text: string; style: string }): TitleCand => ({ ...f, chars: runeLen(f.text), over_limit: runeLen(f.text) > (wx ? 32 : 20), features: [], strong_hits: [] })
  const favs = (work.title_favorites ?? []).map(toCand)
  const [rewriting, setRewriting] = useState<string | null>(null)
  const [busy, setBusy] = useState<'t' | 's' | null>(null)
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
  const titleMax = wx ? 32 : 20
  const save = async (body: Record<string, unknown>, base = work.revision) => {
    try {
      setWork(await patch<Work>(`/works/${work.id}`, { ...body, base_revision: base }))
      setConflict(null)
    } catch (e) {
      if (e instanceof ApiError && e.code === 'version_conflict') setConflict({ server: (e.detail as { server: Work }).server, body })
      else toast.error(errorMessage(e))
    }
  }
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
  return (
    <Card id="step-title" className="scroll-mt-24 p-5">
      <h2 className="mb-4 font-display text-[17px] font-bold text-mist-900">标题{wx ? '与摘要' : '与话题'}</h2>
      <div className="space-y-4">
        <Field label="标题" counter={{ value: runeLen(title), max: titleMax }} hint={wx ? '公众号标题不超过 32 字' : '小红书标题字数上限待核实（V-012），暂按 20 字提示'}>
          <div className="flex gap-2">
            <Input value={title} disabled={readOnly} onChange={(e) => setTitle(e.target.value)} invalid={wx && runeLen(title) > 32}
              onBlur={() => { if (title !== work.title && !(wx && runeLen(title) > 32)) { titleEdited(title); void save({ title }) } }} className="font-display text-[15px] font-semibold" />
            {!readOnly && <Button icon={<Sparkles className="size-4" />} loading={busy === 't'} onClick={genTitles}>候选</Button>}
          </div>
        </Field>
        {favs.length > 0 && (
          <div>
            <div className="mb-1.5 text-[12px] font-medium text-mist-600">收藏的候选</div>
            <div className="grid gap-2 sm:grid-cols-2">{favs.map(titleRow)}</div>
          </div>
        )}
        {titles.length > 0 && (
          <div className="space-y-3 rounded-xl bg-mist-50/70 p-3">
            <div className="flex flex-wrap items-center gap-2 text-[12px] text-mist-500">
              标题工作台
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
          <Field label="话题标签" hint="用空格分隔，例如：#职场 #效率。发布时在小红书里用话题选择器添加。">
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
      </div>
      <WorkConflictDialog server={conflict?.server ?? null} mine={{ ...work, title, summary }} onClose={() => setConflict(null)} onResolve={keepMine => {
        if (!conflict) return
        if (keepMine) void save(conflict.body, conflict.server.revision)
        else { setWork(conflict.server); setConflict(null) }
      }} />
    </Card>
  )
}
