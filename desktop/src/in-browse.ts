import { BrowserWindow, WebContentsView, session, type Session } from 'electron';
import * as crypto from 'node:crypto';

// DEV-AI27-08（W08，D-172 裁决）：内置浏览视图——Codex 同款双路径之"应用内"承载。
// Electron WebContentsView 实现右侧工作视图的浏览体验（27 §7.8 功能表）。
// 第三批（W08d）：多页签——每 tab 独立 WebContentsView/导航代数，单活动 tab 挂载显示，
// 切换 = 移除旧视图挂新视图；关闭需确认语义由渲染器处理（未保存输入由页面自身管理）。
// 边界：独立浏览会话（不共享业务 session/登录态）；渲染器只能发固定意图；
// 原生视图层级：浮层出现前由宿主 detach（27 §5.6）；无沙箱模式整个桥关闭（W05）。

export const IN_BROWSE_MIN_WIDTH = 320;
export const IN_BROWSE_MAX_URL_LENGTH = 2048;
export const IN_BROWSE_MAX_TABS = 8;

export interface InBrowseBounds {
  x: number; y: number; width: number; height: number;
}

export interface InBrowseTabSnapshot {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  navigationGeneration: number;
}

export interface InBrowseSnapshot {
  activeTabId: string | null;
  tabs: InBrowseTabSnapshot[];
  bounds: InBrowseBounds | null;
  detached: boolean;
  detachReason: string | null;
}

type DetachReason = 'approval-dialog' | 'menu' | 'account-switch' | 'settings' | 'close';

interface InBrowseTab {
  id: string;
  view: WebContentsView;
  navigationGeneration: number;
}

/** 单窗口内置浏览视图控制器（多页签）。 */
export class InBrowseViewController {
  private tabs = new Map<string, InBrowseTab>();
  private tabOrder: string[] = [];
  private activeTabId: string | null = null;
  private bounds: InBrowseBounds | null = null;
  private detached = false;
  private detachReason: DetachReason | null = null;

  constructor(
    readonly window: BrowserWindow,
    private readonly browseSession: Session,
    private readonly onSnapshot: (snapshot: InBrowseSnapshot) => void,
  ) {}

  snapshot(): InBrowseSnapshot {
    const tabs: InBrowseTabSnapshot[] = this.tabOrder.map((id) => {
      const tab = this.tabs.get(id)!;
      return {
        id,
        url: tab.view.webContents.getURL(),
        title: tab.view.webContents.getTitle(),
        loading: tab.view.webContents.isLoading(),
        navigationGeneration: tab.navigationGeneration,
      };
    });
    return {
      activeTabId: this.activeTabId,
      tabs,
      bounds: this.detached ? null : this.bounds,
      detached: this.detached,
      detachReason: this.detachReason,
    };
  }

  private createTab(): InBrowseTab {
    const view = new WebContentsView({
      webPreferences: {
        session: this.browseSession,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
        devTools: false,
      },
    });
    const tab: InBrowseTab = { id: crypto.randomUUID(), view, navigationGeneration: 0 };
    // 导航代数递增：SPA 路由与整页导航都算（27 §8.3 旧观察失效语义）。
    view.webContents.on('did-start-navigation', () => {
      tab.navigationGeneration += 1;
      this.emitSnapshot();
    });
    view.webContents.on('did-stop-loading', () => this.emitSnapshot());
    view.webContents.on('page-title-updated', () => this.emitSnapshot());
    this.tabs.set(tab.id, tab);
    this.tabOrder.push(tab.id);
    return tab;
  }

  private activeTab(): InBrowseTab | null {
    if (!this.activeTabId) return null;
    return this.tabs.get(this.activeTabId) ?? null;
  }

  private mountActive(): void {
    const tab = this.activeTab();
    if (!tab || this.detached) return;
    if (this.bounds) {
      tab.view.setBounds({
        x: this.bounds.x, y: this.bounds.y,
        width: Math.max(IN_BROWSE_MIN_WIDTH, this.bounds.width),
        height: this.bounds.height,
      });
    }
    this.window.contentView.addChildView(tab.view);
  }

  /** 打开新页签并激活（27 §7.8：新建空页不自动开 AI 任务）。 */
  openTab(): string {
    if (this.tabOrder.length >= IN_BROWSE_MAX_TABS) {
      // 上限：不静默吞掉，返回当前活动（渲染器显示"已达上限"）。
      return this.activeTabId ?? '';
    }
    this.unmountCurrent();
    const tab = this.createTab();
    this.activeTabId = tab.id;
    this.mountActive();
    this.emitSnapshot();
    return tab.id;
  }

  /** 切换活动页签。 */
  switchTab(tabID: string): boolean {
    if (!this.tabs.has(tabID) || tabID === this.activeTabId) return false;
    this.unmountCurrent();
    this.activeTabId = tabID;
    this.mountActive();
    this.emitSnapshot();
    return true;
  }

  private unmountCurrent(): void {
    const current = this.activeTab();
    if (current) {
      try { this.window.contentView.removeChildView(current.view); } catch { /* 未挂载 */ }
    }
  }

