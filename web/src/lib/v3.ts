import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { get, post, put } from './api'
import { setCustomTheme } from './render'
import type { AIJob, CustomTheme, Memory, UserPrefs, Work } from './types'

/** waitJob polls a background AI job (ai_job) until it finishes; rejects on failure or cancellation. */
export async function waitJob<T>(id: string, signal?: AbortSignal): Promise<T> {
  for (;;) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
    const j = await get<AIJob>(`/ai-jobs/${id}`)
    if (j.status === 'done') return j.result as T
    if (j.status === 'failed' || j.status === 'cancelled' || j.status === 'interrupted') throw new Error(j.error || '任务没有完成')
    await new Promise((r) => setTimeout(r, 1500))
  }
}

/** useCustomTheme loads the account's custom theme (EX-G-01) and registers it for rendering. */
export function useCustomTheme(accountId?: string) {
  const q = useQuery({
    queryKey: ['custom-theme', accountId],
    queryFn: () => get<CustomTheme | null>(`/accounts/${accountId}/custom-theme`),
    enabled: !!accountId,
    staleTime: 300_000,
  })
  useEffect(() => setCustomTheme(q.data ?? null), [q.data])
  return q
}

// ---------- 拼音首字母（命令面板 / 搜索，EX-M-03） ----------

const PINYIN_LETTERS = 'ABCDEFGHJKLMNOPQRSTWXYZ'
const PINYIN_BOUNDARIES = '阿八嚓哒妸发旮哈讥咔垃痳拏噢妑七呥扨它穵夕丫帀'
const collator = (() => {
  try {
    return new Intl.Collator('zh-Hans-CN-u-co-pinyin')
  } catch {
    return null
  }
})()

/** pinyinInitials maps 「选题池」 to "xtc"; non-Chinese characters are kept lower-cased. */
export function pinyinInitials(s: string): string {
  let out = ''
  for (const ch of s) {
    if (/[\u4e00-\u9fff]/.test(ch) && collator) {
      let letter = ''
      for (let i = PINYIN_BOUNDARIES.length - 1; i >= 0; i--) {
        if (collator.compare(ch, PINYIN_BOUNDARIES[i]) >= 0) {
          letter = PINYIN_LETTERS[i]
          break
        }
      }
      out += letter.toLowerCase()
    } else if (/[a-z0-9]/i.test(ch)) out += ch.toLowerCase()
  }
  return out
}

/** fuzzyMatch accepts substrings and pinyin initials ("xtc" → 选题池). */
export function fuzzyMatch(text: string, q: string): boolean {
  const query = q.trim().toLowerCase()
  if (!query) return true
  if (text.toLowerCase().includes(query)) return true
  return /^[a-z0-9]+$/.test(query) && pinyinInitials(text).includes(query)
}

// ---------- 最近访问（EX-M-04，仅存本机） ----------

export interface RecentItem { link: string; title: string; type: string; at: number }
const RECENT_KEY = 'ops.recent'

export function recentItems(): RecentItem[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]') as RecentItem[]
  } catch {
    return []
  }
}

export function rememberRecent(item: Omit<RecentItem, 'at'>) {
  const list = recentItems().filter((x) => x.link !== item.link)
  list.unshift({ ...item, at: Date.now() })
  localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 20)))
  window.dispatchEvent(new Event('ops:recent'))
}

export function useRecentWorks(limit = 5): RecentItem[] {
  const [list, setList] = useState(() => recentItems())
  useEffect(() => {
    const sync = () => setList(recentItems())
    window.addEventListener('ops:recent', sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener('ops:recent', sync)
      window.removeEventListener('storage', sync)
    }
  }, [])
  return list.filter((r) => r.type === 'work').slice(0, limit)
}

// ---------- 个人偏好（EX-K-02 / EX-K-03） ----------

export const defaultPrefs: UserPrefs = {
  default_variants: 1, use_history: true, live_lint: true, ghost_text: true, ghost_key: 'Alt+/', auto_jump_next_empty: true,
  focus_default: false, write_ending_first: false, ux_events: false, cost_tier: 'standard', saved_views: [],
}

export const ghostKeys = ['Alt+/', 'Alt+.', 'Ctrl+.'] as const

