import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { confirm } from '@/components/dialog'
import { Badge, Button, Input, Select, Textarea } from '@/components/ui'
import { errorMessage, get, patch, post, del } from '@/lib/api'
import type { AgentConversation, AgentModel } from '@/lib/agent'
import { ContextPickerDialog, type AgentContextSelection } from './ContextPickers'
import { useAccounts } from '@/lib/session'

type Routine = {
  id: string
  revision: number
  name: string
  prompt: string
  public_context_refs: Array<{ type: string; id: string; revision: string; scope: string; name?: string }>
  account_id: string
  cadence: 'once' | 'daily' | 'weekly'
  weekday?: number
  time_of_day: string
  once_at?: string | null
  timezone: 'Asia/Shanghai'
  destination: 'current' | 'new'
  conversation_id?: string | null
  model: { provider_id: string; model: string }
  status: 'enabled' | 'paused' | 'completed' | 'deleted' | string
  next_due_at?: string | null
  failure_count: number
  error_code?: string
  last_run_at?: string | null
}

type Occurrence = {
  id: string
  due_at: string
  kind: 'scheduled' | 'manual'
  status: string
  error_code?: string
  started_at?: string
  finished_at?: string
}

type RoutineDraft = {
  name: string
  prompt: string
  accountID: string
  cadence: 'once' | 'daily' | 'weekly'
  weekday: number
  timeOfDay: string
  onceAt: string
  destination: 'current' | 'new'
  model: string
}

const emptyDraft = (): RoutineDraft => ({ name: '', prompt: '', accountID: '', cadence: 'daily', weekday: 1,
  timeOfDay: '09:00', onceAt: '', destination: 'new', model: '' })

const statusLabel: Record<string, string> = {
  enabled: '已启用', paused: '已暂停', completed: '已结束', deleted: '已删除',
  pending: '等待调度', leased: '已取得租约', running: '运行中',
  failed: '失败', missed: '错过', interrupted: '中断',
}
const occurrenceStatusLabel: Record<string, string> = { ...statusLabel, completed: '已完成' }

function modelKey(model?: { provider_id?: string | null; model?: string | null }) {
  return model?.provider_id && model.model ? `${model.provider_id}::${model.model}` : ''
}

function modelValue(value: string) {
  const [provider_id, ...name] = value.split('::')
  return provider_id && name.length ? { provider_id, model: name.join('::') } : undefined
}

function formatDate(value?: string | null) {
  return value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '未安排'
}

