// POLISH-01（docs/43 §1.1 / §1.2）：桌面能力唯一收口层。
// 业务 UI 只经过本模块访问桌面桥：桌面端走 IPC，浏览器环境统一安全降级为 supported: false；
// 环境探针与订阅必须 SSR / Node 安全——window / navigator 缺失时一律不抛错。
import { isElectronDesktop, type CXLongImageCaptureResult, type DesktopBrowserPairingConfirmResult, type DesktopBrowserPairingStateResult, type DesktopBrowserTabFocusResult, type DesktopBrowserTabListResult, type DesktopClientHealth, type DesktopComputerUiaActResult, type DesktopComputerUiaInvalidateResult, type DesktopComputerUiaObserveResult, type DesktopComputerUiaViewResult, type DesktopComputerUiaInvokeResult, type DesktopComputerWindowListResult, type DesktopLocalSettingsAction, type DesktopMcpOAuthInput, type DesktopMcpOAuthStartResult, type DesktopMcpOAuthStatus, type DesktopMcpValidateInput, type DesktopMcpValidateResult, type DesktopPlatformIntentResult, type DesktopPlatformLoginInput, type DesktopUiActionResult, type DesktopUpdateOpenResult, type DesktopUpdateStatus, type DesktopUpdateStatusResult, type DesktopXhsManualImageExportInput, type DesktopXhsManualImageExportResult } from './desktop-presentation.js'

export type DesktopBridge = NonNullable<Window['opsDesktopUI']>
export type DesktopUnsupportedResult = { ok: false; supported: false; code: 'desktop_only'; message: string }
export type DesktopBridgeResult<T extends { ok: boolean }> = T | DesktopUnsupportedResult
export type PlatformBridgeInfo = { mode: 'desktop' | 'web'; isElectron: boolean; supported: boolean }

const UNSUPPORTED_MESSAGE = '当前环境不支持此桌面客户端能力。'

/** 唯一读取入口：Web / SSR 下返回 null，调用方据此走既有降级分支。 */
export function getDesktopBridge(): DesktopBridge | null {
  return typeof window !== 'undefined' ? (window.opsDesktopUI ?? null) : null
}

export function isDesktopBridgeAvailable(): boolean {
  return getDesktopBridge() !== null
}

/** 方法级探针：旧宿主可能整桥存在但缺少某几个固定意图，必须按方法判断而不是按桥判断。 */
export function hasDesktopBridgeMethod<K extends keyof DesktopBridge>(method: K): boolean {
  const bridge = getDesktopBridge()
  return !!bridge && typeof bridge[method] === 'function'
}

export function getPlatformBridgeInfo(): PlatformBridgeInfo {
  const isElectron = typeof navigator !== 'undefined' && isElectronDesktop(navigator.userAgent)
  const supported = isDesktopBridgeAvailable()
  return { mode: isElectron || supported ? 'desktop' : 'web', isElectron, supported }
}

export function unsupportedBridgeResult(message = UNSUPPORTED_MESSAGE): DesktopUnsupportedResult {
  return { ok: false, supported: false, code: 'desktop_only', message }
}

export function isUnsupportedBridgeResult(result: unknown): result is DesktopUnsupportedResult {
  if (!result || typeof result !== 'object') return false
  const candidate = result as { ok?: unknown; supported?: unknown; code?: unknown }
  return candidate.ok === false && candidate.supported === false && candidate.code === 'desktop_only'
}

// ---------------------------------------------------------------------------
// 事件订阅：桥或对应方法缺失时返回可安全调用的空函数，绝不抛错。
// ---------------------------------------------------------------------------

export function subscribeDesktopOpenSettings(listener: () => void): () => void {
  const bridge = getDesktopBridge()
  if (!bridge?.onOpenSettings) return () => {}
  return bridge.onOpenSettings(listener)
}

