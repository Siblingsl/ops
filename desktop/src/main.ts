import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  powerMonitor,
  protocol,
  session,
  shell,
  type IpcMainInvokeEvent,
  type Session
} from 'electron';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PRODUCTION_ORIGIN, resolveBusinessOrigin } from './business-origin';
import { DesktopClient, type DesktopRoute, type SaveModelInput } from './desktop-client';
import { registerDesktopPowerHandlers } from './power-lifecycle';
import {
  parseEnvelope,
  PlatformIPCErrorException,
  PlatformIPCSingleFlight,
  toIPCError,
  validatePayloadShape,
  withTimeout,
  type PlatformIPCEnvelope,
  type PlatformIPCError
} from './platform-ipc';
import {
  findPlatformBrowser,
  PlatformBrowserError,
  probePlatformBrowser
} from './platform-worker';
import {
  createCDPClient,
  launchPlatformBrowser
} from './platform-worker';
import {
  openLoginPage,
  waitForLogin,
  type PlatformLoginPlatform,
  type PlatformLoginSession
} from './platform-login';
import { connectionProfileDir, buildProfileMeta, profileMetaPath } from './platform-profile';
import { parseIdentity as parseXhsIdentity, probeCapabilities as probeXhsCapabilities } from './platforms/xhs';
import { parseIdentity as parseWechatIdentity, probeCapabilities as probeWechatCapabilities } from './platforms/wechat-mp';
import { parseDesktopUiIntent, type DesktopUiIntent } from './ui-intents';
import {
  buildDesktopRequestHeaders,
  isBusinessApiUrl,
  isManagementRequestMarker,
  shouldBlockDesktopApiRequest
} from './request-context';

const squirrelStartup = require('electron-squirrel-startup') as boolean;

// 逃生口：部分 Windows 机器上 Chromium 的 GPU 进程反复崩溃（exit_code 0xC0000005）后会直接
// FATAL 退出，用户看到的是「双击没反应」。默认行为保持不变；只有在启动前显式设置环境变量时才降级。
//   OPS_DESKTOP_NO_SANDBOX=1  关闭渲染进程沙箱（GPU 沙箱受限的环境）
//   OPS_DESKTOP_DISABLE_GPU=1 关闭硬件加速（显卡驱动不兼容的环境）
if (process.env.OPS_DESKTOP_NO_SANDBOX === '1') {
  app.commandLine.appendSwitch('no-sandbox');
}
if (process.env.OPS_DESKTOP_DISABLE_GPU === '1') {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu-sandbox');
}

if (squirrelStartup) {
  app.quit();
} else {
  startApplication();
}

const SETTINGS_PROTOCOL_ORIGIN = 'ops-desktop://settings';
const LOCAL_PAGES: Record<string, { file: string; contentType: string }> = {
  '/': { file: 'index.html', contentType: 'text/html; charset=utf-8' },
  '/settings.css': { file: 'settings.css', contentType: 'text/css; charset=utf-8' },
  '/desktop-theme.js': { file: 'desktop-theme.js', contentType: 'text/javascript; charset=utf-8' },
  '/settings.js': { file: 'settings.js', contentType: 'text/javascript; charset=utf-8' },
  '/offline/': { file: 'offline.html', contentType: 'text/html; charset=utf-8' },
  '/offline/offline.js': { file: 'offline.js', contentType: 'text/javascript; charset=utf-8' }
};

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'ops-desktop',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true
    }
  }
]);

let businessWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let failureWindow: BrowserWindow | null = null;
let businessLoadTimeout: ReturnType<typeof setTimeout> | null = null;
let businessFailureReason: 'unreachable' | 'icp-block' | 'render-failed' = 'unreachable';
let businessOrigin = PRODUCTION_ORIGIN;
let businessPartition = 'persist:ops-business-production';
let businessSession: Session | null = null;
let desktopClient: DesktopClient | null = null;
let externalPromptOpen = false;
const localWindows = new Set<number>();
const requestProvenance = new Map<number, 'trusted' | 'untrusted' | 'redirected'>();
const contextMutationRequests = new Set<number>();
let routingRefreshPending = false;
let routingRefresh: Promise<void> | null = null;
let accountDataClearInProgress = false;
let nativeStatusMenuItem: Electron.MenuItem | null = null;
let nativeStatusRevision = 0;
let quitConfirmed = false;
let quitDialogOpen = false;
let desktopTheme: 'light' | 'dark' = 'light';
let desktopReducedMotion: boolean | null = null;

function startApplication(): void {
  app.setAppUserModelId('com.squirrel.OpsDesktop.OPSDesktop');
  nativeTheme.themeSource = 'light';

  const hasLock = app.requestSingleInstanceLock();
  if (!hasLock) {
    app.quit();
    return;
  }

  app.on('second-instance', () => {
    if (businessWindow && !businessWindow.isDestroyed()) {
      businessWindow.show();
      businessWindow.focus();
    } else {
      void loadBusinessPage();
    }
  });

  app.whenReady().then(async () => {
    try {
      desktopTheme = await restoreDesktopTheme();
      desktopReducedMotion = await restoreDesktopMotion();
      nativeTheme.themeSource = desktopTheme;
      businessOrigin = resolveBusinessOrigin(app.isPackaged, process.env.OPS_DESKTOP_DEV_URL);
      businessPartition = businessOrigin === PRODUCTION_ORIGIN
        ? 'persist:ops-business-production'
        : 'persist:ops-business-development';
      registerIpcHandlers();
      installApplicationMenu();

      businessSession = session.fromPartition(businessPartition);
      desktopClient = new DesktopClient(businessSession, businessOrigin);
      registerDesktopPowerHandlers(
        powerMonitor,
        () => desktopClient?.disconnect(),
        () => updateNativeClientStatus()
      );
      installBusinessPermissions(businessSession);
      installDesktopRequestContext(businessSession);
      installDownloadHandling(businessSession);
      await registerLocalProtocol(businessSession);

      await registerLocalProtocol(session.fromPartition('ops-settings'));
      const restoredMode = await desktopClient.restoreAppliedMode();
      void updateNativeClientStatus();
      if (restoredMode === 'incompatible') showFailureWindow();
      else await loadBusinessPage();
    } catch (error) {
      const message = error instanceof Error ? error.message : '启动配置无效';
      await dialog.showMessageBox({
        type: 'error',
        title: 'OPS Desktop 启动失败',
        message
      });
      quitConfirmed = true;
      app.quit();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void loadBusinessPage();
    } else if (businessWindow && !businessWindow.isDestroyed()) {
      businessWindow.show();
    }
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', (event) => {
    if (quitConfirmed) {
      desktopClient?.disconnect();
      return;
    }
    event.preventDefault();
    void confirmApplicationQuit(businessWindow ?? settingsWindow ?? failureWindow ?? null);
  });
}

