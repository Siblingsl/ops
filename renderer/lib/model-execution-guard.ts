/**
 * D-227：模型配置页执行位置防呆判断。
 * 当桌面端或网页连接的是远程后端服务器，而用户在「服务器模型」中填写了回环地址
 * （如 127.0.0.1 / localhost / ::1）时，请求实际会由远程容器向它自身发起并被拒绝；
 * 这里提供纯函数检测，便于弹窗即时给出切换到「本机 AI 配置」的明确提示。
 */

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.trim().replace(/^\[|\]$/g, '').toLowerCase()
  if (!host) return false
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0:0:0:0:0:0:0:1' || host === '0.0.0.0') {
    return true
  }
  const match = /^127\.(\d+)\.(\d+)\.(\d+)$/.exec(host)
  if (!match) return false
  return match.slice(1).every((part) => {
    const value = Number(part)
    return Number.isInteger(value) && value >= 0 && value <= 255
  })
}

export function isLoopbackBaseUrl(rawUrl: string): boolean {
  const trimmed = rawUrl.trim()
  if (!trimmed || /\s/.test(trimmed)) return false
  const candidate = trimmed.includes('://') ? trimmed : `http://${trimmed}`
  try {
    const parsed = new URL(candidate)
    return isLoopbackHost(parsed.hostname)
  } catch {
    return false
  }
}

export function isRemoteApiOrigin(apiBaseUrl: string, windowOrigin?: string): boolean {
  const effective = apiBaseUrl.trim() || (windowOrigin ?? '').trim()
  if (!effective) return false
  if (/^(ops-desktop|file):/i.test(effective)) return true
  try {
    const parsed = new URL(effective)
    return !isLoopbackHost(parsed.hostname)
  } catch {
    return false
  }
}

export function shouldWarnRemoteLoopback(rawBaseUrl: string, apiBaseUrl: string, windowOrigin?: string): boolean {
  return isRemoteApiOrigin(apiBaseUrl, windowOrigin) && isLoopbackBaseUrl(rawBaseUrl)
}
