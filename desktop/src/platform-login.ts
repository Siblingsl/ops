// 平台登录会话（D-129 / 20 文档 §4.1、§5.1、§13.1）。
//
// 职责：按连接的独立 profile 启动本机浏览器 → 打开官方后台 → 等用户本人扫码 →
// 在页面内做**固定、只读**的同源请求读回账号身份 → 关闭浏览器。
//
// 边界（不可越过）：
//   * 脚本是客户端内置的固定常量，**不接受服务端下发**，不带任何外部参数；
//   * 只调用同源 GET 接口读 JSON，不点击发布/删除/修改，不注入 DOM，不读取页面表单；
//   * Cookie/token 只留在该 profile 内，不上传、不写日志、不回传页面；
//   * 一个连接同时只有一个登录会话；同一 profile 被占用时明确报 busy。
//
// 纯 Node 模块（不依赖 Electron），CDP 会话由调用方注入，便于单测。

import type { CDPPageClient, PlatformBrowserProcess } from './platform-worker';
import { isAllowedPlatformUrl, PlatformBrowserError } from './platform-worker';

export type PlatformLoginPlatform = 'xhs' | 'wechat_mp' | 'toutiao';

// 每个平台的官方后台入口。路径取自 §17.1.1 的实测落点，不接受服务端下发。
export const PLATFORM_LOGIN_URLS: Readonly<Record<PlatformLoginPlatform, string>> = Object.freeze({
  xhs: 'https://creator.xiaohongshu.com/new/note-manager',
  wechat_mp: 'https://mp.weixin.qq.com/',
  toutiao: 'https://mp.toutiao.com/'
});

// 轮询参数：3 分钟内每 3 秒探测一次（用户确认的取值）。
export const PLATFORM_LOGIN_TIMEOUT_MS = 180_000;
export const PLATFORM_LOGIN_POLL_MS = 3_000;

// ---------- 固定只读脚本 ----------
//
// 只读求值的脚本是常量，逐字可审计：没有模板替换、没有外部输入、没有写操作。
// 每个脚本只做一件事：以页面自身身份发一次同源 GET，把响应原文返回给本机解析。
// 返回值经 JSON.stringify 后由 CDP 交回，不在这里做任何解析。

// 小红书创作中心的账号信息接口（§6.2、§17.1.1 实测）。
export const XHS_IDENTITY_SCRIPT = `(async () => {
  try {
    const response = await fetch('/api/galaxy/user/info', {
      method: 'GET',
      credentials: 'same-origin',
      headers: { 'Accept': 'application/json' }
    });
    const text = await response.text();
    return JSON.stringify({ ok: response.ok, status: response.status, body: text.slice(0, 65536) });
  } catch (error) {
    return JSON.stringify({ ok: false, status: 0, body: '' });
  }
})()`;

// 公众号后台的账号切换接口：biz_list 里带 bizuin 与原始 ID（§6.3、§17.1.1 实测）。
export const WECHAT_IDENTITY_SCRIPT = `(async () => {
  try {
    const response = await fetch('/cgi-bin/switchacct?action=switch_acct&fingerprint=&lang=zh_CN&f=json&ajax=1', {
      method: 'GET',
      credentials: 'same-origin',
      headers: { 'Accept': 'application/json' }
    });
    const text = await response.text();
    return JSON.stringify({ ok: response.ok, status: response.status, body: text.slice(0, 65536) });
  } catch (error) {
    return JSON.stringify({ ok: false, status: 0, body: '' });
  }
})()`;

export const PLATFORM_IDENTITY_SCRIPTS: Readonly<Partial<Record<PlatformLoginPlatform, string>>> = Object.freeze({
  xhs: XHS_IDENTITY_SCRIPT,
  wechat_mp: WECHAT_IDENTITY_SCRIPT
});

