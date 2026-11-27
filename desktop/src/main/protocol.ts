// OPT-E04a：main.ts 的本地协议 / 业务页面 / 请求上下文拆出模块。
// 只搬移实现，不改任何协议行为、通道名或权限判定；运行期依赖由 main.ts 注入。
import { app, dialog, session, type Session } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as wsRealtime from 'ws';
import { isBusinessOriginUrl } from '../business-origin';
import type { DesktopClient } from '../desktop-client';
import {
  buildDesktopRequestHeaders,
  isBusinessApiUrl,
  isManagementRequestMarker,
  shouldBlockDesktopApiRequest
} from '../request-context';

export interface LocalProtocolDeps {
  localPages: Record<string, { file: string; contentType: string }>;
  desktopRoot: string;
  getDesktopTheme(): 'light' | 'dark';
  getDesktopReducedMotion(): boolean | null;
  getBusinessWindow(): Electron.BrowserWindow | null;
  getDesktopClient(): DesktopClient | null;
  getApiOrigin(): string;
  getBusinessOrigin(): string;
  isBusinessUrl(url: string): boolean;
  isRoutingRefreshPending(): boolean;
  isAccountDataClearInProgress(): boolean;
  refreshDesktopRequestContext(): Promise<void>;
  stopPlatformLoginFlow(): Promise<void>;
}

let deps: LocalProtocolDeps | null = null;

export function configureLocalProtocol(next: LocalProtocolDeps): void {
  deps = next;
}

function requireDeps(): LocalProtocolDeps {
  if (!deps) throw new Error('本机协议模块尚未初始化。');
  return deps;
}

const requestProvenance = new Map<number, 'trusted' | 'untrusted' | 'redirected'>();
const contextMutationRequests = new Set<number>();

export function installBusinessPermissions(businessSession: Session): void {
  const businessOrigin = requireDeps().getBusinessOrigin();
  businessSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
    if (permission === 'notifications') {
      return isBusinessOriginUrl(requestingOrigin, businessOrigin) && details.isMainFrame;
    }
    return permission === 'clipboard-sanitized-write'
      && requestingOrigin === businessOrigin
      && details.isMainFrame;
  });

  businessSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    const allowClipboardWrite = permission === 'clipboard-sanitized-write'
      && details.requestingUrl.startsWith(businessOrigin)
      && details.isMainFrame;
    const allowNotifications = permission === 'notifications'
      && isBusinessOriginUrl(details.requestingUrl, businessOrigin)
      && details.isMainFrame;
    const allow = allowClipboardWrite || allowNotifications;
    callback(allow);
  });
}

