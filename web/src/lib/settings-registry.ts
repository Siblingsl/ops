import { Activity, Bot, Cpu, Gauge, KeyRound, ScrollText, Shield, ShieldAlert, SlidersHorizontal, Trash2, Users, type LucideIcon } from 'lucide-react'

export interface SettingsEntry {
  path: string
  label: string
  icon: LucideIcon
  adminOnly?: boolean
}

export const settingsEntries: SettingsEntry[] = [
  { path: '/settings/preferences', label: '偏好设置', icon: SlidersHorizontal },
  { path: '/settings/security', label: '登录与安全', icon: KeyRound },
  { path: '/settings/accounts', label: '平台账号与凭证', icon: Users },
  { path: '/settings/members', label: '成员与邀请', icon: Users },
  { path: '/settings/models', label: '模型配置', icon: Cpu },
  { path: '/settings/agent', label: '智能体设置', icon: Bot },
  { path: '/settings/skills', label: '写作技能', icon: ScrollText },
  { path: '/settings/usage', label: 'AI 用量与成本', icon: Gauge },
  { path: '/settings/quality', label: 'AI 质量看板', icon: Activity },
  { path: '/settings/words', label: '敏感词库', icon: ShieldAlert },
  { path: '/settings/hot-sources', label: '热点来源', icon: Activity },
  { path: '/settings/daily', label: '每日推荐设置', icon: Activity },
  { path: '/settings/export', label: '数据导出', icon: Gauge },
  { path: '/settings/prompts', label: '提示词模板', icon: ScrollText },
  { path: '/settings/logs', label: '操作日志', icon: ScrollText },
  { path: '/settings/trash', label: '回收站', icon: Trash2 },
  { path: '/settings/admin', label: '系统管理', icon: Shield, adminOnly: true },
  { path: '/settings/crawl', label: '热点采集与日志', icon: Activity, adminOnly: true },
]

export const commonSettingsPaths = new Set(['/settings/accounts', '/settings/models', '/settings/members', '/settings/preferences'])

export function settingsEntryFor(pathname: string): SettingsEntry | undefined {
  const path = pathname.replace(/\/$/, '') || '/'
  if (path === '/settings') return settingsEntries[0]
  return settingsEntries.filter((entry) => path.startsWith(entry.path)).sort((a, b) => b.path.length - a.path.length)[0]
}

export function commandPaletteSettings(): { to: string; label: string }[] {
  return settingsEntries.filter((entry) => !entry.adminOnly).map((entry) => ({ to: entry.path, label: entry.label }))
}

export function currentAccountSettingsPath(accountId?: string | null) {
  return accountId ? `/settings/accounts?id=${encodeURIComponent(accountId)}` : '/settings/accounts'
}
