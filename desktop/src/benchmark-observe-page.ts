// REF41 I1-A5：在桌面主进程里用无登录态、非持久化的隐藏窗口读取公开页。
//
// 硬边界：
// - 只加载 benchmark_target 的公开 http(s) URL，平台域名白名单见 benchmarkURLAllowed；
// - partition 每次都是新建的非持久化分区，从空 Cookie/Storage 开始，不注入用户登录态；
// - 保留平台为通过公开页反爬挑战而设置的临时 Cookie，关闭窗口后统一清空；
// - 拒绝所有权限请求，禁止 window.open；不做登录、不点关注、不读私信/粉丝；
// - 页面要求登录或出现风控文案时写 failed。

import { BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import {
  benchmarkURLAllowed,
  discoverNoteURL,
  failedPublicNote,
  noteIDFromPublicURL,
  parsePublicNoteSnapshot,
  type PublicBenchmarkNote,
  type PublicPageSnapshot
} from './benchmark-observe';
import type { BenchmarkObserveTask } from './benchmark-observe-client';

export interface BenchmarkPageReadOptions {
  allowLocal: boolean;
  timeoutMs?: number;
  settleMs?: number;
}

const SNAPSHOT_SCRIPT = `(() => {
  const meta = {};
  for (const el of Array.from(document.querySelectorAll('meta'))) {
    const key = el.getAttribute('property') || el.getAttribute('name');
    if (!key) continue;
    meta[key] = el.getAttribute('content') || '';
  }
  const globals = {};
  const globalKeys = ['__INITIAL_STATE__', '__NUXT__', '_SSR_HYDRATED_DATA', 'RENDER_DATA', '__NEXT_DATA__', 'SSR_DATA'];
  for (const key of globalKeys) {
    try {
      const value = window[key];
      if (value === undefined || value === null) continue;
      const text = JSON.stringify(value);
      if (typeof text !== 'string') continue;
      if (text.length > 900000) {
        globals[key] = { __truncated: true, __length: text.length };
      } else {
        globals[key] = JSON.parse(text);
      }
    } catch (error) {
      globals[key] = { __unreadable: true };
    }
  }
  const links = Array.from(document.querySelectorAll('a[href]'))
    .slice(0, 300)
    .map((anchor) => anchor.href)
    .filter((href) => typeof href === 'string' && href.length > 0);
  const labeledCounts = Array.from(document.querySelectorAll('[aria-label], [data-count]'))
    .slice(0, 120)
    .map((el) => ({
      label: el.getAttribute('aria-label') || el.getAttribute('data-count') || '',
      text: String(el.innerText || el.getAttribute('data-count') || '').trim()
    }))
    .filter((item) => item.label && item.text);
  return {
    finalUrl: location.href,
    title: document.title || '',
    meta,
    globals,
    links,
    text: String(document.body && document.body.innerText || '').slice(0, 6000),
    labeledCounts
  };
})()`;

const DESKTOP_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MOBILE_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

function readURLForPlatform(raw: string, platform: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  if (platform !== 'toutiao') return raw;
  if (url.hostname.toLowerCase() !== 'www.toutiao.com') return raw;
  const article = url.pathname.match(/^\/article\/([0-9]+)\/?$/);
  if (!article) return raw;
  // 头条桌面页在无登录/无持久 Cookie 的窗口里会返回空壳或风控页；
  // 同一 article id 的移动公开页仍可直接只读。只换读取地址，不改变目标归属。
  return `https://m.toutiao.com/i${article[1]}/`;
}

function userAgentForPlatform(platform: string): string {
  return platform === 'toutiao' || platform === 'wechat_mp' ? MOBILE_USER_AGENT : DESKTOP_USER_AGENT;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function loadPublicSnapshot(
  url: string,
  platform: string,
  options: BenchmarkPageReadOptions
): Promise<PublicPageSnapshot> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const settleMs = options.settleMs ?? 600;
  const window = new BrowserWindow({
    show: false,
    skipTaskbar: true,
    width: 1280,
    height: 900,
    backgroundColor: '#ffffff',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      partition: `benchmark-public-${randomUUID()}`
    }
  });
  const wc = window.webContents;
  wc.setUserAgent(userAgentForPlatform(platform));
  const ses = wc.session;
  try {
    ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = { ...details.requestHeaders };
      for (const key of Object.keys(headers)) {
        const lower = key.toLowerCase();
        // 分区从空 Cookie 开始，平台可能设置短时反爬 Cookie；这里只清掉登录/授权头，
        // 避免把用户的既有凭据带进竞对公开页。关闭窗口后会 clearStorageData。
        if (lower === 'authorization' || lower === 'proxy-authorization' ||
            lower === 'x-csrf-token' || lower === 'x-xsrf-token') {
          delete headers[key];
        }
      }
      callback({ requestHeaders: headers });
    });
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (event, target) => {
      if (!benchmarkURLAllowed(platform, target, options.allowLocal)) {
        event.preventDefault();
      }
    });
    await withTimeout(window.loadURL(url), timeoutMs, `公开页加载超时：${url}`);
    if (settleMs > 0) await sleep(settleMs);
    const snapshot = await withTimeout(
      wc.executeJavaScript(SNAPSHOT_SCRIPT, true),
      timeoutMs,
      `公开页快照超时：${url}`
    ) as PublicPageSnapshot;
    if (!snapshot || typeof snapshot !== 'object' || typeof snapshot.finalUrl !== 'string') {
      throw new Error('公开页快照格式不合法');
    }
    return snapshot;
  } finally {
    try {
      await ses.clearStorageData();
    } catch {
      // 清理失败不改变「本窗口没有登录态」的结论；partition 非持久化，关闭即丢弃。
    }
    try {
      window.destroy();
    } catch {
      // 窗口可能已因加载失败销毁。
    }
  }
}

