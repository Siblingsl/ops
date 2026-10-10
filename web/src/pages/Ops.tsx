import { DailyStatsCard } from './ops/DailyStats'
import { DailyPanel } from './ops/Daily'
import { References } from './ops/References'
import { useQuery } from '@tanstack/react-query'
import { Sparkles } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { confirm } from '@/components/dialog'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Empty,
  Field,
  formatLabel,
  HumanGate,
  Input,
  Notice,
  PageHeader,
  Select,
  Spinner,
  Tabs,
  Textarea,
} from '@/components/ui'
import { aiError } from '@/lib/ai-error'
import { errorMessage, get, post, stream } from '@/lib/api'
import { useCanWrite, useCurrentAccount, useInvalidate } from '@/lib/session'
import type {
  Account,
  AccountPlan,
  PlanSlot,
  PositioningOption,
  Strategy,
  StrategyFields,
  StrategyResult,
  StrategyRevision,
} from '@/lib/types'
import HotPanel from './ops/Hot'

const stages = { cold_start: '起号', growth: '成长', stable: '稳定' }
const weekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const labels = {
  niche: '赛道',
  audience: '目标读者',
  differentiation: '差异化',
  persona: '人设',
  pillars: '内容支柱',
  cadence: '发布节奏',
  stage: '阶段',
  goals: '目标',
  keywords: '追踪关键词',
  taboo: '禁区',
  benchmarks: '对标',
  blocked_words: '禁用 / 屏蔽词',
  hot_enabled: '账号启用热点',
  daily_settings: '今日推荐设置',
}
const cloneFields = (s: StrategyFields): StrategyFields => JSON.parse(JSON.stringify(s))
const showValue = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value, null, 2))
const formats = (account: Account) => (account.platform === 'wechat_mp' ? ['long_article', 'comic'] : ['image_note', 'comic'])

function StrategySummary({ strategy }: { strategy: StrategyFields }) {
  return (
    <div className="space-y-3 text-sm text-mist-700">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="font-semibold text-mist-900">{strategy.niche}</h4>
        <Badge tone="ink">{stages[strategy.stage]}</Badge>
      </div>
      {(['audience', 'differentiation', 'persona'] as const).map((key) => (
        <p key={key}>
          <span className="font-medium">{labels[key]}：</span>
          {strategy[key] || '未填写'}
        </p>
      ))}
      <div className="space-y-2">
        {strategy.pillars.map((p) => (
          <div key={p.name} className="rounded-lg bg-mist-50 p-3">
            <strong>
              {p.name} · {p.ratio}%
            </strong>
            <p>{p.desc}</p>
            <p className="mt-1 text-xs text-mist-500">示例：{(p.examples ?? []).join('；')}</p>
          </div>
        ))}
      </div>
      <p>
        节奏：每周 {strategy.cadence.per_week} 篇 · {strategy.cadence.days.map((d) => weekdays[d - 1]).join('、')} ·{' '}
        {formatLabel[strategy.cadence.format]}
      </p>
      <p>账号热点设置：{strategy.hot_enabled ? '启用' : '关闭'}</p>
      {(['goals', 'keywords', 'taboo', 'blocked_words'] as const).map((key) => (
        <p key={key}>
          {labels[key]}：{(strategy[key] ?? []).join('、') || '未填写'}
        </p>
      ))}
      {(strategy.benchmarks ?? []).map((b, i) => (
        <div key={i}>
          <strong>对标：{b.name}</strong>
          <p>{b.note}</p>
          {(b.links ?? []).map((url) => (
            <a key={url} href={url} target="_blank" rel="noreferrer" className="block break-all text-ink-600">
              {url}
            </a>
          ))}
        </div>
      ))}
    </div>
  )
}

