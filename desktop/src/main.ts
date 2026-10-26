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
  WebContentsView,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type Session
} from 'electron';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
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
  createPageResponseSource,
  openLoginPage,
  waitForLogin,
  PLATFORM_LOGIN_POLL_MS,
  PLATFORM_LOGIN_TIMEOUT_MS,
  type PlatformLoginPlatform,
  type PlatformLoginSession
} from './platform-login';
import { connectionProfileDir, buildProfileMeta, profileMetaPath, removeConnectionNamespace, orphanConnections } from './platform-profile';
import { parseIdentity as parseXhsIdentity, probeCapabilities as probeXhsCapabilities, collectPostedNotes, noteToObservation, normalizeXhsNoteTime, XHS_API, XhsAdapterError } from './platforms/xhs';
import { parseIdentity as parseWechatIdentity, probeCapabilities as probeWechatCapabilities, collectPublishedArticles, articleToObservation, normalizeWechatSentAt, WECHAT_MP_API, WechatAdapterError } from './platforms/wechat-mp';
import { buildPlatformCatalogCompletion, PlatformClient, type PlatformObservationDraft, type PlatformClaimedRun, type PlatformV2ResultType } from './platform-client';
import {
  isBusinessWindowOnlyIntent,
  parseDesktopUiIntent,
  CLIENT_HEALTH_CHANNEL,
  PLATFORM_INTENT_RESULT_CHANNEL,
  type DesktopClientHealth,
  type DesktopUiIntent,
  type PlatformIntentResult
} from './ui-intents';
import {
  createLocalSettingsViewController,
  EmbeddedSettingsSenderRegistry,
  parseEmbeddedSettingsPanel,
  type LocalSettingsPanel
} from './settings-view';
import { PlatformLoginFlow, type LoginAction } from './platform-login-flow';
import { startPlatformLogin, savePlatformLogin } from './platform-login-runtime';
import { trustedLoginBrowsers, selectLoginBrowser, type LoginBrowserFamily } from './platform-browser-trust';
import { readAccountProfile, accountProfileSlot } from './platform-profile';
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
  '/platform-login-ui.js': { file: 'platform-login-ui.js', contentType: 'text/javascript; charset=utf-8' },
  '/embedded/connection': { file: 'index.html', contentType: 'text/html; charset=utf-8' },
  '/embedded/ai': { file: 'index.html', contentType: 'text/html; charset=utf-8' },
  '/embedded/account-device': { file: 'index.html', contentType: 'text/html; charset=utf-8' },
  '/embedded/diagnostics': { file: 'index.html', contentType: 'text/html; charset=utf-8' },
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
let pendingPlatformLoginTarget: Extract<DesktopUiIntent, { type: 'platform-login' }> | null = null;
let failureWindow: BrowserWindow | null = null;
let businessLoadTimeout: ReturnType<typeof setTimeout> | null = null;
let businessFailureReason: 'unreachable' | 'icp-block' | 'render-failed' = 'unreachable';
let businessOrigin = PRODUCTION_ORIGIN;
let businessPartition = 'persist:ops-business-production';
let businessSession: Session | null = null;
let localSettingsSession: Session | null = null;
let localSettingsViewController: ReturnType<typeof createLocalSettingsViewController> | null = null;
let pendingNativeSettingsRequest = false;
let desktopClient: DesktopClient | null = null;
let clientHealthTimer: NodeJS.Timeout | null = null;
let collectionHealth: DesktopClientHealth['collection'] = { status: 'idle', message: '自动采集状态尚未更新。', updatedAt: null };
let presenceHealth: DesktopClientHealth['presence'] = { status: 'unknown', message: '平台连接状态尚未更新。', updatedAt: null };
let lastClientHealthPayload = '';
let externalPromptOpen = false;
const localWindows = new Set<number>();
const localSettingsSenderRegistry = new EmbeddedSettingsSenderRegistry();
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

function setCollectionHealth(status: DesktopClientHealth['collection']['status'], message: string): void {
  collectionHealth = { status, message: message.slice(0, 200), updatedAt: Date.now() };
  broadcastClientHealth();
}

function setPresenceHealth(status: DesktopClientHealth['presence']['status'], message: string): void {
  presenceHealth = { status, message: message.slice(0, 200), updatedAt: Date.now() };
  broadcastClientHealth();
}

function broadcastClientHealth(force = false): void {
  const window = businessWindow;
  if (!desktopClient || !window || window.isDestroyed() || window.webContents.isDestroyed()
    || !isBusinessUrl(window.webContents.getURL())) return;
  const channel = desktopClient.getChannelHealth();
  const payload: DesktopClientHealth = {
    channelState: channel.state,
    channelMessage: channel.message.slice(0, 200),
    collection: collectionHealth,
    presence: presenceHealth
  };
  const serialized = JSON.stringify(payload);
  if (!force && serialized === lastClientHealthPayload) return;
  try {
    window.webContents.send(CLIENT_HEALTH_CHANNEL, payload);
    lastClientHealthPayload = serialized;
  } catch (error) {
    console.error('[client-health] 无法更新桌面状态栏', describeError(error));
  }
}

