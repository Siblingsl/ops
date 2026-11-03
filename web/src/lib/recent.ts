// ---------- 最近访问（EX-M-04，仅存本机） ----------

// A-26-1：同一浏览器可能先后登录不同用户，最近打开按用户隔离存储，
// 避免把上一个用户看过的作品标题显示给下一个登录的人。
// 未确认登录身份（owner 未设置）时不读不写。

export interface RecentItem { link: string; title: string; type: string; at: number }

const RECENT_KEY = 'ops.recent'

let recentOwner: string | undefined

/** Login state owner; called with the confirmed user id once /auth/me resolves, and undefined on logout. */
export function setRecentOwner(id: string | undefined) {
  if (recentOwner === id) return
  recentOwner = id
  window.dispatchEvent(new Event('ops:recent'))
}

export function recentItems(): RecentItem[] {
  if (!recentOwner) return []
  try {
    return JSON.parse(localStorage.getItem(`${RECENT_KEY}.${recentOwner}`) || '[]') as RecentItem[]
  } catch {
    return []
  }
}

export function rememberRecent(item: Omit<RecentItem, 'at'>) {
  if (!recentOwner) return
  const list = recentItems().filter((x) => x.link !== item.link)
  list.unshift({ ...item, at: Date.now() })
  localStorage.setItem(`${RECENT_KEY}.${recentOwner}`, JSON.stringify(list.slice(0, 20)))
  window.dispatchEvent(new Event('ops:recent'))
}
