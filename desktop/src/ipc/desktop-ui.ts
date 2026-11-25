import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import type { LocalSettingsPanel } from '../settings-view';
import type { DesktopUiIntent } from '../ui-intents';

// OPT-U04（docs/43 §4）：桌面「平台登录」与「本机设置面板」的固定意图通道。
// 目的：绕开 window.open 在桌面 dev 构建被弹窗拦截返回 null 的路径（RC-03 阻塞点）。
// 与 ipc/cx.ts、ipc/publish-pack.ts 同口径：只有业务窗口主框架可调，参数严格校验、
// 多余键整份拒绝；返回值只回 { ok: true } 或 { ok: false, code, message }。

export const DESKTOP_UI_OPEN_PLATFORM_LOGIN_CHANNEL = 'desktop-ui:open-platform-login';
export const DESKTOP_UI_SETTINGS_PANEL_CHANNEL = 'desktop-ui:settings-panel';

export type DesktopUiIpcSuccess = { ok: true };
export type DesktopUiIpcFailure = { ok: false; code: string; message: string };
export type DesktopUiIpcResult = DesktopUiIpcSuccess | DesktopUiIpcFailure;

export type DesktopUiPlatform = 'wechat_mp' | 'xhs' | 'toutiao';
export type DesktopUiSettingsAction = LocalSettingsPanel | 'detach' | 'close';

export type DesktopUiIpcDeps = {
  ipcHandle: <T>(channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => T | Promise<T>) => void;
  businessWindow: () => BrowserWindow | null;
  isBusinessUrl: (url: string) => boolean;
  applyIntent: (window: BrowserWindow, intent: DesktopUiIntent) => void;
};

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const PLATFORM_LOGIN_KEYS = 'accountId,platform';
const SETTINGS_PANEL_KEYS = 'action';
const PLATFORMS = new Set<DesktopUiPlatform>(['wechat_mp', 'xhs', 'toutiao']);
const SETTINGS_ACTIONS = new Set<DesktopUiSettingsAction>([
  'connection', 'ai', 'account-device', 'diagnostics', 'detach', 'close',
]);

function failure(code: string, message: string): DesktopUiIpcFailure {
  return { ok: false, code, message };
}

function asRecord(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

/** 业务窗口来源守卫：与 ipc/cx.ts 同口径（宿主存活、同一 webContents、主框架、两个 URL 都在业务站内）。 */
function isTrustedBusinessSender(event: IpcMainInvokeEvent, host: BrowserWindow | null, isBusinessUrl: (url: string) => boolean): host is BrowserWindow {
  const senderFrame = event.senderFrame;
  return Boolean(host && !host.isDestroyed() && event.sender === host.webContents
    && senderFrame && senderFrame === event.sender.mainFrame && isBusinessUrl(senderFrame.url)
    && isBusinessUrl(event.sender.getURL()));
}

/** 严格入参校验：只接受 { accountId: UUID, platform: 'wechat_mp'|'xhs'|'toutiao' }，多余键整份拒绝。 */
function parsePlatformLoginInput(raw: unknown): { accountId: string; platform: DesktopUiPlatform } | null {
  const value = asRecord(raw);
  if (!value || Object.keys(value).sort().join(',') !== PLATFORM_LOGIN_KEYS) return null;
  const accountId = value.accountId;
  const platform = value.platform;
  if (typeof accountId !== 'string' || !UUID.test(accountId)) return null;
  if (typeof platform !== 'string' || !PLATFORMS.has(platform as DesktopUiPlatform)) return null;
  return { accountId, platform: platform as DesktopUiPlatform };
}

/** 严格入参校验：只接受 { action: 六个固定动作之一 }，多余键整份拒绝。 */
function parseSettingsAction(raw: unknown): DesktopUiSettingsAction | null {
  const value = asRecord(raw);
  if (!value || Object.keys(value).sort().join(',') !== SETTINGS_PANEL_KEYS) return null;
  const action = value.action;
  if (typeof action !== 'string' || !SETTINGS_ACTIONS.has(action as DesktopUiSettingsAction)) return null;
  return action as DesktopUiSettingsAction;
}

function intentForSettingsAction(action: DesktopUiSettingsAction): DesktopUiIntent {
  if (action === 'detach') return { type: 'settings-detach' };
  if (action === 'close') return { type: 'settings-close' };
  return { type: 'settings-pane', panel: action };
}

export function registerDesktopUiIpcHandlers(deps: DesktopUiIpcDeps): void {
  const { ipcHandle, businessWindow, isBusinessUrl, applyIntent } = deps;

  ipcHandle(DESKTOP_UI_OPEN_PLATFORM_LOGIN_CHANNEL, (event, raw): DesktopUiIpcResult => {
    const host = businessWindow();
    if (!isTrustedBusinessSender(event, host, isBusinessUrl)) {
      return failure('not_business_window', '不允许此窗口打开平台登录。');
    }
    const input = parsePlatformLoginInput(raw);
    if (!input) return failure('invalid_argument', '平台登录参数无效。');
    applyIntent(host, { type: 'platform-login', accountId: input.accountId, platform: input.platform });
    return { ok: true };
  });

  ipcHandle(DESKTOP_UI_SETTINGS_PANEL_CHANNEL, (event, raw): DesktopUiIpcResult => {
    const host = businessWindow();
    if (!isTrustedBusinessSender(event, host, isBusinessUrl)) {
      return failure('not_business_window', '不允许此窗口切换本机设置面板。');
    }
    const action = parseSettingsAction(raw);
    if (!action) return failure('invalid_argument', '本机设置面板参数无效。');
    applyIntent(host, intentForSettingsAction(action));
    return { ok: true };
  });
}
