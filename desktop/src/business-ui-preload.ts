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

function parsePlatformIntentResult(raw: unknown): PlatformIntentResult | null {
  const value = asRecord(raw);
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
  // DEV-AI27-08（W08）：内置浏览视图固定意图（白名单通道；渲染器无 view 对象）。
  async invokeInBrowse(channel: string, payload?: unknown): Promise<unknown> {
    const allowed = ['inbrowse:snapshot', 'inbrowse:set-bounds', 'inbrowse:navigate', 'inbrowse:back', 'inbrowse:forward', 'inbrowse:reload', 'inbrowse:stop', 'inbrowse:close'];
    if (!allowed.includes(channel)) throw new Error(`不允许的内置浏览意图：${channel}`);
    return ipcRenderer.invoke(channel, payload);
  },
  onInBrowseSnapshot(listener: (snapshot: unknown) => void) {
    const wrapped = (_event: unknown, snapshot: unknown) => listener(snapshot);
    ipcRenderer.on('desktop-ui:inbrowse-snapshot', wrapped);
    return () => { ipcRenderer.removeListener('desktop-ui:inbrowse-snapshot', wrapped); };
  }
});
