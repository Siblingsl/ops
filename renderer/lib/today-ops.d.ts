export const TODAY_OPS_BLOCK_ORDER: readonly ['pending', 'publishing', 'today', 'comments', 'routines', 'risks']

export function visibleTodayOpsItems<T>(block: { items?: T[] } | null | undefined): T[]

export function todayOpsWelcomeSummary(view: {
  summary: { pending: number; publishing: number; risks: number }
} | null | undefined): string
