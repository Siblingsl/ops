import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { DesktopClientHealth, PlatformIntentResult } from './ui-intents';

// Sandboxed preloads can only require Electron built-ins; keep these strings aligned with ui-intents.ts.
const CLIENT_HEALTH_CHANNEL = 'desktop-ui:client-health';
const PLATFORM_INTENT_RESULT_CHANNEL = 'desktop-ui:platform-intent-result';
const CX_LONG_IMAGE_CAPTURE_CHANNEL = 'cx-long-image:capture';

type LocalSettingsState = { dirty: boolean; busy: boolean };
type SettingsOpenListener = () => void;
type LocalSettingsStateListener = (state: LocalSettingsState) => void;
type PlatformIntentResultListener = (result: PlatformIntentResult) => void;
type ClientHealthListener = (health: DesktopClientHealth) => void;
type CXLongImageCaptureResult =
  | { ok: false; code: string; message: string }
  | {
    ok: true;
    buildId: string;
    sourceHash: string;
    png: Uint8Array;
    width: number;
    height: number;
    heightCss: number;
    dpr: number;
    viewportWidth: number;
    viewportHeight: number;
    segments: number;
    captureEngine: string;
    captureEngineVersion: string;
    captureCheckScope: string;
    capturedAt: string;
    fontFamily: string;
  };

// DEV-AI27-17（W17b，A12）：本机选窗结果。handle 不透明，标题只在业务窗口内使用。
type ComputerWindowView = { handle: string; process: string; title: string; forbidden: boolean };
type ComputerWindowListResult =
  | { ok: false; code: string; message: string }
  | { ok: true; windows: ComputerWindowView[] };

// DEV-AI27-A30：本机标签枚举结果（选标签授权弹窗）。origin 已由扩展按页面 URL 归一。
type BrowserTabView = { tab_id: number; title: string; origin: string; window_id: number; active: boolean };
type BrowserTabListResult =
  | { ok: false; code: string; message: string }
  | { ok: true; tabs: BrowserTabView[] };

// DEV-AI27-A3 第一片：MCP 验证结果——目录只含工具名/哈希/schema，不含任何秘密。
type McpValidateInput = {
  connection_id: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
};
type McpToolDescriptorView = { name: string; description_hash: string; input_schema: unknown; output_schema?: unknown };
type McpValidateResult =
  | { ok: false; code: string; message: string }
  | { ok: true; catalog: { tools: McpToolDescriptorView[]; server_info: { name: string; version: string; protocol_version: string }; catalog_revision: string } };

// DEV-AI27-A3 第二片：OAuth 状态摘要——永不包含令牌明文（state/expires_at/has_refresh）。
type McpOAuthStatus = { state: 'unauthorized' | 'authorizing' | 'authorized' | 'needs_reauth'; expires_at: string | null; has_refresh: boolean };
type McpOAuthStartResult = { ok: boolean; state: string; reason: string };

