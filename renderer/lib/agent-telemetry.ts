// OT-04：智能体工作台前端埋点白名单。事件名与目标类型只允许固定枚举，
// 不接受消息正文、提示词、工具参数或页面内容，避免把敏感内容带进 ux_event。
export const AGENT_TELEMETRY_EVENTS = [
  'agent_panel_open',
  'agent_panel_tab',
  'agent_command_run',
  'agent_review_open',
  'agent_review_execute',
  'agent_browser_mode',
] as const

export type AgentTelemetryEvent = (typeof AGENT_TELEMETRY_EVENTS)[number]

const eventName = /^[a-z0-9_.:-]{1,48}$/

export function isAgentTelemetryEvent(value: string): value is AgentTelemetryEvent {
  return (AGENT_TELEMETRY_EVENTS as readonly string[]).includes(value)
}

export function isAgentTelemetryTarget(value: string): boolean {
  return value === '' || eventName.test(value)
}

export function agentTelemetryPayload(event: string, targetType = '') {
  if (!isAgentTelemetryEvent(event) || !isAgentTelemetryTarget(targetType)) return null
  return { events: [{ event, target_type: targetType }] }
}
