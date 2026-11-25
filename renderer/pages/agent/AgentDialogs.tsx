import { Bot } from 'lucide-react'
import { Dialog } from '@/components/dialog'
import { Button, Input, Notice, Select } from '@/components/ui'
import type { AgentBootstrap, AgentMessage, AgentMode, AgentRole } from '@/lib/agent'
import type { Account } from '@/lib/types'
import { AgentModeSelect, modelKey } from './MessageChrome'

// BR-11：页面元素 + 一句批注的本地文本引用；与 IX-04 共用输入台筹码样式，
// 发送时拼进消息正文，不新增服务端引用类型，也不自动发送。
export type AgentPageReference = {
  id: string
  name: string
  url: string
  selector: string
  text: string
  note: string
}

export function pageReferenceText(refs: AgentPageReference[]): string {
  return refs.map((ref) => [
    `【页面引用】${ref.name}`,
    ref.url,
    `选择器：${ref.selector}`,
    ref.text ? `选段：${ref.text}` : '',
    `批注：${ref.note}`,
  ].filter(Boolean).join('\n')).join('\n\n')
}

type AgentSettingsDialogProps = {
  open: boolean
  onClose: () => void
  selectedModel: string
  canWrite: boolean
  allowModelPick: boolean
  busy: boolean
  bootstrapData: AgentBootstrap
  selectedAccount: string
  accountsLoading: boolean
  accountList: Account[]
  selectedRoleID: string
  setSelectedRoleID: (value: string) => void
  roles: AgentRole[]
  rolesLoading: boolean
  desktopPresentation: boolean
  workbenchUI: boolean
  conversationKind?: string
  selectedMode: AgentMode
  changeMode: (mode: AgentMode) => void
  runtimeSummary: string
  runCostSummary: string
  accountSwitched: boolean
  selectedAccountName: string
  historyAccountName: string
  newConversation: () => void
  updateSelection: (kind: 'model' | 'account', value: string) => void
}

