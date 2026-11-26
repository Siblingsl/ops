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
      // OPT-U03（docs/43 §4）：小红书人工接管包——图片按序导出到本机临时目录并打开文件夹。
      // 参数只含 workId 与图片字节；返回值只含张数与安全文件名，本机绝对路径永不回传。
      openXhsManualImageFolder(input: DesktopXhsManualImageExportInput): Promise<DesktopXhsManualImageExportResult>
      // OPT-U04（docs/43 §4）：平台重登 / 本机设置面板固定意图——主进程直接打开登录窗并派发面板，
      // 业务页不再依赖会被拦截的 window.open（RC-03 桌面重登 null 的根治入口）。
      openPlatformLogin(input: DesktopPlatformLoginInput): Promise<DesktopUiActionResult>
      setLocalSettingsPanel(action: DesktopLocalSettingsAction): Promise<DesktopUiActionResult>
      // OPT-E02（docs/43 §5）：客户端版本更新——状态推送/读取/立即检查/打开受信任下载页。
      // 打开下载页不接受渲染器传入 URL，主进程只用自身已校验过的链接。
      onUpdateStatus(listener: (status: DesktopUpdateStatus) => void): () => void
      getUpdateStatus(): Promise<DesktopUpdateStatusResult>
      checkUpdate(): Promise<DesktopUpdateStatusResult>
      openUpdateDownload(): Promise<DesktopUpdateOpenResult>
      // POLISH-02（docs/43 §4 第 3.2 条）：本机连接/运行/版本诊断——只读 16 键摘要 + 脱敏导出（均无参）。
      // 摘要不含 apiKey/token/cookie/deviceId/filePath；导出只回取消与否，不回本机路径。
      getClientDiagnostics(): Promise<DesktopClientDiagnosticsResult>
      exportClientDiagnostics(): Promise<DesktopClientDiagnosticsExportResult>
      // DEV-AI27-17（W17b，A12）：本机选窗器（枚举只在本机，handle 不透明）。
      listComputerWindows(): Promise<DesktopComputerWindowListResult>
      // DT-04（W17c / 27 §11.5.2）：UIA 主链路固定意图——结果按 C09 白名单逐控件校验，
      // 只含 id/type/name/value 四键，进程路径/窗口全集/截图不进渲染器。
      readComputerUIA(input: { pid: number; target_summary: string }): Promise<DesktopComputerUiaViewResult>
      invokeComputerUIA(input: { pid: number; automation_id: string; value?: string | null; target_summary: string }): Promise<DesktopComputerUiaInvokeResult>
      // DEV-CU P3-7（docs/36 §4.12）：observe/act/invalidate 三个固定意图——
      // observe 结果按 C09 白名单递归校验（native_id 等内部字段不可枚举，出现即整批拒绝）；
      // act 结果校验 disposition 双字段一致性；invalidate 按 grant 撤销快照。
      observeComputerUIA(input: {
        pid: number; target_summary: string; grant_id: string; generation: number
        max_depth?: number; root_ref?: string; interactive_only?: boolean; compact?: boolean
      }): Promise<DesktopComputerUiaObserveResult>
      actComputerUIA(input: {
        pid: number; ref: string; grant_id: string; generation: number
        action: string; value?: string | null; target_summary: string
      }): Promise<DesktopComputerUiaActResult>
      invalidateComputerUIA(grantId: string): Promise<DesktopComputerUiaInvalidateResult>
      // DEV-AI27-A30：本机标签枚举（选标签授权弹窗；枚举只在本机，桥未配对时如实报错）。
      listBrowserTabs(): Promise<DesktopBrowserTabListResult>
      // BR-09：用户主动“查看操作”把 Agent 操作的标签切到前台；Agent 工具目录无此入口。
      focusBrowserTab(tabId: number): Promise<DesktopBrowserTabFocusResult>
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

export type DesktopXhsManualImageExt = 'png' | 'jpg' | 'webp' | 'gif'

export type DesktopXhsManualImageExportInput = {
  workId: string
  files: Array<{ ext: DesktopXhsManualImageExt; bytes: Uint8Array }>
}

export type DesktopXhsManualImageExportResult =
  | { ok: false; code: string; message: string }
  | { ok: true; count: number; fileNames: string[] }