const OPEN_SETTINGS_CHANNEL = 'desktop-ui:open-settings';
const LOCAL_SETTINGS_STATE_CHANNEL = 'desktop-ui:local-settings-state';
const openSettingsListeners = new Set<SettingsOpenListener>();
const localSettingsStateListeners = new Set<LocalSettingsStateListener>();
const platformIntentResultListeners = new Set<PlatformIntentResultListener>();
const clientHealthListeners = new Set<ClientHealthListener>();
let pendingOpenSettings = false;
let latestLocalSettingsState: LocalSettingsState | null = null;
let latestClientHealth: DesktopClientHealth | null = null;

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function asRecord(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function parseCXLongImageCaptureResult(raw: unknown): CXLongImageCaptureResult | null {
  const value = asRecord(raw);
  if (!value || typeof value.ok !== 'boolean') return null;
  if (!value.ok) {
    return typeof value.code === 'string' && value.code.length <= 40
      && typeof value.message === 'string' && value.message.length <= 200
      ? { ok: false, code: value.code, message: value.message }
      : null;
  }
  const png = value.png instanceof Uint8Array ? value.png : value.png instanceof ArrayBuffer ? new Uint8Array(value.png) : null;
  if (!isUuid(value.buildId) || typeof value.sourceHash !== 'string' || !/^[0-9a-f]{64}$/i.test(value.sourceHash)
    || !png || png.byteLength < 24 || png.byteLength > 64 * 1024 * 1024
    || value.width !== 780 || !Number.isSafeInteger(value.height) || (value.height as number) < 1 || (value.height as number) > 60_000
    || !Number.isSafeInteger(value.heightCss) || (value.heightCss as number) < 1 || (value.heightCss as number) > 30_000
    || value.dpr !== 2 || value.viewportWidth !== 390 || value.viewportHeight !== 844
    || !Number.isSafeInteger(value.segments) || (value.segments as number) < 1 || (value.segments as number) > 8
    || value.captureEngine !== 'chromium-cdp' || typeof value.captureEngineVersion !== 'string' || value.captureEngineVersion.length > 128
    || typeof value.captureCheckScope !== 'string' || value.captureCheckScope.length > 256
    || typeof value.capturedAt !== 'string' || Number.isNaN(Date.parse(value.capturedAt))
    || typeof value.fontFamily !== 'string' || value.fontFamily.length > 256) return null;
  return {
    ok: true,
    buildId: value.buildId,
    sourceHash: value.sourceHash,
    png,
    width: value.width,
    height: value.height as number,
    heightCss: value.heightCss as number,
    dpr: value.dpr,
    viewportWidth: value.viewportWidth,
    viewportHeight: value.viewportHeight,
    segments: value.segments as number,
    captureEngine: value.captureEngine,
    captureEngineVersion: value.captureEngineVersion,
    captureCheckScope: value.captureCheckScope,
    capturedAt: value.capturedAt,
    fontFamily: value.fontFamily
  };
}

function parseComputerWindowListResult(raw: unknown): ComputerWindowListResult | null {
  const value = asRecord(raw);
  if (!value || typeof value.ok !== 'boolean') return null;
  if (!value.ok) {
    return typeof value.code === 'string' && value.code.length <= 60
      && typeof value.message === 'string' && value.message.length <= 200
      ? { ok: false, code: value.code, message: value.message }
      : null;
  }
  if (!Array.isArray(value.windows) || value.windows.length > 200) return null;
  const windows: ComputerWindowView[] = [];
  for (const item of value.windows) {
    const win = asRecord(item);
    if (!win || typeof win.handle !== 'string' || !/^[0-9a-f]{32}$/.test(win.handle)) return null;
    if (typeof win.process !== 'string' || win.process.length > 120) return null;
    if (typeof win.title !== 'string' || win.title.length > 256) return null;
    if (typeof win.forbidden !== 'boolean') return null;
    windows.push({ handle: win.handle, process: win.process, title: win.title, forbidden: win.forbidden });
  }
  return { ok: true, windows };
}

function parseBrowserTabListResult(raw: unknown): BrowserTabListResult | null {
  const value = asRecord(raw);
  if (!value || typeof value.ok !== 'boolean') return null;
  if (!value.ok) {
    return typeof value.code === 'string' && value.code.length <= 60
      && typeof value.message === 'string' && value.message.length <= 200
      ? { ok: false, code: value.code, message: value.message }
      : null;
  }
  if (!Array.isArray(value.tabs) || value.tabs.length > 200) return null;
  const tabs: BrowserTabView[] = [];
  for (const item of value.tabs) {
    const tab = asRecord(item);
    if (!tab || typeof tab.tab_id !== 'number' || !Number.isSafeInteger(tab.tab_id)) return null;
    if (typeof tab.title !== 'string' || tab.title.length > 120) return null;
    if (typeof tab.origin !== 'string' || tab.origin.length > 200) return null;
    if (typeof tab.window_id !== 'number' || !Number.isSafeInteger(tab.window_id)) return null;
    if (typeof tab.active !== 'boolean') return null;
    tabs.push({ tab_id: tab.tab_id, title: tab.title, origin: tab.origin, window_id: tab.window_id, active: tab.active });
  }
  return { ok: true, tabs };
}

function parseMcpValidateResult(raw: unknown): McpValidateResult | null {
  const value = asRecord(raw);
  if (!value || typeof value.ok !== 'boolean') return null;
  if (!value.ok) {
    return typeof value.code === 'string' && value.code.length <= 40
      && typeof value.message === 'string' && value.message.length <= 300
      ? { ok: false, code: value.code, message: value.message }
      : null;
  }
  const catalog = asRecord(value.catalog);
  if (!catalog) return null;
  const server = asRecord(catalog.server_info);
  if (!server || typeof server.name !== 'string' || typeof server.version !== 'string'
    || typeof server.protocol_version !== 'string') return null;
  if (!Array.isArray(catalog.tools) || catalog.tools.length > 500) return null;
  const tools: McpToolDescriptorView[] = [];
  for (const item of catalog.tools) {
    const tool = asRecord(item);
    if (!tool || typeof tool.name !== 'string' || tool.name.length > 200) return null;
    if (typeof tool.description_hash !== 'string' || !/^[0-9a-f]{16}$/.test(tool.description_hash)) return null;
    if (typeof tool.input_schema !== 'object' || tool.input_schema === null) return null;
    tools.push({ name: tool.name, description_hash: tool.description_hash, input_schema: tool.input_schema, ...(tool.output_schema !== undefined ? { output_schema: tool.output_schema } : {}) });
  }
  if (typeof catalog.catalog_revision !== 'string' || catalog.catalog_revision.length > 64) return null;
  return { ok: true, catalog: { tools, server_info: { name: server.name, version: server.version, protocol_version: server.protocol_version }, catalog_revision: catalog.catalog_revision } };
}

function parseMcpOAuthStatus(raw: unknown): McpOAuthStatus | null {
  const value = asRecord(raw);
  if (!value) return null;
  // 白名单字段：任何多余键（如 access_token/refresh_token）都视为非法——令牌零泄漏断言。
  if (Object.keys(value).sort().join(',') !== 'expires_at,has_refresh,state') return null;
  if (!['unauthorized', 'authorizing', 'authorized', 'needs_reauth'].includes(String(value.state))) return null;
  if (value.expires_at !== null && (typeof value.expires_at !== 'string' || value.expires_at.length > 40 || Number.isNaN(Date.parse(value.expires_at)))) return null;
  if (typeof value.has_refresh !== 'boolean') return null;
  return { state: value.state as McpOAuthStatus['state'], expires_at: value.expires_at as string | null, has_refresh: value.has_refresh };
}

function parseMcpOAuthStartResult(raw: unknown): McpOAuthStartResult | null {
  const value = asRecord(raw);
  if (!value || Object.keys(value).sort().join(',') !== 'ok,reason,state') return null;
  if (typeof value.ok !== 'boolean' || typeof value.state !== 'string' || typeof value.reason !== 'string' || value.reason.length > 200) return null;
  return { ok: value.ok, state: value.state, reason: value.reason };
}

function parsePlatformIntentResult(raw: unknown): PlatformIntentResult | null {  const value = asRecord(raw);
  if (!value || !isUuid(value.requestId) || !isUuid(value.accountId)) return null;
  if (!['platform-account-sync', 'platform-metrics-refresh', 'platform-sync-resume'].includes(String(value.kind))) return null;
  if (!['queued', 'existing', 'no_targets', 'failed'].includes(String(value.status))) return null;
  if (value.message !== undefined && (typeof value.message !== 'string' || value.message.length > 200)) return null;
  if (value.operationId !== undefined && !isUuid(value.operationId)) return null;

  const kind = value.kind as PlatformIntentResult['kind'];
  const status = value.status as PlatformIntentResult['status'];
  if (kind === 'platform-sync-resume' && (status !== 'queued' && status !== 'failed' || !isUuid(value.operationId))) return null;

  return {
    kind,
    requestId: value.requestId,
    accountId: value.accountId,
    status,
    ...(isUuid(value.operationId) ? { operationId: value.operationId } : {}),
    ...(typeof value.message === 'string' ? { message: value.message } : {})
  };
}

function parseClientHealth(raw: unknown): DesktopClientHealth | null {
  const value = asRecord(raw);
  if (!value || Object.keys(value).sort().join(',') !== 'channelMessage,channelState,collection,presence') return null;
  if (!['disconnected', 'connecting', 'ready', 'error'].includes(String(value.channelState))
    || typeof value.channelMessage !== 'string' || value.channelMessage.length > 200) return null;
  const collection = asRecord(value.collection);
  const presence = asRecord(value.presence);
  if (!collection || Object.keys(collection).sort().join(',') !== 'message,status,updatedAt'
    || !['idle', 'running', 'partial', 'failed'].includes(String(collection.status))
    || typeof collection.message !== 'string' || collection.message.length > 200
    || !(collection.updatedAt === null || (typeof collection.updatedAt === 'number' && Number.isSafeInteger(collection.updatedAt) && collection.updatedAt >= 0))) return null;
  if (!presence || Object.keys(presence).sort().join(',') !== 'message,status,updatedAt'
    || !['unknown', 'online', 'offline', 'error'].includes(String(presence.status))
    || typeof presence.message !== 'string' || presence.message.length > 200
    || !(presence.updatedAt === null || (typeof presence.updatedAt === 'number' && Number.isSafeInteger(presence.updatedAt) && presence.updatedAt >= 0))) return null;
  return {
    channelState: value.channelState as DesktopClientHealth['channelState'],
    channelMessage: value.channelMessage,
    collection: {
      status: collection.status as DesktopClientHealth['collection']['status'],
      message: collection.message,
      updatedAt: collection.updatedAt as number | null
    },
    presence: {
      status: presence.status as DesktopClientHealth['presence']['status'],
      message: presence.message,
      updatedAt: presence.updatedAt as number | null
    }
  };
}

ipcRenderer.on(OPEN_SETTINGS_CHANNEL, () => {
  if (openSettingsListeners.size === 0) {
    pendingOpenSettings = true;
    return;
  }
  for (const listener of openSettingsListeners) listener();
});

ipcRenderer.on(LOCAL_SETTINGS_STATE_CHANNEL, (_event: IpcRendererEvent, state: LocalSettingsState) => {
  if (!state || typeof state.dirty !== 'boolean' || typeof state.busy !== 'boolean') return;
  latestLocalSettingsState = { dirty: state.dirty, busy: state.busy };
  for (const listener of localSettingsStateListeners) listener(latestLocalSettingsState);
});

ipcRenderer.on(PLATFORM_INTENT_RESULT_CHANNEL, (_event: IpcRendererEvent, raw: unknown) => {
  const result = parsePlatformIntentResult(raw);
  if (!result) return;
  for (const listener of platformIntentResultListeners) listener(result);
});

ipcRenderer.on(CLIENT_HEALTH_CHANNEL, (_event: IpcRendererEvent, raw: unknown) => {
  const health = parseClientHealth(raw);
  if (!health) return;
  latestClientHealth = health;
  for (const listener of clientHealthListeners) listener(health);
});

contextBridge.exposeInMainWorld('opsDesktopUI', {
  onOpenSettings(listener: SettingsOpenListener) {
    openSettingsListeners.add(listener);
    if (pendingOpenSettings) {
      pendingOpenSettings = false;
      listener();
    }
    return () => openSettingsListeners.delete(listener);
  },
  onLocalSettingsState(listener: LocalSettingsStateListener) {
    localSettingsStateListeners.add(listener);
    if (latestLocalSettingsState) listener(latestLocalSettingsState);
    return () => localSettingsStateListeners.delete(listener);
  },
  onPlatformIntentResult(listener: PlatformIntentResultListener) {
    platformIntentResultListeners.add(listener);
    return () => platformIntentResultListeners.delete(listener);
  },
  onClientHealth(listener: ClientHealthListener) {
    clientHealthListeners.add(listener);
    if (latestClientHealth) listener(latestClientHealth);
    return () => clientHealthListeners.delete(listener);
  },
  async captureLongImage(buildId: string): Promise<CXLongImageCaptureResult> {
    if (!isUuid(buildId)) return { ok: false, code: 'invalid_input', message: '长图构建参数无效。' };
    const result = parseCXLongImageCaptureResult(await ipcRenderer.invoke(CX_LONG_IMAGE_CAPTURE_CHANNEL, { buildId }));
    return result ?? { ok: false, code: 'long_image_invalid', message: 'Electron 返回的长图结果无效。' };
  },
  // DEV-AI27-17（W17b，A12）：本机窗口枚举——只在本机执行，渲染器拿到的是不透明 handle。
  async listComputerWindows(): Promise<ComputerWindowListResult> {
    const result = parseComputerWindowListResult(await ipcRenderer.invoke('computer:list-windows'));
    return result ?? { ok: false, code: 'computer_windows_invalid', message: 'Electron 返回的窗口列表无效。' };
  },
  // DEV-AI27-A30：本机标签枚举（选标签授权弹窗）——枚举在本机，桥未启动/未配对时如实报错。
  async listBrowserTabs(): Promise<BrowserTabListResult> {
    const result = parseBrowserTabListResult(await ipcRenderer.invoke('browser:list-tabs'));
    return result ?? { ok: false, code: 'browser_tabs_invalid', message: 'Electron 返回的标签列表无效。' };
  },
  // DEV-AI27-A3 第一片：MCP 验证——真实握手后返回目录；失败原样透出（不伪造已验证）。
  async validateMcpConnection(input: McpValidateInput): Promise<McpValidateResult> {
    const result = parseMcpValidateResult(await ipcRenderer.invoke('mcp:validate', input));
    return result ?? { ok: false, code: 'mcp_validate_invalid', message: 'Electron 返回的验证结果无效。' };
  },
  // DEV-AI27-A3 第二片：OAuth 授权生命周期——start 走系统浏览器（阻塞至完成/超时），
  // status/revoke 只返回状态摘要，令牌明文不出 IPC。
  async startMcpOAuth(input: { connection_id: string; server_url: string; client_id?: string; scopes?: string[] }): Promise<McpOAuthStartResult> {
    const result = parseMcpOAuthStartResult(await ipcRenderer.invoke('mcp:oauth-start', input));
    return result ?? { ok: false, state: 'needs_reauth', reason: 'Electron 返回的授权结果无效。' };
  },
  async getMcpOAuthStatus(input: { connection_id: string; server_url: string; client_id?: string; scopes?: string[] }): Promise<McpOAuthStatus> {
    const result = parseMcpOAuthStatus(await ipcRenderer.invoke('mcp:oauth-status', input));
    return result ?? { state: 'unauthorized', expires_at: null, has_refresh: false };
  },
  async revokeMcpOAuth(input: { connection_id: string; server_url: string; client_id?: string; scopes?: string[] }): Promise<{ ok: boolean }> {
    const value = asRecord(await ipcRenderer.invoke('mcp:oauth-revoke', input));
    return value && value.ok === true ? { ok: true } : { ok: false };
  },
  // DEV-AI27-08（W08）：内置浏览视图固定意图（白名单通道；渲染器无 view 对象）。
  async invokeInBrowse(channel: string, payload?: unknown): Promise<unknown> {
    const allowed = ['inbrowse:snapshot', 'inbrowse:set-bounds', 'inbrowse:navigate', 'inbrowse:back', 'inbrowse:forward', 'inbrowse:reload', 'inbrowse:stop', 'inbrowse:close', 'inbrowse:open-tab', 'inbrowse:switch-tab', 'inbrowse:close-tab', 'inbrowse:reorder-tab', 'inbrowse:data-stats', 'inbrowse:clear-data', 'voice:realtime-status', 'voice:realtime-start', 'voice:realtime-append', 'voice:realtime-commit', 'voice:realtime-interrupt', 'voice:realtime-stop'];
    if (!allowed.includes(channel)) throw new Error(`不允许的内置浏览意图：${channel}`);
    return ipcRenderer.invoke(channel, payload);
  },
  onInBrowseSnapshot(listener: (snapshot: unknown) => void) {
    const wrapped = (_event: unknown, snapshot: unknown) => listener(snapshot);
    ipcRenderer.on('desktop-ui:inbrowse-snapshot', wrapped);
    return () => { ipcRenderer.removeListener('desktop-ui:inbrowse-snapshot', wrapped); };
  },
  // DEV-AI27-16 第六批（A2）：realtime 桥事件（audio_delta/transcript_delta/error 等信封）。
  onRealtimeEvent(listener: (event: unknown) => void) {
    const wrapped = (_event: unknown, ev: unknown) => listener(ev);
    ipcRenderer.on('desktop-ui:realtime-event', wrapped);
    return () => { ipcRenderer.removeListener('desktop-ui:realtime-event', wrapped); };
  },
  // DEV-AI27-10（W10b）：侧栏草稿/停止事件（主进程桥转发）。
  onSidepanelDraft(listener: (draft: { text: string }) => void) {
    const wrapped = (_event: unknown, draft: unknown) => listener(draft as { text: string });
    ipcRenderer.on('desktop-ui:sidepanel-draft', wrapped);
    return () => { ipcRenderer.removeListener('desktop-ui:sidepanel-draft', wrapped); };
  },
  onSidepanelStop(listener: () => void) {
    const wrapped = () => listener();
    ipcRenderer.on('desktop-ui:sidepanel-stop', wrapped);
    return () => { ipcRenderer.removeListener('desktop-ui:sidepanel-stop', wrapped); };
  }
});