function createBusinessWindow(businessSession: Session): void {
  const dark = desktopTheme === 'dark';
  businessWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'OPS Desktop',
    backgroundColor: dark ? '#201d2b' : '#f7f7f7',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: dark ? '#201d2b' : '#f7f7f7', symbolColor: dark ? '#f1edf8' : '#6a6078', height: 38 },
    autoHideMenuBar: true,
    webPreferences: {
      session: businessSession,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      devTools: !app.isPackaged
    }
  });

  const currentWindow = businessWindow;
  currentWindow.webContents.on('did-finish-load', () => {
    applyDesktopThemeToWindow(currentWindow, desktopTheme);
    applyDesktopMotionToWindow(currentWindow, desktopReducedMotion);
  });
  currentWindow.webContents.setWindowOpenHandler(({ url, disposition }) => {
    const intent = parseDesktopUiIntent(url);
    if (intent) {
      applyDesktopUiIntent(currentWindow, intent);
      return { action: 'deny' };
    }
    if (isExternalPopupDisposition(disposition) && isSafeExternalUrl(url)) {
      void confirmAndOpenExternal(url);
    }
    return { action: 'deny' };
  });

  currentWindow.webContents.on('will-navigate', (event, url) => {
    if (accountDataClearInProgress) {
      event.preventDefault();
      return;
    }
    if (isBusinessUrl(url)) return;
    event.preventDefault();

    const intent = parseDesktopUiIntent(url);
    if (intent) {
      applyDesktopUiIntent(currentWindow, intent);
      return;
    }

    if (isSafeExternalUrl(url)) {
      void confirmAndOpenExternal(url);
    }
  });

  currentWindow.webContents.on('will-frame-navigate', (details) => {
    if (isBusinessUrl(details.url)) return;
    details.preventDefault();
    if (details.isMainFrame && isSafeExternalUrl(details.url)) {
      void confirmAndOpenExternal(details.url);
    }
  });

  currentWindow.webContents.on('will-redirect', (details) => {
    if (!isBusinessUrl(details.url)) details.preventDefault();
  });

  currentWindow.webContents.on('did-navigate', (_event, url) => {
    void updateNativeClientStatus();
  });

  let mainFrameLoadFailed = false;
  currentWindow.webContents.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
    if (isMainFrame) {
      clearBusinessLoadTimeout();
      mainFrameLoadFailed = false;
      businessFailureReason = 'unreachable';
      businessLoadTimeout = setTimeout(() => {
        if (currentWindow.isDestroyed() || !currentWindow.webContents.isLoadingMainFrame()) return;
        businessFailureReason = 'unreachable';
        currentWindow.hide();
        showFailureWindow();
      }, 15_000);
    }
  });

  currentWindow.webContents.on('did-fail-load', (_event, errorCode, _description, _url, isMainFrame) => {
    if (!isMainFrame) return;
    clearBusinessLoadTimeout();
    if (errorCode === -3) return;
    mainFrameLoadFailed = true;
    businessFailureReason = 'unreachable';
    currentWindow.hide();
    showFailureWindow();
  });

  currentWindow.webContents.on('did-finish-load', () => {
    clearBusinessLoadTimeout();
    if (currentWindow.isDestroyed() || mainFrameLoadFailed || !isBusinessUrl(currentWindow.webContents.getURL())) return;
    setTimeout(() => {
      if (currentWindow.isDestroyed() || mainFrameLoadFailed || !isBusinessUrl(currentWindow.webContents.getURL())) return;
      // 渲染进程主线程无响应时 executeJavaScript 永不 settle，窗口会一直保持 show:false。
      // 用超时兜底，把「静默白屏」变成可见的失败窗口。
      const check = currentWindow.webContents.executeJavaScript(
        '(() => { const root = document.getElementById("root"); return { title: document.title || "", text: document.body?.innerText || "", rootChildren: root?.childElementCount ?? 0 }; })()'
      );
      let guardTimer: NodeJS.Timeout | undefined;
      const guard = new Promise<never>((_resolve, reject) => {
        guardTimer = setTimeout(() => reject(new Error('render-check-timeout')), 6_000);
      });
      void Promise.race([check, guard]).then((result) => {
        if (guardTimer) clearTimeout(guardTimer);
        const { title, text, rootChildren } = result as { title: string; text: string; rootChildren: number };
        if (currentWindow.isDestroyed()
          || mainFrameLoadFailed
          || !isBusinessUrl(currentWindow.webContents.getURL())) return;
        if (isIcpBlockingPage(title, text)) {
          businessFailureReason = 'icp-block';
          currentWindow.hide();
          showFailureWindow();
          return;
        }
        if (rootChildren === 0 && text.trim().length === 0) {
          businessFailureReason = 'render-failed';
          currentWindow.hide();
          showFailureWindow();
          return;
        }
        closeFailureWindow();
        currentWindow.show();
        currentWindow.focus();
      }).catch(() => {
        if (guardTimer) clearTimeout(guardTimer);
        if (currentWindow.isDestroyed() || mainFrameLoadFailed || !isBusinessUrl(currentWindow.webContents.getURL())) return;
        businessFailureReason = 'render-failed';
        currentWindow.hide();
        showFailureWindow();
      });
    }, 2500);
  });

  // 兜底：窗口创建后 20s 仍未显示（沙箱/GPU 导致渲染进程起不来，连 did-finish-load 都不触发）
  // 就显示失败窗口，而不是让用户面对「什么都没有」。
  const renderFallback = setTimeout(() => {
    if (currentWindow.isDestroyed() || currentWindow.isVisible()) return;
    businessFailureReason = 'render-failed';
    showFailureWindow();
  }, 20_000);

  currentWindow.on('closed', () => {
    clearBusinessLoadTimeout();
    clearTimeout(renderFallback);
    businessWindow = null;
  });

  currentWindow.on('close', (event) => {
    if (quitConfirmed) return;
    event.preventDefault();
    void confirmApplicationQuit(currentWindow);
  });
}

function installBusinessPermissions(businessSession: Session): void {
  businessSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
    return permission === 'clipboard-sanitized-write'
      && requestingOrigin === businessOrigin
      && details.isMainFrame;
  });

  businessSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    const allow = permission === 'clipboard-sanitized-write'
      && details.requestingUrl.startsWith(businessOrigin)
      && details.isMainFrame;
    callback(allow);
  });
}

function installDesktopRequestContext(businessSession: Session): void {
  const filter = { urls: ['<all_urls>'] };
  businessSession.webRequest.onBeforeRequest(filter, (details, callback) => {
    const requestWindow = businessWindow;
    const isBusinessWindow = Boolean(requestWindow && !requestWindow.isDestroyed()
      && details.webContentsId === requestWindow.webContents.id);
    if (!isBusinessApiUrl(details.url, businessOrigin)) {
      callback({});
      return;
    }

    if (isWorkspaceContextChangeRequest(details.url, details.method)) {
      contextMutationRequests.add(details.id);
    }

    const trusted = isBusinessWindow && isTrustedBusinessMainFrame(details, requestWindow!);
    const routing = desktopClient?.getRequestRoutingState();
    const ready = Boolean(routing?.requestContext.deviceId
      && routing.requestContext.routeRevision && routing.requestContext.routeRevision > 0
      && !routingRefreshPending);
    const previousProvenance = requestProvenance.get(details.id);
    requestProvenance.set(details.id, previousProvenance === 'redirected'
      ? 'redirected'
      : trusted ? 'trusted' : 'untrusted');
    if (shouldBlockDesktopApiRequest({
      requestUrl: details.url,
      method: details.method,
      businessOrigin,
      isBusinessWindow: true,
      trustedBusinessMainFrame: trusted && previousProvenance !== 'redirected',
      requestContextReady: ready,
      mode: routing?.mode ?? 'server',
      forceBlock: routingRefreshPending
    })) {
      callback({ cancel: true });
      return;
    }
    callback({});
  });

  businessSession.webRequest.onBeforeRedirect(filter, (details) => {
    if (requestProvenance.has(details.id)) requestProvenance.set(details.id, 'redirected');
  });

  businessSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    const isBusinessWindow = Boolean(businessWindow && !businessWindow.isDestroyed()
      && details.webContentsId === businessWindow.webContents.id);
    const provenance = requestProvenance.get(details.id);
    const trusted = isBusinessWindow && provenance === 'trusted'
      && isTrustedBusinessMainFrame(details, businessWindow!);
    const markerEntry = Object.entries(details.requestHeaders)
      .find(([name]) => isManagementRequestMarker(name));
    const isManagementRequest = Boolean(markerEntry && desktopClient?.consumeManagementRequestMarker(
      markerEntry[1], details.url, details.method
    ));
    const routing = desktopClient?.getRequestRoutingState();
    const requestHeaders = buildDesktopRequestHeaders({
      requestUrl: details.url,
      businessOrigin,
      trustedBusinessMainFrame: isManagementRequest ? false : trusted,
      mode: isManagementRequest ? 'server' : isBusinessWindow ? routing?.mode ?? 'server' : 'server',
      requestContext: isManagementRequest || !isBusinessWindow ? {} : routing?.requestContext ?? {},
      requestHeaders: details.requestHeaders
    });
    if (isManagementRequest) {
      for (const name of [
        'X-OPS-Desktop-Device',
        'X-OPS-Desktop-Connection',
        'X-OPS-Desktop-Policy',
        'X-OPS-Desktop-Challenge',
        'X-OPS-Desktop-Signature'
      ]) {
        const header = Object.entries(details.requestHeaders).find(([key]) => key.toLowerCase() === name.toLowerCase());
        if (header) requestHeaders[name] = header[1];
      }
    }
    callback({
      requestHeaders
    });
  });

  const finishRequest = (details: { id: number }) => {
    requestProvenance.delete(details.id);
    if (!contextMutationRequests.delete(details.id)) return;
    void refreshDesktopRequestContext();
  };
  businessSession.webRequest.onCompleted(filter, finishRequest);
  businessSession.webRequest.onErrorOccurred(filter, finishRequest);

  businessSession.cookies.on('changed', (_event, cookie) => {
    const host = new URL(businessOrigin).hostname;
    const cookieDomain = (cookie.domain ?? '').replace(/^\./, '');
    if (cookie.name === 'ops_session' && (host === cookieDomain || host.endsWith(`.${cookieDomain}`))) {
      if (!accountDataClearInProgress) void refreshDesktopRequestContext();
    }
  });
}

