import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button, Badge, Card, CardHeader, Empty, Field, Notice, Select, Textarea } from '@/components/ui'
import { ApiError, errorMessage, get, patch, post } from '@/lib/api'
import { fmtNum, relTime } from '@/lib/format'
import { useCanWrite } from '@/lib/session'
import type { PlatformWorkMirrorListItem, PlatformWorkMirrorPage } from '@/lib/types'

type Analysis = {
  overview: string
  pillars: string[]
  findings: { area: 'positioning' | 'content' | 'visual' | 'performance'; message: string; source_refs: string[]; hypothesis: boolean }[]
  actions: { priority: 'high' | 'medium' | 'low'; proposal: string; source_refs: string[]; hypothesis: boolean }[]
}
type ActionState = { action_index: number; status: 'adopted' | 'dismissed' }
type SourceFact = { source_ref: string; kind: string; state: string; values: Record<string, unknown>; as_of_at?: string; as_of_date?: string }
type BasisPreview = {
  cx_basis: { profile_hash: string; input_hash: string; coverage: string; omitted: { ref: string; reason: string }[] }
  source_facts: SourceFact[]
  selection: { default_recent: boolean; platform_work_refs: { id: string; revision: number }[]; include_metrics: boolean; include_followers: boolean }
  task_type: string
  prompt_version: string
  model_route: { primary: { provider_name: string; model: string }; fallback?: { provider_name: string; model: string } }
  context_hash: string
}
type AccountAnalysis = {
  diagnosis_id: string
  result: { analysis: Analysis; source_facts: SourceFact[]; cx_basis: BasisPreview['cx_basis']; selection: BasisPreview['selection']; coverage: string; action_states?: ActionState[] }
  cx_basis: BasisPreview['cx_basis']
  ai_call_id: string
  model: string
  prompt_version: string
  input_hash: string
  stale: boolean
  reused: boolean
  created_at: string
  result_revision: number
}
type AnalysisList = { items: AccountAnalysis[]; next_cursor: string | null }
type UsageSummary = { today_tokens: number; total: { calls: number; cost: number | null } }
type Draft = Analysis

const editable = (analysis: Analysis): Draft => ({
  overview: analysis.overview,
  pillars: [...analysis.pillars],
  findings: analysis.findings.map((item) => ({ ...item, source_refs: [...item.source_refs] })),
  actions: analysis.actions.map((item) => ({ ...item, source_refs: [...item.source_refs] })),
})
const selectionKey = (selected: Record<string, number>, metrics: boolean, followers: boolean, nonce: string) => JSON.stringify({ selected, metrics, followers, nonce })
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
const areaLabel: Record<Analysis['findings'][number]['area'], string> = { positioning: '定位', content: '内容', visual: '视觉', performance: '表现假设' }
const stateLabel = (state: string) => ({ present: '已取得', partial: '部分可用', unavailable: '不可用', unknown: '未知', failed: '读取失败' }[state] ?? state)

