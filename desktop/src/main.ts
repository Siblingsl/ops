// stdio-guard 必须排在 electron 之前：模块加载时即 patch write，避免 EPIPE 弹窗。
import { installBrokenPipeGuard } from './stdio-guard';
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
  type IpcMainInvokeEvent,
  type Session,
  type WebContents
} from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureProductBridge, startBrowserBridgeDiagnostics, stopActiveBridge } from './browser-bridge';
import type { McpHostManager } from './mcp-host';
import { registerMcpIpcHandlers } from './ipc/mcp';
import { registerVoiceIpcHandlers, setRealtimeBridge } from './ipc/voice';
import { registerComputerIpcHandlers, setComputerWorkerHost } from './ipc/computer';
import { registerCXIpcHandlers } from './ipc/cx';
import { registerPublishPackIpcHandlers } from './ipc/publish-pack';
import { registerDesktopUiIpcHandlers } from './ipc/desktop-ui';
// OPT-E02（docs/43 §5）：只读版本更新检查——通道在 ipc/update.ts，检查器在 update-check.ts。
import { registerDesktopUpdateIpcHandlers, DESKTOP_UI_UPDATE_STATUS_CHANNEL } from './ipc/update';
import { createDesktopUpdateChecker, type DesktopUpdateChecker } from './update-check';
import { registerInBrowseIpcHandlers } from './ipc/inbrowse';
import { registerBrowserIpcHandlers } from './ipc/browser';
import { registerSettingsIpcHandlers } from './ipc/settings';
import { ComputerWorkerHost } from './computer-worker-host';
import { bindInBrowseController, type InBrowseViewController } from './in-browse';
import { RealtimeBridge, type RealtimeBridgeEvent } from './voice-realtime';

// 补上非 EPIPE 未捕获异常的展示（防护本身已在 import 时装好）。
installBrokenPipeGuard((error) => {
  const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
  const show = () => {
    try {
      dialog.showErrorBox('A JavaScript error occurred in the main process', text);
    } catch {
      // 对话框也不可用时放弃；避免二次异常。
    }
  };
  if (app.isReady()) show();
  else void app.whenReady().then(show);
});
import {
  PRODUCTION_API_ORIGIN,
  PRODUCTION_BUSINESS_UI_ORIGIN,
  PRODUCTION_SERVICE_NAMESPACE,
  isBusinessOriginUrl,
  resolveApiOrigin,
  resolveBusinessOrigin,
  resolveServiceNamespace
} from './business-origin';
import { DesktopClient } from './desktop-client';
import { registerDesktopPowerHandlers } from './power-lifecycle';
import { PlatformBrowserError } from './platform-worker';
import {
  isBusinessWindowOnlyIntent,
  parseDesktopUiIntent,
  CLIENT_HEALTH_CHANNEL,
  type DesktopClientHealth,
  type DesktopUiIntent
} from './ui-intents';
import {
  createLocalSettingsViewController,
  EmbeddedSettingsSenderRegistry,
  parseEmbeddedSettingsPanel,
  type LocalSettingsPanel
} from './settings-view';
import { PlatformLoginFlow } from './platform-login-flow';
import { startPlatformLogin, savePlatformLogin } from './platform-login-runtime';
import {
  configureLocalProtocol,
  connectRealtimeWebSocket,
  installBusinessPermissions,
  installDesktopRequestContext,
  installDownloadHandling,
  registerLocalProtocol
} from './main/protocol';
import {
  configurePlatformCollect,
  describeError,
  isPlatformLoginActive,
  readPlatformBrowserStatus,
  runPlatformCommand,
  type PlatformBrowserStatus
} from './main/platform-collect';
import {
  configurePlatformLoop,
  isCollectInFlight,
  startBenchmarkObserveLoop as startBenchmarkObserveLoopImpl,
  startPlatformClaimLoop as startPlatformClaimLoopImpl,
  startPlatformPresence as startPlatformPresenceImpl,
  stopBenchmarkObserveLoop as stopBenchmarkObserveLoopImpl,
  stopPlatformClaimLoop as stopPlatformClaimLoopImpl,
  stopPlatformPresence as stopPlatformPresenceImpl
} from './main/platform-loop';
import {
  configurePublishLoop,
  startPlatformPublishLoop,
  stopPlatformPublishLoop
} from './main/publish-loop';
import {
  configureExecutors,
  startBrowserCommandExecutor as startBrowserCommandExecutorImpl,
  startComputerCommandExecutor as startComputerCommandExecutorImpl,
  startMcpCallExecutor as startMcpCallExecutorImpl,
  stopBrowserCommandExecutor as stopBrowserCommandExecutorImpl,
  stopComputerCommandExecutor as stopComputerCommandExecutorImpl,
  stopMcpCallExecutor as stopMcpCallExecutorImpl
} from './main/executors';
import {
  applyDesktopUiIntent,
  configureBusinessIntents,
  parseDesktopRoute,
  parseSaveModelInput
} from './main/business-intents';