export function AgentSettingsDialog(props: AgentSettingsDialogProps) {
  const {
    open, onClose, selectedModel, canWrite, allowModelPick, busy, bootstrapData, selectedAccount,
    accountsLoading, accountList, selectedRoleID, setSelectedRoleID, roles, rolesLoading,
    desktopPresentation, workbenchUI, conversationKind, selectedMode, changeMode,
    runtimeSummary, runCostSummary, accountSwitched, selectedAccountName, historyAccountName,
    newConversation, updateSelection,
  } = props
  return (
    <Dialog open={open} onClose={onClose} title="对话设置" desc="选择本对话使用的模型与操作账号。">
      <div className="space-y-4">
        <label className="block space-y-1.5 text-[13px] font-medium text-mist-700">模型
          <Select aria-label="选择模型" value={selectedModel} disabled={!canWrite || !allowModelPick || busy} onChange={(event) => void updateSelection('model', event.target.value)}>
            {!selectedModel && <option value="">选择模型</option>}
            {bootstrapData.default_model_unsupported && <option value="" disabled>默认模型未通过工具调用自检</option>}
            {selectedModel && !bootstrapData.models.some((model) => modelKey(model.provider_id, model.model) === selectedModel) && <option value={selectedModel}>所选模型已不可用</option>}
            {bootstrapData.models.map((model) => <option key={modelKey(model.provider_id, model.model)} value={modelKey(model.provider_id, model.model)}>{model.provider_name} · {model.model}{model.vision ? ' · 看图' : ''}{model.is_default ? ' · 默认' : ''}</option>)}
          </Select>
          {bootstrapData.models.length === 0 && <span className="block text-xs font-normal text-mist-500">暂无可用于智能体的模型，请先到模型配置页完成能力自检。</span>}
        </label>
        <label className="block space-y-1.5 text-[13px] font-medium text-mist-700">操作账号
          <Select aria-label="选择账号" value={selectedAccount} disabled={!canWrite || busy || accountsLoading} onChange={(event) => void updateSelection('account', event.target.value)}>
            <option value="">不指定账号</option>
            {accountList.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
          </Select>
        </label>
        {bootstrapData.features.agent_roles && <label className="block space-y-1.5 text-[13px] font-medium text-mist-700">执行角色
          <Select aria-label="选择角色" data-testid="agent-role-select" value={selectedRoleID} disabled={!canWrite || busy || rolesLoading} onChange={(event) => setSelectedRoleID(event.target.value)}>
            <option value="">默认（不限定角色）</option>
            {roles.filter((role) => role.status === 'active').map((role) => <option key={role.id} value={role.id}>{role.name}{role.builtin_key ? ' · 内置' : ''}</option>)}
          </Select>
          <span className="block text-xs font-normal text-mist-500">角色限定工具白名单与轮数预算；写入仍逐张卡片确认。</span>
        </label>}
        {bootstrapData.features.plans && desktopPresentation && !workbenchUI && conversationKind !== 'side' && <div className="space-y-2"><span className="block text-[13px] font-medium text-mist-700">模式</span><AgentModeSelect value={selectedMode} disabled={!canWrite || busy} readOnly={bootstrapData.read_only} onChange={(mode) => void changeMode(mode)} />{runtimeSummary && <p className="text-xs text-mist-500" data-testid="agent-runtime-config">{runtimeSummary}</p>}{runCostSummary && <p className="text-xs text-mist-500" data-testid="agent-run-cost">{runCostSummary}</p>}</div>}
        {/* AG-03：历史消息按创建时的账号保存，切换账号不会改写已发生的对话。 */}
        {accountSwitched && <div data-testid="agent-account-switched"><Notice tone="gamboge">
          新消息将使用「{selectedAccountName}」，当前对话的历史仍属于「{historyAccountName}」。想从干净的上下文开始，请新建对话。
          <div className="mt-2"><Button type="button" size="sm" variant="outline" onClick={() => { onClose(); newConversation() }}>新建对话</Button></div>
        </Notice></div>}
      </div>
    </Dialog>
  )
}

type AgentLocalSearchDialogProps = {
  open: boolean
  onClose: () => void
  inputRef: React.RefObject<HTMLInputElement>
  text: string
  setText: (value: string) => void
  busy: boolean
  error: string
  results: AgentMessage[]
  onSearch: () => void
  onJump: (message: AgentMessage) => void
}

export function AgentLocalSearchDialog(props: AgentLocalSearchDialogProps) {
  const { open, onClose, inputRef, text, setText, busy, error, results, onSearch, onJump } = props
  return (
    <Dialog open={open} onClose={onClose} title="查找当前对话" desc="搜索当前对话中所有已保存的用户与助手消息。">
      <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void onSearch() }}>
        <div className="flex gap-2">
          <Input ref={inputRef} aria-label="搜索当前对话" value={text} onChange={(event) => setText(event.target.value)} placeholder="输入要查找的文字" disabled={busy} />
          <Button type="submit" variant="primary" disabled={!text.trim() || busy}>{busy ? '搜索中…' : '查找'}</Button>
        </div>
      </form>
      {busy && <p role="status" className="mt-3 text-[13px] text-mist-500">正在搜索已保存的消息…</p>}
      {error && <p role="alert" className="mt-3 text-[13px] text-danger">{error}</p>}
      {!busy && !error && text.trim() && <p role="status" className="mt-3 text-[12px] text-mist-500">找到 {results.length} 条消息</p>}
      <div className="mt-3 max-h-80 space-y-1 overflow-y-auto">
        {results.map((message) => <button key={message.id} type="button" className="block w-full rounded-lg border border-mist-200 p-3 text-left hover:border-ink-300 hover:bg-ink-50 focus-visible:outline-2 focus-visible:outline-ink-500" onClick={() => onJump(message)}>
          <span className="text-[12px] font-medium text-mist-500">{message.role === 'user' ? '你' : '助手'} · 第 {message.seq} 条</span>
          <span className="mt-1 block whitespace-pre-wrap break-words text-[13px] leading-5 text-mist-800">{message.content.slice(0, 220)}</span>
        </button>)}
        {!text.trim() && <p className="py-5 text-center text-[13px] text-mist-500">输入关键词，搜索此对话的完整历史。</p>}
        {!busy && !error && text.trim() && !results.length && <p className="py-5 text-center text-[13px] text-mist-500">没有匹配的消息</p>}
      </div>
    </Dialog>
  )
}

