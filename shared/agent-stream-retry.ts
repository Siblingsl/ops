/** RC-21：区分「客户端主动取消」的传输层状态与真实业务失败。 */
export const CLIENT_CLOSED_REQUEST_STATUS = 499
/** 空闲会话的 SSE 延迟启动，避免下一轮发送把尚未通过鉴权的连接立即取消。 */
export const IDLE_EVENT_STREAM_DELAY_MS = 250
/** 499 不是业务失败：短暂退避后从快照游标重连。 */
export const CLIENT_CLOSED_RETRY_DELAY_MS = 250
/** 发送受理在 499 上的最大重试次数（request_id 不变，服务端按幂等回执重放）。 */
export const ACCEPT_RETRY_MAX = 2

export function isClientClosedRequest(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const value = error as { status?: unknown; code?: unknown }
  return value.status === CLIENT_CLOSED_REQUEST_STATUS || value.code === 'client_closed_request'
}

export function shouldRetryAccept(error: unknown, attempt: number): boolean {
  return isClientClosedRequest(error) && attempt < ACCEPT_RETRY_MAX
}

export function idleEventStreamDelayMs(hasActiveRun: boolean): number {
  return hasActiveRun ? 0 : IDLE_EVENT_STREAM_DELAY_MS
}
