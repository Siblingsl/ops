/**
 * DEV-P08：页面轮询间隔。
 * 隐藏页返回 false（无请求）；可见时按连续失败次数指数退避，封顶 maxMs。
 */
export function pagePollIntervalMs(
  visible: boolean,
  baseMs: number,
  failureCount = 0,
  maxMs = 60_000,
): number | false {
  if (!visible) return false
  if (baseMs <= 0) return false
  if (failureCount <= 0) return baseMs
  const shift = Math.min(Math.max(0, failureCount), 5)
  return Math.min(baseMs * 2 ** shift, maxMs)
}
