// 平台采集工作进程（D-129 / 20 文档 §5.1、§13.1）。
// 只负责三件事：发现本机已安装的标准 Google Chrome、按固定参数启动、通过 CDP pipe 做只读操作。
// 不使用 Playwright / Puppeteer 及其自带浏览器，不开放调试端口，不回退 Edge 或自带内核。
//
// 纯 Node 模块（不依赖 Electron）：启动参数、版本判定与 CDP 帧编解码都可单测。
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

// 平台站点的允许域名表随适配器版本发布，不接受服务端下发的放行域名（§13.1）。
// PS05/06 在适配器里引用这里的常量，新增域名必须改客户端版本。
export const PLATFORM_ALLOWED_ORIGINS: Readonly<Record<string, ReadonlyArray<string>>> = Object.freeze({
  xhs: ['https://creator.xiaohongshu.com'],
  wechat_mp: ['https://mp.weixin.qq.com']
});

export class PlatformBrowserError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PlatformBrowserError';
    this.code = code;
  }
}

// ---------- 浏览器发现 ----------

export interface BrowserCandidate {
  executablePath: string;
  source: 'registry' | 'standard';
}

// 标准安装路径只列出 Google Chrome 自己的位置，不含 Edge 或 Chromium 自带内核。
export function standardChromePaths(env: NodeJS.ProcessEnv): string[] {
  const paths: string[] = [];
  const programFiles = env['ProgramFiles'] ?? '';
  const programFilesX86 = env['ProgramFiles(x86)'] ?? '';
  const localAppData = env['LOCALAPPDATA'] ?? '';
  if (programFiles) paths.push(path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  if (programFilesX86) paths.push(path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  if (localAppData) paths.push(path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  return paths;
}

// pickExistingChrome 返回第一个真实存在的候选；一个都没有时明确报错，不找替代浏览器。
export async function pickExistingChrome(candidates: ReadonlyArray<BrowserCandidate>): Promise<BrowserCandidate> {
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate.executablePath);
      if (stat.isFile()) return candidate;
    } catch {
      continue;
    }
  }
  throw new PlatformBrowserError('platform_browser_unsupported', '未安装受支持的标准 Google Chrome');
}

// ---------- 启动参数 ----------

export interface PlatformLaunchOptions {
  executablePath: string;
  profileDir: string;
  // 允许的最小/最大主版本；null 表示不拒绝（等 SP-PS01 锁定正式范围）。
  minMajorVersion?: number | null;
  maxMajorVersion?: number | null;
}

// buildLaunchArgs 是唯一允许的平台浏览器启动参数：
// 显式 profile、pipe 调试、显式沙箱、禁用不需要的子系统。
// 绝不包含 --remote-debugging-port、--no-sandbox、--ignore-certificate-errors 或任何用户可控的附加参数。
export function buildLaunchArgs(options: { profileDir: string }): string[] {
  return [
    `--user-data-dir=${options.profileDir}`,
    '--remote-debugging-pipe',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-sync',
    '--disable-translate',
    '--metrics-recording-only',
    '--password-store=basic',
    '--use-mock-keychain',
    // 沙箱保持启用：不出现 --no-sandbox / --disable-web-security。
    '--enable-features=NetworkServiceSandbox',
    'about:blank'
  ];
}

// assertSafeLaunchArgs 在真正启动前再检查一次，防止上层误加危险参数。
export function assertSafeLaunchArgs(args: ReadonlyArray<string>): void {
  const forbidden = ['--no-sandbox', '--disable-web-security', '--ignore-certificate-errors', '--remote-debugging-port'];
  for (const arg of args) {
    const head = arg.split('=')[0];
    if (forbidden.includes(head)) {
      throw new PlatformBrowserError('platform_browser_unsupported', '平台浏览器启动参数包含被禁止的选项');
    }
  }
  const debugging = args.filter((a) => a.startsWith('--remote-debugging-'));
  if (debugging.length !== 1 || debugging[0] !== '--remote-debugging-pipe') {
    throw new PlatformBrowserError('platform_browser_unsupported', '平台浏览器必须且只能通过 --remote-debugging-pipe 调试');
  }
}

// 从 Chrome 版本串取主版本，例如 "155.0.8059.80" → 155。
export function chromeMajorVersion(version: string): number | null {
  const match = /^(\d+)\./.exec(version.trim());
  if (!match) return null;
  const major = Number(match[1]);
  return Number.isSafeInteger(major) && major > 0 ? major : null;
}

// checkBrowserVersion 决定是否允许用该版本启动适配器。
// 超出范围时拒绝启动并提示等待客户端更新，不静默降级、不重建 profile（§5.1）。
export function checkBrowserVersion(
  version: string,
  range: { min?: number | null; max?: number | null } = {}
): { ok: boolean; major: number | null; reason?: string } {
  const major = chromeMajorVersion(version);
  if (major === null) {
    return { ok: false, major: null, reason: '无法识别浏览器版本' };
  }
  if (range.min != null && major < range.min) {
    return { ok: false, major, reason: '浏览器版本低于已验证范围' };
  }
  if (range.max != null && major > range.max) {
    return { ok: false, major, reason: '浏览器版本高于已验证范围' };
  }
  return { ok: true, major };
}

// ---------- 网络目标校验 ----------

