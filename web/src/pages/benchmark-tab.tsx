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
}

interface BenchmarkNote {
  id: string
  target_id: string
  url: string
  title: string
  structure: Record<string, unknown>
  structure_hash: string
  metrics_snapshot: Record<string, unknown>
  takeaways: string[]
  not_borrowable: string[]
  captured_at: string | null
  revision: number
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

function NotesSection({ target, canWrite }: { target: BenchmarkTarget; canWrite: boolean }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [url, setUrl] = useState('')
  const [takeaway, setTakeaway] = useState('')
  const [notBorrow, setNotBorrow] = useState('')
  const [capturedAt, setCapturedAt] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
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
        title, url, structure: { manual: true }, captured_at: capturedAt || null,
        takeaways: takeaway.trim() ? [takeaway.trim()] : [], not_borrowable: notBorrow.trim() ? [notBorrow.trim()] : [],
      })
      setTitle(''); setUrl(''); setTakeaway(''); setNotBorrow(''); setCapturedAt('')
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

  return (
    <div className="mt-2 border-t border-mist-100 pt-2">
      <button type="button" className="flex items-center gap-1 text-[11px] font-semibold text-mist-600" onClick={() => setOpen((v) => !v)}>
        <ChevronRight className={`size-3 transition-transform ${open ? 'rotate-90' : ''}`} />
        <NotebookPen className="size-3" /> 笔记拆解库
        {page.data && <span className="font-normal text-mist-400">（{page.data.items.length} 篇未归档）</span>}
      </button>
      {open && <div className="mt-2 space-y-2">
        {error && <Notice tone="red">{error}</Notice>}
        {canWrite && <div className="grid gap-2 rounded-md border border-mist-100 p-2.5 sm:grid-cols-2">
          <Field label="笔记标题"><Input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} /></Field>
          <Field label="来源 URL（可选）"><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" /></Field>
          <Field label="学到什么（takeaway）"><Input value={takeaway} maxLength={200} onChange={(e) => setTakeaway(e.target.value)} /></Field>
          <Field label="不借鉴什么"><Input value={notBorrow} maxLength={200} onChange={(e) => setNotBorrow(e.target.value)} /></Field>
          <Field label="你看到这篇的时间"><Input type="date" value={capturedAt} onChange={(e) => setCapturedAt(e.target.value)} /></Field>
          <div className="flex items-end"><Button size="sm" variant="secondary" loading={busy} disabled={!canWrite || busy || !title.trim()} onClick={() => void create()}>登记笔记</Button></div>
        </div>}
        {page.data?.items.map((note) => (
          <div key={note.id} className="rounded-md border border-mist-100 p-2 text-[11px]" data-testid="benchmark-note-item">
            <div className="flex items-center gap-2">
              <strong className="text-mist-800">{note.title || '（无标题）'}</strong>
              <span className="text-mist-400">修订 {note.revision}</span>
              <Button size="sm" variant="ghost" className="ml-auto" icon={note.archived_at ? <ArchiveRestore className="size-3" /> : <Archive className="size-3" />}
                disabled={!canWrite} onClick={() => void archive(note, !note.archived_at)}>
                {note.archived_at ? '恢复' : '归档'}
              </Button>
            </div>
            {note.url && <p className="mt-0.5 break-all text-mist-400">{note.url}</p>}
            {note.takeaways.length > 0 && <p className="mt-1 text-mist-600">学习点：{note.takeaways.join('；')}</p>}
            {note.not_borrowable.length > 0 && <p className="text-mist-600">不借鉴：{note.not_borrowable.join('；')}</p>}
            {note.captured_at && <p className="text-mist-400">看到时间：{note.captured_at.slice(0, 10)}（你提供的时间，非系统抓取）</p>}
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
              <NotesSection target={target} canWrite={canWrite} />
            </Card>
          ))}
        </div>
      </Card>
    </div>
  )
}
