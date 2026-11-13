// DEV-CU P5-1（docs/36 §4.2 / §4.11 / §4.12）：渲染器侧电脑控制客户端。
//
// 目录说明：本模块当前落在 renderer/lib/，与在途的 shared 下沉批次（renderer/lib/* 单行
// re-export shared/*）不冲突——本文件是新增文件，未改任何在途 re-export 行。待该批次收口后
// 按 §P5-1「最终目录」迁移到 shared/，届时 renderer 侧只留一行 re-export。电脑控制是桌面端
// 独有能力，web 端不建同名模块。
import type {
  DesktopComputerUiaActResult,
  DesktopComputerUiaInvalidateResult,
  DesktopComputerUiaObserveResult,
} from './desktop-presentation'
import { ApiError, del, errorMessage, get, post } from './api'

/** §4.2 十六个错误码，顺序与规格表一致；字面不得增删改。 */
export const COMPUTER_ERROR_CODES = [
  'computer_stale_ref',
  'computer_ambiguous_target',
  'computer_target_changed',
  'computer_approval_conflict',
  'computer_foreground_busy',
  'computer_action_not_supported',
  'computer_ui_unsupported',
  'computer_action_failed',
  'computer_app_unresponsive',
  'computer_timeout',
  'computer_policy_denied',
  'computer_scope_denied',
  'computer_device_offline',
  'computer_budget_exceeded',
  'computer_invalid_args',
  'computer_internal',
] as const

export type ComputerErrorCode = (typeof COMPUTER_ERROR_CODES)[number]

/**
 * 中文提示：与 ComputerWindowPicker 既有映射同风格——先说发生了什么，再说用户下一步。
 * 每个码都必须有独立文案；不允许共用「未知错误」之类的兜底句（兜底会掩盖真实原因）。
 */
export const COMPUTER_ERROR_HINTS: Record<ComputerErrorCode, string> = {
  computer_stale_ref: '目标已变化，需要重新观察后再操作。',
  computer_ambiguous_target: '找到多个同名目标，无法确定是哪一个；请换一个更具体的窗口或元素。',
  computer_target_changed: '窗口、进程或前台状态已变化，与授权时不一致；请重新选择窗口。',
  computer_approval_conflict: '同一次请求的内容已变化，或授权代数已更新；请重新确认后提交。',
  computer_foreground_busy: '前台正被其它任务占用（浏览器协作或已有前台授权）；先停止它再选择。',
  computer_action_not_supported: '该元素不支持这个动作（缺少对应的系统控件能力）。',
  computer_ui_unsupported: '这个界面无法用系统控件可靠定位；可以改为人工接管。',
  computer_action_failed: '动作没有达到预期结果（读回校验未通过），请重新观察后重试。',
  computer_app_unresponsive: '目标应用暂无响应；稍后重试或改为人工操作。',
  computer_timeout: '操作超时，无法确认是否已生效；请先人工核对界面，不要重复操作。',
  computer_policy_denied: '该窗口命中硬禁区（系统登录、凭据、终端等），任何情况下都不可操作。',
  computer_scope_denied: '授权范围不足：请先选择窗口，或改用「可操作」范围授权。',
  computer_device_offline: '桌面客户端已离线；恢复连接后才能继续操作。',
  computer_budget_exceeded: '操作次数已达上限（10 分钟内 60 次），请稍后再试。',
  computer_invalid_args: '请求参数不合法（缺少参数、引用格式不对或内容超长）。',
  computer_internal: '本机执行组件内部错误；请重新观察，仍失败时人工接管。',
}

/** §4.2 的两列机器可读口径：是否要求换新快照、以及建议的等待毫秒数。 */
export type ComputerErrorPolicy = {
  requiresFreshSnapshot: boolean
  retryAfterMs: number | null
}

/**
 * 策略表只记录「下一步要不要重新观察 / 等多久」。
 * 注意：即便 requiresFreshSnapshot 为 true，渲染器也不自动重试——五态语义要求
 * unknown_outcome 与 delivery_uncertain 一律走人工核对（§4.3、C06）。
 */