function isWorkspaceContextChangeRequest(requestUrl: string, method: string): boolean {
  if (method !== 'POST') return false;
  let pathname: string;
  try {
    pathname = new URL(requestUrl).pathname;
  } catch {
    return false;
  }
  return pathname === '/api/v1/workspaces'
    || pathname === '/api/v1/workspaces/join'
    || pathname === '/api/v1/workspaces/current/leave'
    || /^\/api\/v1\/workspaces\/[^/]+\/switch$/.test(pathname)
    || /^\/api\/v1\/admin\/workspaces\/[^/]+\/enter$/.test(pathname)
    || pathname === '/api/v1/admin/workspaces/exit';
}

function refreshDesktopRequestContext(): Promise<void> {
  if (accountDataClearInProgress) return Promise.resolve();
  if (routingRefresh) return routingRefresh;
  if (!desktopClient) return Promise.resolve();
  routingRefreshPending = true;
  routingRefresh = desktopClient.restoreAppliedMode().then((mode) => {
    routingRefreshPending = mode === 'incompatible';
    void updateNativeClientStatus();
  }).catch(() => {
    routingRefreshPending = true;
  }).finally(() => {
    routingRefresh = null;
  });
  return routingRefresh;
}

function isTrustedBusinessMainFrame(
  details: { url: string; webContentsId?: number; frame?: Electron.WebFrameMain | null; initiatorOrigin?: string },
  window: BrowserWindow
): boolean {
  const frame = details.frame;
  return details.webContentsId === window.webContents.id
    && Boolean(frame && frame === window.webContents.mainFrame)
    && isBusinessUrl(details.url)
    && isBusinessUrl(frame!.url)
    && details.initiatorOrigin === businessOrigin;
}

function installDownloadHandling(businessSession: Session): void {
  businessSession.on('will-download', (event, item, contents) => {
    if (!businessWindow || contents !== businessWindow.webContents) {
      event.preventDefault();
      item.cancel();
      return;
    }

    const filename = path.basename(item.getFilename()).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
    item.setSaveDialogOptions({
      title: '保存下载文件',
      buttonLabel: '保存',
      defaultPath: filename || 'download'
    });

    item.once('done', (_downloadEvent, state) => {
      if (state !== 'interrupted') return;
      const options = {
        type: 'error' as const,
        title: '下载失败',
        message: '文件未能保存。请检查保存位置和磁盘空间后重试。'
      };
      if (businessWindow && !businessWindow.isDestroyed()) {
        void dialog.showMessageBox(businessWindow, options);
      } else {
        void dialog.showMessageBox(options);
      }
    });
  });
}

async function registerLocalProtocol(targetSession: Session): Promise<void> {
  await targetSession.protocol.handle('ops-desktop', async (request) => {
    let requestedPath: string;
    try {
      const requestUrl = new URL(request.url);
      if (requestUrl.hostname !== 'settings' || requestUrl.search || requestUrl.hash) {
        return new Response('Not found', { status: 404 });
      }
      requestedPath = decodeURIComponent(requestUrl.pathname);
    } catch {
      return new Response('Bad request', { status: 400 });
    }

    const asset = LOCAL_PAGES[requestedPath];
    if (!asset) return new Response('Not found', { status: 404 });

    const assetRoot = path.resolve(__dirname, '..', 'public', 'settings');
    const assetPath = path.resolve(assetRoot, asset.file);
    if (!assetPath.startsWith(`${assetRoot}${path.sep}`)) {
      return new Response('Not found', { status: 404 });
    }

    try {
      const body = await fs.readFile(assetPath);
      const responseBody = requestedPath === '/desktop-theme.js'
        ? Buffer.from(body.toString('utf8')
          .replace('__OPS_DESKTOP_THEME__', desktopTheme)
          .replace('__OPS_DESKTOP_REDUCED_MOTION__', desktopReducedMotion === null ? 'system' : String(desktopReducedMotion)), 'utf8')
        : body;
      return new Response(responseBody, {
        status: 200,
        headers: {
          'Content-Type': asset.contentType,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store'
        }
      });
    } catch {
      return new Response('Local page unavailable', { status: 404 });
    }
  });
}

