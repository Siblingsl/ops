import { randomUUID } from 'node:crypto';
import { BrowserWindow, session, type Session } from 'electron';

export {
  CX_LONG_IMAGE_WIDTH,
  CX_LONG_IMAGE_CSS_WIDTH,
  CX_LONG_IMAGE_DPR,
  CX_LONG_IMAGE_SEGMENT_MAX_HEIGHT,
  CX_LONG_IMAGE_MAX_CSS_HEIGHT,
  CX_LONG_IMAGE_MAX_OUTPUT_HEIGHT,
  CX_LONG_IMAGE_MAX_PIXELS,
  CX_LONG_IMAGE_MAX_HTML_BYTES,
  CX_LONG_IMAGE_MAX_PNG_BYTES,
  CX_LONG_IMAGE_MAX_CAPTURE_BYTES,
  CX_LONG_IMAGE_MAX_WORKING_BYTES,
  CXLongImageError,
  planCXLongImage,
  stitchCXLongImageSegments,
  type LongImageErrorCode,
  type LongImagePlan,
} from './cx-long-image-pure';

import {
  CX_LONG_IMAGE_CSS_WIDTH,
  CX_LONG_IMAGE_DPR,
  CX_LONG_IMAGE_MAX_CAPTURE_BYTES,
  CX_LONG_IMAGE_MAX_HTML_BYTES,
  CXLongImageError,
  planCXLongImage,
  stitchCXLongImageSegments,
  type LongImageErrorCode,
} from './cx-long-image-pure';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const CAPTURE_TIMEOUT_MS = 60_000;
const TOTAL_TIMEOUT_MS = 120_000;
const READY_TIMEOUT_MS = 3_000;
const CHROMIUM_CDP_VERSION = '1.3';
const RENDERER_READY_SCRIPT = `(() => new Promise((resolve) => {
  const deadline = performance.now() + ${READY_TIMEOUT_MS};
  const remaining = () => Math.max(0, deadline - performance.now());
  const waitFor = (promise) => Promise.race([
    promise.then(() => true, () => false),
    new Promise((done) => setTimeout(() => done(false), remaining()))
  ]);
  (async () => {
    if (!(await waitFor(document.fonts.ready)) || document.fonts.status !== 'loaded') {
      resolve({ ready: false, reason: 'font' });
      return;
    }
    for (const image of Array.from(document.images)) {
      if (!image.src.startsWith('data:image/') || !(await waitFor(image.decode()))) {
        resolve({ ready: false, reason: 'image' });
        return;
      }
    }
    let previous = '';
    for (let frame = 0; frame < 30 && remaining() > 0; frame += 1) {
      await new Promise((done) => requestAnimationFrame(() => done()));
      const body = document.body;
      const root = document.documentElement;
      let contentBottom = 0;
      for (const element of Array.from(body.querySelectorAll('*'))) {
        contentBottom = Math.max(contentBottom, element.getBoundingClientRect().bottom + window.scrollY);
      }
      const textRange = document.createRange();
      textRange.selectNodeContents(body);
      for (const rect of Array.from(textRange.getClientRects())) {
        contentBottom = Math.max(contentBottom, rect.bottom + window.scrollY);
      }
      const documentHeight = Math.max(root.scrollHeight, body.scrollHeight);
      const layout = {
        width: Math.max(root.clientWidth, body.clientWidth, body.scrollWidth,
          root.scrollWidth - Math.max(0, window.innerWidth - root.clientWidth)),
        height: Math.ceil(Math.max(contentBottom, documentHeight > window.innerHeight ? documentHeight : 0, 1)),
        textLength: (body.innerText || '').trim().length,
        imageCount: document.images.length,
        fontFamily: getComputedStyle(body).fontFamily || 'sans-serif'
      };
      const signature = JSON.stringify(layout);
      if (signature === previous) {
        resolve({ ready: true, ...layout });
        return;
      }
      previous = signature;
    }
    resolve({ ready: false, reason: 'layout' });
  })().catch(() => resolve({ ready: false, reason: 'layout' }));
}))()`;

export type CXLongImageResult = {
  ok: true;
  buildId: string;
  sourceHash: string;
  png: Uint8Array;
  width: number;
  height: number;
  heightCss: number;
  dpr: number;
  viewportWidth: number;
  viewportHeight: number;
  segments: number;
  captureEngine: 'chromium-cdp';
  captureEngineVersion: string;
  captureCheckScope: string;
  capturedAt: string;
  fontFamily: string;
};

export type CXLongImageFailure = { ok: false; code: LongImageErrorCode; message: string };

