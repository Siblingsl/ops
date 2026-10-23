import { Activity, Bot, Cpu, Gauge, KeyRound, ScrollText, Shield, ShieldAlert, SlidersHorizontal, Trash2, Users, type LucideIcon } from 'lucide-react'

export type SettingsScope = '个人' | '当前账号' | '工作区' | '此电脑' | '系统'

export interface SettingsEntry {
  path: string
  label: string
  /** 桌面设置窗中的别名；与 label 不同时，设置窗显示桌面名，用户菜单与命令面板显示 web 名。 */
  desktopLabel?: string
  group: string
  scope: SettingsScope
  icon: LucideIcon
  keywords?: string
  /** 主窗口独立工具页：从设置窗跳出后应能回到设置窗（ST-06）。 */
  tool?: boolean
  adminOnly?: boolean
  localPanel?: 'connection' | 'ai' | 'account-device' | 'diagnostics'
  /** 桌面端专属，Web 用户菜单/命令面板不显示。 */
  webHidden?: boolean
}

/**
 * 设置项唯一事实源（GL-02）：用户菜单、桌面设置窗、命令面板三处都从这里取数。
 * 新增设置项只改这一个数组；命名冲突用 `desktopLabel` 覆盖，避免同页不同名。
 * group 只用于桌面设置窗的分组视图；Web 用户菜单仍按 commonSettingsPaths 拆"常用/高级"。
 */
export const settingsEntries: SettingsEntry[] = [
  { path: '/settings/preferences', label: '偏好设置', group: '工作区设置', scope: '个人', icon: SlidersHorizontal, keywords: '写作 快捷键 AI 档位' },
  { path: '/settings/security', label: '登录与安全', group: '工作区设置', scope: '个人', icon: KeyRound, keywords: '密码 登录' },
  { path: '/settings/accounts', label: '平台账号与凭证', group: '工作区设置', scope: '当前账号', icon: Users, keywords: '公众号 微信公众号 小红书 今日头条 登录 凭证 回填 账号类型' },
  { path: '/settings/members', label: '成员与邀请', group: '工作区设置', scope: '工作区', icon: Users, keywords: '协作 邀请码 工作区名称' },
  { path: '/settings/models', label: '模型配置', desktopLabel: '服务器模型', group: '工作区设置', scope: '工作区', icon: Cpu, keywords: '供应商 API 路由 采样' },
  { path: '/settings/agent', label: '智能体设置', group: '工作区设置', scope: '工作区', icon: Bot, keywords: 'AI 权限 观察者' },
  { path: '/settings/desktop-ai', label: '桌面 AI 策略', group: '工作区设置', scope: '工作区', icon: Bot, keywords: '本机 AI 客户端 端点 owner 所有者', webHidden: true },
  { path: '/settings/budget', label: 'AI 用量与成本', group: '工作区设置', scope: '工作区', icon: Gauge, keywords: '每日 token 上限 调用 费用', webHidden: true },
  { path: '/settings/usage', label: 'AI 用量与成本', desktopLabel: '完整用量报表', group: '数据与工具', scope: '工作区', icon: Gauge, keywords: 'token 每日 上限 费用', tool: true },
  { path: '/settings/quality', label: 'AI 质量看板', group: '数据与工具', scope: '工作区', icon: Activity, keywords: '独立工具', tool: true },
  { path: '/settings/words', label: '敏感词库', group: '工作区设置', scope: '工作区', icon: ShieldAlert, keywords: '自定义词 通用词' },
  { path: '/settings/hot-sources', label: '热点来源', group: '工作区设置', scope: '工作区', icon: Activity, keywords: 'RSS 联网 搜索 订阅' },
  { path: '/settings/daily', label: '每日推荐设置', group: '工作区设置', scope: '工作区', icon: Activity, keywords: '后台 时间 主推 备选' },
  { path: '/settings/mail', label: '邀请邮件', group: '工作区设置', scope: '工作区', icon: Users, keywords: 'SMTP 邮箱', webHidden: true },
  { path: '/settings/export', label: '数据导出', group: '数据与工具', scope: '工作区', icon: Gauge, keywords: 'CSV Markdown 下载' },
  { path: '/settings/prompts', label: '提示词模板', desktopLabel: '提示词模板与测试集', group: '数据与工具', scope: '工作区', icon: ScrollText, keywords: '独立工具', tool: true },
  { path: '/settings/logs', label: '操作日志', group: '数据与工具', scope: '工作区', icon: ScrollText, keywords: '独立工具', tool: true },
  { path: '/settings/trash', label: '回收站', group: '数据与工具', scope: '工作区', icon: Trash2, keywords: '独立工具', tool: true },
  { path: '/settings/admin', label: '系统管理', group: '数据与工具', scope: '系统', icon: Shield, keywords: '独立工具', tool: true, adminOnly: true },
  { path: '/settings/crawl', label: '热点采集与日志', group: '数据与工具', scope: '系统', icon: Activity, keywords: '独立工具', tool: true, adminOnly: true },
  { path: '/settings/local/connection', label: '客户端连接', group: '本机与系统', scope: '此电脑', icon: Activity, keywords: '本机 服务 模式 WSS', localPanel: 'connection', webHidden: true },
  { path: '/settings/local/ai', label: '本机 AI 配置', group: '本机与系统', scope: '此电脑', icon: Cpu, keywords: '模型 密钥 代理 自检 任务映射', localPanel: 'ai', webHidden: true },
  { path: '/settings/local/account-device', label: '账号与设备', group: '本机与系统', scope: '此电脑', icon: Users, keywords: '登录 重新认证 设备 平台 browser', localPanel: 'account-device', webHidden: true },
  { path: '/settings/local/diagnostics', label: '诊断与关于', group: '本机与系统', scope: '此电脑', icon: Activity, keywords: '脱敏 诊断 版本 服务信息 数据占用', localPanel: 'diagnostics', webHidden: true },
]

