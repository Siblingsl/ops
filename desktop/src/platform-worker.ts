// 平台采集工作进程（D-129 / 20 文档 §5.1、§13.1）。
// 只负责三件事：发现本机已安装的正式 Chromium 浏览器、按固定参数启动、通过 CDP pipe 做只读操作。
//
// 浏览器选择顺序（D-129 v0.5）：Google Chrome → Microsoft Edge → Brave → Vivaldi → Opera
// → Chromium → 本机已安装的 Playwright Chromium。只用用户机器上已有的可执行文件，
// 客户端不下载、不打包任何浏览器内核；找不到时明确报错，不静默失败。
// 不开放调试端口；不使用 Playwright 的驱动库（只借用它已经下载到本机的 Chromium 可执行文件）。
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

export type BrowserFamily = 'chrome' | 'edge' | 'brave' | 'vivaldi' | 'opera' | 'chromium' | 'playwright';

// 优先级固定：用户机器上的正式浏览器优先，Playwright 已下载的 Chromium 只作最后一档兜底。
export const PLATFORM_BROWSER_FAMILIES: ReadonlyArray<BrowserFamily> = Object.freeze([
  'chrome',
  'edge',
  'brave',
  'vivaldi',
  'opera',
  'chromium',
  'playwright'
]);

// 展示名只用于界面与诊断，不含路径。
export const PLATFORM_BROWSER_NAMES: Readonly<Record<BrowserFamily, string>> = Object.freeze({
  chrome: 'Google Chrome',
  edge: 'Microsoft Edge',
  brave: 'Brave',
  vivaldi: 'Vivaldi',
  opera: 'Opera',
  chromium: 'Chromium',
  playwright: 'Playwright Chromium'
});

export interface BrowserCandidate {
  executablePath: string;
  source: 'registry' | 'standard' | 'playwright';
  family: BrowserFamily;
}