export async function captureCXLongImageFromBuild(host: BrowserWindow, buildId: string): Promise<CXLongImageResult> {
  if (!UUID.test(buildId) || host.isDestroyed() || host.webContents.isDestroyed()
    || !host.webContents.getURL()) {
    throw new CXLongImageError('invalid_input', '长图构建意图或业务窗口无效。');
  }

  let captureWindow: BrowserWindow | null = null;
  let captureSession: Session | null = null;
  let overallTimer: ReturnType<typeof setTimeout> | null = null;
  let captureStartedAt = 0;
  const cleanup = async () => {
    if (captureWindow && !captureWindow.isDestroyed()) {
      const contents = captureWindow.webContents;
      if (!contents.isDestroyed() && contents.debugger.isAttached()) {
        try { contents.debugger.detach(); } catch { /* Window destruction releases the debugger target. */ }
      }
      try { captureWindow.destroy(); } catch { /* The window may already be closing. */ }
    }
    if (captureSession) {
      captureSession.webRequest.onBeforeRequest(null);
      await Promise.allSettled([captureSession.clearCache(), captureSession.clearStorageData()]);
    }
  };

  try {
    const operation = (async () => {
      const sourceScript = `(() => { const node = document.getElementById('ops-cx-long-image-source'); if (!(node instanceof HTMLTextAreaElement) || node.dataset.buildId !== ${JSON.stringify(buildId)} || !/^[0-9a-f]{64}$/i.test(node.dataset.sourceHash || '')) return null; return { buildId: node.dataset.buildId, sourceHash: node.dataset.sourceHash, html: node.value }; })()`;
      const source = await host.webContents.executeJavaScript(sourceScript, true) as { buildId?: unknown; sourceHash?: unknown; html?: unknown } | null;
      if (!source || source.buildId !== buildId || typeof source.sourceHash !== 'string' || !SHA256.test(source.sourceHash)
        || typeof source.html !== 'string') {
        throw new CXLongImageError('invalid_input', '当前业务窗口没有该构建的冻结渲染源。');
      }
      const htmlBytes = Buffer.byteLength(source.html, 'utf8');
      if (htmlBytes === 0 || htmlBytes > CX_LONG_IMAGE_MAX_HTML_BYTES) {
        throw new CXLongImageError('image_too_tall', '冻结渲染源超过 8 MiB 上限。');
      }
      const captureHtml = secureLongImageDocument(source.html);
      const documentUrl = `data:text/html;base64,${Buffer.from(captureHtml, 'utf8').toString('base64')}`;
      const partition = `cx-long-image-${randomUUID()}`;
      captureSession = session.fromPartition(partition);
      captureSession.setPermissionCheckHandler(() => false);
      captureSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      let mainDocumentAllowed = true;
      captureSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
        const documentRequest = mainDocumentAllowed && details.resourceType === 'mainFrame' && details.url === documentUrl;
        if (documentRequest) mainDocumentAllowed = false;
        const imageRequest = details.resourceType === 'image'
          && details.url.length <= CX_LONG_IMAGE_MAX_HTML_BYTES * 2
          && /^data:image\/(?:jpeg|png|webp);base64,/i.test(details.url);
        callback({ cancel: !documentRequest && !imageRequest });
      });

      captureWindow = new BrowserWindow({
        width: CX_LONG_IMAGE_CSS_WIDTH,
        height: 844,
        show: false,
        frame: false,
        resizable: false,
        maximizable: false,
        minimizable: false,
        fullscreenable: false,
        backgroundColor: '#ffffff',
        webPreferences: {
          session: captureSession,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          webviewTag: false,
          offscreen: true,
          backgroundThrottling: false,
          devTools: false
        }
      });
      const contents = captureWindow.webContents;
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      let initialNavigationAllowed = true;
      contents.once('did-navigate', () => { initialNavigationAllowed = false; });
      contents.on('will-navigate', (event, url) => {
        if (initialNavigationAllowed && url === documentUrl) return;
        event.preventDefault();
      });
      contents.on('will-frame-navigate', (details) => {
        if (details.isMainFrame && initialNavigationAllowed && details.url === documentUrl) return;
        details.preventDefault();
      });
      contents.on('will-redirect', (details) => details.preventDefault());
      await contents.loadURL(documentUrl);
      contents.debugger.attach(CHROMIUM_CDP_VERSION);
      await contents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
        width: CX_LONG_IMAGE_CSS_WIDTH,
        height: 844,
        deviceScaleFactor: CX_LONG_IMAGE_DPR,
        mobile: true,
        scale: 1,
        screenWidth: CX_LONG_IMAGE_CSS_WIDTH,
        screenHeight: 844
      });
      const readyUntil = Date.now() + READY_TIMEOUT_MS;
      const ready = await withDeadline(contents.executeJavaScript(RENDERER_READY_SCRIPT, true), readyUntil, 'render_not_ready');
      if (!isReady(ready)) {
        throw new CXLongImageError('render_not_ready', '字体、图片或页面布局未能在 3 秒内稳定。');
      }
      if (ready.textLength < 1 && ready.imageCount < 1) {
        throw new CXLongImageError('empty_content', '冻结页面没有可见正文或图片。');
      }
      if (ready.width !== CX_LONG_IMAGE_CSS_WIDTH) {
        throw new CXLongImageError('long_image_invalid', `冻结页面实际内容宽度为 ${ready.width} CSS px，无法按 390 CSS px 截图。`);
      }
      const plan = planCXLongImage(ready.height, htmlBytes);
      captureStartedAt = Date.now();
      const captureUntil = Math.min(Date.now() + CAPTURE_TIMEOUT_MS, Date.now() + TOTAL_TIMEOUT_MS);
      const encodedSegments: Buffer[] = [];
      let captureBytes = 0;
      for (const segment of plan.segments) {
        const cssY = segment.y / CX_LONG_IMAGE_DPR;
        const cssHeight = segment.height / CX_LONG_IMAGE_DPR;
        const encoded = await withDeadline(contents.debugger.sendCommand('Page.captureScreenshot', {
          format: 'png',
          fromSurface: true,
          captureBeyondViewport: true,
          clip: { x: 0, y: cssY, width: CX_LONG_IMAGE_CSS_WIDTH, height: cssHeight, scale: 1 }
        }) as Promise<{ data: string }>, captureUntil, 'build_timeout');
        if (typeof encoded.data !== 'string' || !encoded.data) {
          throw new CXLongImageError('long_image_invalid', 'Electron 未返回 PNG 图像分段。');
        }
        const bytes = Buffer.from(encoded.data, 'base64');
        captureBytes += bytes.byteLength;
        if (captureBytes > CX_LONG_IMAGE_MAX_CAPTURE_BYTES) {
          throw new CXLongImageError('image_too_tall', '长图分段超过本机编码内存预算。');
        }
        encodedSegments.push(bytes);
      }
      if (Date.now() - captureStartedAt > CAPTURE_TIMEOUT_MS) {
        throw new CXLongImageError('build_timeout', '长图截图阶段超过 60 秒。');
      }
      const png = stitchCXLongImageSegments(encodedSegments, plan);
      if (Date.now() - captureStartedAt > CAPTURE_TIMEOUT_MS) {
        throw new CXLongImageError('build_timeout', '长图拼接阶段超过 60 秒。');
      }
      return {
        ok: true as const,
        buildId,
        sourceHash: source.sourceHash,
        png,
        width: plan.width,
        height: plan.height,
        heightCss: ready.height,
        dpr: CX_LONG_IMAGE_DPR,
        viewportWidth: CX_LONG_IMAGE_CSS_WIDTH,
        viewportHeight: 844,
        segments: plan.segments.length,
        captureEngine: 'chromium-cdp' as const,
        captureEngineVersion: process.versions.chrome || process.versions.electron || 'unknown',
        captureCheckScope: 'font_ready,image_decode,layout_stable_2_frames,segment_png_decode,final_png_dimensions,non_uniform_pixels',
        capturedAt: new Date().toISOString(),
        fontFamily: ready.fontFamily
      } satisfies CXLongImageResult;
    })();
    const timeout = new Promise<never>((_resolve, reject) => {
      overallTimer = setTimeout(() => reject(new CXLongImageError('build_timeout', '长图构建超过 120 秒。')), TOTAL_TIMEOUT_MS);
    });
    return await Promise.race([operation, timeout]);
  } finally {
    if (overallTimer) clearTimeout(overallTimer);
    await cleanup();
  }
}