// isPrivateHost 拒绝 loopback、RFC1918、link-local 与云元数据地址（§13.1）。
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === '' || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '169.254.169.254' || host === 'metadata.google.internal') return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  const v6 = host;
  if (v6 === '::1' || v6 === '::') return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(v6)) return true; // ULA
  if (/^fe80:/i.test(v6)) return true; // link-local
  return false;
}

// isAllowedPlatformUrl 同时检查协议、允许域名与私网目标。
export function isAllowedPlatformUrl(rawUrl: string, platform: string): boolean {
  const allowed = PLATFORM_ALLOWED_ORIGINS[platform];
  if (!allowed) return false;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  // 明确拒绝 file:/ftp:/未允许的 ws: 等协议。
  if (parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;
  if (isPrivateHost(parsed.hostname)) return false;
  const origin = `${parsed.protocol}//${parsed.host}`.toLowerCase();
  return allowed.some((a) => a.toLowerCase() === origin);
}

// assertRedirectAllowed 校验重定向：最多 3 次，且每一跳仍须在允许表内（§13.1）。
export function assertRedirectAllowed(chain: ReadonlyArray<string>, platform: string): void {
  if (chain.length === 0) return;
  if (chain.length > 3) {
    throw new PlatformBrowserError('platform_network_unavailable', '重定向次数超过上限');
  }
  for (const url of chain) {
    if (!isAllowedPlatformUrl(url, platform)) {
      throw new PlatformBrowserError('platform_network_unavailable', '重定向目标不在允许的官方域名内');
    }
  }
}

// ---------- CDP pipe 帧 ----------

// parseCDPFrameHeader 解析 "\0<长度>\0" 形式的帧头。
// CDP 的 pipe 传输是 NUL 分隔的长度前缀：帧 = "\0" + 十进制长度 + "\0" + JSON。
export function encodeCDPMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([Buffer.from('\0', 'ascii'), Buffer.from(String(body.length), 'ascii'), Buffer.from('\0', 'ascii'), body]);
}

// parseCDPFrame 从缓冲区取出一帧；不足一帧时返回 null 与原始缓冲区。
export function parseCDPFrame(buffer: Buffer<ArrayBufferLike>): { message: unknown; rest: Buffer<ArrayBufferLike> } | null {
  if (buffer.length === 0 || buffer[0] !== 0) return null;
  const lengthEnd = buffer.indexOf(0, 1);
  if (lengthEnd < 0) return null;
  const length = Number(buffer.subarray(1, lengthEnd).toString('ascii'));
  if (!Number.isSafeInteger(length) || length < 0) return null;
  const start = lengthEnd + 1;
  if (buffer.length < start + length) return null;
  const body = buffer.subarray(start, start + length).toString('utf8');
  return { message: JSON.parse(body), rest: buffer.subarray(start + length) };
}

// ---------- 进程 ----------

export interface PlatformBrowserProcess {
  child: ChildProcess;
  send: (message: unknown) => void;
  onMessage: (listener: (message: unknown) => void) => void;
  close: () => Promise<void>;
}

// launchPlatformBrowser 启动 Chrome 并建立 pipe 会话。
// 主进程与子进程之间只用 `stdio: ['ignore','ignore','pipe','pipe','pipe']` 的私有管道：
// fd 3/4 是 CDP 的输入/输出管道，本机其他程序无法借端口接管会话。
export async function launchPlatformBrowser(
  options: PlatformLaunchOptions,
  runtime: { spawnImpl?: typeof spawn; env?: NodeJS.ProcessEnv } = {}
): Promise<PlatformBrowserProcess> {
  const args = buildLaunchArgs({ profileDir: options.profileDir });
  assertSafeLaunchArgs(args);
  const spawnImpl = runtime.spawnImpl ?? spawn;
  // OPS_DESKTOP_NO_SANDBOX 等逃生配置不传给平台浏览器（§5.1）；
  // 只传递系统代理相关的最小环境变量。
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE']) {
    if (runtime.env?.[key]) env[key] = runtime.env[key];
  }
  if (runtime.env?.HTTP_PROXY) env.HTTP_PROXY = runtime.env.HTTP_PROXY;
  if (runtime.env?.HTTPS_PROXY) env.HTTPS_PROXY = runtime.env.HTTPS_PROXY;
  if (runtime.env?.NO_PROXY) env.NO_PROXY = runtime.env.NO_PROXY;

  const child = spawnImpl(options.executablePath, args, {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
    env,
    windowsHide: false
  });
  const toBrowser = child.stdio[3] as NodeJS.WritableStream | null;
  const fromBrowser = child.stdio[4] as NodeJS.ReadableStream | null;
  if (!toBrowser || !fromBrowser) {
    child.kill();
    throw new PlatformBrowserError('platform_browser_unsupported', '无法建立浏览器调试管道');
  }
  const listeners: Array<(message: unknown) => void> = [];
  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  fromBrowser.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      const frame = parseCDPFrame(pending);
      if (!frame) break;
      pending = frame.rest;
      for (const listener of listeners) listener(frame.message);
    }
  });
  return {
    child,
    send: (message: unknown) => { toBrowser.write(encodeCDPMessage(message)); },
    onMessage: (listener) => { listeners.push(listener); },
    close: async () => new Promise<void>((resolve) => {
      if (child.exitCode !== null) {
        resolve();
        return;
      }
      child.once('exit', () => resolve());
      // 只结束自己启动的进程树，不影响用户正常浏览器（§13.1）。
      child.kill();
      setTimeout(resolve, 2000).unref();
    })
  };
}
