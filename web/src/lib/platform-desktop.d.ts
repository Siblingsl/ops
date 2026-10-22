interface Window {
  opsDesktopSettings?: {
    platformCommand(envelope: { v: number; id: string; cmd: string; payload?: unknown }): Promise<unknown>
    openSettings(): Promise<void>
  }
}