export default function AccountAnalysisTab({ accountId }: { accountId: string }) {
  const canWrite = useCanWrite()
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<Record<string, number>>({})
  const [includeMetrics, setIncludeMetrics] = useState(true)
  const [includeFollowers, setIncludeFollowers] = useState(true)
  const [nonce, setNonce] = useState('')
  const [preview, setPreview] = useState<BasisPreview | null>(null)
  const [previewKey, setPreviewKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [controller, setController] = useState<AbortController | null>(null)
  const [reportID, setReportID] = useState('')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [draftRevision, setDraftRevision] = useState(0)
  const [conflict, setConflict] = useState(false)

  const works = useInfiniteQuery({
    queryKey: ['cx-analysis-works', accountId],
    queryFn: ({ pageParam, signal }) => get<PlatformWorkMirrorPage>(`/accounts/${accountId}/platform-works?limit=20${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`, { signal }),
    initialPageParam: '' as string,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  })
  const workItems = works.data?.pages.flatMap((page) => page.items) ?? []
  const history = useQuery({ queryKey: ['cx-account-analysis-history', accountId], queryFn: () => get<AnalysisList>(`/accounts/${accountId}/analyses?kind=account_analysis`) })
  const detail = useQuery({ queryKey: ['cx-account-analysis-detail', reportID], queryFn: () => get<AccountAnalysis>(`/diagnoses/${reportID}`), enabled: !!reportID })
  const usage = useQuery({ queryKey: ['cx-account-analysis-usage', today()], queryFn: () => get<UsageSummary>(`/usage?group_by=day&from=${today()}&to=${today()}`) })
  const currentKey = useMemo(() => selectionKey(selected, includeMetrics, includeFollowers, nonce), [selected, includeMetrics, includeFollowers, nonce])
  const active = detail.data
  const currentStates = new Map((active?.result.action_states ?? []).map((state) => [state.action_index, state.status]))

  useEffect(() => {
    if (!active || editing) return
    setDraft(editable(active.result.analysis))
    setDraftRevision(active.result_revision)
  }, [active, editing])

  const previewBasis = async () => {
    if (!canWrite || busy) return
    setBusy(true)
    setNotice('')
    setPreview(null)
    try {
      const query = new URLSearchParams({ include_metrics: String(includeMetrics), include_followers: String(includeFollowers) })
      Object.entries(selected).forEach(([id, revision]) => query.append('platform_work_ref', `${id}:${revision}`))
      if (nonce) query.set('nonce', nonce)
      const data = await get<BasisPreview>(`/accounts/${accountId}/account-analysis/basis?${query.toString()}`)
      setPreview(data)
      setPreviewKey(currentKey)
    } catch (error) {
      setNotice(errorMessage(error))
    } finally { setBusy(false) }
  }

  const generate = async () => {
    if (!canWrite || !preview || previewKey !== currentKey || busy) return
    setBusy(true)
    setNotice('')
    const aborter = new AbortController()
    setController(aborter)
    try {
      const result = await post<AccountAnalysis>(`/accounts/${accountId}/account-analysis`, {
        basis_profile_hash: preview.cx_basis.profile_hash,
        basis_input_hash: preview.cx_basis.input_hash,
        context_hash: preview.context_hash,
        platform_work_refs: preview.selection.platform_work_refs,
        include_metrics: includeMetrics,
        include_followers: includeFollowers,
        ...(nonce ? { nonce } : {}),
      }, aborter.signal)
      setReportID(result.diagnosis_id)
      setEditing(false)
      setDraft(null)
      await queryClient.invalidateQueries({ queryKey: ['cx-account-analysis-history', accountId] })
      toast.success(result.reused ? '已复用这份分析结果' : '账号分析已完成')
    } catch (error) {
      if (aborter.signal.aborted) setNotice('本次生成已取消，已有报告未变更。')
      else if (error instanceof ApiError && error.status === 409) setNotice('分析依据、模型路由或报告版本已变化。当前输入已保留，请重新预览后再决定是否继续。')
      else setNotice(errorMessage(error))
    } finally { setBusy(false); setController(null) }
  }

  const prepareRegeneration = async () => {
    setNonce(crypto.randomUUID())
    setPreview(null)
    setNotice('已建立新的重新生成请求标识。请先重新预览，确认依据后再生成。')
  }

  const save = async (states: ActionState[] = []) => {
    if (!active || !draft || !canWrite || busy) return
    setBusy(true)
    setNotice('')
    try {
      const saved = await patch<AccountAnalysis>(`/diagnoses/${active.diagnosis_id}/account-analysis`, {
        expected_revision: draftRevision,
        analysis: draft,
        action_states: states,
      })
      queryClient.setQueryData(['cx-account-analysis-detail', active.diagnosis_id], saved)
      await queryClient.invalidateQueries({ queryKey: ['cx-account-analysis-history', accountId] })
      setDraftRevision(saved.result_revision)
      setDraft(editable(saved.result.analysis))
      setConflict(false)
      setEditing(false)
      if (states.length) toast.success('这条建议的反馈已记录；尚未修改任何业务对象')
      else toast.success('分析报告已保存')
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setConflict(true)
        setNotice('这份报告已被其他位置修改。你的编辑仍保留在此页面，可查看最新版本并再次比较。')
      } else setNotice(errorMessage(error))
    } finally { setBusy(false) }
  }

  const recordAction = async (index: number, status: ActionState['status']) => {
    if (!active || !canWrite || busy) return
    setBusy(true)
    setNotice('')
    setDraft(editable(active.result.analysis))
    setDraftRevision(active.result_revision)
    try {
      const response = await patch<AccountAnalysis>(`/diagnoses/${active.diagnosis_id}/account-analysis`, {
        expected_revision: active.result_revision,
        analysis: editable(active.result.analysis),
        action_states: [{ action_index: index, status }],
      })
      queryClient.setQueryData(['cx-account-analysis-detail', active.diagnosis_id], response)
      await queryClient.invalidateQueries({ queryKey: ['cx-account-analysis-history', accountId] })
      toast.success('逐条反馈已保存；不会自动起草、入库或修改账号资料')
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) setNotice('报告版本已变化，反馈未覆盖最新内容；请刷新后再操作。')
      else setNotice(errorMessage(error))
    } finally { setBusy(false) }
  }

  const addFinding = () => setDraft((value) => value && ({ ...value, findings: [...value.findings, { area: 'content', message: '', source_refs: [], hypothesis: true }] }))
  const addAction = () => setDraft((value) => value && ({ ...value, actions: [...value.actions, { priority: 'medium', proposal: '', source_refs: [], hypothesis: true }] }))
  const updateFinding = (index: number, fields: Partial<Draft['findings'][number]>) => setDraft((value) => value && ({ ...value, findings: value.findings.map((item, i) => i === index ? { ...item, ...fields } : item) }))
  const updateAction = (index: number, fields: Partial<Draft['actions'][number]>) => setDraft((value) => value && ({ ...value, actions: value.actions.map((item, i) => i === index ? { ...item, ...fields } : item) }))
  const selectedWorks = workItems.filter((item) => selected[item.id] != null)

  return <div className="space-y-4" data-testid="account-analysis-tab">
    <Notice tone="ink"><p>账号资料与当前定位始终纳入分析依据。可选择同步作品，并控制是否包含正式指标和粉丝数据；缺失字段会标成未知，不会当作零。</p></Notice>
    {!canWrite && <Notice tone="gamboge"><p>观察者可以查看报告历史，不能预览、生成、编辑或反馈。</p></Notice>}

    <Card>
      <CardHeader title="选择本次依据" desc="只读取当前账号已有的平台镜像与服务端快照，不会启动新的平台采集。" />
      <div className="space-y-4 p-5">
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={includeMetrics} disabled={!canWrite || busy} onChange={(event) => setIncludeMetrics(event.target.checked)} />包含正式作品指标</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={includeFollowers} disabled={!canWrite || busy} onChange={(event) => setIncludeFollowers(event.target.checked)} />包含粉丝数据</label>
        </div>
        <p className="text-xs text-mist-500">账号平台资料、定位和策略由服务端按当前版本读取；未勾选任何作品时，服务端默认选择最近最多 20 篇。</p>
        {works.isPending ? <p className="text-sm text-mist-500">正在读取已同步作品目录…</p> : works.error ? <Notice tone="red"><p>{errorMessage(works.error)}</p></Notice> : workItems.length === 0 ? <Empty title="暂时没有可选的平台作品" desc="仍可根据账号资料与定位继续分析。" /> : <div className="max-h-64 space-y-1 overflow-auto rounded-lg border border-mist-200 p-2">
          {workItems.map((work: PlatformWorkMirrorListItem) => <label key={work.id} className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-2 hover:bg-mist-50">
            <input type="checkbox" checked={selected[work.id] != null} disabled={!canWrite || busy} onChange={(event) => setSelected((value) => {
              const next = { ...value }
              if (event.target.checked) {
                if (Object.keys(next).length >= 20) {
                  setNotice('单次分析最多选择 20 篇作品。')
                  return value
                }
                next[work.id] = work.revision
              }
              else delete next[work.id]
              return next
            })} />
            <span className="min-w-0 flex-1"><span className="block truncate text-sm text-mist-800">{work.title || '无标题作品'}</span><span className="mt-0.5 block text-[11px] text-mist-500">{work.published_at ? `发布于 ${new Date(work.published_at).toLocaleDateString()}` : '发布时间未知'} · 正文状态 {work.content_state}</span></span>
          </label>)}
          {works.hasNextPage && <Button size="sm" variant="outline" loading={works.isFetchingNextPage} onClick={() => void works.fetchNextPage()}>加载更多作品</Button>}
        </div>}
        {selectedWorks.length > 0 && <p className="text-xs text-mist-500">已选择 {selectedWorks.length} 篇；服务端上限为 20 篇。</p>}
        {usage.data && <p className="text-xs text-mist-500">工作区今日 AI 用量：{fmtNum(usage.data.today_tokens)} token · {fmtNum(usage.data.total.calls)} 次调用。查看完整报表请前往设置 → 用量。</p>}
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" loading={busy} disabled={!canWrite || works.isPending} onClick={() => void previewBasis()}>预览本次依据与模型</Button>
          <Button variant="outline" disabled={!canWrite || busy || !reportID} onClick={() => void prepareRegeneration()}>重新生成前刷新预览</Button>
          {busy && controller && <Button variant="outline" onClick={() => controller.abort()}>取消生成</Button>}
        </div>
        {notice && <p role="alert" className="text-sm text-red-700">{notice}</p>}
      </div>
    </Card>

    {preview && <Card data-testid="account-analysis-preview">
      <CardHeader title="本次提交快照" desc="以下内容来自服务端；提交时会再次检查来源、提示词和模型路由版本。" />
      <div className="space-y-4 p-5">
        <div className="flex flex-wrap gap-2"><Badge tone={preview.cx_basis.coverage === 'ready' ? 'green' : 'gamboge'}>依据覆盖：{preview.cx_basis.coverage}</Badge><Badge>{preview.task_type}</Badge><Badge>{preview.prompt_version}</Badge><Badge>{preview.model_route.primary.provider_name} / {preview.model_route.primary.model}</Badge>{preview.model_route.fallback && <Badge>备用：{preview.model_route.fallback.provider_name} / {preview.model_route.fallback.model}</Badge>}</div>
        <p className="text-xs text-mist-500">定位依据版本 {preview.cx_basis.profile_hash.slice(0, 12)}… · 输入版本 {preview.cx_basis.input_hash.slice(0, 12)}… · 模型上下文 {preview.context_hash.slice(0, 12)}…</p>
        {preview.source_facts.length ? <div className="grid gap-2 md:grid-cols-2">{preview.source_facts.map((fact) => <div key={fact.source_ref} className="rounded-lg border border-mist-200 p-3">
          <div className="flex items-center justify-between gap-2"><strong className="text-xs text-mist-800">{fact.kind} · {fact.source_ref}</strong><Badge tone={fact.state === 'present' ? 'green' : 'gamboge'}>{stateLabel(fact.state)}</Badge></div>
          <p className="mt-1 text-[11px] text-mist-500">{fact.as_of_at ? `观测于 ${relTime(fact.as_of_at)}` : fact.as_of_date ? `统计日期 ${fact.as_of_date}` : '无单独观测时间'}</p>
          <pre className="mt-2 whitespace-pre-wrap break-words text-xs text-mist-600">{JSON.stringify(fact.values, null, 2)}</pre>
        </div>)}</div> : <Empty title="本次没有可展示的事实字段" desc="仍可查看缺失原因并决定是否继续分析。" />}
        {!!preview.cx_basis.omitted.length && <Notice tone="gamboge"><p className="font-medium">本次缺失项</p><ul className="mt-1 list-disc pl-5">{preview.cx_basis.omitted.map((item) => <li key={`${item.ref}:${item.reason}`}>{item.ref}：{item.reason}</li>)}</ul></Notice>}
        <div className="flex flex-wrap items-center gap-2"><Button variant="primary" loading={busy} disabled={!canWrite || previewKey !== currentKey} onClick={() => void generate()}>生成账号分析</Button><span className="text-xs text-mist-500">只生成报告，不会自动采用任何建议。</span></div>
      </div>
    </Card>}

    <Card>
      <CardHeader title="分析历史" desc="历史只读回看；每份报告按当前依据计算是否过期。" />
      <div className="space-y-2 p-4">
        {history.isPending ? <p className="text-sm text-mist-500">正在读取历史…</p> : history.error ? <Notice tone="red"><p>{errorMessage(history.error)}</p></Notice> : !history.data?.items.length ? <Empty title="还没有账号分析报告" desc="预览本次依据后即可手动生成。" /> : history.data.items.map((item) => <button key={item.diagnosis_id} type="button" onClick={() => { setReportID(item.diagnosis_id); setEditing(false); setConflict(false) }} className={`flex w-full items-start gap-3 rounded-lg border p-3 text-left ${reportID === item.diagnosis_id ? 'border-ink-300 bg-ink-50/50' : 'border-mist-200 hover:bg-mist-50'}`}>
          <span className="min-w-0 flex-1"><span className="block text-sm font-medium text-mist-800">{item.result.analysis.overview}</span><span className="mt-1 block text-xs text-mist-500">{relTime(item.created_at)} · 修订 {item.result_revision} · {item.model || '模型信息缺失'}</span></span><Badge tone={item.stale ? 'gamboge' : 'green'}>{item.stale ? '依据已变化' : '依据当前'}</Badge>
        </button>)}
      </div>
    </Card>

    {active && draft && <Card data-testid="account-analysis-report">
      <CardHeader title="分析报告" desc={`生成于 ${relTime(active.created_at)} · ${active.model || '模型信息缺失'} · 提示词 ${active.prompt_version} · 原始调用 ${active.ai_call_id} · 修订 ${active.result_revision}`} action={<div className="flex gap-2"><Badge tone={active.stale ? 'gamboge' : 'green'}>{active.stale ? '依据已变化，保留历史' : '依据当前'}</Badge>{canWrite && !editing && <Button size="sm" variant="outline" onClick={() => { setDraft(editable(active.result.analysis)); setDraftRevision(active.result_revision); setEditing(true); setConflict(false) }}>编辑报告</Button>}</div>} />
      <div className="space-y-5 p-5">
        {conflict && <Notice tone="gamboge"><p>{notice} <button type="button" className="underline" onClick={() => { void detail.refetch().then((result) => { if (result.data) { setDraft(editable(result.data.result.analysis)); setDraftRevision(result.data.result_revision); setConflict(false); setNotice('') } }) }}>载入最新版本</button></p></Notice>}
        {editing ? <>
          <Field label="分析摘要" hint="最多 500 字；数字、链接与未经验证的事实会被服务端校验。"><Textarea value={draft.overview} onChange={(event) => setDraft({ ...draft, overview: event.target.value })} rows={4} /></Field>
          <Field label="内容支柱" hint="每行一项，最多 8 项。"><Textarea value={draft.pillars.join('\n')} onChange={(event) => setDraft({ ...draft, pillars: event.target.value.split('\n') })} rows={4} /></Field>
          <section className="space-y-3"><div className="flex items-center justify-between"><h3 className="text-sm font-semibold">发现与假设</h3><Button size="sm" variant="outline" onClick={addFinding}>添加一条</Button></div>
            {draft.findings.map((finding, index) => <div key={index} className="grid gap-2 rounded-lg border border-mist-200 p-3 md:grid-cols-[150px_1fr_auto]">
              <Select value={finding.area} onChange={(event) => updateFinding(index, { area: event.target.value as typeof finding.area })}>{Object.entries(areaLabel).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select>
              <Textarea aria-label={`发现 ${index + 1}`} value={finding.message} onChange={(event) => updateFinding(index, { message: event.target.value })} rows={2} />
              <Button size="sm" variant="ghost" onClick={() => setDraft({ ...draft, findings: draft.findings.filter((_, i) => i !== index) })}>移除</Button>
              {!!finding.source_refs.length && <p className="text-xs text-mist-500 md:col-span-3">来源：{finding.source_refs.join('、')} · 待验证假设</p>}
            </div>)}
          </section>
          <section className="space-y-3"><div className="flex items-center justify-between"><h3 className="text-sm font-semibold">建议</h3><Button size="sm" variant="outline" onClick={addAction}>添加一条</Button></div>
            {draft.actions.map((action, index) => <div key={index} className="grid gap-2 rounded-lg border border-mist-200 p-3 md:grid-cols-[130px_1fr_auto]">
              <Select aria-label={`建议 ${index + 1} 优先级`} value={action.priority} onChange={(event) => updateAction(index, { priority: event.target.value as typeof action.priority })}><option value="high">优先级高</option><option value="medium">优先级中</option><option value="low">优先级低</option></Select>
              <Textarea aria-label={`建议 ${index + 1}`} value={action.proposal} onChange={(event) => updateAction(index, { proposal: event.target.value })} rows={2} />
              <Button size="sm" variant="ghost" onClick={() => setDraft({ ...draft, actions: draft.actions.filter((_, i) => i !== index) })}>移除</Button>
              {!!action.source_refs.length && <p className="text-xs text-mist-500 md:col-span-3">来源：{action.source_refs.join('、')} {action.hypothesis ? '· 建议假设' : ''}</p>}
            </div>)}
          </section>
          <div className="flex flex-wrap gap-2"><Button variant="primary" loading={busy} onClick={() => void save()}>保存报告</Button><Button variant="outline" disabled={busy} onClick={() => { setDraft(editable(active.result.analysis)); setEditing(false); setConflict(false); setNotice('') }}>放弃本次编辑</Button></div>
        </> : <>
          <section><h3 className="mb-2 text-sm font-semibold">分析摘要</h3><p className="whitespace-pre-wrap text-sm leading-6 text-mist-700">{active.result.analysis.overview}</p></section>
          {!!active.result.analysis.pillars.length && <section><h3 className="mb-2 text-sm font-semibold">内容支柱</h3><ul className="list-disc space-y-1 pl-5 text-sm text-mist-700">{active.result.analysis.pillars.map((pillar, index) => <li key={index}>{pillar}</li>)}</ul></section>}
          {!!active.result.analysis.findings.length && <section className="space-y-2"><h3 className="text-sm font-semibold">发现与假设</h3>{active.result.analysis.findings.map((finding, index) => <div key={index} className="rounded-lg border border-mist-200 p-3"><div className="mb-1 flex gap-2"><Badge>{areaLabel[finding.area]}</Badge><Badge tone="gamboge">待验证</Badge></div><p className="text-sm text-mist-700">{finding.message}</p>{finding.source_refs.length > 0 && <p className="mt-1 text-xs text-mist-500">来源：{finding.source_refs.join('、')}</p>}</div>)}</section>}
          <section className="space-y-2"><h3 className="text-sm font-semibold">逐项建议</h3>{active.result.analysis.actions.length ? active.result.analysis.actions.map((action, index) => {
            const state = currentStates.get(index)
            return <div key={index} className="rounded-lg border border-mist-200 p-3"><div className="flex flex-wrap items-center gap-2"><Badge tone={action.priority === 'high' ? 'red' : 'gray'}>{action.priority === 'high' ? '优先级高' : action.priority === 'medium' ? '优先级中' : '优先级低'}</Badge>{state && <Badge tone={state === 'adopted' ? 'green' : 'gamboge'}>{state === 'adopted' ? '已标记采用' : '已标记拒绝'}</Badge>}</div><p className="mt-2 text-sm leading-6 text-mist-700">{action.proposal}</p>{action.source_refs.length > 0 && <p className="mt-1 text-xs text-mist-500">依据：{action.source_refs.join('、')}</p>}{canWrite && <div className="mt-3 flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={busy || state === 'adopted'} onClick={() => void recordAction(index, 'adopted')}>标记采用</Button><Button size="sm" variant="outline" disabled={busy || state === 'dismissed'} onClick={() => void recordAction(index, 'dismissed')}>标记拒绝</Button></div>}</div>
          }) : <Empty title="本次没有生成建议" />}</section>
          <Notice tone="ink"><p>采用/拒绝只记录这条报告建议的人工反馈，不会自动起草、入库、发布或修改账号资料。</p></Notice>
          {!!active.result.source_facts.length && <details><summary className="cursor-pointer text-sm font-medium">查看原始依据与数据状态（{active.result.source_facts.length} 项）</summary><div className="mt-3 grid gap-2 md:grid-cols-2">{active.result.source_facts.map((fact) => <div key={fact.source_ref} className="rounded-lg border border-mist-200 p-3"><div className="flex justify-between gap-2"><strong className="text-xs">{fact.kind} · {fact.source_ref}</strong><Badge>{stateLabel(fact.state)}</Badge></div><pre className="mt-2 whitespace-pre-wrap break-words text-xs text-mist-600">{JSON.stringify(fact.values, null, 2)}</pre></div>)}</div></details>}
        </>}
      </div>
    </Card>}
  </div>
}
