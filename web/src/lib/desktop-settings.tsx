import { createContext, useCallback, useContext, useEffect, useId } from 'react'

export interface SettingsEntry {
  path: string
  label: string
  group: string
  scope: '个人' | '当前账号' | '工作区' | '此电脑' | '系统'
  keywords?: string
  tool?: boolean
  adminOnly?: boolean
  localPanel?: 'connection' | 'ai' | 'account-device' | 'diagnostics'
}

export const desktopSettingsEntries: SettingsEntry[] = [
  { path: '/settings/preferences', label: '偏好设置', group: '个人', scope: '个人', keywords: '写作 快捷键 AI 档位' },
  { path: '/settings/security', label: '登录与安全', group: '个人', scope: '个人', keywords: '密码 登录' },
  { path: '/settings/accounts', label: '平台账号与凭证', group: '当前账号', scope: '当前账号', keywords: '公众号 微信公众号 小红书 今日头条 登录 凭证 回填 账号类型' },
  { path: '/settings/members', label: '成员与邀请', group: '工作区', scope: '工作区', keywords: '协作 邀请码 工作区名称' },
  { path: '/settings/models', label: '服务器模型', group: '工作区', scope: '工作区', keywords: '供应商 API 路由 采样' },
  { path: '/settings/desktop-ai', label: '桌面 AI 策略', group: '工作区', scope: '工作区', keywords: '本机 AI 客户端 端点 owner 所有者' },
  { path: '/settings/agent', label: '智能体设置', group: '工作区', scope: '工作区', keywords: 'AI 权限 观察者' },
  { path: '/settings/budget', label: 'AI 用量与成本', group: '工作区', scope: '工作区', keywords: 'token 每日 上限 费用' },
  { path: '/settings/words', label: '敏感词库', group: '工作区', scope: '工作区', keywords: '自定义词 通用词' },
  { path: '/settings/hot-sources', label: '热点来源', group: '工作区', scope: '工作区', keywords: 'RSS 联网 搜索 订阅' },
  { path: '/settings/daily', label: '每日推荐设置', group: '工作区', scope: '工作区', keywords: '后台 时间 主推 备选' },
  { path: '/settings/mail', label: '邀请邮件', group: '工作区', scope: '工作区', keywords: 'SMTP 邮箱' },
  { path: '/settings/export', label: '数据导出', group: '数据与工具', scope: '工作区', keywords: 'CSV Markdown 下载' },
  { path: '/settings/usage', label: '完整用量报表', group: '数据与工具', scope: '工作区', keywords: '独立工具', tool: true },
  { path: '/settings/quality', label: 'AI 质量看板', group: '数据与工具', scope: '工作区', keywords: '独立工具', tool: true },
  { path: '/settings/prompts', label: '提示词模板与测试集', group: '数据与工具', scope: '工作区', keywords: '独立工具', tool: true },
  { path: '/settings/logs', label: '操作日志', group: '数据与工具', scope: '工作区', keywords: '独立工具', tool: true },
  { path: '/settings/trash', label: '回收站', group: '数据与工具', scope: '工作区', keywords: '独立工具', tool: true },
  { path: '/settings/admin', label: '系统管理', group: '数据与工具', scope: '系统', keywords: '独立工具', tool: true, adminOnly: true },
  { path: '/settings/crawl', label: '热点采集与日志', group: '数据与工具', scope: '系统', keywords: '独立工具', tool: true, adminOnly: true },
  { path: '/settings/local/connection', label: '客户端连接', group: '本机与系统', scope: '此电脑', keywords: '本机 服务 模式 WSS', localPanel: 'connection' },
  { path: '/settings/local/ai', label: '本机 AI 配置', group: '本机与系统', scope: '此电脑', keywords: '模型 密钥 代理 自检 任务映射', localPanel: 'ai' },
  { path: '/settings/local/account-device', label: '账号与设备', group: '本机与系统', scope: '此电脑', keywords: '登录 重新认证 设备 平台浏览器', localPanel: 'account-device' },
  { path: '/settings/local/diagnostics', label: '诊断与关于', group: '本机与系统', scope: '此电脑', keywords: '脱敏 诊断 版本 服务信息 数据占用', localPanel: 'diagnostics' },
]

export function desktopSettingsPanel(pathname: string) {
  const path = pathname.replace(/\/$/, '') || '/'
  return desktopSettingsEntries.find((entry) => !entry.tool && entry.path === (path === '/settings' ? '/settings/preferences' : path))
}

export function currentAccountSettingsPath(accountId?: string | null) {
  return accountId ? `/settings/accounts?id=${encodeURIComponent(accountId)}` : '/settings/accounts'
}

export const DESKTOP_ACCOUNT_CREATE_REQUEST = 'ops:desktop-account-create-request'
export const DESKTOP_ACCOUNT_CREATE_READY = 'ops:desktop-account-create-ready'
export const DESKTOP_ACCOUNT_SWITCHER_REQUEST = 'ops:desktop-account-switcher-request'
export const DESKTOP_ACCOUNT_SWITCHER_READY = 'ops:desktop-account-switcher-ready'
export const DESKTOP_ACCOUNT_SWITCHER_FROM_SETTINGS_REQUEST = 'ops:desktop-account-switcher-from-settings-request'
export const DESKTOP_LEAVE_GUARD_REQUEST = 'ops:desktop-leave-guard-request'
export const DESKTOP_LEAVE_GUARD_RELEASE = 'ops:desktop-leave-guard-release'
export const DESKTOP_LOCAL_SETTINGS_REQUEST = 'ops:desktop-local-settings-request'

export function requestDesktopLeaveGuard(reserveNavigation = false) {
  const checks: Array<() => Promise<boolean>> = []
  const grants: Array<() => void> = []
  window.dispatchEvent(new CustomEvent(DESKTOP_LEAVE_GUARD_REQUEST, {
    detail: {
      reserveNavigation,
      register: (check: () => Promise<boolean> | boolean) => checks.push(async () => check()),
      grant: (onAllow: () => void) => grants.push(onAllow),
    },
  }))
  return Promise.all(checks.map((check) => check())).then((results) => {
    const allowed = results.every(Boolean)
    if (allowed) grants.forEach((grant) => grant())
    return allowed
  })
}

export function releaseDesktopLeaveGuard() {
  window.dispatchEvent(new Event(DESKTOP_LEAVE_GUARD_RELEASE))
}

export function requestDesktopAccountSwitcher() {
  window.dispatchEvent(new Event(DESKTOP_ACCOUNT_SWITCHER_FROM_SETTINGS_REQUEST))
}

interface SettingsContextValue {
  updateDraft: (id: string, dirty: boolean, busy: boolean) => void
  isBusy: () => boolean
}

export const DesktopSettingsContext = createContext<SettingsContextValue | null>(null)
export const useEmbeddedSettings = () => useContext(DesktopSettingsContext) !== null

/** 表单自身声明草稿状态；普通 Web 页面没有设置窗上下文，不改变其行为。 */
export function useSettingsDraft(dirty: boolean, busy = false) {
  const context = useContext(DesktopSettingsContext)
  const id = useId()
  const update = context?.updateDraft
  useEffect(() => {
    update?.(id, dirty, busy)
    return () => update?.(id, false, false)
  }, [update, id, dirty, busy])
  return useCallback(() => update?.(id, false, false), [update, id])
}
