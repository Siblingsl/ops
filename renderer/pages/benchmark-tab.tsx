import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Archive, ArchiveRestore, ChevronRight, NotebookPen, Plus, Wand2 } from 'lucide-react'
import { useState } from 'react'
import { Badge, Button, Card, Field, Input, Notice, Select, Textarea } from '@/components/ui'
import { ApiError, errorMessage, get, patch, post } from '@/lib/api'
import { useCanWrite } from '@/lib/session'
import type { Account } from '@/lib/types'

// DEV-CX12 / FR-CX-18：对标账号库与笔记拆解库。
// 四问 fit_score 是服务端投影；本界面只逐项收集答案与理由，不本地算总分。
// 删除用归档替代；额度 50/30，超限显示服务端 409 提示。

type BenchmarkAnswer = { answer: 'yes' | 'no' | 'unknown'; reason: string }
type BenchmarkAnswers = Partial<Record<'sustainable' | 'beyond_single' | 'audience_match' | 'material_support', BenchmarkAnswer>>

interface BenchmarkTarget {
  id: string
  account_id: string
  platform: 'wechat_mp' | 'xhs' | 'toutiao'
  name: string
  url: string
  normalized_url: string
  positioning: string
  follower_band: string
  entry: string | null
  answers: BenchmarkAnswers
  fit_score: number | null
  answered_count: number
  weak_fit: boolean
  status: 'candidate' | 'active' | 'dropped'
  revision: number
  migration_source_key?: string
  archived_at: string | null
  // REF41 I1：监控开关与下次观测（趋势/覆盖面板见 MonitorPanel）。
  monitor_enabled?: boolean
  monitor_interval_hours?: number
  next_observe_at?: string | null
  last_observed_at?: string | null
}

// REF41 I1-A3/A4：趋势点（x 轴是观测序号；无 published_at 时 age_days=null 不补 0）。
interface BenchmarkTrendPoint {
  seq: number
  observed_at: string
  interval_days: number | null
  published_at: string | null
  age_days: number | null
  values: Record<string, unknown>
  quality_state: 'ok' | 'partial' | 'failed'
}

interface BenchmarkDecomposeDraft {
  hook: string
  structure: string[]
  rhythm: string
  takeaways: string[]
  not_borrowable: string[]
  confidence: number
}

interface BenchmarkNote {
  id: string
  target_id: string
  url: string
  title: string
  content_summary: string
  structure: Record<string, unknown>
  structure_hash: string
  metrics_snapshot: Record<string, unknown>
  takeaways: string[] | null
  not_borrowable: string[] | null
  captured_at: string | null
  revision: number
  ai_call_id?: string
  // REF41 I2：AI 初拆只写 decompose_draft；确认后才写 structure。
  decompose_state: 'none' | 'ai_draft' | 'confirmed' | 'failed'
  decompose_revision: number
  decompose_draft: BenchmarkDecomposeDraft | Record<string, never>
  decompose_ai_call_id?: string
  decompose_error: string
  decompose_confirmed_at?: string | null
  archived_at: string | null
}

interface BenchmarkPage { items: BenchmarkTarget[]; next_cursor: number }
interface NotePage { items: BenchmarkNote[]; next_cursor: number }

const answerKeys = ['sustainable', 'beyond_single', 'audience_match', 'material_support'] as const
const answerLabels: Record<(typeof answerKeys)[number], string> = {
  sustainable: '起点可持续', beyond_single: '效果非单篇', audience_match: '读者匹配', material_support: '材料能力支持',
}
const statusLabel: Record<BenchmarkTarget['status'], string> = { candidate: '候选', active: '激活', dropped: '放弃' }

function apiErrorMessage(reason: unknown) {
  if (reason instanceof ApiError && reason.code === 'benchmark_limit') return '已达未归档数量上限（对标 50 / 每对标笔记 30），请先逐项归档。'
  if (reason instanceof ApiError && reason.code === 'benchmark_exists') {
    return reason.message.includes('笔记') ? reason.message : '同账号同平台已存在该 URL；同 URL 不允许重复登记。'
  }
  if (reason instanceof ApiError && reason.code === 'version_conflict') return '内容已被其他窗口修改，请刷新后重试。'
  return errorMessage(reason)
}