export function subscribeDesktopLocalSettingsState(listener: (state: { dirty: boolean; busy: boolean }) => void): () => void {
  const bridge = getDesktopBridge()
  if (!bridge?.onLocalSettingsState) return () => {}
  return bridge.onLocalSettingsState(listener)
}

export function subscribeDesktopPlatformIntentResult(listener: (result: DesktopPlatformIntentResult) => void): () => void {
  const bridge = getDesktopBridge()
  if (!bridge?.onPlatformIntentResult) return () => {}
  return bridge.onPlatformIntentResult(listener)
}

export function subscribeDesktopClientHealth(listener: (health: DesktopClientHealth) => void): () => void {
  const bridge = getDesktopBridge()
  if (!bridge?.onClientHealth) return () => {}
  return bridge.onClientHealth(listener)
}

export function subscribeDesktopUpdateStatus(listener: (status: DesktopUpdateStatus) => void): () => void {
  const bridge = getDesktopBridge()
  if (!bridge?.onUpdateStatus) return () => {}
  return bridge.onUpdateStatus(listener)
}

/** 内置浏览快照：桥侧类型只声明基础字段，业务组件的快照更宽，只在桥接层做单点泛型适配。 */
export function subscribeDesktopInBrowseSnapshot<T = unknown>(listener: (snapshot: T) => void): () => void {
  const bridge = getDesktopBridge()
  if (!bridge?.onInBrowseSnapshot) return () => {}
  return bridge.onInBrowseSnapshot(listener as unknown as Parameters<DesktopBridge['onInBrowseSnapshot']>[0])
}

export function subscribeDesktopRealtimeEvent(listener: Parameters<DesktopBridge['onRealtimeEvent']>[0]): () => void {
  const bridge = getDesktopBridge()
  if (!bridge?.onRealtimeEvent) return () => {}
  return bridge.onRealtimeEvent(listener)
}

export function subscribeDesktopSidepanelDraft(listener: (draft: { text: string }) => void): () => void {
  const bridge = getDesktopBridge()
  if (!bridge?.onSidepanelDraft) return () => {}
  return bridge.onSidepanelDraft(listener)
}

export function subscribeDesktopSidepanelStop(listener: () => void): () => void {
  const bridge = getDesktopBridge()
  if (!bridge?.onSidepanelStop) return () => {}
  return bridge.onSidepanelStop(listener)
}

// ---------------------------------------------------------------------------
// 固定意图：桥或方法缺失时统一返回 unsupportedBridgeResult，绝不抛错；
// 存在时原样透传入参与返回值，底层 IPC 抛错按原样传播给调用方的既有 try/catch。
// ---------------------------------------------------------------------------

export async function getDesktopUpdateStatus(): Promise<DesktopBridgeResult<DesktopUpdateStatusResult>> {
  const bridge = getDesktopBridge()
  if (!bridge?.getUpdateStatus) return unsupportedBridgeResult('当前 OPS 桌面客户端不支持读取更新状态，请重启客户端后重试。')
  return bridge.getUpdateStatus()
}

export async function checkDesktopUpdate(): Promise<DesktopBridgeResult<DesktopUpdateStatusResult>> {
  const bridge = getDesktopBridge()
  if (!bridge?.checkUpdate) return unsupportedBridgeResult('当前 OPS 桌面客户端不支持检查更新，请重启客户端后重试。')
  return bridge.checkUpdate()
}

export async function openDesktopUpdateDownload(): Promise<DesktopBridgeResult<DesktopUpdateOpenResult>> {
  const bridge = getDesktopBridge()
  if (!bridge?.openUpdateDownload) return unsupportedBridgeResult('当前 OPS 桌面客户端不支持打开更新下载页，请重启客户端后重试。')
  return bridge.openUpdateDownload()
}

export async function openDesktopPlatformLogin(input: DesktopPlatformLoginInput): Promise<DesktopBridgeResult<DesktopUiActionResult>> {
  const bridge = getDesktopBridge()
  if (!bridge?.openPlatformLogin) return unsupportedBridgeResult('当前 OPS 桌面客户端不支持平台登录，请重启客户端后重试。')
  return bridge.openPlatformLogin(input)
}