export const COMPUTER_ERROR_POLICY: Record<ComputerErrorCode, ComputerErrorPolicy> = {
  computer_stale_ref: { requiresFreshSnapshot: true, retryAfterMs: null },
  computer_ambiguous_target: { requiresFreshSnapshot: true, retryAfterMs: null },
  computer_target_changed: { requiresFreshSnapshot: true, retryAfterMs: null },
  computer_approval_conflict: { requiresFreshSnapshot: false, retryAfterMs: null },
  computer_foreground_busy: { requiresFreshSnapshot: false, retryAfterMs: null },
  computer_action_not_supported: { requiresFreshSnapshot: false, retryAfterMs: null },
  computer_ui_unsupported: { requiresFreshSnapshot: false, retryAfterMs: null },
  computer_action_failed: { requiresFreshSnapshot: false, retryAfterMs: null },
  computer_app_unresponsive: { requiresFreshSnapshot: true, retryAfterMs: 250 },
  computer_timeout: { requiresFreshSnapshot: true, retryAfterMs: 250 },
  computer_policy_denied: { requiresFreshSnapshot: false, retryAfterMs: null },
  computer_scope_denied: { requiresFreshSnapshot: false, retryAfterMs: null },
  computer_device_offline: { requiresFreshSnapshot: false, retryAfterMs: null },
  computer_budget_exceeded: { requiresFreshSnapshot: false, retryAfterMs: null },
  computer_invalid_args: { requiresFreshSnapshot: false, retryAfterMs: null },
  computer_internal: { requiresFreshSnapshot: false, retryAfterMs: null },
}

/** 已知码返回码值，非 ApiError 或表外码返回空串（调用方据此决定是否走本地文案）。 */
export function computerErrorCode(error: unknown): ComputerErrorCode | '' {
  if (!(error instanceof ApiError)) return ''
  return (COMPUTER_ERROR_CODES as readonly string[]).includes(error.code)
    ? (error.code as ComputerErrorCode)
    : ''
}

/** 已知码给中文下一步提示；表外码不吞——原样透出服务端 message（含请求 ID）。 */
export function computerErrorHint(error: unknown): string {
  const code = computerErrorCode(error)
  return code ? COMPUTER_ERROR_HINTS[code] : errorMessage(error)
}

/**
 * 按码值取中文提示（供本机意图的 {ok:false, code, message} 结果用，不经过 ApiError）。
 * 表外码返回空串，调用方回落到结果自带的 message——同样不吞错。
 */
export function computerHintForCode(code: string): string {
  return (COMPUTER_ERROR_CODES as readonly string[]).includes(code)
    ? COMPUTER_ERROR_HINTS[code as ComputerErrorCode]
    : ''
}

// ---------------------------------------------------------------------------
// 服务端视图（字段与 Go 侧 json tag 一一对应，§4.10 / §4.11）
// ---------------------------------------------------------------------------

export type ComputerGrantView = {
  id: string
  conversation_id: string
  run_id?: string
  target_handle: string
  target_summary: string
  scope: 'observe' | 'act'
  generation: number
  state: string
  device_ack_pending: boolean
  after_event_seq: number
  created_at: string
  expires_at?: string
}

/** §P1-4 / §P4-4 的 202 回执体（grantAcceptedBody），不含完整视图。 */
export type ComputerGrantAccepted = {
  grant_id: string
  run_id?: string
  generation: number
  state: string
  expires_at?: string
  after_event_seq: number
}

export type ComputerCommandView = {
  id: string
  grant_id: string
  run_id?: string
  request_id: string
  card_id?: string
  approval_hash?: string
  action_kind: string
  target_ref?: string
  input_hash: string
  state: string
  payload?: unknown
  result?: unknown
  claimed?: boolean
  disposition?: unknown
  requires_confirmation: boolean
  generation: number
  deadline_at?: string
  dispatched_at?: string
  error_code?: string
  created_at: string
}

