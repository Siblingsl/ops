export type DesktopPlatformIntentKind = 'platform-account-sync' | 'platform-metrics-refresh' | 'platform-sync-resume'
export type DesktopPlatformIntentResult = {
  kind: DesktopPlatformIntentKind
  requestId: string
  accountId: string
  status: 'queued' | 'existing' | 'no_targets' | 'failed'
  operationId?: string
  message?: string
}

export type DesktopClientHealth = {
  channelState: 'disconnected' | 'connecting' | 'ready' | 'error'
  channelMessage: string
  collection: { status: 'idle' | 'running' | 'partial' | 'failed'; message: string; updatedAt: number | null }
  presence: { status: 'unknown' | 'online' | 'offline' | 'error'; message: string; updatedAt: number | null }
}

export type DesktopTheme = 'light' | 'dark'

export interface DesktopDocument {
  documentElement: {
    dataset: Record<string, string | undefined>
  }
}

export interface DesktopThemeStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function isElectronDesktop(userAgent: string): boolean
export function initializeDesktopPresentation(
  document: DesktopDocument,
  storage: DesktopThemeStorage,
  userAgent: string,
  systemReducedMotion?: boolean,
  sharedTheme?: DesktopTheme,
): DesktopTheme | null
export function setDesktopTheme(
  document: DesktopDocument,
  storage: DesktopThemeStorage,
  theme: DesktopTheme,
): DesktopTheme | null
export function setDesktopMotion(
  document: DesktopDocument,
  storage: DesktopThemeStorage,
  reduced: boolean,
): boolean | null

declare global {
  interface Window {
    opsDesktopUI?: {
      onOpenSettings(listener: () => void): () => void
      onLocalSettingsState(listener: (state: { dirty: boolean; busy: boolean }) => void): () => void
      onPlatformIntentResult(listener: (result: DesktopPlatformIntentResult) => void): () => void
      onClientHealth(listener: (health: DesktopClientHealth) => void): () => void
      captureLongImage(buildId: string): Promise<CXLongImageCaptureResult>
      // DEV-AI27-17（W17b，A12）：本机选窗器（枚举只在本机，handle 不透明）。
      listComputerWindows(): Promise<DesktopComputerWindowListResult>
      // DT-04（W17c / 27 §11.5.2）：UIA 主链路固定意图——结果按 C09 白名单逐控件校验，
      // 只含 id/type/name/value 四键，进程路径/窗口全集/截图不进渲染器。
      readComputerUIA(input: { pid: number; target_summary: string }): Promise<DesktopComputerUiaViewResult>
      invokeComputerUIA(input: { pid: number; automation_id: string; value?: string | null; target_summary: string }): Promise<DesktopComputerUiaInvokeResult>
      // DEV-AI27-A30：本机标签枚举（选标签授权弹窗；枚举只在本机，桥未配对时如实报错）。
      listBrowserTabs(): Promise<DesktopBrowserTabListResult>
      // DEV-AI27-A30b：配对统一——读桥侧配对快照 / 确认桥侧配对（快照白名单校验，不含会话密钥）。
      getBrowserPairingState(): Promise<DesktopBrowserPairingStateResult>
      confirmBrowserPairing(): Promise<DesktopBrowserPairingConfirmResult>
      // DEV-AI27-A3 第一片：MCP 验证（本机真实握手，返回目录；失败原样透出）。
      validateMcpConnection(input: DesktopMcpValidateInput): Promise<DesktopMcpValidateResult>
      // DEV-AI27-A3 第二片：OAuth 授权生命周期（start 走系统浏览器；返回值永不含令牌明文）。
      startMcpOAuth(input: DesktopMcpOAuthInput): Promise<DesktopMcpOAuthStartResult>
      getMcpOAuthStatus(input: DesktopMcpOAuthInput): Promise<DesktopMcpOAuthStatus>
      revokeMcpOAuth(input: DesktopMcpOAuthInput): Promise<{ ok: boolean }>
      // DEV-AI27-08（W08）：内置浏览视图固定意图（白名单通道）。
      invokeInBrowse(channel: string, payload?: unknown): Promise<unknown>
      onInBrowseSnapshot(listener: (snapshot: { bounds: { x: number; y: number; width: number; height: number } | null; url: string; title: string; loading: boolean; navigationGeneration: number }) => void): () => void
      // DEV-AI27-16 第六批（A2）：realtime 桥事件（audio_delta/transcript_delta/error 等信封）。
      onRealtimeEvent(listener: (event: { type: string; state?: string; dataBase64?: string; text?: string; error_code?: string; message?: string }) => void): () => void
      // DEV-AI27-10（W10b）：侧栏草稿/停止事件（主进程桥转发）。
      onSidepanelDraft(listener: (draft: { text: string }) => void): () => void
      onSidepanelStop(listener: () => void): () => void
    }
  }
}

