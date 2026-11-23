// FN-11：今日运营的纯展示规则，供组件与单测共用。
// 六块顺序是产品契约；最多 3 条是硬上限，不随服务端返回条数变化。
export const TODAY_OPS_BLOCK_ORDER = ['pending', 'publishing', 'today', 'comments', 'routines', 'risks']

export function visibleTodayOpsItems(block) {
  return Array.isArray(block?.items) ? block.items.slice(0, 3) : []
}

export function todayOpsWelcomeSummary(view) {
  if (!view?.summary) return ''
  const parts = [`今天 ${view.summary.pending} 项待处理`]
  if (view.summary.risks > 0) parts.push(`${view.summary.risks} 项风险`)
  else if (view.summary.publishing > 0) parts.push(`${view.summary.publishing} 条待发布`)
  return parts.join(' · ') + ' · 查看今日运营'
}
