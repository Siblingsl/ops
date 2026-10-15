import { useMemo } from 'react'
import { get } from './api'
import { setCustomTheme } from './custom-theme-state'
import { htmlStats, renderWechat } from './render'
import type { CustomTheme, Work } from './types'
import { useCustomTheme } from './v3'

/** 与排版预览页相同的主题注册、正文渲染和体积统计。 */
export function buildWechatHtml(work: Work, customTheme: CustomTheme | null, themeId = work.theme) {
  setCustomTheme(customTheme)
  const html = renderWechat(work.sections, themeId, work.assets)
  return { html, ...htmlStats(html) }
}

export function useWechatHtml(work: Work, themeId?: string) {
  const customTheme = useCustomTheme(work.account_id).data
  return useMemo(() => buildWechatHtml(work, customTheme ?? null, themeId), [work, customTheme, themeId])
}

/** 执行时重新读取作品，绝不使用卡片提出时或查询缓存中的正文、修订号。 */
export async function agentWechatPayload(toolName: string, workId: string): Promise<Record<string, unknown>> {
  const work = await get<Work>(`/works/${workId}`)
  const article = work.platform === 'wechat_mp' && work.content_format !== 'comic' && work.content_format !== 'card_post'
  if (toolName === 'wechat__push' && !article) return { revision: work.revision }
  if (toolName === 'checks__start' && !article) return {}
  const customTheme = await get<CustomTheme | null>(`/accounts/${work.account_id}/custom-theme`)
  const rendered = buildWechatHtml(work, customTheme)
  if (toolName === 'wechat__push') return { html: rendered.html, revision: work.revision }
  if (toolName === 'checks__start') return { html_chars: rendered.chars, html_bytes: rendered.bytes }
  throw new Error('该工具没有公众号前端载荷契约')
}
