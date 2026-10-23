import type { LocalSettingsPanel } from './settings-view';

export type DesktopUiIntent =
  | { type: 'menu'; menu: 'client' | 'edit' | 'view' }
  | { type: 'settings' }
  | { type: 'settings-pane'; panel: LocalSettingsPanel }
  | { type: 'settings-detach' }
  | { type: 'settings-close' }
  | { type: 'platform-login'; accountId: string; platform: 'xhs' | 'wechat_mp' | 'toutiao' }
  | { type: 'platform-account-sync'; accountId: string; mode: 'incremental' | 'full_reconcile'; connectionRevision: number; requestId: string }
  | { type: 'platform-metrics-refresh'; accountId: string; connectionRevision: number; platformWorkId?: string; requestId: string }
  | { type: 'platform-sync-resume'; accountId: string; operationId: string; expectedOperationRevision: number; requestId: string }
  | { type: 'theme'; theme: 'light' | 'dark' }
  | { type: 'motion'; reduced: boolean }

export type PlatformIntentKind = 'platform-account-sync' | 'platform-metrics-refresh' | 'platform-sync-resume'
export type PlatformIntentResult = {
  kind: PlatformIntentKind
  requestId: string
  accountId: string
  status: 'queued' | 'existing' | 'no_targets' | 'failed'
  operationId?: string
  message?: string
}

export const PLATFORM_INTENT_RESULT_CHANNEL = 'desktop-ui:platform-intent-result'

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
const REVISION = '[1-9][0-9]{0,15}'

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
  const platformLogin = new RegExp(`^ops-desktop://ui/platform-login/(${UUID})/(xhs|wechat_mp|toutiao)$`).exec(url);
  if (platformLogin) return { type: 'platform-login', accountId: platformLogin[1], platform: platformLogin[2] as 'xhs' | 'wechat_mp' | 'toutiao' };
  const platformAccountSync = new RegExp(`^ops-desktop://ui/platform-account-sync/(${UUID})/(incremental|full_reconcile)/(${REVISION})/(${UUID})$`).exec(url);
  if (platformAccountSync) {
    const connectionRevision = Number(platformAccountSync[3]);
    if (!Number.isSafeInteger(connectionRevision)) return null;
    return {
      type: 'platform-account-sync',
      accountId: platformAccountSync[1],
      mode: platformAccountSync[2] as 'incremental' | 'full_reconcile',
      connectionRevision,
      requestId: platformAccountSync[4]
    };
  }
  const platformMetricsRefresh = new RegExp(`^ops-desktop://ui/platform-metrics-refresh/(${UUID})/(${REVISION})/(?:(${UUID})/)?(${UUID})$`).exec(url);
  if (platformMetricsRefresh) {
    const connectionRevision = Number(platformMetricsRefresh[2]);
    if (!Number.isSafeInteger(connectionRevision)) return null;
    const platformWorkId = platformMetricsRefresh[3];
    return {
      type: 'platform-metrics-refresh',
      accountId: platformMetricsRefresh[1],
      connectionRevision,
      ...(platformWorkId ? { platformWorkId } : {}),
      requestId: platformMetricsRefresh[4]
    };
  }
  const platformSyncResume = new RegExp(`^ops-desktop://ui/platform-sync-resume/(${UUID})/(${UUID})/(${REVISION})/(${UUID})$`).exec(url);
  if (platformSyncResume) {
    const expectedOperationRevision = Number(platformSyncResume[3]);
    if (!Number.isSafeInteger(expectedOperationRevision)) return null;
    return {
      type: 'platform-sync-resume',
      accountId: platformSyncResume[1],
      operationId: platformSyncResume[2],
      expectedOperationRevision,
      requestId: platformSyncResume[4]
    };
  }
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

export type BusinessWindowOnlyIntent = Extract<DesktopUiIntent, { type: PlatformIntentKind }>

// 只有业务窗口可以发起这三类本机平台动作：本机设置视图与独立设置窗口一律拒绝。
export function isBusinessWindowOnlyIntent(intent: DesktopUiIntent): intent is BusinessWindowOnlyIntent {
  return intent.type === 'platform-account-sync'
    || intent.type === 'platform-metrics-refresh'
    || intent.type === 'platform-sync-resume'
}
