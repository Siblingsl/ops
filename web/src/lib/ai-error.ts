import { toast } from 'sonner'
import { ApiError, errorMessage, preferFallbackModel } from './api'

const modelFailures = new Set(['ai_upstream_error', 'ai_key_invalid', 'ai_output_invalid'])
function goModels() {
  window.history.pushState(null, '', '/settings/models')
  window.dispatchEvent(new PopStateEvent('popstate'))
}

/**
 * aiError shows the unified AI failure toast (10 文档 9.2 第 5 条):
 * 哪一步失败 · 原因 · 你的内容没有被改动 · [重试] [换备用模型].
 */
export function aiError(e: unknown, step: string, retry?: () => unknown) {
  if ((e as Error)?.name === 'AbortError') return
  const code = e instanceof ApiError ? e.code : ''
  const trace = e instanceof ApiError && e.requestId ? `（请求 ID：${e.shortRequestId}）` : ''
  const reason = errorMessage(e).replace(/[。，]?\s*(你的|原有)内容没有被改动[^]*$/, '').replace(trace, '')
  const hasFallback = e instanceof ApiError && !!(e.detail as { fallback_available?: boolean } | undefined)?.fallback_available
  // NW-B5：模型没配置时，"重试"没有意义，必须给"去配置模型"。
  const notConfigured = code === 'ai_not_configured' || code === 'ai_key_missing'
  const switchModel = notConfigured
    ? { label: '去配置模型', onClick: goModels }
    : modelFailures.has(code)
      ? hasFallback && retry
        ? { label: '换备用模型', onClick: () => { preferFallbackModel(); toast.message('接下来 10 分钟优先使用备用模型'); void retry() } }
        : { label: '换备用模型', onClick: goModels }
      : undefined
  toast.error(`${step}失败`, {
    description: `${reason} · 你的内容没有被改动${trace}`,
    duration: retry || switchModel ? Number.POSITIVE_INFINITY : 10_000,
    action: retry && !notConfigured ? { label: '重试', onClick: () => void retry() } : undefined,
    cancel: switchModel,
  })
}
