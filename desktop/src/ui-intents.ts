import type { LocalSettingsPanel } from './settings-view';

export type DesktopUiIntent =
  | { type: 'menu'; menu: 'client' | 'edit' | 'view' }
  | { type: 'settings' }
  | { type: 'settings-pane'; panel: LocalSettingsPanel }
  | { type: 'settings-detach' }
  | { type: 'settings-close' }
  | { type: 'platform-login'; accountId: string; platform: 'xhs' | 'wechat_mp' | 'toutiao' }
  | { type: 'theme'; theme: 'light' | 'dark' }
  | { type: 'motion'; reduced: boolean }

const INTENTS: Record<string, DesktopUiIntent> = {
  'ops-desktop://ui/menu/client': { type: 'menu', menu: 'client' },
  'ops-desktop://ui/menu/edit': { type: 'menu', menu: 'edit' },
  'ops-desktop://ui/menu/view': { type: 'menu', menu: 'view' },
  'ops-desktop://ui/settings': { type: 'settings' },
  'ops-desktop://ui/theme/light': { type: 'theme', theme: 'light' },
  'ops-desktop://ui/theme/dark': { type: 'theme', theme: 'dark' },
  'ops-desktop://ui/motion/reduce': { type: 'motion', reduced: true },
  'ops-desktop://ui/motion/soft': { type: 'motion', reduced: false },
}

export function parseDesktopUiIntent(url: string): DesktopUiIntent | null {
  const platformLogin = /^ops-desktop:\/\/ui\/platform-login\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\/(xhs|wechat_mp|toutiao)$/.exec(url);
  if (platformLogin) return { type: 'platform-login', accountId: platformLogin[1], platform: platformLogin[2] as 'xhs' | 'wechat_mp' | 'toutiao' };
  const settingsAction = /^ops-desktop:\/\/ui\/settings\/(connection|ai|account-device|diagnostics|detach|close)$/.exec(url);
  if (settingsAction) {
    const action = settingsAction[1];
    if (action === 'detach') return { type: 'settings-detach' };
    if (action === 'close') return { type: 'settings-close' };
    return { type: 'settings-pane', panel: action as LocalSettingsPanel };
  }
  const intent = INTENTS[url]
  return intent ? { ...intent } : null
}
