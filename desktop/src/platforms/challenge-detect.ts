// 41 §3 / B-03：风控页识别与分类（纯函数 + 固定探针脚本）。
//
// 设计边界（与 41 §0.2、docs/07 一致）：
//   * 只识别与分类，不自动解题、不点击挑战、不调用打码服务、不绕过风控；
//   * 分类错误的方向必须偏向「交人」（interactive）而不是「自动通过」；
//   * 通用文案只在短页面上生效，避免一篇正文含 "captcha" 的文章被误判成验证码；
//   * 探针只读页面状态，不修改 DOM、不挂全局、不发请求。
//
// 输出直接可进日志与 UI：vendor / kind / signal（截断 160）/ waitedMs / recommendation。

export type ChallengeVendor =
  | 'none'
  | 'cloudflare'
  | 'perimeterx'
  | 'datadome'
  | 'akamai'
  | 'imperva'
  | 'awswaf'
  | 'hcaptcha'
  | 'recaptcha'
  | 'unknown';

export type ChallengeKind = 'none' | 'non-interactive' | 'interactive' | 'block';

export interface ChallengeProbe {
  url: string;
  title: string;
  text: string;
  textLength: number;
  frameUrls: string[];
  scriptSrcs: string[];
  /** 命中的探针选择器（未命中不出现）。 */
  selectors: string[];
  /** 命中且可见的探针选择器（getBoundingClientRect + offsetParent）。 */
  visibleSelectors: string[];
}

export interface ChallengeOutcome {
  vendor: ChallengeVendor;
  kind: ChallengeKind;
  signal: string;
  status: 'clear' | 'wait' | 'handoff' | 'stop';
  url: string;
  waitedMs: number;
  recommendation: 'continue' | 'wait' | 'handoff' | 'stop';
}

// 41 §3.1 的原样选择器清单。新增/删除必须同步 41 与 fixture 用例。
export const PROBE_SELECTORS: ReadonlyArray<string> = Object.freeze([
  '#challenge-form',
  '#challenge-running',
  '#challenge-stage',
  '#cf-challenge-running',
  '.cf-turnstile',
  '#cf-error-details',
  '#sec-if-cpt-container',
  '#sec-cpt-if',
  '#sec-text-if',
  '#ddv1-captcha-container',
  '#px-captcha',
  '#px-captcha-wrapper',
  "[id^='px-captcha']",
  "#main-iframe[src*='_Incapsula_Resource']",
  '#captcha-container awswaf-captcha',
  'awswaf-captcha',
  '#challenge-container',
  '.g-recaptcha',
  "iframe[src*='/recaptcha/'][title*='challenge']",
  '.h-captcha'
]);

export const CHALLENGE_SHORT_TEXT_LENGTH = 1500;
export const CHALLENGE_SIGNAL_MAX = 160;
export const DEFAULT_CHALLENGE_WAIT_MS = 15_000;
export const DEFAULT_CHALLENGE_POLL_MS = 3_000;

// 页面侧固定探针脚本：常量，不接受外部输入，不读表单、不改 DOM。
// Runtime.evaluate / chrome.scripting 都可直接用；返回对象可 JSON 序列化。
export const CHALLENGE_PROBE_SCRIPT = `(() => {
  const SELECTORS = ${JSON.stringify(PROBE_SELECTORS)};
  const present = [];
  const visible = [];
  for (const selector of SELECTORS) {
    let nodes = null;
    try { nodes = document.querySelectorAll(selector); } catch (error) { nodes = null; }
    if (!nodes || nodes.length === 0) continue;
    present.push(selector);
    for (const el of nodes) {
      try {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && el.offsetParent !== null) { visible.push(selector); break; }
      } catch (error) { /* 单个节点异常不影响其它选择器 */ }
    }
  }
  const frameUrls = [];
  for (const frame of document.querySelectorAll('iframe, frame')) {
    const src = frame.getAttribute('src') || '';
    if (src) frameUrls.push(src.slice(0, 200));
  }
  const scriptSrcs = [];
  for (const script of document.querySelectorAll('script[src]')) {
    const src = script.getAttribute('src') || '';
    if (src) scriptSrcs.push(String(src).slice(0, 200));
  }
  const body = document.body;
  const text = body ? String(body.innerText || '').slice(0, 4000) : '';
  const textLength = body ? String(body.innerText || '').length : 0;
  return {
    url: location.href,
    title: document.title || '',
    text,
    textLength,
    frameUrls,
    scriptSrcs,
    selectors: present,
    visibleSelectors: visible
  };
})()`;

