// ---------- 最近访问（EX-M-04，仅存本机） ----------

// A-26-1/A-26-2：最近打开按用户和工作区隔离，避免跨登录用户或工作区显示作品标题。
// 用户与工作区身份未确认时不读不写。

export interface RecentItem { link: string; title: string; type: string; at: number }

const RECENT_KEY = 'ops.recent'

let recentScope: string | undefined

/** Called with the confirmed user/workspace pair from /auth/me; missing either identity disables access. */
export function setRecentOwner(userId: string | undefined, workspaceId?: string) {
  const scope = userId && workspaceId ? `${userId}:${workspaceId}` : undefined
  if (recentScope === scope) return
  recentScope = scope
  window.dispatchEvent(new Event('ops:recent'))
}

export function recentItems(): RecentItem[] {
  if (!recentScope) return []
  try {
    return JSON.parse(localStorage.getItem(`${RECENT_KEY}.${recentScope}`) || '[]') as RecentItem[]
  } catch {
    return []
  }
}

export function rememberRecent(item: Omit<RecentItem, 'at'>) {
  if (!recentScope) return
  const list = recentItems().filter((x) => x.link !== item.link)
  list.unshift({ ...item, at: Date.now() })
  localStorage.setItem(`${RECENT_KEY}.${recentScope}`, JSON.stringify(list.slice(0, 20)))
  window.dispatchEvent(new Event('ops:recent'))
}