// 每个品牌的 Windows 标准安装位置；只列正式发行版，不含便携版、Beta/Dev 通道。
export function standardBrowserPaths(env: NodeJS.ProcessEnv, family: BrowserFamily): string[] {
  const programFiles = env['ProgramFiles'] ?? '';
  const programFilesX86 = env['ProgramFiles(x86)'] ?? '';
  const localAppData = env['LOCALAPPDATA'] ?? '';
  const roots = [programFiles, programFilesX86, localAppData].filter((root) => root !== '');
  let paths: string[];
  switch (family) {
    case 'chrome':
      paths = roots.map((root) => path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      break;
    case 'edge':
      // Edge 在 64 位系统上默认装到 Program Files (x86)。
      paths = [programFilesX86, programFiles, localAppData]
        .filter((root) => root !== '')
        .map((root) => path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
      break;
    case 'brave':
      paths = roots.map((root) => path.join(root, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'));
      break;
    case 'vivaldi':
      paths = roots.map((root) => path.join(root, 'Vivaldi', 'Application', 'vivaldi.exe'));
      break;
    case 'opera':
      // Opera 默认按用户安装，也可能装到系统目录。
      paths = [
        localAppData && path.join(localAppData, 'Programs', 'Opera', 'opera.exe'),
        localAppData && path.join(localAppData, 'Programs', 'Opera GX', 'opera.exe'),
        programFiles && path.join(programFiles, 'Opera', 'opera.exe'),
        programFilesX86 && path.join(programFilesX86, 'Opera', 'opera.exe')
      ].filter((value): value is string => typeof value === 'string' && value !== '');
      break;
    case 'chromium':
      paths = roots.map((root) => path.join(root, 'Chromium', 'Application', 'chrome.exe'));
      break;
    case 'playwright':
      // Playwright 的 Chromium 由目录扫描得到，不按固定路径猜测。
      paths = [];
      break;
    default:
      paths = [];
  }
  return [...new Set(paths)];
}

const REGISTRY_APP_PATHS = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths';
const REGISTRY_EXECUTABLES: Readonly<Partial<Record<BrowserFamily, string>>> = Object.freeze({
  chrome: 'chrome.exe',
  edge: 'msedge.exe',
  brave: 'brave.exe',
  vivaldi: 'vivaldi.exe',
  opera: 'opera.exe'
});

// registryAppPathKeys 给出该品牌可能登记的 App Paths 键；没登记的品牌返回空。
export function registryAppPathKeys(family: BrowserFamily): string[] {
  const exe = REGISTRY_EXECUTABLES[family];
  if (!exe) return [];
  return [
    `HKLM\\${REGISTRY_APP_PATHS}\\${exe}`,
    `HKCU\\${REGISTRY_APP_PATHS}\\${exe}`,
    `HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`
  ];
}

// parseRegistryAppPath 从 `reg query ... /ve` 的输出里取默认值路径。
// 输出形如：`    (Default)    REG_SZ    C:\Program Files\Google\Chrome\Application\chrome.exe`
export function parseRegistryAppPath(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const match = /\bREG_(?:EXPAND_)?SZ\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const value = match[1].trim().replace(/^"(.*)"$/, '$1');
    if (value.toLowerCase().endsWith('.exe')) return value;
  }
  return null;
}

// playwrightBrowsersDir 是 Playwright 默认的浏览器缓存位置；环境变量可覆盖。
export function playwrightBrowsersDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  const override = env['PLAYWRIGHT_BROWSERS_PATH'];
  if (override && override !== '0') return override;
  const home = env['USERPROFILE'] ?? env['HOME'] ?? '';
  switch (platform) {
    case 'win32':
      return path.join(env['LOCALAPPDATA'] ?? home, 'ms-playwright');
    case 'darwin':
      return path.join(home, 'Library', 'Caches', 'ms-playwright');
    default:
      return path.join(home, '.cache', 'ms-playwright');
  }
}

// playwrightChromiumCandidates 把目录名（如 chromium-1248）按构建号从新到旧展开成候选可执行文件。
// 只用已经下载到本机的文件，不触发任何下载。
export function playwrightChromiumCandidates(baseDir: string, entries: ReadonlyArray<string>): BrowserCandidate[] {
  const builds = entries
    .map((name) => /^chromium-(\d+)$/.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ dir: match[0], build: Number(match[1]) }))
    .filter((entry) => Number.isSafeInteger(entry.build) && entry.build > 0)
    .sort((a, b) => b.build - a.build);
  const layouts: ReadonlyArray<ReadonlyArray<string>> = [
    ['chrome-win64', 'chrome.exe'],
    ['chrome-win', 'chrome.exe'],
    ['chrome-linux64', 'chrome'],
    ['chrome-linux', 'chrome'],
    ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium']
  ];
  const candidates: BrowserCandidate[] = [];
  for (const build of builds) {
    for (const layout of layouts) {
      candidates.push({
        executablePath: path.join(baseDir, build.dir, ...layout),
        source: 'playwright',
        family: 'playwright'
      });
    }
  }
  return candidates;
}

export interface BrowserDiscoveryRuntime {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  readdir?: (dir: string) => Promise<string[]>;
  isFile?: (file: string) => Promise<boolean>;
  queryRegistry?: (key: string) => Promise<string | null>;
}