/** 用户菜单"工作区设置"分组：高频四项；其余进"高级设置"折叠。 */
export const commonSettingsPaths = new Set(['/settings/accounts', '/settings/models', '/settings/members', '/settings/preferences'])

/** Web 用户菜单 / 命令面板可见的条目（不含桌面专属与管理员专属）。 */
export const webSettingsEntries = settingsEntries.filter((entry) => !entry.webHidden && !entry.adminOnly)

/** 桌面设置窗使用的显示名：有别名用别名，否则用 web 名。 */
export function desktopSettingsLabel(entry: SettingsEntry) {
  return entry.desktopLabel ?? entry.label
}

/** 桌面设置窗导航的五类分组。 */
export type SettingsGroupName = '个人' | '当前账号' | '工作区' | '数据与工具' | '本机与系统'

/**
 * 分组只由 scope/group 推导（GL-02）：设置窗渲染与验收脚本共用这一处，
 * 不要再各自维护「设置名 → 分组」的映射表。
 */
export function settingsGroupOf(entry: SettingsEntry): SettingsGroupName {
  if (entry.scope === '个人') return '个人'
  if (entry.scope === '当前账号') return '当前账号'
  if (entry.scope === '此电脑') return '本机与系统'
  return entry.group === '工作区设置' ? '工作区' : '数据与工具'
}

export function settingsEntryFor(pathname: string): SettingsEntry | undefined {
  const path = pathname.replace(/\/$/, '') || '/'
  if (path === '/settings') return settingsEntries[0]
  // 路径前缀匹配按长度降序，保证 /settings/local/ai 不会先命中 /settings/local。
  return settingsEntries.filter((entry) => path.startsWith(entry.path)).sort((a, b) => b.path.length - a.path.length)[0]
}

/** 命令面板用的 (路径, 名称) 列表；管理员项由调用方按角色追加。 */
export function commandPaletteSettings(): { to: string; label: string }[] {
  return webSettingsEntries.map((entry) => ({ to: entry.path, label: entry.label }))
}

export function currentAccountSettingsPath(accountId?: string | null) {
  return accountId ? `/settings/accounts?id=${encodeURIComponent(accountId)}` : '/settings/accounts'
}