  /** 关闭页签（27 §7.8：关闭活动目标先停控；最后一个关闭后视图清空）。 */
  closeTab(tabID: string): void {
    const tab = this.tabs.get(tabID);
    if (!tab) return;
    const removedIdx = this.tabOrder.indexOf(tabID);
    try { tab.view.webContents.stop(); } catch { /* 已销毁 */ }
    try { this.window.contentView.removeChildView(tab.view); } catch { /* 未挂载 */ }
    this.tabs.delete(tabID);
    this.tabOrder = this.tabOrder.filter((id) => id !== tabID);
    if (this.activeTabId === tabID) {
      // 激活相邻页签（同位置右邻，末位则左邻）。idx 必须在 filter 前取。
      this.activeTabId = this.tabOrder[Math.min(removedIdx, this.tabOrder.length - 1)] ?? null;
      if (this.activeTabId && !this.detached) this.mountActive();
    }
    this.emitSnapshot();
  }

  private emitSnapshot(): void {
    this.onSnapshot(this.snapshot());
  }

  /** 设置工作视图内的显示区域（渲染器布局同步）。 */
  setBounds(raw: { x: number; y: number; width: number; height: number }): void {
    const bounds = {
      x: raw.x, y: raw.y,
      width: Math.max(IN_BROWSE_MIN_WIDTH, raw.width),
      height: raw.height,
    };
    this.bounds = bounds;
    const tab = this.activeTab();
    if (tab && !this.detached) {
      if (!this.window.contentView.children.includes(tab.view)) {
        this.window.contentView.addChildView(tab.view);
      }
      tab.view.setBounds(bounds);
    }
    this.emitSnapshot();
  }

  /** 固定意图：在活动页签导航（http/https 限定，27 §14.3）。 */
  navigate(rawUrl: string): { ok: boolean; reason?: string } {
    if (this.detached) return { ok: false, reason: 'detached' };
    if (!rawUrl || rawUrl.length > IN_BROWSE_MAX_URL_LENGTH) return { ok: false, reason: 'url_invalid' };
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return { ok: false, reason: 'url_invalid' };
    }
    if (!/^https?:$/.test(parsed.protocol)) return { ok: false, reason: 'protocol_denied' };
    let tab = this.activeTab();
    if (!tab) {
      // 无活动页签时自动开一个（渲染器直接输地址的场景）。
      const id = this.openTab();
      tab = this.tabs.get(id) ?? null;
      if (!tab) return { ok: false, reason: 'tab_limit' };
    }
    void tab.view.webContents.loadURL(parsed.href);
    return { ok: true };
  }

  goBack(): void { this.activeTab()?.view.webContents.goBack(); }
  goForward(): void { this.activeTab()?.view.webContents.goForward(); }
  reload(): void { this.activeTab()?.view.webContents.reload(); }
  stopLoading(): void { this.activeTab()?.view.webContents.stop(); }

  /** 原生浮层出现前：移除活动视图（27 §5.6）。 */
  detach(reason: DetachReason): void {
    this.detached = true;
    this.detachReason = reason;
    this.unmountCurrent();
    this.emitSnapshot();
  }

  /** 浮层关闭后：重挂活动视图。 */
  attach(): void {
    this.detached = false;
    this.detachReason = null;
    if (this.activeTab() && this.bounds) this.mountActive();
    this.emitSnapshot();
  }

  isDetached(): { detached: boolean; reason: DetachReason | null } {
    return { detached: this.detached, reason: this.detachReason };
  }

  destroy(): void {
    for (const [, tab] of this.tabs) {
      try { tab.view.webContents.stop(); } catch { /* 已销毁 */ }
      try { this.window.contentView.removeChildView(tab.view); } catch { /* 未挂载 */ }
    }
    this.tabs.clear();
    this.tabOrder = [];
    this.activeTabId = null;
    this.bounds = null;
    this.emitSnapshot();
  }
}

// ---------------------------------------------------------------------------
// 每业务窗口单例 + 生命周期
// ---------------------------------------------------------------------------

const controllers = new WeakMap<BrowserWindow, InBrowseViewController>();

export function getInBrowseController(window: BrowserWindow): InBrowseViewController | null {
  return controllers.get(window) ?? null;
}

export function bindInBrowseController(window: BrowserWindow, onSnapshot: (s: InBrowseSnapshot) => void): InBrowseViewController {
  const existing = controllers.get(window);
  if (existing) return existing;
  const browseSession: Session = session.fromPartition('ops-inbrowse', { cache: true });
  const controller = new InBrowseViewController(window, browseSession, onSnapshot);
  controllers.set(window, controller);
  window.once('closed', () => controller.destroy());
  return controller;
}

export function inBrowseDetachForOverlay(window: BrowserWindow, reason: DetachReason): void {
  controllers.get(window)?.detach(reason);
}

export function inBrowseAttachAfterOverlay(window: BrowserWindow): void {
  controllers.get(window)?.attach();
}
