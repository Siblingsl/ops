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
      // DEV-AI27-A30：本机标签枚举（选标签授权弹窗；枚举只在本机，桥未配对时如实报错）。
      listBrowserTabs(): Promise<DesktopBrowserTabListResult>
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
