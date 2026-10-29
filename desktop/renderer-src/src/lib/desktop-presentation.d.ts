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
    }
  }
}
