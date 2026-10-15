import type { QueryClient } from '@tanstack/react-query'

export interface AgentMutationTarget {
  type: string
  id: string
  account_id?: string | null
  work_id?: string | null
}

// 仅登记现有页面使用的查询键。工具必须显式列出，新增工具不会自动套用前缀规则。
const work = ['work', 'works', 'check', 'check-report', 'push-preview', 'versions', 'calendar', 'dashboard', 'next-actions', 'activity', 'search', 'search-page']
const topics = ['topics', 'dashboard', 'next-actions', 'calendar', 'search', 'search-page']
const groups: [string, readonly string[]][] = [
  ['works__create works__import_published works__update works__set_viewpoint works__set_post_push_todos works__set_title_favorites works__delete works__duplicate works__derive works__unlock works__create_version works__restore_version works__preview_link works__polish_ignore works__golden_sentence works__approve_review works__mark_published works__organize_apply works__generate_image', work],
  ['outline__save outline__confirm storyboard__save storyboard__confirm sections__create sections__reorder sections__update sections__delete sections__restore sections__set_materials sections__draft sections__rewrite sections__restore_revision cards__generate_image panels__update panels__generate_text panels__generate_image', [...work, 'section-revisions', 'library', 'materials', 'material-usage']],
  ['checks__start checks__resolve_item checks__complete wechat__push wechat__sync_draft xhs__create_pack', work],
  ['assets__upload assets__reuse assets__update assets__crop assets__delete', [...work, 'library']],
  ['topics__score topics__create topics__update topics__delete', topics],
  ['topics__start_work', [...topics, ...work]],
  ['series__create series__update series__delete', ['series', 'series-context', 'topics']],
  ['accounts__create accounts__update accounts__disable accounts__enable accounts__test_wechat_credential accounts__wechat_link_check', ['accounts', 'push-preview', 'dashboard', 'health']],
  ['accounts__delete', ['accounts', ...work, ...topics, 'profile', 'memories', 'characters', 'samples', 'materials', 'library', 'board', 'reviews']],
  ['materials__create materials__update materials__delete materials__merge', ['materials', 'material-dups', 'material-usage', 'retrieve', 'search', 'search-page', 'work']],
  ['inbox__create inbox__triage inbox__dismiss', ['inbox']],
  ['inbox__convert_to_topic', ['inbox', ...topics]],
  ['inbox__convert_to_material', ['inbox', 'materials']],
  ['profile__update', ['profile', 'accounts', 'health']],
  ['custom_theme__update', ['custom-theme', ...work]],
  ['style__create style__update style__delete', ['samples', 'profile']],
  ['characters__create characters__update characters__delete characters__upload_ref characters__delete_ref', ['characters', 'work', 'library']],
  ['memory__create memory__distill memory__confirm memory__update memory__disable memory__delete', ['memories', 'health']],
  ['strategy__activate strategy__restore', ['strategy', 'plan', 'daily', 'dashboard', 'health']],
  ['plan__suggest plan__regenerate_slot plan__clear_slot', ['plan', 'calendar']],
  ['plan__adopt_slot', ['plan', ...topics, ...work]],
  ['daily__regenerate daily__replace_item daily__dismiss_item', ['daily', 'daily-stats']],
  ['daily__adopt_item daily__start_item', ['daily', 'daily-stats', ...topics, ...work]],
  ['daily_settings__update', ['daily-settings']],
  ['hot__refresh hot__dismiss_match', ['account-hot', 'hot-trends']],
  ['hot__convert_match', ['account-hot', ...topics]],
  ['hot_sources__update hot_sources__add_search', ['hot-sources', 'account-hot']],
  ['references__add references__paste references__delete', ['references']],
  ['metrics__create metrics__update metrics__delete metrics__import metrics__sync_wechat metrics__assign_unmatched metrics__ignore_unmatched metrics__recognize_screenshots metrics__confirm_screenshot_row', ['metrics', 'board', 'unmatched', 'top-works', 'dashboard', 'rhythm']],
  ['followers__record', ['followers', 'dashboard']],
  ['reviews__create reviews__ignore_insight reviews__attribution', ['reviews', 'digests']],
  ['reviews__adopt_suggestion', ['reviews', ...topics]],
  ['reviews__remember_insight', ['reviews', 'memories']],
  ['comments__create comments__update', ['comments', 'activity']],
  ['stars__add stars__remove', ['stars']],
  ['workspace__create workspace__rename workspace__transfer_owner', ['me', 'members', 'accounts', 'agent-bootstrap']],
  ['workspace__create_invite workspace__send_invite_email workspace__revoke_invite', ['invites']],
  ['workspace__set_member workspace__remove_member', ['members', 'me', 'agent-bootstrap']],
  ['admin__patch_user admin__reset_password admin__revoke_sessions', ['admin-users', 'me', 'agent-bootstrap']],
  ['admin__system_settings_update', ['admin-settings', 'auth-status', 'system']],
  ['admin__crawl_update admin__crawl_source_update admin__crawl_source_test admin__crawl_platform_update', ['crawl-admin', 'crawl-health', 'crawl-runs']],
  ['models__set_route models__test models__selftest', ['providers', 'routes', 'agent-bootstrap']],
  ['ai_jobs__cancel', ['ai-jobs', 'work-jobs']],
  ['feedback__post', ['quality', 'quality-calls']],
  ['settings__update', ['settings', 'ai-status']],
  ['words__create words__delete', ['words']],
  ['prompts__update', ['prompt-templates']],
  ['prompt_eval__create_case prompt_eval__delete_case prompt_eval__create_run prompt_eval__replay prompt_eval__update_run', ['eval-cases', 'eval-runs']],
  ['outline__templates_update', ['outline-templates']],
  ['trash__restore trash__purge', ['trash', ...work, ...topics, 'materials', 'library']],
  ['notifications__read notifications__read_all', ['notifications']],
  ['prefs__update', ['prefs']],
  ['demo__import demo__clear', ['accounts', ...work, ...topics, 'profile', 'materials', 'memories', 'board', 'reviews']],
]

export const agentInvalidationPrefixes: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  groups.flatMap(([names, keys]) => names.split(' ').map((name) => [name, keys])),
)

export async function invalidateAgentAction(client: QueryClient, toolName: string, target?: AgentMutationTarget) {
  const prefixes = agentInvalidationPrefixes[toolName]
  // TODO：新工具须核对页面查询键并登记；禁止对未知工具清空整个查询缓存。
  if (!prefixes) throw new Error(`工具 ${toolName} 尚未登记缓存失效映射，请刷新目标页面`)
  const keys: unknown[][] = prefixes.map((prefix) => [prefix])
  if (target?.work_id) keys.push(['work', target.work_id])
  if (target?.type === 'work' && target.id) keys.push(['work', target.id])
  await Promise.all(keys.map((queryKey) => client.invalidateQueries({ queryKey })))
}
