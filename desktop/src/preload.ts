import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('opsDesktopSettings', {
  getInfo: () => ipcRenderer.invoke('settings:get-info'),
  exportDiagnostics: () => ipcRenderer.invoke('settings:export-diagnostics'),
  getModels: () => ipcRenderer.invoke('settings:get-models'),
  getPolicy: () => ipcRenderer.invoke('settings:get-policy'),
  setPolicy: (policy: { enabled: boolean; allowMemberEndpoints: boolean }) => ipcRenderer.invoke('settings:set-policy', policy),
  getDevices: () => ipcRenderer.invoke('settings:get-devices'),
  revokeDevice: (input: { deviceId: string; password: string }) => ipcRenderer.invoke('settings:revoke-device', input),
  getRoutes: () => ipcRenderer.invoke('settings:get-routes'),
  saveRoutes: (input: { routes: DesktopRouteInput[]; expectedRevision: number }) => ipcRenderer.invoke('settings:save-routes', input),
  startModelTest: (input: { providerId: string; model: string }) => ipcRenderer.invoke('settings:start-model-test', input),
  getModelTest: (testId: string) => ipcRenderer.invoke('settings:get-model-test', testId),
  applyMode: (mode: 'server' | 'desktop') => ipcRenderer.invoke('settings:apply-mode', mode),
  getBusinessAccounts: () => ipcRenderer.invoke('settings:get-accounts'),
  changeAccountType: (input: { accountId: string; contentFormat: string }) => ipcRenderer.invoke('settings:change-account-type', input),
  reauthenticate: (password: string) => ipcRenderer.invoke('settings:reauthenticate', password),
  clearAccountData: () => ipcRenderer.invoke('settings:clear-account-data'),
  saveModel: (input: SaveModelInput) => ipcRenderer.invoke('settings:save-model', input),
  deleteModel: (input: { providerId: string; configRevision: number }) => ipcRenderer.invoke('settings:delete-model', input),
  connectAI: () => ipcRenderer.invoke('settings:connect-ai'),
  disconnectAI: () => ipcRenderer.invoke('settings:disconnect-ai'),
  retryBusinessPage: () => ipcRenderer.invoke('settings:retry-business-page'),
  openLoginPage: () => ipcRenderer.invoke('settings:open-login-page'),
  openSettings: () => ipcRenderer.invoke('settings:open-settings'),
  closeLocalWindow: () => ipcRenderer.invoke('settings:close-local-window'),
  // 平台采集的本机命令（20 文档 §11.4）：固定信封 {v,id,cmd,payload}，
  // 命令白名单在 main 侧再校验一次，页面不能借这里调用任意通道。
  platformCommand: (envelope: { v: number; id: string; cmd: string; payload?: unknown }) =>
    ipcRenderer.invoke('settings:platform-command', envelope),
  // 平台浏览器探测结论（D-129 v0.5）：只回品牌、版本与错误码，不含本机路径。
  platformBrowser: (input?: { refresh?: boolean }) => ipcRenderer.invoke('settings:platform-browser', input)
});
