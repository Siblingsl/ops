import {
  app,
  safeStorage,
  utilityProcess,
  type Session,
  type UtilityProcess
} from 'electron';
import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { promises as fs } from 'node:fs';
import { isIP } from 'node:net';
import https from 'node:https';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import WebSocket from 'ws';
import {
  ManagementRequestRegistry,
  prepareDesktopRouteApplication,
  type AppliedDesktopRequestContext,
  type DesktopMode,
  type DesktopRouteSelection
} from './request-context';
import { channelReconnectDelayMs } from './reconnect-policy';
import { ChannelMixin } from './client/channel';
import { ModelsMixin } from './client/models';
import { PlatformMixin } from './client/platform';
import { ConfigMixin } from './client/config';
import { createPinnedDirectHttpsAgent, createPinnedHttpsProxyAgent, normalizeProxyUrl, parseSystemProxyResolution, type ProxyRoute } from './proxy';
import {
  PlatformCollectionUnsupportedError,
  parsePlatformCollectionCapability,
  resolvePlatformEndpoint,
  type PlatformCollectionCapability
} from './platform-capability';

const API_PREFIX = '/api/v1';
const PROTOCOL_VERSION = 1;
const PLATFORM_PROTOCOL_VERSION = 1;
const CHUNK_BYTES = 64 * 1024;
const REQUEST_WINDOW = 4 * CHUNK_BYTES;
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_RESPONSE_BYTES = 18 * 1024 * 1024;
const MAX_FETCHED_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_IMAGE_FETCH_BODY_BYTES = 8 * 1024;
const MAX_CONTROL_BYTES = 16 * 1024;
const MAX_WS_BUFFERED_BYTES = 1024 * 1024;
const MAX_COMPLETED_REQUEST_IDS = 64;
const CONTROL_RATE_PER_SECOND = 2048;
const CONTROL_BURST = 4096;
const DEADLINE_MATCH_TOLERANCE_MS = 2000;

interface ControlBudget {
  tokens: number;
  updatedAt: number;
}

export interface AuthInfo {
  csrf_token: string;
  user_id: string;
  username: string;
  reauth_ok: boolean;
  admin_override?: boolean;
  workspace: { id: string; name: string; role: string };
}

export interface StoredDevice {
  id: string;
  publicKey: string;
  encryptedPrivateKey: string;
}

export interface StoredModel {
  providerId: string;
  name: string;
  baseUrl: string;
  models: string[];
  endpointKind: 'loopback' | 'public';
  proxyMode?: 'system' | 'manual' | 'direct';
  proxyUrl?: string;
  configRevision: number;
  allowedImageHosts?: string[];
  encryptedApiKey?: string;
  encryptedProxyAuth?: string;
}

export interface StoredWorkspace {
  models: StoredModel[];
  appliedMode?: DesktopMode;
  appliedRouteRevision?: number;
  draftRoutes?: DesktopRoute[];
  draftRouteRevision?: number;
}

export interface StoredAccount {
  device?: StoredDevice;
  workspaces: Record<string, StoredWorkspace>;
}

export interface ConfigDocument {
  version: 1;
  accounts: Record<string, StoredAccount>;
}

export interface PublicModel {
  providerId: string;
  name: string;
  baseUrl: string;
  models: string[];
  allowedImageHosts: string[];
  endpointKind: 'loopback' | 'public';
  proxyMode: 'system' | 'manual' | 'direct';
  proxyUrl: string;
  configRevision: number;
  hasKey: boolean;
  keyMask: string;
  hasProxyAuth: boolean;
}

export interface SaveModelInput {
  providerId?: string;
  configRevision?: number;
  name: string;
  baseUrl: string;
  models: string[];
  apiKey: string;
  allowedImageHosts?: string[];
  proxyMode?: 'system' | 'manual' | 'direct';
  proxyUrl?: string;
  proxyUsername?: string;
  proxyPassword?: string;
}

/** D-123 / DEV-415：业务账号（客户端设置页只读最小字段）。 */
export interface BusinessAccount {
  id: string;
  platform: 'wechat_mp' | 'xhs' | 'toutiao';
  name: string;
  content_format: string;
  status: string;
  type_note?: string;
}

/** D-123 / DEV-415：更换内容类型的结果摘要。 */
export interface AccountTypeChangeResult {
  account: BusinessAccount;
  typeChange: Record<string, unknown>;
}

export interface ModelManifestEntry {
  id: string;
  models: string[];
  status: string;
  config_revision: number;
}