export type { PlatformBrowserStatus } from './main/platform-collect';
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

// 测试/验收辅助（仅显式环境变量触发）：开 CDP 远程调试口，供授权的自动化登录注入。
// 不设该变量时行为与原先完全一致（口不开）。
if (process.env.OPS_DESKTOP_REMOTE_DEBUGGING_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.OPS_DESKTOP_REMOTE_DEBUGGING_PORT);
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
      supportFetchAPI: true,
      corsEnabled: true
    }
  }
]);

let businessWindow: BrowserWindow | null = null;
let pendingPlatformLoginTarget: Extract<DesktopUiIntent, { type: 'platform-login' }> | null = null;
let failureWindow: BrowserWindow | null = null;
let businessLoadTimeout: ReturnType<typeof setTimeout> | null = null;
let businessFailureReason: 'unreachable' | 'icp-block' | 'render-failed' = 'unreachable';
let businessOrigin = PRODUCTION_BUSINESS_UI_ORIGIN;
let apiOrigin = PRODUCTION_API_ORIGIN;
let serviceNamespace = PRODUCTION_SERVICE_NAMESPACE;
let businessPartition = 'persist:ops-business-production';
let businessSession: Session | null = null;
let localSettingsSession: Session | null = null;
let localSettingsViewController: ReturnType<typeof createLocalSettingsViewController> | null = null;
let pendingNativeSettingsRequest = false;
let desktopClient: DesktopClient | null = null;
// OPT-E02：进程内单例检查器；通过固定 IPC 暴露给业务窗口，并在退出时 dispose。
let desktopUpdateChecker: DesktopUpdateChecker | null = null;
let clientHealthTimer: NodeJS.Timeout | null = null;
let collectionHealth: DesktopClientHealth['collection'] = { status: 'idle', message: '自动采集状态尚未更新。', updatedAt: null };
let presenceHealth: DesktopClientHealth['presence'] = { status: 'unknown', message: '平台连接状态尚未更新。', updatedAt: null };
let lastClientHealthPayload = '';
let externalPromptOpen = false;
const localWindows = new Set<number>();
const localSettingsSenderRegistry = new EmbeddedSettingsSenderRegistry();
const activeCXLongImageCaptures = new Set<string>();
let routingRefreshPending = false;
let routingRefresh: Promise<void> | null = null;
let accountDataClearInProgress = false;
let nativeStatusMenuItem: Electron.MenuItem | null = null;
let nativeStatusRevision = 0;
let quitConfirmed = false;
let quitDialogOpen = false;
let desktopTheme: 'light' | 'dark' = 'light';
let desktopReducedMotion: boolean | null = null;

const platformLoginFlow = new PlatformLoginFlow({
  async context() {
    if (!desktopClient) throw new Error('客户端尚未初始化');
    const { userId, workspaceId, deviceId } = await desktopClient.getAuthContext();
    return { origin: serviceNamespace, userId, workspaceId, deviceId };
  },
  async account(accountId, platform) {
    const account = (await desktopClient!.listBusinessAccounts()).find((item) => item.id === accountId && item.platform === platform && item.status === 'active');
    if (!account) throw new PlatformBrowserError('platform_account_unavailable', '目标账号不存在或已停用');
    return account;
  },
  async start(scope, family, operationId) { return startPlatformLogin(desktopClient!, app.getPath('userData'), scope, family, operationId); },
  async save(scope, identity, handle, recoverOnly, signal) { return savePlatformLogin(desktopClient!, app.getPath('userData'), scope, identity, handle, recoverOnly, signal); }
});