// assertReadOnlyScript 在发送前复查脚本内容：只允许固定常量里的那一段。
// 任何拼接、模板变量或写操作迹象都拒绝，防止调用方绕过常量。
export function assertReadOnlyScript(script: string, platform: PlatformLoginPlatform): void {
  if (script !== PLATFORM_IDENTITY_SCRIPTS[platform]) {
    throw new PlatformBrowserError('platform_schema_changed', '只读脚本与内置版本不一致');
  }
  // 纵深：即便常量被改动，也拦掉明显有写意图的调用。
  const forbidden = [
    /method:\s*['"](POST|PUT|PATCH|DELETE)['"]/i,
    /document\.cookie/i,
    /localStorage/i,
    /sessionStorage/i,
    /\.click\(/,
    /\.submit\(/,
    /XMLHttpRequest/i,
    /WebSocket/i
  ];
  for (const pattern of forbidden) {
    if (pattern.test(script)) {
      throw new PlatformBrowserError('platform_schema_changed', '只读脚本包含被禁止的调用');
    }
  }
}

// ---------- 求值结果解析 ----------

export interface IdentityProbeResult {
  // page 为 true 表示页面本身已登录并可读身份；false 表示还需要用户继续扫码/登录。
  loggedIn: boolean;
  // 原始 JSON 文本，交给适配器的 parseIdentity 解析；解析失败不在这里抛。
  payload: string | null;
}

// parseEvaluateResponse 从 CDP `Runtime.evaluate` 的返回值里取出我们那段 JSON。
// 只接受字符串形态（脚本自己 JSON.stringify 过），其它形态一律当作“读不到”。
export function parseEvaluateResponse(result: unknown): IdentityProbeResult {
  const remote = (result as { result?: { type?: unknown; value?: unknown; description?: unknown } } | null)?.result;
  if (!remote) return { loggedIn: false, payload: null };
  let raw: unknown = remote.value;
  if (typeof raw !== 'string' && typeof remote.description === 'string') raw = remote.description;
  if (typeof raw !== 'string' || raw.trim() === '') return { loggedIn: false, payload: null };
  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return { loggedIn: false, payload: null };
  }
  const env = envelope as { ok?: unknown; status?: unknown; body?: unknown };
  if (env.ok !== true || typeof env.body !== 'string' || env.body.trim() === '') {
    return { loggedIn: false, payload: null };
  }
  let body: unknown;
  try {
    body = JSON.parse(env.body);
  } catch {
    return { loggedIn: false, payload: null };
  }
  // 平台把“未登录”也回 200，靠业务码判断；这里只判“是否拿到了可解析的业务对象”，
  // 具体身份是否成立交给适配器的 parseIdentity。
  const candidate = body as { data?: unknown; base_resp?: { ret?: unknown } };
  if (candidate.base_resp && typeof candidate.base_resp.ret === 'number' && candidate.base_resp.ret !== 0) {
    return { loggedIn: false, payload: null };
  }
  return { loggedIn: true, payload: env.body };
}

// ---------- 采集用只读响应源 ----------
//
// 取数分两种接口（20 文档 §1307）：
//   1. 不需要平台签名的同源只读接口（`/api/galaxy/user/info` 等）：用固定脚本直接 GET；
//   2. 需要平台签名的接口（如笔记列表 `/api/galaxy/v2/creator/note/user/posted`）：
//      直接 GET 会被回 406 `{"code":-1,"success":false}`。此时**不能自己造签名**，
//      而是让正常后台页面按它自己的方式发起请求，我们监听 Network 响应取 body。
//      §13.1 明确：不向服务器导出签名／会话，也不复制整套鉴权。
export const READ_ONLY_PATH_PREFIXES: ReadonlyArray<string> = Object.freeze(['/api/', '/cgi-bin/']);

// 需要平台签名的接口前缀：这些路径必须走页面自发请求 + 响应监听。
// 直接 GET 会 406，因此不能放进 buildReadOnlyFetchScript 的调用集合。
export const SIGNED_PATH_PREFIXES: ReadonlyArray<string> = Object.freeze([
  '/api/galaxy/v2/creator/note/'
]);

export function requiresPlatformSignature(path: string): boolean {
  return SIGNED_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
}

// 公众号后台的会话 token 在页面 URL 里（`?token=…`），接口必须带上它，
// 否则回 `{"ret":200040,"err_msg":"invalid csrf token"}`（2026-10-21 实测）。
// 只允许在路径上追加 `token` 这一个参数，不接受调用方传入任意值。
export const PATH_TOKEN_PLATFORMS: ReadonlyArray<PlatformLoginPlatform> = Object.freeze(['wechat_mp']);
export const PATH_TOKEN_PARAM = 'token';

// withPagePathToken 给需要页面 token 的接口补上 token 参数。
// token 由页面自身 URL 提供（调用方从 session 取），这里只做拼接与去重。
export function withPagePathToken(path: string, token: string): string {
  if (token.trim() === '') return path;
  const hashIndex = path.indexOf('#');
  const base = hashIndex >= 0 ? path.slice(0, hashIndex) : path;
  const queryIndex = base.indexOf('?');
  const query = queryIndex >= 0 ? base.slice(queryIndex + 1) : '';
  const existing = new URLSearchParams(query);
  if (existing.has(PATH_TOKEN_PARAM)) return path;
  existing.set(PATH_TOKEN_PARAM, token.trim());
  const pathname = queryIndex >= 0 ? base.slice(0, queryIndex) : base;
  return `${pathname}?${existing.toString()}`;
}

// buildTokenAwareFetchScript 生成“先取页面 token、再带 token 请求”的固定脚本。
// 与 buildReadOnlyFetchScript 同样的只读约束，只是多一个 token 参数。
export function buildTokenAwareFetchScript(path: string): string {
  assertReadOnlyPath(path);
  return `(async () => {
  try {
    const token = new URLSearchParams(location.search).get('${PATH_TOKEN_PARAM}') || '';
    const url = new URL(${JSON.stringify(path)}, location.origin);
    if (token) url.searchParams.set('${PATH_TOKEN_PARAM}', token);
    const response = await fetch(url.toString(), {
      method: 'GET',
      credentials: 'same-origin',
      headers: { 'Accept': 'application/json' }
    });
    const text = await response.text();
    return JSON.stringify({ ok: response.ok, status: response.status, body: text.slice(0, 524288) });
  } catch (error) {
    return JSON.stringify({ ok: false, status: 0, body: '' });
  }
})()`;
}

export function assertReadOnlyPath(path: string): void {
  if (!path.startsWith('/')) {
    throw new PlatformBrowserError('platform_network_unavailable', '只读请求必须是同源相对路径');
  }
  if (path.includes('..') || path.includes('\\') || path.includes('\0') || path.includes('#')) {
    throw new PlatformBrowserError('platform_network_unavailable', '只读请求路径包含不允许的字符');
  }
  if (path.includes('://')) {
    throw new PlatformBrowserError('platform_network_unavailable', '只读请求不允许绝对地址');
  }
  if (!READ_ONLY_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    throw new PlatformBrowserError('platform_network_unavailable', '只读请求路径不在允许的接口前缀内');
  }
}

// buildReadOnlyFetchScript 生成一次同源 GET 的固定脚本。
// 路径经 JSON.stringify 转义后嵌入，仍然只做 GET + 同源 + 返回原文，不含任何写操作。
export function buildReadOnlyFetchScript(path: string): string {
  assertReadOnlyPath(path);
  return `(async () => {
  try {
    const response = await fetch(${JSON.stringify(path)}, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { 'Accept': 'application/json' }
    });
    const text = await response.text();
    return JSON.stringify({ ok: response.ok, status: response.status, body: text.slice(0, 524288) });
  } catch (error) {
    return JSON.stringify({ ok: false, status: 0, body: '' });
  }
})()`;
}

// createPageResponseSource 把 CDP 页面会话包装成适配器需要的只读响应源。
// 适配器只调用 fetchJSON(path)，不接触 CDP、不自己发请求。
//
// 签名接口走 observeResponse：让页面自己发起该请求（导航到对应页面或用页面内只读
// 触发），我们只从 Network 域取回响应 body。这里不构造、不复制任何签名头。
export function createPageResponseSource(session: PlatformLoginSession): {
  fetchJSON: (path: string) => Promise<unknown>;
  fetchSigned: (path: string) => Promise<unknown>;
  fetchSignedNextPage: (path: string) => Promise<unknown | null>;
  observeResponse: (pathPrefix: string, trigger: () => Promise<void>, timeoutMs?: number) => Promise<unknown>;
} {
  const observe = async (pathPrefix: string, trigger: () => Promise<void>, timeoutMs = 30_000) => {
    assertReadOnlyPath(pathPrefix);
    if (!session.cdp.collectResponses) {
      throw new PlatformBrowserError('platform_capability_denied', '当前调试会话不支持响应监听');
    }
    const collected = session.cdp.collectResponses(pathPrefix, timeoutMs);
    await trigger();
    const body = await collected;
    if (body === null) {
      throw new PlatformBrowserError('platform_network_unavailable', '没有捕获到平台的响应');
    }
    return body;
  };
  return {
    fetchJSON: async (path: string) => {
      // 公众号后台的接口必须带页面 URL 里的 token，否则回 invalid csrf token。
      const needsToken = PATH_TOKEN_PLATFORMS.includes(session.platform);
      const script = needsToken ? buildTokenAwareFetchScript(path) : buildReadOnlyFetchScript(path);
      const result = await session.cdp.request('Runtime.evaluate', {
        expression: script,
        awaitPromise: true,
        returnByValue: true
      }, 30_000).catch(() => null);
      const envelope = parseRawEnvelope(result);
      if (!envelope) {
        throw new PlatformBrowserError('platform_network_unavailable', '页面内只读请求没有返回可用数据');
      }
      if (!envelope.ok) {
        throw new PlatformBrowserError(
          envelope.status === 401 || envelope.status === 403 ? 'platform_login_required'
            : envelope.status === 406 ? 'platform_capability_denied'
              : 'platform_network_unavailable',
          '页面内只读请求失败'
        );
      }
      return envelope.body;
    },

    // fetchSigned：签名接口不自己造签名，改为“让页面自己请求、我们监听响应”。
    // 触发方式是导航到登记过的官方页面，让页面自身发起该请求。
    // 只导航到内置常量里的官方地址，不接受外部 URL。
    fetchSigned: async (path: string) => {
      const trigger = SIGNED_PATH_TRIGGERS[path.split('?')[0]];
      if (!trigger) {
        throw new PlatformBrowserError('platform_capability_denied', '该签名接口没有登记触发页面');
      }
      if (!isAllowedPlatformUrl(trigger.url, session.platform)) {
        throw new PlatformBrowserError('platform_network_unavailable', '触发页面不在允许的官方域名内');
      }
      return observe(trigger.observe, async () => {
        // 先离开再回来，保证“同一 URL 的 Page.navigate”也能重新触发请求。
        // 公众号的 switchacct 只在从根进入后台时发起，因此这里不能用 about:blank
        // 打断（实测会捕获不到），改为直接导航到登记页面。
        if (trigger.resetViaBlank) {
          await session.cdp.request('Page.navigate', { url: 'about:blank' }, 10_000).catch(() => undefined);
        }
        await session.cdp.request('Page.navigate', { url: trigger.url }, 30_000);
      });
    },

    observeResponse: observe,

    // fetchSignedNextPage：在**同一个**列表页里加载下一批，用于签名列表的分页。
    //
    // 为什么不能继续用 fetchSigned：它每次都重新导航到列表页，平台会把页码重置回
    // 第一页。2026-10-26 实测——导航只给第一页 10 条，之后无论请求 page=1/2/3 都
    // 返回同一批（服务端记录为 page_repeated）；而把列表容器滚到底部，页面自己会
    // 依次发出 page=1/2/3，读到 39 条，与平台自报的笔记总数一致。
    //
    // 这里仍然只监听页面自己发出的请求：不构造签名、不复制请求头、不改写 URL，
    // 只是用只读的 DOM 滚动把列表翻到底，让页面自己去取下一页。
    // 返回 null 表示该接口没有登记滚动触发方式，调用方应退回逐页导航。
    fetchSignedNextPage: async (path: string) => {
      const trigger = SIGNED_PATH_TRIGGERS[path.split('?')[0]];
      if (!trigger || !trigger.scroll) return null;
      if (!isAllowedPlatformUrl(trigger.url, session.platform)) {
        throw new PlatformBrowserError('platform_network_unavailable', '触发页面不在允许的官方域名内');
      }
      // 没捕获到响应有两种可能：列表真的到底了，或者这一次滚动没触发出来。
      // 只看被动监听分不清这两者，所以最多重试一次再判定“到底”，
      // 避免把偶发的漏触发当成枚举完成（那会让覆盖被高估）。
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          return await observe(trigger.observe, async () => {
            const result = await session.cdp.request('Runtime.evaluate', {
              expression: SCROLL_LIST_TO_END_SCRIPT,
              returnByValue: true
            }, 15_000).catch(() => null);
            if (!result) {
              throw new PlatformBrowserError('platform_network_unavailable', '页面滚动没有返回结果');
            }
          }, trigger.scrollTimeoutMs ?? 12_000);
        } catch (error) {
          if (!(error instanceof PlatformBrowserError) || error.code !== 'platform_network_unavailable') throw error;
          // 第二次仍然没有响应：按“没有更多”交给调用方收口，不当作网络故障，
          // 否则每读到最后一页都会失败一次。
          if (attempt === 1) return null;
        }
      }
      return null;
    }
  };
}

