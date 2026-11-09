import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { Badge, Button, Card, CardHeader, Empty, Field, Notice, Select, Textarea } from '@/components/ui'
import { ApiError, errorMessage, get, post } from '@/lib/api'
import { relTime } from '@/lib/format'
import { useCanWrite } from '@/lib/session'
import type { PlatformWorkMirrorListItem, PlatformWorkMirrorPage } from '@/lib/types'

type FieldInput = { source: 'platform_snapshot' | 'manual'; value: string }
type Confirmation = { status: 'pass' | 'fail' | 'unknown'; note: string }
type Item = { key: string; label: string; status: 'pass' | 'fail' | 'unknown'; reason: string; source: string; detail?: Record<string, unknown> }
type Stored = {
  schema: number
  inputs: { nickname: FieldInput; bio: FieldInput; avatar_ref: FieldInput; background_info: FieldInput; pinned_content: FieldInput; platform_work_refs: { id: string; revision: number }[] }
  input_sources: Record<string, { kind: string; state: string; revision?: number; observed_at?: string; reason?: string }>
  manual_confirmations: Record<string, Confirmation>
  items: Item[]
  checked_at: string
  input_hash: string
  profile_version: string
  strategy_ref?: string | null
  strategy_version?: number
  platform_snapshot_revision?: number
  ai_is_simulated: boolean
  ai_call_id?: string
  model?: string
  model_route?: string
  prompt_version?: number
  works: { id: string; revision: number; title: string; content_state: string; observed_at?: string }[]
}
type Basis = {
  account_id: string
  basis_profile_hash: string
  platform_snapshot_revision?: number
  positioning: { tags: string[]; audience: string; tone: string }
  platform_snapshot?: { display_name?: string; bio?: string; avatar_ref?: string; field_states: Record<string, string>; revision: number; observed_at: string } | null
  strategy?: { ref: string; version: number; pillars: { name: string; desc: string; ratio: number; examples: string[] }[] } | null
  profile_check?: Stored | null
  stale: boolean
  stale_reasons: string[]
  new_platform_basis_available: boolean
}
type CheckResponse = { saved: boolean; reused: boolean; previous_profile_check_preserved: boolean; warning?: string; profile_check: Stored }
type Form = {
  accountId: string
  nickname: FieldInput
  bio: FieldInput
  avatar_ref: FieldInput
  background_info: FieldInput
  pinned_content: FieldInput
  selected: Record<string, number>
  confirmations: Record<string, Confirmation>
}

const confirmationFields = [
  { key: 'bio_layers', label: '简介层次', prompt: '简介是否包含主题、经验或能提供的价值？' },
  { key: 'avatar_readable', label: '头像可识别', prompt: '请在本人平台主页检查头像主体是否清晰可识别。此页不读取外链头像图像。' },
  { key: 'background_info', label: '背景补充信息', prompt: '补充信息是否有助于理解你的经历或专业背景？' },
  { key: 'pinned_content', label: '置顶内容', prompt: '置顶内容是否帮助读者认识你、方法或案例？不会按发布时间猜测置顶。' },
  { key: 'pillar_coverage', label: '内容支柱覆盖', prompt: '所选本人作品是否体现当前已采用方案的内容支柱？' },
] as const

const fieldValue = (source: string | undefined, value: string | undefined, platformValue: string | undefined): FieldInput => {
  if (source === 'platform_snapshot' && platformValue !== undefined) return { source: 'platform_snapshot', value: platformValue }
  if (source === 'platform_snapshot') return { source: 'manual', value: value ?? '' }
  return { source: 'manual', value: value ?? '' }
}

function makeForm(accountId: string, basis: Basis): Form {
  const saved = basis.profile_check
  const inputs = saved?.inputs
  return {
    accountId,
    nickname: fieldValue(inputs?.nickname.source, inputs?.nickname.value, basis.platform_snapshot?.display_name),
    bio: fieldValue(inputs?.bio.source, inputs?.bio.value, basis.platform_snapshot?.bio),
    avatar_ref: fieldValue(inputs?.avatar_ref.source, inputs?.avatar_ref.value, basis.platform_snapshot?.avatar_ref),
    background_info: { source: 'manual', value: inputs?.background_info.value ?? '' },
    pinned_content: { source: 'manual', value: inputs?.pinned_content.value ?? '' },
    selected: Object.fromEntries((inputs?.platform_work_refs ?? []).map(({ id, revision }) => [id, revision])),
    confirmations: Object.fromEntries(confirmationFields.map(({ key }) => [key, saved?.manual_confirmations?.[key] ?? { status: 'unknown', note: '' }])),
  }
}