// OPT-E04a：循环/执行器实现已拆到 main/*.ts；这里保留同名薄委托，启动与退出调用点不变。
function startPlatformPresence(): void { startPlatformPresenceImpl(); }
function stopPlatformPresence(): void { stopPlatformPresenceImpl(); }
function startPlatformClaimLoop(): void { startPlatformClaimLoopImpl(); }
function stopPlatformClaimLoop(): void { stopPlatformClaimLoopImpl(); }
function startBenchmarkObserveLoop(): void { startBenchmarkObserveLoopImpl(); }
function stopBenchmarkObserveLoop(): void { stopBenchmarkObserveLoopImpl(); }
function startBrowserCommandExecutor(): void { startBrowserCommandExecutorImpl(); }
function stopBrowserCommandExecutor(): void { stopBrowserCommandExecutorImpl(); }
function startComputerCommandExecutor(): void { startComputerCommandExecutorImpl(); }
function stopComputerCommandExecutor(): void { stopComputerCommandExecutorImpl(); }
function startMcpCallExecutor(): void { startMcpCallExecutorImpl(); }
function stopMcpCallExecutor(): void { stopMcpCallExecutorImpl(); }

function setCollectionHealth(status: DesktopClientHealth['collection']['status'], message: string): void {
  collectionHealth = { status, message: message.slice(0, 200), updatedAt: Date.now() };
  broadcastClientHealth();
}

