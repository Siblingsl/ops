import type { DefinitionFields } from './skill-canon'

export type SkillDef = DefinitionFields
export interface SkillDefinition extends SkillDef {
  id: string
  scope: string
  account_id: string | null
  revision: number
  content_hash: string
  origin: string
  source_key: string
  created_by: string | null
  created_at: string | null
  updated_at: string | null
}
export interface SkillWarning { code: string; field: string; message: string }
export type SkillForm = SkillDef & { scope: string; account_id: string | null }
export interface SkillList { items: SkillDefinition[]; next_cursor: string | null; total: number }
export interface SkillImpact {
  base_revision: number
  affected_bindings: number
  accounts: { id: string; name: string; workspace_name: string; bindings: number }[]
  impact_token: string
}
export const skillPlatforms = [
  { value: 'wechat_mp', label: '公众号' }, { value: 'xhs', label: '小红书' }, { value: 'toutiao', label: '今日头条' },
]
export const skillFormats = [
  { value: 'long_article', label: '长图文' }, { value: 'image_note', label: '图文笔记' },
  { value: 'comic', label: '漫画' }, { value: 'qa_article', label: '问答体' },
  { value: 'briefing', label: '资讯简报' }, { value: 'list_note', label: '清单合集' },
  { value: 'card_post', label: '图文卡片' }, { value: 'script', label: '口播脚本' },
  { value: 'micro_post', label: '微头条' },
]
export const skillTasks = [
  'outline', 'section_draft', 'section_edit', 'title', 'summary', 'rewrite_plan',
  'section_rewrite', 'comic_storyboard', 'comic_panel_text', 'comic_rewrite',
  'section_continue', 'hook_suggest', 'topic_suggest', 'topic_hot_suggest',
  'image_suggest', 'organize_notes', 'daily_recommend', 'strategy_outline',
  'tag_suggest', 'outline_review', 'read_through', 'polish_check', 'fix_suggest', 'layout_suggest', 'copilot_chat',
]
const reasons: Record<string, string> = {
  builtin_retired: '内置版本已退役', disabled: '技能已停用', task_disabled: '生成入口未开启',
  agent_disabled: '智能体入口未开启', platform_mismatch: '平台不匹配', format_mismatch: '作品形态不匹配',
  task_mismatch: '任务不在适用范围', candidate_limit: '超出入选上限', budget_exceeded: '超出装配预算',
  not_loaded: '未在智能体中加载',
}
export function skillReasonText(reason: string | null | undefined) { return reason ? reasons[reason] ?? reason : '' }
export function skillScopeLabel(scope: string) {
  return scope === 'builtin' ? '内置' : scope === 'workspace' ? '工作区' : scope === 'account' ? '账号' : '个人'
}
// 只拣选契约允许的字段，不能将列表 DTO 的 ID、归属或时间混入 PUT。
export function skillFields(form: SkillDef): SkillDef {
  return {
    name: form.name, summary: form.summary, triggers: form.triggers, instructions: form.instructions,
    platforms: form.platforms, content_formats: form.content_formats, task_types: form.task_types,
    task_enabled: form.task_enabled, agent_enabled: form.agent_enabled, status: form.status,
  }
}
export function emptySkillForm(): SkillForm {
  return {
    name: '', summary: '', triggers: '', instructions: '', platforms: [], content_formats: [], task_types: [],
    task_enabled: true, agent_enabled: true, status: 'active', scope: 'personal', account_id: '',
  }
}