interface PendingRequest {
  id: string;
  providerId: string;
  model: string;
  configRevision: number;
  operation: 'chat_completions' | 'image_generations' | 'generated_image_fetch';
  bodyLength: number;
  deadlineMs: number;
  deadlineAt: number;
  openedAt: number;
  purpose: 'business' | 'self_test';
  generation: number;
  parentRequestId?: string;
  receivedBytes: number;
  nextRequestSequence: number;
  requestCredits: number;
  requestEnded: boolean;
  responseEnded: boolean;
  rejectedCode?: string;
  upstreamErrorCode?: 'credential_echo' | 'upstream_stream_failed';
  headersSent: boolean;
  responseCredits: number;
  nextResponseSequence: number;
  responseBytes: number;
  responseStatus?: number;
  responseContentType?: string;
  imageUrlReady?: boolean;
}

interface CompletedImageParent {
  providerId: string;
  model: string;
  configRevision: number;
  generation: number;
  purpose: 'business' | 'self_test';
  deadlineAt: number;
  expiresAt: number;
  timer: NodeJS.Timeout;
}

interface WorkerMessage {
  type: string;
  requestId?: string;
  data?: Uint8Array;
  status?: number;
  contentType?: string;
  retryAfter?: string;
  code?: string;
  count?: number;
  targetUrl?: string;
  proxy?: ProxyRoute;
}

interface WireMessage {
  type?: string;
  request_id?: string;
  parent_request_id?: string;
  provider_id?: string;
  model?: string;
  operation?: string;
  purpose?: string;
  config_revision?: number;
  route_revision?: number;
  generation?: number;
  protocol_version?: number;
  deadline_ms?: number;
  body_length?: number;
  sequence?: number;
  direction?: string;
  count?: number;
  error_code?: string;
}

interface PublicState {
  signedIn: boolean;
  username: string;
  workspaceName: string;
  reauthRequired: boolean;
  storageAvailable: boolean;
  localConfigAvailable: boolean;
  deviceRegistered: boolean | null;
  modelCount: number | null;
  activeModelRequests: number;
  channelState: 'disconnected' | 'connecting' | 'ready' | 'error';
  channelMessage: string;
  mode: DesktopMode;
  routeRevision: number;
  deviceId: string;
}

export interface PublicSystemInfo {
  version: string;
  dev: boolean;
  dataBytes: number;
}

export interface DesktopRoute {
  task_type: string;
  execution_location: 'desktop' | 'server' | 'disabled';
  provider_id: string | null;
  model: string;
  fallback_provider_id: string | null;
  fallback_model: string;
}

export interface DesktopRouteState {
  routes: DesktopRoute[];
  policy_revision: number;
  draft_routes?: DesktopRoute[];
  draft_revision?: number;
  has_draft?: boolean;
}

export interface DesktopPolicy {
  workspace_id: string;
  enabled: boolean;
  allow_member_endpoints: boolean;
  authorization_revision: number;
}

export interface DesktopDevice {
  id: string;
  name: string;
  platform: string;
  version: string;
  revoked_at: string | null;
  created_at: string;
  last_seen_at: string | null;
}

interface RequestRoutingState {
  mode: DesktopMode;
  requestContext: AppliedDesktopRequestContext;
}

export class DesktopClient extends ConfigMixin(PlatformMixin(ModelsMixin(ChannelMixin))) {
  requestRouting: RequestRoutingState = { mode: 'server', requestContext: {} };
  appliedRouteRevision = 0;

  constructor(
    readonly businessSession: Session,
    readonly apiOrigin: string,
    readonly serviceNamespace: string = apiOrigin
  ) {
    super();
  }

  async getPublicState(): Promise<PublicState> {
    let auth: AuthInfo | null = null;
    try {
      auth = await this.getAuthInfo();
    } catch {
      // Local settings must remain usable when the business session is offline.
    }

    let modelCount: number | null = 0;
    let deviceRegistered: boolean | null = false;
    let localConfigAvailable = true;
    let deviceId = '';
    if (auth) {
      try {
        const account = await this.getAccount(auth);
        deviceRegistered = Boolean(account.device);
        deviceId = account.device?.id ?? '';
        modelCount = account.workspaces[auth.workspace.id]?.models.length ?? 0;
      } catch {
        // Online identity and runtime mode must remain readable when only the local AI config is damaged.
        localConfigAvailable = false;
        deviceRegistered = null;
        modelCount = null;
      }
    }

    return {
      signedIn: Boolean(auth),
      username: auth?.username ?? '',
      workspaceName: auth?.workspace.name ?? '',
      reauthRequired: Boolean(auth && !auth.reauth_ok),
      storageAvailable: safeStorage.isEncryptionAvailable(),
      localConfigAvailable,
      deviceRegistered,
      modelCount,
      activeModelRequests: this.pending.size,
      channelState: this.channelState,
      channelMessage: this.channelMessage,
      mode: this.requestRouting.mode,
      routeRevision: this.appliedRouteRevision,
      deviceId
    };
  }