// REF41 I1-A3/A4：趋势图只连连续的正常观测；failed/partial 不落 0，也不跨点连线。
function BenchmarkTrendChart({ targetId, points }: { targetId: string; points: BenchmarkTrendPoint[] }) {
  const key = (() => {
    const preferred = ['likes', 'views', 'comments', 'favorites', 'shares', 'plays', 'impressions']
    for (const candidate of preferred) {
      if (points.some((point) => point.quality_state === 'ok' && typeof point.values[candidate] === 'number')) return candidate
    }
    for (const point of points) {
      if (point.quality_state !== 'ok') continue
      const found = Object.entries(point.values).find(([, value]) => typeof value === 'number')
      if (found) return found[0]
    }
    return null
  })()
  if (!key) return null
  const width = 320
  const height = 92
  const padX = 14
  const padY = 14
  const rows = points.map((point, index) => {
    const numeric = point.quality_state === 'ok' && typeof point.values[key] === 'number'
      ? Number(point.values[key]) : null
    return { point, index, numeric }
  })
  const values = rows.flatMap((row) => row.numeric == null ? [] : [row.numeric])
  if (!values.length) return null
  const min = Math.min(...values)
  const max = Math.max(...values)
  const x = (index: number) => padX + (width - padX * 2) * (rows.length <= 1 ? 0.5 : index / (rows.length - 1))
  const y = (value: number) => padY + (height - padY * 2) * (1 - (value - min) / (max === min ? 1 : max - min))
  const segments: string[] = []
  let current: string[] = []
  for (const row of rows) {
    if (row.numeric == null) {
      if (current.length > 1) segments.push(current.join(' '))
      current = []
      continue
    }
    current.push(`${x(row.index)},${y(row.numeric)}`)
  }
  if (current.length > 1) segments.push(current.join(' '))
  return (
    <div className="mt-2 rounded border border-mist-200 bg-white/70 p-1.5" data-testid={`benchmark-trend-chart-${targetId}`}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="竞对观测趋势：x 轴为观测序号，仅正常观测连线，失败或部分缺失不连线"
        className="h-24 w-full max-w-[360px]">
        <line x1={padX} y1={height - padY} x2={width - padX} y2={height - padY} stroke="#e5e7eb" />
        {segments.map((segment, index) => <polyline key={index} points={segment} fill="none" stroke="#41695b" strokeWidth="2" />)}
        {rows.map((row) => row.numeric == null
          ? <circle key={row.point.seq} cx={x(row.index)} cy={padY} r="3" fill="none" stroke="#9ca3af" strokeWidth="1.5" aria-hidden="true" />
          : <circle key={row.point.seq} cx={x(row.index)} cy={y(row.numeric)} r="2.8" fill="#41695b" aria-hidden="true" />)}
      </svg>
      <p className="text-[10.5px] text-mist-400">{key}：实线仅连接相邻正常观测；空心点表示失败/部分缺失，不连线、不计为 0。</p>
    </div>
  )
}