export function installDesktopRequestContext(businessSession: Session, apiOrigin: string): void {
  const filter = { urls: ['<all_urls>'] };
  businessSession.webRequest.onBeforeRequest(filter, (details, callback) => {
    const d = requireDeps();
    const requestWindow = d.getBusinessWindow();
    const isBusinessWindow = Boolean(requestWindow && !requestWindow.isDestroyed()
      && details.webContentsId === requestWindow.webContents.id);
    if (!isBusinessApiUrl(details.url, apiOrigin)) {
      callback({});
      return;
    }

    if (isWorkspaceContextChangeRequest(details.url, details.method)) {
      void d.stopPlatformLoginFlow();
      contextMutationRequests.add(details.id);
    }

    const trusted = isBusinessWindow && isTrustedBusinessMainFrame(details, requestWindow!);
    const routing = d.getDesktopClient()?.getRequestRoutingState();
    const ready = Boolean(routing?.requestContext.deviceId
      && routing.requestContext.routeRevision && routing.requestContext.routeRevision > 0
      && !d.isRoutingRefreshPending());
    const previousProvenance = requestProvenance.get(details.id);
    requestProvenance.set(details.id, previousProvenance === 'redirected'
      ? 'redirected'
      : trusted ? 'trusted' : 'untrusted');
    if (shouldBlockDesktopApiRequest({
      requestUrl: details.url,
      method: details.method,
      businessOrigin: apiOrigin,
      isBusinessWindow: true,
      trustedBusinessMainFrame: trusted && previousProvenance !== 'redirected',
      requestContextReady: ready,
      mode: routing?.mode ?? 'server',
      forceBlock: d.isRoutingRefreshPending()
    })) {
      callback({ cancel: true });
      return;
    }
    callback({});
  });

  businessSession.webRequest.onBeforeRedirect(filter, (details) => {
    if (requestProvenance.has(details.id)) requestProvenance.set(details.id, 'redirected');
  });

  businessSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    const d = requireDeps();
    const businessWindow = d.getBusinessWindow();
    const isBusinessWindow = Boolean(businessWindow && !businessWindow.isDestroyed()
      && details.webContentsId === businessWindow.webContents.id);
    const provenance = requestProvenance.get(details.id);
    const trusted = isBusinessWindow && provenance === 'trusted'
      && isTrustedBusinessMainFrame(details, businessWindow!);
    const markerEntry = Object.entries(details.requestHeaders)
      .find(([name]) => isManagementRequestMarker(name));
    const isManagementRequest = Boolean(markerEntry && d.getDesktopClient()?.consumeManagementRequestMarker(
      markerEntry[1], details.url, details.method
    ));
    const routing = d.getDesktopClient()?.getRequestRoutingState();
    const requestHeaders = buildDesktopRequestHeaders({
      requestUrl: details.url,
      businessOrigin: apiOrigin,
      trustedBusinessMainFrame: isManagementRequest ? false : trusted,
      mode: isManagementRequest ? 'server' : isBusinessWindow ? routing?.mode ?? 'server' : 'server',
      requestContext: isManagementRequest || !isBusinessWindow ? {} : routing?.requestContext ?? {},
      requestHeaders: details.requestHeaders
    });
    if (isManagementRequest) {
      for (const name of [
        'X-OPS-Desktop-Device',
        'X-OPS-Desktop-Connection',
        'X-OPS-Desktop-Policy',
        'X-OPS-Desktop-Challenge',
        'X-OPS-Desktop-Signature'
      ]) {
        const header = Object.entries(details.requestHeaders).find(([key]) => key.toLowerCase() === name.toLowerCase());
        if (header) requestHeaders[name] = header[1];
      }
    }
    callback({
      requestHeaders
    });
  });

  const finishRequest = (details: { id: number }) => {
    const d = requireDeps();
    requestProvenance.delete(details.id);
    if (!contextMutationRequests.delete(details.id)) return;
    void d.refreshDesktopRequestContext();
  };
  businessSession.webRequest.onCompleted(filter, finishRequest);
  businessSession.webRequest.onErrorOccurred(filter, finishRequest);

  businessSession.cookies.on('changed', (_event, cookie) => {
    const d = requireDeps();
    const host = new URL(d.getApiOrigin()).hostname;
    const cookieDomain = (cookie.domain ?? '').replace(/^\./, '');
    if (cookie.name === 'ops_session' && (host === cookieDomain || host.endsWith(`.${cookieDomain}`))) {
      if (!d.isAccountDataClearInProgress()) void d.refreshDesktopRequestContext();
    }
  });
}

function isWorkspaceContextChangeRequest(requestUrl: string, method: string): boolean {
  if (method !== 'POST') return false;
  let pathname: string;
  try {
    pathname = new URL(requestUrl).pathname;
  } catch {
    return false;
  }
  return pathname === '/api/v1/workspaces'
    || pathname === '/api/v1/workspaces/join'
    || pathname === '/api/v1/workspaces/current/leave'
    || /^\/api\/v1\/workspaces\/[^/]+\/switch$/.test(pathname)
    || /^\/api\/v1\/admin\/workspaces\/[^/]+\/enter$/.test(pathname)
    || pathname === '/api/v1/admin/workspaces/exit';
}