function registerIpcHandlers(): void {
  ipcHandle('settings:get-info', async (event) => {
    assertTrustedLocalSender(event);
    const clientState = await desktopClient?.getPublicState();
    if (clientState) applyNativeClientStatus(clientState);
    return {
      appVersion: app.getVersion(),
      businessOrigin,
      connectionState: getConnectionState(),
      failureReason: businessFailureReason,
      aiStatus: clientState?.mode === 'desktop'
        ? `已应用此客户端 AI 模式；任务映射版本 ${clientState.routeRevision}。${clientState.channelState === 'ready' ? '本机通道已连接。' : '本机通道当前不可用。'}`
        : '当前使用服务器 AI 模式；本机模型配置不会影响线上任务。',
      clientState
    };
  });

  ipcHandle('settings:export-diagnostics', async (event) => {
    assertTrustedLocalSender(event);
    if (!desktopClient) throw new Error('客户端设置尚未初始化。');
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) throw new Error('设置窗口已关闭。');
    const state = await desktopClient.getPublicState();
    const report = {
      generated_at: new Date().toISOString(),
      app: {
        version: app.getVersion(),
        electron: process.versions.electron,
        node: process.versions.node,
        platform: os.platform(),
        architecture: os.arch()
      },
      service: businessOrigin,
      business_connection: getConnectionState(),
      client: {
        signed_in: state.signedIn,
        reauth_required: state.reauthRequired,
        secure_storage_available: state.storageAvailable,
        device_registered: state.deviceRegistered,
        model_count: state.modelCount,
        active_model_requests: state.activeModelRequests,
        channel_state: state.channelState,
        mode: state.mode,
        route_revision: state.routeRevision
      }
    };
    const { canceled, filePath } = await dialog.showSaveDialog(window, {
      title: '导出脱敏诊断信息',
      buttonLabel: '保存诊断文件',
      defaultPath: `ops-desktop-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (canceled || !filePath) return false;
    await fs.writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8' });
    return true;
  });

  ipcHandle('settings:get-models', (event) => {
    assertTrustedLocalSender(event);
    if (!desktopClient) throw new Error('客户端设置尚未初始化。');
    return desktopClient.listModels();
  });

  ipcHandle('settings:get-policy', (event) => {
    assertTrustedLocalSender(event);
    if (!desktopClient) throw new Error('客户端设置尚未初始化。');
    return desktopClient.getPolicy();
  });

  ipcHandle('settings:set-policy', (event, value) => {
    assertTrustedLocalSender(event);
    if (!desktopClient) throw new Error('客户端设置尚未初始化。');
    if (!value || typeof value !== 'object') throw new Error('工作区策略输入无效。');
    const input = value as Record<string, unknown>;
    if (typeof input.enabled !== 'boolean' || typeof input.allowMemberEndpoints !== 'boolean') {
      throw new Error('工作区策略字段无效。');
    }
    return desktopClient.updatePolicy(input.enabled, input.allowMemberEndpoints);
  });

  ipcHandle('settings:get-devices', (event) => {
    assertTrustedLocalSender(event);
    if (!desktopClient) throw new Error('客户端设置尚未初始化。');
    return desktopClient.listDevices();
  });

  ipcHandle('settings:revoke-device', (event, value) => {
    assertTrustedLocalSender(event);
    if (!desktopClient || !value || typeof value !== 'object') throw new Error('设备回收请求无效。');
    const input = value as Record<string, unknown>;
    if (typeof input.deviceId !== 'string' || typeof input.password !== 'string' || input.password.length > 1024) {
      throw new Error('设备回收字段无效。');
    }
    return desktopClient.revokeDevice(input.deviceId, input.password);
  });

  ipcHandle('settings:get-routes', async (event) => {
    assertTrustedLocalSender(event);
    if (!desktopClient) throw new Error('客户端设置尚未初始化。');
    const [routeTypes, serverModels, desktopRoutes, desktopModels] = await Promise.all([
      desktopClient.listRouteTypes(),
      desktopClient.listServerModels(),
      desktopClient.listDesktopRoutes(),
      desktopClient.listModels()
    ]);
    return { routeTypes, serverModels, desktopRoutes, desktopModels };
  });

  ipcHandle('settings:save-routes', (event, value) => {
    assertTrustedLocalSender(event);
    if (!desktopClient) throw new Error('客户端设置尚未初始化。');
    if (!value || typeof value !== 'object') throw new Error('任务映射输入无效。');
    const input = value as Record<string, unknown>;
    if (typeof input.expectedRevision !== 'number' || !Array.isArray(input.routes)) {
      throw new Error('任务映射版本或内容无效。');
    }
    return desktopClient.saveDesktopRoutes(
      input.routes.map(parseDesktopRoute), input.expectedRevision
    );
  });

  ipcHandle('settings:start-model-test', (event, value) => {
    assertTrustedLocalSender(event);
    if (!desktopClient) throw new Error('客户端设置尚未初始化。');
    if (!value || typeof value !== 'object') throw new Error('自检请求无效。');
    const input = value as Record<string, unknown>;
    if (typeof input.providerId !== 'string' || typeof input.model !== 'string') {
      throw new Error('请选择待自检的模型。');
    }
    return desktopClient.startModelTest(input.providerId, input.model);
  });

  ipcHandle('settings:get-model-test', (event, value) => {
    assertTrustedLocalSender(event);
    if (!desktopClient) throw new Error('客户端设置尚未初始化。');
    if (typeof value !== 'string' || value.length > 80) throw new Error('自检任务标识无效。');
    return desktopClient.getModelTest(value);
  });

  ipcHandle('settings:apply-mode', async (event, value) => {
    assertTrustedLocalSender(event);
    if (!desktopClient || (value !== 'server' && value !== 'desktop')) throw new Error('执行模式无效。');
    const clientState = await desktopClient.getPublicState();
    const { response } = await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender)!, {
      type: value === 'desktop' ? 'warning' : 'question',
      title: value === 'desktop' ? '启用此客户端 AI' : '切换到服务器 AI',
      message: '请先保存业务页面中的未提交内容。客户端无法检测编辑器是否有尚未保存的修改。',
      detail: value === 'desktop'
        ? `后续任务上下文仍经线上后端，并会发送到本机设置的 AI 端点。回环地址不代表数据不会离开本机。当前正在处理的本机模型调用：${clientState.activeModelRequests}。应用后将重新加载业务页面。`
        : `后续 AI 请求将使用工作区的线上服务器模型。当前正在处理的本机模型调用：${clientState.activeModelRequests}。应用后将重新加载业务页面。`,
      buttons: ['取消', '确认并重新加载'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    });
    if (response !== 1) return false;
    routingRefreshPending = true;
    try {
      await desktopClient.applyMode(value);
      const currentUrl = businessWindow && !businessWindow.isDestroyed()
        ? businessWindow.webContents.getURL()
        : '';
      if (isBusinessUrl(currentUrl)) await navigateBusiness(currentUrl);
      else await loadBusinessPage();
      routingRefreshPending = false;
      return true;
    } catch (error) {
      try {
        const restored = await desktopClient.restoreAppliedMode();
        routingRefreshPending = restored === 'incompatible';
      } catch {
        routingRefreshPending = true;
      }
      throw error;
    }
  });

  ipcHandle('settings:reauthenticate', (event, value) => {
    assertTrustedLocalSender(event);
    if (typeof value !== 'string' || value.length > 1024) throw new Error('密码输入无效。');
    if (!desktopClient) throw new Error('客户端设置尚未初始化。');
    return desktopClient.reauthenticate(value);
  });

  // D-123 / DEV-415：客户端设置页更换业务账号内容类型。确认框用系统原生对话框，
  // 与删除本机模型、清除账号数据等同级操作保持一致；跨平台一律拒绝（服务端同样拒绝）。
  ipcHandle('settings:get-accounts', (event) => {
    assertTrustedLocalSender(event);
    if (!desktopClient) throw new Error('客户端设置尚未初始化。');
    return desktopClient.listBusinessAccounts();
  });

  ipcHandle('settings:change-account-type', async (event, value) => {
    assertTrustedLocalSender(event);
    if (!desktopClient) throw new Error('客户端设置尚未初始化。');
    if (!value || typeof value !== 'object') throw new Error('更换内容类型请求无效。');
    const input = value as Record<string, unknown>;
    const accountId = typeof input.accountId === 'string' ? input.accountId : '';
    const contentFormat = typeof input.contentFormat === 'string' ? input.contentFormat : '';
    if (!/^[0-9a-f-]{36}$/i.test(accountId) || !/^[a-z_]{1,32}$/.test(contentFormat)) {
      throw new Error('账号或内容类型无效。');
    }
    const accounts = await desktopClient.listBusinessAccounts();
    const account = accounts.find((item) => item.id === accountId);
    if (!account) throw new Error('账号不存在或已删除，请刷新设置。');
    if (account.content_format === contentFormat) throw new Error('账号已经是该内容类型。');
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) throw new Error('设置窗口已关闭。');
    const works = await desktopClient.countBusinessWorks(accountId);
    // 对话框面向用户，显示中文类型名；逻辑校验仍用枚举值。
    const formatNames: Record<string, string> = {
      long_article: '长图文', qa_article: '问答体长图文', briefing: '资讯简报',
      card_post: '图文卡片', script: '口播脚本', comic: '漫画',
      image_note: '图文笔记', list_note: '清单合集笔记'
    };
    const fromLabel = formatNames[account.content_format] ?? account.content_format;
    const toLabel = formatNames[contentFormat] ?? contentFormat;
    const { response } = await dialog.showMessageBox(window, {
      type: 'warning',
      title: '更换账号内容类型',
      message: `把账号「${account.name}」的内容类型从「${fromLabel}」换成「${toLabel}」？`,
      detail: `已有 ${works} 篇作品保持原类型，检查、推送与打包行为完全不变；之后新建的作品将使用新类型。更换平台仍需在业务页面新建账号。`,
      buttons: ['取消', '确认更换'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    });
    if (response !== 1) throw new Error('已取消更换内容类型。');
    return desktopClient.changeAccountContentFormat({ accountId, contentFormat });
  });

  ipcHandle('settings:clear-account-data', async (event) => {
    assertTrustedLocalSender(event);
    if (!desktopClient || !businessSession) throw new Error('客户端设置尚未初始化。');
    const identity = await desktopClient.getCurrentAccountIdentity();
    const clientState = await desktopClient.getPublicState();
    if (!clientState.signedIn) throw new Error('请先登录要清理的 OPS 账号。');
    if (identity.username !== clientState.username) throw new Error('当前登录账号已变化，请刷新设置后重试。');
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) throw new Error('设置窗口已关闭。');
    const { response } = await dialog.showMessageBox(window, {
      type: 'warning',
      title: '清除此账号本机数据',
      message: `确定清除账号“${identity.username}”在此客户端上的数据并退出登录吗？`,
      detail: `将删除此账号的本机模型密钥、设备私钥、任务映射草稿和客户端模式，并清理当前业务站点的 Cookie、站点存储与缓存。当前未完成的本机模型调用：${clientState.activeModelRequests}；清理会断开 AI 通道并终止这些调用，模型端可能已经计费。此操作不会删除线上作品或账号数据，也不会撤销线上设备；设备撤销需单独操作。`,
      buttons: ['取消', '清除并退出'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    });
    if (response !== 1) return false;

    routingRefreshPending = true;
    accountDataClearInProgress = true;
    try {
      if (routingRefresh) await routingRefresh;
      routingRefreshPending = true;
      await desktopClient.clearCurrentAccountData(identity.userId);
      try {
        await businessSession.clearStorageData({ origin: businessOrigin });
        await businessSession.clearCache();
      } catch {
        throw new Error('该账号的本机 AI 配置已删除，但线上站点数据或缓存未能全部清理。请重试清理，或重新登录后再操作。');
      }
      await navigateBusiness(`${businessOrigin}/login`, true);
      routingRefreshPending = false;
      await dialog.showMessageBox(window, {
        type: 'info',
        title: '本机数据已清除',
        message: '此账号的本机配置和业务站点数据已清除。',
        detail: '重新打开业务页面后需要再次登录。',
        buttons: ['确定'],
        noLink: true
      });
      return true;
    } catch (error) {
      try {
        const restored = await desktopClient.restoreAppliedMode();
        routingRefreshPending = restored === 'incompatible';
      } catch {
        routingRefreshPending = true;
      }
      throw error;
    } finally {
      accountDataClearInProgress = false;
    }
  });

  ipcHandle('settings:save-model', (event, value) => {
    assertTrustedLocalSender(event);
    if (!desktopClient) throw new Error('客户端设置尚未初始化。');
    return desktopClient.saveModel(parseSaveModelInput(value));
  });

  ipcHandle('settings:delete-model', async (event, value) => {
    assertTrustedLocalSender(event);
    if (!desktopClient || !value || typeof value !== 'object') throw new Error('模型删除请求无效。');
    const input = value as Record<string, unknown>;
    if (typeof input.providerId !== 'string' || !/^[0-9a-f-]{36}$/i.test(input.providerId)
      || typeof input.configRevision !== 'number' || !Number.isSafeInteger(input.configRevision)) {
      throw new Error('模型删除字段无效。');
    }
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) throw new Error('设置窗口已关闭。');
    const { response } = await dialog.showMessageBox(window, {
      type: 'warning',
      title: '删除本机模型配置',
      message: '确定停用并移除此本机模型配置吗？',
      detail: '服务端会移除此模型的任务映射并断开客户端 AI 通道；历史记录保留。',
      buttons: ['取消', '停用并移除'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    });
    if (response !== 1) return null;
    return desktopClient.deleteModel(input.providerId, input.configRevision);
  });

  ipcHandle('settings:connect-ai', (event) => {
    assertTrustedLocalSender(event);
    if (!desktopClient) throw new Error('客户端设置尚未初始化。');
    return desktopClient.connect();
  });

  ipcHandle('settings:disconnect-ai', (event) => {
    assertTrustedLocalSender(event);
    desktopClient?.disconnect();
  });

  ipcHandle('settings:retry-business-page', (event) => {
    assertTrustedLocalSender(event);
    return loadBusinessPage();
  });

  ipcHandle('settings:open-login-page', (event) => {
    assertTrustedLocalSender(event);
    return navigateBusiness(`${businessOrigin}/login`);
  });

  ipcHandle('settings:open-settings', (event) => {
    assertTrustedLocalSender(event);
    showSettingsWindow();
  });

  ipcHandle('settings:close-local-window', (event) => {
    assertTrustedLocalSender(event);
    const localWindow = BrowserWindow.fromWebContents(event.sender);
    localWindow?.close();
  });

  // 平台采集的本机命令（20 文档 §11.4）。主进程代办与 OPS 的认证请求和上传；
  // 工作进程不接收 OPS Cookie、密码、设备私钥或任意服务器 URL。
  ipcHandle('settings:platform-command', async (event, raw) => {
    assertTrustedLocalSender(event);
    return runPlatformCommand(raw);
  });

  // 浏览器探测单独一条通道：拉起浏览器比其它本机命令慢，不能共用 5 秒超时。
  ipcHandle('settings:platform-browser', async (event, raw) => {
    assertTrustedLocalSender(event);
    const force = raw !== null && typeof raw === 'object' && (raw as { refresh?: unknown }).refresh === true;
    return readPlatformBrowserStatus(force);
  });
}

// 平台命令的单一执行入口：先校验信封、命令白名单与参数形状，再单飞执行；
// 所有失败都压成稳定错误码与安全文案，不回传路径、堆栈或原始平台响应。
const platformIPC = new PlatformIPCSingleFlight();

async function runPlatformCommand(raw: unknown): Promise<{ ok: true; data?: unknown } | { ok: false; error: PlatformIPCError }> {
  try {
    const envelope = parseEnvelope(raw);
    validatePayloadShape(envelope.cmd, envelope.payload);
    platformIPC.begin(envelope.cmd);
    try {
      const data = await withTimeout(executePlatformCommand(envelope));
      return { ok: true, data };
    } finally {
      platformIPC.end(envelope.cmd);
    }
  } catch (error) {
    return { ok: false, error: toIPCError(error) };
  }
}

async function executePlatformCommand(envelope: PlatformIPCEnvelope): Promise<unknown> {
  switch (envelope.cmd) {
    case 'read-status': {
      // 只回报能力摘要与浏览器探测结论，不含本机路径或会话内容。
      const capability = await desktopClient?.getPlatformCollectionCapability();
      const browser = await readPlatformBrowserStatus();
      return {
        supported: capability ? capability.enabled : false,
        protocolVersion: capability?.protocol_version ?? null,
        platforms: capability?.platforms ?? [],
        browser
      };
    }
    case 'open-login': {
      const payload = envelope.payload as { accountId: string; platform: PlatformLoginPlatform };
      return openPlatformLogin(payload.accountId, payload.platform);
    }
    case 'request-collect':
    case 'pause':
    case 'clear-account-data':
      // 这三条命令的具体实现依赖 PS05/06 适配器与连接生命周期；
      // 现在返回稳定错误码，避免页面以为操作已生效。
      return { performed: false, errorCode: 'platform_client_required' };
    default:
      throw new PlatformIPCErrorException('ipc_unknown_command', '不支持的本机命令');
  }
}

// ---------- 本机平台登录（DEV-PS13 / 20 文档 §4.1、§5.1） ----------
//
// 一次登录会话的生命周期：建/复用连接命名空间 profile → 启动本机浏览器 →
// 打开官方后台 → 等用户本人扫码 → 页面内固定只读请求读回身份 → 建连接并验证 → 关浏览器。
// 浏览器与 profile 只在本次会话内存在，会话结束后不保留任何登录凭据到 OPS 侧。

// 同意说明版本：内容变更时递增，服务端据此要求重新确认（§4.1 步骤 3）。
const PLATFORM_CONSENT_VERSION = 1;

// 同一时刻只允许一个登录会话：一个浏览器、一个 profile，避免双开争用同一目录。
let activeLogin: { accountId: string; platform: PlatformLoginPlatform } | null = null;

interface PlatformLoginOutcome {
  opened: true;
  connected: boolean;
  externalAccountKey: string | null;
  connectionId: string | null;
  displayName: string | null;
  timedOut: boolean;
  attempts: number;
}

async function openPlatformLogin(accountId: string, platform: PlatformLoginPlatform): Promise<PlatformLoginOutcome> {
  if (!desktopClient) throw new Error('客户端设置尚未初始化。');
  if (activeLogin) {
    // 已有会话在跑：明确拒绝，不静默顶掉另一个正在扫码的窗口。
    throw new PlatformBrowserError('platform_profile_busy', '另一个平台登录正在进行，请先完成或关闭它');
  }
  activeLogin = { accountId, platform };
  let session: PlatformLoginSession | null = null;
  try {
    const auth = await desktopClient.getAuthContext();
    const candidate = await findPlatformBrowser();
    // profile 按「登录用户 / 平台 / 连接」隔离；首版一次登录对应一个待验证连接，
    // 连接 ID 在服务端建好后才存在，因此这里先用账号维度的一次性命名空间，
    // 登录成功后由服务端返回的连接 ID 接管后续采集会话（见 D-129 的 PS13 口径）。
    const profileDir = connectionProfileDir(await app.getPath('userData'), {
      userId: auth.userId,
      platform,
      connectionId: auth.connectionNamespaceId
    });
    await fs.mkdir(path.dirname(profileDir), { recursive: true });
    await fs.writeFile(profileMetaPath(profileDir), JSON.stringify(buildProfileMeta({
      origin: businessOrigin,
      userId: auth.userId,
      workspaceId: auth.workspaceId,
      deviceId: auth.deviceId,
      platform,
      connectionId: auth.connectionNamespaceId,
      externalAccountKey: ''
    }), null, 2), { encoding: 'utf8', mode: 0o600 });

    const browser = await launchPlatformBrowser({ executablePath: candidate.executablePath, profileDir });
    const cdp = createCDPClient(browser, 20_000);
    session = { platform, profileDir, browser, cdp };
    try {
      await openLoginPage(session);
      const outcome = await waitForLogin(session);
      if (!outcome.loggedIn || !outcome.payload) {
        return {
          opened: true,
          connected: false,
          externalAccountKey: null,
          connectionId: null,
          displayName: null,
          timedOut: outcome.timedOut,
          attempts: outcome.attempts
        };
      }
      // 身份解析用 PS05/06 已有的适配器，不在这里另写一套字段提取。
      // 两个平台的 identity 形状不同，分开走各自的 probe，不做联合类型收窄。
      const parsed = JSON.parse(outcome.payload);
      const now = new Date().toISOString();
      let externalAccountKey: string;
      let displayName: string | null;
      let capabilities: Record<string, unknown>;
      if (platform === 'xhs') {
        const identity = parseXhsIdentity(parsed);
        externalAccountKey = identity.externalAccountKey;
        displayName = identity.redId || null;
        capabilities = probeXhsCapabilities({
          mainSiteLoggedIn: true,
          identity,
          postedNotesReadable: true,
          followerInfoReadable: true,
          now
        }) as unknown as Record<string, unknown>;
      } else {
        const identity = parseWechatIdentity(parsed);
        externalAccountKey = identity.externalAccountKey;
        displayName = identity.originalID || null;
        capabilities = probeWechatCapabilities({
          backendLoggedIn: true,
          identity,
          listReadable: true,
          now
        }) as unknown as Record<string, unknown>;
      }
      const created = await desktopClient.createPlatformConnection({
        accountId,
        externalAccountKey,
        consentVersion: PLATFORM_CONSENT_VERSION
      });
      const connectionId = typeof created.id === 'string' ? created.id : null;
      if (connectionId) {
        await desktopClient.verifyPlatformConnection({
          connectionId,
          externalAccountKey,
          capabilities
        });
      }
      return {
        opened: true,
        connected: true,
        externalAccountKey,
        connectionId,
        displayName,
        timedOut: false,
        attempts: outcome.attempts
      };
    } finally {
      await cdp.close();
    }
  } finally {
    activeLogin = null;
    session = null;
  }
}

// 浏览器探测结论只在主进程缓存：一次会话里浏览器不会中途换，重复探测只会反复拉起进程。
// 缓存的是结论而不是候选路径，对外结构里不出现任何本机路径。
interface PlatformBrowserStatus {
  state: 'ready' | 'unsupported' | 'launch_failed'
  family: string | null
  name: string | null
  version: string | null
  major: number | null
  errorCode: string | null
  checkedAt: string
}

let platformBrowserStatus: PlatformBrowserStatus | null = null;
let platformBrowserProbe: Promise<PlatformBrowserStatus> | null = null;

async function readPlatformBrowserStatus(force = false): Promise<PlatformBrowserStatus> {
  if (!force && platformBrowserStatus) return platformBrowserStatus;
  if (!force && platformBrowserProbe) return platformBrowserProbe;
  platformBrowserProbe = probePlatformBrowserOnce().finally(() => {
    platformBrowserProbe = null;
  });
  return platformBrowserProbe;
}

async function probePlatformBrowserOnce(): Promise<PlatformBrowserStatus> {
  const checkedAt = new Date().toISOString();
  try {
    const candidate = await findPlatformBrowser();
    // 用一次性临时 profile 探测，不碰任何真实连接的会话目录。
    const probeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ops-platform-probe-'));
    try {
      const probe = await probePlatformBrowser({ candidate, profileDir: probeDir });
      platformBrowserStatus = {
        state: 'ready',
        family: probe.family,
        name: probe.name,
        version: probe.version,
        major: probe.major,
        errorCode: null,
        checkedAt
      };
    } finally {
      await fs.rm(probeDir, { recursive: true, force: true }).catch(() => undefined);
    }
  } catch (error) {
    const code = error instanceof PlatformBrowserError ? error.code : 'platform_browser_launch_failed';
    platformBrowserStatus = {
      state: code === 'platform_browser_unsupported' ? 'unsupported' : 'launch_failed',
      family: null,
      name: null,
      version: null,
      major: null,
      errorCode: code,
      checkedAt
    };
  }
  return platformBrowserStatus;
}

function ipcHandle<T>(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => T | Promise<T>
): void {
  ipcMain.handle(channel, (event, ...args) => handler(event, ...args));
}

function parseSaveModelInput(value: unknown): SaveModelInput {
  if (!value || typeof value !== 'object') throw new Error('模型配置输入无效。');
  const input = value as Record<string, unknown>;
  if (typeof input.name !== 'string' || typeof input.baseUrl !== 'string'
    || !Array.isArray(input.models) || input.models.some((model) => typeof model !== 'string')
    || typeof input.apiKey !== 'string' || input.apiKey.length > 4096) {
    throw new Error('模型配置字段无效。');
  }
  if (input.allowedImageHosts !== undefined
    && (!Array.isArray(input.allowedImageHosts) || input.allowedImageHosts.some((host) => typeof host !== 'string'))) {
    throw new Error('图片 CDN 域名配置无效。');
  }
  if (input.providerId !== undefined && typeof input.providerId !== 'string') {
    throw new Error('模型配置标识无效。');
  }
  if (input.configRevision !== undefined && typeof input.configRevision !== 'number') {
    throw new Error('模型配置版本无效。');
  }
  if (input.proxyMode !== undefined && !['system', 'manual', 'direct'].includes(String(input.proxyMode))) {
    throw new Error('代理模式无效。');
  }
  for (const key of ['proxyUrl', 'proxyUsername', 'proxyPassword']) {
    if (input[key] !== undefined && (typeof input[key] !== 'string' || (input[key] as string).length > 4096)) {
      throw new Error('代理配置字段无效。');
    }
  }
  return {
    providerId: input.providerId as string | undefined,
    configRevision: input.configRevision as number | undefined,
    name: input.name,
    baseUrl: input.baseUrl,
    models: input.models as string[],
    apiKey: input.apiKey,
    allowedImageHosts: input.allowedImageHosts as string[] | undefined,
    proxyMode: input.proxyMode as SaveModelInput['proxyMode'],
    proxyUrl: input.proxyUrl as string | undefined,
    proxyUsername: input.proxyUsername as string | undefined,
    proxyPassword: input.proxyPassword as string | undefined
  };
}

function parseDesktopRoute(value: unknown): DesktopRoute {
  if (!value || typeof value !== 'object') throw new Error('任务映射字段无效。');
  const route = value as Record<string, unknown>;
  if (typeof route.task_type !== 'string'
    || !['desktop', 'server', 'disabled'].includes(String(route.execution_location))
    || (route.provider_id !== null && typeof route.provider_id !== 'string')
    || typeof route.model !== 'string'
    || (route.fallback_provider_id !== null && typeof route.fallback_provider_id !== 'string')
    || typeof route.fallback_model !== 'string') {
    throw new Error('任务映射字段无效。');
  }
  return {
    task_type: route.task_type,
    execution_location: route.execution_location as DesktopRoute['execution_location'],
    provider_id: route.provider_id as string | null,
    model: route.model,
    fallback_provider_id: route.fallback_provider_id as string | null,
    fallback_model: route.fallback_model
  };
}

function assertTrustedLocalSender(event: IpcMainInvokeEvent): void {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (!senderWindow || !localWindows.has(senderWindow.id) || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('不允许此窗口调用本地接口。');
  }

  let senderUrl: URL;
  try {
    senderUrl = new URL(event.senderFrame.url);
  } catch {
    throw new Error('不允许此页面调用本地接口。');
  }

  if (senderUrl.protocol !== 'ops-desktop:'
    || senderUrl.hostname !== 'settings'
    || senderUrl.username
    || senderUrl.password
    || senderUrl.port
    || senderUrl.search
    || senderUrl.hash
    || !['/', '/offline/'].includes(senderUrl.pathname)) {
    throw new Error('不允许此页面调用本地接口。');
  }
}

function showSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }

  settingsWindow = createLocalWindow('OPS Desktop 设置', 'ops-desktop://settings/');
  const currentWindow = settingsWindow;
  currentWindow.on('closed', () => {
    localWindows.delete(currentWindow.id);
    settingsWindow = null;
  });
}

function showFailureWindow(): void {
  if (failureWindow && !failureWindow.isDestroyed()) {
    failureWindow.show();
    failureWindow.focus();
    return;
  }

  failureWindow = createLocalWindow('OPS Desktop — 无法连接', 'ops-desktop://settings/offline/');
  const currentWindow = failureWindow;
  currentWindow.on('closed', () => {
    localWindows.delete(currentWindow.id);
    failureWindow = null;
  });
}

function createLocalWindow(title: string, url: string): BrowserWindow {
  const dark = desktopTheme === 'dark';
  const window = new BrowserWindow({
    width: 1080,
    height: 850,
    minWidth: 760,
    minHeight: 640,
    title,
    autoHideMenuBar: true,
    backgroundColor: dark ? '#201d2b' : '#f7f7f7',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: dark ? '#201d2b' : '#f7f7f7', symbolColor: dark ? '#f1edf8' : '#6a6078', height: 38 },
    webPreferences: {
      session: session.fromPartition('ops-settings'),
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      devTools: !app.isPackaged
    }
  });

  localWindows.add(window.id);
  window.webContents.on('did-finish-load', () => {
    applyDesktopThemeToWindow(window, desktopTheme);
    applyDesktopMotionToWindow(window, desktopReducedMotion);
  });
  window.on('close', (event) => {
    if (quitConfirmed || BrowserWindow.getAllWindows().some((other) => other !== window && !other.isDestroyed())) return;
    event.preventDefault();
    void confirmApplicationQuit(window);
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    const intent = parseDesktopUiIntent(url);
    if (intent) applyDesktopUiIntent(window, intent);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, nextUrl) => {
    const intent = parseDesktopUiIntent(nextUrl);
    if (intent) {
      event.preventDefault();
      applyDesktopUiIntent(window, intent);
      return;
    }
    if (!nextUrl.startsWith(`${SETTINGS_PROTOCOL_ORIGIN}/`)) event.preventDefault();
  });
  window.webContents.on('will-frame-navigate', (details) => {
    if (!details.url.startsWith(`${SETTINGS_PROTOCOL_ORIGIN}/`)) details.preventDefault();
  });

  void window.loadURL(url).catch(() => {
    if (!window.isDestroyed()) window.close();
  });
  return window;
}

async function restoreDesktopTheme(): Promise<'light' | 'dark'> {
  try {
    const stored = (await fs.readFile(path.join(app.getPath('userData'), 'desktop-ui-theme'), 'utf8')).trim();
    return stored === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

async function restoreDesktopMotion(): Promise<boolean | null> {
  try {
    const value = (await fs.readFile(path.join(app.getPath('userData'), 'desktop-ui-motion'), 'utf8')).trim();
    return value === 'reduce' ? true : value === 'soft' ? false : null;
  } catch {
    return null;
  }
}

function closeFailureWindow(): void {
  if (failureWindow && !failureWindow.isDestroyed()) failureWindow.close();
}

function applyDesktopUiIntent(window: BrowserWindow, intent: DesktopUiIntent): void {
  if (intent.type === 'settings') {
    showSettingsWindow();
    return;
  }

  if (intent.type === 'theme') {
    desktopTheme = intent.theme;
    nativeTheme.themeSource = intent.theme;
    void fs.writeFile(path.join(app.getPath('userData'), 'desktop-ui-theme'), desktopTheme, 'utf8').catch(() => undefined);
    const dark = intent.theme === 'dark';
    for (const target of BrowserWindow.getAllWindows()) {
      target.setTitleBarOverlay({
        color: dark ? '#201d2b' : '#f7f7f7',
        symbolColor: dark ? '#f1edf8' : '#6a6078',
        height: 38
      });
      applyDesktopThemeToWindow(target, intent.theme);
    }
    return;
  }

  if (intent.type === 'motion') {
    desktopReducedMotion = intent.reduced;
    void fs.writeFile(path.join(app.getPath('userData'), 'desktop-ui-motion'), intent.reduced ? 'reduce' : 'soft', 'utf8').catch(() => undefined);
    for (const target of BrowserWindow.getAllWindows()) applyDesktopMotionToWindow(target, desktopReducedMotion);
    return;
  }

  const ids = {
    client: 'ops-app-menu-client',
    edit: 'ops-app-menu-edit',
    view: 'ops-app-menu-view'
  } as const;
  const item = Menu.getApplicationMenu()?.getMenuItemById(ids[intent.menu]);
  item?.submenu?.popup({ window });
}

function applyDesktopMotionToWindow(window: BrowserWindow, reduced: boolean | null): void {
  if (reduced === null) return;
  if (window.isDestroyed() || window.webContents.isDestroyed()) return;
  const value = reduced ? 'true' : 'false';
  void window.webContents.executeJavaScript(`(() => {
    const root = document.documentElement;
    if (root.dataset.presentation !== 'ops-creative-desktop') return;
    root.dataset.reducedMotion = '${value}';
    try { localStorage.setItem('ops-desktop-motion', '${reduced ? 'reduce' : 'soft'}'); } catch {}
    window.dispatchEvent(new CustomEvent('ops:desktop-motion', { detail: ${value} }));
  })()`).catch(() => undefined);
}

function applyDesktopThemeToWindow(window: BrowserWindow, theme: 'light' | 'dark'): void {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return;
  void window.webContents.executeJavaScript(`(() => {
    const root = document.documentElement;
    if (root.dataset.presentation !== 'ops-creative-desktop') return;
    root.dataset.theme = '${theme}';
    try { localStorage.setItem('ops-desktop-theme', '${theme}'); } catch {}
    window.dispatchEvent(new CustomEvent('ops:desktop-theme', { detail: '${theme}' }));
  })()`).catch(() => undefined);
}

function clearBusinessLoadTimeout(): void {
  if (!businessLoadTimeout) return;
  clearTimeout(businessLoadTimeout);
  businessLoadTimeout = null;
}

async function loadBusinessPage(): Promise<void> {
  if (!businessWindow || businessWindow.isDestroyed()) {
    if (!businessSession) {
      businessSession = session.fromPartition(businessPartition);
    }
    createBusinessWindow(businessSession);
  }
  await navigateBusiness(businessOrigin);
}

async function navigateBusiness(url: string, allowDuringAccountDataClear = false): Promise<void> {
  if (accountDataClearInProgress && !allowDuringAccountDataClear) {
    throw new Error('账号本机数据清理期间，暂不能切换业务页面。');
  }
  if (!isBusinessUrl(url)) throw new Error('业务页面地址不在允许的站点内。');
  if (!businessWindow || businessWindow.isDestroyed()) return;

  try {
    await businessWindow.loadURL(url);
  } catch {
    businessWindow.hide();
    showFailureWindow();
  }
}

function getConnectionState(): 'online' | 'offline' | 'unknown' {
  if (failureWindow && !failureWindow.isDestroyed()) return 'offline';
  if (businessWindow && !businessWindow.isDestroyed() && businessWindow.webContents.getURL()) return 'online';
  return 'unknown';
}

function isBusinessUrl(value: string): boolean {
  try {
    return new URL(value).origin === businessOrigin;
  } catch {
    return false;
  }
}

function isIcpBlockingPage(title: string, text: string): boolean {
  const content = `${title}\n${text}`;
  return /non-compliance\s+icp\s+filing/i.test(content)
    || /未完成备案|备案拦截/.test(content);
}

function isSafeExternalUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function isExternalPopupDisposition(disposition: string): boolean {
  return ['foreground-tab', 'background-tab', 'new-window'].includes(disposition);
}

async function confirmAndOpenExternal(value: string): Promise<void> {
  if (externalPromptOpen || !businessWindow || businessWindow.isDestroyed()) return;
  externalPromptOpen = true;
  try {
    const hostname = new URL(value).hostname;
    const { response } = await dialog.showMessageBox(businessWindow, {
      type: 'question',
      title: '打开外部链接',
      message: `是否在系统浏览器中打开 ${hostname}？`,
      buttons: ['打开', '取消'],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    });
    if (response === 0) await openExternalUrl(value);
  } finally {
    externalPromptOpen = false;
  }
}

async function openExternalUrl(value: string): Promise<void> {
  if (!isSafeExternalUrl(value)) return;
  try {
    await shell.openExternal(value);
  } catch {
    await dialog.showMessageBox({
      type: 'error',
      title: '无法打开链接',
      message: '系统浏览器未能打开此链接。'
    });
  }
}

async function confirmApplicationQuit(parent: BrowserWindow | null): Promise<void> {
  if (quitDialogOpen || quitConfirmed) return;
  quitDialogOpen = true;
  const previousRoutingRefreshPending = routingRefreshPending;
  routingRefreshPending = true;
  try {
    const activeRequests = desktopClient?.getActiveModelRequestCount() ?? 0;
    const options: Electron.MessageBoxOptions = {
      type: 'warning',
      title: '退出 OPS Desktop',
      message: '确定退出 OPS Desktop 吗？',
      detail: `请先保存业务页面中尚未提交的内容；客户端无法判断编辑器是否有未保存修改。当前有 ${activeRequests} 条本机模型调用正在进行。退出会终止这些调用，模型服务可能已经计费；客户端不会自动重发。`,
      buttons: ['继续使用', '退出客户端'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    };
    const { response } = parent && !parent.isDestroyed()
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options);
    if (response !== 1) return;
    quitConfirmed = true;
    desktopClient?.disconnect();
    app.quit();
  } finally {
    if (!quitConfirmed) routingRefreshPending = previousRoutingRefreshPending;
    quitDialogOpen = false;
  }
}

function installApplicationMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      id: 'ops-app-menu-client',
      label: '客户端',
      submenu: [
        { id: 'ops-native-client-status', label: '工作区：读取中 · 模式：读取中', enabled: false },
        { type: 'separator' },
        { label: 'AI 连接设置…', click: showSettingsWindow },
        { label: '重新登录…', click: () => void navigateBusiness(`${businessOrigin}/login`) },
        { type: 'separator' },
        {
          label: '关于 OPS Desktop',
          click: () => void dialog.showMessageBox({
            title: '关于 OPS Desktop',
            message: 'OPS Desktop',
            detail: 'OPS Desktop 连接线上业务与本机 AI 服务。启用此客户端 AI 后，线上后端通过受限通道调用你配置的模型；本机模型凭证保留在此设备。'
          })
        },
        { type: 'separator' },
        { role: 'quit', label: '退出' }
      ]
    },
    {
      id: 'ops-app-menu-edit',
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      id: 'ops-app-menu-view',
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  nativeStatusMenuItem = menu.getMenuItemById('ops-native-client-status');
  Menu.setApplicationMenu(menu);
}

async function updateNativeClientStatus(): Promise<void> {
  if (!desktopClient) return;
  const revision = ++nativeStatusRevision;
  let state: Awaited<ReturnType<DesktopClient['getPublicState']>>;
  try {
    state = await desktopClient.getPublicState();
  } catch {
    if (revision === nativeStatusRevision && nativeStatusMenuItem) {
      nativeStatusMenuItem.label = '工作区：不可用 · 模式：状态未知';
    }
    return;
  }
  if (revision !== nativeStatusRevision) return;
  applyNativeClientStatus(state);
}

function applyNativeClientStatus(state: Awaited<ReturnType<DesktopClient['getPublicState']>>): void {
  const workspace = state.signedIn ? state.workspaceName : '未登录';
  const mode = state.mode === 'desktop' ? '此客户端 AI' : '服务器 AI';
  const channel = state.mode === 'desktop' && state.channelState !== 'ready' ? '（通道未就绪）' : '';
  const label = `工作区：${workspace} · 模式：${mode}${channel}`;
  if (nativeStatusMenuItem) nativeStatusMenuItem.label = label;
  if (businessWindow && !businessWindow.isDestroyed()) {
    businessWindow.setTitle(`OPS Desktop — ${workspace} · ${mode}${channel}`);
  }
}