type AgentCompactDialogProps = {
  open: boolean
  onClose: () => void
  busy: boolean
  onCompact: () => void
}

export function AgentCompactDialog({ open, onClose, busy, onCompact }: AgentCompactDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} title="压缩这段对话？" desc="压缩只影响下一次运行的上下文，不会删除消息。原始消息仍可查看、检索和导出。"
      footer={<><Button variant="ghost" onClick={onClose}>取消</Button><Button variant="primary" loading={busy} onClick={() => { onClose(); void onCompact() }}>开始压缩</Button></>}>
      <p className="text-[13px] leading-relaxed text-mist-600">会保留任务目标、约束与已确认结论；未确认的内容不会被当作结论。压缩失败时保留原上下文。</p>
    </Dialog>
  )
}

export function Unavailable({ bootstrap, navigate }: { bootstrap: AgentBootstrap; navigate: (to: string) => void }) {
  // AG-01 & AG-05：智能体不可用时给出「去开启/去配置」出口，按原因和角色分别给按钮直达对应设置页
  const reason = bootstrap.reason
  const isOwner = bootstrap.role === 'owner'
  const goToAgentSettings = () => navigate('/settings/agent')
  const goToModelSettings = () => navigate('/settings/models')

  let title = ''
  let subtitle = ''
  let actionButton = null

  if (reason === 'admin_override') {
    title = '代访问期间不能使用智能体'
    subtitle = '切换回原身份后可正常使用。'
  } else if (reason === 'viewer_disabled') {
    title = '所有者已关闭观察者使用智能体'
    subtitle = isOwner
      ? '作为所有者，你可以到设置页自行开启。'
      : '请联系工作区所有者开启观察者权限。'
    actionButton = isOwner && (
      <button type="button" onClick={goToAgentSettings} className="inline-flex mt-3 cursor-pointer items-center gap-1 rounded-md bg-ink-600 px-3 py-2 text-[13px] text-white shadow hover:bg-ink-700">
        去智能体设置
      </button>
    )
  } else if (reason === 'disabled') {
    title = '所有者已关闭智能体'
    subtitle = isOwner
      ? '作为所有者，你可以到设置页自行开启。'
      : '请联系工作区所有者开启。'
    actionButton = isOwner && (
      <button type="button" onClick={goToAgentSettings} className="inline-flex mt-3 cursor-pointer items-center gap-1 rounded-md bg-ink-600 px-3 py-2 text-[13px] text-white shadow hover:bg-ink-700">
        去智能体设置
      </button>
    )
  } else if (reason === 'no_model') {
    title = '还没有配置可用于对话的模型'
    subtitle = '请先配置支持工具调用的模型。历史对话仍可查看。'
    actionButton = (
      <button type="button" onClick={goToModelSettings} className="inline-flex mt-3 cursor-pointer items-center gap-1 rounded-md bg-ink-600 px-3 py-2 text-[13px] text-white shadow hover:bg-ink-700">
        去模型配置
      </button>
    )
  } else if (reason === 'not_tested') {
    title = '模型已经配置好了，但还没有完成能力自检'
    subtitle = '完成一次自检后就能开始对话。历史对话仍可查看。'
    actionButton = (
      <button type="button" onClick={goToModelSettings} className="inline-flex mt-3 cursor-pointer items-center gap-1 rounded-md bg-ink-600 px-3 py-2 text-[13px] text-white shadow hover:bg-ink-700">
        去模型配置并自检
      </button>
    )
  } else {
    title = '智能体暂时不可用'
    subtitle = '请稍后重试或联系管理员。'
  }

  return <div className="flex h-full items-center justify-center p-6"><div className="max-w-md rounded-2xl border border-mist-200 bg-white p-8 text-center shadow-card"><Bot className="mx-auto size-8 text-mist-300" /><h1 className="mt-3 text-lg font-semibold text-mist-800">{title}</h1><p className="mt-2 text-sm text-mist-500">{subtitle}</p>{actionButton}</div></div>
}