export async function setDesktopLocalSettingsPanel(action: DesktopLocalSettingsAction): Promise<DesktopBridgeResult<DesktopUiActionResult>> {
  const bridge = getDesktopBridge()
  if (!bridge?.setLocalSettingsPanel) return unsupportedBridgeResult('当前 OPS 桌面客户端不支持本机设置面板，请重启客户端后重试。')
  return bridge.setLocalSettingsPanel(action)
}

export async function openXhsManualImageFolder(input: DesktopXhsManualImageExportInput): Promise<DesktopBridgeResult<DesktopXhsManualImageExportResult>> {
  const bridge = getDesktopBridge()
  if (!bridge?.openXhsManualImageFolder) return unsupportedBridgeResult('当前 OPS 桌面客户端不支持导出图片文件夹，请重启客户端后重试。')
  return bridge.openXhsManualImageFolder(input)
}

export async function captureDesktopLongImage(buildId: string): Promise<DesktopBridgeResult<CXLongImageCaptureResult>> {
  const bridge = getDesktopBridge()
  if (!bridge?.captureLongImage) return unsupportedBridgeResult('当前 OPS 桌面客户端不支持安全长图，请升级客户端后重试。')
  return bridge.captureLongImage(buildId)
}

export async function listDesktopComputerWindows(): Promise<DesktopBridgeResult<DesktopComputerWindowListResult>> {
  const bridge = getDesktopBridge()
  if (!bridge?.listComputerWindows) return unsupportedBridgeResult('当前 OPS 桌面客户端不支持枚举本机窗口，请重启客户端后重试。')
  return bridge.listComputerWindows()
}

export async function readDesktopComputerUIA(input: Parameters<DesktopBridge['readComputerUIA']>[0]): Promise<DesktopBridgeResult<DesktopComputerUiaViewResult>> {
  const bridge = getDesktopBridge()
  if (!bridge?.readComputerUIA) return unsupportedBridgeResult('当前 OPS 桌面客户端不支持读取界面控件，请重启客户端后重试。')
  return bridge.readComputerUIA(input)
}

export async function invokeDesktopComputerUIA(input: Parameters<DesktopBridge['invokeComputerUIA']>[0]): Promise<DesktopBridgeResult<DesktopComputerUiaInvokeResult>> {
  const bridge = getDesktopBridge()
  if (!bridge?.invokeComputerUIA) return unsupportedBridgeResult('当前 OPS 桌面客户端不支持操作界面控件，请重启客户端后重试。')
  return bridge.invokeComputerUIA(input)
}

export async function observeDesktopComputerUIA(input: Parameters<DesktopBridge['observeComputerUIA']>[0]): Promise<DesktopBridgeResult<DesktopComputerUiaObserveResult>> {
  const bridge = getDesktopBridge()
  if (!bridge?.observeComputerUIA) return unsupportedBridgeResult('当前 OPS 桌面客户端不支持观察界面控件，请重启客户端后重试。')
  return bridge.observeComputerUIA(input)
}

export async function actDesktopComputerUIA(input: Parameters<DesktopBridge['actComputerUIA']>[0]): Promise<DesktopBridgeResult<DesktopComputerUiaActResult>> {
  const bridge = getDesktopBridge()
  if (!bridge?.actComputerUIA) return unsupportedBridgeResult('当前 OPS 桌面客户端不支持操作界面控件，请重启客户端后重试。')
  return bridge.actComputerUIA(input)
}

export async function invalidateDesktopComputerUIA(grantId: string): Promise<DesktopBridgeResult<DesktopComputerUiaInvalidateResult>> {
  const bridge = getDesktopBridge()
  if (!bridge?.invalidateComputerUIA) return unsupportedBridgeResult('当前 OPS 桌面客户端不支持撤销界面快照，请重启客户端后重试。')
  return bridge.invalidateComputerUIA(grantId)
}