// SCROLL_LIST_TO_END_SCRIPT 把页面里“真正可滚动的那个列表容器”滚到底部。
// 只读：只改 scrollTop，不发请求、不读数据。
// 实测小红书创作中心的滚动容器是 `div.content`（2018/592），而 document.body 的
// scrollHeight 与 window.innerHeight 相等，滚 window 完全不生效（2026-10-26 实测
// 滚 window 得到 0 条新数据）。这里按“可滚动距离最大”挑选容器，避免写死类名。
export const SCROLL_LIST_TO_END_SCRIPT = `(() => {
  const doc = document;
  const best = { el: null, distance: 0 };
  for (const el of doc.querySelectorAll('div, main, section, ul, ol')) {
    const distance = el.scrollHeight - el.clientHeight;
    if (distance > 40 && distance > best.distance) { best.el = el; best.distance = distance; }
  }
  const target = best.el || doc.scrollingElement || doc.documentElement;
  if (!target) return null;
  target.scrollTop = target.scrollHeight;
  return { top: target.scrollTop, height: target.scrollHeight, client: target.clientHeight };
})()`;

// SIGNED_PATH_TRIGGERS 登记“签名接口 → 会自然触发它的官方页面”。
// 只登记已确认的页面，不猜路径；新增接口必须随适配器版本一起加。
// scroll=true 表示该接口支持“在同一页面滚动加载下一批”，供 fetchSignedNextPage 使用。
export const SIGNED_PATH_TRIGGERS: Readonly<Record<string, { url: string; observe: string; resetViaBlank?: boolean; scroll?: boolean; scrollTimeoutMs?: number }>> = Object.freeze({
  '/api/galaxy/v2/creator/note/user/posted': {
    url: 'https://creator.xiaohongshu.com/new/note-manager',
    observe: '/api/galaxy/v2/creator/note/user/posted',
    // 小红书同一 URL 的 Page.navigate 不会重新发请求，需要先离开再回来。
    resetViaBlank: true,
    // 滚动列表容器到底会触发下一批；末页不再发请求时按“没有更多”处理。
    scroll: true,
    scrollTimeoutMs: 12_000
  },
  // 公众号账号列表：`switchacct` 由页面自身在进入后台时发起，参数含时效性签名，
  // 构造不出来（直接请求恒回 `{"ret":200009,"err_msg":"not found"}`，2026-10-21 实测）。
  // 只能让页面自己发；从根进入后台即可触发，中间插 about:blank 反而捕获不到。
  '/cgi-bin/switchacct': {
    url: 'https://mp.weixin.qq.com/',
    observe: '/cgi-bin/switchacct'
  }
});