export function isTrustedBusinessApiRequest(input: {
  requestUrl: string;
  apiOrigin: string;
  businessOrigin: string;
  frameUrl?: string;
  initiatorOrigin?: string;
  sameWebContents: boolean;
  isMainFrame: boolean;
}): boolean {
  return input.sameWebContents
    && input.isMainFrame
    && isBusinessApiUrl(input.requestUrl, input.apiOrigin)
    && Boolean(input.frameUrl && isBusinessOriginUrl(input.frameUrl, input.businessOrigin))
    && Boolean(input.initiatorOrigin && isBusinessOriginUrl(input.initiatorOrigin, input.businessOrigin));
}

function isTrustedBusinessMainFrame(
  details: { url: string; webContentsId?: number; frame?: Electron.WebFrameMain | null; initiatorOrigin?: string },
  window: Electron.BrowserWindow
): boolean {
  const d = requireDeps();
  const frame = details.frame;
  return isTrustedBusinessApiRequest({
    requestUrl: details.url,
    apiOrigin: d.getApiOrigin(),
    businessOrigin: d.getBusinessOrigin(),
    frameUrl: frame?.url,
    initiatorOrigin: details.initiatorOrigin,
    sameWebContents: details.webContentsId === window.webContents.id,
    isMainFrame: Boolean(frame && frame === window.webContents.mainFrame)
  });
}

export function installDownloadHandling(businessSession: Session): void {
  businessSession.on('will-download', (event, item, contents) => {
    const businessWindow = requireDeps().getBusinessWindow();
    if (!businessWindow || contents !== businessWindow.webContents) {
      event.preventDefault();
      item.cancel();
      return;
    }

    const filename = path.basename(item.getFilename()).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
    item.setSaveDialogOptions({
      title: '保存下载文件',
      buttonLabel: '保存',
      defaultPath: filename || 'download'
    });

    item.once('done', (_downloadEvent, state) => {
      if (state !== 'interrupted') return;
      const options = {
        type: 'error' as const,
        title: '下载失败',
        message: '文件未能保存。请检查保存位置和磁盘空间后重试。'
      };
      const currentWindow = requireDeps().getBusinessWindow();
      if (currentWindow && !currentWindow.isDestroyed()) {
        void dialog.showMessageBox(currentWindow, options);
      } else {
        void dialog.showMessageBox(options);
      }
    });
  });
}

export async function registerLocalProtocol(targetSession: Session): Promise<void> {
  const d = requireDeps();
  await targetSession.protocol.handle('ops-desktop', async (request) => {
    let requestedPath: string;
    let hostname: string;
    try {
      const requestUrl = new URL(request.url);
      hostname = requestUrl.hostname;
      if (requestUrl.username || requestUrl.password || requestUrl.port || requestUrl.hash) {
        return new Response('Not found', { status: 404 });
      }
      requestedPath = decodeURIComponent(requestUrl.pathname);
    } catch {
      return new Response('Bad request', { status: 400 });
    }

    if (hostname === 'business') return serveBusinessUI(requestedPath, request.method);
    if (hostname !== 'settings' || request.url.includes('?')) return new Response('Not found', { status: 404 });

    const asset = d.localPages[requestedPath];
    if (!asset) return new Response('Not found', { status: 404 });

    const assetRoot = path.join(d.desktopRoot, 'public', 'settings');
    const assetPath = path.resolve(assetRoot, asset.file);
    if (!assetPath.startsWith(`${assetRoot}${path.sep}`)) {
      return new Response('Not found', { status: 404 });
    }

    try {
      const body = await fs.readFile(assetPath);
      const desktopTheme = d.getDesktopTheme();
      const desktopReducedMotion = d.getDesktopReducedMotion();
      const responseBody = requestedPath === '/desktop-theme.js'
        ? Buffer.from(body.toString('utf8')
          .replace('__OPS_DESKTOP_THEME__', desktopTheme)
          .replace('__OPS_DESKTOP_REDUCED_MOTION__', desktopReducedMotion === null ? 'system' : String(desktopReducedMotion)), 'utf8')
        : body;
      return new Response(responseBody, {
        status: 200,
        headers: {
          'Content-Type': asset.contentType,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store'
        }
      });
    } catch {
      return new Response('Local page unavailable', { status: 404 });
    }
  });
}