// OPT-U04（docs/43 §4）：桌面平台登录与本机设置面板的固定意图。
// 输入只含账号与平台 / 面板动作；返回值只允许 { ok: true } 或 { ok: false, code, message }。
export type DesktopUiPlatform = 'wechat_mp' | 'xhs' | 'toutiao'

export type DesktopPlatformLoginInput = {
  accountId: string
  platform: DesktopUiPlatform
}

export type DesktopLocalSettingsAction = 'connection' | 'ai' | 'account-device' | 'diagnostics' | 'detach' | 'close'

export type DesktopUiActionResult =
  | { ok: false; code: string; message: string }
  | { ok: true }

// OPT-E02（docs/43 §5）：更新状态固定 9 键，由 preload 的严格白名单收敛后进入渲染器。
export type DesktopUpdateStatusKind =
  | 'idle'
  | 'checking'
  | 'update-available'
  | 'up-to-date'
  | 'unconfigured'
  | 'error'

export type DesktopUpdateStatus = {
  status: DesktopUpdateStatusKind
  currentVersion: string
  latestVersion: string
  updateAvailable: boolean
  releaseNotes: string
  downloadUrl: string
  sha256: string
  checkedAt: number | null
  error: string
}

export type DesktopUpdateStatusResult =
  | { ok: false; code: string; message: string }
  | { ok: true; status: DesktopUpdateStatus }

export type DesktopUpdateOpenResult =
  | { ok: false; code: string; message: string }
  | { ok: true }

// POLISH-02（docs/43 §4 第 3.2 条）：本机诊断只读摘要，严格 16 键（字母序即白名单顺序）。
// 严禁追加 apiKey / token / cookie / password / deviceId / username / workspaceName / apiOrigin / filePath。
export type DesktopClientDiagnostics = {
  appVersion: string
  electronVersion: string
  platform: string
  arch: string
  connectionState: 'online' | 'offline' | 'unknown'
  mode: 'server' | 'desktop'
  channelState: 'disconnected' | 'connecting' | 'ready' | 'error'
  channelMessage: string
  routeRevision: number
  signedIn: boolean
  reauthRequired: boolean
  storageAvailable: boolean
  localConfigAvailable: boolean
  deviceRegistered: boolean | null
  modelCount: number | null
  activeModelRequests: number
}

export type DesktopClientDiagnosticsResult =
  | { ok: false; code: string; message: string }
  | { ok: true; diagnostics: DesktopClientDiagnostics }

export type DesktopClientDiagnosticsExportResult =
  | { ok: false; code: string; message: string }
  | { ok: true; canceled: boolean }

// DEV-AI27-17（W17b，A12）：本机窗口摘要。handle 不透明，标题仅用于本机选择。
// DEV-CU P5-2（用户选定方案①）：补 pid——observe/act 必填 pid，handle 不可逆无法反解；
// pid 只在本机渲染器↔主进程间使用，不上送服务端或模型（C09 仍禁进程路径/句柄/窗口全集）。
export type DesktopComputerWindow = {
  pid: number
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

// DEV-CU P3-7（docs/36 §4.12）：observe 树节点白名单类型。
// 键集合整批拒绝：process_path/hwnd/class_name/native_id 等内部字段不可出现。
export type DesktopComputerUiaObserveNode = {
  role: string
  name: string
  value: string
  ref_id: string
  available_actions: string[]
  states: string[]
  bounds: { x: number; y: number; w: number; h: number }
  children: DesktopComputerUiaObserveNode[]
  children_count: number
  depth: number
}

export type DesktopComputerUiaObserveResult =
  | { ok: false; code: string; message: string }
  | {
    ok: true
    snapshot_id: string
    revision: number
    ref_count: number
    complete: boolean
    nodes_observed: number
    truncated?: boolean
    identity_unproven?: boolean
    tree: DesktopComputerUiaObserveNode
  }

export type DesktopComputerUiaActResult =
  | { ok: false; code: string; message: string }
  | {
    ok: true
    action: string
    snapshot_id?: string
    ref?: string
    disposition: { delivery: string; retry: string }
    verification_scope?: string
    verification_reason?: string
    steps?: Array<{ label: string; outcome: string; mechanism: string }>
  }

export type DesktopComputerUiaInvalidateResult =
  | { ok: false; code: string; message: string }
  | { ok: true; cleared: number }

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

// BR-09：用户主动“查看操作”的结果；只回标签句柄。
export type DesktopBrowserTabFocusResult =
  | { ok: false; code: string; message: string }
  | { ok: true; tab_id: number }

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