export type CXLongImageCaptureResult =  | { ok: false; code: string; message: string }
  | {
    ok: true
    buildId: string
    sourceHash: string
    png: Uint8Array
    width: number
    height: number
    heightCss: number
    dpr: number
    viewportWidth: number
    viewportHeight: number
    segments: number
    captureEngine: 'chromium-cdp'
    captureEngineVersion: string
    captureCheckScope: string
    capturedAt: string
    fontFamily: string
  }

// DEV-AI27-17（W17b，A12）：本机窗口摘要。handle 不透明，标题仅用于本机选择。
export type DesktopComputerWindow = {
  handle: string
  process: string
  title: string
  forbidden: boolean
}

export type DesktopComputerWindowListResult =
  | { ok: false; code: string; message: string }
  | { ok: true; windows: DesktopComputerWindow[] }

// DT-04（W17c / 27 §11.5.2）：UIA 控件树视图（C09 脱敏：无进程路径/句柄/截图）。
export type DesktopComputerUiaControl = { id: string; type: string; name: string; value: string }

export type DesktopComputerUiaViewResult =
  | { ok: false; code: string; message: string }
  | { ok: true; window: string; controls: DesktopComputerUiaControl[] }

export type DesktopComputerUiaInvokeResult =
  | { ok: false; code: string; message: string }
  | { ok: true; action: string }

// DEV-AI27-A30：本机标签摘要。origin 为页面 URL 归一后的源（scheme://host[:port]）。
export type DesktopBrowserTab = {
  tab_id: number
  title: string
  origin: string
  window_id: number
  active: boolean
}

export type DesktopBrowserTabListResult =
  | { ok: false; code: string; message: string }
  | { ok: true; tabs: DesktopBrowserTab[] }

// DEV-AI27-A30b：桥配对快照（短码核对 + 组装服务端 confirm 的最小集合；无会话密钥）。
export type DesktopBrowserPairingSnapshot = {
  state: 'unpaired' | 'pairing' | 'paired' | 'revoked'
  pairing: { code: string; expires_at: number; expired: boolean } | null
  extension_instance_id: string | null
  host_pid: number | null
}

export type DesktopBrowserPairingStateResult =
  | { ok: false; code: string; message: string }
  | { ok: true; snapshot: DesktopBrowserPairingSnapshot }

export type DesktopBrowserPairingConfirmResult =
  | { ok: false; code: string; message: string }
  | { ok: true; extension_instance_id: string | null }

// DEV-AI27-A3 第一片：MCP 验证输入与结果。目录只含工具名/哈希/schema，不含任何秘密。
export type DesktopMcpValidateInput = {
  connection_id: string
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  cwd?: string
  url?: string
}

export type DesktopMcpCatalog = {
  tools: Array<{ name: string; description_hash: string; input_schema: unknown; output_schema?: unknown }>
  server_info: { name: string; version: string; protocol_version: string }
  catalog_revision: string
}

export type DesktopMcpValidateResult =
  | { ok: false; code: string; message: string }
  | { ok: true; catalog: DesktopMcpCatalog }

// DEV-AI27-A3 第二片：OAuth 输入与状态摘要。本片只支持 public client（PKCE，无 client_secret）。
export type DesktopMcpOAuthInput = {
  connection_id: string
  server_url: string
  client_id?: string
  scopes?: string[]
}

export type DesktopMcpOAuthStatus = {
  state: 'unauthorized' | 'authorizing' | 'authorized' | 'needs_reauth'
  expires_at: string | null
  has_refresh: boolean
}

export type DesktopMcpOAuthStartResult = {
  ok: boolean
  state: string
  reason: string
}