  getRequestRoutingState(): RequestRoutingState {
    return { mode: this.requestRouting.mode, requestContext: { ...this.requestRouting.requestContext } };
  }

  getActiveModelRequestCount(): number {
    return this.pending.size;
  }

  async getPublicSystemInfo(): Promise<PublicSystemInfo> {
    const info = await this.request<{ version: string; dev: boolean; data_bytes: number }>('/system/info');
    return { version: info.version, dev: info.dev, dataBytes: info.data_bytes };
  }


  async getPolicy(): Promise<{ globalEnabled: boolean; policy: DesktopPolicy }> {
    const result = await this.request<{ global_enabled: boolean; policy: DesktopPolicy }>('/desktop/policy');
    return { globalEnabled: result.global_enabled, policy: result.policy };
  }

  async updatePolicy(enabled: boolean, allowMemberEndpoints: boolean): Promise<DesktopPolicy> {
    const auth = await this.getAuthInfo();
    return this.request<DesktopPolicy>('/desktop/policy', {
      method: 'PUT',
      headers: { 'X-CSRF-Token': auth.csrf_token },
      body: JSON.stringify({ enabled, allow_member_endpoints: allowMemberEndpoints })
    });
  }

  async listDevices(): Promise<{ devices: DesktopDevice[]; reauthRequired: boolean }> {
    const result = await this.request<{ devices: DesktopDevice[]; reauth_ok: boolean }>('/desktop/devices');
    return { devices: result.devices, reauthRequired: !result.reauth_ok };
  }

  async revokeDevice(deviceId: string, password: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(deviceId) || password.length > 1024) throw new Error('设备回收输入无效。');
    const deviceState = await this.request<{ csrf_token: string }>('/desktop/devices');
    await this.request(`/desktop/devices/${encodeURIComponent(deviceId)}`, {
      method: 'DELETE',
      headers: { 'X-CSRF-Token': deviceState.csrf_token },
      ...(password ? { body: JSON.stringify({ password }) } : {})
    });

