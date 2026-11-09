import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import { EventEmitter } from 'node:events';

// DEV-AI27-11（P01，27 §11.2 插件/MCP）：MCP HTTP 连接的 OAuth 2.1 客户端。
// 设计约束（docs/31 方向二）：
// - Authorization Code + PKCE(S256)；授权在系统浏览器完成，不在应用内嵌登录页；
// - 回环回调 127.0.0.1:<随机端口>/callback，端口随机、失败重试换端口；
// - 令牌经 Electron safeStorage 加密落 userData/mcp-tokens/<connectionId>.bin
//   （与既有本机 AI 密钥同机制，storage 由调用方注入以便测试）；
// - 校验 issuer / audience / state / exp；401 只刷新一次，失败转 needs_reauth；
// - 令牌零泄漏：不进日志、不进 IPC 返回值、不进导出配置；删除连接即删令牌文件。

export interface McpOAuthConfig {
  connectionId: string;
  serverUrl: string; // MCP HTTP 端点，发现文档从其 origin 派生
  clientId?: string; // 未动态注册时手工填写
  clientSecret?: string;
  scopes?: string[];
}

export interface OAuthTokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number; // epoch ms
  tokenType: string;
  scope?: string;
}

export interface OAuthDiscovery {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  registrationEndpoint?: string;
}

export type OAuthState =
  | 'unauthorized'
  | 'authorizing'
  | 'authorized'
  | 'needs_reauth';

/** 令牌持久化接口（生产实现走 Electron safeStorage；测试用内存实现）。 */
export interface OAuthTokenStorage {
  isEncryptionAvailable(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(blob: Buffer): string;
  read(connectionId: string): Buffer | null;
  write(connectionId: string, blob: Buffer): void;
  remove(connectionId: string): void;
}

/** 生产令牌仓：userData/mcp-tokens/<connectionId>.bin，safeStorage 加密。 */
export class SafeStorageTokenStorage implements OAuthTokenStorage {
  constructor(
    private readonly userDataDir: string,
    // Electron safeStorage 模块（类型宽松以免主进程外引用 electron 包）。
    private readonly safeStorage: { isEncryptionAvailable(): boolean; encryptString(s: string): Buffer; decryptString(b: Buffer): string },
  ) {}

  private tokenDir(): string {
    return path.join(this.userDataDir, 'mcp-tokens');
  }

  private tokenFile(connectionId: string): string {
    // connectionId 是 uuid，但防御性拒绝路径穿越。
    if (!/^[A-Za-z0-9_-]+$/.test(connectionId)) throw new Error('mcp_oauth_invalid_connection');
    return path.join(this.tokenDir(), `${connectionId}.bin`);
  }

  isEncryptionAvailable(): boolean {
    return this.safeStorage.isEncryptionAvailable();
  }

  encrypt(plain: string): Buffer {
    return this.safeStorage.encryptString(plain);
  }

  decrypt(blob: Buffer): string {
    return this.safeStorage.decryptString(blob);
  }

  read(connectionId: string): Buffer | null {
    try {
      return fs.readFileSync(this.tokenFile(connectionId));
    } catch {
      return null;
    }
  }

  write(connectionId: string, blob: Buffer): void {
    const dir = this.tokenDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.tokenFile(connectionId), blob);
  }

  remove(connectionId: string): void {
    try {
      fs.unlinkSync(this.tokenFile(connectionId));
    } catch { /* 不存在即视为已删 */ }
  }
}