const sourceName = (kind: string) => ({ platform_snapshot: '本人平台快照', manual: '人工补充', platform_work_mirror: '本人作品镜像', simulated: 'AI 模拟' }[kind] ?? kind)
const statusName = (status: string) => ({ pass: '通过', fail: '未通过', unknown: '未知' }[status] ?? status)
const statusTone = (status: string) => status === 'pass' ? 'green' : status === 'fail' ? 'red' : 'gamboge'
const sourceKeys: { key: 'nickname' | 'bio' | 'avatar_ref'; title: string; platformKey: string }[] = [
  { key: 'nickname', title: '昵称', platformKey: 'display_name' },
  { key: 'bio', title: '简介', platformKey: 'bio' },
  { key: 'avatar_ref', title: '头像引用', platformKey: 'avatar_ref' },
]

export default function ProfileCheckTab({ accountId }: { accountId: string }) {
  const canWrite = useCanWrite()
  const queryClient = useQueryClient()
  const basis = useQuery({
    queryKey: ['cx-profile-check', accountId],
    queryFn: ({ signal }) => get<Basis>(`/accounts/${accountId}/profile-check`, { signal }),
    staleTime: 0,
  })
  const works = useInfiniteQuery({
    queryKey: ['cx-profile-check-works', accountId],
    queryFn: ({ pageParam, signal }) => get<PlatformWorkMirrorPage>(`/accounts/${accountId}/platform-works?limit=20${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`, { signal }),
    initialPageParam: '' as string,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  })
  const workItems = works.data?.pages.flatMap((page) => page.items) ?? []
  const [form, setForm] = useState<Form | null>(null)
  const [busy, setBusy] = useState(false)
  const [controller, setController] = useState<AbortController | null>(null)
  const [notice, setNotice] = useState('')
  const [attempt, setAttempt] = useState<Stored | null>(null)
  const [savedResult, setSavedResult] = useState<Stored | null>(null)

  useEffect(() => {
    if (!basis.data) return
    setForm((current) => current?.accountId === accountId ? current : makeForm(accountId, basis.data))
    setSavedResult(basis.data.profile_check ?? null)
  }, [accountId, basis.data])

  const selectedCount = Object.keys(form?.selected ?? {}).length
  const selectedWorks = useMemo(() => workItems.filter((work) => form?.selected[work.id] != null), [workItems, form?.selected])
  const currentCheck = attempt ?? savedResult ?? basis.data?.profile_check ?? null
  const completed = currentCheck?.items.filter((item) => item.status === 'pass' || item.status === 'fail').length ?? 0

  const updateField = (key: keyof Pick<Form, 'nickname' | 'bio' | 'avatar_ref' | 'background_info' | 'pinned_content'>, fields: Partial<FieldInput>) => {
    setForm((value) => value && ({ ...value, [key]: { ...value[key], ...fields } }))
  }
  const updateConfirmation = (key: string, fields: Partial<Confirmation>) => {
    setForm((value) => value && ({ ...value, confirmations: { ...value.confirmations, [key]: { ...value.confirmations[key], ...fields } } }))
  }

  const save = async (simulate: boolean) => {
    if (!basis.data || !form || !canWrite || busy) return
    setBusy(true)
    setNotice('')
    setAttempt(null)
    const aborter = new AbortController()
    setController(aborter)
    try {
      const result = await post<CheckResponse>(`/accounts/${accountId}/profile-check`, {
        basis_profile_hash: basis.data.basis_profile_hash,
        platform_snapshot_revision: basis.data.platform_snapshot_revision ?? null,
        inputs: {
          nickname: form.nickname, bio: form.bio, avatar_ref: form.avatar_ref,
          background_info: { source: 'manual', value: form.background_info.value },
          pinned_content: { source: 'manual', value: form.pinned_content.value },
          platform_work_refs: Object.entries(form.selected).map(([id, revision]) => ({ id, revision })),
        },
        manual_confirmations: form.confirmations,
        simulate,
      }, aborter.signal)
      if (result.saved) {
        setSavedResult(result.profile_check)
        setAttempt(null)
        setNotice(result.reused ? '本次输入与已保存结果相同，已复用原结果。' : '自检结果已保存。')
        await queryClient.invalidateQueries({ queryKey: ['cx-profile-check', accountId] })
      } else {
        setAttempt(result.profile_check)
        setNotice(result.warning ?? '本次结果未保存；之前的自检记录保持不变。')
      }
    } catch (error) {
      if (aborter.signal.aborted) setNotice('本次操作已取消，已有自检结果未变更；当前输入仍保留。')
      else if (error instanceof ApiError && error.status === 409) {
        setNotice(`${errorMessage(error)} 当前输入仍保留；请检查新依据后再提交。`)
        void basis.refetch()
      } else setNotice(errorMessage(error))
    } finally {
      setBusy(false)
      setController(null)
    }
  }

  if (basis.isPending || !form) return <div data-testid="profile-check-tab" className="space-y-4"><Card><div className="p-5 text-sm text-mist-500">正在读取主页自检依据…</div></Card></div>
  if (basis.error || !basis.data) return <div data-testid="profile-check-tab" className="space-y-4"><Notice tone="red"><p>{errorMessage(basis.error)}</p></Notice><Button variant="outline" onClick={() => void basis.refetch()}>重试</Button></div>

  const snapshot = basis.data.platform_snapshot
  const savedInputSources = savedResult?.input_sources ?? {}
  const resultIsAttempt = attempt != null

  return <div className="space-y-4" data-testid="profile-check-tab">
    <Notice tone="ink"><p>主页自检只读取本人已有资料和镜像作品。平台字段、人工判断与 AI 文字模拟分别标注来源；未知项不计为通过，也不会阻止发布。</p></Notice>
    {!canWrite && <Notice tone="gamboge"><p>观察者可以查看自检记录，不能保存、模拟或修改人工判断。</p></Notice>}
    {basis.data.stale && <Notice tone="gamboge"><p>已保存的自检依据发生变化，历史结果仍保留但可能过期。{basis.data.stale_reasons.join('；')}</p></Notice>}
    {basis.data.new_platform_basis_available && <Notice tone="gamboge"><p>平台资料有了较新的快照。人工选择的资料不会自动替换；若要采用新快照，请在对应字段点击“使用当前快照”。</p></Notice>}

    <Card>
      <CardHeader title="选择主页资料来源" desc="本人平台快照与人工补充分开保存。同步只产生新依据，不会覆盖你的人工选择。" />
      <div className="space-y-4 p-5">
        {!snapshot && <Notice tone="gamboge"><p>尚无可用的平台资料快照；昵称、简介与头像引用可人工补充，来源会明确标注。</p></Notice>}
        {sourceKeys.map(({ key, title, platformKey }) => {
          const input = form[key]
          const platformValue = snapshot?.[key === 'nickname' ? 'display_name' : key]
          const state = snapshot?.field_states?.[platformKey] ?? 'unknown'
          const source = snapshot ? savedInputSources[key] : undefined
          return <Field key={key} label={title} hint={input.source === 'platform_snapshot'
            ? `来源：本人平台快照 · 状态 ${state} · ${snapshot ? `修订 ${snapshot.revision}，观测于 ${relTime(snapshot.observed_at)}` : '没有快照'}`
            : `来源：人工补充 · ${source?.reason ?? (state === 'present' ? '人工选择保留独立于平台快照' : `平台字段状态 ${state}`)}`}>
            <Textarea aria-label={title} value={input.source === 'platform_snapshot' ? (platformValue ?? input.value) : input.value}
              readOnly={input.source === 'platform_snapshot'} rows={key === 'bio' ? 3 : 2} disabled={!canWrite || busy}
              onChange={(event) => updateField(key, { value: event.target.value })} />
            <div className="mt-2 flex flex-wrap gap-2">
              {input.source !== 'manual' && <Button size="sm" variant="outline" disabled={!canWrite || busy} onClick={() => updateField(key, { source: 'manual', value: platformValue ?? input.value })}>改为人工补充</Button>}
              {input.source !== 'platform_snapshot' && platformValue !== undefined && <Button size="sm" variant="outline" disabled={!canWrite || busy} onClick={() => updateField(key, { source: 'platform_snapshot', value: platformValue })}>使用当前快照</Button>}
              {input.source === 'platform_snapshot' && platformValue === undefined && <span className="text-xs text-red-700">平台字段当前不可用；请改用人工补充或保留为未知。</span>}
            </div>
          </Field>
        })}

        <Field label="背景信息（人工补充）" hint="当前同步链路没有背景字段，留空时结果为未知。">
          <Textarea aria-label="背景信息（人工补充）" value={form.background_info.value} rows={2} disabled={!canWrite || busy} onChange={(event) => updateField('background_info', { value: event.target.value })} />
        </Field>
        <Field label="置顶内容说明（人工补充）" hint="没有可靠置顶标记，不按发布时间推断。请说明本人主页中置顶内容的主题或作用。">
          <Textarea aria-label="置顶内容说明（人工补充）" value={form.pinned_content.value} rows={2} disabled={!canWrite || busy} onChange={(event) => updateField('pinned_content', { value: event.target.value })} />
        </Field>

        <div className="rounded-lg border border-mist-200 p-3">
          <h3 className="text-sm font-semibold">当前账号定位与内容方案</h3>
          <p className="mt-1 text-xs text-mist-500">定位标签：{basis.data.positioning.tags?.length ? basis.data.positioning.tags.join('、') : '未知'} · 目标读者：{basis.data.positioning.audience || '未知'} · 表达语气：{basis.data.positioning.tone || '未知'}</p>
          {basis.data.strategy?.pillars?.length ? <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-mist-700">{basis.data.strategy.pillars.map((pillar, index) => <li key={`${pillar.name}:${index}`}>{pillar.name}{pillar.desc ? `：${pillar.desc}` : ''}</li>)}</ul> : <p className="mt-2 text-sm text-mist-500">没有已采用的内容方案，内容支柱覆盖会显示未知。</p>}
        </div>
      </div>
    </Card>

    <Card>
      <CardHeader title="选择本人作品" desc="只用于人工核对当前内容支柱，不发送作品正文或指标给主页模拟任务。最多选择 20 篇。" />
      <div className="space-y-3 p-5">
        {works.isPending ? <p className="text-sm text-mist-500">正在读取已同步作品目录…</p> : works.error ? <Notice tone="red"><p>{errorMessage(works.error)}</p></Notice> : workItems.length === 0 ? <Empty title="暂时没有可选的平台作品" desc="内容支柱覆盖将保持未知；可先完成其他主页自检项。" /> : <div className="max-h-64 space-y-1 overflow-auto rounded-lg border border-mist-200 p-2">
          {workItems.map((work: PlatformWorkMirrorListItem) => <label key={work.id} className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-2 hover:bg-mist-50">
            <input type="checkbox" checked={form.selected[work.id] != null} disabled={!canWrite || busy} onChange={(event) => setForm((value) => {
              if (!value) return value
              const next = { ...value.selected }
              if (event.target.checked) {
                if (Object.keys(next).length >= 20) { setNotice('主页自检最多选择 20 篇本人作品。'); return value }
                next[work.id] = work.revision
              } else delete next[work.id]
              return { ...value, selected: next }
            })} />
            <span className="min-w-0 flex-1"><span className="block truncate text-sm text-mist-800">{work.title || '无标题作品'}</span><span className="mt-0.5 block text-[11px] text-mist-500">{work.published_at ? `发布于 ${new Date(work.published_at).toLocaleDateString()}` : '发布时间未知'} · 正文状态 {work.content_state} · 修订 {work.revision}</span></span>
          </label>)}
          {works.hasNextPage && <Button size="sm" variant="outline" loading={works.isFetchingNextPage} disabled={!canWrite || busy} onClick={() => void works.fetchNextPage()}>加载更多作品</Button>}
        </div>}
        {selectedWorks.length > 0 && <p className="text-xs text-mist-500">当前已选择 {selectedCount} 篇作品。</p>}
        {selectedCount > selectedWorks.length && <p className="text-xs text-mist-500">另有 {selectedCount - selectedWorks.length} 篇已保存选择未出现在当前列表页；继续加载目录可查看。</p>}
      </div>
    </Card>

    <Card>
      <CardHeader title="逐项人工确认" desc="每一项由你明确选择通过、未通过或未知。头像视觉与置顶状态不由模型推断。" />
      <div className="space-y-4 p-5">
        {confirmationFields.map(({ key, label, prompt }) => <div key={key} className="grid gap-3 rounded-lg border border-mist-200 p-3 md:grid-cols-[minmax(0,1fr)_150px]">
          <div><h3 className="text-sm font-semibold">{label}</h3><p className="mt-1 text-xs text-mist-500">{prompt}</p><Textarea aria-label={`${label}判断依据`} placeholder="填写判断依据；未知时可留空" value={form.confirmations[key]?.note ?? ''} rows={2} disabled={!canWrite || busy} onChange={(event) => updateConfirmation(key, { note: event.target.value })} /></div>
          <Field label="判断状态"><Select aria-label={`${label}状态`} value={form.confirmations[key]?.status ?? 'unknown'} disabled={!canWrite || busy} onChange={(event) => updateConfirmation(key, { status: event.target.value as Confirmation['status'] })}><option value="unknown">未知</option><option value="pass">通过</option><option value="fail">未通过</option></Select></Field>
        </div>)}
      </div>
    </Card>

    <Card>
      <CardHeader title="保存或模拟读者反应" desc="模拟只读取文字摘要，不是真实读者测试；不会读取头像图像、作品正文、粉丝数或效果数据。" />
      <div className="space-y-3 p-5">
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" loading={busy} disabled={!canWrite} onClick={() => void save(true)}>保存并模拟文字第一印象</Button>
          <Button variant="outline" loading={busy} disabled={!canWrite} onClick={() => void save(false)}>仅保存当前自检</Button>
          {busy && controller && <Button variant="outline" onClick={() => controller.abort()}>取消</Button>}
        </div>
        {notice && <p role="status" className="text-sm text-mist-700">{notice}</p>}
        {!canWrite && <p className="text-xs text-mist-500">当前角色只有读取权限。</p>}
      </div>
    </Card>

    {currentCheck && <Card data-testid="profile-check-result">
      <CardHeader title={resultIsAttempt ? '本次未保存的尝试' : '主页自检结果'} desc={`${relTime(currentCheck.checked_at)} · ${sourceName('simulated')} · ${currentCheck.model || '未运行模型'} · 提示词版本 ${currentCheck.prompt_version ?? '未知'}`} action={<Badge tone={resultIsAttempt ? 'gamboge' : currentCheck.items.some((item) => item.status === 'unknown') ? 'gamboge' : 'green'}>{resultIsAttempt ? '未保存' : `已完成 ${completed}/7`}</Badge>} />
      <div className="space-y-4 p-5">
        {resultIsAttempt && <Notice tone="gamboge"><p>本次结果未覆盖已保存记录。你当前的输入仍在上方表单中；旧记录保持不变。</p></Notice>}
        {currentCheck.items.map((item) => <div key={item.key} className="rounded-lg border border-mist-200 p-3">
          <div className="flex flex-wrap items-center gap-2"><strong className="text-sm text-mist-800">{item.label}</strong><Badge tone={statusTone(item.status)}>{statusName(item.status)}</Badge><Badge>{sourceName(item.source)}</Badge></div>
          <p className="mt-1 text-sm leading-6 text-mist-700">{item.reason}</p>
          {item.key === 'first_impression' && item.detail && <div className="mt-2 space-y-1 rounded-md bg-mist-50 p-3 text-sm text-mist-600"><p>可能理解：{String(item.detail.understood ?? '未知')}</p><p>可能获得：{String(item.detail.value ?? '未知')}</p>{Array.isArray(item.detail.unclear) && item.detail.unclear.length > 0 && <p>仍不清楚：{item.detail.unclear.map(String).join('、')}</p>}<p className="text-xs text-mist-500">AI 模拟推断，不代表真实读者测试、受众反馈或内容效果。</p></div>}
        </div>)}
        <details><summary className="cursor-pointer text-sm font-medium">查看来源、版本与缺失说明</summary><div className="mt-3 grid gap-2 md:grid-cols-2">{Object.entries(currentCheck.input_sources).map(([key, source]) => <div key={key} className="rounded-lg border border-mist-200 p-3"><div className="flex items-center justify-between gap-2"><strong className="text-xs">{key} · {sourceName(source.kind)}</strong><Badge>{source.state}</Badge></div><p className="mt-1 text-xs text-mist-500">{source.revision != null ? `修订 ${source.revision}` : '无平台修订号'} · {source.observed_at ? `观测于 ${relTime(source.observed_at)}` : '无平台观测时间'}</p>{source.reason && <p className="mt-1 text-xs text-mist-600">{source.reason}</p>}</div>)}</div><p className="mt-2 text-xs text-mist-500">资料版本 {currentCheck.profile_version.slice(0, 12)}… · 快照修订 {currentCheck.platform_snapshot_revision ?? '无'} · 记录时间 {new Date(currentCheck.checked_at).toLocaleString()}</p></details>
        <Notice tone="ink"><p>该结果是辅助核对清单，不是发布门槛。所有建议和状态都需要你逐项查看；没有任何自动采用、起草或写入动作。</p></Notice>
      </div>
    </Card>}
  </div>
}
