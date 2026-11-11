/** DEV-P09：GET 对 502/503/504 的重试策略（与 web/src/lib/api-retry.ts 保持同口径）。 */

/** 首次失败后最多再试几次（不含首次请求）。 */
export const GET_RETRY_MAX = 2

const RETRYABLE = new Set([502, 503, 504])

export function shouldRetryGet(method: string, attempt: number, status: number): boolean {
  return method === 'GET' && attempt < GET_RETRY_MAX && RETRYABLE.has(status)
}

/**
 * 下一次重试等待毫秒。
 * 优先 Retry-After（秒或 HTTP-date），否则 250ms * 2^attempt + 0–99ms 抖动，封顶 4s / Retry-After 封顶 30s。
 */
export function getRetryDelayMs(
  failedAttempt: number,
  retryAfterHeader: string | null | undefined,
  opts?: { random?: () => number; now?: number },
): number {
  const random = opts?.random ?? Math.random
  const now = opts?.now ?? Date.now()
  const raw = (retryAfterHeader ?? '').trim()
  if (raw) {
    const asSec = Number(raw)
    if (Number.isFinite(asSec) && asSec >= 0) return Math.min(Math.ceil(asSec * 1000), 30_000)
    const when = Date.parse(raw)
    if (!Number.isNaN(when)) return Math.min(Math.max(0, when - now), 30_000)
  }
  const base = Math.min(250 * 2 ** failedAttempt, 4_000)
  return base + Math.floor(random() * 100)
}
