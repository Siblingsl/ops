import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { errorMessage, get, patch, post } from '@/lib/api'
import type { AgentConversation, AgentGoal, AgentGoalCriterion, AgentModel } from '@/lib/agent'
import { useAccounts } from '@/lib/session'
import { Badge, Button, Input, Select, Textarea } from '@/components/ui'

type CriterionDraft = { text: string; requires_confirmation: boolean }
type CompactPreview = { summary_upto_seq: number; through_seq: number; input_chars: number; summary_chars: number; estimated_tokens: number; can_compact: boolean }

const goalStatus: Record<string, { label: string; tone: 'gray' | 'ink' | 'green' | 'red' | 'gamboge' }> = {
  active: { label: '进行中', tone: 'ink' }, paused: { label: '已暂停', tone: 'gray' }, waiting_user: { label: '等待你处理', tone: 'gamboge' },
  completed: { label: '已完成', tone: 'green' }, blocked: { label: '已阻塞', tone: 'red' }, budget_limited: { label: '预算已用尽', tone: 'gamboge' }, cancelled: { label: '已结束', tone: 'gray' },
}

function modelKey(model?: { provider_id?: string | null; model?: string | null }) {
  return model?.provider_id && model.model ? JSON.stringify({ provider_id: model.provider_id, model: model.model }) : ''
}

function modelRef(value: string): { provider_id: string; model: string } | undefined {
  try {
    const parsed = JSON.parse(value) as { provider_id?: string; model?: string }
    return parsed.provider_id && parsed.model ? { provider_id: parsed.provider_id, model: parsed.model } : undefined
  } catch { return undefined }
}