    const config = await this.loadConfig();
    let changed = false;
    for (const account of Object.values(config.accounts)) {
      if (account.device?.id === deviceId) {
        delete account.device;
        changed = true;
      }
    }
    if (changed) await this.saveConfig();
  }

  /** D-123 / DEV-415：读取业务账号，供客户端设置页更换内容类型。 */
  async listBusinessAccounts(): Promise<BusinessAccount[]> {
    const auth = await this.getAuthInfo();
    const rows = await this.request<BusinessAccount[]>('/accounts', {
      headers: { 'X-CSRF-Token': auth.csrf_token }
    });
    return Array.isArray(rows) ? rows : [];
  }

  /** D-123 / DEV-415：账号下未删除作品数，用于确认弹窗的影响说明。 */
  async countBusinessWorks(accountId: string): Promise<number> {
    const auth = await this.getAuthInfo();
    const rows = await this.request<{ id: string }[]>(`/accounts/${encodeURIComponent(accountId.trim())}/works`, {
      headers: { 'X-CSRF-Token': auth.csrf_token }
    });
    return Array.isArray(rows) ? rows.length : 0;
  }

  /**
   * D-123 / DEV-415：同平台内更换账号内容类型。服务端要求显式确认；
   * 已有作品按作品级快照保持原类型，新建作品使用新类型。
   */
  async changeAccountContentFormat(input: { accountId: string; contentFormat: string }): Promise<AccountTypeChangeResult> {
    const accountId = input.accountId.trim();
    const contentFormat = input.contentFormat.trim();
    if (!accountId) throw new Error('请先选择要更换类型的账号。');
    if (!contentFormat) throw new Error('请先选择新的内容类型。');
    const auth = await this.getAuthInfo();
    const res = await this.request<BusinessAccount & { account?: BusinessAccount; type_change?: Record<string, unknown> }>(
      `/accounts/${encodeURIComponent(accountId)}`,
      {
        method: 'PATCH',
        headers: { 'X-CSRF-Token': auth.csrf_token },
        body: JSON.stringify({ content_format: contentFormat, confirm_type_change: true })
      }
    );
    // 服务端只在类型确实变化时返回 {account, type_change}；竞态下（例如他人已改为同类型）
    // 返回裸账号对象，此时按「无变化」处理，避免把正常响应误判为失败。
    const account = res?.account ?? res;
    if (!account?.id) throw new Error('服务端未返回更新后的账号，请刷新后重试。');
    return { account, typeChange: res?.type_change ?? {} };
  }

  async reauthenticate(password: string): Promise<void> {
    if (!password) throw new Error('请输入当前账号密码。');
    const auth = await this.getAuthInfo();
    await this.request('/auth/reauth', {
      method: 'POST',
      headers: { 'X-CSRF-Token': auth.csrf_token },
      body: JSON.stringify({ password })
    });
  }

  async getCurrentAccountIdentity(): Promise<{ userId: string; username: string }> {
    const auth = await this.getAuthInfo();
    return { userId: auth.user_id, username: auth.username };
  }

  // 命令执行器的写请求由主进程发起，没有页面里的 CSRF 注入；这里按当前会话补一次。
  private async commandMutationHeaders(): Promise<Record<string, string>> {
    try {
      const auth = await this.getAuthInfo();
      return auth.csrf_token ? { 'X-CSRF-Token': auth.csrf_token } : {};
    } catch {
      return {};
    }
  }

  // A30b 片 2（拍板：账本存载荷+同步等待）：浏览器命令执行器的服务端三步——
  // 领取 pending（含载荷）、CAS 派发（claimed=true 才执行）、回执（含 result）。
  // 类型结构与 browser-executor.ts 的 BrowserCommandRow 同构（分层各自声明）。
  async listPendingBrowserCommands(): Promise<{ commands: Array<{ id: string; action_kind: string; deadline_at?: string; claimed?: boolean; payload?: unknown; [key: string]: unknown }> }> {
    return await this.request('/agent/browser/commands/pending');
  }

  async dispatchBrowserCommand(id: string): Promise<{ id: string; action_kind: string; deadline_at?: string; claimed?: boolean; payload?: unknown; [key: string]: unknown }> {
    return await this.request(`/agent/browser/commands/${encodeURIComponent(id)}/dispatch`, {
      method: 'POST',
      headers: await this.commandMutationHeaders(),
      body: '{}'
    });
  }

  async receiptBrowserCommand(id: string, body: { state: string; error_code?: string; result?: unknown }): Promise<Record<string, unknown>> {
    return await this.request(`/agent/browser/commands/${encodeURIComponent(id)}/receipt`, {
      method: 'POST',
      headers: await this.commandMutationHeaders(),
      body: JSON.stringify(body)
    });
  }

  // DEV-CU P4-11 收口：电脑命令执行器的服务端三步（pending → CAS dispatch → receipt）。
  // 与 browser 同构；载荷里只有 ref/text，不含归属（grant 由命令行携带）。
  async listPendingComputerCommands(): Promise<{ commands: Array<{ id: string; action_kind: string; grant_id?: string; generation?: number; deadline_at?: string; claimed?: boolean; payload?: unknown; [key: string]: unknown }> }> {
    return await this.request('/agent/computer/commands/pending');
  }

  async dispatchComputerCommand(id: string): Promise<{ id: string; action_kind: string; grant_id?: string; generation?: number; deadline_at?: string; claimed?: boolean; payload?: unknown; [key: string]: unknown }> {
    return await this.request(`/agent/computer/commands/${encodeURIComponent(id)}/dispatch`, {
      method: 'POST',
      headers: await this.commandMutationHeaders(),
      body: '{}'
    });
  }

  async receiptComputerCommand(id: string, body: { state: string; error_code?: string; result?: unknown; disposition?: unknown }): Promise<Record<string, unknown>> {
    return await this.request(`/agent/computer/commands/${encodeURIComponent(id)}/receipt`, {
      method: 'POST',
      headers: await this.commandMutationHeaders(),
      body: JSON.stringify(body)
    });
  }

  async clearCurrentAccountData(expectedUserId: string): Promise<void> {
    const auth = await this.getAuthInfo();
    if (auth.user_id !== expectedUserId) throw new Error('当前登录账号已变化，请刷新设置后重试。');
    this.disconnect();
    const config = await this.loadConfig();
    const accountKey = `${this.serviceNamespace}\n${auth.user_id}`;
    const storedAccount = config.accounts[accountKey];
    delete config.accounts[accountKey];
    try {
      await this.saveConfig();
    } catch {
      if (storedAccount) config.accounts[accountKey] = storedAccount;
      throw new Error('本机账号配置未能删除。请检查磁盘空间和用户目录权限后重试。');
    }

    this.requestRouting = { mode: 'server', requestContext: {} };
    this.appliedRouteRevision = 0;
  }



  protected async ensureDevice(auth: AuthInfo, account: StoredAccount, accountKey: string, signal?: AbortSignal): Promise<StoredDevice> {
    if (account.device) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密存储不可用，无法读取本机设备密钥。');
      this.decrypt(account.device.encryptedPrivateKey);
      return account.device;
    }
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密存储不可用，不能注册并持久化设备密钥。');
    if (!auth.reauth_ok) throw new Error('请先在本窗口完成密码重新认证，再创建本机设备。');

    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const publicJwk = publicKey.export({ format: 'jwk' });
    if (typeof publicJwk.x !== 'string') throw new Error('无法生成设备公钥。');
    const rawPublicKey = Buffer.from(publicJwk.x, 'base64url');
    const publicKeyBase64 = rawPublicKey.toString('base64');
    const device: StoredDevice = {
      id: randomUUID(),
      publicKey: publicKeyBase64,
      encryptedPrivateKey: safeStorage.encryptString(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()).toString('base64')
    };
    const body = {
      id: device.id,
      public_key: publicKeyBase64,
      name: 'OPS Desktop',
      platform: 'windows-x64',
      version: app.getVersion()
    };
    await this.signedRequest(
      auth, device, 'device.register', 'POST', '/desktop/devices', body, publicKeyBase64, {}, signal
    );
    if (signal?.aborted) throw signal.reason ?? new Error('桌面通道连接已取消。');
    account.device = device;
    await this.saveConfig();
    return device;
  }

  protected async signedRequest<T = unknown>(
    auth: AuthInfo,
    device: StoredDevice,
    operation: string,
    method: string,
    pathName: string,
    bodyValue: unknown,
    publicKey?: string,
    extraHeaders: Record<string, string> = {},
    signal?: AbortSignal,
    purpose?: string
  ): Promise<T> {
    const body = JSON.stringify(bodyValue);
    const requestPath = `${API_PREFIX}${pathName}`;
    const challenge = await this.request<{ challenge_id: string; signature_payload: string }>(
      '/desktop/challenges', {
        method: 'POST',
        headers: { 'X-CSRF-Token': auth.csrf_token },
        ...(signal ? { signal } : {}),
        body: JSON.stringify({
          device_id: device.id,
          operation,
          method,
          path: requestPath,
          body_sha256: createHash('sha256').update(body).digest('hex'),
          ...(publicKey ? { public_key: publicKey } : {}),
          ...(purpose ? { purpose } : {})
        })
      }
    );
    if (signal?.aborted) throw signal.reason ?? new Error('桌面通道连接已取消。');
    const privateKey = createPrivateKey(this.decrypt(device.encryptedPrivateKey));
    const signature = sign(null, Buffer.from(challenge.signature_payload, 'base64'), privateKey).toString('base64');
    return this.request<T>(pathName, {
      method,
      headers: {
        'X-CSRF-Token': auth.csrf_token,
        'X-OPS-Desktop-Device': device.id,
        'X-OPS-Desktop-Challenge': challenge.challenge_id,
        'X-OPS-Desktop-Signature': signature,
        ...extraHeaders
      },
      ...(signal ? { signal } : {}),
      body
    });
  }

}