export function cxLongImageFailure(error: unknown): CXLongImageFailure {
  if (error instanceof CXLongImageError) return { ok: false, code: error.code, message: error.message };
  return { ok: false, code: 'long_image_invalid', message: '长图生成失败，原稿保持不变。' };
}

function secureLongImageDocument(html: string): string {
  const opening = /^<!doctype html><html><head>/i;
  if (!opening.test(html) || !/<\/head>/i.test(html) || !/<body(?:\s[^>]*)?>/i.test(html)) {
    throw new CXLongImageError('long_image_invalid', '冻结 HTML 文档结构无效。');
  }
  const policy = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; font-src \'none\'; script-src \'none\'; connect-src \'none\'; frame-src \'none\'; object-src \'none\'; media-src \'none\'; base-uri \'none\'; form-action \'none\'">';
  let result = html.replace(opening, match => `${match}${policy}<meta name="viewport" content="width=device-width,initial-scale=1">`);
  result = result.replace(/<body(?:\s[^>]*)?>/i, '<body style="margin:0;padding:0;width:390px;min-width:390px;max-width:390px;overflow-x:hidden">');
  return result;
}

function isReady(value: unknown): value is { ready: true; width: number; height: number; textLength: number; imageCount: number; fontFamily: string } {
  if (!value || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  return result.ready === true && Number.isSafeInteger(result.width) && Number.isSafeInteger(result.height)
    && Number.isSafeInteger(result.textLength) && Number.isSafeInteger(result.imageCount)
    && typeof result.fontFamily === 'string' && result.fontFamily.length > 0;
}

function withDeadline<T>(promise: Promise<T>, deadline: number, code: 'render_not_ready' | 'build_timeout'): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new CXLongImageError(code, code === 'render_not_ready'
    ? '字体、图片或页面布局未能在 3 秒内稳定。' : '长图构建超过 120 秒。'));
  let timer: ReturnType<typeof setTimeout> | null = null;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new CXLongImageError(code, code === 'render_not_ready'
        ? '字体、图片或页面布局未能在 3 秒内稳定。' : '长图截图阶段超过 60 秒。')), remaining);
    })
  ]).finally(() => { if (timer) clearTimeout(timer); });
}