async function defaultIsFile(file: string): Promise<boolean> {
  try {
    const stat = await fs.stat(file);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function defaultQueryRegistry(key: string): Promise<string | null> {
  const { execFile } = await import('node:child_process');
  return new Promise<string | null>((resolve) => {
    execFile('reg', ['query', key, '/ve'], { windowsHide: true, timeout: 3000 }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      resolve(parseRegistryAppPath(stdout));
    });
  });
}

// discoverPlatformBrowser 按固定优先级返回本机真实存在的浏览器候选；路径不对外展示。
export async function discoverPlatformBrowser(runtime: BrowserDiscoveryRuntime = {}): Promise<BrowserCandidate[]> {
  const env = runtime.env ?? process.env;
  const platform = runtime.platform ?? process.platform;
  const readdir = runtime.readdir ?? ((dir: string) => fs.readdir(dir));
  const isFile = runtime.isFile ?? defaultIsFile;
  const queryRegistry = runtime.queryRegistry ?? defaultQueryRegistry;
  const found: BrowserCandidate[] = [];
  for (const family of PLATFORM_BROWSER_FAMILIES) {
    if (family === 'playwright') {
      const baseDir = playwrightBrowsersDir(env, platform);
      const entries = await readdir(baseDir).catch(() => [] as string[]);
      for (const candidate of playwrightChromiumCandidates(baseDir, entries)) {
        if (await isFile(candidate.executablePath)) found.push(candidate);
      }
      continue;
    }
    if (platform === 'win32') {
      // 注册表能覆盖装到非标准目录的情况；查询失败不影响标准路径判定。
      for (const key of registryAppPathKeys(family)) {
        const exe = await queryRegistry(key).catch(() => null);
        if (exe && (await isFile(exe))) {
          found.push({ executablePath: exe, source: 'registry', family });
        }
      }
    }
    for (const executablePath of standardBrowserPaths(env, family)) {
      if (await isFile(executablePath)) {
        found.push({ executablePath, source: 'standard', family });
      }
    }
  }
  // 同一可执行文件只保留优先级最高的那条（注册表与标准路径常指向同一个文件）。
  const seen = new Set<string>();
  return found.filter((candidate) => {
    const key = candidate.executablePath.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// findPlatformBrowser 返回优先级最高的候选；一个都没有时明确报错，不静默失败。
export async function findPlatformBrowser(runtime: BrowserDiscoveryRuntime = {}): Promise<BrowserCandidate> {
  const candidates = await discoverPlatformBrowser(runtime);
  if (candidates.length === 0) {
    throw new PlatformBrowserError(
      'platform_browser_unsupported',
      '未找到可用的浏览器，请先安装 Google Chrome 或 Microsoft Edge'
    );
  }
  return candidates[0];
}

// pickExistingBrowser 返回第一个真实存在的候选；一个都没有时明确报错。
export async function pickExistingBrowser(candidates: ReadonlyArray<BrowserCandidate>): Promise<BrowserCandidate> {
  for (const candidate of candidates) {
    if (await defaultIsFile(candidate.executablePath)) return candidate;
  }
  throw new PlatformBrowserError('platform_browser_unsupported', '未找到可用的浏览器，请先安装 Google Chrome 或 Microsoft Edge');
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

// CDP 的 pipe 传输是「JSON + NUL 结尾」：每条消息是一段 UTF-8 JSON，后跟一个 \0 分隔符，
// 没有长度前缀（Chromium 的 PipeTransport 用 '\0' 作为分隔符切分）。
// 2026-10-20 用本机 Chrome 155 实测确认：写成 "\0<长度>\0<JSON>" 会被回
// `{"error":{"code":-32700,"message":"JSON: no input at position 0"}}`。
export function encodeCDPMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([body, Buffer.from('\0', 'ascii')]);
}

// 单条 CDP 消息的上限：页面快照与响应体能到几百 KB，超过 8 MiB 一定是异常流，
// 不能无限累积缓冲区把工作进程撑爆。
export const CDP_MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

// parseCDPFrame 从缓冲区取出以 NUL 结尾的一条消息；不足一条时返回 null。
export function parseCDPFrame(buffer: Buffer<ArrayBufferLike>): { message: unknown; rest: Buffer<ArrayBufferLike> } | null {
  let offset = 0;
  for (;;) {
    const end = buffer.indexOf(0, offset);
    if (end < 0) {
      if (buffer.length - offset > CDP_MAX_MESSAGE_BYTES) {
        throw new PlatformBrowserError('platform_schema_changed', '浏览器调试消息超出允许大小');
      }
      return null;
    }
    const body = buffer.subarray(offset, end).toString('utf8');
    const rest = buffer.subarray(end + 1);
    // 连续分隔符不产生消息，继续找下一条。
    if (body.trim() !== '') {
      if (body.length > CDP_MAX_MESSAGE_BYTES) {
        throw new PlatformBrowserError('platform_schema_changed', '浏览器调试消息超出允许大小');
      }
      try {
        return { message: JSON.parse(body), rest };
      } catch {
        // 半个 JSON 说明这条消息还没写完：保留缓冲区继续等，不能当成错误帧丢掉。
        return null;
      }
    }
    offset = end + 1;
  }
}

// ---------- 进程 ----------

export interface PlatformBrowserProcess {
  child: ChildProcess;
  send: (message: unknown) => void;
  onMessage: (listener: (message: unknown) => void) => void;
  /** 子进程在握手前退出或根本无法启动时返回稳定错误，用于把“找不到”与“起不来”分开。 */
  failure: () => PlatformBrowserError | null;
  close: () => Promise<void>;
}

// launchPlatformBrowser 启动浏览器并建立 pipe 会话。
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
  // spawn 失败（路径失效、无权限、被策略拦截）是异步 error 事件；
  // 不挂监听会让主进程直接崩掉，这里压成稳定错误码交给上层。
  let failureError: PlatformBrowserError | null = null;
  child.on('error', () => {
    failureError = new PlatformBrowserError(
      'platform_browser_launch_failed',
      '无法启动本机浏览器，请确认该浏览器可以正常打开'
    );
  });
  child.on('exit', () => {
    if (!failureError) {
      failureError = new PlatformBrowserError(
        'platform_browser_launch_failed',
        '浏览器启动后立即退出，请确认该浏览器可以正常打开'
      );
    }
  });
  const toBrowser = child.stdio[3] as NodeJS.WritableStream | null;
  const fromBrowser = child.stdio[4] as NodeJS.ReadableStream | null;
  if (!toBrowser || !fromBrowser) {
    child.kill();
    throw new PlatformBrowserError('platform_browser_launch_failed', '无法建立浏览器调试管道');
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
    failure: () => failureError,
    // close 必须让浏览器自己正常退出，不能直接 kill。
    // 2026-10-21 实测：`child.kill()` 强杀会让 Chromium 丢掉刚建立的登录会话，
    // 同一 profile 重启后需要重新扫码；改用 CDP 的 `Browser.close` 优雅关闭后，
    // 会话被正常刷盘，重启直接进入创作中心、无需扫码。
    // 注意：等待用的定时器**不能 unref**——unref 的定时器不会保持事件循环，
    // 在没有其它句柄时 await 会永远挂起（测试环境必然复现）。
    close: async () => {
      if (child.exitCode !== null) return;
      // 等浏览器自己退出；超时只是兜底，必须 clearTimeout，否则定时器会挂住事件循环。
      const waitExit = (ms: number): Promise<boolean> => new Promise((resolve) => {
        if (child.exitCode !== null) {
          resolve(true);
          return;
        }
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          resolve(false);
        }, ms);
        child.once('exit', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(true);
        });
      });
      // 先请浏览器自己退出（会触发会话落盘）。
      try {
        toBrowser.write(encodeCDPMessage({ id: 0, method: 'Browser.close' }));
      } catch {
        // 管道已断：直接走下面的兜底。
      }
      const exitedCleanly = await waitExit(8000);
      // 兜底：优雅关闭没生效时再强杀，避免留下孤儿进程占用 profile。
      if (!exitedCleanly && child.exitCode === null) {
        // 只结束自己启动的进程树，不影响用户正常浏览器（§13.1）。
        child.kill();
        await waitExit(2000);
      }
    }
  };
}

