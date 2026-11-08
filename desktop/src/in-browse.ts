import { BrowserWindow, WebContentsView, session, type Session } from 'electron';
import * as crypto from 'node:crypto';

// DEV-AI27-08（W08，D-172 裁决）：内置浏览视图——Codex 同款双路径之"应用内"承载。
// Electron WebContentsView 实现右侧工作视图的浏览体验（27 §7.8 功能表）。
// 边界：独立浏览会话（不共享业务 session/登录态）；渲染器只能发固定意图；
// 原生视图层级：审批框/菜单出现前由宿主隐藏视图（27 §5.6），React z-index 不参与；
// 无沙箱模式（OPS_DESKTOP_NO_SANDBOX=1）时整个桥关闭（W05 已实现），本模块不单独绕过。

export const IN_BROWSE_MIN_WIDTH = 320;
export const IN_BROWSE_MAX_URL_LENGTH = 2048;

export interface InBrowseSnapshot {
  bounds: { x: number; y: number; width: number; height: number } | null;
  url: string;
  title: string;
  loading: boolean;
  navigationGeneration: number;
}

type DetachReason = 'approval-dialog' | 'menu' | 'account-switch' | 'settings' | 'close';

/**
 * 单窗口内置浏览视图控制器。
 * - 视图挂在业务窗口上，bounds 由渲染器经固定意图同步（跟随工作视图布局）。
 * - 导航代数（navigationGeneration）随每次导航/刷新递增；旧观察引用随代数失效。
 * - detaches：审批框/菜单/设置等原生浮层出现前调用 detach()，关闭后 attach() 并重核目标。
 */
export class InBrowseViewController {
  private view: WebContentsView | null = null;
  private bounds: InBrowseSnapshot['bounds'] = null;
  private navigationGeneration = 0;
  private detached = false;
  private detachReason: DetachReason | null = null;

  constructor(
    readonly window: BrowserWindow,
    private readonly browseSession: Session,
    private readonly onSnapshot: (snapshot: InBrowseSnapshot) => void,
  ) {}

  snapshot(): InBrowseSnapshot {
    const url = this.view?.webContents.getURL() ?? '';
    return {
      bounds: this.detached ? null : this.bounds,
      url,
      title: this.view?.webContents.getTitle() ?? '',
      loading: this.view ? this.view.webContents.isLoading() : false,
      navigationGeneration: this.navigationGeneration,
    };
  }

  private ensureView(): WebContentsView {
    if (this.view && !this.view.webContents.isDestroyed()) return this.view;
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
    // 导航代数递增：SPA 路由与整页导航都算（27 §8.3 旧观察失效语义）。
    view.webContents.on('did-start-navigation', () => {
      this.navigationGeneration += 1;
      this.emitSnapshot();
    });
    view.webContents.on('did-stop-loading', () => this.emitSnapshot());
    view.webContents.on('page-title-updated', () => this.emitSnapshot());
    this.view = view;
    if (this.bounds) this.applyBounds();
    return view;
  }

  private applyBounds(): void {
    if (this.view && this.bounds) {
      this.view.setBounds({
        x: this.bounds.x, y: this.bounds.y,
        width: Math.max(IN_BROWSE_MIN_WIDTH, this.bounds.width),
        height: this.bounds.height,
      });
    }
  }

  private emitSnapshot(): void {
    this.onSnapshot(this.snapshot());
  }

  /** 设置工作视图内的显示区域（渲染器布局同步）。 */
  setBounds(raw: { x: number; y: number; width: number; height: number }): void {
    // clamp 后记录（快照与视图实际 bounds 一致；宽度下限保护）。
    const bounds = {
      x: raw.x, y: raw.y,
      width: Math.max(IN_BROWSE_MIN_WIDTH, raw.width),
      height: raw.height,
    };
    this.bounds = bounds;
    const view = this.ensureView();
    if (!this.detached) {
      this.window.contentView.addChildView(view);
      this.applyBounds();
    }
    this.emitSnapshot();
  }

  /** 固定意图：导航（http/https 限定，27 §14.3）。 */
  navigate(rawUrl: string): { ok: boolean; reason?: string } {
    if (this.detached) return { ok: false, reason: 'detached' };
    if (!rawUrl || rawUrl.length > IN_BROWSE_MAX_URL_LENGTH) return { ok: false, reason: 'url_invalid' };
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return { ok: false, reason: 'url_invalid' };
    }
    // 27 §14.3：file:/javascript:/data:/chrome: 不作为目标。
    if (!/^https?:$/.test(parsed.protocol)) return { ok: false, reason: 'protocol_denied' };
    const view = this.ensureView();
    if (!this.detached) this.window.contentView.addChildView(view);
    this.applyBounds();
    void view.webContents.loadURL(parsed.href);
    return { ok: true };
  }

  goBack(): void { this.view?.webContents.goBack(); }
  goForward(): void { this.view?.webContents.goForward(); }
  reload(): void { this.view?.webContents.reload(); }
  stopLoading(): void { this.view?.webContents.stop(); }

  /** 关闭当前页并移除视图（27 §7.8：关闭活动目标先停控）。 */
  close(): void {
    if (this.view) {
      try { this.view.webContents.stop(); } catch { /* 已销毁 */ }
      try { this.window.contentView.removeChildView(this.view); } catch { /* 未挂载 */ }
      this.view = null;
      this.bounds = null;
    }
    this.emitSnapshot();
  }

  /** 原生浮层（审批框/菜单/设置）出现前调用：隐藏视图（27 §5.6）。 */
  detach(reason: DetachReason): void {
    this.detached = true;
    this.detachReason = reason;
    if (this.view) {
      try { this.window.contentView.removeChildView(this.view); } catch { /* 未挂载 */ }
    }
    this.emitSnapshot();
  }

  /** 浮层关闭后调用：恢复视图（bounds 重核后重新挂载）。 */
  attach(): void {
    this.detached = false;
    this.detachReason = null;
    if (this.view && this.bounds) {
      this.window.contentView.addChildView(this.view);
      this.applyBounds();
    }
    this.emitSnapshot();
  }

  isDetached(): { detached: boolean; reason: DetachReason | null } {
    return { detached: this.detached, reason: this.detachReason };
  }

  destroy(): void {
    this.close();
  }
}

// ---------------------------------------------------------------------------
// 每业务窗口单例 + 固定意图 IPC（渲染器不直接持有 view）
// ---------------------------------------------------------------------------

const controllers = new WeakMap<BrowserWindow, InBrowseViewController>();

export function getInBrowseController(window: BrowserWindow): InBrowseViewController | null {
  return controllers.get(window) ?? null;
}

/** 业务窗口关闭时销毁视图。 */
export function bindInBrowseController(window: BrowserWindow, onSnapshot: (s: InBrowseSnapshot) => void): InBrowseViewController {
  const existing = controllers.get(window);
  if (existing) return existing;
  const browseSession: Session = session.fromPartition('ops-inbrowse', { cache: true });
  const controller = new InBrowseViewController(window, browseSession, onSnapshot);
  controllers.set(window, controller);
  window.once('closed', () => controller.destroy());
  return controller;
}

/** 审批框/菜单/设置浮层的统一挂点：main.ts 在弹层前调用，关闭后调用。 */
export function inBrowseDetachForOverlay(window: BrowserWindow, reason: DetachReason): void {
  controllers.get(window)?.detach(reason);
}

export function inBrowseAttachAfterOverlay(window: BrowserWindow): void {
  controllers.get(window)?.attach();
}

export function inBrowseSessionName(): string {
  return 'ops-inbrowse';
}

export function inBrowseRandomNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}