function safeError(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 300);
  return '操作失败，请检查网络和本地设置。';
}

function isPositiveInt(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isDesktopOperation(value: unknown): value is PendingRequest['operation'] {
  return value === 'chat_completions' || value === 'image_generations' || value === 'generated_image_fetch';
}

// stableUuid 从任意稳定字符串派生一个固定的 UUIDv5 形状标识。
// 用途仅限本机 profile 目录命名空间：同一输入永远得到同一目录，不含任何凭据。
function stableUuid(input: string): string {
  const hex = createHash('sha256').update(input).digest('hex');
  const variant = ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

function normalizeUuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    return '';
  }
  return value.toLowerCase();
}

function bytesToUuid(bytes: Buffer): string {
  if (bytes.length !== 16) return '';
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function asBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}

function allowedErrorCode(value: unknown): string {
  return ['offline', 'unauthorized', 'timeout', 'redirect', 'protocol'].includes(String(value))
    ? String(value)
    : 'offline';
}

function allowedContentType(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 200) return null;
  const mediaType = value.split(';', 1)[0].trim().toLowerCase();
  if (mediaType === 'application/json' || mediaType === 'text/event-stream'
    || mediaType === 'application/octet-stream' || mediaType.startsWith('image/')) return value;
  return null;
}

function isJsonContentType(value: string | undefined): boolean {
  return typeof value === 'string' && value.split(';', 1)[0].trim().toLowerCase() === 'application/json';
}

function validRetryAfter(value: unknown): value is string {
  return typeof value === 'string' && /^\d{1,5}$/.test(value);
}