// parseRawEnvelope 解析脚本自报的 {ok,status,body}；body 保持字符串，交给适配器自己 JSON.parse。
export function parseRawEnvelope(result: unknown): { ok: boolean; status: number; body: unknown } | null {
  const remote = (result as { result?: { value?: unknown; description?: unknown } } | null)?.result;
  if (!remote) return null;
  let raw: unknown = remote.value;
  if (typeof raw !== 'string' && typeof remote.description === 'string') raw = remote.description;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return null;
  }
  const env = envelope as { ok?: unknown; status?: unknown; body?: unknown };
  if (typeof env.ok !== 'boolean' || typeof env.body !== 'string') return null;
  const status = typeof env.status === 'number' ? env.status : 0;
  if (!env.ok) return { ok: false, status, body: null };
  if (env.body.trim() === '') return { ok: false, status, body: null };
  try {
    return { ok: true, status, body: JSON.parse(env.body) };
  } catch {
    return null;
  }
}

// ---------- 登录会话 ----------

export interface PlatformLoginSession {
  platform: PlatformLoginPlatform;
  profileDir: string;
  browser: PlatformBrowserProcess;
  cdp: CDPPageClient;
}

// attachLoginPage 建立到具体页面的 CDP session。
// pipe 启动得到的是 Browser 级会话，Page/Runtime 域只在 page session 里存在；
// 不 attach 就发 `Page.enable` 会被回 -32601（2026-10-21 实测）。
export async function attachLoginPage(session: PlatformLoginSession): Promise<string> {
  return session.cdp.attachToPage(20_000);
}

