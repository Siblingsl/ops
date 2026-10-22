import type { WebContents, WebContentsView } from 'electron';

export type LocalSettingsPanel = 'connection' | 'ai' | 'account-device' | 'diagnostics';

const LOCAL_SETTINGS_PANELS = new Set<LocalSettingsPanel>([
  'connection',
  'ai',
  'account-device',
  'diagnostics'
]);

export function parseEmbeddedSettingsPanel(value: string): LocalSettingsPanel | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'ops-desktop:'
      || url.hostname !== 'settings'
      || url.username
      || url.password
      || url.port
      || url.search
      || url.hash) return null;
    const match = /^\/embedded\/(connection|ai|account-device|diagnostics)$/.exec(url.pathname);
    const panel = match?.[1] as LocalSettingsPanel | undefined;
    return panel && LOCAL_SETTINGS_PANELS.has(panel) ? panel : null;
  } catch {
    return null;
  }
}

export function getEmbeddedSettingsBounds(width: number, height: number): Electron.Rectangle {
  const windowWidth = Math.max(0, Math.floor(width));
  const windowHeight = Math.max(0, Math.floor(height));
  const dialogWidth = Math.min(1120, Math.max(0, windowWidth - 32));
  const availableHeight = Math.max(0, windowHeight - 96);
  const dialogHeight = Math.min(800, availableHeight);
  const dialogLeft = Math.floor((windowWidth - dialogWidth) / 2);
  const dialogTop = 54 + Math.floor((availableHeight - dialogHeight) / 2);
  return {
    x: dialogLeft + 221,
    y: dialogTop + 97,
    width: Math.max(0, dialogWidth - 222),
    height: Math.max(0, dialogHeight - 136)
  };
}

export interface EmbeddedSettingsSenderEvent {
  sender: Pick<WebContents, 'id' | 'getURL' | 'isDestroyed' | 'mainFrame'>;
  senderFrame: { url: string } | null;
}

export class EmbeddedSettingsSenderRegistry {
  private readonly entries = new Map<number, { webContents: EmbeddedSettingsSenderEvent['sender']; panel: LocalSettingsPanel }>();

  register(webContents: EmbeddedSettingsSenderEvent['sender'], panel: LocalSettingsPanel): () => void {
    const entry = { webContents, panel };
    this.entries.set(webContents.id, entry);
    return () => {
      if (this.entries.get(webContents.id) === entry) this.entries.delete(webContents.id);
    };
  }

  isTrusted(event: EmbeddedSettingsSenderEvent): boolean {
    const entry = this.entries.get(event.sender.id);
    if (!entry || entry.webContents !== event.sender || event.sender.isDestroyed() || !event.senderFrame) return false;
    try {
      return event.senderFrame === event.sender.mainFrame
        && parseEmbeddedSettingsPanel(event.senderFrame.url) === entry.panel
        && parseEmbeddedSettingsPanel(event.sender.getURL()) === entry.panel;
    } catch {
      return false;
    }
  }
}

type SettingsHostEvent = 'resize' | 'resized' | 'maximize' | 'unmaximize' | 'closed';

export interface EmbeddedSettingsHost {
  contentView: {
    addChildView(view: WebContentsView): void;
    removeChildView(view: WebContentsView): void;
  };
  getContentSize(): number[];
  webContents?: Pick<WebContents, 'focus'>;
  isDestroyed(): boolean;
  on(event: SettingsHostEvent, listener: () => void): unknown;
  removeListener(event: SettingsHostEvent, listener: () => void): unknown;
}

export interface LocalSettingsViewControllerOptions {
  registry: EmbeddedSettingsSenderRegistry;
  createView: () => WebContentsView;
}

export function createLocalSettingsViewController({ registry, createView }: LocalSettingsViewControllerOptions) {
  let view: WebContentsView | null = null;
  let host: EmbeddedSettingsHost | null = null;
  let panel: LocalSettingsPanel | null = null;
  let unregister: (() => void) | null = null;
  let destroyed = false;
  const resizeEvents: SettingsHostEvent[] = ['resize', 'resized', 'maximize', 'unmaximize'];
  let resizeHandler: (() => void) | null = null;
  let closeHandler: (() => void) | null = null;

  function updateBounds(): void {
    if (!host || !view) return;
    const [width, height] = host.getContentSize();
    view.setBounds(getEmbeddedSettingsBounds(width, height));
  }

  function detachHost(): void {
    const previousHost = host;
    if (host && view) host.contentView.removeChildView(view);
    if (host && resizeHandler) {
      for (const event of resizeEvents) host.removeListener(event, resizeHandler);
    }
    if (host && closeHandler) host.removeListener('closed', closeHandler);
    unregister?.();
    unregister = null;
    resizeHandler = null;
    closeHandler = null;
    host = null;
    if (previousHost && !previousHost.isDestroyed()) previousHost.webContents?.focus();
  }

  async function show(nextHost: EmbeddedSettingsHost, nextPanel: LocalSettingsPanel): Promise<void> {
    if (destroyed) throw new Error('本机设置视图已关闭。');
    view ??= createView();
    if (host && host !== nextHost) detachHost();
    const panelChanged = panel !== nextPanel;
    if (panelChanged) {
      unregister?.();
      unregister = null;
      panel = nextPanel;
      unregister = registry.register(view.webContents, nextPanel);
    }
    if (host !== nextHost) {
      host = nextHost;
      host.contentView.addChildView(view);
      resizeHandler = updateBounds;
      closeHandler = destroy;
      for (const event of resizeEvents) host.on(event, resizeHandler);
      host.on('closed', closeHandler);
      if (!unregister) unregister = registry.register(view.webContents, nextPanel);
    }
    if (panelChanged) await view.webContents.loadURL(`ops-desktop://settings/embedded/${nextPanel}`);
    updateBounds();
    view.webContents.focus?.();
  }

  function detach(): void {
    detachHost();
  }

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    detachHost();
    if (view && !view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
    view = null;
    panel = null;
  }

  return {
    show,
    detach,
    destroy,
    isTrusted: (event: EmbeddedSettingsSenderEvent) => registry.isTrusted(event),
    get isDestroyed() { return destroyed; },
    get currentHost() { return host; },
    get currentPanel() { return panel; },
    get webContents() { return view?.webContents ?? null; }
  };
}
