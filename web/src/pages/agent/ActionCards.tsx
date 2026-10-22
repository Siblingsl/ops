import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Dialog } from '@/components/dialog'
import { Badge, Button, Card, cn, Input, Notice, Textarea } from '@/components/ui'
import type { AgentAction } from '@/lib/agent'
import { invalidateAgentAction, type AgentMutationTarget } from '@/lib/agent-invalidate'
import { errorMessage, post, stream } from '@/lib/api'
import { agentWechatPayload } from '@/lib/wechat-html'

export interface AgentActionCardsProps {
  actions: AgentAction[]
  running: boolean
  onRefresh: () => Promise<unknown> | void
  onContinue: () => Promise<unknown> | void
  desktopPresentation?: boolean
  /** 多组卡片按消息插入时，由对话页统一传播执行锁。 */
  onExecutingChange?: (executing: boolean) => void
}

interface ActionDone {
  action: AgentAction
  can_continue: boolean
  target?: AgentMutationTarget
  result_summary?: string
  secret_once?: Record<string, unknown>
}

const resolutions: Record<string, { value: string; label: string }[]> = {
  sensitive: [{ value: 'modified', label: '已修改' }, { value: 'kept', label: '已知悉，保留' }],
  fact: [{ value: 'verified', label: '已核实' }, { value: 'modified', label: '已修改' }],
  ai_disclosure: [{ value: 'acknowledged', label: '已知悉，发布时会声明' }],
  similarity: [{ value: 'acknowledged', label: '已知悉' }, { value: 'modified', label: '已修改' }],
  ad_law: [{ value: 'acknowledged', label: '已知悉' }, { value: 'modified', label: '已修改' }],
  stale: [{ value: 'verified', label: '已核实仍准确' }, { value: 'modified', label: '已换用新数据' }],
}

const statusText: Record<string, string> = {
  pending: '等待确认', executing: '执行中', needs_input: '需要你的选择', succeeded: '已完成',
  failed: '执行失败', rejected: '已拒绝', expired: '已过期', superseded: '已被替代',
}

const confirmDescriptions: Record<string, string> = {
  accounts__delete: '账号下的作品、选题、档案与凭证将一并清除，且不可恢复。',
  trash__purge: '彻底删除后无法恢复。',
  assets__delete: '图片文件将被删除。',
  characters__delete_ref: '角色参考图片文件将被删除。',
  memory__delete: '删除记忆后不能恢复。',
  metrics__delete: '删除指标记录后不能恢复。',
  series__delete: '删除系列后不能恢复。',
  words__delete: '删除词条后不能恢复。',
  prompt_eval__delete_case: '删除评测用例后不能恢复。',
  demo__clear: '示例数据将全部清除。',
  works__unlock: '解锁后可以修改已发布作品，修改不会同步到平台。',
  works__restore_version: '当前正文会被版本内容覆盖，系统先自动保存一个版本。',
  works__organize_apply: '应用整理结果会替换全部段落，请确认已完整审阅。',
  workspace__remove_member: '成员将失去本工作区访问权。',
  workspace__transfer_owner: '转移后，你将不再是本工作区的所有者。',
  admin__patch_user: '将修改该用户的启用状态或超级管理员权限，请核对具体变更。',
  admin__reset_password: '将生成临时密码，该用户的其他会话将失效。',
  admin__revoke_sessions: '该用户的全部会话将失效。',
  admin__system_settings_update: '维护模式会影响系统访问，关闭注册会阻止新用户注册，请核对具体开关。',
  wechat__push: '仅写入这一篇作品到公众号草稿箱，不会发表或群发。',
}

function gateLabel(action: AgentAction) {
  if (action.gate === 'H-03') return action.tool_name === 'storyboard__confirm' ? '我已阅读并确认分镜' : action.tool_name === 'works__organize_apply' ? '我已阅读整理结果，同意替换全部段落' : '我已阅读并确认大纲'
  if (action.gate === 'H-07') return '我确认已在平台上发布'
  if (action.gate === 'H-09') return '我已审阅全文'
  return `我已核对这张卡片，确认执行 ${action.gate}`
}