export function matchGhostKey(e: KeyboardEvent, key: string): boolean {
  const mod = (e.ctrlKey || e.metaKey) && !e.altKey
  switch (key) {
    case 'Alt+.':
      return e.altKey && !e.ctrlKey && !e.metaKey && (e.key === '.' || e.code === 'Period')
    case 'Ctrl+.':
      return mod && (e.key === '.' || e.code === 'Period')
    default:
      return e.altKey && !e.ctrlKey && !e.metaKey && (e.key === '/' || e.code === 'Slash')
  }
}

/** usePrefetchWork loads a work after the pointer rests on it for 200ms, and can warm a few works up front (4.5 预取). */
export function usePrefetchWork() {
  const qc = useQueryClient()
  const timer = useRef<number>()
  const load = useCallback((id: string) => qc.prefetchQuery({ queryKey: ['work', id], queryFn: () => get<Work>(`/works/${id}`), staleTime: 30_000 }), [qc])
  return {
    load,
    hover: (id: string) => ({
      onMouseEnter: () => { timer.current = window.setTimeout(() => void load(id), 200) },
      onMouseLeave: () => window.clearTimeout(timer.current),
    }),
  }
}

/** usePendingMemories counts AI memories still waiting for the author's confirmation (3.5). */
export function usePendingMemories(accountId: string | undefined) {
  const q = useQuery({ queryKey: ['memories', accountId], queryFn: () => get<Memory[]>(`/accounts/${accountId}/memories`), enabled: !!accountId, staleTime: 60_000 })
  return (q.data ?? []).filter((m) => m.status === 'suggested').length
}

export interface AIStatus { ready: boolean; vision_route: boolean; image_route: boolean }

/** useAIStatus tells whether AI is configured and which optional routes exist (DEV-UX01), so the UI can warn before a call fails. */
export function useAIStatus() {
  return useQuery({ queryKey: ['ai-status'], queryFn: () => get<AIStatus>('/ai/status'), staleTime: 60_000 }).data
}

export type WorkCmd = { cmd: 'goto'; sectionId: string } | { cmd: 'titles' | 'versions' | 'derive' | 'focus' }

/** workCmd lets the command palette drive the open work page (4.1「本作品」分组). */
export function workCmd(c: WorkCmd) {
  window.dispatchEvent(new CustomEvent<WorkCmd>('ops:work-cmd', { detail: c }))
}

export function useWorkCmd(handler: (c: WorkCmd) => void) {
  useEffect(() => {
    const h = (e: Event) => handler((e as CustomEvent<WorkCmd>).detail)
    window.addEventListener('ops:work-cmd', h)
    return () => window.removeEventListener('ops:work-cmd', h)
  })
}

export function usePrefs() {
  const q = useQuery({ queryKey: ['prefs'], queryFn: () => get<UserPrefs>('/me/preferences'), staleTime: 300_000 })
  return q.data ?? defaultPrefs
}

export function useSavePrefs() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (p: Partial<UserPrefs>) => put<UserPrefs>('/me/preferences', { ...(qc.getQueryData<UserPrefs>(['prefs']) ?? defaultPrefs), ...p }),
    onSuccess: (data) => qc.setQueryData(['prefs'], data),
  })
}

// ---------- 体验事件（S3，默认关闭，只记事件名） ----------

let uxQueue: { event: string; target_type: string }[] = []
let uxTimer: number | undefined
let uxEnabled = false

export function setUXEnabled(v: boolean) {
  uxEnabled = v
}

export function trackUX(event: string, targetType = '') {
  if (!uxEnabled) return
  uxQueue.push({ event, target_type: targetType })
  window.clearTimeout(uxTimer)
  uxTimer = window.setTimeout(() => {
    const events = uxQueue.slice(0, 50)
    uxQueue = []
    post('/ux-events', { events }).catch(() => undefined)
  }, 3000)
}

// ---------- 小工具 ----------

export const memoryKindLabel: Record<string, string> = { tone: '语气', structure: '结构', wording: '用词', avoid: '避免', fact: '事实' }
export const memoryScopeLabel: Record<string, string> = { all: '全部任务', draft: '起草与改写', title: '标题', topic: '选题' }
export const memorySourceLabel: Record<string, string> = {
  manual: '手动添加', instruction: '临时指令复用', edit_diff: '采纳差异', rejection: '放弃记录', review: '复盘结论',
}

export function todayISO(offsetDays = 0): string {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
