type PowerMonitorEvents = {
  on(event: 'suspend' | 'resume', listener: () => void): unknown;
};

export function registerDesktopPowerHandlers(
  powerMonitor: PowerMonitorEvents,
  disconnect: () => void,
  refreshStatus: () => void | Promise<void>
): void {
  powerMonitor.on('suspend', disconnect);
  powerMonitor.on('resume', () => { void refreshStatus(); });
}
