/**
 * 模型失败的可读提示与行动建议（OPT-A01）。
 * 服务端把 403/401、429、超时映射为 ai_key_invalid / ai_rate_limited / ai_timeout；
 * 这里统一桌面端的标题、原因与“换模型/重试”文案，避免每个页面各写一套。
 */

export const modelFailureCodes = [
  'ai_upstream_error',
  'ai_key_invalid',
  'ai_rate_limited',
  'ai_timeout',
  'ai_output_invalid',
] as const

export type ModelFailureCode = (typeof modelFailureCodes)[number]

export function isModelFailure(code: string): code is ModelFailureCode {
  return (modelFailureCodes as readonly string[]).includes(code)
}

/** 统一的中文原因；服务端已给出具体说明时仍以服务端为准。 */
export function modelFailureHint(code: string): string {
  switch (code) {
    case 'ai_key_invalid':
      return '模型密钥无效或上游账号被限制，请检查 Key 或切换一个可用模型'
    case 'ai_rate_limited':
      return '模型服务限流或额度已用尽，请稍后重试或切换一个可用模型'
    case 'ai_timeout':
      return '模型响应超时，请换一个更快的模型或缩短素材/上下文后重试'
    case 'ai_output_invalid':
      return '模型输出不符合要求，重试或换一个更稳定的模型'
    default:
      return '模型服务调用失败，请重试或换一个可用模型'
  }
}

/** 行动按钮：密钥/限流/超时都应直达模型配置；有备用模型时可一键切换。 */
export function modelFailureActionLabel(code: string, hasFallback: boolean): string {
  if (code === 'ai_key_invalid' && hasFallback) return '换备用模型'
  if (hasFallback) return '换备用模型'
  return '打开模型配置'
}
