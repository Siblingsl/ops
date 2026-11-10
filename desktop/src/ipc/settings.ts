import { app, BrowserWindow, dialog, type IpcMainEvent, type IpcMainInvokeEvent, type Session } from 'electron';
import os from 'node:os';
import fs from 'node:fs/promises';
import type { DesktopClient, DesktopDevice, DesktopPolicy, DesktopRoute, DesktopRouteState, BusinessAccount, AccountTypeChangeResult, PublicModel, SaveModelInput,  } from '../desktop-client';
import type { DesktopMode } from '../request-context';
import type { PlatformLoginFlow } from '../platform-login-flow';
import type { PlatformBrowserStatus } from '../main';

// DT-08 片 10（docs/33 §10.8 DT-08）：main.ts 的 settings:* 通道拆分。
// 28 个固定意图 + local-state 事件搬入本模块；跨域依赖经 SettingsIpcDeps 注入
// （main.ts 持有：业务窗/会话/客户端单例、来源校验器、导航与平台命令入口）。
// 契约、确认弹窗文案与防线校验逐字节搬移。

export interface SettingsIpcDeps {
  ipcHandle: <T>(channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => T | Promise<T>) => void;
  ipcOn: (channel: string, handler: (event: IpcMainEvent, ...args: unknown[]) => void) => void;
  assertTrustedLocalSender: (event: IpcMainInvokeEvent) => void;
  getLocalSettingsWindow: (event: IpcMainInvokeEvent) => BrowserWindow | null;
  localSettingsViewController: { get(): ReturnType<typeof import('../settings-view').createLocalSettingsViewController> | null; destroy(): void };
  businessWindow: { get(): BrowserWindow | null };
  businessSession: { get(): Session | null };
  desktopClient: { get(): DesktopClient | null };
  apiOrigin: { get(): string };
  businessOrigin: { get(): string };
  businessFailureReason: { get(): 'unreachable' | 'icp-block' | 'render-failed' };
  connectionState: () => 'online' | 'offline' | 'unknown';
  applyNativeClientStatus: (state: Awaited<ReturnType<DesktopClient['getPublicState']>>) => void;
  routingRefreshPending: { set(v: boolean): void; get(): boolean };
  routingRefresh: { get(): Promise<void> | null };
  accountDataClearInProgress: { set(v: boolean): void; get(): boolean };
  pendingPlatformLoginTarget: { take(): { accountId: string; platform: string } | null; clear(): void };
  isBusinessUrl: (url: string) => boolean;
  parseSaveModelInput: (value: unknown) => SaveModelInput;
  parseDesktopRoute: (value: unknown) => DesktopRoute;
  runPlatformCommand: (raw: unknown) => Promise<{ ok: true; data?: unknown } | { ok: false; error: { code: string } }>;
  readPlatformBrowserStatus: (force?: boolean) => Promise<PlatformBrowserStatus>;
  navigateBusiness: (url: string, allowDuringAccountDataClear?: boolean) => Promise<void>;
  loadBusinessPage: () => Promise<void>;
  openNativeSettings: () => void;
  platformLoginFlow: { stop(): Promise<void> };
}

const requireClient = (deps: SettingsIpcDeps): DesktopClient => {
  const client = deps.desktopClient.get();
  if (!client) throw new Error('客户端设置尚未初始化。');
  return client;
};