async function serveBusinessUI(requestedPath: string, method: string): Promise<Response> {
  if (method !== 'GET' && method !== 'HEAD') return new Response('Method not allowed', { status: 405 });

  const d = requireDeps();
  const rendererRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'renderer')
    : path.join(d.desktopRoot, 'renderer');
  let assetPath = requestedPath === '/'
    ? path.join(rendererRoot, 'index.html')
    : path.resolve(rendererRoot, `.${requestedPath}`);
  const relativePath = path.relative(rendererRoot, assetPath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return new Response('Not found', { status: 404 });
  }

  let stat = await fs.stat(assetPath).catch(() => null);
  if (stat?.isDirectory()) {
    assetPath = path.join(assetPath, 'index.html');
    stat = await fs.stat(assetPath).catch(() => null);
  }
  if (!stat?.isFile()) {
    if (path.extname(requestedPath)) return new Response('Not found', { status: 404 });
    assetPath = path.join(rendererRoot, 'index.html');
    stat = await fs.stat(assetPath).catch(() => null);
  }
  if (!stat?.isFile()) return new Response('Desktop UI unavailable', { status: 503 });

  try {
    const body = await fs.readFile(assetPath);
    const contentType = rendererContentType(path.extname(assetPath));
    return new Response(method === 'HEAD' ? null : body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(body.byteLength),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': assetPath.endsWith('index.html') ? 'no-store' : 'no-cache'
      }
    });
  } catch {
    return new Response('Desktop UI unavailable', { status: 404 });
  }
}

function rendererContentType(extension: string): string {
  return ({
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.ico': 'image/x-icon',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain; charset=utf-8',
    '.webmanifest': 'application/manifest+json',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2'
  } as Record<string, string>)[extension.toLowerCase()] ?? 'application/octet-stream';
}

// DEV-AI27-16 第六批（A2）：realtime WebSocket 连接工厂（ws 8.x）。
// token 已由调用方拼进 URL 查询参数；这里只负责把 ws 事件适配成桥依赖接口。
// A2：代理端点走既有登录会话（Cookie 在 Electron session 里，渲染器拿不到 httpOnly）。
// ws/wss 不参与 Cookie 域匹配，这里按 http/https 等价地址取 Cookie。
async function realtimeCookieHeader(url: string): Promise<string> {
  try {
    const parsed = new URL(url)
    parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
    const cookies = await session.defaultSession.cookies.get({ url: parsed.origin });
    return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  } catch {
    return '';
  }
}

export function connectRealtimeWebSocket(url: string): Promise<{
  send(raw: string): void;
  close(): void;
  onMessage(cb: (raw: string) => void): void;
  onClose(cb: (code: number, reason: string) => void): void;
  onError(cb: (err: Error) => void): void;
}> {
  return new Promise((resolve, reject) => {
    void (async () => {
      const cookie = await realtimeCookieHeader(url);
      const socket = new wsRealtime.WebSocket(url, {
        handshakeTimeout: 10_000,
        headers: cookie ? { Cookie: cookie } : undefined,
      });
      let settled = false;
      socket.on('open', () => {
        if (settled) return;
        settled = true;
        resolve({
          send: (raw: string) => { if (socket.readyState === wsRealtime.WebSocket.OPEN) socket.send(raw); },
          close: () => { try { socket.close(1000, 'bridge_stop'); } catch { /* 已断 */ } },
          onMessage: (cb) => { socket.on('message', (data) => cb(String(data))); },
          onClose: (cb) => { socket.on('close', (code, reason) => cb(code, String(reason))); },
          onError: (cb) => { socket.on('error', (err) => cb(err)); },
        });
      });
      socket.on('error', (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
    })();
  });
}