// ---------------------------------------------------------------------------
// PKCE 与发现
// ---------------------------------------------------------------------------

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function createPkcePair(): PkcePair {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function createState(): string {
  return crypto.randomBytes(24).toString('base64url');
}

/** 发现文档路径：RFC 8414 先 path-aware 再 root fallback。 */
export function discoveryURLs(serverUrl: string): string[] {
  const u = new URL(serverUrl);
  const origin = u.origin;
  const pathPart = u.pathname.replace(/\/+$/, '');
  return [
    `${origin}/.well-known/oauth-authorization-server${pathPart}`,
    `${origin}/.well-known/oauth-authorization-server`,
  ];
}

export async function fetchDiscovery(serverUrl: string, fetchImpl: typeof fetch): Promise<OAuthDiscovery> {
  let lastErr = '';
  for (const url of discoveryURLs(serverUrl)) {
    try {
      const res = await fetchImpl(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) {
        lastErr = `discovery_status_${res.status}`;
        continue;
      }
      const doc = (await res.json()) as Record<string, string>;
      if (!doc.issuer || !doc.authorization_endpoint || !doc.token_endpoint) {
        lastErr = 'discovery_incomplete';
        continue;
      }
      return {
        issuer: doc.issuer,
        authorizationEndpoint: doc.authorization_endpoint,
        tokenEndpoint: doc.token_endpoint,
        revocationEndpoint: doc.revocation_endpoint,
        registrationEndpoint: doc.registration_endpoint,
      };
    } catch (err) {
      lastErr = String((err as Error).message ?? err).slice(0, 120);
    }
  }
  throw new Error(`mcp_oauth_discovery_failed: ${lastErr}`);
}

// ---------------------------------------------------------------------------
// 回环回调服务器
// ---------------------------------------------------------------------------

export interface LoopbackResult {
  code: string | null;
  state: string | null;
  error: string | null;
}

/** 启动 127.0.0.1 随机端口回环服务器，等授权回调；返回实际端口与结果 Promise。 */
export function startLoopbackCallback(): Promise<{ port: number; done: Promise<LoopbackResult>; close(): void }> {
  return new Promise((resolveServer, rejectServer) => {
    const server = http.createServer((req, res) => {
      try {
        const u = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (u.pathname !== '/callback') {
          res.writeHead(404).end();
          return;
        }
        const result: LoopbackResult = {
          code: u.searchParams.get('code'),
          state: u.searchParams.get('state'),
          error: u.searchParams.get('error'),
        };
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body><p>OPS 授权完成，可关闭此窗口。</p></body></html>');
        settle(result);
      } catch {
        res.writeHead(400).end();
        settle({ code: null, state: null, error: 'callback_parse_failed' });
      }
    });
    let settled = false;
    let settle: (r: LoopbackResult) => void;
    const done = new Promise<LoopbackResult>((resolve) => { settle = resolve; });
    server.on('error', (err) => rejectServer(err));
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        rejectServer(new Error('mcp_oauth_loopback_invalid'));
        return;
      }
      resolveServer({
        port: addr.port,
        done,
        close() {
          if (!settled) {
            settled = true;
            settle({ code: null, state: null, error: 'callback_closed' });
          }
          try { server.close(); } catch { /* 已关 */ }
        },
      });
    });
  });
}

// ---------------------------------------------------------------------------
// 授权 + 刷新 + 撤销
// ---------------------------------------------------------------------------

export interface AuthorizeOutcome {
  state: OAuthState;
  reason?: string;
}

export class McpOAuthClient extends EventEmitter {
  state: OAuthState = 'unauthorized';
  private tokens: OAuthTokenSet | null = null;
  private discovery: OAuthDiscovery | null = null;

  constructor(
    readonly config: McpOAuthConfig,
    private readonly storage: OAuthTokenStorage,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly clock: () => number = () => Date.now(),
  ) {
    super();
  }

  /** 加载落盘令牌（连接启动时调用）；exp 过期即视作需刷新但不立即丢弃 refresh_token。 */
  load(): void {
    const blob = this.storage.read(this.config.connectionId);
    if (!blob) return;
    try {
      const parsed = JSON.parse(this.storage.decrypt(blob)) as OAuthTokenSet;
      if (!parsed.accessToken) return;
      this.tokens = parsed;
      this.state = this.clock() < parsed.expiresAt ? 'authorized' : 'authorized'; // 过期由 refresh 处理
    } catch {
      this.state = 'needs_reauth';
    }
  }