// openLoginPage 打开官方后台并等首屏加载完成。
// 导航目标必须同时通过 §13.1 的允许域名校验，否则拒绝启动。
export async function openLoginPage(
  session: PlatformLoginSession,
  options: { captureBeforeNavigate?: ReadonlyArray<string>; captureTimeoutMs?: number } = {}
): Promise<{ url: string; title: string; captured: Map<string, unknown> }> {
  const target = PLATFORM_LOGIN_URLS[session.platform];
  if (!isAllowedPlatformUrl(target, session.platform)) {
    throw new PlatformBrowserError('platform_network_unavailable', '登录页不在允许的官方域名内');
  }
  // 必须先连到具体页面：Browser 级会话没有 Page/Runtime 域。
  await attachLoginPage(session);
  await session.cdp.request('Page.enable');
  // 有些接口只在“页面首次进入后台”时由页面自己发起（公众号 switchacct），
  // 之后再导航不会重发。因此调用方要求捕获时，必须在导航**之前**就注册监听。
  const captured = new Map<string, unknown>();
  const pending: Array<{ prefix: string; done: Promise<void> }> = [];
  for (const prefix of options.captureBeforeNavigate ?? []) {
    assertReadOnlyPath(prefix);
    const collected = session.cdp.collectResponses(prefix, options.captureTimeoutMs ?? 25_000);
    pending.push({
      prefix,
      done: collected.then((body) => {
        if (body !== null) captured.set(prefix, body);
      }).catch(() => undefined)
    });
  }
  await session.cdp.request('Page.navigate', { url: target }, 30_000);
  // 等页面自身完成首屏：document.readyState 到 complete 即可开始探测身份。
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const ready = await session.cdp.request('Runtime.evaluate', {
      expression: 'document.readyState',
      returnByValue: true
    }, 5_000).catch(() => null);
    const value = (ready as { result?: { value?: unknown } } | null)?.result?.value;
    if (value === 'complete') break;
    await delay(500);
  }
  // 等预置监听收口：给页面一点时间把首次请求发完（有上限，不无限等）。
  if (pending.length > 0) {
    await Promise.race([
      Promise.all(pending.map((p) => p.done)),
      delay(options.captureTimeoutMs ?? 25_000)
    ]);
  }
  // 等 URL 稳定：有些平台的"会话失效"不是 HTTP 重定向，而是页面加载完成后
  // 由 JS 异步跳到 /login（小红书实测：先到 /new/note-manager，
  // readyState 立刻变 complete，随后才跳 /login?redirectReason=401）。
  // 只在 readyState=complete 时取一次 URL，会把失效会话误判成已登录——
  // 表现为 availability=ready、failure_count=0，用户看不到"需要重新扫码"。
  const stableUrl = await waitForStableURL(session, target);
  const info = await session.cdp.request('Runtime.evaluate', {
    expression: 'JSON.stringify({ url: location.href, title: document.title })',
    returnByValue: true
  }, 5_000).catch(() => null);
  const raw = (info as { result?: { value?: unknown } } | null)?.result?.value;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as { url?: unknown; title?: unknown };
      return {
        // 稳定窗口内若发生过跳转，以跳转后的 URL 为准（它才是真实落点）。
        url: typeof parsed.url === 'string' ? parsed.url : stableUrl,
        title: typeof parsed.title === 'string' ? parsed.title : '',
        captured
      };
    } catch {
      // 落到下面的默认值。
    }
  }
  return { url: stableUrl, title: '', captured };
}