export function GoalPanel({ conversationID, conversation, goal, models, goalsEnabled, compactEnabled, canManage, busy, onCompact }: {
  conversationID?: string
  conversation?: AgentConversation
  goal?: AgentGoal | null
  models: AgentModel[]
  goalsEnabled: boolean
  compactEnabled: boolean
  canManage: boolean
  busy: boolean
  onCompact: () => Promise<unknown>
}) {
  const qc = useQueryClient()
  const accounts = useAccounts()
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [objective, setObjective] = useState('')
  const [criteria, setCriteria] = useState<CriterionDraft[]>([{ text: '', requires_confirmation: false }])
  const [constraints, setConstraints] = useState('')
  const [accountID, setAccountID] = useState('')
  const [selectedModel, setSelectedModel] = useState('')
  const [allowBackground, setAllowBackground] = useState(false)
  const [runBudget, setRunBudget] = useState('10')
  const [secondsBudget, setSecondsBudget] = useState('1800')
  const [tokenBudget, setTokenBudget] = useState('')
  const [preview, setPreview] = useState<CompactPreview | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)

  useEffect(() => {
    if (editing) return
    setObjective(goal?.objective ?? '')
    setCriteria(goal?.criteria.map(({ text, requires_confirmation }) => ({ text, requires_confirmation })) ?? [{ text: '', requires_confirmation: false }])
    setConstraints(goal?.constraints ?? '')
    setAccountID(goal?.account_id ?? conversation?.account_id ?? '')
    setSelectedModel(modelKey(goal ? { provider_id: goal.model_provider_id, model: goal.model } : conversation ? { provider_id: conversation.model_provider_id, model: conversation.model } : undefined))
    setAllowBackground(goal?.allow_background ?? false)
    setRunBudget(String(goal?.run_budget ?? 10))
    setSecondsBudget(String(goal?.seconds_budget ?? 1800))
    setTokenBudget(goal?.token_budget == null ? '' : String(goal.token_budget))
  }, [goal?.id, goal?.revision, conversation?.id, conversation?.account_id, conversation?.model_provider_id, conversation?.model, editing])

  const refresh = async () => Promise.all([
    qc.invalidateQueries({ queryKey: ['agent-conversation', conversationID] }),
    qc.invalidateQueries({ queryKey: ['agent-conversations'] }),
  ])

  const save = async () => {
    if (!conversationID || saving || !objective.trim() || !accountID || !modelRef(selectedModel) || criteria.some((item) => !item.text.trim())) return
    setSaving(true)
    try {
      const body = {
        request_id: crypto.randomUUID(), ...(goal ? { expected_revision: goal.revision } : {}),
        objective: objective.trim(), criteria: criteria.map((item) => ({ text: item.text.trim(), requires_confirmation: item.requires_confirmation })),
        constraints: constraints.trim(), account_id: accountID, model: modelRef(selectedModel), allow_background: allowBackground,
        run_budget: Number(runBudget), seconds_budget: Number(secondsBudget), token_budget: tokenBudget.trim() ? Number(tokenBudget) : null,
      }
      if (goal) await patch(`/agent/conversations/${conversationID}/goal`, body)
      else await post(`/agent/conversations/${conversationID}/goal`, body)
      setEditing(false)
      await refresh()
    } catch (error) { toast.error(errorMessage(error)) }
    finally { setSaving(false) }
  }

  const control = async (action: 'pause' | 'resume' | 'cancel') => {
    if (!goal || saving) return
    setSaving(true)
    try {
      await post(`/agent/goals/${goal.id}/control`, { expected_revision: goal.revision, request_id: crypto.randomUUID(), action })
      await refresh()
    } catch (error) { toast.error(errorMessage(error)) }
    finally { setSaving(false) }
  }

  const confirmCriterion = async (criterion: AgentGoalCriterion) => {
    if (!goal || saving) return
    setSaving(true)
    try {
      await post(`/agent/goals/${goal.id}/confirm-criterion`, {
        expected_revision: goal.revision, request_id: crypto.randomUUID(), criterion_id: criterion.id, confirmed: true,
      })
      await refresh()
    } catch (error) { toast.error(errorMessage(error)) }
    finally { setSaving(false) }
  }

  const loadPreview = async () => {
    if (!conversationID || previewBusy) return
    setPreviewBusy(true)
    try { setPreview(await get<CompactPreview>(`/agent/conversations/${conversationID}/compact-preview`)) }
    catch (error) { toast.error(errorMessage(error)) }
    finally { setPreviewBusy(false) }
  }

  const activeAccounts = (accounts.data ?? []).filter((item) => item.status === 'active')
  const goalState = goalStatus[goal?.status ?? ''] ?? goalStatus.active
  const selectedModelExists = models.some((item) => modelKey(item) === selectedModel)

  return <div className="space-y-4">
    {goalsEnabled && <section className="space-y-3" aria-labelledby="agent-goal-heading">
      <div className="flex items-center justify-between gap-2"><h3 id="agent-goal-heading">任务目标</h3>{goal && <Badge tone={goalState.tone}>{goalState.label}</Badge>}</div>
      {!conversationID ? <p className="text-xs text-mist-500">先创建对话，再把它设为一个可跟进的任务。</p>
        : !goal && !editing ? <div className="space-y-2"><p className="text-xs text-mist-500">把目标、完成条件和预算保存到本对话。普通问答不会自动变成后台任务。</p>
          {canManage && <Button type="button" size="sm" onClick={() => setEditing(true)}>设为任务</Button>}</div>
          : goal && !editing ? <div className="space-y-3">
            <p className="whitespace-pre-wrap break-words text-sm text-mist-700">{goal.objective}</p>
            <ul className="space-y-2">{goal.criteria.map((criterion) => <li key={criterion.id} className="rounded-lg border border-mist-200 p-2.5 text-xs">
              <div className="flex items-start justify-between gap-2"><span className="text-mist-700">{criterion.text}</span><Badge tone={criterion.status === 'verified' || criterion.status === 'confirmed' ? 'green' : criterion.status === 'needs_confirmation' ? 'gamboge' : 'gray'}>{({ verified: '已核验', confirmed: '你已确认', needs_confirmation: '待你确认', unverifiable: '无法验证', unverified: '未完成' } as Record<string, string>)[criterion.status] ?? criterion.status}</Badge></div>
              {criterion.evidence_refs.length > 0 && <p className="mt-1 text-mist-500">已关联 {criterion.evidence_refs.length} 项证据</p>}
              {canManage && criterion.status === 'needs_confirmation' && <Button type="button" className="mt-2" size="sm" disabled={busy || saving} onClick={() => void confirmCriterion(criterion)}>确认此项完成</Button>}
            </li>)}</ul>
            {goal.constraints && <p className="text-xs text-mist-500">约束：{goal.constraints}</p>}
            <p className="text-xs text-mist-500">预算：{goal.used_runs}/{goal.run_budget} 次 · {goal.used_seconds}/{goal.seconds_budget} 秒 · {goal.token_budget ? `${goal.used_tokens}/${goal.token_budget} tokens` : `已用 ${goal.used_tokens} tokens`}{goal.allow_background ? ' · 允许持续推进' : ' · 仅手动继续'}</p>
            {goal.blocker && <p className="text-xs text-danger" role="status">卡点：{goal.blocker}</p>}
            {canManage && <div className="flex flex-wrap gap-2">
              {goal.status !== 'completed' && goal.status !== 'cancelled' && <Button type="button" size="sm" variant="outline" disabled={saving || busy && goal.status !== 'active'} onClick={() => setEditing(true)}>编辑目标</Button>}
              {(goal.status === 'active' || goal.status === 'waiting_user') && <Button type="button" size="sm" variant="outline" loading={saving} onClick={() => void control('pause')}>暂停</Button>}
              {['paused', 'blocked', 'waiting_user', 'budget_limited'].includes(goal.status) && <Button type="button" size="sm" loading={saving} onClick={() => void control('resume')}>恢复并继续</Button>}
              {goal.status !== 'completed' && goal.status !== 'cancelled' && <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={() => void control('cancel')}>结束目标</Button>}
            </div>}
          </div>
          : <div className="space-y-3">
            <label className="block space-y-1 text-xs font-medium text-mist-600">目标（最多 500 字）<Textarea maxLength={500} rows={3} value={objective} onChange={(event) => setObjective(event.target.value)} /></label>
            <fieldset className="space-y-2"><legend className="text-xs font-medium text-mist-600">完成条件（1～5 项）</legend>
              {criteria.map((criterion, index) => <div key={index} className="rounded-lg border border-mist-200 p-2">
                <Textarea aria-label={`完成条件 ${index + 1}`} maxLength={500} rows={2} value={criterion.text} onChange={(event) => setCriteria((old) => old.map((item, i) => i === index ? { ...item, text: event.target.value } : item))} />
                <div className="mt-1 flex items-center justify-between gap-2"><label className="flex items-center gap-1.5 text-xs text-mist-500"><input type="checkbox" checked={criterion.requires_confirmation} onChange={(event) => setCriteria((old) => old.map((item, i) => i === index ? { ...item, requires_confirmation: event.target.checked } : item))} />需要你确认质量</label>
                  {criteria.length > 1 && <Button type="button" size="sm" variant="ghost" onClick={() => setCriteria((old) => old.filter((_, i) => i !== index))}>移除</Button>}</div>
              </div>)}
              {criteria.length < 5 && <Button type="button" size="sm" variant="ghost" onClick={() => setCriteria((old) => [...old, { text: '', requires_confirmation: false }])}>添加完成条件</Button>}
            </fieldset>
            <label className="block space-y-1 text-xs font-medium text-mist-600">约束（最多 1000 字）<Textarea maxLength={1000} rows={2} value={constraints} onChange={(event) => setConstraints(event.target.value)} /></label>
            <label className="block space-y-1 text-xs font-medium text-mist-600">运营账号<Select value={accountID} onChange={(event) => setAccountID(event.target.value)}><option value="">选择账号</option>{activeAccounts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></label>
            <label className="block space-y-1 text-xs font-medium text-mist-600">模型<Select value={selectedModel} onChange={(event) => setSelectedModel(event.target.value)}><option value="">选择模型</option>{models.map((item) => <option key={modelKey(item)} value={modelKey(item)}>{item.provider_name} · {item.model}</option>)}</Select>{!selectedModelExists && selectedModel && <span className="text-gamboge-700">当前模型不可用，请重新选择。</span>}</label>
            <div className="grid grid-cols-3 gap-2"><label className="space-y-1 text-xs text-mist-600">运行次数<Input type="number" min={1} max={10} value={runBudget} onChange={(event) => setRunBudget(event.target.value)} /></label><label className="space-y-1 text-xs text-mist-600">运行秒数<Input type="number" min={60} max={1800} step={60} value={secondsBudget} onChange={(event) => setSecondsBudget(event.target.value)} /></label><label className="space-y-1 text-xs text-mist-600">Token 上限<Input type="number" min={1000} max={100000} step={1000} placeholder="不单独限制" value={tokenBudget} onChange={(event) => setTokenBudget(event.target.value)} /></label></div>
            <label className="flex items-start gap-2 text-xs text-mist-600"><input type="checkbox" className="mt-0.5" checked={allowBackground} onChange={(event) => setAllowBackground(event.target.checked)} />允许任务在页面关闭后持续推进；出现待办卡片或问题时会停止并等你处理。</label>
            <div className="flex justify-end gap-2"><Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>取消</Button><Button type="button" size="sm" loading={saving} disabled={!canManage || !objective.trim() || !accountID || !modelRef(selectedModel) || criteria.some((item) => !item.text.trim())} onClick={() => void save()}>{goal ? '保存新版本' : '保存并启用目标'}</Button></div>
          </div>}
    </section>}

    {compactEnabled && conversationID && <section className="space-y-2 border-t border-mist-200 pt-3" aria-labelledby="agent-compact-heading">
      <h3 id="agent-compact-heading">整理上下文</h3>
      {!preview ? <Button type="button" size="sm" variant="outline" disabled={busy} loading={previewBusy} onClick={() => void loadPreview()}>预览整理范围与用量</Button>
        : <div className="space-y-2 text-xs text-mist-600" role="status"><p>{preview.can_compact ? `整理第 ${preview.summary_upto_seq + 1}～${preview.through_seq} 条旧消息；约 ${preview.estimated_tokens.toLocaleString()} tokens（估算）。` : '当前没有需要整理的旧消息。'}</p>
          {preview.can_compact && <p>本次模型调用将计入工作区 AI 用量；正在运行或有待办时不能开始。</p>}
          <div className="flex gap-2"><Button type="button" size="sm" disabled={!preview.can_compact || busy} onClick={() => { setPreview(null); void onCompact() }}>开始整理</Button><Button type="button" size="sm" variant="ghost" onClick={() => setPreview(null)}>取消</Button></div></div>}
    </section>}
  </div>
}