// REF41 I1：目标卡监控开关 + 间隔 + 趋势只读面板。覆盖不足显示提示，不画虚假连续线。
function MonitorPanel({ target, canWrite }: { target: BenchmarkTarget; canWrite: boolean }) {
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [interval, setIntervalValue] = useState(target.monitor_interval_hours ?? 24)
  const enabled = target.monitor_enabled === true
  const toggle = async (on: boolean) => {
    setBusy(true)
    try {
      await patch(`/benchmark/targets/${target.id}/monitor`, { enabled: on, interval_hours: interval })
      await qc.invalidateQueries({ queryKey: ['benchmarks'] })
    } finally {
      setBusy(false)
    }
  }
  const trendQuery = useQuery({
    queryKey: ['benchmark-trend', target.id],
    queryFn: () => get<{ points: BenchmarkTrendPoint[] }>(`/benchmark/targets/${target.id}/trend`),
    enabled,
  })
  const coverageQuery = useQuery({
    queryKey: ['benchmark-coverage', target.id],
    queryFn: () => get<{ expected: number; observed: number; failed: number; missing: number }>(`/benchmark/targets/${target.id}/coverage`),
    enabled,
  })
  const points = trendQuery.data?.points ?? []
  return (
    <div className="mt-2 rounded-lg border border-mist-200 bg-mist-50/60 p-2.5" data-testid={`benchmark-monitor-${target.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] font-semibold text-mist-800">监控</span>
        {enabled ? <Badge tone="green">开启</Badge> : <Badge tone="gray">关闭</Badge>}
        <label className="flex items-center gap-1 text-[11.5px] text-mist-600">
          间隔
          <input type="number" min={6} max={168} value={interval} disabled={!canWrite || busy}
            data-testid={`benchmark-monitor-interval-${target.id}`}
            className="h-7 w-16 rounded border border-mist-200 px-1.5 text-[11.5px]"
            onChange={(e) => setIntervalValue(Number(e.target.value))} />
          小时（6–168）
        </label>
        {enabled
          ? <Button size="sm" variant="ghost" disabled={!canWrite || busy} onClick={() => void toggle(false)}>关闭监控</Button>
          : <Button size="sm" variant="secondary" disabled={!canWrite || busy} data-testid={`benchmark-monitor-enable-${target.id}`} onClick={() => void toggle(true)}>开启监控</Button>}
        {enabled && target.next_observe_at && <span className="text-[11px] text-mist-400">下次观测 {new Date(target.next_observe_at).toLocaleString('zh-CN')}</span>}
      </div>
      {enabled && (
        <div className="mt-2 space-y-1">
          {coverageQuery.isError && (
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-rose-600" role="alert"
              data-testid={`benchmark-coverage-error-${target.id}`}>
              <span>覆盖数据加载失败：{errorMessage(coverageQuery.error)}</span>
              <Button size="sm" variant="ghost" onClick={() => void coverageQuery.refetch()}>重试</Button>
            </div>
          )}
          {coverageQuery.data && (coverageQuery.data.observed < 2) && (
            <p className="text-[11px] text-gamboge-700" data-testid={`benchmark-coverage-hint-${target.id}`}>
              覆盖不足：仅 {coverageQuery.data.observed} 次观测，趋势仅供参考。
            </p>
          )}
          {trendQuery.isLoading
            ? <p className="text-[11px] text-mist-400">趋势加载中…</p>
            : trendQuery.isError
              ? (
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-rose-600" role="alert"
                  data-testid={`benchmark-trend-error-${target.id}`}>
                  <span>趋势加载失败：{errorMessage(trendQuery.error)}</span>
                  <Button size="sm" variant="ghost" onClick={() => void trendQuery.refetch()}>重试</Button>
                </div>
              )
              : points.length === 0
                ? <p className="text-[11px] text-mist-400">尚无观测数据；开启后由桌面采集按间隔记录。</p>
                : (
                  <>
                    <BenchmarkTrendChart targetId={target.id} points={points} />
                    <ul className="space-y-0.5" data-testid={`benchmark-trend-${target.id}`}>
                      {points.map((point) => (
                        <li key={point.seq} className="flex flex-wrap items-center gap-x-2 text-[11px]">
                          <span className="font-medium text-mist-700">第 {point.seq} 次观测</span>
                          <span className="text-mist-400">{new Date(point.observed_at).toLocaleString('zh-CN')}</span>
                          {point.interval_days != null && <span className="text-mist-500">间隔 {point.interval_days} 天</span>}
                          {point.age_days != null
                            ? <span className="text-mist-500">日龄 {Math.round(point.age_days)} 天</span>
                            : <span className="text-mist-400">日龄未知</span>}
                          {point.quality_state !== 'ok' && (
                            <span className={point.quality_state === 'failed' ? 'text-rose-600' : 'text-gamboge-700'}>
                              {point.quality_state === 'failed' ? '采集失败（不计入 0）' : '部分字段缺失'}
                            </span>
                          )}
                          <span className="text-mist-600">
                            {Object.entries(point.values).filter(([, v]) => typeof v === 'number').map(([k, v]) => `${k} ${v}`).join(' · ') || '无数值'}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
        </div>
      )}
    </div>
  )
}

function TargetEditor({ target, canWrite, onSaved }: { target: BenchmarkTarget; canWrite: boolean; onSaved: (next: BenchmarkTarget) => void }) {
  const [answers, setAnswers] = useState<BenchmarkAnswers>(() => structuredClone(target.answers))
  const [status, setStatus] = useState(target.status)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const dirty = JSON.stringify(answers) !== JSON.stringify(target.answers) || status !== target.status
  const answeredLocally = answerKeys.filter((key) => answers[key] && answers[key].answer !== 'unknown').length

  const save = async () => {
    if (!canWrite || busy || !dirty) return
    setBusy(true)
    setError('')
    try {
      const saved = await patch<BenchmarkTarget>(`/benchmarks/${target.id}`, { base_revision: target.revision, answers, status })
      onSaved(saved)
    } catch (reason) {
      setError(apiErrorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-2 space-y-2 rounded-md border border-mist-100 bg-mist-50/40 p-2.5">
      <p className="text-[11px] font-semibold text-mist-700">四问匹配（yes=25 / no=0，必须给理由；unknown 不算 no，不足 4 问不计分）</p>
      {answerKeys.map((key) => (
        <div key={key} className="grid gap-1.5 sm:grid-cols-[150px_110px_1fr] sm:items-center">
          <span className="text-[11px] text-mist-600">{answerLabels[key]}</span>
          <Select aria-label={`${answerLabels[key]}答案`} className="h-8 text-[12px]" disabled={!canWrite || busy}
            value={answers[key]?.answer ?? ''}
            onChange={(e) => {
              const value = e.target.value as BenchmarkAnswer['answer'] | ''
              setAnswers((current) => {
                const next = { ...current }
                if (!value) delete next[key]
                else next[key] = { answer: value, reason: next[key]?.reason ?? '' }
                return next
              })
            }}>
            <option value="">未回答</option>
            <option value="yes">yes</option>
            <option value="no">no</option>
            <option value="unknown">unknown（不计分）</option>
          </Select>
          <Input aria-label={`${answerLabels[key]}理由`} className="h-8 text-[12px]" placeholder="yes/no 必须写理由（1..500 码点）"
            disabled={!canWrite || busy || answers[key]?.answer === 'unknown' || !answers[key]}
            value={answers[key]?.reason ?? ''}
            onChange={(e) => setAnswers((current) => ({ ...current, [key]: { answer: current[key]?.answer ?? 'yes', reason: e.target.value } }))} />
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-mist-500">状态</span>
        <Select aria-label="对标状态" className="h-8 w-28 text-[12px]" disabled={!canWrite || busy} value={status}
          onChange={(e) => setStatus(e.target.value as BenchmarkTarget['status'])}>
          <option value="candidate">候选</option>
          <option value="active">激活</option>
          <option value="dropped">放弃</option>
        </Select>
        <span className="text-[11px] text-mist-500">
          {target.fit_score === null
            ? `已答 ${answeredLocally}/4 · 总分待四问答完由服务端计算`
            : `fit_score ${target.fit_score}${target.weak_fit ? ' · weak_fit（低匹配提示，不改排序）' : ''}`}
        </span>
        {dirty && <Button size="sm" variant="primary" className="ml-auto" loading={busy} disabled={!canWrite || busy} onClick={() => void save()}>保存四问</Button>}
      </div>
      {error && <Notice tone="red">{error}</Notice>}
    </div>
  )
}


// DEV-CX12 / FR-CX-14：单篇结构拆解。临时参考正文只在本请求内发送给所选模型，
// 不落库；合格骨架直接写入该对标的笔记（同 URL CAS 更新、无 URL 新建）。
function ExtractSection({ target, canWrite, onCreated }: { target: BenchmarkTarget; canWrite: boolean; onCreated: () => void }) {
  const [open, setOpen] = useState(false)
  const [reference, setReference] = useState('')
  const [noteURL, setNoteURL] = useState('')
  const [capturedAt, setCapturedAt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ structure: Record<string, unknown>; structure_hash: string } | null>(null)
  const codePoints = Array.from(reference.trim()).length
  const tooShort = codePoints > 0 && codePoints < 300
  const tooLong = codePoints > 20000

  const extract = async () => {
    if (!canWrite || busy || tooShort || tooLong) return
    setBusy(true)
    setError('')
    setResult(null)
    try {
      const saved = await post<{ structure: Record<string, unknown>; structure_hash: string }>(`/accounts/${target.account_id}/structure-extract`, {
        reference_text: reference.trim(), target_id: target.id, note_url: noteURL.trim(), captured_at: capturedAt || null,
      })
      setResult(saved)
      setReference('')
      onCreated()
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === 'extraction_copy_risk') setError('拆解结果与参考正文重合度过高，未保存；请更换文章或重试。')
      else if (reason instanceof ApiError && reason.code === 'version_conflict') setError('该 URL 的笔记已被他人更新，请刷新后重试。')
      else setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-2">
      <button type="button" className="flex items-center gap-1 text-[11px] font-semibold text-mist-600" onClick={() => setOpen((v) => !v)}>
        <ChevronRight className={`size-3 transition-transform ${open ? 'rotate-90' : ''}`} />
        <Wand2 className="size-3" /> AI 结构拆解
        <span className="font-normal text-mist-400">（粘贴单篇正文，300..20000 码点）</span>
      </button>
      {open && <div className="mt-2 space-y-2 rounded-md border border-mist-100 p-2.5">
        <p className="text-[10px] leading-relaxed text-mist-500">
          参考正文只用于本次请求发送给所选模型，不会保存到作品、笔记或上下文；模型返回前会校验与原文的重合度，重合过高时拒绝保存。不会自动抓取链接。
        </p>
        <Textarea aria-label="参考正文" rows={6} value={reference} disabled={!canWrite || busy}
          onChange={(e) => setReference(e.target.value)} placeholder="粘贴一篇对标笔记的完整正文（300..20000 码点）" />
        <p className="text-[10px] text-mist-400">{codePoints} 码点{tooShort ? ' · 不足 300' : tooLong ? ' · 超过 20000，请精简' : ''}</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="笔记 URL（可选，同 URL 将更新已有笔记）"><Input value={noteURL} onChange={(e) => setNoteURL(e.target.value)} placeholder="https://" /></Field>
          <Field label="你看到这篇的时间（可选）"><Input type="date" value={capturedAt} onChange={(e) => setCapturedAt(e.target.value)} /></Field>
        </div>
        <Button size="sm" variant="secondary" loading={busy} disabled={!canWrite || busy || tooShort || tooLong} onClick={() => void extract()}>生成结构拆解</Button>
        {error && <Notice tone="red">{error}</Notice>}
        {result && <div className="rounded-md border border-ink-100 bg-ink-50/40 p-2 text-[11px]" data-testid="structure-extract-result">
          <p className="font-semibold text-ink-800">拆解完成，已存入下方笔记列表（哈希 {result.structure_hash.slice(0, 12)}…）</p>
          <p className="mt-1 text-mist-600">钩子：{String((result.structure as Record<string, string>).hook_type)} · CTA：{String((result.structure as Record<string, string>).cta_type)}</p>
        </div>}
      </div>}
    </div>
  )
}

function noteDecomposeLines(items: string[] | undefined) {
  return (items ?? []).join('\n')
}

function splitDecomposeLines(value: string) {
  return value.split('\n').map((item) => item.trim()).filter(Boolean)
}

function noteHasDecomposeDraft(note: BenchmarkNote) {
  return note.decompose_state === 'ai_draft' && Boolean((note.decompose_draft as Partial<BenchmarkDecomposeDraft>).hook)
}

function NoteContentSummary({ note, canWrite, onChanged }: { note: BenchmarkNote; canWrite: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(note.content_summary ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const save = async () => {
    if (!canWrite || busy) return
    setBusy(true)
    setError('')
    try {
      await patch(`/benchmark-notes/${note.id}`, { base_revision: note.revision, content_summary: value.trim() })
      setEditing(false)
      onChanged()
    } catch (reason) {
      setError(apiErrorMessage(reason))
    } finally {
      setBusy(false)
    }
  }
  return <div className="mt-1 rounded-md bg-mist-50/60 p-1.5" data-testid="benchmark-note-content-summary">
    {editing ? <>
      <Field label="原文摘要（最多 4000 字；只保存摘要，不保存全文）">
        <Textarea aria-label="编辑原文摘要" rows={4} value={value} maxLength={4000} disabled={!canWrite || busy} onChange={(e) => setValue(e.target.value)} />
      </Field>
      <div className="mt-1 flex items-center gap-2">
        <span className="text-[10px] text-mist-400">{Array.from(value).length}/4000</span>
        <Button size="sm" variant="secondary" loading={busy} disabled={!canWrite || busy} onClick={() => void save()}>保存摘要</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setValue(note.content_summary ?? ''); setEditing(false); setError('') }}>取消</Button>
      </div>
      {error && <Notice tone="red">{error}</Notice>}
    </> : <p className="break-words text-[10px] text-mist-500">
      原文摘要：{note.content_summary ? note.content_summary.slice(0, 240) + (note.content_summary.length > 240 ? '…' : '') : '未填写（AI 初拆前需补充）'}
      {canWrite && <button type="button" className="ml-1 font-semibold text-ink-600" disabled={busy} onClick={() => setEditing(true)}>编辑摘要</button>}
    </p>}
  </div>
}

// REF41 I2：草稿编辑面板。草稿只存在 decompose_draft；确认按钮才写 structure。
function NoteDecomposePanel({ note, canWrite, onChanged }: { note: BenchmarkNote; canWrite: boolean; onChanged: () => void }) {
  const raw = note.decompose_draft as Partial<BenchmarkDecomposeDraft>
  const [hook, setHook] = useState(raw.hook ?? '')
  const [structure, setStructure] = useState(noteDecomposeLines(raw.structure))
  const [rhythm, setRhythm] = useState(raw.rhythm ?? '')
  const [takeaways, setTakeaways] = useState(noteDecomposeLines(raw.takeaways))
  const [notBorrowable, setNotBorrowable] = useState(noteDecomposeLines(raw.not_borrowable))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  if (note.decompose_state === 'confirmed') {
    return <div className="mt-2 rounded-md border border-emerald-100 bg-emerald-50/40 p-2" data-testid="benchmark-decompose-confirmed">
      <p className="text-[11px] font-semibold text-emerald-800">已确认入库 · 拆解修订 {note.decompose_revision}</p>
      {note.decompose_confirmed_at && <p className="text-[10px] text-mist-500">确认时间：{note.decompose_confirmed_at.slice(0, 16).replace('T', ' ')}</p>}
      {note.decompose_error && <p className="mt-1 text-[10px] text-red-600">上次失败：{note.decompose_error}</p>}
    </div>
  }
  if (!noteHasDecomposeDraft(note)) {
    return <div className="mt-2 rounded-md border border-mist-100 bg-mist-50/40 p-2 text-[11px]" data-testid="benchmark-decompose-empty">
      {note.decompose_state === 'failed'
        ? <p className="text-red-600">上次 AI 初拆失败：{note.decompose_error || '未知原因'}；当前结构未改变，可重试。</p>
        : <p className="text-mist-500">尚未 AI 初拆。AI 只生成结构草稿，确认前不写当前结构。</p>}
    </div>
  }

  const confirm = async () => {
    if (!canWrite || busy) return
    setBusy(true); setError('')
    try {
      await post(`/benchmark/notes/${note.id}/decompose/confirm`, {
        draft: {
          hook: hook.trim(), structure: splitDecomposeLines(structure), rhythm: rhythm.trim(),
          takeaways: splitDecomposeLines(takeaways), not_borrowable: splitDecomposeLines(notBorrowable),
          confidence: raw.confidence ?? 0,
        },
      })
      onChanged()
    } catch (reason) {
      setError(apiErrorMessage(reason))
    } finally {
      setBusy(false)
    }
  }
  const discard = async () => {
    if (!canWrite || busy) return
    setBusy(true); setError('')
    try {
      await post(`/benchmark/notes/${note.id}/decompose/discard`, {})
      onChanged()
    } catch (reason) {
      setError(apiErrorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  return <div className="mt-2 space-y-2 rounded-md border border-amber-100 bg-amber-50/30 p-2" data-testid="benchmark-decompose-draft">
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[11px] font-semibold text-amber-900">结构草稿（AI 初拆，未入库）</span>
      <Badge tone="gray">置信度 {Math.round((raw.confidence ?? 0) * 100)}%</Badge>
      {note.decompose_ai_call_id && <span className="text-[10px] text-mist-400">AI call {note.decompose_ai_call_id.slice(0, 8)}…</span>}
    </div>
    <p className="text-[10px] leading-relaxed text-mist-500">当前结构没有被修改。你可以编辑草稿；只有点“确认入库”才写 structure/takeaways/not_borrowable。</p>
    <p className="text-[10px] leading-relaxed text-mist-500" data-testid="benchmark-decompose-source">原文摘要（用户提供，最多 4000 字；只保存摘要，不保存全文）：{note.content_summary ? note.content_summary.slice(0, 800) + (note.content_summary.length > 800 ? '…' : '') : '（未填写）'}</p>
    <Field label="hook（开头钩子）"><Input aria-label="拆解 hook" data-testid="benchmark-decompose-hook" value={hook} maxLength={200} disabled={!canWrite || busy} onChange={(e) => setHook(e.target.value)} /></Field>
    <Field label="structure（每行一项，最多 8 项）"><Textarea aria-label="拆解 structure" data-testid="benchmark-decompose-structure" rows={4} value={structure} disabled={!canWrite || busy} onChange={(e) => setStructure(e.target.value)} /></Field>
    <Field label="rhythm（节奏）"><Input aria-label="拆解 rhythm" value={rhythm} maxLength={200} disabled={!canWrite || busy} onChange={(e) => setRhythm(e.target.value)} /></Field>
    <div className="grid gap-2 sm:grid-cols-2">
      <Field label="takeaways（每行一项）"><Textarea aria-label="拆解 takeaways" rows={3} value={takeaways} disabled={!canWrite || busy} onChange={(e) => setTakeaways(e.target.value)} /></Field>
      <Field label="not_borrowable（每行一项）"><Textarea aria-label="拆解 not_borrowable" rows={3} value={notBorrowable} disabled={!canWrite || busy} onChange={(e) => setNotBorrowable(e.target.value)} /></Field>
    </div>
    {error && <Notice tone="red">{error}</Notice>}
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="primary" loading={busy} disabled={!canWrite || busy} data-testid="benchmark-decompose-confirm" onClick={() => void confirm()}>确认入库</Button>
      <Button size="sm" variant="ghost" disabled={!canWrite || busy} data-testid="benchmark-decompose-discard" onClick={() => void discard()}>丢弃草稿</Button>
    </div>
  </div>
}

function NotesSection({ target, canWrite }: { target: BenchmarkTarget; canWrite: boolean }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [url, setUrl] = useState('')
  const [contentSummary, setContentSummary] = useState('')
  const [takeaway, setTakeaway] = useState('')
  const [notBorrow, setNotBorrow] = useState('')
  const [capturedAt, setCapturedAt] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [batchBusy, setBatchBusy] = useState(false)
  const [batchError, setBatchError] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [decomposingId, setDecomposingId] = useState<string | null>(null)
  const page = useQuery({
    queryKey: ['benchmark-notes', target.id],
    queryFn: () => get<NotePage>(`/benchmarks/${target.id}/notes`),
  })

  const create = async () => {
    if (!canWrite || busy) return
    setBusy(true)
    setError('')
    try {
      // structure 须为 JSON 对象；结构化拆解由 DEV-CX14 的 cx_structure_extract 提供，
      // 本期手工登记先用最小占位骨架，钩子/段落细节在笔记学习点中记录。
      await post(`/benchmarks/${target.id}/notes`, {
        title, url, content_summary: contentSummary.trim(), structure: { manual: true }, captured_at: capturedAt || null,
        takeaways: takeaway.trim() ? [takeaway.trim()] : [], not_borrowable: notBorrow.trim() ? [notBorrow.trim()] : [],
      })
      setTitle(''); setUrl(''); setContentSummary(''); setTakeaway(''); setNotBorrow(''); setCapturedAt('')
      await qc.invalidateQueries({ queryKey: ['benchmark-notes', target.id] })
    } catch (reason) {
      setError(apiErrorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  const archive = async (note: BenchmarkNote, archived: boolean) => {
    if (!canWrite) return
    try {
      await patch(`/benchmark-notes/${note.id}`, { base_revision: note.revision, archived })
      await qc.invalidateQueries({ queryKey: ['benchmark-notes', target.id] })
    } catch (reason) {
      setError(apiErrorMessage(reason))
    }
  }

  const decompose = async (note: BenchmarkNote) => {
    if (!canWrite || decomposingId) return
    setDecomposingId(note.id)
    setError('')
    try {
      await post(`/benchmark/notes/${note.id}/decompose`, {})
      await qc.invalidateQueries({ queryKey: ['benchmark-notes', target.id] })
    } catch (reason) {
      setError(apiErrorMessage(reason))
      await qc.invalidateQueries({ queryKey: ['benchmark-notes', target.id] })
    } finally {
      setDecomposingId(null)
    }
  }

  const toggleSelected = (id: string) => {
    setSelected((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id)
      if (current.length >= 5) return current
      return [...current, id]
    })
  }

  const batchDecompose = async () => {
    if (!canWrite || batchBusy || selected.length < 1 || selected.length > 5) return
    setBatchBusy(true)
    setBatchError('')
    try {
      const result = await post<{ items: Array<{ note_id: string; error?: string }>; count: number }>('/benchmark/decompose-batch', { note_ids: selected })
      const failures = result.items?.filter((item) => item.error) ?? []
      if (failures.length) setBatchError(`有 ${failures.length} 条未生成草稿：${failures.map((item) => item.error).join('；')}`)
      setSelected([])
      await qc.invalidateQueries({ queryKey: ['benchmark-notes', target.id] })
    } catch (reason) {
      setBatchError(apiErrorMessage(reason))
    } finally {
      setBatchBusy(false)
    }
  }

  return (
    <div className="mt-2 border-t border-mist-100 pt-2">
      <button type="button" className="flex items-center gap-1 text-[11px] font-semibold text-mist-600" onClick={() => setOpen((v) => !v)}>
        <ChevronRight className={`size-3 transition-transform ${open ? 'rotate-90' : ''}`} />
        <NotebookPen className="size-3" /> 笔记拆解库
        {page.data && <span className="font-normal text-mist-400">（{page.data.items.length} 篇未归档）</span>}
      </button>
      {open && <div className="mt-2 space-y-2">
        {error && <Notice tone="red">{error}</Notice>}
        {batchError && <Notice tone="red">{batchError}</Notice>}
        {canWrite && <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-100 bg-amber-50/40 p-2" data-testid="benchmark-decompose-batch">
          <span className="text-[11px] font-semibold text-amber-900">批量 AI 初拆</span>
          <span className="text-[10px] text-mist-500">已选 {selected.length}/5 · 只生成草稿，确认仍需逐条</span>
          <Button size="sm" variant="secondary" className="ml-auto" loading={batchBusy} disabled={batchBusy || selected.length < 1} data-testid="benchmark-decompose-batch-button" onClick={() => void batchDecompose()}>批量初拆</Button>
        </div>}
        {canWrite && <div className="grid gap-2 rounded-md border border-mist-100 p-2.5 sm:grid-cols-2">
          <Field label="笔记标题"><Input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} /></Field>
          <Field label="来源 URL（可选）"><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" /></Field>
          <div className="sm:col-span-2">
            <Field label="原文摘要（最多 4000 字；只保存摘要，不保存全文）">
              <Textarea aria-label="原文摘要" rows={3} value={contentSummary} maxLength={4000} onChange={(e) => setContentSummary(e.target.value)} placeholder="用自己的话概括原文的开头钩子、段落推进、节奏和结尾；不要粘贴全文" />
            </Field>
            <p className="mt-1 text-[10px] text-mist-400">{Array.from(contentSummary).length}/4000 · AI 初拆会使用这段摘要</p>
          </div>
          <Field label="学到什么（takeaway）"><Input value={takeaway} maxLength={200} onChange={(e) => setTakeaway(e.target.value)} /></Field>
          <Field label="不借鉴什么"><Input value={notBorrow} maxLength={200} onChange={(e) => setNotBorrow(e.target.value)} /></Field>
          <Field label="你看到这篇的时间"><Input type="date" value={capturedAt} onChange={(e) => setCapturedAt(e.target.value)} /></Field>
          <div className="flex items-end"><Button size="sm" variant="secondary" loading={busy} disabled={!canWrite || busy || !title.trim()} onClick={() => void create()}>登记笔记</Button></div>
        </div>}
        {page.data?.items.map((note) => (
          <div key={note.id} className="rounded-md border border-mist-100 p-2 text-[11px]" data-testid="benchmark-note-item">
            <div className="flex items-center gap-2">
              {canWrite && !note.archived_at && <input type="checkbox" aria-label={`选择拆解 ${note.title || note.id}`} data-testid="benchmark-note-select" checked={selected.includes(note.id)} disabled={!selected.includes(note.id) && selected.length >= 5} onChange={() => toggleSelected(note.id)} />}
              <strong className="text-mist-800">{note.title || '（无标题）'}</strong>
              <span className="text-mist-400">修订 {note.revision}</span>
              {note.decompose_state === 'confirmed' && <Badge tone="gray">已拆解 · 修订 {note.decompose_revision}</Badge>}
              {note.decompose_state === 'ai_draft' && <Badge tone="gray">草稿待确认</Badge>}
              {note.decompose_state === 'failed' && <Badge tone="gray">拆解失败</Badge>}
              {canWrite && <Button size="sm" variant="secondary" className="ml-auto" loading={decomposingId === note.id}
                disabled={!canWrite || Boolean(decomposingId) || Boolean(note.archived_at) || !(note.content_summary ?? '').trim()} title={!(note.content_summary ?? '').trim() ? '请先补充原文摘要' : undefined} data-testid="benchmark-note-decompose"
                onClick={() => void decompose(note)}>{note.decompose_state === 'ai_draft' ? '查看/重试' : 'AI 初拆'}</Button>}
              <Button size="sm" variant="ghost" className={canWrite ? '' : 'ml-auto'} icon={note.archived_at ? <ArchiveRestore className="size-3" /> : <Archive className="size-3" />}
                disabled={!canWrite} onClick={() => void archive(note, !note.archived_at)}>
                {note.archived_at ? '恢复' : '归档'}
              </Button>
            </div>
            {note.url && <p className="mt-0.5 break-all text-mist-400">{note.url}</p>}
            <NoteContentSummary note={note} canWrite={canWrite && !note.archived_at} onChanged={() => void qc.invalidateQueries({ queryKey: ['benchmark-notes', target.id] })} />
            <p className="mt-1 break-words text-[10px] text-mist-500" data-testid="benchmark-note-current-structure">当前结构：{JSON.stringify(note.structure).slice(0, 180) || '空'}</p>
            {(note.takeaways ?? []).length > 0 && <p className="mt-1 text-mist-600">学习点：{(note.takeaways ?? []).join('；')}</p>}
            {(note.not_borrowable ?? []).length > 0 && <p className="text-mist-600">不借鉴：{(note.not_borrowable ?? []).join('；')}</p>}
            {note.captured_at && <p className="text-mist-400">看到时间：{note.captured_at.slice(0, 10)}（你提供的时间，非系统抓取）</p>}
            {(note.decompose_state === 'ai_draft' || note.decompose_state === 'confirmed' || note.decompose_state === 'failed') && <NoteDecomposePanel key={`${note.id}-${note.decompose_state}-${note.decompose_ai_call_id ?? ''}-${note.decompose_revision}`} note={note} canWrite={canWrite} onChanged={() => void qc.invalidateQueries({ queryKey: ['benchmark-notes', target.id] })} />}
          </div>
        ))}
        {!page.data?.items.length && page.isSuccess && <p className="text-[11px] text-mist-400">还没有笔记；每篇拆解单独登记，不自动抓取链接。</p>}
        <ExtractSection target={target} canWrite={canWrite} onCreated={() => void qc.invalidateQueries({ queryKey: ['benchmark-notes', target.id] })} />
      </div>}
    </div>
  )
}

export default function BenchmarkTab({ account }: { account: Account }) {
  const qc = useQueryClient()
  const canWrite = useCanWrite()
  const [filter, setFilter] = useState<'all' | BenchmarkTarget['status']>('all')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [positioning, setPositioning] = useState('')
  const [band, setBand] = useState('unknown')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const page = useQuery({
    queryKey: ['benchmarks', account.id, filter],
    queryFn: () => get<BenchmarkPage>(`/accounts/${account.id}/benchmarks${filter === 'all' ? '' : `?status=${filter}`}`),
  })

  const create = async () => {
    if (!canWrite || busy || !name.trim()) return
    setBusy(true)
    setError('')
    try {
      await post(`/accounts/${account.id}/benchmarks`, { platform: account.platform, name: name.trim(), url, positioning, follower_band: band })
      setName(''); setUrl(''); setPositioning(''); setBand('unknown')
      await qc.invalidateQueries({ queryKey: ['benchmarks', account.id] })
    } catch (reason) {
      setError(apiErrorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  const patchTarget = async (target: BenchmarkTarget, change: Record<string, unknown>) => {
    try {
      await patch(`/benchmarks/${target.id}`, { base_revision: target.revision, ...change })
      await qc.invalidateQueries({ queryKey: ['benchmarks', account.id] })
    } catch (reason) {
      setError(apiErrorMessage(reason))
    }
  }

  return (
    <div className="space-y-4" data-testid="benchmark-tab">
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[15px] font-bold text-mist-900">对标账号库</h2>
          <Badge tone="gray">候选 / 激活 / 放弃 · 上限 50 个未归档</Badge>
          <div className="ml-auto flex items-center gap-2">
            <span className="text-[11px] text-mist-500">状态过滤</span>
            <Select aria-label="对标状态过滤" className="h-8 w-24 text-[12px]" value={filter}
              onChange={(e) => setFilter(e.target.value as typeof filter)}>
              <option value="all">全部</option><option value="candidate">候选</option>
              <option value="active">激活</option><option value="dropped">放弃</option>
            </Select>
          </div>
        </div>
        <p className="mt-1 text-[12px] leading-relaxed text-mist-500">
          记录值得学习的对标账号与笔记拆解；库归属当前账号，platform 是对方平台，不代表我方身份。不访问 URL，也不自动生成任何内容。
        </p>
        {error && <div className="mt-2"><Notice tone="red">{error}</Notice></div>}
        {canWrite && <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <Field label="名称（1..100 码点）"><Input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="主页 URL（可选）"><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" /></Field>
          <Field label="定位摘要（可选）"><Input value={positioning} maxLength={500} onChange={(e) => setPositioning(e.target.value)} /></Field>
          <div className="flex items-end gap-2">
            <Field label="粉丝量级">
              <Select className="h-9 text-[12px]" value={band} onChange={(e) => setBand(e.target.value)}>
                <option value="unknown">未知</option><option value="<1k">&lt;1k</option>
                <option value="1k-1w">1k-1w</option><option value="1w-10w">1w-10w</option><option value="10w+">10w+</option>
              </Select>
            </Field>
            <Button size="sm" variant="primary" className="mb-0.5" icon={<Plus className="size-3.5" />} loading={busy}
              disabled={!canWrite || busy || !name.trim()} onClick={() => void create()}>添加对标</Button>
          </div>
        </div>}
        {page.isLoading && <p className="mt-3 text-[12px] text-mist-400">加载中…</p>}
        {page.data && page.data.items.length === 0 && <p className="mt-3 text-[12px] text-mist-400">还没有对标账号。旧的运营方案对标不会自动带答案，会以候选状态出现在这里。</p>}
        <div className="mt-3 space-y-2" data-testid="benchmark-list">
          {page.data?.items.map((target) => (
            <Card key={target.id} className="p-3" data-testid="benchmark-target-item">
              <div className="flex flex-wrap items-center gap-2">
                <strong className="text-[13px] text-mist-900">{target.name}</strong>
                <Badge tone="gray">{statusLabel[target.status]}</Badge>
                {target.weak_fit && <Badge tone="gamboge">weak_fit</Badge>}
                {target.migration_source_key && <span className="text-[10px] text-mist-400">来自旧方案，未作答</span>}
                <div className="ml-auto flex gap-1">
                  {target.status !== 'active' && <Button size="sm" variant="ghost" disabled={!canWrite} onClick={() => void patchTarget(target, { status: 'active' })}>激活</Button>}
                  {target.status !== 'candidate' && <Button size="sm" variant="ghost" disabled={!canWrite} onClick={() => void patchTarget(target, { status: 'candidate' })}>转候选</Button>}
                  {target.status !== 'dropped' && <Button size="sm" variant="ghost" disabled={!canWrite} onClick={() => void patchTarget(target, { status: 'dropped' })}>放弃</Button>}
                  <Button size="sm" variant="ghost" icon={<Archive className="size-3.5" />} disabled={!canWrite} aria-label="归档对标"
                    onClick={() => void patchTarget(target, { archived: true })} />
                </div>
              </div>
              {target.url && <p className="mt-0.5 break-all text-[11px] text-mist-400">{target.url}</p>}
              {target.positioning && <p className="mt-0.5 text-[11px] text-mist-600">{target.positioning}</p>}
              <p className="mt-0.5 text-[11px] text-mist-400">{target.platform} · 粉丝 {target.follower_band === 'unknown' ? '未知' : target.follower_band}{target.entry ? ` · 来源 ${target.entry}` : ''}</p>
              <TargetEditor target={target} canWrite={canWrite} onSaved={() => void qc.invalidateQueries({ queryKey: ['benchmarks', account.id] })} />
              <MonitorPanel target={target} canWrite={canWrite} />
              <NotesSection target={target} canWrite={canWrite} />
            </Card>
          ))}
        </div>
      </Card>
    </div>
  )
}