function startClientHealthBroadcast(): void {
  if (clientHealthTimer) return;
  clientHealthTimer = setInterval(() => broadcastClientHealth(), 1_000);
  clientHealthTimer.unref?.();
}

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

      businessSession = session.fromPartition(businessPartition);
      localSettingsSession = session.fromPartition('ops-settings');
      desktopClient = new DesktopClient(businessSession, businessOrigin);
      startClientHealthBroadcast();
      registerDesktopPowerHandlers(
        powerMonitor,
        () => desktopClient?.disconnect(),
        async () => {
          try {
            await desktopClient?.reconnectAfterResume();
          } catch (error) {
            console.error('[desktop-channel] 恢复连接失败', describeError(error));
          }
          await updateNativeClientStatus();
          broadcastClientHealth(true);
        }
      );
      installBusinessPermissions(businessSession);
      installDesktopRequestContext(businessSession);
      installDownloadHandling(businessSession);
      await registerLocalProtocol(businessSession);
      await registerLocalProtocol(localSettingsSession);
      registerIpcHandlers();
      installApplicationMenu();
      const restoredMode = await desktopClient.restoreAppliedMode();
      void updateNativeClientStatus();
      // 平台采集 presence 心跳：只在服务端开通且本地已登录时真正上报，
      // 由 tick 内部判断，这里直接启动即可（重复调用幂等）。
      startPlatformPresence();
      // 后台领取循环：自动生成的任务只有客户端主动 claim 才会执行。
      startPlatformClaimLoop();
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
      stopPlatformPresence();
      stopPlatformClaimLoop();
      desktopClient?.disconnect();
      return;
    }
    event.preventDefault();
    void confirmApplicationQuit(businessWindow ?? failureWindow ?? null);
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
      preload: path.join(__dirname, 'business-ui-preload.js'),
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
    lastClientHealthPayload = '';
    broadcastClientHealth(true);
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
    flushPendingNativeSettingsRequest(currentWindow);
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
      void platformLoginFlow.stop();
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
  ipcMain.on('settings:local-state', (event: IpcMainEvent, raw: unknown) => {
    if (!localSettingsViewController?.isTrusted(event)) return;
    if (!raw || typeof raw !== 'object' || Object.keys(raw).sort().join(',') !== 'busy,dirty') return;
    const state = raw as { dirty: unknown; busy: unknown };
    if (typeof state.dirty !== 'boolean' || typeof state.busy !== 'boolean') return;
    const host = localSettingsViewController.currentHost;
    if (host !== businessWindow || !businessWindow || businessWindow.isDestroyed() || businessWindow.webContents.isDestroyed()) return;
    if (!isBusinessUrl(businessWindow.webContents.mainFrame.url)
      || !isBusinessUrl(businessWindow.webContents.getURL())) return;
    businessWindow.webContents.send('desktop-ui:local-settings-state', { dirty: state.dirty, busy: state.busy });
  });

  ipcHandle('settings:get-info', async (event) => {
    assertTrustedLocalSender(event);
    if (!desktopClient) throw new Error('客户端设置尚未初始化。');
    const clientState = await desktopClient.getPublicState();
    const systemInfo = await desktopClient.getPublicSystemInfo().catch(() => null);
    applyNativeClientStatus(clientState);
    return {
      appVersion: app.getVersion(),
      businessOrigin,
      connectionState: getConnectionState(),
      failureReason: businessFailureReason,
      systemInfo,
      aiStatus: clientState.mode === 'desktop'
        ? `已应用此客户端 AI 模式；任务映射版本 ${clientState.routeRevision}。${clientState.channelState === 'ready' ? '本机通道已连接。' : '本机通道当前不可用。'}${clientState.localConfigAvailable ? '' : ' 本机设置文件无法读取，模型与设备设置已停用。'}`
        : `当前使用服务器 AI 模式；本机模型配置不会影响线上任务。${clientState.localConfigAvailable ? '' : ' 本机设置文件无法读取，模型与设备设置已停用。'}`,
      clientState
    };
  });

  ipcHandle('settings:export-diagnostics', async (event) => {
    assertTrustedLocalSender(event);
    if (!desktopClient) throw new Error('客户端设置尚未初始化。');
    const window = getLocalSettingsWindow(event);
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
        local_config_available: state.localConfigAvailable,
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
    const window = getLocalSettingsWindow(event);
    if (!window) throw new Error('设置窗口已关闭。');
    const { response } = await dialog.showMessageBox(window, {
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
    const window = getLocalSettingsWindow(event);
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
    const window = getLocalSettingsWindow(event);
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
    const window = getLocalSettingsWindow(event);
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
    openNativeSettings();
  });

  ipcHandle('settings:take-platform-login-target', (event) => {
    assertTrustedLocalSender(event);
    const target = pendingPlatformLoginTarget;
    pendingPlatformLoginTarget = null;
    return target ? { accountId: target.accountId, platform: target.platform } : null;
  });

  ipcHandle('settings:close-local-window', (event) => {
    assertTrustedLocalSender(event);
    if (localSettingsViewController?.isTrusted(event)) {
      if (businessWindow && !businessWindow.isDestroyed() && !businessWindow.webContents.isDestroyed()) {
        businessWindow.webContents.send('desktop-ui:local-settings-state', { dirty: false, busy: false });
      }
      localSettingsViewController.destroy();
      localSettingsViewController = null;
      pendingPlatformLoginTarget = null;
      void platformLoginFlow.stop();
      return;
    }
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
    // status/cancel 必须能在 probe/confirm 在途时执行；流程 owner 自行约束写步骤单飞。
    if (envelope.cmd !== 'login-action') platformIPC.begin(envelope.cmd);
    try {
      // 超时按命令区分：`open-login` 要等用户本人扫码（最长 3 分钟），
      // `request-collect` 要读页面、抓响应、提交批次，同样远超 5 秒。
      // 用 5 秒的通用超时会在流程走完前就把命令判死（2026-10-21 实测两次复现）。
      // `read-status`/`pause` 等快命令仍是 5 秒，保持“本机操作不能挂住页面”的约束。
      const data = await withTimeout(
        executePlatformCommand(envelope),
        platformCommandTimeout(envelope.cmd)
      );
      return { ok: true, data };
    } finally {
      if (envelope.cmd !== 'login-action') platformIPC.end(envelope.cmd);
    }
  } catch (error) {
    // 诊断：把真实异常打到主进程日志，便于定位被 toIPCError 压掉的失败原因。
    // 只记录错误码与首行消息，不记录路径、堆栈或平台响应内容。
    console.error('[platform-command]', envelopeCmdOf(raw), describeError(error));
    return { ok: false, error: toIPCError(error) };
  }
}

// platformCommandTimeout 给每条本机命令一个与其真实耗时相称的上限。
// 快命令保持 5 秒（默认值），需要等用户或跑完整流程的命令单独放宽。
function platformCommandTimeout(cmd: string): number | undefined {
  if (cmd === 'open-login') return PLATFORM_LOGIN_IPC_TIMEOUT_MS;
  if (cmd === 'login-action') return 45_000;
  if (cmd === 'login-browsers') return 40_000;
  if (cmd === 'request-collect') return PLATFORM_COLLECT_IPC_TIMEOUT_MS;
  if (cmd === 'request-account-sync' || cmd === 'request-metrics-refresh' || cmd === 'resume-platform-sync') return 30_000;
  return undefined;
}

function envelopeCmdOf(raw: unknown): string {  try {
    const v = raw as { cmd?: unknown } | null;
    return typeof v?.cmd === 'string' ? v.cmd : '(unknown)';
  } catch {
    return '(unknown)';
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return `${typeof code === 'string' ? code : error.name}: ${error.message.split('\n')[0].slice(0, 200)}`;
  }
  return String(error).slice(0, 200);
}

async function executePlatformCommand(envelope: PlatformIPCEnvelope): Promise<unknown> {
  switch (envelope.cmd) {
    case 'read-status': {
      // 只回报能力摘要、浏览器探测结论与待清理目录数量，不含本机路径或会话内容。
      const capability = await desktopClient?.getPlatformCollectionCapability();
      const browser = await readPlatformBrowserStatus();
      const orphans = await countOrphanProfiles();
      return {
        supported: capability ? capability.enabled : false,
        protocolVersion: capability?.protocol_version ?? null,
        platforms: capability?.platforms ?? [],
        browser,
        orphanProfiles: orphans
      };
    }
    case 'open-login': {
      const payload = envelope.payload as { accountId: string; platform: PlatformLoginPlatform; browserFamily?: LoginBrowserFamily; operationId?: string };
      if (platformIPC.isBusy('request-collect')) throw new PlatformBrowserError('platform_profile_busy', '正在读取平台数据，请稍后连接');
      return platformLoginFlow.open(payload.accountId, payload.platform, payload.browserFamily, payload.operationId);
    }
    case 'login-action': {
      const payload = envelope.payload as { operationId: string; action: LoginAction };
      return platformLoginFlow.action(payload.operationId, payload.action);
    }
    case 'login-browsers': {
      const payload = envelope.payload as { accountId: string; platform: string };
      const auth = await desktopClient!.getAuthContext();
      const stored = await readAccountProfile(app.getPath('userData'), { ...auth, ...payload, origin: businessOrigin });
      return { fixedFamily: stored.meta?.browserFamily ?? null, candidates: (await trustedLoginBrowsers()).map((candidate) => ({ family: candidate.family, name: candidate.family === 'chrome' ? 'Google Chrome' : 'Microsoft Edge' })) };
    }
    case 'request-collect': {
      const payload = envelope.payload as { accountId: string };
      return runPlatformCollect(payload.accountId);
    }
    case 'request-account-sync': {
      if (!desktopClient) throw new Error('客户端设置尚未初始化。');
      const payload = envelope.payload as { accountId: string; mode: 'incremental' | 'full_reconcile'; connectionRevision: number };
      const requestIdIsUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(envelope.id);
      return desktopClient.requestPlatformAccountSync({ ...payload, idempotencyKey: requestIdIsUuid ? envelope.id : randomUUID() });
    }
    case 'request-metrics-refresh': {
      if (!desktopClient) throw new Error('客户端设置尚未初始化。');
      const payload = envelope.payload as { accountId: string; connectionRevision: number; platformWorkIds?: string[] };
      return desktopClient.requestPlatformMetricsRefresh({ ...payload, idempotencyKey: randomUUID() });
    }
    case 'resume-platform-sync': {
      if (!desktopClient) throw new Error('客户端设置尚未初始化。');
      const payload = envelope.payload as { accountId: string; operationId: string; expectedOperationRevision: number };
      return desktopClient.resumePlatformSyncOperation(payload);
    }
    case 'pause':
      // 暂停由页面直接调 PATCH 连接（只改 auto_collect），本机无副作用，保留稳定错误码。
      return { performed: false, errorCode: 'platform_client_required' };
    case 'clear-account-data': {
      const payload = envelope.payload as { accountId: string };
      return clearPlatformAccountData(payload.accountId);
    }
    case 'clear-orphan-profiles': {
      const payload = envelope.payload as { platform: PlatformLoginPlatform };
      return clearOrphanProfiles(payload.platform);
    }
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

// 本机登录的 IPC 超时：等待用户扫码最长 3 分钟（与 platform-login 的轮询上限一致），
// 再加 30 秒余量给浏览器启动、身份解析与服务端建连接。
// 不能用 5 秒的通用超时：那会在用户还没扫完码时就把命令判成失败。
const PLATFORM_LOGIN_IPC_TIMEOUT_MS = 220_000;

// 采集命令的 IPC 超时：claim + 心跳 + 页面取数 + 解析 + 提交终批，
// 首次采集还要启动浏览器与导航，给 3 分钟。
const PLATFORM_COLLECT_IPC_TIMEOUT_MS = 180_000;

// 同一时刻只允许一个登录会话：一个浏览器、一个 profile，避免双开争用同一目录。
let activeLogin: { accountId: string; platform: PlatformLoginPlatform } | null = null;

const platformLoginFlow = new PlatformLoginFlow({
  async context() {
    if (!desktopClient) throw new Error('客户端尚未初始化');
    const { userId, workspaceId, deviceId } = await desktopClient.getAuthContext();
    return { origin: businessOrigin, userId, workspaceId, deviceId };
  },
  async account(accountId, platform) {
    const account = (await desktopClient!.listBusinessAccounts()).find((item) => item.id === accountId && item.platform === platform && item.status === 'active');
    if (!account) throw new PlatformBrowserError('platform_account_unavailable', '目标账号不存在或已停用');
    return account;
  },
  async start(scope, family, operationId) { return startPlatformLogin(desktopClient!, app.getPath('userData'), scope, family, operationId); },
  async save(scope, identity, handle, recoverOnly, signal) { return savePlatformLogin(desktopClient!, app.getPath('userData'), scope, identity, handle, recoverOnly, signal); }
});

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
  // D-131：旧 PS13 单步实现保留作协作期间历史参考，正式 IPC 仅走 platformLoginFlow。
  // 不再从 UI 调用，避免绕过本人身份确认；按用户要求不删除其他工作中的代码。
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
      // 公众号的账号列表只在页面首次进入后台时由页面自己发起（switchacct），
      // 之后再导航不会重发，构造请求也恒回 not found。因此必须在导航前就注册监听。
      // 新 profile 会先停在扫码页：此时监听仍在，用户扫码进后台后才会捕获到。
      const page = await openLoginPage(session, platform === 'wechat_mp'
        ? { captureBeforeNavigate: [WECHAT_IDENTITY_PATH], captureTimeoutMs: 20_000 }
        : {});
      // 公众号身份优先用导航期间捕获的 switchacct 响应，而不是页面内重新拼请求。
      if (platform === 'wechat_mp') {
        let capturedIdentity = page.captured.get(WECHAT_IDENTITY_PATH);
        // 还没捕获到说明停在扫码页：继续等用户扫码，监听在后台仍有效。
        if (capturedIdentity === undefined) {
          capturedIdentity = await waitForWechatIdentity(session);
        }
        if (capturedIdentity !== undefined) {
          return finishWechatLogin(accountId, capturedIdentity);
        }
        // 仍然没有：明确说明原因，不退回“只有 token 没有身份”的半可信状态。
        throw new PlatformBrowserError('platform_identity_mismatch', '没有取到公众号账号身份，请重新登录后再试');
      }
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
        // 写入"账号 slot"的 meta：采集时要靠它确认"这条 run 属于本机已登录的这个账号"。
        const loginAuth = await desktopClient.getAuthContext();
        await writeAccountProfileMeta({
          auth: loginAuth,
          accountId,
          platform,
          externalAccountKey,
          connectionId: accountProfileSlot({ ...loginAuth, origin: businessOrigin, accountId, platform })
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

// ---------- 本机平台采集（DEV-PS15 / 20 文档 §4.2、§10） ----------
//
// 一次采集：claim 取一条 run → 按 query_scope 读页面 → 适配器解析成观测 →
// 按批次提交 → 终批报告 run_status。只读，不点发布/删除/修改。
// 采集会话同样用独立 profile，结束后优雅关闭以保住登录会话。

interface PlatformCollectOutcome {
  performed: boolean;
  runId: string | null;
  runStatus: string;
  accepted: number;
  rejected: number;
  stopReason: string | null;
  errorCode: string | null;
  // auto_adopt 开启时未能投影为正式指标的行数与原因。
  // accepted 仍计入（观测确实入库），但"没进正式指标"必须让用户看见，
  // 否则只会看到一条显示成功的日志。
  adoptErrors: number;
  adoptReason: string | null;
}

async function runPlatformCollect(accountId: string, preClaimedRun?: PlatformClaimedRun): Promise<PlatformCollectOutcome> {
  if (!desktopClient) throw new Error('客户端设置尚未初始化。');
  if (activeLogin || platformLoginFlow.active) {
    throw new PlatformBrowserError('platform_profile_busy', '另一个平台登录正在进行，请先完成或关闭它');
  }
  const capability = await desktopClient.getPlatformCollectionCapability();
  const client = new PlatformClient(capability, async (operation, method, path, body) =>
    desktopClient!.platformSignedCall(operation, method, path, body));

  // 后台循环已经领过任务时直接用，避免重复 claim 把刚领到的 run 丢掉。
  let run = preClaimedRun ?? null;
  if (run) {
    // 本实例还没 claim 过，必须显式接管，否则 heartbeat/submit 会报"没有已领取的任务"。
    client.adopt(run);
  } else {
    // 先发一次 presence，让服务端知道本设备在线（调度按 presence 派任务）。
    await client.presence();
    run = await client.claim();
  }
  if (!run) {
    return {
      performed: true, runId: null, runStatus: 'no_task',
      accepted: 0, rejected: 0, stopReason: null, errorCode: null, adoptErrors: 0, adoptReason: null
    };
  }
  if (run.wire_protocol_version === 2) {
    return runPlatformV2Collect(accountId, run, client);
  }
  if (run.platform !== 'xhs' && run.platform !== 'wechat_mp') {
    // 两个平台之外的任务一律拒绝，不猜测平台。
    await client.submit({
      final_batch: true,
      run_status: 'failed',
      stop_reason: 'platform_not_supported',
      error_code: 'platform_not_supported',
      observations: []
    });
    return {
      performed: true, runId: run.id, runStatus: 'failed',
      accepted: 0, rejected: 0, stopReason: 'platform_not_supported', errorCode: 'platform_not_supported', adoptErrors: 0, adoptReason: null
    };
  }
  const platform = run.platform as PlatformLoginPlatform;

  const auth = await desktopClient.getAuthContext();
  // profile 目录必须与**登录写入口**一致。v2 登录流程把平台会话写进账号 slot
  // （accountProfileSlot 派生的哈希目录，见 platform-login-runtime.ts），
  // 采集却读设备命名空间（connectionNamespaceId）时，那个目录里可能还留着
  // 另一个账号的旧登录态，于是整批采集读成了别人的笔记
  // （2026-10-22 实测：验收号只读到 1 篇，正是命名空间里残留账号的作品）。
  const stored = await readAccountProfile(app.getPath('userData'), { ...auth, origin: businessOrigin, accountId: run.account_id, platform });
  const profileDir = stored.profileDir;
  // 归属校验全部由 readAccountProfile 负责（含历史 profile 缺 accountId 的兼容），
  // 这里只判断"有没有可用的归属信息"：meta 为 null 表示该 slot 从未登录过。
  console.error('[collect] profile-check', JSON.stringify({
    hasMeta: stored.meta !== null,
    metaPlatform: stored.meta?.platform ?? null,
    runPlatform: platform
  }));
  if (!stored.meta) {
    await client.submit({ final_batch: true, run_status: 'failed', stop_reason: 'login_required', error_code: 'platform_login_required', observations: [] });
    return { performed: true, runId: run.id, runStatus: 'failed', accepted: 0, rejected: 0, stopReason: 'login_required', errorCode: 'platform_login_required', adoptErrors: 0, adoptReason: null };
  }
  const candidate = selectLoginBrowser(await trustedLoginBrowsers(), stored.meta.browserFamily);
  const browser = await launchPlatformBrowser({ executablePath: candidate.executablePath, profileDir });
  const cdp = createCDPClient(browser, 20_000);
  const session = { platform, profileDir, browser, cdp };
  let accepted = 0;
  let rejected = 0;
  try {
    const page = await openLoginPage(session);
    if (!isLoggedInLanding(platform, page.url)) {
      // 会话失效：如实报告需要重新登录，不重试、不反复拉二维码。
      const receipt = await client.submit({
        final_batch: true,
        run_status: 'failed',
        stop_reason: 'login_required',
        error_code: 'platform_login_required',
        observations: []
      });
      return {
        performed: true, runId: run.id, runStatus: receipt.run_status,
        accepted: receipt.accepted, rejected: receipt.rejected,
        stopReason: 'login_required', errorCode: 'platform_login_required',
        adoptErrors: 0, adoptReason: null
      };
    }
    // 心跳：确认租约仍在、未被取消。
    const beat = await client.heartbeat();
    if (beat.canceled) {
      const receipt = await client.submit({
        final_batch: true, run_status: 'canceled', stop_reason: 'canceled', error_code: null, observations: []
      });
      return {
        performed: true, runId: run.id, runStatus: receipt.run_status,
        accepted: receipt.accepted, rejected: receipt.rejected, stopReason: 'canceled', errorCode: null,
        adoptErrors: 0, adoptReason: null
      };
    }

    // 旧版单阶段采集同样要走节奏包装：滚动续读会在一次采集里连发多次列表请求，
    // §13.1 要求串行且相邻请求至少间隔 5 秒。
    const source = pacedPlatformSource(createPageResponseSource(session));
    // 观测必须带真实的外部账号键，否则服务端无法把作品归到正确连接。
    // 优先用 run 冻结的绑定快照，其次回读连接摘要。
    const externalAccountKey = await resolveRunAccountKey(run);
    if (!externalAccountKey) {
      throw new PlatformBrowserError('platform_identity_mismatch', '本次任务缺少外部账号标识');
    }
    // 目录改对之后仍要核对“这份登录态就是本任务的账号”：采到别人的笔记比采不到更糟（§6.2）。
    // 读不到身份时只跳过核对并留痕，不因此把整次采集判失败。
    if (platform === 'xhs') {
      try {
        const current = parseXhsIdentity(await source.fetchJSON(XHS_API.userInfo));
        if (current.externalAccountKey !== externalAccountKey) {
          throw new PlatformBrowserError('platform_identity_mismatch', '浏览器登录的账号与本次任务不一致');
        }
      } catch (identityError) {
        if (identityError instanceof PlatformBrowserError && identityError.code === 'platform_identity_mismatch') throw identityError;
        console.error('[collect] identity-check skipped', describeError(identityError));
      }
    }
    const observedAt = new Date().toISOString();
    // 服务端按 run 冻结的 binding_snapshot 逐篇比对作品、绑定修订与发布修订；
    // 客户端必须原样回传这两个 revision，否则会被判“绑定或发布信息已变化”。
    const targets = parseRunTargets(run.binding_snapshot);
    const drafts: PlatformObservationDraft[] = [];
    let rowNo = 0;
    let unmatched = 0;
    let discovered = 0;
    let coverage: Record<string, unknown>;
    if (platform === 'xhs') {
      // 笔记列表接口需要平台签名，直接 GET 会被回 406（2026-10-21 实测）。
      // 适配器通过 source.fetchSigned 走“页面自发请求 + 响应监听”，不构造也不复制签名。
      const discovery = await collectPostedNotes(source, { maxPages: 3 });
      discovered = discovery.notes.length;
      coverage = discovery.coverage;
      for (const note of discovery.notes) {
        const target = targets.get(note.noteId);
        // 不提交快照之外的作品：§7.2 不允许把未绑定作品塞进采集结果。
        if (!target) {
          unmatched += 1;
          continue;
        }
        const draft = noteToObservation(note, {
          externalAccountKey,
          observedAt,
          bindingRevision: target.bindingRevision,
          publishRevision: target.publishRevision
        });
        if (!draft) continue;
        drafts.push({ ...draft, row_no: rowNo });
        rowNo += 1;
      }
    } else {
      // 公众号发表记录：接口需要页面 URL 里的 token（适配器经响应源自动补），
      // `publish_page` 是嵌套 JSON 字符串，适配器已二次解析。
      const discovery = await collectPublishedArticles(source, { maxPages: 3 });
      discovered = discovery.articles.length;
      coverage = discovery.coverage as unknown as Record<string, unknown>;
      for (const article of discovery.articles) {
        const target = targets.get(article.externalID.toLowerCase());
        if (!target) {
          unmatched += 1;
          continue;
        }
        const draft = articleToObservation(article, {
          externalAccountKey,
          observedAt,
          bindingRevision: target.bindingRevision,
          publishRevision: target.publishRevision
        });
        if (!draft) continue;
        drafts.push({ ...draft, row_no: rowNo });
        rowNo += 1;
      }
    }
    console.error('[collect] discovery', JSON.stringify({
      platform,
      discovered,
      targets: targets.size,
      unmatched,
      drafts: drafts.length,
      coverage
    }));
    const incomplete = typeof coverage.incomplete_reason === 'string' ? coverage.incomplete_reason : null;
    const receipt = await client.submit({
      final_batch: true,
      run_status: incomplete ? 'partial' : 'succeeded',
      stop_reason: incomplete,
      error_code: null,
      coverage,
      observations: drafts
    });
    accepted = receipt.accepted;
    rejected = receipt.rejected;
    return {
      performed: true, runId: run.id, runStatus: receipt.run_status,
      accepted, rejected, stopReason: incomplete, errorCode: null,
      // auto_adopt 开启时，服务端会把未能投影的行数放回执。
      // 这些行"观测已入库但没进正式指标"，必须透出来，不能让用户以为全部生效。
      adoptErrors: receipt.adopt_errors ?? 0,
      adoptReason: receipt.adopt_reason ?? null
    };
  } catch (error) {
    const code = platformCollectErrorCode(error);
    // 失败也要交终批，否则 run 会一直挂在 leased 直到租约过期。
    console.error('[collect] failed', code, describeError(error));
    await client.submit({
      final_batch: true, run_status: 'failed', stop_reason: 'collect_failed', error_code: code, observations: []
    }).catch((submitError) => {
      console.error('[collect] final batch rejected', describeError(submitError));
    });
    return {
      performed: true, runId: run.id, runStatus: 'failed',
      accepted: 0, rejected: 0, stopReason: 'collect_failed', errorCode: code, adoptErrors: 0, adoptReason: null
    };
  } finally {
    await cdp.close();
  }
}

const PLATFORM_V2_PAGE_LIMIT = 3;
const PLATFORM_V2_PAGE_SIZE = 20;
const PLATFORM_V2_PACING_MS = 5_000;

function pacedPlatformSource(source: ReturnType<typeof createPageResponseSource>): ReturnType<typeof createPageResponseSource> {
  let lastRequestAt = 0;
  const paced = async <T,>(read: () => Promise<T>): Promise<T> => {
    const wait = PLATFORM_V2_PACING_MS - (Date.now() - lastRequestAt);
    if (lastRequestAt > 0 && wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    const result = await read();
    lastRequestAt = Date.now();
    return result;
  };
  return {
    ...source,
    fetchJSON: (path) => paced(() => source.fetchJSON(path)),
    fetchSigned: (path) => paced(() => source.fetchSigned(path)),
    // 滚动续读同样要串行 + 相邻请求至少 5 秒（docs/21 §安全修复：串行并至少间隔 5 秒）。
    fetchSignedNextPage: (path) => paced(() => source.fetchSignedNextPage(path)),
    observeResponse: (path, trigger, timeout) => paced(() => source.observeResponse(path, trigger, timeout))
  };
}

interface PlatformV2TargetSnapshot {
  externalID: string;
  bindingRevision?: number;
  publishRevision?: number;
}

function parsePlatformV2Targets(snapshot: unknown): { local: Map<string, PlatformV2TargetSnapshot>; mirrors: Map<string, PlatformV2TargetSnapshot> } {
  const local = new Map<string, PlatformV2TargetSnapshot>();
  const mirrors = new Map<string, PlatformV2TargetSnapshot>();
  if (!snapshot || typeof snapshot !== 'object') return { local, mirrors };
  const value = snapshot as { local_bindings?: unknown; platform_works?: unknown };
  if (Array.isArray(value.local_bindings)) for (const item of value.local_bindings) {
    if (!item || typeof item !== 'object') continue;
    const target = item as { external_id?: unknown; binding_revision?: unknown; publish_revision?: unknown };
    if (typeof target.external_id !== 'string' || typeof target.binding_revision !== 'number' || typeof target.publish_revision !== 'number') continue;
    local.set(target.external_id, { externalID: target.external_id, bindingRevision: target.binding_revision, publishRevision: target.publish_revision });
  }
  if (Array.isArray(value.platform_works)) for (const item of value.platform_works) {
    if (!item || typeof item !== 'object') continue;
    const target = item as { external_id?: unknown };
    if (typeof target.external_id === 'string') mirrors.set(target.external_id, { externalID: target.external_id });
  }
  return { local, mirrors };
}

function platformV2StartPage(queryScope: unknown): number {
  if (!queryScope || typeof queryScope !== 'object') return 0;
  const checkpoint = (queryScope as { checkpoint?: unknown }).checkpoint;
  if (!checkpoint || typeof checkpoint !== 'object') return 0;
  const page = (checkpoint as { next_page?: unknown }).next_page;
  return typeof page === 'number' && Number.isInteger(page) && page >= 0 ? page : 0;
}

function platformV2ScopeUpperBound(queryScope: unknown): number | null {
  if (!queryScope || typeof queryScope !== 'object') return null;
  const frozen = (queryScope as { frozen_scope?: unknown }).frozen_scope;
  if (!frozen || typeof frozen !== 'object') return null;
  const raw = (frozen as { scope_upper_bound?: unknown }).scope_upper_bound;
  if (typeof raw !== 'string') return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function platformV2CatalogItem(input: {
  externalID: string; accountKey: string; contentType: string; title: string; authorDisplay: string;
  publishedAt: string | null; metrics: PlatformObservationDraft | null; upperBound: number | null;
}): { item: Record<string, unknown> | null; outsideUpperBound: boolean; missingPublishedAt: boolean } {
  const publishedTime = input.publishedAt ? Date.parse(input.publishedAt) : Number.NaN;
  const outsideUpperBound = input.upperBound !== null && Number.isFinite(publishedTime) && publishedTime > input.upperBound;
  if (outsideUpperBound) return { item: null, outsideUpperBound, missingPublishedAt: false };
  const fieldStates: Record<string, string> = {
    title: input.title ? 'present' : 'unknown',
    summary: 'unknown', canonical_url: 'unknown', published_at: input.publishedAt ? 'present' : 'unknown',
    remote_updated_at: 'unknown', cover_ref: 'unknown', topics: 'unknown', tags: 'unknown'
  };
  return {
    outsideUpperBound,
    missingPublishedAt: !input.publishedAt,
    item: {
      external_id: input.externalID,
      author_external_account_key: input.accountKey,
      remote_content_type: input.contentType,
      remote_status: 'published',
      title: input.title,
      summary: '',
      author_display: input.authorDisplay,
      topics: [],
      tags: [],
      field_states: fieldStates,
      ...(input.publishedAt ? { published_at: input.publishedAt } : {}),
      ...(input.metrics ? { inline_metrics: [input.metrics] } : {})
    }
  };
}

async function runPlatformV2Collect(accountId: string, run: PlatformClaimedRun, client: PlatformClient): Promise<PlatformCollectOutcome> {
  if (!desktopClient) throw new Error('客户端设置尚未初始化。');
  if (run.platform !== 'xhs' && run.platform !== 'wechat_mp') {
    return submitV2ControlFailure(client, run, 'platform_browser_unsupported', 'platform_browser_unsupported');
  }
  if (activeLogin || platformLoginFlow.active) throw new PlatformBrowserError('platform_profile_busy', '另一个平台登录正在进行，请先完成或关闭它');
  const platform = run.platform as PlatformLoginPlatform;
  const auth = await desktopClient.getAuthContext();
  // 与 v1 采集同理：登录态落在账号 slot 里，采集必须读同一个目录，
  // 不能用设备命名空间（那里可能是另一个账号的历史登录态）。
  const stored = await readAccountProfile(app.getPath('userData'), {
    ...auth, origin: businessOrigin, accountId, platform
  });
  const profileDir = stored.profileDir;
  if (!stored.meta || stored.meta.platform !== platform) {
    return submitV2ControlFailure(client, run, 'platform_login_required', 'platform_login_required');
  }
  const candidate = selectLoginBrowser(await trustedLoginBrowsers(), stored.meta.browserFamily);
  const browser = await launchPlatformBrowser({ executablePath: candidate.executablePath, profileDir });
  const cdp = createCDPClient(browser, 20_000);
  const session = { platform, profileDir, browser, cdp };
  let accepted = 0;
  let rejected = 0;
  try {
    const opened = await client.withHeartbeat(() => openLoginPage(session));
    if (opened.canceled) return { performed: true, runId: run.id, runStatus: 'canceled', accepted: 0, rejected: 0, stopReason: 'canceled', errorCode: null, adoptErrors: 0, adoptReason: null };
    const page = opened.value;
    if (!page) throw new PlatformBrowserError('platform_navigation_failed', '平台页面未能打开');
    if (!isLoggedInLanding(platform, page.url)) return submitV2ControlFailure(client, run, 'platform_login_required', 'platform_login_required');

    const source = pacedPlatformSource(createPageResponseSource(session));
    const externalAccountKey = await resolveRunAccountKey(run);
    if (!externalAccountKey) return submitV2ControlFailure(client, run, 'platform_identity_mismatch', 'platform_identity_mismatch');
    let currentExternalKey = '';
    let displayName = '';
    if (platform === 'xhs') {
      const identity = parseXhsIdentity(await source.fetchJSON(XHS_API.userInfo));
      currentExternalKey = identity.externalAccountKey;
      displayName = identity.redId;
    } else {
      const identityPayload = await source.fetchSigned(WECHAT_MP_API.switchAccount);
      const current = await cdp.request('Runtime.evaluate', {
        expression: `(() => { const id = globalThis.wx?.data?.user_name; return typeof id === 'string' && /^gh_[0-9a-zA-Z]+$/.test(id) ? id : null; })()`,
        returnByValue: true
      }) as { result?: { value?: unknown } };
      const identity = parseWechatIdentity(identityPayload, typeof current.result?.value === 'string' ? current.result.value : undefined);
      currentExternalKey = identity.externalAccountKey;
      displayName = identity.originalID;
    }
    if (currentExternalKey !== externalAccountKey || stored.meta.externalAccountKey && stored.meta.externalAccountKey !== currentExternalKey) {
      return submitV2ControlFailure(client, run, 'platform_identity_mismatch', 'platform_identity_mismatch');
    }

    const observedAt = new Date().toISOString();
    const stage = run.operation_stage ?? 'metrics';
    const targets = parsePlatformV2Targets(run.binding_snapshot);
    const expectedMetrics = new Set([...targets.local.keys(), ...targets.mirrors.keys()]);
    if (run.task_kind === 'account_sync' && stage === 'profile') {
      return submitV2Control(client, run, {
        state: 'unknown', reason: 'profile_capability_unverified', observed_at: observedAt
      }, 'partial');
    }
    if (run.task_kind === 'account_sync' && stage === 'catalog') {
      const startPage = platformV2StartPage(run.query_scope);
      const upperBound = platformV2ScopeUpperBound(run.query_scope);
      const items: Array<Record<string, unknown>> = [];
      let uncertainBoundary = false;
      let enumerationComplete = false;
      let totalCount: number | null = null;
      let pagesRead = 0;
      let hasMore = false;
      let incompleteReason: string | null = null;
      const partition = platform === 'xhs' ? 'notes' : 'articles';
      if (platform === 'xhs') {
        const discovered = await collectPostedNotes(source, {
          maxPages: PLATFORM_V2_PAGE_LIMIT,
          startPage,
          buildPath: ({ page: pageNo }) => `${XHS_API.postedNotes}?page=${pageNo}&page_size=${PLATFORM_V2_PAGE_SIZE}`
        });
        enumerationComplete = discovered.enumerationComplete;
        totalCount = discovered.totalCount;
        pagesRead = discovered.pagesRead;
        hasMore = discovered.hasMore;
        incompleteReason = discovered.coverage.incomplete_reason;
        for (const note of discovered.notes) {
          if (note.status !== 'published') continue;
          const publishedAt = normalizeXhsNoteTime(note.recordedAt);
          const metrics = noteToObservation(note, { externalAccountKey, observedAt });
          const contentType = note.contentType === 'image' ? 'image_note' : note.contentType === 'video' ? 'video_note' : 'unknown';
          const result = platformV2CatalogItem({ externalID: note.noteId, accountKey: externalAccountKey, contentType,
            title: note.title, authorDisplay: displayName || externalAccountKey, publishedAt, metrics, upperBound });
          uncertainBoundary ||= result.missingPublishedAt;
          if (result.item) items.push(result.item);
        }
      } else {
        const discovered = await collectPublishedArticles(source, { maxPages: PLATFORM_V2_PAGE_LIMIT, startPage });
        enumerationComplete = discovered.enumerationComplete;
        totalCount = discovered.coverage.total_count ?? null;
        pagesRead = discovered.pagesRead;
        hasMore = discovered.hasMore;
        incompleteReason = discovered.coverage.incomplete_reason;
        for (const article of discovered.articles) {
          if (article.status !== 'published') continue;
          const publishedAt = normalizeWechatSentAt(article.sentAt);
          const metrics = articleToObservation(article, { externalAccountKey, observedAt });
          const result = platformV2CatalogItem({ externalID: article.externalID, accountKey: externalAccountKey, contentType: 'wechat_article',
            title: article.title, authorDisplay: displayName || externalAccountKey, publishedAt, metrics, upperBound });
          uncertainBoundary ||= result.missingPublishedAt;
          if (result.item) items.push(result.item);
        }
      }
      for (let offset = 0; offset < items.length; offset += 25) {
        const data: Record<string, unknown> = {
          items: items.slice(offset, offset + 25), enumeration_complete: false,
          partition: platform === 'xhs' ? 'notes' : 'articles', consistency: 'best_effort'
        };
        if (totalCount !== null) data.total_count = totalCount;
        const receipt = await client.submitV2('work_catalog', data);
        accepted += receipt.accepted;
        rejected += receipt.rejected;
      }
      const nextPage = startPage + pagesRead;
      const completion = buildPlatformCatalogCompletion({ enumerationComplete, uncertainBoundary, incompleteReason,
        hasMore, nextPage, partition, totalCount, observedAt });
      const receipt = await client.submitV2('control', completion.data, completion.outcome);
      accepted += receipt.accepted;
      rejected += receipt.rejected;
      return { performed: true, runId: run.id, runStatus: receipt.run_status, accepted, rejected,
        stopReason: completion.outcome.stopReason, errorCode: null, adoptErrors: 0, adoptReason: null };
    }
    if (run.task_kind === 'account_sync' && stage === 'content') {
      return submitV2Control(client, run, {
        state: 'unsupported', reason: 'content_capability_unverified', observed_at: observedAt
      }, 'succeeded');
    }

    if ((run.task_kind === 'account_sync' && stage === 'metrics') || run.task_kind === 'collect' && stage === 'metrics') {
      if (expectedMetrics.size === 0) {
        const receipt = await client.submitV2('control', { state: 'complete', observed_at: observedAt }, { status: 'succeeded' });
        return { performed: true, runId: run.id, runStatus: receipt.run_status, accepted: 0, rejected: 0, stopReason: null, errorCode: null, adoptErrors: 0, adoptReason: null };
      }
      const drafts: PlatformObservationDraft[] = [];
      const found = new Set<string>();
      if (platform === 'xhs') {
        const discovered = await collectPostedNotes(source, { maxPages: PLATFORM_V2_PAGE_LIMIT, buildPath: ({ page: pageNo }) => `${XHS_API.postedNotes}?page=${pageNo}&page_size=${PLATFORM_V2_PAGE_SIZE}` });
        for (const note of discovered.notes) {
          if (!expectedMetrics.has(note.noteId) || note.status !== 'published') continue;
          found.add(note.noteId);
          const target = targets.local.get(note.noteId);
          const draft = noteToObservation(note, { externalAccountKey, observedAt, bindingRevision: target?.bindingRevision, publishRevision: target?.publishRevision });
          if (draft) drafts.push({ ...draft, row_no: drafts.length });
        }
      } else {
        const discovered = await collectPublishedArticles(source, { maxPages: PLATFORM_V2_PAGE_LIMIT });
        for (const article of discovered.articles) {
          if (!expectedMetrics.has(article.externalID) || article.status !== 'published') continue;
          found.add(article.externalID);
          const target = targets.local.get(article.externalID);
          const draft = articleToObservation(article, { externalAccountKey, observedAt, bindingRevision: target?.bindingRevision, publishRevision: target?.publishRevision });
          if (draft) drafts.push({ ...draft, row_no: drafts.length });
        }
      }
      for (let offset = 0; offset < drafts.length; offset += 25) {
        const receipt = await client.submitV2('metrics', { observations: drafts.slice(offset, offset + 25) });
        accepted += receipt.accepted;
        rejected += receipt.rejected;
      }
      if (found.size < expectedMetrics.size) {
        await client.submitV2('control', {
          state: 'partial', reason: 'target_not_in_bounded_window', observed_at: observedAt
        }, { status: 'partial', stopReason: 'target_not_in_bounded_window' });
        return { performed: true, runId: run.id, runStatus: 'partial', accepted, rejected, stopReason: 'target_not_in_bounded_window', errorCode: null, adoptErrors: 0, adoptReason: null };
      }
      if (drafts.length === 0) {
        await client.submitV2('control', { state: 'partial', reason: 'temporarily_unavailable', observed_at: observedAt }, { status: 'partial', stopReason: 'temporarily_unavailable' });
        return { performed: true, runId: run.id, runStatus: 'partial', accepted, rejected, stopReason: 'temporarily_unavailable', errorCode: null, adoptErrors: 0, adoptReason: null };
      }
      const receipt = await client.submitV2('control', { state: 'complete', observed_at: observedAt }, { status: 'succeeded' });
      accepted += receipt.accepted;
      return { performed: true, runId: run.id, runStatus: receipt.run_status, accepted, rejected, stopReason: null, errorCode: null, adoptErrors: receipt.adopt_errors ?? 0, adoptReason: receipt.adopt_reason ?? null };
    }
    return submitV2Control(client, run, { state: 'unknown', reason: 'temporarily_unavailable', observed_at: observedAt }, 'failed');
  } catch (error) {
    const code = platformCollectErrorCode(error);
    console.error('[collect-v2] failed', code, describeError(error));
    return submitV2ControlFailure(client, run, v2ControlReason(code), code);
  } finally {
    await cdp.close();
  }
}

function platformCollectErrorCode(error: unknown): string {
  if (error instanceof PlatformBrowserError || error instanceof XhsAdapterError || error instanceof WechatAdapterError) {
    return error.code;
  }
  return 'platform_network_unavailable';
}

function v2ControlReason(errorCode: string): string {
  if (errorCode === 'platform_identity_mismatch') return 'author_identity_unverified';
  if (errorCode === 'platform_login_required' || errorCode === 'platform_challenge_required') return 'access_denied';
  if (errorCode === 'platform_schema_changed') return 'catalog_inconsistent';
  if (errorCode === 'platform_rate_limited' || errorCode === 'platform_account_restricted') return 'platform_risk';
  return 'network_unavailable';
}

async function submitV2Control(client: PlatformClient, run: PlatformClaimedRun, data: Record<string, unknown>, status: 'succeeded' | 'partial' | 'failed' = 'succeeded'): Promise<PlatformCollectOutcome> {
  const receipt = await client.submitV2('control', data, { status, stopReason: typeof data.reason === 'string' ? data.reason : null });
  return { performed: true, runId: run.id, runStatus: receipt.run_status, accepted: receipt.accepted, rejected: receipt.rejected,
    stopReason: typeof data.reason === 'string' ? data.reason : null, errorCode: null, adoptErrors: receipt.adopt_errors ?? 0, adoptReason: receipt.adopt_reason ?? null };
}

async function submitV2ControlFailure(client: PlatformClient, run: PlatformClaimedRun, errorCode: string, reasonCode: string): Promise<PlatformCollectOutcome> {
  const data = { state: 'unknown', reason: v2ControlReason(reasonCode), observed_at: new Date().toISOString() };
  const receipt = await client.submitV2('control', data, { status: 'failed', stopReason: data.reason, errorCode });
  return { performed: true, runId: run.id, runStatus: receipt.run_status, accepted: receipt.accepted, rejected: receipt.rejected,
    stopReason: data.reason, errorCode, adoptErrors: receipt.adopt_errors ?? 0, adoptReason: receipt.adopt_reason ?? null };
}

// ---------- 撤销连接与本机清理（DEV-PS23 / 20 文档 §5.4） ----------
//
// 顺序不能反：先调服务端回收（只减权），成功后才删本机 profile。
// 反过来的话，服务端连接还在、本机凭据没了，用户会看到一个再也验证不了的连接。
// 清理只删该连接自己的目录，不递归删账号命名空间（避免误删同账号其它连接）。

interface PlatformClearOutcome {
  performed: boolean;
  revoked: boolean;
  removed: boolean;
  connectionId: string | null;
  errorCode: string | null;
}

async function clearPlatformAccountData(accountId: string): Promise<PlatformClearOutcome> {
  if (!desktopClient) throw new Error('客户端设置尚未初始化。');
  if (activeLogin || platformLoginFlow.active || platformIPC.isBusy('request-collect')) {
    throw new PlatformBrowserError('platform_profile_busy', '平台登录正在进行，请先完成或关闭它');
  }
  const auth = await desktopClient.getAuthContext();
  // 找出该账号在本设备上的连接。用 mine.list 而不是本地猜 ID。
  const connections = await desktopClient.listPlatformConnections().catch(() => []);
  const target = connections.find((c) => String(c.account_id ?? '').toLowerCase() === accountId.toLowerCase() && c.state !== 'revoked');
  if (!target) {
    // 服务端已经没有该连接：本机可能还有残留目录，按平台清理一次。
    return { performed: true, revoked: false, removed: false, connectionId: null, errorCode: null };
  }
  const connectionId = String(target.id);
  const platform = String(target.platform ?? '');
  await desktopClient.revokePlatformConnection(connectionId);
  // 服务端回收成功后才删本机 profile。
  const removed = await removeConnectionNamespace(await app.getPath('userData'), {
    userId: auth.userId,
    platform,
    connectionId: accountProfileSlot({ ...auth, origin: businessOrigin, workspaceId: String(target.workspace_id), accountId, platform })
  });
  console.error('[platform-clear]', JSON.stringify({ revoked: true, removed: removed.removed }));
  return { performed: true, revoked: true, removed: removed.removed, connectionId, errorCode: null };
}

// ---------- 无主 profile 目录扫描（DEV-PS26 / 20 文档 §5.4） ----------
//
// "无主目录"指本机存在、但服务端已不认识（连接被撤销/账号被删除/换了设备）的 profile。
// 它们不会自动消失，会一直占磁盘，还留着平台登录态。
// 策略：只扫描与计数，不自动删除——删除必须由用户确认，且要确认浏览器未占用目录。

interface OrphanProfileSummary {
  xhs: number;
  wechat_mp: number;
  total: number;
}

// countOrphanProfiles 对比本机目录与服务端连接列表，返回各平台的待清理数量。
// 服务端不可达时返回 null（不把"读不到"当成"没有无主目录"）。
async function countOrphanProfiles(): Promise<OrphanProfileSummary | null> {
  if (!desktopClient) return null;
  let auth;
  try {
    auth = await desktopClient.getAuthContext();
  } catch {
    return null;
  }
  let connections: Array<Record<string, unknown>>;
  try {
    connections = await desktopClient.listPlatformConnections();
  } catch {
    // 服务端读不到就不下结论，避免把网络问题显示成"有 N 个待清理"。
    return null;
  }
  const userData = await app.getPath('userData');
  const out: OrphanProfileSummary = { xhs: 0, wechat_mp: 0, total: 0 };
  for (const platform of ['xhs', 'wechat_mp'] as const) {
    const known = connections
      .filter((c) => String(c.platform ?? '') === platform)
      .map((c) => String(c.id ?? ''))
      .filter((id) => id !== '');
    const orphans = await orphanConnections(userData, { userId: auth.userId, platform }, known)
      .catch(() => [] as string[]);
    out[platform] = orphans.length;
    out.total += orphans.length;
  }
  return out;
}

interface OrphanClearOutcome {
  performed: boolean;
  platform: PlatformLoginPlatform;
  found: number;
  removed: number;
  // 浏览器占用目录时删不掉，如实报告，不假装成功。
  skipped: number;
  errorCode: string | null;
}

// clearOrphanProfiles 清理某一平台的无主 profile 目录。
//
// 安全边界：
//  - 只处理**服务端不认识**的连接目录，绝不动仍在服务端登记的那条；
//  - 单个平台的显式调用，不提供"全部清理"；
//  - 删不掉的（浏览器占用）如实计入 skipped，不重试、不强行删。
async function clearOrphanProfiles(platform: PlatformLoginPlatform): Promise<OrphanClearOutcome> {
  if (!desktopClient) throw new Error('客户端设置尚未初始化。');
  if (activeLogin || platformLoginFlow.active || platformIPC.isBusy('request-collect')) {
    throw new PlatformBrowserError('platform_profile_busy', '平台登录正在进行，请先完成或关闭它');
  }
  const auth = await desktopClient.getAuthContext();
  const connections = await desktopClient.listPlatformConnections();
  const known = connections
    .filter((c) => String(c.platform ?? '') === platform)
    .map((c) => String(c.id ?? ''))
    .filter((id) => id !== '');
  const userData = await app.getPath('userData');
  const orphans = await orphanConnections(userData, { userId: auth.userId, platform }, known);
  let removed = 0;
  for (const connectionId of orphans) {
    const result = await removeConnectionNamespace(userData, {
      userId: auth.userId, platform, connectionId
    }).catch(() => ({ removed: false }));
    if (result.removed) removed += 1;
  }
  console.error('[platform-clear-orphans]', JSON.stringify({
    platform, found: orphans.length, removed
  }));
  return {
    performed: true,
    platform,
    found: orphans.length,
    removed,
    skipped: orphans.length - removed,
    errorCode: null
  };
}

// ---------- presence 心跳（DEV-PS33 / 20 文档 §5.2、§10.1.1） ----------
//
// 规范要求：客户端在平台开关开启时**每 30 秒发送一次 presence，即使没有任务也要发**，
// 否则空闲连接永远等不到新任务。
//
// 原来只在 request-collect 里发一次。服务端 presenceTTL 是 90 秒、调度每 10 分钟跑一次，
// 因此调度时设备早已被判离线，**自动采集完全不可能触发**。这是自动采集的阻断点。
//
// 设计约束：
//  - 只在能力可用（服务端开通平台采集）且本地已登录时发；失败静默、不弹窗、不重试成风暴。
//  - 不发 presence 期间不阻塞任何其它功能；网络问题只记一次日志。
//  - 停止时机：应用退出、平台开关关闭、未登录。

const PLATFORM_PRESENCE_INTERVAL_MS = 30_000;

let presenceTimer: NodeJS.Timeout | null = null;
let presenceInFlight = false;
let presenceLastError: string | null = null;

// startPlatformPresence 启动心跳。重复调用是幂等的。
function startPlatformPresence(): void {
  if (presenceTimer) return;
  const tick = async () => {
    if (presenceInFlight || !desktopClient) return;
    presenceInFlight = true;
    try {
      const capability = await desktopClient.getPlatformCollectionCapability();
      if (!capability.enabled) {
        // 服务端未开通平台采集：不发 presence，也把错误状态清掉。
        presenceLastError = null;
        setPresenceHealth('offline', '自动采集尚未启用。');
        return;
      }
      await desktopClient.presence();
      setPresenceHealth('online', '平台采集服务在线。');
      if (presenceLastError) {
        // 从失败恢复时记一条，便于排查"为什么之前一直离线"。
        console.error('[platform-presence] 已恢复上报');
        presenceLastError = null;
      }
    } catch (error) {
      // 静默失败：不弹窗、不打断用户。只在首次或错误变化时记一条，避免日志被刷满。
      const code = error instanceof PlatformBrowserError ? error.code : 'presence_failed';
      if (presenceLastError !== code) {
        presenceLastError = code;
        console.error('[platform-presence] 上报失败', code, describeError(error));
      }
      setPresenceHealth('error', '平台连接状态暂不可用，请检查账号登录情况。');
    } finally {
      presenceInFlight = false;
    }
  };
  // 立即发一次：不要等 30 秒，否则刚启动的客户端在调度眼里仍是离线。
  void tick();
  presenceTimer = setInterval(() => void tick(), PLATFORM_PRESENCE_INTERVAL_MS);
  // 心跳不应阻止进程退出。
  presenceTimer.unref?.();
}

// stopPlatformPresence 停止心跳（应用退出或平台开关关闭时）。
function stopPlatformPresence(): void {
  if (!presenceTimer) return;
  clearInterval(presenceTimer);
  presenceTimer = null;
}

// ---------- 后台任务循环（DEV-PS34 / 20 文档 §5.2、§10.1.1） ----------
//
// 光有 presence 心跳还不够：文档 §5.2 说"每 30 秒发 presence，否则空闲连接永远等不到新任务"，
// 但 presence 只让服务端认为设备在线；任务要**客户端主动 claim** 才会被执行。
// 原来 claim 只在用户点"开始采集"时调用一次，因此自动生成的任务会一直 queued 到超时。
//
// 这里的循环：每 30 秒尝试 claim 一次；领到就执行，没领到就等下一轮。
// 约束：同一时刻只跑一个采集（浏览器与 profile 不能并发），已经在采时跳过本轮。

const PLATFORM_CLAIM_INTERVAL_MS = 30_000;

let claimTimer: NodeJS.Timeout | null = null;
let collectInFlight = false;

// startPlatformClaimLoop 启动后台领取循环。重复调用幂等。
function startPlatformClaimLoop(): void {
  if (claimTimer) return;
  const tick = async () => {
    if (collectInFlight || !desktopClient) return;
    if (activeLogin || platformLoginFlow.active) return; // 登录中不抢 profile
    collectInFlight = true;
    try {
      const capability = await desktopClient.getPlatformCollectionCapability();
      if (!capability.enabled) {
        setCollectionHealth('idle', '自动采集尚未启用。');
        return;
      }
      const client = new PlatformClient(capability, async (operation, method, path, body) =>
        desktopClient!.platformSignedCall(operation, method, path, body));
      const run = await client.claim();
      if (!run) {
        setCollectionHealth('idle', '自动采集服务在线，正在等待任务。');
        return;
      }
      setCollectionHealth('running', '正在采集平台作品。');
      console.error('[platform-auto] 领到任务', JSON.stringify({ platform: run.platform, taskKind: run.task_kind }));
      const outcome = await runPlatformCollect(run.account_id, run);
      console.error('[platform-auto] 完成', JSON.stringify({
        runStatus: outcome.runStatus, accepted: outcome.accepted,
        rejected: outcome.rejected, errorCode: outcome.errorCode,
        // 投影失败时把原因一并记下。不记的话，日志里只有"完成"，而数据其实没进正式指标。
        adoptErrors: outcome.adoptErrors, adoptReason: outcome.adoptReason
      }));
      // PB-11：采集成功但正式指标未写入时，在桌面状态栏给出可见提醒。
      if (outcome.adoptErrors > 0) {
        setCollectionHealth('partial', `${outcome.adoptErrors} 条观测未写入正式指标，请在平台连接设置中逐条确认。`);
      } else if (outcome.runStatus === 'failed') {
        setCollectionHealth('failed', '平台采集未能完成，请检查网络和平台连接设置后重试。');
      } else {
        setCollectionHealth('idle', '自动采集已完成。');
      }
      // 自动采用失败要单独告警：这是"采集成功但数据没进正式指标"的静默失败，
      // 靠一行 JSON 容易被忽略，所以再打一条明确的中文提示。
      if (outcome.adoptErrors > 0) {
        console.error(
          `[platform-auto] 有 ${outcome.adoptErrors} 条观测已采集但未写入正式指标，原因：${outcome.adoptReason ?? '未知'}。` +
          '请在平台连接卡片里逐条确认。'
        );
      }
    } catch (error) {
      // PB-09：自动采集循环失败时显示概括原因，不把内部错误码暴露给用户。
      console.error('[platform-auto] 循环异常', describeError(error));
      setCollectionHealth('failed', '自动采集最近失败，请检查网络和平台连接设置后重试。');
    } finally {
      collectInFlight = false;
    }
  };
  claimTimer = setInterval(() => void tick(), PLATFORM_CLAIM_INTERVAL_MS);
  claimTimer.unref?.();
}

function stopPlatformClaimLoop(): void {
  if (!claimTimer) return;
  clearInterval(claimTimer);
  claimTimer = null;
}

// writeAccountProfileMeta 写"账号 slot"的 meta.json。
//
// 采集时必须靠它确认"这条 run 属于本机已登录的这个账号"。账号 slot 的目录名由
// `accountProfileSlot()` 按 (origin,user,workspace,device,platform,account) 派生，
// 与登录时的"连接命名空间"目录是**两套目录**：
//   - 连接命名空间（connectionNamespaceId）：承载平台登录态，浏览器 profile 实际所在；
//   - 账号 slot：只记归属元数据，供调度侧确认 run 与账号的对应关系。
// 两个平台在登录成功后都必须写，否则自动采集一律被判 login_required。
async function writeAccountProfileMeta(input: {
  auth: { userId: string; workspaceId: string; deviceId: string };
  accountId: string;
  platform: PlatformLoginPlatform;
  externalAccountKey: string;
  connectionId: string;
}): Promise<void> {
  const userData = await app.getPath('userData');
  const profileDir = connectionProfileDir(userData, {
    userId: input.auth.userId,
    platform: input.platform,
    connectionId: input.connectionId
  });
  await fs.mkdir(path.dirname(profileDir), { recursive: true });
  await fs.writeFile(profileMetaPath(profileDir), JSON.stringify(buildProfileMeta({
    origin: businessOrigin,
    userId: input.auth.userId,
    workspaceId: input.auth.workspaceId,
    deviceId: input.auth.deviceId,
    platform: input.platform,
    connectionId: input.connectionId,
    externalAccountKey: input.externalAccountKey,
    // 归属字段：采集侧 readAccountProfile 会校验这个 accountId。
    accountId: input.accountId,
    slotId: input.connectionId
  })), { encoding: 'utf8', mode: 0o600 });
}

// WECHAT_IDENTITY_PATH 是公众号账号列表接口。它只在页面首次进后台时由页面自己发起，
// 参数含时效性签名，构造请求恒回 `{"ret":200009}`（2026-10-21 实测），只能监听。
const WECHAT_IDENTITY_PATH = '/cgi-bin/switchacct';

// waitForWechatIdentity 等用户扫码进入后台，并在进入的瞬间捕获 switchacct。
// switchacct 是页面自己发的，且有签名；只能靠“监听已注册 + 页面跳转”触发，
// 因此这里循环：重新注册监听 → 导航到根 → 看是否捕获到。
// 已经登录时会立刻触发；停在扫码页时会一直等，直到超时。
async function waitForWechatIdentity(session: PlatformLoginSession): Promise<unknown> {
  const deadline = Date.now() + PLATFORM_LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const collected = session.cdp.collectResponses(WECHAT_IDENTITY_PATH, 12_000);
    await session.cdp.request('Page.navigate', { url: 'https://mp.weixin.qq.com/' }, 30_000).catch(() => undefined);
    const captured = await collected;
    if (captured !== null) return captured;
    // 没捕获到：可能还在扫码页，等一会儿再重试。
    await new Promise<void>((resolve) => setTimeout(resolve, PLATFORM_LOGIN_POLL_MS));
  }
  return undefined;
}

// finishWechatLogin 用导航期间捕获的 switchacct 响应完成公众号连接建立。
async function finishWechatLogin(accountId: string, payload: unknown): Promise<PlatformLoginOutcome> {
  const identity = parseWechatIdentity(payload);
  const capabilities = probeWechatCapabilities({
    backendLoggedIn: true,
    identity,
    listReadable: true,
    now: new Date().toISOString()
  }) as unknown as Record<string, unknown>;
  const created = await desktopClient!.createPlatformConnection({
    accountId,
    externalAccountKey: identity.externalAccountKey,
    consentVersion: PLATFORM_CONSENT_VERSION
  });
  const connectionId = typeof created.id === 'string' ? created.id : null;
  if (connectionId) {
    await desktopClient!.verifyPlatformConnection({
      connectionId,
      externalAccountKey: identity.externalAccountKey,
      capabilities
    });
    // 与小红书一致：写账号 slot 的 meta，否则自动采集找不到归属会判 login_required。
    const loginAuth = await desktopClient!.getAuthContext();
    await writeAccountProfileMeta({
      auth: loginAuth,
      accountId,
      platform: 'wechat_mp',
      externalAccountKey: identity.externalAccountKey,
      connectionId: accountProfileSlot({ ...loginAuth, origin: businessOrigin, accountId, platform: 'wechat_mp' })
    });
  }
  return {
    opened: true,
    connected: true,
    externalAccountKey: identity.externalAccountKey,
    connectionId,
    displayName: identity.originalID || null,
    timedOut: false,
    attempts: 1
  };
}

// isLoggedInLanding 判断导航落点是否仍处于已登录的官方后台。
// 两个平台的登录页形态不同：小红书会跳到 `/login`，公众号会停在扫码页或 `cgi-bin/loginpage`。
// 只按域名与已知登录页后缀判断，不做内容嗅探。
function isLoggedInLanding(platform: PlatformLoginPlatform, landedUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(landedUrl);
  } catch {
    return false;
  }
  if (platform === 'xhs') {
    if (parsed.hostname !== 'creator.xiaohongshu.com') return false;
    return !parsed.pathname.startsWith('/login');
  }
  if (parsed.hostname !== 'mp.weixin.qq.com') return false;
  // 公众号未登录会落在 /cgi-bin/loginpage 或带 action=scanlogin 的地址。
  if (parsed.pathname.startsWith('/cgi-bin/loginpage')) return false;
  const action = parsed.searchParams.get('action') ?? '';
  if (action.includes('scanlogin')) return false;
  return true;
}

// parseRunTargets 从 run 冻结的 binding_snapshot 里取出每篇作品的绑定与发布修订。
// 服务端提交时逐项比较，客户端必须原样回传，不能自己推断或升级修订。
function parseRunTargets(snapshot: unknown): Map<string, { bindingRevision: number; publishRevision: number }> {
  const out = new Map<string, { bindingRevision: number; publishRevision: number }>();
  if (!Array.isArray(snapshot)) return out;
  for (const item of snapshot) {
    if (!item || typeof item !== 'object') continue;
    const t = item as { external_id?: unknown; binding_revision?: unknown; publish_revision?: unknown };
    if (typeof t.external_id !== 'string' || t.external_id === '') continue;
    const bindingRevision = typeof t.binding_revision === 'number' ? t.binding_revision : Number.NaN;
    const publishRevision = typeof t.publish_revision === 'number' ? t.publish_revision : Number.NaN;
    if (!Number.isFinite(bindingRevision) || !Number.isFinite(publishRevision)) continue;
    out.set(t.external_id.toLowerCase(), { bindingRevision, publishRevision });
  }
  return out;
}

// resolveRunAccountKey 取本次任务的外部账号键。
// 优先用 run 冻结的 binding_snapshot（服务端权威值）；该快照在首版只含作品绑定时为空，
// 因此回退到连接摘要里的 external_account_key。都取不到时返回 null，
// 由调用方明确报错，不用空字符串让服务端静默丢观测。
async function resolveRunAccountKey(run: { connection_id: string; binding_snapshot: unknown }): Promise<string | null> {
  const snapshot = run.binding_snapshot;
  if (snapshot && typeof snapshot === 'object') {
    const key = (snapshot as { external_account_key?: unknown }).external_account_key;
    if (typeof key === 'string' && key.trim() !== '') return key.trim();
  }
  const summary = await desktopClient!.getPlatformConnectionSummary(run.connection_id).catch((error) => {
    console.error('[collect] connection summary failed', describeError(error));
    return null;
  });
  const fromSummary = summary && typeof summary.external_account_key === 'string' ? summary.external_account_key : '';
  if (fromSummary.trim() === '') {
    console.error('[collect] summary missing key', JSON.stringify({
      hasSummary: summary !== null,
      keys: summary ? Object.keys(summary).slice(0, 20) : []
    }));
  }
  return fromSummary.trim() !== '' ? fromSummary.trim() : null;
}

// resolveCollectProfileDir 复用登录时的 profile 命名空间，保证采集用的是同一份会话。
async function resolveCollectProfileDir(platform: string): Promise<string> {
  const auth = await desktopClient!.getAuthContext();
  return connectionProfileDir(await app.getPath('userData'), {
    userId: auth.userId,
    platform,
    connectionId: auth.connectionNamespaceId
  });
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
  if (localSettingsViewController?.isTrusted(event)) return;

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

function getLocalSettingsWindow(event: IpcMainInvokeEvent): BrowserWindow | null {
  if (localSettingsViewController?.isTrusted(event)
    && localSettingsViewController.currentHost === businessWindow
    && businessWindow && !businessWindow.isDestroyed()) return businessWindow;
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  return senderWindow && localWindows.has(senderWindow.id) ? senderWindow : null;
}

function openNativeSettings(): void {
  if (failureWindow && !failureWindow.isDestroyed() && failureWindow.isVisible()) {
    openFailureSettings(failureWindow);
    return;
  }

  if (businessWindow && !businessWindow.isDestroyed() && !businessWindow.webContents.isDestroyed()
    && isBusinessUrl(businessWindow.webContents.mainFrame.url)
    && isBusinessUrl(businessWindow.webContents.getURL())
    && !businessWindow.webContents.isLoadingMainFrame()) {
    pendingNativeSettingsRequest = false;
    if (localSettingsViewController?.currentHost === businessWindow) localSettingsViewController.detach();
    businessWindow.show();
    businessWindow.focus();
    businessWindow.webContents.send('desktop-ui:open-settings');
    return;
  }

  pendingNativeSettingsRequest = true;
  void loadBusinessPage().catch(() => {
    if (failureWindow && !failureWindow.isDestroyed()) openFailureSettings(failureWindow);
  });
}

function flushPendingNativeSettingsRequest(window: BrowserWindow): void {
  if (!pendingNativeSettingsRequest || window !== businessWindow || window.isDestroyed() || window.webContents.isDestroyed()) return;
  if (!isBusinessUrl(window.webContents.mainFrame.url) || !isBusinessUrl(window.webContents.getURL())) return;
  pendingNativeSettingsRequest = false;
  window.webContents.send('desktop-ui:open-settings');
}

function openFailureSettings(window: BrowserWindow): void {
  pendingNativeSettingsRequest = false;
  let pathname = '';
  try {
    pathname = new URL(window.webContents.getURL()).pathname;
  } catch {
    return;
  }
  if (pathname === '/offline/') {
    void window.loadURL(`${SETTINGS_PROTOCOL_ORIGIN}/`);
    return;
  }
  if (pathname !== '/') return;
  window.show();
  window.focus();
  if (pendingPlatformLoginTarget && !window.webContents.isLoading()) {
    window.webContents.send('settings:platform-login-target', {
      accountId: pendingPlatformLoginTarget.accountId,
      platform: pendingPlatformLoginTarget.platform
    });
    pendingPlatformLoginTarget = null;
  }
}

function showLocalSettingsView(window: BrowserWindow, panel: LocalSettingsPanel): void {
  if (window !== businessWindow || window.isDestroyed() || window.webContents.isDestroyed()
    || !isBusinessUrl(window.webContents.mainFrame.url) || !isBusinessUrl(window.webContents.getURL())) return;
  if (!localSettingsSession) throw new Error('本机设置会话尚未初始化。');
  if (!localSettingsViewController || localSettingsViewController.isDestroyed) {
    localSettingsViewController = createLocalSettingsViewController({
      registry: localSettingsSenderRegistry,
      createView: () => {
        const view = new WebContentsView({
          webPreferences: {
            session: localSettingsSession!,
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true,
            webviewTag: false,
            devTools: !app.isPackaged
          }
        });
        view.webContents.setWindowOpenHandler(({ url }) => {
          const intent = parseDesktopUiIntent(url);
          if (intent && isBusinessWindowOnlyIntent(intent)) return { action: 'deny' };
          if (intent?.type === 'settings-close') requestCloseLocalSettingsFromView(window);
          else if (intent) applyDesktopUiIntent(window, intent);
          return { action: 'deny' };
        });
        view.webContents.on('will-navigate', (event, url) => {
          if (parseEmbeddedSettingsPanel(url)) return;
          event.preventDefault();
          const intent = parseDesktopUiIntent(url);
          if (intent && isBusinessWindowOnlyIntent(intent)) return;
          if (intent?.type === 'settings-close') requestCloseLocalSettingsFromView(window);
          else if (intent) applyDesktopUiIntent(window, intent);
        });
        view.webContents.on('will-frame-navigate', (details) => {
          if (!details.isMainFrame || !parseEmbeddedSettingsPanel(details.url)) details.preventDefault();
        });
        view.webContents.on('will-redirect', (details) => {
          if (!parseEmbeddedSettingsPanel(details.url)) details.preventDefault();
        });
        view.webContents.on('did-finish-load', () => {
          if (localSettingsViewController?.currentPanel !== 'account-device' || !pendingPlatformLoginTarget) return;
          sendPlatformLoginTarget(view.webContents);
        });
        return view;
      }
    });
  }
  void localSettingsViewController.show(window, panel).then(() => {
    if (panel === 'account-device' && pendingPlatformLoginTarget
      && localSettingsViewController?.currentPanel === 'account-device') {
      const view = localSettingsViewController;
      // did-finish-load delivers the target for a newly loaded panel; this covers a reused panel.
      if (view.currentHost === window) sendPlatformLoginTargetForCurrentView();
    }
  }).catch((error) => {
    console.error('[settings] failed to show local panel', error instanceof Error ? error.message : 'unknown');
  });
}

function sendPlatformLoginTarget(webContents: Electron.WebContents): void {
  if (!pendingPlatformLoginTarget || webContents.isDestroyed()) return;
  webContents.send('settings:platform-login-target', {
    accountId: pendingPlatformLoginTarget.accountId,
    platform: pendingPlatformLoginTarget.platform
  });
  pendingPlatformLoginTarget = null;
}

function sendPlatformLoginTargetForCurrentView(): void {
  if (!localSettingsViewController || localSettingsViewController.isDestroyed
    || localSettingsViewController.currentPanel !== 'account-device'
    || localSettingsViewController.currentHost !== businessWindow) return;
  const webContents = localSettingsViewController.webContents;
  if (webContents && !webContents.isLoading()) sendPlatformLoginTarget(webContents);
}

function requestCloseLocalSettingsFromView(window: BrowserWindow): void {
  if (localSettingsViewController?.currentHost !== window) return;
  openNativeSettings();
}

function showFailureWindow(): void {
  if (failureWindow && !failureWindow.isDestroyed()) {
    failureWindow.show();
    failureWindow.focus();
    if (pendingNativeSettingsRequest) openFailureSettings(failureWindow);
    return;
  }

  failureWindow = createLocalWindow('OPS Desktop — 无法连接', 'ops-desktop://settings/offline/');
  const currentWindow = failureWindow;
  currentWindow.on('closed', () => {
    localWindows.delete(currentWindow.id);
    failureWindow = null;
  });
  if (pendingNativeSettingsRequest) currentWindow.webContents.once('did-finish-load', () => openFailureSettings(currentWindow));
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
    if (intent && isBusinessWindowOnlyIntent(intent)) return { action: 'deny' };
    if (intent) applyDesktopUiIntent(window, intent);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, nextUrl) => {
    const intent = parseDesktopUiIntent(nextUrl);
    if (intent) {
      event.preventDefault();
      if (!isBusinessWindowOnlyIntent(intent)) applyDesktopUiIntent(window, intent);
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

async function runBusinessPlatformAccountSyncIntent(
  window: BrowserWindow,
  intent: Extract<DesktopUiIntent, { type: 'platform-account-sync' }>
): Promise<void> {
  const canRespond = () => window === businessWindow && !window.isDestroyed() && !window.webContents.isDestroyed()
    && isBusinessUrl(window.webContents.mainFrame.url) && isBusinessUrl(window.webContents.getURL());
  if (!canRespond()) return;
  const sendResult = (status: PlatformIntentResult['status'], message?: string) => {
    if (!canRespond()) return;
    window.webContents.send(PLATFORM_INTENT_RESULT_CHANNEL, {
      kind: intent.type,
      requestId: intent.requestId,
      accountId: intent.accountId,
      status,
      ...(message ? { message: message.slice(0, 200) } : {})
    } satisfies PlatformIntentResult);
  };

  if (accountDataClearInProgress) {
    sendResult('failed', '账号本机数据正在清理，请稍后重试。');
    return;
  }

  const response = await runPlatformCommand({
    v: 1,
    id: intent.requestId,
    cmd: 'request-account-sync',
    payload: {
      accountId: intent.accountId,
      mode: intent.mode,
      connectionRevision: intent.connectionRevision
    }
  });
  if (!response.ok) {
    sendResult('failed', response.error.message);
    return;
  }

  const data = response.data;
  const status = typeof data === 'object' && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>).status
    : null;
  if (status === 'queued' || status === 'existing' || status === 'no_targets') {
    sendResult(status);
    return;
  }
  sendResult('failed', '同步服务返回结果无效，请刷新进度后重试。');
}

// 业务窗口发起的本机平台动作统一走这里：先确认回执能安全投递，再把结果原样转成
// 四态回执（queued/existing/no_targets/failed），不把服务端错误结构直接暴露给渲染进程。
function businessIntentResponder(window: BrowserWindow, requestId: string) {
  const canRespond = () => window === businessWindow && !window.isDestroyed() && !window.webContents.isDestroyed()
    && isBusinessUrl(window.webContents.mainFrame.url) && isBusinessUrl(window.webContents.getURL());
  return {
    canRespond,
    send<T extends { requestId: string }>(channel: string, payload: Omit<T, 'requestId'>): void {
      if (!canRespond()) return;
      window.webContents.send(channel, { requestId, ...payload });
    }
  };
}

async function runBusinessPlatformMetricsRefreshIntent(
  window: BrowserWindow,
  intent: Extract<DesktopUiIntent, { type: 'platform-metrics-refresh' }>
): Promise<void> {
  const responder = businessIntentResponder(window, intent.requestId);
  if (!responder.canRespond()) return;
  const sendResult = (status: PlatformIntentResult['status'], message?: string, operationId?: string) => {
    responder.send<PlatformIntentResult>(PLATFORM_INTENT_RESULT_CHANNEL, {
      kind: intent.type,
      accountId: intent.accountId,
      status,
      ...(operationId ? { operationId } : {}),
      ...(message ? { message: message.slice(0, 200) } : {})
    });
  };

  if (accountDataClearInProgress) {
    sendResult('failed', '账号本机数据正在清理，请稍后重试。');
    return;
  }

  const response = await runPlatformCommand({
    v: 1,
    id: intent.requestId,
    cmd: 'request-metrics-refresh',
    payload: {
      accountId: intent.accountId,
      connectionRevision: intent.connectionRevision,
      ...(intent.platformWorkId ? { platformWorkIds: [intent.platformWorkId] } : {})
    }
  });
  if (!response.ok) {
    sendResult('failed', response.error.message);
    return;
  }

  const data = typeof response.data === 'object' && response.data !== null && !Array.isArray(response.data)
    ? response.data as Record<string, unknown>
    : null;
  const status = data?.status;
  const operation = typeof data?.operation === 'object' && data.operation !== null && !Array.isArray(data.operation)
    ? data.operation as Record<string, unknown>
    : null;
  const operationId = typeof operation?.id === 'string'
    && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(operation.id)
    ? operation.id
    : undefined;
  if (status === 'queued' || status === 'existing' || status === 'no_targets') {
    if (!operationId) {
      sendResult('failed', '指标刷新服务未返回有效的操作编号，请刷新进度后重试。');
      return;
    }
    sendResult(status, undefined, operationId);
    return;
  }
  sendResult('failed', '指标刷新服务返回结果无效，请刷新进度后重试。');
}

async function runBusinessPlatformSyncResumeIntent(
  window: BrowserWindow,
  intent: Extract<DesktopUiIntent, { type: 'platform-sync-resume' }>
): Promise<void> {
  const responder = businessIntentResponder(window, intent.requestId);
  if (!responder.canRespond()) return;
  const sendResult = (status: PlatformIntentResult['status'], message?: string) => {
    responder.send<PlatformIntentResult>(PLATFORM_INTENT_RESULT_CHANNEL, {
      kind: intent.type,
      accountId: intent.accountId,
      operationId: intent.operationId,
      status,
      ...(message ? { message: message.slice(0, 200) } : {})
    });
  };

  if (accountDataClearInProgress) {
    sendResult('failed', '账号本机数据正在清理，请稍后重试。');
    return;
  }

  const response = await runPlatformCommand({
    v: 1,
    id: intent.requestId,
    cmd: 'resume-platform-sync',
    payload: {
      accountId: intent.accountId,
      operationId: intent.operationId,
      expectedOperationRevision: intent.expectedOperationRevision
    }
  });
  if (!response.ok) {
    sendResult('failed', response.error.message);
    return;
  }

  const data = typeof response.data === 'object' && response.data !== null && !Array.isArray(response.data)
    ? response.data as Record<string, unknown>
    : null;
  const operation = typeof data?.operation === 'object' && data.operation !== null && !Array.isArray(data.operation)
    ? data.operation as Record<string, unknown>
    : null;
  if (!operation || operation.id !== intent.operationId) {
    sendResult('failed', '继续同步服务返回结果无效，请刷新进度后重试。');
    return;
  }
  sendResult('queued');
}

function applyDesktopUiIntent(window: BrowserWindow, intent: DesktopUiIntent): void {
  if (intent.type === 'platform-account-sync') {
    if (window === businessWindow) void runBusinessPlatformAccountSyncIntent(window, intent);
    return;
  }

  if (intent.type === 'platform-metrics-refresh') {
    if (window === businessWindow) void runBusinessPlatformMetricsRefreshIntent(window, intent);
    return;
  }

  if (intent.type === 'platform-sync-resume') {
    if (window === businessWindow) void runBusinessPlatformSyncResumeIntent(window, intent);
    return;
  }

  if (intent.type === 'settings') {
    openNativeSettings();
    return;
  }

  if (intent.type === 'settings-pane') {
    showLocalSettingsView(window, intent.panel);
    return;
  }

  if (intent.type === 'settings-detach') {
    if (localSettingsViewController?.currentHost === window) localSettingsViewController.detach();
    return;
  }

  if (intent.type === 'settings-close') {
    if (localSettingsViewController
      && (!localSettingsViewController.currentHost || localSettingsViewController.currentHost === window)) {
      localSettingsViewController.destroy();
      localSettingsViewController = null;
      pendingPlatformLoginTarget = null;
      void platformLoginFlow.stop();
    }
    return;
  }

  if (intent.type === 'platform-login') {
    pendingPlatformLoginTarget = intent;
    if (localSettingsViewController?.currentHost === businessWindow
      && localSettingsViewController.currentPanel === 'account-device') {
      sendPlatformLoginTargetForCurrentView();
    }
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

async function flushBusinessWindowBeforeQuit(): Promise<boolean> {
  const window = businessWindow;
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return true;
  const url = window.webContents.getURL();
  if (!isBusinessUrl(url)) return true;
  const script = `new Promise((resolve) => {
    let settled = false;
    const checks = [];
    const grants = [];
    const finish = (allowed) => {
      if (settled) return;
      settled = true;
      clearTimeout(rendererTimeout);
      resolve(allowed);
    };
    const rendererTimeout = setTimeout(() => finish(false), 12000);
    const detail = {
      reserveNavigation: true,
      register: (check) => { if (typeof check === 'function') checks.push(check); },
      grant: (grant) => { if (typeof grant === 'function') grants.push(grant); }
    };
    window.dispatchEvent(new CustomEvent('ops:desktop-leave-guard-request', { detail }));
    Promise.all(checks.map(async (check) => {
      try { return await check(); } catch { return false; }
    })).then((results) => {
      if (settled) return;
      const allowed = results.every((result) => result === true);
      if (allowed) {
        try { grants.forEach((grant) => grant()); } catch { finish(false); return; }
      }
      finish(allowed);
    }, () => finish(false));
  })`;
  let timeout: NodeJS.Timeout | undefined;
  try {
    const allowed = await Promise.race([
      window.webContents.executeJavaScript(script, true),
      new Promise<boolean>((resolve) => { timeout = setTimeout(() => resolve(false), 15_000); })
    ]);
    if (timeout) clearTimeout(timeout);
    if (!allowed) console.warn('[quit-guard] 作品保存失败或等待超时，已取消退出');
    return allowed === true;
  } catch (error) {
    if (timeout) clearTimeout(timeout);
    console.error('[quit-guard] 无法确认作品保存状态，已取消退出', describeError(error));
    return false;
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
      detail: `退出前会先尝试保存业务页面中尚未提交的内容；保存失败或等待超时会取消退出。当前有 ${activeRequests} 条本机模型调用正在进行。退出会终止这些调用，模型服务可能已经计费；客户端不会自动重发。`,
      buttons: ['继续使用', '退出客户端'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    };
    const { response } = parent && !parent.isDestroyed()
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options);
    if (response !== 1) return;
    const workSaved = await flushBusinessWindowBeforeQuit();
    if (!workSaved) {
      const warning: Electron.MessageBoxOptions = {
        type: 'warning',
        title: '已取消退出',
        message: '业务页面还有内容未能确认保存。',
        detail: '请返回作品页，等待保存完成后再退出 OPS Desktop。',
        buttons: ['返回应用'],
        defaultId: 0,
        noLink: true
      };
      if (parent && !parent.isDestroyed()) await dialog.showMessageBox(parent, warning);
      else await dialog.showMessageBox(warning);
      return;
    }
    await platformLoginFlow.stop();
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
        { label: 'AI 连接设置…', click: () => openNativeSettings() },
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