export function registerSettingsIpcHandlers(deps: SettingsIpcDeps): void {
  const { ipcHandle } = deps;

  deps.ipcOn('settings:local-state', (event: IpcMainEvent, raw: unknown) => {
    const controller = deps.localSettingsViewController.get();
    if (!controller?.isTrusted(event)) return;
    if (!raw || typeof raw !== 'object' || Object.keys(raw).sort().join(',') !== 'busy,dirty') return;
    const state = raw as { dirty: unknown; busy: unknown };
    if (typeof state.dirty !== 'boolean' || typeof state.busy !== 'boolean') return;
    const host = controller.currentHost;
    const businessWindow = deps.businessWindow.get();
    if (host !== businessWindow || !businessWindow || businessWindow.isDestroyed() || businessWindow.webContents.isDestroyed()) return;
    if (!deps.isBusinessUrl(businessWindow.webContents.mainFrame.url)
      || !deps.isBusinessUrl(businessWindow.webContents.getURL())) return;
    businessWindow.webContents.send('desktop-ui:local-settings-state', { dirty: state.dirty, busy: state.busy });
  });

  ipcHandle('settings:get-info', async (event) => {
    deps.assertTrustedLocalSender(event);
    const desktopClient = requireClient(deps);
    const clientState = await desktopClient.getPublicState();
    const systemInfo = await desktopClient.getPublicSystemInfo().catch(() => null);
    deps.applyNativeClientStatus(clientState);
    return {
      appVersion: app.getVersion(),
      apiOrigin: deps.apiOrigin.get(),
      connectionState: deps.connectionState(),
      failureReason: deps.businessFailureReason.get(),
      systemInfo,
      aiStatus: clientState.mode === 'desktop'
        ? `已应用此客户端 AI 模式；任务映射版本 ${clientState.routeRevision}。${clientState.channelState === 'ready' ? '本机通道已连接。' : '本机通道当前不可用。'}${clientState.localConfigAvailable ? '' : ' 本机设置文件无法读取，模型与设备设置已停用。'}`
        : `当前使用服务器 AI 模式；本机模型配置不会影响线上任务。${clientState.localConfigAvailable ? '' : ' 本机设置文件无法读取，模型与设备设置已停用。'}`,
      clientState
    };
  });

  ipcHandle('settings:export-diagnostics', async (event) => {
    deps.assertTrustedLocalSender(event);
    const desktopClient = requireClient(deps);
    const window = deps.getLocalSettingsWindow(event);
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
      service: deps.apiOrigin.get(),
      business_connection: deps.connectionState(),
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
    deps.assertTrustedLocalSender(event);
    return requireClient(deps).listModels();
  });

  ipcHandle('settings:get-policy', (event) => {
    deps.assertTrustedLocalSender(event);
    return requireClient(deps).getPolicy() as Promise<{ globalEnabled: boolean; policy: DesktopPolicy }>;
  });

  ipcHandle('settings:set-policy', (event, value) => {
    deps.assertTrustedLocalSender(event);
    const desktopClient = requireClient(deps);
    if (!value || typeof value !== 'object') throw new Error('工作区策略输入无效。');
    const input = value as Record<string, unknown>;
    if (typeof input.enabled !== 'boolean' || typeof input.allowMemberEndpoints !== 'boolean') {
      throw new Error('工作区策略字段无效。');
    }
    return desktopClient.updatePolicy(input.enabled, input.allowMemberEndpoints);
  });

  ipcHandle('settings:get-devices', (event) => {
    deps.assertTrustedLocalSender(event);
    return requireClient(deps).listDevices() as Promise<{ devices: DesktopDevice[]; reauthRequired: boolean }>;
  });

  ipcHandle('settings:revoke-device', (event, value) => {
    deps.assertTrustedLocalSender(event);
    const desktopClient = requireClient(deps);
    if (!value || typeof value !== 'object') throw new Error('设备回收请求无效。');
    const input = value as Record<string, unknown>;
    if (typeof input.deviceId !== 'string' || typeof input.password !== 'string' || input.password.length > 1024) {
      throw new Error('设备回收字段无效。');
    }
    return desktopClient.revokeDevice(input.deviceId, input.password);
  });

  ipcHandle('settings:get-routes', async (event) => {
    deps.assertTrustedLocalSender(event);
    const desktopClient = requireClient(deps);
    const [routeTypes, serverModels, desktopRoutes, desktopModels] = await Promise.all([
      desktopClient.listRouteTypes(),
      desktopClient.listServerModels(),
      desktopClient.listDesktopRoutes(),
      desktopClient.listModels()
    ]);
    return { routeTypes, serverModels, desktopRoutes, desktopModels } as {
      routeTypes: Array<{ task_type: string; label: string }>;
      serverModels: Array<{ id: string; name: string; models: string[]; status: string }>;
      desktopRoutes: DesktopRouteState;
      desktopModels: PublicModel[];
    };
  });

  ipcHandle('settings:save-routes', (event, value) => {
    deps.assertTrustedLocalSender(event);
    const desktopClient = requireClient(deps);
    if (!value || typeof value !== 'object') throw new Error('任务映射输入无效。');
    const input = value as Record<string, unknown>;
    if (typeof input.expectedRevision !== 'number' || !Array.isArray(input.routes)) {
      throw new Error('任务映射版本或内容无效。');
    }
    return desktopClient.saveDesktopRoutes(
      input.routes.map(deps.parseDesktopRoute), input.expectedRevision
    );
  });

  ipcHandle('settings:start-model-test', (event, value) => {
    deps.assertTrustedLocalSender(event);
    const desktopClient = requireClient(deps);
    if (!value || typeof value !== 'object') throw new Error('自检请求无效。');
    const input = value as Record<string, unknown>;
    if (typeof input.providerId !== 'string' || typeof input.model !== 'string') {
      throw new Error('请选择待自检的模型。');
    }
    return desktopClient.startModelTest(input.providerId, input.model);
  });

  ipcHandle('settings:get-model-test', (event, value) => {
    deps.assertTrustedLocalSender(event);
    const desktopClient = requireClient(deps);
    if (typeof value !== 'string' || value.length > 80) throw new Error('自检任务标识无效。');
    return desktopClient.getModelTest(value);
  });

  ipcHandle('settings:apply-mode', async (event, value) => {
    deps.assertTrustedLocalSender(event);
    const desktopClient = requireClient(deps);
    if (value !== 'server' && value !== 'desktop') throw new Error('执行模式无效。');
    const mode = value as DesktopMode;
    const clientState = await desktopClient.getPublicState();
    const window = deps.getLocalSettingsWindow(event);
    if (!window) throw new Error('设置窗口已关闭。');
    const { response } = await dialog.showMessageBox(window, {
      type: mode === 'desktop' ? 'warning' : 'question',
      title: mode === 'desktop' ? '启用此客户端 AI' : '切换到服务器 AI',
      message: '请先保存业务页面中的未提交内容。客户端无法检测编辑器是否有尚未保存的修改。',
      detail: mode === 'desktop'
        ? `后续任务上下文仍经线上后端，并会发送到本机设置的 AI 端点。回环地址不代表数据不会离开本机。当前正在处理的本机模型调用：${clientState.activeModelRequests}。应用后将重新加载业务页面。`
        : `后续 AI 请求将使用工作区的线上服务器模型。当前正在处理的本机模型调用：${clientState.activeModelRequests}。应用后将重新加载业务页面。`,
      buttons: ['取消', '确认并重新加载'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    });
    if (response !== 1) return false;
    deps.routingRefreshPending.set(true);
    try {
      await desktopClient.applyMode(mode);
      const businessWindow = deps.businessWindow.get();
      const currentUrl = businessWindow && !businessWindow.isDestroyed()
        ? businessWindow.webContents.getURL()
        : '';
      if (deps.isBusinessUrl(currentUrl)) await deps.navigateBusiness(currentUrl);
      else await deps.loadBusinessPage();
      deps.routingRefreshPending.set(false);
      return true;
    } catch (error) {
      try {
        const restored = await desktopClient.restoreAppliedMode();
        deps.routingRefreshPending.set(restored === 'incompatible');
      } catch {
        deps.routingRefreshPending.set(true);
      }
      throw error;
    }
  });

  ipcHandle('settings:reauthenticate', (event, value) => {
    deps.assertTrustedLocalSender(event);
    if (typeof value !== 'string' || value.length > 1024) throw new Error('密码输入无效。');
    return requireClient(deps).reauthenticate(value);
  });

  // D-123 / DEV-415：客户端设置页更换业务账号内容类型。确认框用系统原生对话框，
  // 与删除本机模型、清除账号数据等同级操作保持一致；跨平台一律拒绝（服务端同样拒绝）。
  ipcHandle('settings:get-accounts', (event) => {
    deps.assertTrustedLocalSender(event);
    return requireClient(deps).listBusinessAccounts() as Promise<BusinessAccount[]>;
  });

  ipcHandle('settings:change-account-type', async (event, value) => {
    deps.assertTrustedLocalSender(event);
    const desktopClient = requireClient(deps);
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
    const window = deps.getLocalSettingsWindow(event);
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
    return desktopClient.changeAccountContentFormat({ accountId, contentFormat }) as Promise<AccountTypeChangeResult>;
  });

  ipcHandle('settings:clear-account-data', async (event) => {
    deps.assertTrustedLocalSender(event);
    const desktopClient = requireClient(deps);
    const businessSession = deps.businessSession.get();
    if (!businessSession) throw new Error('客户端设置尚未初始化。');
    const identity = await desktopClient.getCurrentAccountIdentity();
    const clientState = await desktopClient.getPublicState();
    if (!clientState.signedIn) throw new Error('请先登录要清理的 OPS 账号。');
    if (identity.username !== clientState.username) throw new Error('当前登录账号已变化，请刷新设置后重试。');
    const window = deps.getLocalSettingsWindow(event);
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

    deps.routingRefreshPending.set(true);
    deps.accountDataClearInProgress.set(true);
    try {
      const pendingRefresh = deps.routingRefresh.get();
      if (pendingRefresh) await pendingRefresh;
      deps.routingRefreshPending.set(true);
      await desktopClient.clearCurrentAccountData(identity.userId);
      try {
        await businessSession.clearStorageData({ origin: deps.apiOrigin.get() });
        await businessSession.clearStorageData({ origin: deps.businessOrigin.get() });
        await businessSession.clearCache();
      } catch {
        throw new Error('该账号的本机 AI 配置已删除，但线上站点数据或缓存未能全部清理。请重试清理，或重新登录后再操作。');
      }
      await deps.navigateBusiness(`${deps.businessOrigin.get()}/login`, true);
      deps.routingRefreshPending.set(false);
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
        deps.routingRefreshPending.set(restored === 'incompatible');
      } catch {
        deps.routingRefreshPending.set(true);
      }
      throw error;
    } finally {
      deps.accountDataClearInProgress.set(false);
    }
  });

  ipcHandle('settings:save-model', (event, value) => {
    deps.assertTrustedLocalSender(event);
    return requireClient(deps).saveModel(deps.parseSaveModelInput(value)) as Promise<PublicModel[]>;
  });

  ipcHandle('settings:delete-model', async (event, value) => {
    deps.assertTrustedLocalSender(event);
    const desktopClient = requireClient(deps);
    if (!value || typeof value !== 'object') throw new Error('模型删除请求无效。');
    const input = value as Record<string, unknown>;
    if (typeof input.providerId !== 'string' || !/^[0-9a-f-]{36}$/i.test(input.providerId)
      || typeof input.configRevision !== 'number' || !Number.isSafeInteger(input.configRevision)) {
      throw new Error('模型删除字段无效。');
    }
    const window = deps.getLocalSettingsWindow(event);
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
    deps.assertTrustedLocalSender(event);
    return requireClient(deps).connect();
  });

  ipcHandle('settings:disconnect-ai', (event) => {
    deps.assertTrustedLocalSender(event);
    deps.desktopClient.get()?.disconnect();
  });

  ipcHandle('settings:retry-business-page', (event) => {
    deps.assertTrustedLocalSender(event);
    return deps.loadBusinessPage();
  });

  ipcHandle('settings:open-login-page', (event) => {
    deps.assertTrustedLocalSender(event);
    return deps.navigateBusiness(`${deps.businessOrigin.get()}/login`);
  });

  ipcHandle('settings:open-settings', (event) => {
    deps.assertTrustedLocalSender(event);
    deps.openNativeSettings();
  });

  ipcHandle('settings:take-platform-login-target', (event) => {
    deps.assertTrustedLocalSender(event);
    return deps.pendingPlatformLoginTarget.take();
  });

  ipcHandle('settings:close-local-window', (event) => {
    deps.assertTrustedLocalSender(event);
    const controller = deps.localSettingsViewController.get();
    if (controller?.isTrusted(event)) {
      const businessWindow = deps.businessWindow.get();
      if (businessWindow && !businessWindow.isDestroyed() && !businessWindow.webContents.isDestroyed()) {
        businessWindow.webContents.send('desktop-ui:local-settings-state', { dirty: false, busy: false });
      }
      controller.destroy();
      deps.localSettingsViewController.destroy();
      deps.pendingPlatformLoginTarget.clear();
      void deps.platformLoginFlow.stop();
      return;
    }
    const localWindow = BrowserWindow.fromWebContents(event.sender);
    localWindow?.close();
  });

  // 平台采集的本机命令（20 文档 §11.4）。主进程代办与 OPS 的认证请求和上传；
  // 工作进程不接收 OPS Cookie、密码、设备私钥或任意服务器 URL。
  ipcHandle('settings:platform-command', async (event, raw) => {
    deps.assertTrustedLocalSender(event);
    return deps.runPlatformCommand(raw);
  });

  // 浏览器探测单独一条通道：拉起浏览器比其它本机命令慢，不能共用 5 秒超时。
  ipcHandle('settings:platform-browser', async (event, raw) => {
    deps.assertTrustedLocalSender(event);
    const force = raw !== null && typeof raw === 'object' && (raw as { refresh?: unknown }).refresh === true;
    return deps.readPlatformBrowserStatus(force);
  });
}
