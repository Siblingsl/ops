import { BrowserWindow, WebContentsView, session, type Session, type DownloadItem } from 'electron';
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

/** 内置浏览器的下载记录（27 §14.5：逐文件确认，不自动打开/执行/上传）。 */
export interface InBrowseDownloadRecord {
  id: string;
  filename: string;
  state: 'completed' | 'interrupted' | 'cancelled';
  receivedBytes: number;
  totalBytes: number;
  sourceUrl: string;
}

/** 弹窗策略回执（27 §7.8 弹窗处理）：deny 时不静默，让渲染器给可读提示。 */
export interface InBrowseBlockedPopup {
  url: string;
  reason: 'new_window' | 'protocol_denied' | 'tab_limit' | 'cross_origin';
  at: number;
}

export interface InBrowseSnapshot {
  activeTabId: string | null;
  tabs: InBrowseTabSnapshot[];
  bounds: InBrowseBounds | null;
  detached: boolean;
  detachReason: string | null;
  /** 最近 20 条下载记录，新的在前；与页签状态互不影响。 */
  downloads: InBrowseDownloadRecord[];
  /** 最近一次被拒绝的弹窗（null 表示当前没有待提示的拒绝）。 */
  lastBlockedPopup: InBrowseBlockedPopup | null;
}

type DetachReason = 'approval-dialog' | 'menu' | 'account-switch' | 'settings' | 'close';

