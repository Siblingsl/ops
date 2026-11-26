import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';

// POLISH-02（docs/43 §4 第 3.2 条）：偏好设置「此电脑」内的本机连接 / 运行 / 版本诊断。
// 两条固定通道都无入参：读取只回严格 16 键脱敏摘要；导出复用 settings:export-diagnostics
// 的报告结构，保存框与落盘都留在主进程，本机绝对路径永远不回传渲染器。
// 与 ipc/update.ts、ipc/desktop-ui.ts 同口径：只有业务窗口主框架可调，被拒时不碰任何依赖。

export const DESKTOP_UI_GET_CLIENT_DIAGNOSTICS_CHANNEL = 'desktop-ui:get-client-diagnostics';
export const DESKTOP_UI_EXPORT_CLIENT_DIAGNOSTICS_CHANNEL = 'desktop-ui:export-client-diagnostics';

/** 渲染器可见的只读摘要：严格 16 键，键名按字母序即为白名单顺序。 */
export type DesktopClientDiagnostics = {
  appVersion: string;
  electronVersion: string;
  platform: string;
  arch: string;
  connectionState: 'online' | 'offline' | 'unknown';
  mode: 'server' | 'desktop';
  channelState: 'disconnected' | 'connecting' | 'ready' | 'error';
  channelMessage: string;
  routeRevision: number;
  signedIn: boolean;
  reauthRequired: boolean;
  storageAvailable: boolean;
  localConfigAvailable: boolean;
  deviceRegistered: boolean | null;
  modelCount: number | null;
  activeModelRequests: number;
};

/**
 * 主进程内部诊断源：在 16 键摘要之外只多出两个「只进落盘报告」的字段——
 * `nodeVersion` 与 `service`（服务地址）。它们不进 IPC 摘要，也不进渲染器。
 */
export type DesktopClientDiagnosticsSource = DesktopClientDiagnostics & {
  nodeVersion: string;
  service: string;
};

export type DesktopClientDiagnosticsResult =
  | { ok: true; diagnostics: DesktopClientDiagnostics }
  | { ok: false; code: string; message: string };

export type DesktopClientDiagnosticsExportResult =
  | { ok: true; canceled: boolean }
  | { ok: false; code: string; message: string };

export type DesktopClientDiagnosticsIpcDeps = {
  ipcHandle: <T>(channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => T | Promise<T>) => void;
  businessWindow: () => BrowserWindow | null;
  isBusinessUrl: (url: string) => boolean;
  getDiagnosticsSource: () => Promise<DesktopClientDiagnosticsSource | null>;
  saveDiagnosticsFile: (window: BrowserWindow, defaultName: string, content: string) => Promise<{ canceled: boolean }>;
};

type Failure = { ok: false; code: string; message: string };

function failure<T extends Failure>(code: string, message: string): T {
  return { ok: false, code, message } as T;
}

/** 业务窗口来源守卫：与 ipc/update.ts、ipc/desktop-ui.ts 完全同口径。 */
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

/** 只保留 16 个白名单键；nodeVersion / service 等仅用于落盘报告的字段在此被剥离。 */
function toDiagnostics(source: DesktopClientDiagnosticsSource): DesktopClientDiagnostics {
  return {
    appVersion: source.appVersion,
    electronVersion: source.electronVersion,
    platform: source.platform,
    arch: source.arch,
    connectionState: source.connectionState,
    mode: source.mode,
    channelState: source.channelState,
    channelMessage: source.channelMessage,
    routeRevision: source.routeRevision,
    signedIn: source.signedIn,
    reauthRequired: source.reauthRequired,
    storageAvailable: source.storageAvailable,
    localConfigAvailable: source.localConfigAvailable,
    deviceRegistered: source.deviceRegistered,
    modelCount: source.modelCount,
    activeModelRequests: source.activeModelRequests,
  };
}

/** 与 settings:export-diagnostics 同口径的脱敏报告（字段名、缩进与末尾换行都保持一致）。 */
function buildReport(source: DesktopClientDiagnosticsSource): string {
  const report = {
    generated_at: new Date().toISOString(),
    app: {
      version: source.appVersion,
      electron: source.electronVersion,
      node: source.nodeVersion,
      platform: source.platform,
      architecture: source.arch,
    },
    service: source.service,
    business_connection: source.connectionState,
    client: {
      signed_in: source.signedIn,
      reauth_required: source.reauthRequired,
      secure_storage_available: source.storageAvailable,
      local_config_available: source.localConfigAvailable,
      device_registered: source.deviceRegistered,
      model_count: source.modelCount,
      active_model_requests: source.activeModelRequests,
      channel_state: source.channelState,
      mode: source.mode,
      route_revision: source.routeRevision,
    },
  };
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function registerClientDiagnosticsIpcHandlers(deps: DesktopClientDiagnosticsIpcDeps): void {
  const { ipcHandle, businessWindow, isBusinessUrl, getDiagnosticsSource, saveDiagnosticsFile } = deps;

  ipcHandle(DESKTOP_UI_GET_CLIENT_DIAGNOSTICS_CHANNEL, async (event): Promise<DesktopClientDiagnosticsResult> => {
    // 固定通道无参：忽略调用方传入的任何参数。
    if (!isTrustedBusinessSender(event, businessWindow(), isBusinessUrl)) {
      return failure('not_business_window', '不允许此窗口读取客户端诊断状态。');
    }
    let source: DesktopClientDiagnosticsSource | null;
    try {
      source = await getDiagnosticsSource();
    } catch {
      return failure('diagnostics_failed', '读取客户端诊断状态失败，请稍后重试。');
    }
    if (!source) return failure('client_unavailable', '本机客户端尚未就绪，请稍后重试。');
    return { ok: true, diagnostics: toDiagnostics(source) };
  });

  ipcHandle(DESKTOP_UI_EXPORT_CLIENT_DIAGNOSTICS_CHANNEL, async (event): Promise<DesktopClientDiagnosticsExportResult> => {
    // 固定通道无参：默认文件名与报告内容全部由主进程生成，渲染器无法指定路径或内容。
    const host = businessWindow();
    if (!isTrustedBusinessSender(event, host, isBusinessUrl)) {
      return failure('not_business_window', '不允许此窗口导出客户端诊断信息。');
    }
    let source: DesktopClientDiagnosticsSource | null;
    try {
      source = await getDiagnosticsSource();
    } catch {
      return failure('export_failed', '导出脱敏诊断信息失败，请稍后重试。');
    }
    if (!source) return failure('client_unavailable', '本机客户端尚未就绪，请稍后重试。');
    const defaultName = `ops-desktop-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
    try {
      const result = await saveDiagnosticsFile(host, defaultName, buildReport(source));
      // 只回取消与否；保存路径等本机信息一律不回传。
      return { ok: true, canceled: result.canceled === true };
    } catch {
      return failure('export_failed', '导出脱敏诊断信息失败，请稍后重试。');
    }
  });
}
