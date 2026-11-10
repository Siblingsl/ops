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

export class DesktopClient extends ModelsMixin(ChannelMixin) {
  readonly configPath = path.join(app.getPath('userData'), 'desktop-config.json');
  configPromise: Promise<ConfigDocument> | null = null;
  private readonly managementRequests: ManagementRequestRegistry;
  requestRouting: RequestRoutingState = { mode: 'server', requestContext: {} };
  appliedRouteRevision = 0;

  constructor(
    readonly businessSession: Session,
    readonly apiOrigin: string,
    readonly serviceNamespace: string = apiOrigin
  ) {
    super();
    this.managementRequests = new ManagementRequestRegistry(apiOrigin);
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

  consumeManagementRequestMarker(marker: string, requestUrl: string, method: string): boolean {
    return this.managementRequests.consume(marker, requestUrl, method);
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

  // A30b 片 2（拍板：账本存载荷+同步等待）：浏览器命令执行器的服务端三步——
  // 领取 pending（含载荷）、CAS 派发（claimed=true 才执行）、回执（含 result）。
  // 类型结构与 browser-executor.ts 的 BrowserCommandRow 同构（分层各自声明）。
  async listPendingBrowserCommands(): Promise<{ commands: Array<{ id: string; action_kind: string; deadline_at?: string; claimed?: boolean; payload?: unknown; [key: string]: unknown }> }> {
    return await this.request('/agent/browser/commands/pending');
  }

  async dispatchBrowserCommand(id: string): Promise<{ id: string; action_kind: string; deadline_at?: string; claimed?: boolean; payload?: unknown; [key: string]: unknown }> {
    return await this.request(`/agent/browser/commands/${encodeURIComponent(id)}/dispatch`, {
      method: 'POST',
      body: '{}'
    });
  }

  async receiptBrowserCommand(id: string, body: { state: string; error_code?: string; result?: unknown }): Promise<Record<string, unknown>> {
    return await this.request(`/agent/browser/commands/${encodeURIComponent(id)}/receipt`, {
      method: 'POST',
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

  // 平台采集能力（D-129）：旧服务器没有 platform_collection 字段时抛 PlatformCollectionUnsupportedError，
  // 调用方据此显示“不支持”，不得改调 AI 端点。
  async getPlatformCollectionCapability(): Promise<PlatformCollectionCapability> {
    const payload = await this.request<Record<string, unknown>>('/desktop/capabilities');
    return parsePlatformCollectionCapability(payload, PLATFORM_PROTOCOL_VERSION);
  }

  // 以 platform.device.register 登记同一台设备。它只按平台采集策略授权，
  // 不改变桌面 AI 策略，也不复用 AI 设备登记路径。
  async ensurePlatformDevice(): Promise<StoredDevice> {
    const capability = await this.getPlatformCollectionCapability();
    if (!capability.enabled) {
      throw new PlatformCollectionUnsupportedError('服务端尚未启用平台数据采集。');
    }
    const endpoint = resolvePlatformEndpoint(capability, 'platform.device.register');
    const auth = await this.getAuthInfo();
    const { account, accountKey } = await this.getWorkspace(auth);
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
    const publicKeyBase64 = Buffer.from(publicJwk.x, 'base64url').toString('base64');
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
      version: app.getVersion(),
      purpose: capability.purpose
    };
    await this.signedRequest(
      auth, device, 'platform.device.register', endpoint.method,
      endpoint.path.slice(API_PREFIX.length), body, publicKeyBase64, {}, undefined, capability.purpose
    );
    account.device = device;
    await this.saveConfig();
    return device;
  }

  // getAuthContext 给本机平台登录用：只暴露启动隔离 profile 所需的最小标识，
  // 不含 Cookie、token 或设备私钥。
  async getAuthContext(): Promise<{
    userId: string;
    workspaceId: string;
    deviceId: string;
    connectionNamespaceId: string;
  }> {
    const auth = await this.getAuthInfo();
    const device = await this.ensurePlatformDevice();
    return {
      userId: auth.user_id,
      workspaceId: auth.workspace.id,
      deviceId: device.id,
      // 登录会话的 profile 命名空间：按「用户 + 设备」稳定派生，
      // 保证同一用户在同一台设备上重复登录复用同一目录，换设备则隔离。
      connectionNamespaceId: stableUuid(`${auth.user_id}\n${device.id}`)
    };
  }

  // getPlatformConnectionSummary 取本人持有的连接摘要（含 external_account_key）。
  // 走 platform.connection.mine.list：账户级只读，不要求工作区策略开启。
  async getPlatformConnectionSummary(connectionId: string): Promise<Record<string, unknown> | null> {
    const capability = await this.getPlatformCollectionCapability();
    const endpoint = resolvePlatformEndpoint(capability, 'platform.connection.mine.list');
    const device = await this.ensurePlatformDevice();
    const auth = await this.getAuthInfo();
    const payload = await this.platformSignedRequest<{ connections?: unknown }>(
      auth, device, 'platform.connection.mine.list', endpoint.method,
      endpoint.path.slice(API_PREFIX.length), {}
    );
    const list = Array.isArray(payload?.connections) ? payload.connections : [];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      // 服务端把 UUID 序列化成字符串，但这里仍按字符串比较，避免类型差异导致匹配失败。
      const id = String((item as { id?: unknown }).id ?? '');
      if (id.toLowerCase() === connectionId.toLowerCase()) {
        return item as Record<string, unknown>;
      }
    }
    return null;
  }

  // platformSignedCall 给平台采集协议客户端用：按操作名取端点、完成设备证明、发请求。
  // 只接受 PLATFORM_OPERATION_PATHS 里登记的操作，不接受任意路径。
  async platformSignedCall(operation: string, method: string, pathName: string, body: unknown, extraHeaders: Record<string, string> = {}): Promise<unknown> {
    const device = await this.ensurePlatformDevice();
    const auth = await this.getAuthInfo();
    return this.platformSignedRequest<unknown>(auth, device, operation, method, pathName, body, extraHeaders);
  }

  async requestPlatformAccountSync(input: { accountId: string; mode: 'incremental' | 'full_reconcile'; connectionRevision: number; idempotencyKey: string }): Promise<Record<string, unknown>> {
    const capability = await this.getPlatformCollectionCapability();
    const endpoint = resolvePlatformEndpoint(capability, 'platform.account.sync.request');
    return await this.platformSignedCall('platform.account.sync.request', endpoint.method,
      endpoint.path.replace('{accountId}', encodeURIComponent(input.accountId)), {
        mode: input.mode,
        expected_connection_revision: input.connectionRevision
      }, { 'Idempotency-Key': input.idempotencyKey }) as Record<string, unknown>;
  }

  async requestPlatformMetricsRefresh(input: { accountId: string; connectionRevision: number; idempotencyKey: string; platformWorkIds?: string[] }): Promise<Record<string, unknown>> {
    const capability = await this.getPlatformCollectionCapability();
    const endpoint = resolvePlatformEndpoint(capability, 'platform.metrics.refresh.request');
    return await this.platformSignedCall('platform.metrics.refresh.request', endpoint.method,
      endpoint.path.replace('{accountId}', encodeURIComponent(input.accountId)), {
        target_scope: input.platformWorkIds?.length ? 'explicit' : 'due_and_recent',
        platform_work_ids: input.platformWorkIds ?? [],
        work_ids: [],
        expected_connection_revision: input.connectionRevision
      }, { 'Idempotency-Key': input.idempotencyKey }) as Record<string, unknown>;
  }

  async resumePlatformSyncOperation(input: { accountId: string; operationId: string; expectedOperationRevision: number }): Promise<Record<string, unknown>> {
    const capability = await this.getPlatformCollectionCapability();
    const endpoint = resolvePlatformEndpoint(capability, 'platform.sync.operation.resume');
    const pathName = endpoint.path
      .replace('{accountId}', encodeURIComponent(input.accountId))
      .replace('{operationId}', encodeURIComponent(input.operationId));
    return await this.platformSignedCall('platform.sync.operation.resume', endpoint.method, pathName, {
      action: 'resume',
      expected_operation_revision: input.expectedOperationRevision
    }) as Record<string, unknown>;
  }

  // createPlatformConnection 为某个 OPS 账号建立待验证连接（20 文档 §11.2）。
  // 一次只建一个；已存在未撤销连接时服务端返回 409，这里原样上抛。
  async createPlatformConnection(input: {
    accountId: string;
    externalAccountKey: string;
    consentVersion: number;
  }): Promise<Record<string, unknown>> {
    const capability = await this.getPlatformCollectionCapability();
    const endpoint = resolvePlatformEndpoint(capability, 'platform.connection.create');
    const device = await this.ensurePlatformDevice();
    const auth = await this.getAuthInfo();
    return this.platformSignedRequest<Record<string, unknown>>(
      auth, device, 'platform.connection.create', endpoint.method,
      endpoint.path.slice(API_PREFIX.length),
      {
        account_id: input.accountId,
        external_account_key: input.externalAccountKey,
        platform_consent_version: input.consentVersion
      }
    );
  }

  // verifyPlatformConnection 绑定真实平台身份与能力快照（20 文档 §11.2）。
  // 身份冲突由服务端返回 409，不在这里重试或覆盖。
  async verifyPlatformConnection(input: {
    connectionId: string;
    externalAccountKey: string;
    capabilities: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const capability = await this.getPlatformCollectionCapability();
    const endpoint = resolvePlatformEndpoint(capability, 'platform.connection.verify');
    const device = await this.ensurePlatformDevice();
    const auth = await this.getAuthInfo();
    return this.platformSignedRequest<Record<string, unknown>>(
      auth, device, 'platform.connection.verify', endpoint.method,
      endpoint.path.slice(API_PREFIX.length).replace('{id}', encodeURIComponent(input.connectionId)),
      { external_account_key: input.externalAccountKey, capabilities: input.capabilities }
    );
  }

  // presence 上报设备在线（20 文档 §5.2）：服务端 presenceTTL 90 秒，
  // 客户端必须每 30 秒发一次，否则调度时设备被判离线、空闲连接永远等不到任务。
  async presence(): Promise<void> {
    const capability = await this.getPlatformCollectionCapability();
    const endpoint = resolvePlatformEndpoint(capability, 'platform.presence');
    const device = await this.ensurePlatformDevice();
    const auth = await this.getAuthInfo();
    await this.platformSignedRequest<unknown>(
      auth, device, 'platform.presence', endpoint.method,
      endpoint.path.slice(API_PREFIX.length), {}
    );
  }

  // listPlatformConnections 取本人持有的全部连接摘要（账户级只读，不要求工作区策略）。
  async listPlatformConnections(): Promise<Array<Record<string, unknown>>> {
    const capability = await this.getPlatformCollectionCapability();
    const endpoint = resolvePlatformEndpoint(capability, 'platform.connection.mine.list');
    const device = await this.ensurePlatformDevice();
    const auth = await this.getAuthInfo();
    const payload = await this.platformSignedRequest<{ connections?: unknown }>(
      auth, device, 'platform.connection.mine.list', endpoint.method,
      endpoint.path.slice(API_PREFIX.length), {}
    );
    return Array.isArray(payload?.connections)
      ? payload.connections.filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
      : [];
  }

  // revokePlatformConnection 本人回收连接（只减权，不需要工作区策略）。
  // 服务端成功后才允许清理本机 profile：先减权、再删本地凭据，顺序不能反。
  async revokePlatformConnection(connectionId: string): Promise<Record<string, unknown>> {
    const capability = await this.getPlatformCollectionCapability();
    const endpoint = resolvePlatformEndpoint(capability, 'platform.connection.mine.revoke');
    const device = await this.ensurePlatformDevice();
    const auth = await this.getAuthInfo();
    return this.platformSignedRequest<Record<string, unknown>>(
      auth, device, 'platform.connection.mine.revoke', endpoint.method,
      endpoint.path.slice(API_PREFIX.length).replace('{id}', encodeURIComponent(connectionId)),
      {}
    );
  }

  // platformSignedRequest 复用同一套设备证明：挑战 → 签名 → 带证明头请求。
  // 平台端点不传 purpose（只有登记类操作需要）。
  private async platformSignedRequest<T>(
    auth: AuthInfo,
    device: StoredDevice,
    operation: string,
    method: string,
    pathName: string,
    bodyValue: unknown,
    extraHeaders: Record<string, string> = {}
  ): Promise<T> {
    // GET/HEAD 不能带 body（fetch 会直接抛错）。挑战里的 body_sha256 必须与真正发出的
    // body 一致，否则服务端验签会失败；因此这里对 GET/HEAD 用空串的摘要。
    const hasBody = method !== 'GET' && method !== 'HEAD';
    const body = hasBody ? JSON.stringify(bodyValue) : '';
    // 调用方有两种传法：`PlatformClient` 给的是带 /api/v1 的全路径，
    // `createPlatformConnection` 等给的是去掉前缀的相对路径。两种都要接受，
    // 否则会拼成 /api/v1/api/v1/...，服务端按未登记路径回“设备证明操作不受支持”。
    const relative = pathName.startsWith(API_PREFIX) ? pathName.slice(API_PREFIX.length) : pathName;
    const requestPath = `${API_PREFIX}${relative}`;
    const challenge = await this.request<{ challenge_id: string; signature_payload: string }>(
      '/desktop/challenges', {
        method: 'POST',
        headers: { 'X-CSRF-Token': auth.csrf_token },
        body: JSON.stringify({
          device_id: device.id,
          operation,
          method,
          path: requestPath,
          body_sha256: createHash('sha256').update(body).digest('hex')
        })
      }
    );
    const privateKey = createPrivateKey(this.decrypt(device.encryptedPrivateKey));
    const signature = sign(null, Buffer.from(challenge.signature_payload, 'base64'), privateKey).toString('base64');
    // request() 内部会拼 API_PREFIX，这里必须传相对路径，否则会变成 /api/v1/api/v1/...
    // GET/HEAD 不能带 body（fetch 会直接抛错）；挑战里的 body_sha256 已是空串的摘要，
    // 与服务端按空 body 计算的结果一致。
    return this.request<T>(relative, {
      method,
      headers: {
        'X-CSRF-Token': auth.csrf_token,
        'X-OPS-Desktop-Device': device.id,
        'X-OPS-Desktop-Challenge': challenge.challenge_id,
        'X-OPS-Desktop-Signature': signature,
        ...extraHeaders
      },
      ...(hasBody ? { body } : {})
    });
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

  protected async getAuthInfo(signal?: AbortSignal): Promise<AuthInfo> {
    return this.request<AuthInfo>('/auth/me', signal ? { signal } : {});
  }

  protected async getWorkspace(auth: AuthInfo): Promise<{
    account: StoredAccount;
    workspace: StoredWorkspace;
    accountKey: string;
  }> {
    const config = await this.loadConfig();
    const accountKey = `${this.serviceNamespace}\n${auth.user_id}`;
    const account = config.accounts[accountKey] ?? { workspaces: {} };
    account.workspaces[auth.workspace.id] ??= { models: [] };
    config.accounts[accountKey] = account;
    return { account, workspace: account.workspaces[auth.workspace.id], accountKey };
  }

  private async getAccount(auth: AuthInfo): Promise<StoredAccount> {
    return (await this.getWorkspace(auth)).account;
  }

  protected async request<T>(pathName: string, init: RequestInit = {}): Promise<T> {
    const url = new URL(`${API_PREFIX}${pathName}`, this.apiOrigin).toString();
    const headers = new Headers(init.headers);
    let hasDesktopProof = false;
    headers.forEach((_value, name) => {
      if (name.toLowerCase().startsWith('x-ops-desktop-')) hasDesktopProof = true;
    });
    const marker = hasDesktopProof ? this.managementRequests.issue(url, init.method ?? 'GET') : '';
    if (marker) headers.set('X-OPS-Desktop-Management-Request', marker);
    headers.set('Accept', 'application/json');
    if (init.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const timeoutSignal = AbortSignal.timeout(10_000);
    const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
    try {
      const response = await this.businessSession.fetch(url, {
        ...init,
        headers,
        credentials: 'include',
        redirect: 'error',
        cache: 'no-store',
        signal
      });
      const payload = await response.json().catch(() => null) as unknown;
      if (!response.ok) throw new Error(apiErrorMessage(payload, response.status));
      return payload as T;
    } finally {
      if (marker) this.managementRequests.discard(marker);
    }
  }

  protected async loadConfig(): Promise<ConfigDocument> {
    if (!this.configPromise) {
      this.configPromise = fs.readFile(this.configPath, 'utf8')
        .then((content) => JSON.parse(content) as ConfigDocument)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return { version: 1, accounts: {} };
          throw new Error('本机设置文件无法读取。');
        });
    }
    return this.configPromise;
  }

  protected async saveConfig(): Promise<void> {
    const config = await this.loadConfig();
    const tempPath = `${this.configPath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(config), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tempPath, this.configPath);
  }

  protected decrypt(encrypted: string): string {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密存储不可用。');
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
    } catch {
      throw new Error('本机密钥无法解密；请重新配置该密钥。');
    }
  }
}



function apiErrorMessage(payload: unknown, status: number): string {
  if (payload && typeof payload === 'object' && 'error' in payload) {
    const error = (payload as { error?: { message?: unknown; code?: unknown } }).error;
    if (error && typeof error.message === 'string') return error.message.slice(0, 300);
  }
  return `线上服务请求失败（HTTP ${status}）。`;
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