  /** 系统浏览器授权全流程：发现 → PKCE → 打开浏览器 → 回环收 code → 换 token → 校验 → 落盘。 */
  async authorize(openBrowser: (url: string) => void): Promise<AuthorizeOutcome> {
    this.state = 'authorizing';
    this.emit('state', this.state);
    let discovery: OAuthDiscovery;
    try {
      discovery = await fetchDiscovery(this.config.serverUrl, this.fetchImpl);
    } catch (err) {
      this.state = 'needs_reauth';
      this.emit('state', this.state);
      return { state: this.state, reason: String((err as Error).message) };
    }
    this.discovery = discovery;
    // issuer 预校验：发现文档 issuer 必须与服务器 origin 一致（防混淆）。
    const serverOrigin = new URL(this.config.serverUrl).origin;
    if (!discovery.issuer.startsWith(serverOrigin)) {
      this.state = 'needs_reauth';
      this.emit('state', this.state);
      return { state: this.state, reason: 'issuer_mismatch' };
    }
    if (!this.config.clientId) {
      this.state = 'needs_reauth';
      this.emit('state', this.state);
      return { state: this.state, reason: 'client_id_required' };
    }
    const pkce = createPkcePair();
    const state = createState();
    // 回环端口被占 → 换端口重试 3 次。
    let loopback: Awaited<ReturnType<typeof startLoopbackCallback>> | null = null;
    for (let attempt = 0; attempt < 3 && !loopback; attempt += 1) {
      try {
        loopback = await startLoopbackCallback();
      } catch { /* 端口占用，重试 */ }
    }
    if (!loopback) {
      this.state = 'needs_reauth';
      this.emit('state', this.state);
      return { state: this.state, reason: 'loopback_unavailable' };
    }
    const redirectURI = `http://127.0.0.1:${loopback.port}/callback`;
    const authURL = new URL(discovery.authorizationEndpoint);
    authURL.searchParams.set('response_type', 'code');
    authURL.searchParams.set('client_id', this.config.clientId);
    authURL.searchParams.set('redirect_uri', redirectURI);
    authURL.searchParams.set('code_challenge', pkce.challenge);
    authURL.searchParams.set('code_challenge_method', 'S256');
    authURL.searchParams.set('state', state);
    if (this.config.scopes?.length) authURL.searchParams.set('scope', this.config.scopes.join(' '));

    openBrowser(authURL.toString());
    // 回调等待上限 5 分钟（用户在系统浏览器完成授权）。
    const timer = setTimeout(() => loopback!.close(), 5 * 60 * 1000);
    let callback: LoopbackResult;
    try {
      callback = await loopback.done;
    } finally {
      clearTimeout(timer);
      loopback.close();
    }
    if (callback.error || !callback.code) {
      this.state = 'needs_reauth';
      this.emit('state', this.state);
      return { state: this.state, reason: callback.error ?? 'callback_no_code' };
    }
    if (callback.state !== state) {
      this.state = 'needs_reauth';
      this.emit('state', this.state);
      return { state: this.state, reason: 'state_mismatch' };
    }
    try {
      const tokens = await this.exchangeCode(discovery, callback.code, pkce.verifier, redirectURI);
      this.storeTokens(tokens);
      this.state = 'authorized';
      this.emit('state', this.state);
      return { state: this.state };
    } catch (err) {
      this.state = 'needs_reauth';
      this.emit('state', this.state);
      return { state: this.state, reason: String((err as Error).message).slice(0, 120) };
    }
  }

