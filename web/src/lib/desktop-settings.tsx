import { createContext, useCallback, useContext, useEffect, useId } from 'react'
import { desktopSettingsLabel, settingsEntries, settingsEntryFor, settingsGroupOf, type SettingsEntry } from './settings-registry'

export { currentAccountSettingsPath } from './settings-registry'
export type { SettingsEntry, SettingsGroupName, SettingsScope } from './settings-registry'
export { settingsGroupOf }

/** 桌面设置窗的条目清单 = 同一事实源（GL-02），仅此处按桌面呈现取别名。 */
export { settingsEntries as desktopSettingsEntries }

export function desktopSettingsPanel(pathname: string) {
  const entry = settingsEntryFor(pathname)
  return entry?.tool ? undefined : entry
}

/** 设置窗里显示的当前项名称（含桌面别名）。 */
export function desktopSettingsEntryLabel(entry: SettingsEntry) {
  return desktopSettingsLabel(entry)
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

/** 桌面端「打开设置窗」入口：独立工具页跳出去后，靠它回到设置窗（ST-06）。 */
export function requestOpenSettings() {
  window.opsDesktopSettings?.openSettings()
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