function setPresenceHealth(status: DesktopClientHealth['presence']['status'], message: string): void {
  presenceHealth = { status, message: message.slice(0, 200), updatedAt: Date.now() };
  broadcastClientHealth();
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
    configureLocalProtocol({
      localPages: LOCAL_PAGES,
      desktopRoot: path.resolve(__dirname, '..'),
      getDesktopTheme: () => desktopTheme,
      getDesktopReducedMotion: () => desktopReducedMotion,
      getBusinessWindow: () => businessWindow,
      getDesktopClient: () => desktopClient,
      getApiOrigin: () => apiOrigin,
      getBusinessOrigin: () => businessOrigin,
      isBusinessUrl,
      isRoutingRefreshPending: () => routingRefreshPending,
      isAccountDataClearInProgress: () => accountDataClearInProgress,
      refreshDesktopRequestContext,
      stopPlatformLoginFlow: () => platformLoginFlow.stop()
    });
    configurePlatformCollect({
      getDesktopClient: () => desktopClient,
      getPlatformLoginFlow: () => platformLoginFlow,
      getServiceNamespace: () => serviceNamespace
    });
    configurePlatformLoop({
      getDesktopClient: () => desktopClient,
      isPlatformLoginActive,
      setPresenceHealth,
      setCollectionHealth
    });
    configurePublishLoop({
      getDesktopClient: () => desktopClient,
      getServiceNamespace: () => serviceNamespace,
      isPlatformLoginActive,
      isCollectInFlight
    });
    configureExecutors({
      getDesktopClient: () => desktopClient,
      getMcpHostManager: () => mcpHostManager,
      getComputerWorkerHost: () => computerWorkerHost
    });
    configureBusinessIntents({
      getBusinessWindow: () => businessWindow,
      isBusinessUrl,
      getAccountDataClearInProgress: () => accountDataClearInProgress,
      openNativeSettings,
      showLocalSettingsView,
      sendPlatformLoginTargetForCurrentView,
      localSettingsViewController: {
        get: () => localSettingsViewController,
        set: (value) => { localSettingsViewController = value; }
      },
      pendingPlatformLoginTarget: {
        set: (value) => { pendingPlatformLoginTarget = value; },
        clear: () => { pendingPlatformLoginTarget = null; }
      },
      platformLoginFlow,
      setDesktopTheme: (theme) => { desktopTheme = theme; },
      setDesktopReducedMotion: (reduced) => { desktopReducedMotion = reduced; },
      applyDesktopThemeToWindow,
      applyDesktopMotionToWindow
    });
    try {
      desktopTheme = await restoreDesktopTheme();
      desktopReducedMotion = await restoreDesktopMotion();
      nativeTheme.themeSource = desktopTheme;
      businessOrigin = resolveBusinessOrigin(app.isPackaged, process.env.OPS_DESKTOP_DEV_URL);
      apiOrigin = resolveApiOrigin(app.isPackaged, businessOrigin);
      serviceNamespace = resolveServiceNamespace(app.isPackaged, businessOrigin);
      businessPartition = app.isPackaged
        ? 'persist:ops-business-production'
        : 'persist:ops-business-development';

      businessSession = session.fromPartition(businessPartition);
      localSettingsSession = session.fromPartition('ops-settings');
      desktopClient = new DesktopClient(businessSession, apiOrigin, serviceNamespace);
      // OPT-E02：更新检查器只读 app.getVersion() 与 apiOrigin，不写任何本机文件。
      // 发现新版本时仅推送状态给业务窗口，由底栏温和提示；绝不自动弹窗。
      desktopUpdateChecker = createDesktopUpdateChecker({
        currentVersion: () => app.getVersion(),
        apiOrigin: () => apiOrigin,
        onStatus: (status) => {
          const window = businessWindow;
          if (!window || window.isDestroyed() || window.webContents.isDestroyed()
            || !isBusinessUrl(window.webContents.getURL())) return;
          window.webContents.send(DESKTOP_UI_UPDATE_STATUS_CHANNEL, status);
        },
      });
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
      installDesktopRequestContext(businessSession, apiOrigin);
      installDownloadHandling(businessSession);
      await registerLocalProtocol(businessSession);
      await registerLocalProtocol(localSettingsSession);
      // A30b（用户拍板：常驻启动）：产品路径无条件启动浏览器桥，监听 127.0.0.1:8765，
      // 供 OPS 扩展经 native host 连接；启动失败（端口被占等）如实降级不崩溃。
      // 27 §12.5 红线保留：全局无沙箱模式下必须关闭浏览器执行桥，不得为联调打开。
      if (process.env.OPS_DESKTOP_NO_SANDBOX === '1') {
        console.log('[browser-bridge] OPS_DESKTOP_NO_SANDBOX=1：浏览器执行桥已关闭；恢复正常模式后重启以启用。');
      } else {
        const bridgeReady = await ensureProductBridge();
        if (!bridgeReady) {
          console.log('[browser-bridge] 桥未能常驻启动；本次会话浏览器协作相关功能将如实报"桥未运行"。');
        }
        if (process.env.OPS_DESKTOP_BRIDGE_DIAG === '1') {
          await startBrowserBridgeDiagnostics();
        }
      }
      registerIpcHandlers();
      installApplicationMenu();
      const restoredMode = await desktopClient.restoreAppliedMode();
      void updateNativeClientStatus();
      // 平台采集 presence 心跳：只在服务端开通且本地已登录时真正上报，
      // 由 tick 内部判断，这里直接启动即可（重复调用幂等）。
      startPlatformPresence();
      // REF41 P2：发布任务优先于采集领取。两个循环共用同一个平台 profile，
      // 且都以 30 秒为周期；如果采集先注册定时器，它会在每个周期边界先抢到
      // profile，发布任务可能长期饿死。发布任务由用户动作触发、数量有限，
      // 因此先注册发布循环，让它在同一周期边界先拿到 claim 机会。
      startPlatformPublishLoop();
      startPlatformClaimLoop();
      // REF41 I1-A5：竞对公开页只读观测，与平台采集 profile 隔离。
      startBenchmarkObserveLoop();
      startBrowserCommandExecutor();
      startComputerCommandExecutor();
      startMcpCallExecutor();
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
      // DT-03：统一清理（两条退出路径共用，见 disposeApplicationResources）。
      disposeApplicationResources();
      return;
    }
    event.preventDefault();
    void confirmApplicationQuit(businessWindow ?? failureWindow ?? null);
  });
}