/** http/https 判定（弹窗与页内导航共用；file:/javascript:/自定义协议均拒）。 */
function isHttpUrl(raw: string): boolean {
  try {
    return /^https?:$/.test(new URL(raw).protocol);
  } catch {
    return false;
  }
}

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
  private downloads: InBrowseDownloadRecord[] = [];
  private lastBlockedPopup: InBrowseBlockedPopup | null = null;

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
      downloads: [...this.downloads],
      lastBlockedPopup: this.lastBlockedPopup,
    };
  }

  /**
   * 记录一次下载结果并推送真实快照。
   *
   * 注意：这里必须走 `snapshot()`，不能手写快照对象。下载是会话级事件、
   * 与页签无关，早前版本在 done 回调里直接推送 `{ tabs: [], activeTabId: null }`，
   * 一次下载就会把前端的页签列表整体清空。
   */
  recordDownload(record: InBrowseDownloadRecord): void {
    this.downloads = [record, ...this.downloads].slice(0, 20);
    this.emitSnapshot();
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
    // DEV-AI27-08f（27 §7.8 弹窗处理）：deny 默认 + 同站进新页签 + 跨站/非 http(s) 拒绝并回执。
    // 放行路径也不让 Electron 开原生窗：我们在控制器内开页签并导航，handler 始终 deny。
    view.webContents.setWindowOpenHandler(({ url, disposition }) => {
      const reason = this.popupDenyReason(url, disposition);
      if (reason) {
        this.blockPopup(url, reason);
        return { action: 'deny' };
      }
      const before = this.tabOrder.length;
      this.openTab();
      if (this.tabOrder.length > before) {
        void this.navigate(url);
      } else {
        // 上限 8：页签没开出来，回执 tab_limit 提示而非静默。
        this.blockPopup(url, 'tab_limit');
      }
      return { action: 'deny' };
    });
    // 非 http/https 的页内导航一律拦截（下载链接由 will-download 承载，不导航）。
    view.webContents.on('will-navigate', (event, url) => {
      if (!isHttpUrl(url)) {
        event.preventDefault();
        this.blockPopup(url, 'protocol_denied');
      }
    });
    this.tabs.set(tab.id, tab);
    this.tabOrder.push(tab.id);
    return tab;
  }

  /** 弹窗拒绝原因：null = 允许（同站 http(s) 的 tab 型弹窗）。 */
  private popupDenyReason(url: string, disposition: string): InBrowseBlockedPopup['reason'] | null {
    if (disposition === 'new-window' || disposition === 'save-to-disk') return 'new_window';
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return 'protocol_denied';
    }
    if (!/^https?:$/.test(parsed.protocol)) return 'protocol_denied';
    // 跨站拒绝：只允许与当前活动页签同源的目标（源含协议+主机+端口）。
    const current = this.activeTab();
    if (current) {
      try {
        if (new URL(current.view.webContents.getURL()).origin !== parsed.origin) return 'cross_origin';
      } catch {
        // 当前页签 URL 异常时按跨站处理，不扩大放行面。
        return 'cross_origin';
      }
    }
    return null;
  }

  /** 记录被拒弹窗并推送快照（不静默——渲染器据 lastBlockedPopup 提示）。 */
  private blockPopup(url: string, reason: InBrowseBlockedPopup['reason']): void {
    this.lastBlockedPopup = { url: url.slice(0, 2048), reason, at: Date.now() };
    this.emitSnapshot();
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

  /** 拖拽排序：把 from 移到 to 的位置（27 §7.8 标签管理 UI 增强）。 */
  reorderTab(from: string, to: string): boolean {
    if (!this.tabs.has(from) || !this.tabs.has(to) || from === to) return false;
    const fromIdx = this.tabOrder.indexOf(from);
    const toIdx = this.tabOrder.indexOf(to);
    const [moved] = this.tabOrder.splice(fromIdx, 1);
    // 向右拖落在目标之后、向左拖落在目标之前，否则「拖到最右」永远到不了末位。
    const targetIdx = this.tabOrder.indexOf(to);
    this.tabOrder.splice(fromIdx < toIdx ? targetIdx + 1 : targetIdx, 0, moved);
    this.emitSnapshot();
    return true;
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

  // -------------------------------------------------------------------------
  // DEV-AI27-06（W06c）：AI 操作内置页面——动作执行器。
  // 与 Chrome 扩展动作同语义（27 §8.1）：observe/click/type/extract 直接在活动
  // WebContentsView 上执行；页面脚本为包内登记的函数（executeScript 传函数引用），
  // 不接收任意 JS；密码/MFA//上传控件拒绝；doc_rev 失效反例拒绝；
  // 敏感控件与脚本错误不进入日志正文（W05 脱敏原则）。
  // AI 调用路径：模型工具 browser_* → 服务端 /tools/browser/commands 账本 →
  // OPS 桥（W06b 链接线）→ 本类方法（本批）；命令账本幂等由服务端保证。
  // -------------------------------------------------------------------------

  /** 观察活动页签：脱敏可见内容 + 可交互节点（上限 300，与扩展 observeFn 同语义）。 */
  async observe(tabID?: string): Promise<{ ok: boolean; reason?: string; data?: unknown }> {
    const tab = tabID ? this.tabs.get(tabID) : this.activeTab();
    if (!tab) return { ok: false, reason: 'no_active_tab' };
    const url = tab.view.webContents.getURL();
    if (!/^https?:/.test(url)) return { ok: false, reason: 'tab_not_http' };
    try {
      const result = await tab.view.webContents.executeJavaScript(`(${inBrowseObserveFn.toString()})(300)`, false);
      return { ok: true, data: result };
    } catch (err) {
      return { ok: false, reason: 'observe_failed: ' + String((err as Error).message).slice(0, 120) };
    }
  }

  /** 点击活动页签的已观察节点（doc_rev 失效拒绝）。 */
  async click(tabID: string | undefined, ref: string, docRev: string): Promise<{ ok: boolean; reason?: string; data?: unknown }> {
    const tab = tabID ? this.tabs.get(tabID) : this.activeTab();
    if (!tab) return { ok: false, reason: 'no_active_tab' };
    try {
      const result = await tab.view.webContents.executeJavaScript(`(${inBrowseClickFn.toString()})(${JSON.stringify(ref)}, ${JSON.stringify(docRev)})`, false);
      return { ok: true, data: result };
    } catch (err) {
      return { ok: false, reason: 'click_failed: ' + String((err as Error).message).slice(0, 120) };
    }
  }

  /** 文本输入（拒绝密码/上传控件）。 */
  async type(tabID: string | undefined, ref: string, text: string, docRev: string): Promise<{ ok: boolean; reason?: string; data?: unknown }> {
    const tab = tabID ? this.tabs.get(tabID) : this.activeTab();
    if (!tab) return { ok: false, reason: 'no_active_tab' };
    if (text.length > 10000) return { ok: false, reason: 'text_too_long' };
    try {
      const result = await tab.view.webContents.executeJavaScript(`(${inBrowseTypeFn.toString()})(${JSON.stringify(ref)}, ${JSON.stringify(text)}, ${JSON.stringify(docRev)})`, false);
      return { ok: true, data: result };
    } catch (err) {
      return { ok: false, reason: 'type_failed: ' + String((err as Error).message).slice(0, 120) };
    }
  }

  /** 提取指定选择器文本（含输入框 value）。 */
  async extract(tabID: string | undefined, selector: string, docRev: string): Promise<{ ok: boolean; reason?: string; data?: unknown }> {
    const tab = tabID ? this.tabs.get(tabID) : this.activeTab();
    if (!tab) return { ok: false, reason: 'no_active_tab' };
    try {
      const result = await tab.view.webContents.executeJavaScript(`(${inBrowseExtractFn.toString()})(${JSON.stringify(selector)}, ${JSON.stringify(docRev)})`, false);
      return { ok: true, data: result };
    } catch (err) {
      return { ok: false, reason: 'extract_failed: ' + String((err as Error).message).slice(0, 120) };
    }
  }

  /** 截图（JPEG，≤2MiB，与扩展 captureVisibleTab 同语义——内置视图走 webContents.capturePage）。 */
  async screenshot(tabID?: string): Promise<{ ok: boolean; reason?: string; data?: { base64: string } }> {
    const tab = tabID ? this.tabs.get(tabID) : this.activeTab();
    if (!tab) return { ok: false, reason: 'no_active_tab' };
    try {
      const image = await tab.view.webContents.capturePage();
      const resized = image.resize({ width: Math.min(image.getSize().width, 1920) });
      const jpeg = resized.toJPEG(70);
      if (jpeg.length > 2 * 1024 * 1024) return { ok: false, reason: 'screenshot_too_large' };
      return { ok: true, data: { base64: jpeg.toString('base64') } };
    } catch (err) {
      return { ok: false, reason: 'screenshot_failed: ' + String((err as Error).message).slice(0, 120) };
    }
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
    this.lastBlockedPopup = null;
    this.emitSnapshot();
  }
}

// ---------------------------------------------------------------------------
// 每业务窗口单例 + 生命周期
// ---------------------------------------------------------------------------

// 用 Map 而不是 WeakMap：下载是会话级事件，需要遍历所有窗口广播记录。
// 窗口关闭时在 once('closed') 里显式 delete，避免持有已销毁的控制器。
const controllers = new Map<BrowserWindow, InBrowseViewController>();

export function getInBrowseController(window: BrowserWindow): InBrowseViewController | null {
  return controllers.get(window) ?? null;
}

export function bindInBrowseController(window: BrowserWindow, onSnapshot: (s: InBrowseSnapshot) => void): InBrowseViewController {
  const existing = controllers.get(window);
  if (existing) return existing;
  const browseSession: Session = session.fromPartition('ops-inbrowse', { cache: true });
  installDownloadHandling(browseSession);
  const controller = new InBrowseViewController(window, browseSession, onSnapshot);
  controllers.set(window, controller);
  window.once('closed', () => {
    controllers.delete(window);
    controller.destroy();
  });
  return controller;
}

// 同一 partition 的 Session 是共享的，bind 会随窗口多次调用；
// 不加这层去重，多开窗口时每次下载都会触发多遍回调。
const downloadHandledSessions = new WeakSet<Session>();

// DEV-AI27-08e（深化 2/5，27 §14.5 下载）：逐文件确认——不自动打开/执行/上传；
// 保存采用 Electron 原生文件对话框（用户选择位置）；取消即中止，不落盘到隐式目录。
function installDownloadHandling(browseSession: Session): void {
  if (downloadHandledSessions.has(browseSession)) return;
  downloadHandledSessions.add(browseSession);
  browseSession.on('will-download', (_event, item: DownloadItem) => {
    // 27 §14.5：下载显示真实来源/名称/类型/大小，由用户逐文件确认保存位置。
    item.setSaveDialogOptions({
      title: '保存下载文件',
      defaultPath: item.getFilename(),
    });
    item.on('done', (_event, state) => {
      const record: InBrowseDownloadRecord = {
        id: crypto.randomUUID(),
        filename: item.getFilename(),
        state,
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
        sourceUrl: item.getURL(),
      };
      // 下载无法可靠归属到单一窗口（session 共享），广播给当前打开的所有窗口。
      for (const controller of controllers.values()) controller.recordDownload(record);
    });
  });
}

export function inBrowseDetachForOverlay(window: BrowserWindow, reason: DetachReason): void {
  controllers.get(window)?.detach(reason);
}

export function inBrowseAttachAfterOverlay(window: BrowserWindow): void {
  controllers.get(window)?.attach();
}

// ---------------------------------------------------------------------------
// DEV-AI27-08g（27 §14.5 浏览数据管理）：受控清理浏览实例数据。
// 边界：只作用于 persist:ops-inbrowse 浏览分区；业务 session（登录态）与 OPS 证据
// 目录完全不经过这里——设置页两类数据分区展示，防止"一键清全部"误伤业务登录态。
// ---------------------------------------------------------------------------

/** 浏览数据类型：cache（HTTP 缓存/存储）、cookies（含 storage 的站点数据）、all（两者）。 */
export type InBrowseDataKind = 'cache' | 'cookies' | 'all';

export interface InBrowseDataStats {
  cacheBytes: number | null;
  cookiesCount: number | null;
}

let browseDataSession: Session | null = null;

function browseDataTargetSession(): Session {
  if (!browseDataSession) browseDataSession = session.fromPartition('ops-inbrowse', { cache: true });
  return browseDataSession;
}

/** 浏览分区数据体积（读取失败返回 null，不伪造 0）。 */
export async function inBrowseDataStats(): Promise<InBrowseDataStats> {
  const s = browseDataTargetSession();
  let cacheBytes: number | null = null;
  let cookiesCount: number | null = null;
  try {
    cacheBytes = await s.getCacheSize();
  } catch { /* 部分平台不可用：如实标 null */ }
  try {
    cookiesCount = (await s.cookies.get({})).length;
  } catch { /* 同上 */ }
  return { cacheBytes, cookiesCount };
}

/** 清理浏览实例数据（仅 persist:ops-inbrowse）。返回实际执行的清理项。 */
export async function clearInBrowseData(kind: InBrowseDataKind): Promise<{ cleared: string[] }> {
  if (kind !== 'cache' && kind !== 'cookies' && kind !== 'all') {
    throw new Error('inbrowse_data_kind_invalid');
  }
  const s = browseDataTargetSession();
  const cleared: string[] = [];
  if (kind === 'cache' || kind === 'all') {
    await s.clearCache();
    cleared.push('cache');
  }
  if (kind === 'cookies' || kind === 'all') {
    // clearStorageData 不传 origin 清整个分区：cookies + localStorage + indexedDB 等。
    await s.clearStorageData();
    cleared.push('cookies', 'storage');
  }
  return { cleared };
}

// ---------------------------------------------------------------------------
// 页面内登记动作（executeScript 传函数引用的字符串化版本；与扩展 observeFn 同语义）。
// 密码/MFA//上传控件拒绝；doc_rev 失效拒绝；节点上限 300。
// ---------------------------------------------------------------------------

function inBrowseObserveFn(maxNodes: number): unknown {
  const selector = 'a,button,input,select,textarea,[role="button"],[role="link"],[role="tab"],[role="checkbox"]';
  const all = Array.from(document.querySelectorAll(selector));
  const visible = all.filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  const w = window as unknown as { __opsRefMap?: Map<string, Element>; __opsRefSeq?: number; __opsDocRev?: string };
  if (!w.__opsRefMap) w.__opsRefMap = new Map();
  if (!w.__opsRefSeq) w.__opsRefSeq = 0;
  w.__opsRefMap.clear();
  const nodes: Array<Record<string, string>> = [];
  for (const el of visible.slice(0, maxNodes)) {
    w.__opsRefSeq += 1;
    const ref = `n${w.__opsRefSeq}`;
    w.__opsRefMap.set(ref, el);
    const input = el as HTMLInputElement;
    nodes.push({
      ref,
      tag: el.tagName.toLowerCase(),
      type: input.type || '',
      name: ((input.placeholder || el.getAttribute('aria-label') || el.textContent || '').trim()).slice(0, 80),
    });
  }
  const prevRev = w.__opsDocRev;
  w.__opsDocRev = `r${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  void prevRev;
  return {
    url: location.href,
    title: document.title,
    text_head: (document.body ? document.body.innerText : '').slice(0, 4000),
    nodes,
    node_total: visible.length,
    doc_rev: w.__opsDocRev,
  };
}

function inBrowseClickFn(ref: string, docRev: string): unknown {
  const w = window as unknown as { __opsDocRev?: string; __opsRefMap?: Map<string, Element> };
  if (w.__opsDocRev !== docRev) return { error: 'doc_rev_changed' };
  const el = w.__opsRefMap?.get(ref) as HTMLButtonElement | undefined;
  if (!el) return { error: 'ref_not_found' };
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return { error: 'ref_not_visible' };
  if (el.matches('input[type="password"]')) return { error: 'sensitive_control' };
  el.click();
  return { clicked: true };
}

function inBrowseTypeFn(ref: string, text: string, docRev: string): unknown {
  const w = window as unknown as { __opsDocRev?: string; __opsRefMap?: Map<string, Element> };
  if (w.__opsDocRev !== docRev) return { error: 'doc_rev_changed' };
  const el = w.__opsRefMap?.get(ref) as HTMLInputElement | undefined;
  if (!el) return { error: 'ref_not_found' };
  const tag = el.tagName.toLowerCase();
  if (tag !== 'input' && tag !== 'textarea') return { error: 'not_text_control' };
  const type = (el.getAttribute('type') || '').toLowerCase();
  if (type === 'password' || type === 'file') return { error: 'sensitive_control' };
  el.focus();
  el.value = text;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { typed: text.length };
}

function inBrowseExtractFn(selector: string, docRev: string): unknown {
  const w = window as unknown as { __opsDocRev?: string };
  if (w.__opsDocRev !== docRev) return { error: 'doc_rev_changed' };
  const el = document.querySelector(selector);
  if (!el) return { error: 'selector_not_found' };
  const isValueControl = ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
  return {
    text: isValueControl ? String((el as HTMLInputElement).value ?? '').slice(0, 2000) : (el.textContent || '').trim().slice(0, 2000),
    tag: el.tagName.toLowerCase(),
  };
}
