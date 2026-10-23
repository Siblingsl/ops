import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { DesktopClientHealth, PlatformIntentResult } from './ui-intents';

// Sandboxed preloads can only require Electron built-ins; keep these strings aligned with ui-intents.ts.
const CLIENT_HEALTH_CHANNEL = 'desktop-ui:client-health';
const PLATFORM_INTENT_RESULT_CHANNEL = 'desktop-ui:platform-intent-result';

type LocalSettingsState = { dirty: boolean; busy: boolean };
type SettingsOpenListener = () => void;
type LocalSettingsStateListener = (state: LocalSettingsState) => void;
type PlatformIntentResultListener = (result: PlatformIntentResult) => void;
type ClientHealthListener = (health: DesktopClientHealth) => void;

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
  }
});
