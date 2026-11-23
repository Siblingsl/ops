// B-06：网络抓包预算与凭据脱敏（开发期工具，不进产品运行时）。
//
// 对齐 `docs/41-browse可借鉴实现清单.md` §6.1（browse `network/model.rs` /
// `network/redaction.rs`）。本模块只做数据模型与纯函数：
//   * 采集预算：1000 条 / 单 body 1 MiB / 总 body 25 MiB / 默认 30 分钟 / 并发 4；
//   * 名字匹配：auth/authorization/cookie/... 命中即替换；phone/mobile/email 等 PII 同样替换；
//   * 一次性字段：password/otp/pin 等任意长度替换；
//   * 值记忆：被洗掉的值在别处再次出现也替换，普通值仅 ≥8 字符才做子串替换；
//   * URL：query 按名字洗，path 段看起来像 token 才洗；
//   * body：JSON 递归、form 按表单、multipart 保留 filename 洗 secret part；
//     解析不了就整个丢弃并标 UNREDACTABLE。
//
// 不宣称：脱敏是尽力而为，不是数据边界；eval/console/页面文本/截图原样返回。

export const MAX_ENTRIES = 1000;
export const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_TOTAL_BODY_BYTES = 25 * 1024 * 1024;
export const DEFAULT_MAX_DURATION_MS = 30 * 60 * 1000;
export const FINALIZER_CONCURRENCY = 4;
export const MINIMUM_KNOWN_SUBSTRING_LENGTH = 8;
export const REDACTED = '[redacted]';
const SENTINEL = '__browse_redacted__';

const SECRET_NAME = /(^|[^a-z])(auth|authorization|cookie|credential|csrf|xsrf|token|secret|session|password|passwd|pwd|passcode|otp|code|api[_-]?key|access[_-]?key|refresh[_-]?key|signature|sig|phone|mobile|email)([^a-z]|$)/i;
const ONE_TIME_FIELD = /^(password|passwd|passcode|passphrase|pwd|otp|totp|mfa|2fa|verification[_-]?code|pin)$/i;

export type CaptureReason =
  | 'TOO_LARGE'
  | 'BUDGET_USED'
  | 'UNAVAILABLE'
  | 'UNSUPPORTED_ENCODING'
  | 'UNREDACTABLE';

export interface CaptureEntry {
  bodyBytes: number;
  durationMs: number;
}

export interface CaptureDecision {
  allowed: boolean;
  reason?: CaptureReason;
}

/** 采集预算：超限明确标注原因，不静默截断。 */
export class NetworkCaptureBudget {
  private entries = 0;
  private bodyBytes = 0;
  private elapsedMs = 0;
  private stopReason: CaptureReason | null = null;
  private finalizers = 0;

  constructor(
    readonly limits = {
      maxEntries: MAX_ENTRIES,
      maxBodyBytes: MAX_BODY_BYTES,
      maxTotalBodyBytes: MAX_TOTAL_BODY_BYTES,
      maxDurationMs: DEFAULT_MAX_DURATION_MS,
      concurrency: FINALIZER_CONCURRENCY,
    },
  ) {}

  consider(entry: CaptureEntry): CaptureDecision {
    if (this.stopReason) return { allowed: false, reason: this.stopReason };
    if (this.entries >= this.limits.maxEntries) return { allowed: false, reason: 'BUDGET_USED' };
    if (entry.bodyBytes > this.limits.maxBodyBytes) return { allowed: false, reason: 'TOO_LARGE' };
    if (this.bodyBytes + entry.bodyBytes > this.limits.maxTotalBodyBytes) return { allowed: false, reason: 'BUDGET_USED' };
    if (this.elapsedMs + entry.durationMs > this.limits.maxDurationMs) {
      this.stopReason = 'BUDGET_USED';
      return { allowed: false, reason: 'BUDGET_USED' };
    }
    this.entries += 1;
    this.bodyBytes += entry.bodyBytes;
    this.elapsedMs += Math.max(0, entry.durationMs);
    return { allowed: true };
  }

  beginFinalize(): boolean {
    if (this.finalizers >= this.limits.concurrency) return false;
    this.finalizers += 1;
    return true;
  }

  endFinalize(): void {
    this.finalizers = Math.max(0, this.finalizers - 1);
  }

  stop(reason: CaptureReason): void {
    this.stopReason = reason;
  }

  state(): { entries: number; bodyBytes: number; elapsedMs: number; finalizers: number; stopReason: CaptureReason | null } {
    return {
      entries: this.entries,
      bodyBytes: this.bodyBytes,
      elapsedMs: this.elapsedMs,
      finalizers: this.finalizers,
      stopReason: this.stopReason,
    };
  }
}