function executeLabel(action: AgentAction) {
  if (action.tool_name === 'works__set_viewpoint') return '保存我的观点'
  if (action.tool_name === 'wechat__push') return '写入草稿箱'
  if (action.gate === 'H-01') return action.tool_name === 'daily__start_item' ? '入库并开始写' : '入库'
  if (action.gate === 'H-08') return '采纳'
  if (action.gate === 'HC-20') return '确认记忆'
  return '执行'
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function message(value: unknown) {
  const data = object(value)
  return typeof data.message === 'string' ? data.message : typeof value === 'string' ? value : ''
}

function changeValue(action: AgentAction, field: string) {
  return action.changes.find((change) => change.field === field)?.after ?? ''
}

function hasPreviewFields(action: AgentAction, fields: string[]) {
  return fields.every((field) => action.changes.some((change) => change.field === field
    && typeof change.after === 'string' && (field === 'summary' || change.after.trim() !== '')))
}

/** 缺少门槛预览时不推断业务值，等待服务端补齐卡片数据。 */
function missingPreview(action: AgentAction) {
  if (action.tool_name === 'checks__resolve_item' && !resolutions[changeValue(action, 'category')]) return '卡片未返回可处理的检查类别，请到检查页逐项处理。'
  if (action.gate === 'H-03' && !action.changes.some((c) => ['items', 'outline', 'panels', 'storyboard', 'sections'].includes(c.field) && c.after)) return '卡片未返回完整大纲、分镜或整理结果，无法审阅确认。'
  if (action.tool_name === 'wechat__push' && !hasPreviewFields(action, ['title', 'summary', 'cover', 'images', 'today', 'draft'])) return '卡片尚未返回标题、封面、摘要、图片数、今日次数与草稿状态的完整推送预览，请到推送页确认。'
  if (action.tool_name === 'checks__complete' && !hasPreviewFields(action, ['passed', 'total'])) return '卡片尚未返回检查通过数与总数，请到检查页确认完成。'
  if (action.gate === 'H-09' && !hasPreviewFields(action, ['check_summary'])) return '卡片尚未返回最近检查摘要，请打开作品页审阅。'
  return ''
}

export function AgentActionCards({ actions, running, onRefresh, onContinue, onExecutingChange, desktopPresentation = false }: AgentActionCardsProps) {
  const [busy, setBusy] = useState<string | null>(null)
  const busyRef = useRef(false)
  const mounted = useRef(true)
  const [updated, setUpdated] = useState<Record<string, AgentAction>>({})
  const [continueReady, setContinueReady] = useState(false)
  const [error, setError] = useState('')
  const client = useQueryClient()
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { setUpdated({}) }, [actions])

  const decide = async (action: AgentAction, request?: Record<string, unknown>) => {
    if (running || busyRef.current || actions.some((item) => item.status === 'executing')) return
    busyRef.current = true
    setBusy(action.id)
    onExecutingChange?.(true)
    setError('')
    const route = window.location.pathname + window.location.search
    let canContinue = false
    try {
      if (request) {
        if (action.tool_name === 'wechat__push' || action.tool_name === 'checks__start') request.client_payload = await agentWechatPayload(action.tool_name, action.target.id)
        const done = await stream<ActionDone>(`/agent/actions/${action.id}/execute`, request, {
          onEvent: (event, data: unknown) => {
            if (event === 'done') return
            const value = object(data)
            const label = [value.label, value.name, value.stage, value.message, value.status].filter((v) => typeof v === 'string').join(' · ')
            if (label) setProgress((old) => ({ ...old, [action.id]: `${label}${typeof value.current === 'number' && typeof value.total === 'number' ? ` · ${value.current}/${value.total}` : ''}` }))
          },
        })
        if (!done?.action) throw new Error('执行流已断开，尚未收到最终结果，请刷新后核对卡片状态。')
        setUpdated((old) => ({ ...old, [action.id]: done.action }))
        if (done.secret_once) setSecrets((old) => ({ ...old, [action.id]: done.secret_once! }))
        canContinue = done.can_continue
        if (done.action.status === 'succeeded') {
          try { await invalidateAgentAction(client, action.tool_name, done.target) }
          catch (e) { setError(errorMessage(e)) }
        }
      } else {
        const result = await post<{ batch_resolved: boolean; can_continue: boolean }>(`/agent/actions/${action.id}/reject`)
        canContinue = result.can_continue === true
      }
      await onRefresh()
    } catch (e) {
      setError(errorMessage(e))
      await onRefresh()
    } finally {
      busyRef.current = false
      setBusy(null)
      onExecutingChange?.(false)
    }
    if (canContinue) {
      if (mounted.current && route === window.location.pathname + window.location.search) {
        try { await onContinue() }
        catch (e) { setError(errorMessage(e)); setContinueReady(true) }
      } else setContinueReady(true)
    }
  }
  const [progress, setProgress] = useState<Record<string, string>>({})
  // 一次性值仅保留在当前组件内存，不写入查询缓存、localStorage 或对话消息。
  const [secrets, setSecrets] = useState<Record<string, Record<string, unknown>>>({})
  const locked = running || !!busy || actions.some((action) => action.status === 'executing')
  return <div className="space-y-3">
    {error && <Notice tone="red">{error}</Notice>}
    {actions.map((original) => {
      const action = updated[original.id] ?? original
      return <ActionCard key={action.id} action={action} locked={locked} running={running} busy={busy === action.id}
        progress={progress[action.id]} secret={secrets[action.id]} onDismissSecret={() => setSecrets((old) => { const next = { ...old }; delete next[action.id]; return next })}
        onExecute={(request) => decide(action, request)} onReject={() => decide(action)} desktopPresentation={desktopPresentation} />
    })}
    {continueReady && <Button type="button" disabled={locked} onClick={() => { setContinueReady(false); void onContinue() }}>继续</Button>}
  </div>
}

