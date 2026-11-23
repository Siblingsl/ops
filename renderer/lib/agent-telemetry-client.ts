import { post } from './api'
import { agentTelemetryPayload } from './agent-telemetry'

// 仅发送白名单事件名与目标类型；服务端仍按用户 ux_events 偏好决定是否落库。
export function trackAgentEvent(event: string, targetType = '') {
  const payload = agentTelemetryPayload(event, targetType)
  if (!payload) return
  void post('/ux-events', payload).catch(() => {
    // 埋点失败不能影响主流程；不重试、不弹 toast、不记录正文。
  })
}