export async function readPublicBenchmarkTask(
  task: BenchmarkObserveTask,
  options: BenchmarkPageReadOptions
): Promise<PublicBenchmarkNote> {
  const targetURL = task.url?.trim() ?? '';
  const readURL = readURLForPlatform(targetURL, task.platform);
  if (!targetURL || !benchmarkURLAllowed(task.platform, readURL, options.allowLocal)) {
    return failedPublicNote(targetURL, task.platform, `竞对公开页 ${task.platform}`, 'empty_page');
  }
  try {
    let snapshot = await loadPublicSnapshot(readURL, task.platform, options);
    if (!benchmarkURLAllowed(task.platform, snapshot.finalUrl, options.allowLocal)) {
      return failedPublicNote(targetURL, task.platform, snapshot.title, 'login_wall');
    }
    // 主页级 target 需要先从公开页链接里发现作品；作品级 target 直接解析。
    // 页面可能从移动短链重定向到规范作品页，因此 finalUrl 也要参与作品识别。
    let noteURL = noteIDFromPublicURL(targetURL, task.platform) ? targetURL : null;
    if (!noteURL && noteIDFromPublicURL(snapshot.finalUrl, task.platform)) {
      noteURL = snapshot.finalUrl;
    }
    if (!noteURL) noteURL = discoverNoteURL(snapshot, task.platform);
    if (!noteURL) {
      return failedPublicNote(targetURL, task.platform, snapshot.title, 'no_public_note');
    }
    if (!benchmarkURLAllowed(task.platform, noteURL, options.allowLocal)) {
      return failedPublicNote(targetURL, task.platform, snapshot.title, 'no_public_note');
    }
    if (noteURL !== snapshot.finalUrl) snapshot = await loadPublicSnapshot(noteURL, task.platform, options);
    return parsePublicNoteSnapshot(snapshot, task.platform, noteURL);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isRisk = message.includes('验证') || message.includes('登录');
    return failedPublicNote(
      targetURL, task.platform, `竞对公开页 ${task.platform}`,
      isRisk ? 'risk_control' : 'empty_page'
    );
  }
}