// waitForStableURL 观察一小段时间，等 JS 触发的跳转落定。
//
// 判定"稳定"的条件：连续两次采样（间隔 `pollMs`）URL 相同，且距上次变化
// 已超过 `quietMs`。整段最多等 `maxMs`，超时就用当前 URL——
// **不能无限等**：正常页面本来就不会变，等太久会拖慢每次采集。
//
// 返回最后的 URL；取不到时回退到 `fallback`。
async function waitForStableURL(
  session: PlatformLoginSession,
  fallback: string,
  options: { maxMs?: number; pollMs?: number; quietMs?: number } = {}
): Promise<string> {
  const maxMs = options.maxMs ?? 1_500;
  const pollMs = options.pollMs ?? 250;
  const quietMs = options.quietMs ?? 400;
  const startedAt = Date.now();
  let last = fallback;
  let lastChangedAt = startedAt;
  while (Date.now() - startedAt < maxMs) {
    await delay(pollMs);
    const info = await session.cdp.request('Runtime.evaluate', {
      expression: 'location.href',
      returnByValue: true
    }, 3_000).catch(() => null);
    const href = (info as { result?: { value?: unknown } } | null)?.result?.value;
    if (typeof href !== 'string' || href === '') continue;
    if (href !== last) {
      last = href;
      lastChangedAt = Date.now();
      continue;
    }
    // URL 与上次相同，且已经安静足够久：认为跳转结束。
    if (Date.now() - lastChangedAt >= quietMs) return last;
  }
  return last;
}