// ---------- CDP 握手 ----------

export interface CDPClient {
  request: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>;
  close: () => Promise<void>;
}

// CDPPageClient 额外提供“连到具体页面”的能力：Page/Runtime 域只在 page session 里可用。
export interface CDPPageClient extends CDPClient {
  attachToPage: (timeoutMs?: number) => Promise<string>;
  detach: () => Promise<void>;
  // collectResponses 监听页面自身发出的请求，取回匹配路径前缀的 JSON 响应体。
  // 只读：不注入脚本、不改请求头、不重放请求；用于需要平台签名的接口。
  collectResponses: (pathPrefix: string, timeoutMs?: number) => Promise<unknown | null>;
  // onEvent 订阅 CDP 事件（Network.* 等），返回取消订阅函数。
  onEvent: (listener: (method: string, params: unknown) => void) => () => void;
}

// createCDPClient 是最小请求/响应配对：按自增 id 匹配响应，超时明确失败。
// 只用于握手与后续只读调用，不实现事件订阅以外的能力。
//
// 注意：`--remote-debugging-pipe` 建立的是 **Browser 级**会话，Page/Runtime/Network 这些域
// 只在具体 target 的 session 里存在。直接发 `Page.enable` 会被回
// `{"code":-32601,"message":"'Page.enable' wasn't found"}`（2026-10-21 实测）。
// 因此本客户端默认先 attach 到一个 page target，之后的请求自动带上 sessionId。
export function createCDPClient(process: PlatformBrowserProcess, defaultTimeoutMs = 10_000): CDPPageClient {
  let nextID = 1;
  const pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  // 事件订阅者：Network.* 等无 id 的帧按 method 分发给监听者。
  const eventListeners = new Set<(method: string, params: unknown) => void>();
  process.onMessage((message) => {
    const frame = message as {
      id?: unknown; result?: unknown; method?: unknown; params?: unknown;
      error?: { message?: unknown; code?: unknown };
    };
    if (typeof frame.id !== 'number') {
      if (typeof frame.method === 'string') {
        for (const listener of eventListeners) {
          try {
            listener(frame.method, frame.params);
          } catch {
            // 监听器异常不能打断 CDP 主循环。
          }
        }
      }
      return;
    }
    const waiter = pending.get(frame.id);
    if (!waiter) return;
    pending.delete(frame.id);
    clearTimeout(waiter.timer);
    if (frame.error) {
      // 把浏览器的真实错误码带进错误信息，便于定位是“域不存在”还是“参数不合法”。
      const code = typeof frame.error.code === 'number' ? frame.error.code : 0;
      const text = typeof frame.error.message === 'string' ? frame.error.message : '';
      waiter.reject(new PlatformBrowserError(
        'platform_schema_changed',
        `浏览器调试调用失败（${code}）${text ? `：${text.slice(0, 120)}` : ''}`
      ));
      return;
    }
    waiter.resolve(frame.result);
  });
  let pageSessionId: string | null = null;
  const client: CDPClient = {
    request: (method, params, timeoutMs) => new Promise((resolve, reject) => {
      const failure = process.failure();
      if (failure) {
        reject(failure);
        return;
      }
      const id = nextID++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new PlatformBrowserError('platform_browser_launch_failed', '浏览器调试通道无响应'));
      }, timeoutMs ?? defaultTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      // 已 attach 到 page 之后，所有域调用都带 sessionId；Browser 级方法（Target.*）不带。
      const frame: Record<string, unknown> = { id, method, params: params ?? {} };
      if (pageSessionId && !method.startsWith('Target.')) frame.sessionId = pageSessionId;
      process.send(frame);
    }),
    close: async () => {
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new PlatformBrowserError('platform_browser_launch_failed', '浏览器调试会话已结束'));
      }
      pending.clear();
      await process.close();
    }
  };
  return {
    ...client,
    // attachToPage 取第一个 page target 并建立 flat session。
    // pipe 启动时自带一个 about:blank 页面；没有 page target 时明确报错，不静默重试。
    attachToPage: async (timeoutMs?: number): Promise<string> => {
      const targets = (await client.request('Target.getTargets', {}, timeoutMs)) as {
        targetInfos?: Array<{ targetId?: unknown; type?: unknown }>;
      };
      const page = (targets?.targetInfos ?? []).find((t) => t.type === 'page' && typeof t.targetId === 'string');
      if (!page || typeof page.targetId !== 'string') {
        throw new PlatformBrowserError('platform_browser_launch_failed', '浏览器没有可用的页面');
      }
      const attached = (await client.request('Target.attachToTarget', { targetId: page.targetId, flatten: true }, timeoutMs)) as {
        sessionId?: unknown;
      };
      if (typeof attached?.sessionId !== 'string' || attached.sessionId === '') {
        throw new PlatformBrowserError('platform_browser_launch_failed', '无法连接到浏览器页面');
      }
      pageSessionId = attached.sessionId;
      return pageSessionId;
    },
    detach: async (): Promise<void> => {
      pageSessionId = null;
    },
    onEvent: (listener) => {
      eventListeners.add(listener);
      return () => {
        eventListeners.delete(listener);
      };
    },
    // collectResponses 等页面自己发出匹配 pathPrefix 的请求，再取回它的响应体。
    // 只读：不构造请求、不复制签名头、不重放。
    collectResponses: (pathPrefix: string, timeoutMs = 30_000) => new Promise<unknown | null>((resolve, reject) => {
      const requestIDs = new Set<string>();
      let settled = false;
      let unsubscribe = () => {};
      const finish = (value: unknown | null, error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        if (error) reject(error);
        else resolve(value);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      // 直接订阅内部事件集合：client 的类型是 CDPClient，onEvent 在返回对象上。
      const listener = (method: string, params: unknown) => {
        if (method === 'Network.responseReceived') {
          const p = params as { requestId?: unknown; response?: { url?: unknown; status?: unknown; mimeType?: unknown } };
          const url = typeof p?.response?.url === 'string' ? p.response.url : '';
          // 只认与 pathPrefix 匹配的响应，且必须成功。
          if (typeof p?.requestId !== 'string' || !url.includes(pathPrefix)) return;
          const status = typeof p.response?.status === 'number' ? p.response.status : 0;
          if (status < 200 || status >= 300) return;
          requestIDs.add(p.requestId);
          return;
        }
        if (method === 'Network.loadingFinished') {
          const p = params as { requestId?: unknown };
          if (typeof p?.requestId !== 'string' || !requestIDs.has(p.requestId)) return;
          requestIDs.delete(p.requestId);
          client.request('Network.getResponseBody', { requestId: p.requestId }, 15_000)
            .then((body) => {
              const text = (body as { body?: unknown })?.body;
              if (typeof text !== 'string' || text.trim() === '') {
                finish(null);
                return;
              }
              try {
                finish(JSON.parse(text));
              } catch {
                // 非 JSON 响应（HTML 错误页等）不算可用数据。
                finish(null);
              }
            })
            .catch(() => finish(null));
        }
      };
      eventListeners.add(listener);
      unsubscribe = () => { eventListeners.delete(listener); };
      // 打开 Network 域后才能收到 responseReceived/loadingFinished。
      client.request('Network.enable', {}, 10_000).catch((error) => finish(null, error));
    })
  };
}

