import type { DesktopPlatformIntentKind, DesktopPlatformIntentResult } from './desktop-presentation.js'

export type DesktopPlatformIntentRequest =
  | { type: 'platform-account-sync'; accountId: string; mode: 'incremental' | 'full_reconcile'; connectionRevision: number }
  | { type: 'platform-metrics-refresh'; accountId: string; connectionRevision: number; platformWorkId?: string }
  | { type: 'platform-sync-resume'; accountId: string; operationId: string; expectedOperationRevision: number }

const RESULT_TIMEOUT_MS = 35_000

function intentUrl(request: DesktopPlatformIntentRequest, requestId: string): string {
  const accountId = encodeURIComponent(request.accountId)
  if (request.type === 'platform-account-sync') {
    return `ops-desktop://ui/platform-account-sync/${accountId}/${request.mode}/${request.connectionRevision}/${requestId}`
  }
  if (request.type === 'platform-metrics-refresh') {
    const workId = request.platformWorkId ? `${encodeURIComponent(request.platformWorkId)}/` : ''
    return `ops-desktop://ui/platform-metrics-refresh/${accountId}/${request.connectionRevision}/${workId}${requestId}`
  }
  return `ops-desktop://ui/platform-sync-resume/${accountId}/${encodeURIComponent(request.operationId)}/${request.expectedOperationRevision}/${requestId}`
}

function failedMessage(kind: DesktopPlatformIntentKind, message?: string): string {
  if (message) return message
  if (kind === 'platform-account-sync') return '本机同步请求失败，请稍后重试。'
  if (kind === 'platform-metrics-refresh') return '本机指标刷新请求失败，请稍后重试。'
  return '继续同步失败，请刷新进度后重试。'
}

/** 发起固定平台深链，并只接受匹配当前 kind、accountId、requestId 的一次性回执。 */
export function requestDesktopPlatformIntent(request: DesktopPlatformIntentRequest): Promise<DesktopPlatformIntentResult> {
  if (typeof window === 'undefined') return Promise.reject(new Error('当前环境不支持桌面平台操作。'))
  const subscribe = window.opsDesktopUI?.onPlatformIntentResult
  if (!subscribe) return Promise.reject(new Error('当前 OPS 桌面客户端不支持本机平台操作，请重启客户端后重试。'))

  const requestId = crypto.randomUUID()
  const url = intentUrl(request, requestId)
  return new Promise((resolve, reject) => {
    let timeout: number | undefined
    let settled = false
    let unsubscribe: () => void = () => {}
    const finish = (result?: DesktopPlatformIntentResult, error?: Error) => {
      if (settled) return
      settled = true
      if (timeout !== undefined) window.clearTimeout(timeout)
      unsubscribe()
      if (error) reject(error)
      else if (result) resolve(result)
    }

    unsubscribe = subscribe((result) => {
      if (result.kind !== request.type || result.accountId !== request.accountId || result.requestId !== requestId) return
      if (request.type === 'platform-sync-resume' && result.operationId !== request.operationId) return
      if (result.status === 'failed') {
        finish(undefined, new Error(failedMessage(result.kind, result.message)))
        return
      }
      finish(result)
    })
    timeout = window.setTimeout(() => {
      finish(undefined, new Error('本机平台操作等待超时，请刷新同步进度后重试。'))
    }, RESULT_TIMEOUT_MS)

    try {
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch (error) {
      finish(undefined, error instanceof Error ? error : new Error('无法打开本机平台操作。'))
    }
  })
}
