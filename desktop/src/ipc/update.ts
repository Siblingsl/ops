import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { isTrustedDownloadUrl, type DesktopUpdateChecker, type DesktopUpdateStatus } from '../update-check';

// OPT-E02（docs/43 §5）：桌面端版本更新检查的三条固定意图通道。
// 与 ipc/desktop-ui.ts 同口径：只有业务窗口主框架可调用；三条通道都不接受入参，
// 「打开下载页」只使用主进程已检查并二次校验过的下载链接，渲染器无法传入任意 URL。

export const DESKTOP_UI_UPDATE_STATUS_CHANNEL = 'desktop-ui:update-status';
export const DESKTOP_UI_GET_UPDATE_STATUS_CHANNEL = 'desktop-ui:get-update-status';
export const DESKTOP_UI_CHECK_UPDATE_CHANNEL = 'desktop-ui:check-update';
export const DESKTOP_UI_OPEN_UPDATE_DOWNLOAD_CHANNEL = 'desktop-ui:open-update-download';

export type DesktopUpdateIpcStatusResult =
  | { ok: true; status: DesktopUpdateStatus }
  | { ok: false; code: string; message: string };

export type DesktopUpdateIpcOpenResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

export type DesktopUpdateIpcDeps = {
  ipcHandle: <T>(channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => T | Promise<T>) => void;
  businessWindow: () => BrowserWindow | null;
  isBusinessUrl: (url: string) => boolean;
  checker: DesktopUpdateChecker;
  openExternal: (url: string) => Promise<void> | void;
};

function failure<T extends { ok: false; code: string; message: string }>(code: string, message: string): T {
  return { ok: false, code, message } as T;
}

/** 业务窗口来源守卫：与 ipc/cx.ts、ipc/desktop-ui.ts 同口径（宿主、同一 webContents、主框架、双 URL 都在业务站内）。 */
function isTrustedBusinessSender(
  event: IpcMainInvokeEvent,
  host: BrowserWindow | null,
  isBusinessUrl: (url: string) => boolean,
): host is BrowserWindow {
  const senderFrame = event.senderFrame;
  return Boolean(host && !host.isDestroyed() && event.sender === host.webContents
    && senderFrame && senderFrame === event.sender.mainFrame && isBusinessUrl(senderFrame.url)
    && isBusinessUrl(event.sender.getURL()));
}

export function registerDesktopUpdateIpcHandlers(deps: DesktopUpdateIpcDeps): void {
  const { ipcHandle, businessWindow, isBusinessUrl, checker, openExternal } = deps;

  ipcHandle(DESKTOP_UI_GET_UPDATE_STATUS_CHANNEL, (event): DesktopUpdateIpcStatusResult => {
    if (!isTrustedBusinessSender(event, businessWindow(), isBusinessUrl)) {
      return failure('not_business_window', '不允许此窗口读取客户端更新状态。');
    }
    return { ok: true, status: checker.getStatus() };
  });

  ipcHandle(DESKTOP_UI_CHECK_UPDATE_CHANNEL, async (event): Promise<DesktopUpdateIpcStatusResult> => {
    if (!isTrustedBusinessSender(event, businessWindow(), isBusinessUrl)) {
      return failure('not_business_window', '不允许此窗口检查客户端更新。');
    }
    // checkNow 内部已把网络/HTTP/JSON 异常收敛为 status: 'error'，这里无需再兜底。
    return { ok: true, status: await checker.checkNow() };
  });

  ipcHandle(DESKTOP_UI_OPEN_UPDATE_DOWNLOAD_CHANNEL, async (event): Promise<DesktopUpdateIpcOpenResult> => {
    // 固定通道无参：忽略调用方传入的任何参数，只使用已检查到的受信任链接。
    if (!isTrustedBusinessSender(event, businessWindow(), isBusinessUrl)) {
      return failure('not_business_window', '不允许此窗口打开客户端下载页。');
    }
    const url = checker.getStatus().downloadUrl;
    if (!url || !isTrustedDownloadUrl(url)) {
      return failure('download_unavailable', '当前没有可用的下载链接，请联系管理员获取最新安装包。');
    }
    try {
      await openExternal(url);
    } catch {
      return failure('open_failed', '系统浏览器未能打开下载链接，请稍后重试。');
    }
    return { ok: true };
  });
}