export interface PlatformBrowserProbe {
  family: BrowserFamily;
  name: string;
  version: string;
  major: number | null;
}

// parseBrowserProduct 从 CDP `Browser.getVersion` 的 product 串取产品名与版本：
// Chrome 报 "Chrome/155.0.8059.85"，Edge 报 "Edg/155.0.4283.62"，Chromium 报 "Chromium/…"。
// 2026-10-20 在本机实测确认了 Chrome 与 Edge 两种形态。
export function parseBrowserProduct(product: string): { brand: string; version: string } | null {
  const match = /^([A-Za-z][A-Za-z0-9 ]*)\/(\d+\.\d+[\w.\-]*)$/.exec(product.trim());
  if (!match) return null;
  return { brand: match[1], version: match[2] };
}

// probePlatformBrowser 用隔离 profile 启动一次浏览器，读回版本后立即关闭。
// 这是“本机确实能用这个浏览器”的唯一可信证据：只看路径存在不算验证通过。
export async function probePlatformBrowser(
  options: { candidate: BrowserCandidate; profileDir: string; timeoutMs?: number },
  runtime: { spawnImpl?: typeof spawn; env?: NodeJS.ProcessEnv } = {}
): Promise<PlatformBrowserProbe> {
  const browser = await launchPlatformBrowser(
    { executablePath: options.candidate.executablePath, profileDir: options.profileDir },
    runtime
  );
  const cdp = createCDPClient(browser, options.timeoutMs ?? 15_000);
  try {
    const result = (await cdp.request('Browser.getVersion')) as { product?: unknown };
    const product = typeof result?.product === 'string' ? result.product : '';
    const parsed = parseBrowserProduct(product);
    if (!parsed) {
      throw new PlatformBrowserError('platform_browser_unsupported', '无法识别浏览器版本');
    }
    return {
      family: options.candidate.family,
      name: PLATFORM_BROWSER_NAMES[options.candidate.family],
      version: parsed.version,
      major: chromeMajorVersion(parsed.version)
    };
  } catch (error) {
    // 握手前子进程就退出或根本没起来：给出“起不来”而不是“不支持”，
    // 否则用户会去重装一个其实已经装好的浏览器。
    const failure = browser.failure();
    if (failure) throw failure;
    throw error;
  } finally {
    await cdp.close();
  }
}