function formatShanghaiInput(value?: string | null) {
  if (!value) return ''
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(value))
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`
}

export function RoutinePanel({ open, canManage, models, conversation }: {
  open: boolean
  canManage: boolean
  models: AgentModel[]
  conversation?: AgentConversation
}) {
  const qc = useQueryClient()
  const accounts = useAccounts()
  const [editingID, setEditingID] = useState<string | null>(null)
  const [draft, setDraft] = useState<RoutineDraft>(emptyDraft)
  const [saving, setSaving] = useState(false)
  const [historyID, setHistoryID] = useState<string | null>(null)
  const [contextsOpen, setContextsOpen] = useState(false)
  const [contextRefs, setContextRefs] = useState<AgentContextSelection[]>([])
  const requestIDs = useRef(new Map<string, string>())
  const defaultsApplied = useRef(false)
  const list = useQuery({
    queryKey: ['agent-routines'],
    queryFn: () => get<{ items: Routine[]; server_models?: AgentModel[] }>('/agent/routines'),
    enabled: open,
    staleTime: 0,
  })
  const activeAccounts = useMemo(() => (accounts.data ?? []).filter((item) => item.status === 'active'), [accounts.data])
  const serverModels = useMemo(() => list.data?.server_models ?? models.filter((item) => item.execution_location !== 'desktop'), [list.data?.server_models, models])

  useEffect(() => {
    if (!open) {
      defaultsApplied.current = false
      return
    }
    if (!list.isSuccess || defaultsApplied.current) return
    defaultsApplied.current = true
    const accountID = conversation?.account_id && activeAccounts.some((item) => item.id === conversation.account_id)
      ? conversation.account_id : activeAccounts[0]?.id ?? ''
    const model = modelKey(serverModels.find((item) => item.is_default) ?? serverModels[0])
    setDraft((old) => ({ ...old, accountID, model,
      destination: conversation && conversation.account_id === accountID ? 'current' : 'new' }))
  }, [open, list.isSuccess, activeAccounts, serverModels, conversation])

  const refresh = async () => Promise.all([
    qc.invalidateQueries({ queryKey: ['agent-routines'] }),
    qc.invalidateQueries({ queryKey: ['agent-routine-occurrences'] }),
  ])
  const requestID = (key: string) => {
    const existing = requestIDs.current.get(key)
    if (existing) return existing
    const value = crypto.randomUUID()
    requestIDs.current.set(key, value)
    return value
  }
  const resetDraft = () => {
    const defaultAccount = conversation?.account_id && activeAccounts.some((item) => item.id === conversation.account_id)
      ? conversation.account_id : activeAccounts[0]?.id ?? ''
    const defaultModel = modelKey(serverModels.find((item) => item.is_default) ?? serverModels[0])
    setDraft({ ...emptyDraft(), accountID: defaultAccount, model: defaultModel,
      destination: conversation && conversation.account_id === defaultAccount ? 'current' : 'new' })
    setContextRefs([])
    setEditingID(null)
  }
  const edit = (routine: Routine) => {
    setEditingID(routine.id)
    setDraft({ name: routine.name, prompt: routine.prompt, accountID: routine.account_id, cadence: routine.cadence,
      weekday: routine.weekday ?? 1, timeOfDay: routine.time_of_day.slice(0, 5),
      onceAt: formatShanghaiInput(routine.once_at), destination: routine.destination,
      model: modelKey(routine.model) })
    setContextRefs(routine.public_context_refs.map((item) => ({ type: item.type, id: item.id, revision: item.revision,
      name: item.name || `${item.type} · ${item.id}`, summary: '已保存的公开业务引用', scope: 'account', account_id: routine.account_id,
      updated_at: '', reference_scope: 'turn' })))
  }
  const payload = () => ({
    name: draft.name.trim(), prompt: draft.prompt.trim(),
    public_context_refs: contextRefs.map((item) => ({ type: item.type, id: item.id, revision: item.revision, name: item.name, scope: 'turn' })),
    account_id: draft.accountID,
    cadence: draft.cadence, weekday: draft.cadence === 'weekly' ? draft.weekday : null,
    time_of_day: draft.timeOfDay, once_at: draft.cadence === 'once' && draft.onceAt ? new Date(`${draft.onceAt}:00+08:00`).toISOString() : null,
    timezone: 'Asia/Shanghai', destination: draft.destination,
    conversation_id: draft.destination === 'current' ? conversation?.id : null, model: modelValue(draft.model),
  })
  const save = async () => {
    if (!canManage || saving || !draft.name.trim() || !draft.prompt.trim() || !draft.accountID || !modelValue(draft.model) ||
        draft.destination === 'current' && (!conversation || conversation.account_id !== draft.accountID) ||
        draft.cadence === 'once' && !draft.onceAt) return
    const body = payload()
    const key = editingID ? `update:${editingID}:${JSON.stringify(body)}` : `create:${JSON.stringify(body)}`
    setSaving(true)
    try {
      if (editingID) await patch(`/agent/routines/${editingID}`, { ...body, expected_revision: list.data?.items.find((item) => item.id === editingID)?.revision, request_id: requestID(key) })
      else await post('/agent/routines', { ...body, request_id: requestID(key) })
      requestIDs.current.delete(key)
      resetDraft()
      await refresh()
    } catch (error) { toast.error(errorMessage(error)) }
    finally { setSaving(false) }
  }
  const control = async (routine: Routine, action: 'pause' | 'enable' | 'run_once') => {
    if (!canManage || saving) return
    const key = `control:${routine.id}:${action}:${routine.revision}`
    setSaving(true)
    try {
      await post(`/agent/routines/${routine.id}/control`, { expected_revision: routine.revision, request_id: requestID(key), action })
      requestIDs.current.delete(key)
      await refresh()
    } catch (error) {
      toast.error(action === 'run_once' ? `${errorMessage(error)}。若响应中断，请先刷新执行记录，不要自动重复运行。` : errorMessage(error))
    } finally { setSaving(false) }
  }
  const remove = async (routine: Routine) => {
    if (!canManage || saving || !(await confirm({ title: `删除例行任务「${routine.name}」？`,
      desc: '历史执行记录和报告会保留在对话中；删除不会撤销已完成的操作。', confirmText: '删除任务', danger: true }))) return
    const key = `delete:${routine.id}:${routine.revision}`
    setSaving(true)
    try {
      await del(`/agent/routines/${routine.id}`, { expected_revision: routine.revision, request_id: requestID(key) })
      requestIDs.current.delete(key)
      if (editingID === routine.id) resetDraft()
      await refresh()
    } catch (error) { toast.error(errorMessage(error)) }
    finally { setSaving(false) }
  }

  const selectedModel = serverModels.find((item) => modelKey(item) === draft.model)

  return <div className="space-y-4">
    <section className="rounded-xl border border-mist-200 bg-mist-50 p-3 text-xs leading-5 text-mist-600">
      例行任务只查询所选账号的公开运营数据并生成本人报告或提醒。每次最多运行 300 秒、读取 30 次、保存一份报告；费用计入所选服务器模型的工作区用量。不会发布、推送或自动写入业务对象。
    </section>
    {canManage && <section className="space-y-3 rounded-xl border border-mist-200 p-3" aria-labelledby="agent-routine-form-heading">
      <div className="flex items-center justify-between gap-2"><h3 id="agent-routine-form-heading">{editingID ? '修改例行任务' : '新建例行任务'}</h3>
        {editingID && <Button type="button" size="sm" variant="ghost" onClick={resetDraft}>取消修改</Button>}</div>
      <label className="block space-y-1 text-xs font-medium text-mist-600">名称<Input maxLength={100} value={draft.name} onChange={(event) => setDraft((old) => ({ ...old, name: event.target.value }))} placeholder="例如：每周运营复盘" /></label>
      <label className="block space-y-1 text-xs font-medium text-mist-600">任务提示（最多 4000 字）<Textarea maxLength={4000} rows={4} value={draft.prompt} onChange={(event) => setDraft((old) => ({ ...old, prompt: event.target.value }))} placeholder="明确查询范围、报告结构和提醒条件。提示只作为任务输入，不会放宽只读权限。" /></label>
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-medium text-mist-600">公共业务引用（最多 12 项）</p><Button type="button" size="sm" variant="outline" disabled={!draft.accountID || contextRefs.length >= 12} onClick={() => setContextsOpen(true)}>添加引用</Button></div>
        {contextRefs.length > 0 ? <ul className="flex flex-wrap gap-1.5">{contextRefs.map((item) => <li key={`${item.type}:${item.id}`} className="flex max-w-full items-center gap-1 rounded-md border border-mist-200 bg-mist-50 px-2 py-1 text-xs text-mist-600"><span className="max-w-64 truncate">{item.name}</span><button type="button" aria-label={`移除引用 ${item.name}`} className="rounded px-1 hover:bg-mist-200" onClick={() => setContextRefs((old) => old.filter((ref) => ref.type !== item.type || ref.id !== item.id))}>×</button></li>)}</ul>
          : <p className="text-xs text-mist-400">只会在每次运行时重新鉴权所选账号的公开资料。</p>}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1 text-xs font-medium text-mist-600">运营账号<Select value={draft.accountID} onChange={(event) => { const accountID = event.target.value; setDraft((old) => ({ ...old, accountID, destination: conversation?.account_id === accountID ? old.destination : 'new' })); setContextRefs([]) }}><option value="">选择账号</option>{activeAccounts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></label>
        <label className="block space-y-1 text-xs font-medium text-mist-600">服务器模型<Select value={draft.model} onChange={(event) => setDraft((old) => ({ ...old, model: event.target.value }))}><option value="">选择已自检模型</option>{serverModels.map((item) => <option key={modelKey(item)} value={modelKey(item)}>{item.provider_name} · {item.model}{item.is_default ? ' · 默认' : ''}</option>)}</Select>{serverModels.length === 0 && <span className="text-gamboge-700">当前没有可用于例行任务的服务器模型。</span>}</label>
        <label className="block space-y-1 text-xs font-medium text-mist-600">频率<Select value={draft.cadence} onChange={(event) => setDraft((old) => ({ ...old, cadence: event.target.value as RoutineDraft['cadence'] }))}><option value="once">一次性</option><option value="daily">每天</option><option value="weekly">每周</option></Select></label>
        {draft.cadence === 'weekly' && <label className="block space-y-1 text-xs font-medium text-mist-600">星期<Select value={String(draft.weekday)} onChange={(event) => setDraft((old) => ({ ...old, weekday: Number(event.target.value) }))}>{['周一','周二','周三','周四','周五','周六','周日'].map((label, index) => <option key={label} value={index + 1}>{label}</option>)}</Select></label>}
        {draft.cadence === 'once' && <label className="block space-y-1 text-xs font-medium text-mist-600">执行时间（上海时区）<Input type="datetime-local" value={draft.onceAt} onChange={(event) => setDraft((old) => ({ ...old, onceAt: event.target.value }))} /></label>}
        {draft.cadence !== 'once' && <label className="block space-y-1 text-xs font-medium text-mist-600">执行时间（上海时区）<Input type="time" value={draft.timeOfDay} onChange={(event) => setDraft((old) => ({ ...old, timeOfDay: event.target.value }))} /></label>}
        <label className="block space-y-1 text-xs font-medium text-mist-600">结果落点<Select value={draft.destination} onChange={(event) => setDraft((old) => ({ ...old, destination: event.target.value as RoutineDraft['destination'] }))}><option value="new">每次新建独立对话</option><option value="current" disabled={!conversation || conversation.account_id !== draft.accountID}>附加到当前对话</option></Select>{draft.destination === 'current' && conversation && <span className="text-mist-500">{conversation.title}（只追加本次报告，不读取旧对话内容）</span>}</label>
      </div>
      <div className="flex justify-end"><Button type="button" variant="primary" size="sm" loading={saving} disabled={!draft.name.trim() || !draft.prompt.trim() || !draft.accountID || !selectedModel || draft.cadence === 'once' && !draft.onceAt || draft.destination === 'current' && (!conversation || conversation.account_id !== draft.accountID)} onClick={() => void save()}>{editingID ? '保存修改' : '创建并启用'}</Button></div>
    </section>}

    <section className="space-y-2" aria-labelledby="agent-routine-list-heading">
      <div className="flex items-center justify-between gap-2"><h3 id="agent-routine-list-heading">已配置任务</h3>{list.data && <span className="text-xs text-mist-500">{list.data.items.length} 项</span>}</div>
      {list.isLoading && <p role="status" className="py-5 text-center text-sm text-mist-500">正在读取例行任务…</p>}
      {list.isError && <div role="alert" className="space-y-2 rounded-lg border border-danger/30 p-3 text-sm text-danger"><p>{errorMessage(list.error)}</p><Button type="button" size="sm" variant="outline" onClick={() => void list.refetch()}>重试读取</Button></div>}
      {list.data?.items.map((routine) => <article key={routine.id} className="space-y-2 rounded-xl border border-mist-200 p-3">
        <div className="flex flex-wrap items-start justify-between gap-2"><div><h4 className="font-semibold text-mist-800">{routine.name}</h4><p className="mt-0.5 text-xs text-mist-500">{routine.cadence === 'once' ? '一次性' : routine.cadence === 'daily' ? '每天' : `每周${['一','二','三','四','五','六','日'][(routine.weekday ?? 1) - 1]}`} · {routine.time_of_day.slice(0, 5)} · 上海时间</p></div><Badge tone={routine.status === 'enabled' ? 'green' : routine.status === 'paused' ? 'gamboge' : 'gray'}>{statusLabel[routine.status] ?? routine.status}</Badge></div>
        <p className="whitespace-pre-wrap break-words text-sm text-mist-700">{routine.prompt}</p>
        <p className="text-xs text-mist-500">下次：{formatDate(routine.next_due_at)} · 最近：{formatDate(routine.last_run_at)}{routine.failure_count > 0 ? ` · 连续失败 ${routine.failure_count}/3` : ''}{routine.error_code ? ` · ${routine.error_code}` : ''}</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" disabled={saving} onClick={() => setHistoryID(historyID === routine.id ? null : routine.id)}>{historyID === routine.id ? '收起记录' : '执行记录'}</Button>
          {canManage && routine.status === 'enabled' && <Button type="button" size="sm" variant="outline" loading={saving} onClick={() => void control(routine, 'pause')}>暂停</Button>}
          {canManage && routine.status === 'paused' && <Button type="button" size="sm" loading={saving} onClick={() => void control(routine, 'enable')}>重新启用</Button>}
          {canManage && routine.status === 'enabled' && <Button type="button" size="sm" variant="secondary" loading={saving} onClick={() => void control(routine, 'run_once')}>立即运行一次</Button>}
          {canManage && ['enabled', 'paused'].includes(routine.status) && <Button type="button" size="sm" variant="outline" disabled={saving} onClick={() => edit(routine)}>编辑</Button>}
          {canManage && routine.status !== 'deleted' && <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={() => void remove(routine)}>删除</Button>}
        </div>
        {historyID === routine.id && <RoutineHistory routineID={routine.id} />}
      </article>)}
      {list.data?.items.length === 0 && <p className="rounded-xl border border-dashed border-mist-300 px-4 py-8 text-center text-sm text-mist-500">还没有例行任务。创建后，服务器会按计划只读查询，并把报告留在本人对话中。</p>}
    </section>
    <ContextPickerDialog open={contextsOpen} onClose={() => setContextsOpen(false)} accountID={draft.accountID}
      selected={contextRefs} onAdd={(item) => setContextRefs((old) => old.length < 12 ? [...old, item] : old)} turnOnly
      description="选择的公开业务资料会在每次运行时按当前账号和版本重新鉴权；私人对话、附件和个人技能不会带入。" />
  </div>
}

function RoutineHistory({ routineID }: { routineID: string }) {
  const history = useQuery({
    queryKey: ['agent-routine-occurrences', routineID],
    queryFn: () => get<{ items: Occurrence[] }>(`/agent/routines/${routineID}/occurrences?limit=30`),
  })
  if (history.isLoading) return <p role="status" className="text-xs text-mist-500">正在读取执行记录…</p>
  if (history.isError) return <p role="alert" className="text-xs text-danger">执行记录读取失败：{errorMessage(history.error)}</p>
  if (!history.data?.items.length) return <p className="text-xs text-mist-500">暂无执行记录</p>
  return <ol className="space-y-1 border-l border-mist-200 pl-3" aria-label="例行任务执行记录">
    {history.data.items.map((item) => <li key={item.id} className="text-xs text-mist-600">{formatDate(item.due_at)} · {item.kind === 'manual' ? '手动运行' : '计划运行'} · {occurrenceStatusLabel[item.status] ?? item.status}{item.error_code ? ` · ${item.error_code}` : ''}</li>)}
  </ol>
}