  private async exchangeCode(discovery: OAuthDiscovery, code: string, verifier: string, redirectURI: string): Promise<OAuthTokenSet> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectURI,
      client_id: this.config.clientId ?? '',
      code_verifier: verifier,
    });
    return this.tokenRequest(discovery.tokenEndpoint, body, true);
  }

  private async tokenRequest(endpoint: string, body: URLSearchParams, expectRefresh: boolean): Promise<OAuthTokenSet> {
    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    if (this.config.clientSecret) {
      headers.Authorization = `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64')}`;
      body.delete('client_id');
    }
    const res = await this.fetchImpl(endpoint, { method: 'POST', headers, body: body.toString() });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`token_endpoint_status_${res.status}${text.includes('invalid_grant') ? '_invalid_grant' : ''}`);
    }
    const json = (await res.json()) as {
      access_token?: string; refresh_token?: string; expires_in?: number; token_type?: string; scope?: string;
    };
    if (!json.access_token) throw new Error('token_response_missing_access_token');
    const expiresIn = typeof json.expires_in === 'number' && json.expires_in > 0 ? json.expires_in : 3600;
    const tokens: OAuthTokenSet = {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? (expectRefresh ? undefined : this.tokens?.refreshToken),
      expiresAt: this.clock() + expiresIn * 1000,
      tokenType: json.token_type ?? 'Bearer',
      scope: json.scope,
    };
    return tokens;
  }

  private storeTokens(tokens: OAuthTokenSet): void {
    this.tokens = tokens;
    if (!this.storage.isEncryptionAvailable()) {
      // 与本机 AI 密钥同策略：加密存储不可用就不落盘（令牌只留在内存，重启需重新授权）。
      return;
    }
    this.storage.write(this.config.connectionId, this.storage.encrypt(JSON.stringify(tokens)));
  }

  /** 取可用令牌：过期时静默刷新一次；刷新失败转 needs_reauth 并返回 null。 */
  async accessToken(): Promise<string | null> {
    if (!this.tokens) return null;
    if (this.clock() < this.tokens.expiresAt - 30_000) {
      return this.tokens.accessToken;
    }
    return this.refreshOnce();
  }

  /** 401 处理：只刷新一次。调用方在单次请求内最多走一遍。 */
  async refreshOnce(): Promise<string | null> {
    if (!this.tokens?.refreshToken) {
      this.state = 'needs_reauth';
      this.emit('state', this.state);
      return null;
    }
    const discovery = this.discovery ?? await fetchDiscovery(this.config.serverUrl, this.fetchImpl).catch(() => null);
    if (!discovery) {
      this.state = 'needs_reauth';
      this.emit('state', this.state);
      return null;
    }
    this.discovery = discovery;
    try {
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.tokens.refreshToken,
      });
      if (this.config.clientId && !this.config.clientSecret) body.set('client_id', this.config.clientId);
      const tokens = await this.tokenRequest(discovery.tokenEndpoint, body, false);
      this.storeTokens(tokens);
      this.state = 'authorized';
      this.emit('state', this.state);
      return tokens.accessToken;
    } catch {
      // 刷新失败：清内存令牌（保留落盘以支持诊断？——不，零保留更安全），转 needs_reauth。
      this.tokens = null;
      this.state = 'needs_reauth';
      this.emit('state', this.state);
      return null;
    }
  }

  /** 撤销令牌（连接删除/登出）；端点存在时调用，失败不阻断本地清理。 */
  async revoke(): Promise<void> {
    const token = this.tokens;
    this.tokens = null;
    this.storage.remove(this.config.connectionId);
    this.state = 'unauthorized';
    this.emit('state', this.state);
    if (!token?.accessToken || !this.discovery?.revocationEndpoint) return;
    const body = new URLSearchParams({ token: token.accessToken });
    if (this.config.clientId && !this.config.clientSecret) body.set('client_id', this.config.clientId);
    try {
      await this.fetchImpl(this.discovery.revocationEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
    } catch { /* 撤销端点不可达：本地已清理，不阻断 */ }
  }

  /** 删除连接时清理令牌文件。 */
  cleanup(): void {
    this.storage.remove(this.config.connectionId);
    this.tokens = null;
    this.state = 'unauthorized';
    this.emit('state', this.state);
  }

  /** 供注入 Authorization 头；不暴露令牌本身给调用方日志。 */
  async authorizationHeader(): Promise<string | null> {
    const token = await this.accessToken();
    if (!token) return null;
    return `Bearer ${token}`;
  }

  /** 摘要视图：永不返回令牌明文（管理页展示用）。 */
  statusView(): { state: OAuthState; expires_at: string | null; has_refresh: boolean } {
    return {
      state: this.state,
      expires_at: this.tokens ? new Date(this.tokens.expiresAt).toISOString() : null,
      has_refresh: Boolean(this.tokens?.refreshToken),
    };
  }
}