function ActionCard({ action, locked, running, busy, progress, secret, onDismissSecret, onExecute, onReject, desktopPresentation = false }: {
  action: AgentAction; locked: boolean; running: boolean; busy: boolean; progress?: string; secret?: Record<string, unknown>
  onDismissSecret: () => void; onExecute: (request: Record<string, unknown>) => Promise<void>; onReject: () => Promise<void>; desktopPresentation?: boolean
}) {
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [editTypes, setEditTypes] = useState<Record<string, 'text' | 'json'>>({})
  const [ack, setAck] = useState(false)
  const [resolution, setResolution] = useState('')
  const [choice, setChoice] = useState('')
  const [overLimitConfirmed, setOverLimitConfirmed] = useState(false)
  const [dialog, setDialog] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const [error, setError] = useState('')
  const [preparing, setPreparing] = useState(false)
  const live = ['pending', 'needs_input'].includes(action.status) && Date.parse(action.expires_at) > Date.now()
  const second = object(action.second_confirm)
  // 当前 Go 响应未给 SecondConfirm.TypeName 配 JSON tag，兼容其现有字段拼写。
  const typeName = second.type_name ?? second.TypeName
  const needsName = typeof typeName === 'string' && !!typeName
  const missingName = needsName && (!action.target.name || /[0-9a-f]{8}-[0-9a-f]{4}-/i.test(action.target.name))
  const need = object(action.need)
  useEffect(() => {
    setChoice('')
    setOverLimitConfirmed(false)
    setDialog(false)
    setConfirmText('')
  }, [action.id, action.status, need.kind])
  const category = changeValue(action, 'category')
  const needsResolution = action.tool_name === 'checks__resolve_item'
  const missing = missingPreview(action) || (missingName ? '卡片未返回可核对的真实对象名称，暂不能确认此操作。' : '')
  const required = action.blank_fields.some((field) => !(edits[field] ?? '').trim())
  const waitingChoice = action.status === 'needs_input'
  const knownChoice = ['draft_missing', 'draft_modified', 'over_limit'].includes(String(need.kind))
  const validChoice = need.kind === 'draft_missing' ? choice === 'new'
    : need.kind === 'draft_modified' ? choice === 'new' || choice === 'overwrite'
      : need.kind === 'over_limit' && overLimitConfirmed
  const disabled = !live || locked || preparing || !!missing || required || (!!action.gate && !ack) || (needsResolution && !resolution) || (waitingChoice && (!knownChoice || !validChoice))
  const secondRequired = action.kind === 'X' || action.second_confirm != null || need.kind === 'over_limit'
  const safeLink = action.target.link.startsWith('/') && !action.target.link.startsWith('//') ? action.target.link : ''

  const execute = async () => {
    if (disabled) return
    setPreparing(true)
    setError('')
    try {
      const values: Record<string, unknown> = {}
      for (const [field, value] of Object.entries(edits)) {
        // 响应没有参数 Schema，类型由用户明确选择，不能把数字标题等文本猜成数字。
        values[field] = editTypes[field] === 'json' ? JSON.parse(value) : value
      }
      const request: Record<string, unknown> = { confirm: true, gate_ack: ack, second_confirm: secondRequired, confirm_text: confirmText, edits: values }
      if (needsResolution) request.resolution = resolution
      if (waitingChoice) request.choice = need.kind === 'over_limit' ? { confirm_over_limit: overLimitConfirmed } : { overwrite_choice: choice }
      setDialog(false)
      setChoice('')
      setOverLimitConfirmed(false)
      await onExecute(request)
    } catch (e) { setError(errorMessage(e)) }
    finally { setPreparing(false) }
  }

  return <Card className={cn('space-y-4 border p-4', action.kind === 'X' ? 'border-red-300 bg-red-50/30' : action.kind === 'H' ? 'border-gamboge-300 bg-gamboge-50/30' : 'border-mist-200', desktopPresentation && 'desktop-agent-action-card')}>
    <div className={cn('flex flex-wrap items-center gap-2', desktopPresentation && 'desktop-agent-action-header')}>
      <h3 className="min-w-0 flex-1 font-semibold text-mist-900">{action.title}</h3>
      <Badge tone={action.kind === 'X' ? 'red' : action.kind === 'H' ? 'gamboge' : 'gray'}>{action.kind === 'X' ? '不可撤销' : action.kind === 'H' ? `人工确认 ${action.gate}` : '普通写入'}</Badge>
      <span className="text-xs text-mist-500">{statusText[action.status] ?? action.status}</span>
    </div>
    {safeLink && <Link to={safeLink} target="_blank" rel="noopener noreferrer" className="text-sm text-ink-700 underline">查看{action.target.name || '目标对象'}</Link>}
    {action.changes.map((change) => {
      const editable = change.editable && action.editable_fields.includes(change.field)
      const value = edits[change.field] ?? change.after
      return <div key={change.field} className="space-y-2 text-sm">
        <div className="font-medium text-mist-700">{change.label}{change.blank && <span className="ml-2 text-danger">请由你本人填写</span>}</div>
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="whitespace-pre-wrap break-words rounded bg-mist-50 p-2 text-mist-500"><span className="mb-1 block text-xs">当前</span>{change.before || '（空）'}</div>
          <div className={cn('whitespace-pre-wrap break-words rounded p-2', value !== change.before && 'bg-ink-50 text-ink-900')}><span className="mb-1 block text-xs text-mist-500">修改后</span>{value || '（空）'}</div>
        </div>
        {editable && live && <div className="space-y-2"><label className="block"><span className="sr-only">修改{change.label}</span><Textarea value={value} disabled={locked || preparing} rows={3} onChange={(event) => setEdits((old) => ({ ...old, [change.field]: event.target.value }))} /></label><label className="flex items-center gap-2 text-xs text-mist-500">值类型<select aria-label={`${change.label}的值类型`} disabled={locked || preparing} value={editTypes[change.field] ?? 'text'} onChange={(event) => setEditTypes((old) => ({ ...old, [change.field]: event.target.value as 'text' | 'json' }))}><option value="text">文本</option><option value="json">JSON（数字、开关、列表或对象）</option></select></label></div>}
      </div>
    })}
    {action.notices.map((notice, index) => <Notice key={index} tone="gray">{notice === 'external_source' ? '本次参考了外部资料，请核对内容' : notice}</Notice>)}
    {action.ai_cost && <Notice tone="gamboge">会调用 AI，计入今日用量</Notice>}
    {live && missing && <Notice tone="gamboge">{missing}</Notice>}
    {live && needsResolution && resolutions[category] && <fieldset disabled={locked || preparing} className="space-y-2 text-sm"><legend className="mb-2 font-medium">请选择这一项的处理方式</legend>{resolutions[category].map((option) => <label key={option.value} className="flex items-center gap-2"><input type="radio" name={`resolution-${action.id}`} value={option.value} checked={resolution === option.value} onChange={() => setResolution(option.value)} />{option.label}</label>)}</fieldset>}
    {live && waitingChoice && <fieldset disabled={locked || preparing} className="space-y-2 text-sm">
      <legend className="mb-2 font-medium">需要你的选择</legend>
      {need.kind === 'draft_missing' && <>{safeLink && <Link to={`${safeLink.split('#')[0]}#backfill`} target="_blank" rel="noopener noreferrer" className="block text-ink-700 underline">回填已发布</Link>}<label className="flex items-center gap-2"><input type="radio" checked={choice === 'new'} onChange={() => setChoice('new')} />新建草稿（计入当日次数）</label></>}
      {need.kind === 'draft_modified' && <>{[{ value: 'overwrite', label: '仍然覆盖' }, { value: 'new', label: '另存为新草稿（计入当日次数）' }].map((item) => <label key={item.value} className="flex items-center gap-2"><input type="radio" name={`choice-${action.id}`} checked={choice === item.value} onChange={() => setChoice(item.value)} />{item.label}</label>)}</>}
      {need.kind === 'over_limit' && <><Notice tone="gamboge">今日写入次数已达上限。此上限用于降低连续写入的风险，请再次核对公众号平台关于批量连续发布的规则（3.27.2）。</Notice><label className="flex items-center gap-2"><input type="checkbox" checked={overLimitConfirmed} onChange={(event) => setOverLimitConfirmed(event.target.checked)} />我了解超限风险，仍需写入</label></>}
      {!knownChoice && <Notice tone="red">当前选择类型无法识别，请到目标页面核对。</Notice>}
    </fieldset>}
    {live && action.gate && <label className="flex items-start gap-2 text-sm text-mist-700"><input type="checkbox" className="mt-1" checked={ack} disabled={locked || preparing} onChange={(event) => setAck(event.target.checked)} />{gateLabel(action)}</label>}
    {action.result_summary && <p className="whitespace-pre-wrap text-sm text-ink-700">{action.result_summary}</p>}
    {(message(action.error) || message(action.last_error) || error) && <Notice tone="red">{error || message(action.error) || message(action.last_error)}</Notice>}
    {progress && <p role="status" className="text-sm text-mist-500">{progress}</p>}
    {secret && <Notice tone="gamboge"><p>以下信息仅在本次执行后显示，请立即保存。</p><pre className="mt-2 whitespace-pre-wrap break-all select-all">{JSON.stringify(secret, null, 2)}</pre><Button type="button" size="sm" variant="ghost" onClick={onDismissSecret}>我已保存，关闭</Button></Notice>}
    {live && <div className="flex flex-wrap items-center gap-2"><Button type="button" variant={action.kind === 'X' ? 'danger' : action.kind === 'H' ? 'human' : 'primary'} loading={busy || preparing} disabled={disabled} onClick={() => { if (secondRequired) { setConfirmText(''); setDialog(true) } else void execute() }}>{executeLabel(action)}</Button><Button type="button" variant="ghost" disabled={locked || preparing} onClick={() => void onReject()}>拒绝</Button>{running && <span className="text-xs text-mist-500">等待智能体说完</span>}</div>}
    <Dialog open={dialog} onClose={() => { if (!preparing) setDialog(false) }} title={need.kind === 'over_limit' ? '超出今日次数，仍要写入？' : action.tool_name === 'wechat__push' ? '写入公众号草稿箱（不会发表）' : '再次确认此操作'}
      footer={<><Button type="button" variant="ghost" onClick={() => setDialog(false)}>取消</Button><Button type="button" variant="danger" loading={preparing} disabled={disabled || (needsName && confirmText !== action.target.name)} onClick={() => void execute()}>确认执行这一项</Button></>}>
      <p className="whitespace-pre-wrap text-sm text-mist-700">{typeof action.second_confirm === 'string' ? action.second_confirm : typeof second.text === 'string' ? second.text : confirmDescriptions[action.tool_name] ?? '此操作会直接修改或删除数据，执行后可能无法恢复。请核对上方完整变更。'}</p>
      {needsName && <label className="mt-4 block space-y-2 text-sm"><span>请输入完整{typeName === 'account_name' ? '账号名称' : '用户名'}：{action.target.name}</span><Input value={confirmText} autoComplete="off" onChange={(event) => setConfirmText(event.target.value)} /></label>}
    </Dialog>
  </Card>
}