const SIGNAL_MAX = CHALLENGE_SIGNAL_MAX;
const SHORT = CHALLENGE_SHORT_TEXT_LENGTH;

function clip(text: string): string {
  return String(text || '').slice(0, SIGNAL_MAX);
}

function includesAny(value: string, needles: ReadonlyArray<string>): boolean {
  const lower = value.toLowerCase();
  return needles.some((needle) => lower.includes(needle.toLowerCase()));
}

function matchesTitle(title: string, patterns: ReadonlyArray<RegExp>): boolean {
  return patterns.some((pattern) => pattern.test(title));
}

/** 把扩展/页面探针原始结果规范化为 ChallengeProbe；非法输入返回 null。 */
export function buildChallengeProbe(input: unknown): ChallengeProbe | null {
  if (!input) return null;
  const raw = typeof input === 'string' ? safeJson(input) : input;
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const text = typeof obj.text === 'string' ? obj.text : '';
  const strings = (value: unknown): string[] => (Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map((item) => item.slice(0, 200))
    : []);
  const textLength = typeof obj.textLength === 'number' && Number.isFinite(obj.textLength)
    ? Math.max(0, Math.floor(obj.textLength))
    : text.length;
  return {
    url: typeof obj.url === 'string' ? obj.url.slice(0, 2048) : '',
    title: typeof obj.title === 'string' ? obj.title.slice(0, 300) : '',
    text,
    textLength,
    frameUrls: strings(obj.frameUrls),
    scriptSrcs: strings(obj.scriptSrcs),
    selectors: strings(obj.selectors),
    visibleSelectors: strings(obj.visibleSelectors)
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function outcome(
  probe: ChallengeProbe,
  vendor: ChallengeVendor,
  kind: ChallengeKind,
  signal: string,
  waitedMs = 0
): ChallengeOutcome {
  const status: ChallengeOutcome['status'] = kind === 'none'
    ? 'clear'
    : kind === 'block'
      ? 'stop'
      : kind === 'interactive'
        ? 'handoff'
        : 'wait';
  const recommendation: ChallengeOutcome['recommendation'] = kind === 'none'
    ? 'continue'
    : kind === 'block'
      ? 'stop'
      : kind === 'interactive'
        ? 'handoff'
        : 'wait';
  return { vendor, kind, signal: clip(signal), status, url: probe.url, waitedMs, recommendation };
}

// classifyChallenge 是纯函数：无网络、无 DOM、无随机；同一 Probe 必得同一结论。
// 判定顺序：block > 厂商 interactive > 厂商 non-interactive > 通用短页文案 > none。
export function classifyChallenge(probe: ChallengeProbe): ChallengeOutcome {
  const title = probe.title || '';
  const text = probe.text || '';
  const short = probe.textLength < SHORT;
  const has = (selector: string): boolean => probe.selectors.includes(selector);
  const visible = (selector: string): boolean => probe.visibleSelectors.includes(selector);
  const frameHas = (needle: string): boolean => probe.frameUrls.some((url) => url.toLowerCase().includes(needle.toLowerCase()));
  const scriptHas = (needle: string): boolean => probe.scriptSrcs.some((url) => url.toLowerCase().includes(needle.toLowerCase()));

  // ---- Cloudflare block（明确拒绝访问）----
  if (includesAny(text, ['sorry, you have been blocked'])
    && (has('#cf-error-details') || includesAny(text, ['cloudflare']))) {
    return outcome(probe, 'cloudflare', 'block', 'cloudflare block: sorry, you have been blocked');
  }

  // ---- Cloudflare challenge（过渡页 / Turnstile）----
  const cloudflareTitle = matchesTitle(title, [
    /just a moment/i,
    /attention required!?\s*\|\s*cloudflare/i,
    /checking your browser/i
  ]);
  const cloudflareSelector = ['#challenge-form', '#challenge-running', '#challenge-stage', '#cf-challenge-running']
    .some((selector) => has(selector));
  const cloudflareFrame = short && frameHas('challenges.cloudflare.com');
  if (cloudflareTitle || cloudflareSelector || cloudflareFrame || has('.cf-turnstile')) {
    if (visible('.cf-turnstile') || includesAny(text, ['verify you are human'])) {
      return outcome(probe, 'cloudflare', 'interactive', 'cloudflare interactive: turnstile / verify you are human');
    }
    return outcome(probe, 'cloudflare', 'non-interactive', 'cloudflare transition page');
  }

  // ---- PerimeterX / HUMAN ----
  if (has('#px-captcha') || has('#px-captcha-wrapper') || has("[id^='px-captcha']") || includesAny(text, ['press & hold'])) {
    return outcome(probe, 'perimeterx', 'interactive', 'perimeterx: px-captcha / press & hold');
  }

  // ---- DataDome ----
  if (frameHas('captcha-delivery.com') || has('#ddv1-captcha-container')) {
    return outcome(probe, 'datadome', 'interactive', 'datadome: captcha-delivery frame');
  }
  const urlPath = safePath(probe.url);
  if (urlPath.includes('/interstitial/')) {
    return outcome(probe, 'datadome', 'non-interactive', 'datadome interstitial');
  }

  // ---- Akamai ----
  if (matchesTitle(title, [/access denied/i]) && includesAny(text, ['reference #'])) {
    return outcome(probe, 'akamai', 'block', 'akamai: access denied + reference #');
  }
  if (has('#sec-if-cpt-container') || has('#sec-cpt-if') || has('#sec-text-if')) {
    return outcome(probe, 'akamai', 'interactive', 'akamai: sec-if-cpt container');
  }

  // ---- Imperva ----
  if (frameHas('_incapsula_resource') || scriptHas('_incapsula_resource') || has("#main-iframe[src*='_Incapsula_Resource']")) {
    return outcome(probe, 'imperva', 'interactive', 'imperva: incapsula resource');
  }
  if (short && includesAny(text, ['incapsula incident id'])) {
    return outcome(probe, 'imperva', 'block', 'imperva: incapsula incident id');
  }

  // ---- AWS WAF ----
  if (has('awswaf-captcha') || has('#captcha-container awswaf-captcha')) {
    return outcome(probe, 'awswaf', 'interactive', 'aws waf: awswaf-captcha');
  }
  if (scriptHas('.awswaf.com/') && short) {
    return outcome(probe, 'awswaf', 'non-interactive', 'aws waf: awswaf script on short page');
  }

  // ---- hCaptcha / reCAPTCHA（必须短页面 + 墙文案，避免普通登录页误判）----
  const wallText = includesAny(text, ['verify you are human', 'verify you are a human', 'i am not a robot', "i'm not a robot", 'unusual traffic', 'captcha', 'security check']);
  if (frameHas('hcaptcha.com/captcha/') && short && wallText) {
    return outcome(probe, 'hcaptcha', 'interactive', 'hcaptcha: captcha frame + short page wall text');
  }
  if (frameHas('google.com/recaptcha') && frameHas('/anchor') && short && wallText) {
    return outcome(probe, 'recaptcha', 'interactive', 'recaptcha: anchor frame + short page wall text');
  }

  // ---- 通用文案（只在短页面生效）----
  if (short && includesAny(text, ['unusual traffic', 'verify you are human', 'complete the security check', 'please verify you are a human'])) {
    return outcome(probe, 'unknown', 'interactive', 'generic short-page challenge copy');
  }

  return outcome(probe, 'none', 'none', '', 0);
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return String(url || '').toLowerCase();
  }
}

/** 分类结论 → 适配器错误码。block 停采；interactive / 未消退的 non-interactive 交人。 */
export function challengeErrorCode(outcomeValue: ChallengeOutcome): 'platform_blocked' | 'platform_challenge_required' | null {
  if (outcomeValue.kind === 'block') return 'platform_blocked';
  if (outcomeValue.kind === 'interactive' || outcomeValue.kind === 'non-interactive') return 'platform_challenge_required';
  return null;
}

/** 分类结论的可读错误信息（不含页面敏感正文，只含脱敏 URL 与截断信号）。 */
export function challengeErrorMessage(outcomeValue: ChallengeOutcome): string {
  return `平台风控页拦截（${outcomeValue.vendor}/${outcomeValue.kind}）：${outcomeValue.signal || '页面结构与正常后台不一致'}`;
}

// ChallengeStopError 与适配器错误同构：只带 platform_* 错误码，调用方的统一错误投影可直接识别。
export class ChallengeStopError extends Error {
  readonly code: 'platform_blocked' | 'platform_challenge_required';
  readonly vendor: ChallengeVendor;
  readonly kind: ChallengeKind;
  readonly signal: string;
  readonly recommendation: ChallengeOutcome['recommendation'];
  constructor(value: ChallengeOutcome) {
    const code = challengeErrorCode(value) ?? 'platform_challenge_required';
    super(challengeErrorMessage(value));
    this.name = 'ChallengeStopError';
    this.code = code;
    this.vendor = value.vendor;
    this.kind = value.kind;
    this.signal = value.signal;
    this.recommendation = value.recommendation;
  }
}

export interface ChallengeProbeSource {
  probeChallenge?: () => Promise<unknown>;
  requestHandoff?: (value: ChallengeOutcome) => Promise<unknown>;
}

export interface ChallengeGuardOptions {
  waitMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function readProbe(source: ChallengeProbeSource): Promise<ChallengeProbe | null> {
  if (!source.probeChallenge) return null;
  try {
    return buildChallengeProbe(await source.probeChallenge());
  } catch {
    // 探针失败不阻断正常采集：无法证明有风控时不误停，交给后续解析失败兜底。
    return null;
  }
}

/** 等待风控页自行消退（non-interactive 过渡页），带上限。返回最后一次结论。 */
export async function waitForChallengeClear(
  source: ChallengeProbeSource,
  options: ChallengeGuardOptions = {}
): Promise<ChallengeOutcome | null> {
  const waitMs = Math.max(0, options.waitMs ?? DEFAULT_CHALLENGE_WAIT_MS);
  const pollMs = Math.max(100, options.pollMs ?? DEFAULT_CHALLENGE_POLL_MS);
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const startedAt = now();
  let last: ChallengeOutcome | null = null;
  for (;;) {
    const probe = await readProbe(source);
    if (!probe) return last;
    last = classifyChallenge(probe);
    last = { ...last, waitedMs: now() - startedAt };
    if (last.kind === 'none' || last.kind === 'block') return last;
    if (now() - startedAt >= waitMs) return last;
    await sleep(Math.min(pollMs, Math.max(100, waitMs - (now() - startedAt))));
  }
}

/**
 * collect 入口的风控闸门：
 *   none → 继续；non-interactive → 有上限地等；interactive → 交人（B-01 handoff，不自动解）；
 *   block → 直接停采（platform_blocked）。
 * 没有探针能力的响应源直接放行（不影响既有平台链路）。
 */
export async function ensureNoChallenge(
  source: ChallengeProbeSource,
  options: ChallengeGuardOptions = {}
): Promise<ChallengeOutcome | null> {
  const first = await readProbe(source);
  if (!first) return null;
  const initial = classifyChallenge(first);
  if (initial.kind === 'none') return initial;
  if (initial.kind === 'block') throw new ChallengeStopError(initial);
  if (initial.kind === 'non-interactive') {
    const settled = await waitForChallengeClear(source, options);
    if (settled && settled.kind === 'none') return settled;
    throw new ChallengeStopError(settled ?? initial);
  }
  // interactive：先交人（requestHandoff 只等待人操作，不自动点击/解题），再复核一次。
  if (source.requestHandoff) {
    try { await source.requestHandoff(initial); } catch { /* 交人失败按未通过处理 */ }
  }
  const settled = await waitForChallengeClear(source, options);
  if (settled && settled.kind === 'none') return settled;
  throw new ChallengeStopError(settled ?? initial);
}
