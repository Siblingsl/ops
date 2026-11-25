// OPT-E04a：main.ts 的业务窗口意图处理与设置输入解析拆出模块。
// 不改任何意图语义；业务窗、设置面板与主题状态通过显式 Deps 回接 main.ts。
import { app, BrowserWindow, Menu, nativeTheme } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { DesktopRoute, SaveModelInput } from '../desktop-client';
import { inBrowseAttachAfterOverlay, inBrowseDetachForOverlay } from '../in-browse';
import type { LocalSettingsPanel, createLocalSettingsViewController } from '../settings-view';
import type { PlatformLoginFlow } from '../platform-login-flow';
import {
  PLATFORM_INTENT_RESULT_CHANNEL,
  type DesktopUiIntent,
  type PlatformIntentResult
} from '../ui-intents';
import { runPlatformCommand } from './platform-collect';

export interface BusinessIntentDeps {
  getBusinessWindow(): BrowserWindow | null;
  isBusinessUrl(url: string): boolean;
  getAccountDataClearInProgress(): boolean;
  openNativeSettings(): void;
  showLocalSettingsView(window: BrowserWindow, panel: LocalSettingsPanel): void;
  sendPlatformLoginTargetForCurrentView(): void;
  localSettingsViewController: {
    get(): ReturnType<typeof createLocalSettingsViewController> | null;
    set(value: ReturnType<typeof createLocalSettingsViewController> | null): void;
  };
  pendingPlatformLoginTarget: {
    set(value: Extract<DesktopUiIntent, { type: 'platform-login' }> | null): void;
    clear(): void;
  };
  platformLoginFlow: Pick<PlatformLoginFlow, 'stop'>;
  setDesktopTheme(theme: 'light' | 'dark'): void;
  setDesktopReducedMotion(reduced: boolean | null): void;
  applyDesktopThemeToWindow(window: BrowserWindow, theme: 'light' | 'dark'): void;
  applyDesktopMotionToWindow(window: BrowserWindow, reduced: boolean | null): void;
}

let deps: BusinessIntentDeps | null = null;

export function configureBusinessIntents(next: BusinessIntentDeps): void {
  deps = next;
}

function requireDeps(): BusinessIntentDeps {
  if (!deps) throw new Error('业务意图模块尚未初始化。');
  return deps;
}

export function parseSaveModelInput(value: unknown): SaveModelInput {
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

export function parseDesktopRoute(value: unknown): DesktopRoute {
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

async function runBusinessPlatformAccountSyncIntent(
  window: BrowserWindow,
  intent: Extract<DesktopUiIntent, { type: 'platform-account-sync' }>
): Promise<void> {
  const d = requireDeps();
  const businessWindow = d.getBusinessWindow();
  const canRespond = () => window === businessWindow && !window.isDestroyed() && !window.webContents.isDestroyed()
    && d.isBusinessUrl(window.webContents.mainFrame.url) && d.isBusinessUrl(window.webContents.getURL());
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

  if (d.getAccountDataClearInProgress()) {
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
  const d = requireDeps();
  const businessWindow = d.getBusinessWindow();
  const canRespond = () => window === businessWindow && !window.isDestroyed() && !window.webContents.isDestroyed()
    && d.isBusinessUrl(window.webContents.mainFrame.url) && d.isBusinessUrl(window.webContents.getURL());
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
  const d = requireDeps();
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

  if (d.getAccountDataClearInProgress()) {
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
  const d = requireDeps();
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

  if (d.getAccountDataClearInProgress()) {
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

export function applyDesktopUiIntent(window: BrowserWindow, intent: DesktopUiIntent): void {
  const d = requireDeps();
  const businessWindow = d.getBusinessWindow();
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
    d.openNativeSettings();
    return;
  }

  if (intent.type === 'settings-pane') {
    // DEV-AI27-08（W08c）：原生设置浮层出现前隐藏内置浏览视图（27 §5.6 层级规则）。
    inBrowseDetachForOverlay(window, 'settings');
    d.showLocalSettingsView(window, intent.panel);
    return;
  }

  if (intent.type === 'settings-detach') {
    const controller = d.localSettingsViewController.get();
    if (controller?.currentHost === window) controller.detach();
    return;
  }

  if (intent.type === 'settings-close') {
    const controller = d.localSettingsViewController.get();
    if (controller
      && (!controller.currentHost || controller.currentHost === window)) {
      controller.destroy();
      d.localSettingsViewController.set(null);
      d.pendingPlatformLoginTarget.clear();
      void d.platformLoginFlow.stop();
    }
    // DEV-AI27-08（W08c）：设置浮层关闭后恢复内置浏览视图并重核目标（27 §5.6）。
    inBrowseAttachAfterOverlay(window);
    return;
  }

  if (intent.type === 'platform-login') {
    d.pendingPlatformLoginTarget.set(intent);
    const controller = d.localSettingsViewController.get();
    if (controller?.currentHost === businessWindow
      && controller.currentPanel === 'account-device') {
      d.sendPlatformLoginTargetForCurrentView();
    }
    return;
  }

  if (intent.type === 'theme') {
    d.setDesktopTheme(intent.theme);
    nativeTheme.themeSource = intent.theme;
    void fs.writeFile(path.join(app.getPath('userData'), 'desktop-ui-theme'), intent.theme, 'utf8').catch(() => undefined);
    const dark = intent.theme === 'dark';
    for (const target of BrowserWindow.getAllWindows()) {
      target.setTitleBarOverlay({
        color: dark ? '#201d2b' : '#f7f7f7',
        symbolColor: dark ? '#f1edf8' : '#6a6078',
        height: 38
      });
      d.applyDesktopThemeToWindow(target, intent.theme);
    }
    return;
  }

  if (intent.type === 'motion') {
    d.setDesktopReducedMotion(intent.reduced);
    void fs.writeFile(path.join(app.getPath('userData'), 'desktop-ui-motion'), intent.reduced ? 'reduce' : 'soft', 'utf8').catch(() => undefined);
    for (const target of BrowserWindow.getAllWindows()) d.applyDesktopMotionToWindow(target, intent.reduced);
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