export interface RedactBodyResult {
  body: string;
  reason?: 'UNREDACTABLE';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function looksLikeTokenSegment(segment: string): boolean {
  if (segment.length < 20) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return false;
  // base64url 特征：同时出现数字与大小写字母，或长度 ≥ 32。
  return segment.length >= 32 || (/[0-9]/.test(segment) && /[A-Z]/.test(segment) && /[a-z]/.test(segment));
}

export class Redactor {
  private readonly known = new Set<string>();

  /** 名字命中则替换；一次性字段任意长度替换。 */
  redactField(name: string, value: string): string {
    const key = String(name || '');
    const text = String(value ?? '');
    if (SECRET_NAME.test(key) || ONE_TIME_FIELD.test(key)) {
      if (text.length >= MINIMUM_KNOWN_SUBSTRING_LENGTH || ONE_TIME_FIELD.test(key)) this.known.add(text);
      return REDACTED;
    }
    return this.redactKnown(text);
  }

  /** 值记忆：普通值 ≥8 字符才做子串替换。 */
  redactKnown(text: string): string {
    let out = String(text ?? '');
    for (const value of this.known) {
      if (value.length < MINIMUM_KNOWN_SUBSTRING_LENGTH) continue;
      out = out.split(value).join(REDACTED);
    }
    return out;
  }

  redactHeaders(headers: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
      const lower = name.toLowerCase();
      if (SECRET_NAME.test(lower)) {
        if (String(value).length >= MINIMUM_KNOWN_SUBSTRING_LENGTH) this.known.add(String(value));
        out[name] = REDACTED;
      } else {
        out[name] = this.redactKnown(String(value));
      }
    }
    return out;
  }

  redactUrl(raw: string): string {
    let url: URL;
    try {
      url = new URL(String(raw));
    } catch {
      return REDACTED;
    }
    url.hash = '';
    for (const key of Array.from(url.searchParams.keys())) {
      const values = url.searchParams.getAll(key);
      url.searchParams.delete(key);
      for (const value of values) url.searchParams.append(key, this.redactField(key, value));
    }
    const segments = url.pathname.split('/').map((segment) => (looksLikeTokenSegment(segment) ? REDACTED : this.redactKnown(segment)));
    url.pathname = segments.join('/');
    url.search = url.search.replaceAll(SENTINEL, REDACTED);
    return url.toString().replaceAll(SENTINEL, REDACTED);
  }

  redactJson(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => this.redactJson(item));
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (typeof item === 'string') out[key] = this.redactField(key, item);
        else if (SECRET_NAME.test(key)) {
          out[key] = REDACTED;
        } else out[key] = this.redactJson(item);
      }
      return out;
    }
    if (typeof value === 'string') return this.redactKnown(value);
    return value;
  }

  redactForm(body: string): string {
    const params = new URLSearchParams(body);
    const out = new URLSearchParams();
    for (const key of Array.from(params.keys())) {
      for (const value of params.getAll(key)) out.append(key, this.redactField(key, value));
    }
    return out.toString();
  }

  redactMultipart(body: string, boundary: string): RedactBodyResult {
    if (!boundary) return { body: '', reason: 'UNREDACTABLE' };
    const parts = body.split(`--${boundary}`);
    if (parts.length < 2) return { body: '', reason: 'UNREDACTABLE' };
    const rebuilt: string[] = [];
    for (const part of parts) {
      if (!part.trim() || part.trim() === '--') continue;
      const headerEnd = part.indexOf('\r\n\r\n') >= 0 ? part.indexOf('\r\n\r\n') : part.indexOf('\n\n');
      if (headerEnd < 0) return { body: '', reason: 'UNREDACTABLE' };
      const separatorLength = part.slice(headerEnd, headerEnd + 4) === '\r\n\r\n' ? 4 : 2;
      const headersText = part.slice(0, headerEnd);
      const content = part.slice(headerEnd + separatorLength);
      const nameMatch = /name="([^"]*)"/i.exec(headersText);
      const name = nameMatch ? nameMatch[1] : '';
      const kept = content.replace(/\r\n$|\n$/, '');
      const value = SECRET_NAME.test(name) || ONE_TIME_FIELD.test(name) ? REDACTED : this.redactKnown(kept);
      rebuilt.push(`${headersText}${part.slice(headerEnd, headerEnd + separatorLength)}${value}\r\n`);
    }
    return { body: rebuilt.map((p) => `--${boundary}\r\n${p}`).join('') + `--${boundary}--\r\n` };
  }

  redactBody(contentType: string, body: string): RedactBodyResult {
    const type = String(contentType || '').toLowerCase();
    try {
      if (type.includes('application/json')) {
        const parsed = JSON.parse(body);
        return { body: JSON.stringify(this.redactJson(parsed)) };
      }
      if (type.includes('application/x-www-form-urlencoded')) return { body: this.redactForm(body) };
      if (type.includes('multipart/form-data')) {
        const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
        return this.redactMultipart(body, boundary ? (boundary[1] || boundary[2] || '').trim() : '');
      }
      return { body };
    } catch {
      return { body: '', reason: 'UNREDACTABLE' };
    }
  }
}