// probeIdentity 在页面内执行固定只读脚本，读回身份原文。
// 返回 loggedIn=false 表示还没登录或页面还没就绪，调用方继续轮询。
export async function probeIdentity(session: PlatformLoginSession): Promise<IdentityProbeResult> {
  const script = PLATFORM_IDENTITY_SCRIPTS[session.platform];
  if (!script) throw new PlatformBrowserError('platform_capability_denied', '当前平台的稳定身份读取尚未通过验证');
  assertReadOnlyScript(script, session.platform);
  const result = await session.cdp.request('Runtime.evaluate', {
    expression: script,
    awaitPromise: true,
    returnByValue: true
  }, 15_000).catch(() => null);
  return parseEvaluateResponse(result);
}

// waitForLogin 轮询直到读到身份或超时。超时不关浏览器，用户可重试而不重建会话。
export async function waitForLogin(
  session: PlatformLoginSession,
  options: { timeoutMs?: number; pollMs?: number; onTick?: (attempt: number) => void } = {}
): Promise<{ loggedIn: boolean; payload: string | null; attempts: number; timedOut: boolean }> {
  const timeoutMs = options.timeoutMs ?? PLATFORM_LOGIN_TIMEOUT_MS;
  const pollMs = options.pollMs ?? PLATFORM_LOGIN_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    options.onTick?.(attempts);
    const probe = await probeIdentity(session);
    if (probe.loggedIn && probe.payload) {
      return { loggedIn: true, payload: probe.payload, attempts, timedOut: false };
    }
    if (Date.now() >= deadline) {
      return { loggedIn: false, payload: null, attempts, timedOut: true };
    }
    await delay(pollMs);
  }
}

// delay 只用于轮询间隔。这里**不能** unref：unref 的定时器不会让事件循环保持存活，
// 在没有任何其它句柄时（例如测试环境）await 会永远挂起。
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
