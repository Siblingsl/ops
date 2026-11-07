import { contextBridge, ipcRenderer } from 'electron';

// DEV-AI27-02 W02 技术验证：浏览器桥诊断窗 preload。只暴露固定意图，无通用 IPC。
const api = {
  getState: () => ipcRenderer.invoke('ops-bridge-diag:get-state'),
  confirmPairing: () => ipcRenderer.invoke('ops-bridge-diag:confirm-pairing'),
  revoke: () => ipcRenderer.invoke('ops-bridge-diag:revoke'),
  dispatch: (action: string, payload: unknown) => ipcRenderer.invoke('ops-bridge-diag:dispatch', action, payload),
  onUpdate: (cb: (snapshot: unknown) => void) => {
    const listener = (_event: unknown, snapshot: unknown) => cb(snapshot);
    ipcRenderer.on('ops-bridge-diag:update', listener);
    return () => ipcRenderer.removeListener('ops-bridge-diag:update', listener);
  },
};

contextBridge.exposeInMainWorld('opsBridgeDiag', api);

export type OpsBridgeDiag = typeof api;