function StrategyEditor({
  account,
  initial,
  callId,
  choiceIndex,
  onSaved,
  onCancel,
}: {
  account: Account
  initial: StrategyFields
  callId?: string | null
  choiceIndex?: number
  onSaved: () => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(() => cloneFields(initial))
  const [sync, setSync] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const inv = useInvalidate()
  const set = <K extends keyof StrategyFields>(key: K, next: StrategyFields[K]) => setValue((v) => ({ ...v, [key]: next }))
  const ratio = value.pillars.reduce((sum, p) => sum + p.ratio, 0)
  const valid =
    value.niche.trim() &&
    value.pillars.length >= 3 &&
    value.pillars.length <= 5 &&
    ratio === 100 &&
    value.pillars.every((p) => p.name.trim() && Number.isInteger(p.ratio) && p.ratio > 0 && p.ratio <= 100) &&
    new Set(value.pillars.map((p) => p.name.trim())).size === value.pillars.length &&
    value.cadence.days.length > 0
  const save = async () => {
    if (!valid) return
    if (
      sync.length &&
      !(await confirm({
        title: '确认同步账号档案？',
        desc: `将同步：${sync.map((k) => labels[k as keyof typeof labels]).join('、')}。禁用词会合并到档案。`,
        confirmText: '同步并启用',
      }))
    )
      return
    setSaving(true)
    try {
      await post(`/accounts/${account.id}/strategy`, { ...value, sync_profile: sync, ai_call_id: callId, choice_index: choiceIndex })
      await inv(['strategy', account.id], ['plan', account.id], ['references', account.id], ['account-hot', account.id], ['hot-trends', account.id], ['daily', account.id], ['next-actions', account.id], ['profile', account.id], ['health', account.id], ['dashboard', account.id])
      toast.success('已启用新方案，今天起未采用的槽位已更新')
      onSaved()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setSaving(false)
    }
  }
  return (
    <fieldset disabled={saving} className="space-y-4">
      <Badge tone="ink">3. 编辑并启用方案</Badge>
      {(['niche', 'audience', 'differentiation', 'persona'] as const).map((key) => (
        <Field key={key} label={labels[key]} required={key === 'niche'}>
          <Textarea rows={2} value={value[key]} onChange={(e) => set(key, e.target.value)} />
        </Field>
      ))}
      <div className="space-y-3">
        <h4 className="text-sm font-semibold">内容支柱（3–5 个）</h4>
        {value.pillars.some((p) => p.ratio > 66) && <Notice>某个支柱占比超过三分之二。为避免同支柱连续超过两次，大纲的实际分配可能偏离占比；可以调整占比以改善分布。</Notice>}
        {value.pillars.map((p, i) => (
          <div key={i} className="space-y-2 rounded-lg border border-mist-200 p-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <Field label="名称">
                <Input
                  value={p.name}
                  onChange={(e) =>
                    set(
                      'pillars',
                      value.pillars.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)),
                    )
                  }
                />
              </Field>
              <Field label="占比 %">
                <Input
                  type="number"
                  min={1}
                  max={100}
                  value={p.ratio}
                  onChange={(e) =>
                    set(
                      'pillars',
                      value.pillars.map((x, j) => (j === i ? { ...x, ratio: Number(e.target.value) } : x)),
                    )
                  }
                />
              </Field>
            </div>
            <Field label="说明">
              <Textarea
                rows={2}
                value={p.desc}
                onChange={(e) =>
                  set(
                    'pillars',
                    value.pillars.map((x, j) => (j === i ? { ...x, desc: e.target.value } : x)),
                  )
                }
              />
            </Field>
            <Field label="示例选题（每行一个）">
              <Textarea
                rows={3}
                value={(p.examples ?? []).join('\n')}
                onChange={(e) =>
                  set(
                    'pillars',
                    value.pillars.map((x, j) => (j === i ? { ...x, examples: e.target.value.split('\n') } : x)),
                  )
                }
              />
            </Field>
            <Button
              size="sm"
              variant="ghost"
              disabled={saving || value.pillars.length <= 3}
              onClick={() =>
                set(
                  'pillars',
                  value.pillars.filter((_, j) => j !== i),
                )
              }
            >
              移除支柱
            </Button>
          </div>
        ))}
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            disabled={saving || value.pillars.length >= 5}
            onClick={() => set('pillars', [...value.pillars, { name: '', desc: '', ratio: 1, examples: [] }])}
          >
            添加支柱
          </Button>
          <span className={ratio === 100 ? 'text-sm text-mist-500' : 'text-sm text-danger'}>占比合计 {ratio}%（必须为 100%）</span>
        </div>
      </div>
      <fieldset>
        <legend className="mb-2 text-sm font-medium">计划发布日 · 每周 {value.cadence.days.length} 篇</legend>
        <div className="flex flex-wrap gap-3">
          {weekdays.map((day, i) => (
            <label key={day} className="flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                checked={value.cadence.days.includes(i + 1)}
                onChange={(e) => {
                  const days = e.target.checked ? [...value.cadence.days, i + 1].sort() : value.cadence.days.filter((d) => d !== i + 1)
                  set('cadence', { ...value.cadence, days, per_week: days.length })
                }}
              />
              {day}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="作品形态">
          <Select value={value.cadence.format} onChange={(e) => set('cadence', { ...value.cadence, format: e.target.value })}>
            {formats(account).map((f) => (
              <option key={f} value={f}>
                {formatLabel[f]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="阶段">
          <Select value={value.stage} onChange={(e) => set('stage', e.target.value as StrategyFields['stage'])}>
            {Object.entries(stages).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {(['goals', 'keywords', 'taboo', 'blocked_words'] as const).map((key) => (
        <Field key={key} label={`${labels[key]}（每行一个）`}>
          <Textarea rows={2} value={(value[key] ?? []).join('\n')} onChange={(e) => set(key, e.target.value.split('\n'))} />
        </Field>
      ))}
      <div className="space-y-2">
        <h4 className="text-sm font-semibold">对标（启用方案后，单篇链接进入参考队列）</h4>
        <p className="text-xs text-mist-500">小红书和公众号目前受 robots 限制，请在对标参考中手动粘贴正文提炼；每次最多添加 20 个单篇链接。</p>
        {(value.benchmarks ?? []).map((b, i) => (
          <div key={i} className="space-y-2 rounded-lg border border-mist-200 p-3">
            <Field label="名称">
              <Input
                value={b.name}
                onChange={(e) =>
                  set(
                    'benchmarks',
                    value.benchmarks.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)),
                  )
                }
              />
            </Field>
            <Field label="我欣赏它什么">
              <Textarea
                value={b.note}
                onChange={(e) =>
                  set(
                    'benchmarks',
                    value.benchmarks.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)),
                  )
                }
              />
            </Field>
            <Field label="代表作链接（每行一个，最多 5 条）">
              <Textarea
                value={(b.links ?? []).join('\n')}
                onChange={(e) =>
                  set(
                    'benchmarks',
                    value.benchmarks.map((x, j) => (j === i ? { ...x, links: e.target.value.split('\n') } : x)),
                  )
                }
              />
            </Field>
            <Button
              size="sm"
              variant="ghost"
              disabled={saving}
              onClick={() =>
                set(
                  'benchmarks',
                  value.benchmarks.filter((_, j) => j !== i),
                )
              }
            >
              移除对标
            </Button>
          </div>
        ))}
        <Button
          size="sm"
          disabled={saving || (value.benchmarks ?? []).length >= 10}
          onClick={() => set('benchmarks', [...(value.benchmarks ?? []), { name: '', note: '', links: [] }])}
        >
          添加对标
        </Button>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={value.hot_enabled} onChange={(e) => set('hot_enabled', e.target.checked)} />
        账号启用热点
      </label>
      <div className="grid gap-3 md:grid-cols-2">
 <Field label="今日推荐生成方式"><Select value={String(value.daily_settings.generate??'inherit')} onChange={e=>{const d={...value.daily_settings};if(e.target.value==='inherit')delete d.generate;else d.generate=e.target.value;set('daily_settings',d)}}><option value="inherit">沿用工作区默认</option><option value="off">关闭，只手动生成</option><option value="on_open">打开时准备</option><option value="background">每天后台准备（近 7 天活跃）</option></Select></Field>
 <Field label="后台生成小时（北京时间）"><Input type="number" min={0} max={23} value={Number(value.daily_settings.hour??7)} onChange={e=>set('daily_settings',{...value.daily_settings,hour:Number(e.target.value)})}/></Field>
 {(['primary_count','alternate_count'] as const).map(key=><Field key={key} label={key==='primary_count'?'主推数量（0 按发布日）':'备选数量（0 沿用默认）'}><Input type="number" min={0} max={5} value={Number(value.daily_settings[key]??0)} onChange={e=>set('daily_settings',{...value.daily_settings,[key]:Number(e.target.value)})}/></Field>)}
 </div>
      <HumanGate code="人工确认">启用后保存为新版本，并重建今天起未采用的槽位。计划日期仅供内容规划。</HumanGate>
      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm font-medium">将同步以下字段（默认不勾选）</legend>
        {(['audience', 'persona', 'blocked_words'] as const).map((key) => (
          <label key={key} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              disabled={saving}
              checked={sync.includes(key)}
              onChange={(e) => setSync((s) => (e.target.checked ? [...s, key] : s.filter((k) => k !== key)))}
            />
            {labels[key]}：{showValue(value[key])}
          </label>
        ))}
      </fieldset>
      <div className="flex gap-2">
        <Button variant="human" disabled={!valid} loading={saving} onClick={save}>
          启用方案
        </Button>
        <Button disabled={saving} variant="ghost" onClick={onCancel}>
          取消
        </Button>
      </div>
    </fieldset>
  )
}

function StrategyPanel({ account }: { account: Account }) {
  const canWrite = useCanWrite()
  const inv = useInvalidate()
  const query = useQuery({ queryKey: ['strategy', account.id], queryFn: () => get<StrategyResult>(`/accounts/${account.id}/strategy`) })
  const [question, setQuestion] = useState({
    domain: '',
    experiences: '',
    audience: '',
    weekly_hours: 5,
    format: account.content_format as string,
    goal: '',
  })
  const [samples, setSamples] = useState('')
  const [options, setOptions] = useState<PositioningOption[]>([])
  const [editor, setEditor] = useState<StrategyFields | null>(null)
  const [callId, setCallId] = useState<string | null>(null)
  const [choice, setChoice] = useState<number | undefined>()
  const [busy, setBusy] = useState(false)
  const [streamText, setStreamText] = useState('')
  const [history, setHistory] = useState(false)
  const [selectedVersion, setSelectedVersion] = useState<Strategy | null>(null)
  const [note, setNote] = useState('')
  const [revision, setRevision] = useState<StrategyRevision | null>(null)
  const [decisions, setDecisions] = useState<Record<number, 'accept' | 'ignore'>>({})
  const abort = useRef<AbortController | null>(null)
  useEffect(() => () => abort.current?.abort(), [])
  const active = query.data?.active
  const generate = async () => {
    setBusy(true)
    setStreamText('')
    setOptions([])
    abort.current = new AbortController()
    try {
      const done = await stream<{ result: { options: PositioningOption[] }; ai_call_id: string }>(
        `/accounts/${account.id}/strategy/options`,
        { ...question, samples: samples.trim() ? [{ title: '旧作品', content: samples }] : [] },
        { signal: abort.current.signal, onDelta: (d) => setStreamText((s) => s + d) },
      )
      if (!done?.result?.options?.length) throw new Error('未返回有效方案，请重新生成')
      setOptions(done.result.options)
      setCallId(done.ai_call_id)
    } catch (e) {
      if ((e as Error).name !== 'AbortError') aiError(e, '生成运营方案', generate)
    } finally {
      setBusy(false)
    }
  }
  const revise = async () => {
    setBusy(true)
    try {
      setRevision(await post<StrategyRevision>(`/accounts/${account.id}/strategy/revise`, { note }))
      setDecisions({})
    } catch (e) {
      aiError(e, '调整方案', revise)
    } finally {
      setBusy(false)
    }
  }
  const restore = async (version: Strategy) => {
    if (
      !(await confirm({
        title: `恢复方案 v${version.version}？`,
        desc: '将复制为新版本，并重建今天起未采用的槽位。账号档案不会自动同步。',
        confirmText: '恢复为新版本',
      }))
    )
      return
    setBusy(true)
    try {
      await post(`/accounts/${account.id}/strategy/versions/${version.version}/restore`)
      await inv(['strategy', account.id], ['plan', account.id], ['references', account.id], ['account-hot', account.id], ['hot-trends', account.id], ['daily', account.id], ['next-actions', account.id])
      setSelectedVersion(null)
      toast.success('已恢复为新版本')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const accepted = Object.values(decisions).filter((v) => v === 'accept').length
  const editRevision = () => {
    if (!revision) return
    const next = cloneFields(revision.current)
    revision.changes.forEach((change, i) => {
      if (decisions[i] === 'accept') Object.assign(next, { [change.field]: change.to })
    })
    setEditor(next)
    setCallId(revision.ai_call_id)
    setChoice(undefined)
    setRevision(null)
  }
  return (
    <Card>
      <CardHeader
        title="运营方案"
        desc="先确定真实定位与内容节奏，再逐条选择要写的内容。"
        action={
          active && !editor ? (
            <Tabs
              value={history ? 'history' : 'current'}
              onChange={(v) => setHistory(v === 'history')}
              items={[
                { value: 'current', label: '当前方案' },
                { value: 'history', label: '版本历史' },
              ]}
            />
          ) : undefined
        }
      />
      <div className="p-5">
        {query.isPending ? (
          <Spinner />
        ) : query.isError ? (
          <Notice tone="red">
            {errorMessage(query.error)}
            <Button size="sm" onClick={() => query.refetch()}>
              重试
            </Button>
          </Notice>
        ) : editor ? (
          <StrategyEditor
            account={account}
            initial={editor}
            callId={callId}
            choiceIndex={choice}
            onSaved={() => {
              setEditor(null)
              setOptions([])
              setRevision(null)
            }}
            onCancel={() => setEditor(null)}
          />
        ) : active ? (
          <div className="space-y-4">
            {history ? (
              <>
                <div className="flex flex-wrap gap-2">
                  {(query.data?.versions ?? []).map((v) => (
                    <Button key={v.id} size="sm" disabled={busy} onClick={() => setSelectedVersion(v)}>
                      v{v.version} · {v.status === 'active' ? '使用中' : new Date(v.created_at).toLocaleDateString('zh-CN')}
                    </Button>
                  ))}
                </div>
                {selectedVersion && (
                  <>
                    <StrategySummary strategy={selectedVersion} />
                    {canWrite && selectedVersion.status !== 'active' && (
                      <Button variant="human" loading={busy} onClick={() => restore(selectedVersion)}>
                        恢复此版本
                      </Button>
                    )}
                  </>
                )}
              </>
            ) : (
              <>
                <Badge tone="ink">当前 v{active.version}</Badge>
                <StrategySummary strategy={active} />
                {canWrite && (
                  <>
                    <Field label="调整意见（可选）">
                      <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="结合你的实际反馈，说明想调整什么" />
                    </Field>
                    <div className="flex gap-2">
                      <Button loading={busy} onClick={revise}>
                        调整方案
                      </Button>
                      <Button
                        disabled={busy}
                        onClick={() => {
                          setEditor(active)
                          setCallId(null)
                          setChoice(undefined)
                        }}
                      >
                        手动编辑
                      </Button>
                    </div>
                    {revision && (
                      <div className="space-y-3">
                        <HumanGate code="逐条确认">接受或忽略每条建议，再检查并启用新版本。</HumanGate>
                        {revision.changes.length === 0 ? (
                          <Notice>暂无调整建议。</Notice>
                        ) : (
                          revision.changes.map((c, i) => (
                            <div key={i} className="space-y-2 rounded-lg border border-mist-200 p-3">
                              <strong className="text-sm">{labels[c.field]}</strong>
                              <div className="grid gap-2 sm:grid-cols-2">
                                <pre className="whitespace-pre-wrap break-words text-xs">原值：{showValue(c.from)}</pre>
                                <pre className="whitespace-pre-wrap break-words text-xs">建议：{showValue(c.to)}</pre>
                              </div>
                              <p className="text-sm text-mist-500">{c.reason}</p>
                              <div className="flex gap-2">
                                <Button
                                  size="sm"
                                  variant={decisions[i] === 'accept' ? 'human' : 'secondary'}
                                  onClick={() => setDecisions((d) => ({ ...d, [i]: 'accept' }))}
                                >
                                  接受
                                </Button>
                                <Button
                                  size="sm"
                                  variant={decisions[i] === 'ignore' ? 'primary' : 'ghost'}
                                  onClick={() => setDecisions((d) => ({ ...d, [i]: 'ignore' }))}
                                >
                                  忽略
                                </Button>
                              </div>
                            </div>
                          ))
                        )}
                        {revision.changes.length > 0 && (
                          <Button
                            variant="human"
                            disabled={!accepted || Object.keys(decisions).length !== revision.changes.length}
                            onClick={editRevision}
                          >
                            检查已接受的 {accepted} 条修改
                          </Button>
                        )}
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        ) : !canWrite ? (
          <Empty title="还没有运营方案" desc="请工作区所有者或编辑成员完成起号向导。" />
        ) : (
          <div className="space-y-4">
            <ol className="flex flex-wrap gap-2 text-sm">
              {['问卷', '对比方案', '编辑并启用'].map((s, i) => (
                <li key={s}>
                  <Badge tone={options.length ? (i === 1 ? 'ink' : 'gray') : i === 0 ? 'ink' : 'gray'}>
                    {i + 1}. {s}
                  </Badge>
                </li>
              ))}
            </ol>
            {busy ? (
              <>
                <Spinner />
                <pre className="max-h-80 overflow-auto whitespace-pre-wrap text-xs">{streamText || '正在根据你的真实经历生成方案…'}</pre>
                <Button onClick={() => abort.current?.abort()}>停止</Button>
              </>
            ) : options.length ? (
              <>
                <div className="grid gap-4 lg:grid-cols-3">
                  {options.map((o, i) => (
                    <div key={i} className="space-y-3 rounded-lg border border-mist-200 p-4">
                      <h4 className="font-semibold">方案 {i + 1}</h4>
                      <StrategySummary strategy={o} />
                      <Notice tone="ink">适合理由：{o.fit_reason}</Notice>
                      <Notice tone="gamboge">风险：{(o.risks ?? []).join('；') || '请结合实际条件核实'}</Notice>
                      <Button
                        onClick={() => {
                          setEditor(o)
                          setChoice(i)
                        }}
                      >
                        选择并编辑
                      </Button>
                    </div>
                  ))}
                </div>
                <Button onClick={() => setOptions([])}>返回修改问卷</Button>
                <Button onClick={generate}>重新生成</Button>
              </>
            ) : (
              <>
                <Notice>平台：{account.platform === 'wechat_mp' ? '公众号' : '小红书'}。差异化依据你提供的真实经历；旧作品可不填。</Notice>
                {(['domain', 'experiences', 'audience', 'goal'] as const).map((key) => (
                  <Field
                    key={key}
                    label={{ domain: '想做的领域', experiences: '真实经历与资源', audience: '想吸引谁', goal: '目标（可选）' }[key]}
                    required={key === 'domain' || key === 'experiences'}
                  >
                    <Textarea
                      rows={key === 'experiences' ? 4 : 2}
                      value={question[key]}
                      onChange={(e) => setQuestion((q) => ({ ...q, [key]: e.target.value }))}
                    />
                  </Field>
                ))}
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="每周投入时间（小时）">
                    <Input
                      type="number"
                      min={1}
                      max={168}
                      value={question.weekly_hours}
                      onChange={(e) => setQuestion((q) => ({ ...q, weekly_hours: Number(e.target.value) }))}
                    />
                  </Field>
                  <Field label="形态">
                    <Select value={question.format} onChange={(e) => setQuestion((q) => ({ ...q, format: e.target.value }))}>
                      {formats(account).map((f) => (
                        <option key={f} value={f}>
                          {formatLabel[f]}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
                <Field label="旧作品（可选，粘贴正文）">
                  <Textarea rows={4} value={samples} onChange={(e) => setSamples(e.target.value)} />
                </Field>
                <Button
                  variant="primary"
                  icon={<Sparkles className="size-4" />}
                  disabled={!question.domain.trim() || !question.experiences.trim()}
                  onClick={generate}
                >
                  生成 2–3 个方案
                </Button>
              </>
            )}
          </div>
        )}
      </div>
    </Card>
  )
}

function PlanPanel({ account }: { account: Account }) {
  const canWrite = useCanWrite()
  const inv = useInvalidate()
  const query = useQuery({ queryKey: ['plan', account.id], queryFn: () => get<AccountPlan>(`/accounts/${account.id}/plan`) })
  const [busy, setBusy] = useState<string | null>(null)
  const [adopting, setAdopting] = useState<PlanSlot | null>(null)
  const [title, setTitle] = useState('')
  const [angle, setAngle] = useState('')
  const run = async (key: string, path: string, body?: unknown) => {
    setBusy(key)
    try {
      const result = await post<{ updated?: number; empty?: number; similar?: unknown[] }>(path, body)
      await inv(['plan', account.id], ['topics', account.id], ['calendar'], ['dashboard', account.id])
      if (key === 'suggest')
        toast.success(`已生成 ${result.updated ?? 0} 个槽位建议，剩余 ${(result.empty ?? 0) - (result.updated ?? 0)} 个空槽位`)
      if (key === 'adopt') {
        setAdopting(null)
        toast.success('已加入选题池和内容日历')
        if (result.similar?.length) toast.info('选题池中有相似选题，请查看并避免重复创作')
      }
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }
  const dateAt = (offset: number) => {
    const date = new Date(`${query.data!.from}T12:00:00`)
    date.setDate(date.getDate() + offset)
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  }
  return (
    <Card>
      <CardHeader
        title="内容大纲"
        desc="未来四周，逐槽采用后进入选题池与日历。"
        action={
          canWrite ? (
            <Button
              loading={busy === 'suggest'}
              disabled={!!busy || !query.data?.has_strategy}
              onClick={() => run('suggest', `/accounts/${account.id}/plan/suggest`)}
            >
              生成本月大纲
            </Button>
          ) : undefined
        }
      />
      {query.isPending ? (
        <div className="p-5">
          <Spinner />
        </div>
      ) : query.isError ? (
        <Notice tone="red">
          {errorMessage(query.error)}
          <Button onClick={() => query.refetch()}>重试</Button>
        </Notice>
      ) : !query.data?.has_strategy ? (
        <Empty title="先启用运营方案" desc="方案启用后，按计划发布日生成槽位。" />
      ) : (
        <div className="space-y-4 p-5">
          <HumanGate code="逐槽采用">AI 只填写建议。每个槽位由你选择采用、换一个或留空。</HumanGate>
          {adopting && (
            <div className="space-y-3 rounded-lg border border-gamboge-200 p-4">
              <h4 className="font-semibold">采用 {adopting.date} 的选题</h4>
              <Field label="标题">
                <Input value={title} onChange={(e) => setTitle(e.target.value)} />
              </Field>
              <Field label="角度">
                <Textarea value={angle} onChange={(e) => setAngle(e.target.value)} />
              </Field>
              <Button
                variant="human"
                disabled={!!busy || !title.trim()}
                onClick={() => run('adopt', `/plan-slots/${adopting.id}/adopt`, { title, angle })}
              >
                确认采用
              </Button>
              <Button variant="ghost" disabled={!!busy} onClick={() => setAdopting(null)}>
                取消
              </Button>
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1100px] table-fixed border-collapse text-sm">
              <thead>
                <tr>
                  {weekdays.map((day) => (
                    <th key={day} className="border border-mist-200 bg-mist-50 p-2">
                      {day}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[0, 1, 2, 3].map((week) => (
                  <tr key={week}>
                    {weekdays.map((_, day) => {
                      const date = dateAt(week * 7 + day)
                      const slots = query.data!.slots.filter((s) => s.date === date)
                      return (
                        <td key={date} className="border border-mist-200 p-2 align-top">
                          <div className="mb-2 text-xs text-mist-500">
                            {date.slice(5)}
                            {date === query.data!.today && <Badge tone="ink">今天</Badge>}
                          </div>
                          {!slots.length && <p className="text-xs text-mist-400">无计划槽位</p>}
                          {slots.map((s) => (
                            <div key={s.id} className="mb-3 space-y-2">
                              <Badge>{s.pillar}</Badge>
                              <p className="text-xs text-mist-500">{formatLabel[s.format]}</p>
                              {s.hot_alternative && <p className="text-xs text-ink-700">可替换为热点选题：{s.hot_alternative.hot_item.title}（见今日热点；由你逐条决定）</p>}
                              {s.status === 'adopted' ? (
                                <>
                                  <Badge tone="green">已采用</Badge>
                                  <p>{s.topic_title || '选题已移除'}</p>
                                  <p className="text-xs text-mist-500">{s.topic_status === 'pending' ? '待定' : s.topic_status === 'adopted' ? '已选用' : s.topic_status === 'dropped' ? '已放弃' : ''}</p>
                                  {s.topic_id && (
                                    <Link className="text-ink-600" to={`/a/${account.id}/topics?focus=${s.topic_id}`}>
                                      查看选题
                                    </Link>
                                  )}
                                  {s.work_id && (
                                    <Link className="block text-ink-600" to={`/works/${s.work_id}`}>
                                      查看作品
                                    </Link>
                                  )}
                                </>
                              ) : (
                                <>
                                  {s.suggestion ? (
                                    <>
                                      <p className="font-medium">{s.suggestion.title}</p>
                                      <p className="text-xs">{s.suggestion.angle}</p>
                                      <p className="text-xs text-mist-500">依据：{s.suggestion.reason}</p>
                                    </>
                                  ) : (
                                    <p className="text-xs text-mist-400">留空</p>
                                  )}
                                  {canWrite && (
                                    <div className="flex flex-wrap gap-1">
                                      <Button
                                        size="sm"
                                        variant="human"
                                        disabled={!!busy || !s.suggestion}
                                        onClick={() => {
                                          setAdopting(s)
                                          setTitle(s.suggestion!.title)
                                          setAngle(s.suggestion!.angle)
                                        }}
                                      >
                                        采用
                                      </Button>
                                      <Button size="sm" disabled={!!busy} onClick={() => run(s.id, `/plan-slots/${s.id}/regenerate`)}>
                                        换一个
                                      </Button>
                                      <Button
                                        size="sm"
                                        variant="ghost"
                                        disabled={!!busy || !s.suggestion}
                                        onClick={() => run(s.id, `/plan-slots/${s.id}/clear`)}
                                      >
                                        留空
                                      </Button>
                                    </div>
                                  )}
                                </>
                              )}
                            </div>
                          ))}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Link to={`/a/${account.id}/calendar`} className="text-sm text-ink-600">
            查看内容日历
          </Link>
        </div>
      )}
    </Card>
  )
}

export default function Ops() {
  const account = useCurrentAccount()
  if (!account) return <Empty title="请选择账号" />
  return (
    <div className="space-y-6">
      <PageHeader title="账号运营" desc={`${account.name} · 定位、内容节奏与每天的创作参考`} />
      <StrategyPanel key={`strategy-${account.id}`} account={account} />
 <DailyStatsCard key={`stats-${account.id}`} accountId={account.id} warningsOnly/>
      <PlanPanel key={`plan-${account.id}`} account={account} />
      <HotPanel key={`hot-${account.id}`} account={account} />
 <References key={`refs-${account.id}`} accountId={account.id} />
      <DailyPanel key={`daily-${account.id}`} accountId={account.id} />
    </div>
  )
}