export async function listDesktopBrowserTabs(): Promise<DesktopBridgeResult<DesktopBrowserTabListResult>> {
  const bridge = getDesktopBridge()
  if (!bridge?.listBrowserTabs) return unsupportedBridgeResult('当前 OPS 桌面客户端不支持读取本机标签，请重启客户端后重试。')
  return bridge.listBrowserTabs()
}

export async function focusDesktopBrowserTab(tabId: number): Promise<DesktopBridgeResult<DesktopBrowserTabFocusResult>> {
  const bridge = getDesktopBridge()
  if (!bridge?.focusBrowserTab) return unsupportedBridgeResult('当前 OPS 桌面客户端不支持切换标签，请重启客户端后重试。')
  return bridge.focusBrowserTab(tabId)
}

export async function getDesktopBrowserPairingState(): Promise<DesktopBridgeResult<DesktopBrowserPairingStateResult>> {
  const bridge = getDesktopBridge()
  if (!bridge?.getBrowserPairingState) return unsupportedBridgeResult('当前 OPS 桌面客户端不支持读取浏览器配对状态，请重启客户端后重试。')
  return bridge.getBrowserPairingState()
}

export async function confirmDesktopBrowserPairing(): Promise<DesktopBridgeResult<DesktopBrowserPairingConfirmResult>> {
  const bridge = getDesktopBridge()
  if (!bridge?.confirmBrowserPairing) return unsupportedBridgeResult('当前 OPS 桌面客户端不支持确认浏览器配对，请重启客户端后重试。')
  return bridge.confirmBrowserPairing()
}

export async function validateDesktopMcpConnection(input: DesktopMcpValidateInput): Promise<DesktopBridgeResult<DesktopMcpValidateResult>> {
  const bridge = getDesktopBridge()
  if (!bridge?.validateMcpConnection) return unsupportedBridgeResult('当前 OPS 桌面客户端不支持验证 MCP 连接，请重启客户端后重试。')
  return bridge.validateMcpConnection(input)
}

export async function startDesktopMcpOAuth(input: DesktopMcpOAuthInput): Promise<DesktopBridgeResult<DesktopMcpOAuthStartResult>> {
  const bridge = getDesktopBridge()
  if (!bridge?.startMcpOAuth) return unsupportedBridgeResult('当前 OPS 桌面客户端不支持 MCP 授权，请重启客户端后重试。')
  return bridge.startMcpOAuth(input)
}

export async function getDesktopMcpOAuthStatus(input: DesktopMcpOAuthInput): Promise<DesktopMcpOAuthStatus | null> {
  const bridge = getDesktopBridge()
  if (!bridge?.getMcpOAuthStatus) return null
  return bridge.getMcpOAuthStatus(input)
}

export async function revokeDesktopMcpOAuth(input: DesktopMcpOAuthInput): Promise<{ ok: boolean; supported?: false }> {
  const bridge = getDesktopBridge()
  if (!bridge?.revokeMcpOAuth) return { ok: false, supported: false }
  return bridge.revokeMcpOAuth(input)
}

/** 内置浏览固定意图：取到原始调用器供需要读取原始返回体的组件使用（如实时语音）。 */
export function getDesktopInBrowseInvoker(): DesktopBridge['invokeInBrowse'] | null {
  return getDesktopBridge()?.invokeInBrowse ?? null
}

/** 内置浏览固定意图：桥缺失返回 unsupported，成功时把原始返回体收敛到 data。 */
export async function invokeDesktopInBrowse(channel: string, payload?: unknown): Promise<{ ok: true; data: unknown } | DesktopUnsupportedResult> {
  const bridge = getDesktopBridge()
  if (!bridge?.invokeInBrowse) return unsupportedBridgeResult('当前 OPS 桌面客户端不支持内置浏览，请重启客户端后重试。')
  return { ok: true, data: await bridge.invokeInBrowse(channel, payload) }
}
