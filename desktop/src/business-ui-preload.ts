import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

type LocalSettingsState = { dirty: boolean; busy: boolean };
type SettingsOpenListener = () => void;
type LocalSettingsStateListener = (state: LocalSettingsState) => void;

const OPEN_SETTINGS_CHANNEL = 'desktop-ui:open-settings';
const LOCAL_SETTINGS_STATE_CHANNEL = 'desktop-ui:local-settings-state';
const openSettingsListeners = new Set<SettingsOpenListener>();
const localSettingsStateListeners = new Set<LocalSettingsStateListener>();
let pendingOpenSettings = false;
let latestLocalSettingsState: LocalSettingsState | null = null;

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
  }
});