export type ComputerCapabilities = {
  available: boolean
  reason?: string
  device_state: string
  protocol_range: string
  observation_modes: string[]
  foreground_state: string
}

/** POST /agent/conversations/{id}/computer-grants 的入参（§P1-4）。 */
export type ComputerGrantInput = {
  run_id?: string
  target_handle: string
  target_summary: string
  scope: 'observe' | 'act'
  request_id: string
}

/** POST /agent/computer/commands 的入参（§4.11：写类须带 card_id + approval_hash）。 */
export type ComputerCommandInput = {
  run_id: string
  grant_id: string
  request_id: string
  action_kind: string
  payload: Record<string, unknown>
  expected_generation: number
  card_id?: string
  approval_hash?: string
}

/**
 * 本机三个固定意图：只在桌面客户端可用；桥不存在时如实报 computer_ui_unsupported，
 * 不伪造成功、也不退回任何 HTTP 观察通道（C09：界面只在本机读）。
 */
export const computerLocal = {
  async observe(input: {
    pid: number; target_summary: string; grant_id: string; generation: number
    max_depth?: number; root_ref?: string; interactive_only?: boolean; compact?: boolean
  }): Promise<DesktopComputerUiaObserveResult> {
    const bridge = typeof window === 'undefined' ? undefined : window.opsDesktopUI
    if (!bridge?.observeComputerUIA) {
      return { ok: false, code: 'computer_ui_unsupported', message: '需要 OPS Desktop 客户端：界面观察只在本机进行。' }
    }
    return bridge.observeComputerUIA(input)
  },
  async act(input: {
    pid: number; ref: string; grant_id: string; generation: number
    action: string; value?: string | null; target_summary: string
  }): Promise<DesktopComputerUiaActResult> {
    const bridge = typeof window === 'undefined' ? undefined : window.opsDesktopUI
    if (!bridge?.actComputerUIA) {
      return { ok: false, code: 'computer_ui_unsupported', message: '需要 OPS Desktop 客户端：界面操作只在本机执行。' }
    }
    return bridge.actComputerUIA(input)
  },
  async invalidate(grantId: string): Promise<DesktopComputerUiaInvalidateResult> {
    const bridge = typeof window === 'undefined' ? undefined : window.opsDesktopUI
    if (!bridge?.invalidateComputerUIA) {
      return { ok: false, code: 'computer_ui_unsupported', message: '需要 OPS Desktop 客户端：快照只能在本机撤销。' }
    }
    return bridge.invalidateComputerUIA(grantId)
  },
}

/** 服务端接口封装：只用 §4.11 已登记路径，不新增任何批量/脚本入口。 */
export const computerApi = {
  createGrant(conversationId: string, input: ComputerGrantInput) {
    return post<ComputerGrantAccepted>(`/agent/conversations/${conversationId}/computer-grants`, input)
  },
  listGrants(conversationId: string) {
    return get<{ grants: ComputerGrantView[] }>(
      `/agent/computer-grants?conversation_id=${encodeURIComponent(conversationId)}`,
    )
  },
  handoff(grantId: string) {
    return post<ComputerGrantAccepted>(`/agent/computer-grants/${grantId}/handoff`, {})
  },
  revoke(grantId: string) {
    return del<ComputerGrantAccepted>(`/agent/computer-grants/${grantId}`)
  },
  deviceAck(grantId: string) {
    return post<ComputerGrantAccepted>(`/agent/computer/grants/${grantId}/device-ack`, {})
  },
  createCommand(input: ComputerCommandInput) {
    return post<ComputerCommandView>('/agent/computer/commands', input)
  },
  commands(runId: string) {
    return get<{ commands: ComputerCommandView[] }>(
      `/agent/computer/commands?run_id=${encodeURIComponent(runId)}`,
    )
  },
  capabilities() {
    return get<ComputerCapabilities>('/agent/computer/capabilities')
  },
  local: computerLocal,
}