// Q-27（docs/41，16 文档 §15.3 200% 文本放大）：业务窗菜单收纳于自绘标题栏，
// Windows 下菜单 role 缩放加速键（Ctrl+=/Ctrl+-/Ctrl+0）不经菜单路径触发，
// 键盘用户没有可用的页面缩放入口。在 webContents 层注册 before-input-event
// 拦截同一组加速键，映射与菜单 role 一致的 zoomLevel（±0.5/步，0=100%），
// 上限 clamp 在 ±5（约 200%+，Electron 缩放档位与 Chromium 一致）。
function installWebContentsZoomShortcuts(contents: WebContents): void {
  const minLevel = -5;
  const maxLevel = 5;
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !input.control || input.alt || input.meta || input.shift) return;
    let delta: number | null = null;
    if (input.key === '=' || input.key === '+') {
      delta = 0.5;
    } else if (input.key === '-') {
      delta = -0.5;
    } else if (input.key === '0') {
      if (contents.getZoomLevel() === 0) return;
      event.preventDefault();
      contents.setZoomLevel(0);
      return;
    } else {
      return;
    }
    event.preventDefault();
    const next = Math.min(maxLevel, Math.max(minLevel, contents.getZoomLevel() + delta));
    contents.setZoomLevel(next);
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
  installWebContentsZoomShortcuts(currentWindow.webContents);
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

  // OPT-E02：业务窗口就绪后延迟 15s 做一次静默检查；只推状态，不弹窗打断写稿。
  desktopUpdateChecker?.scheduleStartupCheck();
}


// DEV-AI27-17（W17b，A12）：电脑控制 worker 宿主单例；退出前必须回收 fork 出的隔离进程。
let computerWorkerHost: ComputerWorkerHost | null = null;
// DT-03：退出清理需要触达的常驻资源单例。此前是 registerIpcHandlers 的函数局部变量，
// 两条退出路径都摸不到它们（realtimeBridge 只在 voice:realtime-stop 停、
// mcpHostManager 只有按连接 stop），属退出清理不完整的根因之一。
let realtimeBridge: RealtimeBridge | null = null;
let mcpHostManager: McpHostManager | null = null;

/** DT-03：单个清理步骤的容错包装——记录失败但不阻断退出序列。 */
function safeDispose(name: string, dispose: () => void | Promise<void>): void {
  try {
    const result = dispose();
    if (result instanceof Promise) {
      result.catch((error) => console.error(`[dispose] ${name} 异步清理失败`, describeError(error)));
    }
  } catch (error) {
    console.error(`[dispose] ${name} 清理失败`, describeError(error));
  }
}

/** DT-03（docs/33 §10.7）：应用退出统一清理。修复前两条退出路径各自只停一部分：
 * before-quit 只停 presence/claimLoop/executor/desktopClient；confirmApplicationQuit
 * 只停 loginFlow/worker/desktopClient——realtimeBridge、mcpHostManager、浏览器桥
 * （8765 常驻监听）与在途长图捕获两边都没有。现在两条路径都只调用本函数；
 * 顺序按「先停事件源与循环 → 再停本机能力 → 最后断服务端通道」，清理失败记日志
 * 不影响退出。 */
function disposeApplicationResources(): void {
  safeDispose('platform presence', stopPlatformPresence);
  safeDispose('platform claim loop', stopPlatformClaimLoop);
  safeDispose('platform publish loop', stopPlatformPublishLoop);
  safeDispose('benchmark observe loop', stopBenchmarkObserveLoop);
  safeDispose('browser command executor', stopBrowserCommandExecutor);
  safeDispose('computer command executor', stopComputerCommandExecutor);
  safeDispose('mcp call executor', stopMcpCallExecutor);
  safeDispose('platform login flow', () => void platformLoginFlow.stop());
  safeDispose('realtime bridge', () => realtimeBridge?.stop());
  safeDispose('mcp host connections', () => mcpHostManager?.stopAll());
  safeDispose('computer worker host', () => {
    // DEV-CU P3-6：退出清理。快照/截图按 grant 存于 worker 进程内存（C02 不落盘），
    // host.stop() 结束 worker 进程即全部失效（computer-worker/index.js:26 exit 钩子兜底）；
    // 运行期失权路径走 computer:uia-invalidate / capture_invalidate 固定意图。
    computerWorkerHost?.stop();
    computerWorkerHost = null;
  });
  safeDispose('browser bridge', stopActiveBridge);
  safeDispose('long image captures', () => {
    // 在途捕获的窗口资源由 captureCXLongImageFromBuild 的 finally 自行回收；
    // 退出时只清空占用标记，让 capture_busy 门不再阻塞新会话启动。
    activeCXLongImageCaptures.clear();
  });
  safeDispose('desktop update checker', () => desktopUpdateChecker?.dispose());
  safeDispose('desktop client', () => desktopClient?.disconnect());
}

