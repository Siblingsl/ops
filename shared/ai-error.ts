import { toast } from 'sonner'
import { ApiError, errorMessage, preferFallbackModel } from './api'
import { isModelFailure, modelFailureActionLabel, modelFailureHint } from './ai-failure'

function goModels() {
  window.history.pushState(null, '', '/settings/models')
  window.dispatchEvent(new PopStateEvent('popstate'))
}

/**
 * aiError shows the unified AI failure toast (10 文档 9.2 第 5 条):
 * 哪一步失败 · 原因 · 你的内容没有被改动 · [重试] [换备用模型].
 * OPT-A01：403/429/超时统一由 shared/ai-failure 给中文原因与行动按钮；
 * 没有备用模型时按钮直达模型配置，而不是留下一个无效的“换备用模型”。
 */
export function aiError(e: unknown, step: string, retry?: () => unknown) {
  if ((e as Error)?.name === 'AbortError') return
  const code = e instanceof ApiError ? e.code : ''
  const trace = e instanceof ApiError && e.requestId ? `（请求 ID：${e.shortRequestId}）` : ''
  const reason = errorMessage(e).replace(/[。，]?\s*(你的|原有)内容没有被改动[^]*$/, '').replace(trace, '')
  const hasFallback = e instanceof ApiError && !!(e.detail as { fallback_available?: boolean } | undefined)?.fallback_available
  // NW-B5：模型没配置时，"重试"没有意义，必须给"去配置模型"。
  const notConfigured = code === 'ai_not_configured' || code === 'ai_key_missing'
  const modelFailure = isModelFailure(code)
  const switchModel = notConfigured
    ? { label: '去配置模型', onClick: goModels }
    : modelFailure
      ? hasFallback && retry
        ? { label: modelFailureActionLabel(code, true), onClick: () => { preferFallbackModel(); toast.message('接下来 10 分钟优先使用备用模型'); void retry() } }
        : { label: modelFailureActionLabel(code, false), onClick: goModels }
      : undefined
  const hint = modelFailure && !reason.includes('限流') && !reason.includes('超时') && !reason.includes('密钥')
    ? `；${modelFailureHint(code)}`
    : ''
  toast.error(`${step}失败`, {
    description: `${reason}${hint} · 你的内容没有被改动${trace}`,
    duration: retry || switchModel ? Number.POSITIVE_INFINITY : 10_000,
    action: retry && !notConfigured ? { label: '重试', onClick: () => void retry() } : undefined,
    cancel: switchModel,
  })
}