function registerIpcHandlers(): void {
  // DEV-AI27-16 第六批（A2）：realtime 桥单例——事件转发到业务窗口；调用方限业务窗口主框架。
  realtimeBridge = new RealtimeBridge({
    connect: (url) => connectRealtimeWebSocket(url),
    now: () => Date.now(),
  });
  realtimeBridge.on('event', (ev: RealtimeBridgeEvent) => {
    if (businessWindow && !businessWindow.isDestroyed()) {
      businessWindow.webContents.send('desktop-ui:realtime-event', ev);
    }
  });
  const requireRealtimeCaller = (event: IpcMainInvokeEvent): RealtimeBridge => {
    const senderFrame = event.senderFrame;
    if (!businessWindow || businessWindow.isDestroyed() || event.sender !== businessWindow.webContents
      || !senderFrame || senderFrame !== event.sender.mainFrame || !isBusinessUrl(senderFrame.url)
      || !isBusinessUrl(event.sender.getURL())
      || !realtimeBridge) {
      throw new Error('不允许此窗口调用实时语音意图。');
    }
    return realtimeBridge;
  };
  // DEV-AI27-08（W08，D-172）：内置浏览视图固定意图（27 §7.8/§12.5）。
  // 仅业务窗口主框架可调用；bounds/导航/浮层隐藏由主进程持有，渲染器无 view 对象。
  const requireInBrowse = (event: IpcMainInvokeEvent): InBrowseViewController => {
    const senderFrame = event.senderFrame;
    if (!businessWindow || businessWindow.isDestroyed() || event.sender !== businessWindow.webContents
      || !senderFrame || senderFrame !== event.sender.mainFrame || !isBusinessUrl(senderFrame.url)
      || !isBusinessUrl(event.sender.getURL())) {
      throw new Error('不允许此窗口调用内置浏览意图。');
    }
    return bindInBrowseController(businessWindow, (snapshot) => {
      if (businessWindow && !businessWindow.isDestroyed()) {
        businessWindow.webContents.send('desktop-ui:inbrowse-snapshot', snapshot);
      }
    });
  };
  // DEV-AI27-08（W08，D-172）：内置浏览视图固定意图——DT-08 片 8 拆至 ipc/inbrowse.ts
  // （契约与防线语义不变；来源校验与快照推送闭包留 main.ts）。
  registerInBrowseIpcHandlers({ ipcHandle, requireInBrowse });
  // DEV-AI27-17（W17b，A12）：本机选窗器。枚举只在本机发生（27 §11.5.1/C09）——
  // 渲染器只拿不透明 handle 与脱敏摘要，不上传窗口全集、进程路径或截图。
  // handle = sha256(pid + 标题) 前 32 位：服务端与模型拿不到明文，本机可重算核对。
  const requireComputerCaller = (event: IpcMainInvokeEvent): void => {
    const senderFrame = event.senderFrame;
    if (!businessWindow || businessWindow.isDestroyed() || event.sender !== businessWindow.webContents
      || !senderFrame || senderFrame !== event.sender.mainFrame || !isBusinessUrl(senderFrame.url)
      || !isBusinessUrl(event.sender.getURL())) {
      throw new Error('不允许此窗口调用本机选窗。');
    }
  };
  // DEV-AI27-17（W17b，A12）：本机选窗器 + DT-04 UIA 主链路——DT-08 片 3 拆至
  // ipc/computer.ts（通道契约与 C09 脱敏不变；requireComputerCaller 校验与 host 单例留 main）。
  computerWorkerHost = new ComputerWorkerHost();
  setComputerWorkerHost(computerWorkerHost);
  registerComputerIpcHandlers({ ipcHandle, requireComputerCaller });
  // DEV-AI27-A30/A30b：本机标签枚举与配对快照——DT-08 片 9 拆至 ipc/browser.ts
  // （桥状态如实报错与脱敏语义不变；requireComputerCaller 留 main.ts）。
  registerBrowserIpcHandlers({ ipcHandle, requireComputerCaller });
  // DEV-AI27-A3 第一/二片（27 §11.2）：MCP 宿主与 OAuth 生命周期——DT-08 片 1 拆至
  // ipc/mcp.ts（契约与返回值形状不变，mcpHostManager 单例经 onManagerReady 回传供
  // 退出清理触达）。
  registerMcpIpcHandlers({ ipcHandle, requireComputerCaller, onManagerReady: (manager) => { mcpHostManager = manager; } });
  // DEV-AI27-16 第六批（A2，27 §11.4.5）：realtime 双向音频桥——DT-08 片 2 拆至
  // ipc/voice.ts（通道契约不变；桥实例与 requireRealtimeCaller 校验留在 main.ts）。
  setRealtimeBridge(realtimeBridge);
  registerVoiceIpcHandlers({ ipcHandle, requireRealtimeCaller });
  // DT-08 片 4：cx-long-image:capture 拆至 ipc/cx.ts（占用门与失败语义不变；
  // 在途捕获集合留在 main.ts 供退出统一清理）。
  registerCXIpcHandlers({ ipcHandle, businessWindow: () => businessWindow, isBusinessUrl, activeCXLongImageCaptures });
  // OPT-U03（docs/43 §4）：小红书人工接管包的图片有序导出——通道整体在 ipc/publish-pack.ts，
  // 落盘根目录/大小上限/业务窗口守卫都在该模块内；main.ts 不内联通道。
  registerPublishPackIpcHandlers({ ipcHandle, businessWindow: () => businessWindow, isBusinessUrl });
  // OPT-U04（docs/43 §4）：平台重登与本机设置面板的固定 IPC——通道与校验都在 ipc/desktop-ui.ts，
  // 业务页不再依赖会被拦截的 window.open；原 setWindowOpenHandler 的 ops-desktop://ui/* 兼容保留。
  registerDesktopUiIpcHandlers({ ipcHandle, businessWindow: () => businessWindow, isBusinessUrl, applyIntent: applyDesktopUiIntent });
  // OPT-E02（docs/43 §5）：版本更新三通道。checker 在 whenReady 里已创建；这里只接线，
  // 业务窗口守卫与「打开下载页只吃已校验链接」都在 ipc/update.ts 内完成。
  if (desktopUpdateChecker) {
    registerDesktopUpdateIpcHandlers({
      ipcHandle,
      businessWindow: () => businessWindow,
      isBusinessUrl,
      checker: desktopUpdateChecker,
      openExternal: (url) => shell.openExternal(url),
    });
  }
  // DT-08 片 10：settings:* 28 通道 + local-state 事件拆至 ipc/settings.ts（确认弹窗
  // 文案与防线校验逐字节搬移；跨域依赖经 SettingsIpcDeps 注入）。
  registerSettingsIpcHandlers({
    ipcHandle,
    ipcOn: (channel, handler) => ipcMain.on(channel, handler),
    assertTrustedLocalSender,
    getLocalSettingsWindow,
    localSettingsViewController: { get: () => localSettingsViewController, destroy() { localSettingsViewController = null; } },
    businessWindow: { get: () => businessWindow },
    businessSession: { get: () => businessSession },
    desktopClient: { get: () => desktopClient },
    apiOrigin: { get: () => apiOrigin },
    businessOrigin: { get: () => businessOrigin },
    businessFailureReason: { get: () => businessFailureReason },
    connectionState: getConnectionState,
    applyNativeClientStatus,
    routingRefreshPending: { set: (v) => { routingRefreshPending = v; }, get: () => routingRefreshPending },
    routingRefresh: { get: () => routingRefresh },
    accountDataClearInProgress: { set: (v) => { accountDataClearInProgress = v; }, get: () => accountDataClearInProgress },
    pendingPlatformLoginTarget: { take: () => { const t = pendingPlatformLoginTarget; pendingPlatformLoginTarget = null; return t ? { accountId: t.accountId, platform: t.platform } : null; }, clear: () => { pendingPlatformLoginTarget = null; } },
    parseSaveModelInput,
    parseDesktopRoute,
    runPlatformCommand,
    readPlatformBrowserStatus,
    isBusinessUrl,
    navigateBusiness,
    loadBusinessPage,
    openNativeSettings,
    platformLoginFlow,
  });
}


function ipcHandle<T>(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => T | Promise<T>
): void {
  ipcMain.handle(channel, (event, ...args) => handler(event, ...args));
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
  // Q-27（docs/41）：本机设置窗同样走自绘标题栏，补齐键盘缩放路径。
  installWebContentsZoomShortcuts(window.webContents);
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
  return isBusinessOriginUrl(value, businessOrigin);
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
    // DT-03：统一清理（与 before-quit 同一清单，补齐 realtime/mcp/桥/长图捕获）。
    disposeApplicationResources();
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
