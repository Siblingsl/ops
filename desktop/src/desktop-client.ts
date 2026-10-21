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

interface AuthInfo {
  csrf_token: string;
  user_id: string;
  username: string;
  reauth_ok: boolean;
  admin_override?: boolean;
  workspace: { id: string; name: string; role: string };
}

interface StoredDevice {
  id: string;
  publicKey: string;
  encryptedPrivateKey: string;
}

interface StoredModel {
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

interface StoredWorkspace {
  models: StoredModel[];
  appliedMode?: DesktopMode;
  appliedRouteRevision?: number;
  draftRoutes?: DesktopRoute[];
  draftRouteRevision?: number;
}

interface StoredAccount {
  device?: StoredDevice;
  workspaces: Record<string, StoredWorkspace>;
}

interface ConfigDocument {
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

interface ModelManifestEntry {
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
  deviceRegistered: boolean;
  modelCount: number;
  activeModelRequests: number;
  channelState: 'disconnected' | 'connecting' | 'ready' | 'error';
  channelMessage: string;
  mode: DesktopMode;
  routeRevision: number;
  deviceId: string;
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

export class DesktopClient {
  private readonly configPath = path.join(app.getPath('userData'), 'desktop-config.json');
  private configPromise: Promise<ConfigDocument> | null = null;
  private readonly managementRequests: ManagementRequestRegistry;
  private worker: UtilityProcess | null = null;
  private socket: WebSocket | null = null;
  private channelState: PublicState['channelState'] = 'disconnected';
  private channelMessage = '通道尚未连接';
  private connectedUserId: string | null = null;
  private connectedWorkspaceId: string | null = null;
  private connectingAbort: AbortController | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastHeartbeatAck = 0;
  private generation = 0;
  private requestRouting: RequestRoutingState = { mode: 'server', requestContext: {} };
  private appliedRouteRevision = 0;
  private activeModels = new Map<string, StoredModel>();
  private pending = new Map<string, PendingRequest>();
  private completedRequestIds = new Set<string>();
  private imageParents = new Map<string, CompletedImageParent>();
  private pendingReady: ((error?: Error) => void) | null = null;
  private pendingReadyTimer: NodeJS.Timeout | null = null;
  private readonly sentControlBudget: ControlBudget = { tokens: CONTROL_BURST, updatedAt: performance.now() };
  private readonly receivedControlBudget: ControlBudget = { tokens: CONTROL_BURST, updatedAt: performance.now() };

  constructor(
    private readonly businessSession: Session,
    private readonly businessOrigin: string
  ) {
    this.managementRequests = new ManagementRequestRegistry(businessOrigin);
  }

  async getPublicState(): Promise<PublicState> {
    let auth: AuthInfo | null = null;
    try {
      auth = await this.getAuthInfo();
    } catch {
      // Local settings must remain usable when the business session is offline.
    }

    let modelCount = 0;
    let deviceRegistered = false;
    let deviceId = '';
    if (auth) {
      const account = await this.getAccount(auth);
      deviceRegistered = Boolean(account.device);
      deviceId = account.device?.id ?? '';
      modelCount = account.workspaces[auth.workspace.id]?.models.length ?? 0;
    }

    return {
      signedIn: Boolean(auth),
      username: auth?.username ?? '',
      workspaceName: auth?.workspace.name ?? '',
      reauthRequired: Boolean(auth && !auth.reauth_ok),
      storageAvailable: safeStorage.isEncryptionAvailable(),
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

  async listDesktopRoutes(): Promise<DesktopRouteState> {
    const auth = await this.getAuthInfo();
    const { account, workspace, accountKey } = await this.getWorkspace(auth);
    const device = await this.ensureDevice(auth, account, accountKey);
    const state = await this.request<DesktopRouteState>('/desktop/routes', {
      headers: { 'X-OPS-Desktop-Device': device.id }
    });
    return {
      ...state,
      draft_routes: workspace.draftRoutes ?? state.routes,
      draft_revision: workspace.draftRouteRevision ?? state.policy_revision,
      has_draft: Boolean(workspace.draftRoutes)
    };
  }

  async listRouteTypes(): Promise<Array<{ task_type: string; label: string }>> {
    const routes = await this.request<Array<{ task_type: string; label: string }>>('/model-routes');
    return routes;
  }

  async listServerModels(): Promise<Array<{ id: string; name: string; models: string[]; status: string }>> {
    return this.request('/model-providers');
  }

  async saveDesktopRoutes(routes: DesktopRoute[], expectedRevision: number): Promise<DesktopRouteState> {
    const auth = await this.getAuthInfo();
    const { account, workspace } = await this.getWorkspace(auth);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error('任务映射版本无效。');
    workspace.draftRoutes = routes;
    workspace.draftRouteRevision = expectedRevision;
    account.workspaces[auth.workspace.id] = workspace;
    await this.saveConfig();
    return {
      routes,
      policy_revision: expectedRevision,
      draft_routes: routes,
      draft_revision: expectedRevision,
      has_draft: true
    };
  }

  async startModelTest(providerId: string, model: string): Promise<{ test_id: string; status: string; stage: string }> {
    const auth = await this.getAuthInfo();
    const { account, accountKey } = await this.getWorkspace(auth);
    const device = await this.ensureDevice(auth, account, accountKey);
    return this.signedRequest<{ test_id: string; status: string; stage: string }>(
      auth, device, 'model.test', 'POST', `/desktop/models/${encodeURIComponent(providerId)}/test`, { model }
    );
  }

  async getModelTest(testId: string): Promise<Record<string, unknown>> {
    const auth = await this.getAuthInfo();
    const { account, accountKey } = await this.getWorkspace(auth);
    const device = await this.ensureDevice(auth, account, accountKey);
    return this.request(`/desktop/model-tests/${encodeURIComponent(testId)}`, {
      headers: { 'X-OPS-Desktop-Device': device.id }
    });
  }

  async applyMode(mode: DesktopMode): Promise<void> {
    const auth = await this.getAuthInfo();
    const { account, workspace, accountKey } = await this.getWorkspace(auth);
    if (mode === 'server') {
      workspace.appliedMode = 'server';
      account.workspaces[auth.workspace.id] = workspace;
      await this.saveConfig();
      this.requestRouting = { mode: 'server', requestContext: {} };
      this.appliedRouteRevision = 0;
      return;
    }

    const capability = await this.request<{ protocol_version: number }>('/desktop/capabilities');
    if (capability.protocol_version !== PROTOCOL_VERSION) throw new Error('线上服务与此客户端的 AI 协议版本不兼容。');
    const routeState = await this.listDesktopRoutes();
    const prepared = prepareDesktopRouteApplication({
      appliedRoutes: routeState.routes as DesktopRouteSelection[],
      ...(routeState.has_draft ? { draftRoutes: routeState.draft_routes as DesktopRouteSelection[] } : {}),
      ...(routeState.has_draft ? { draftRevision: routeState.draft_revision } : {}),
      policyRevision: routeState.policy_revision
    });
    const needsReconnect = this.channelState !== 'ready'
      || this.socket?.readyState !== WebSocket.OPEN
      || !this.requestRouting.requestContext.connectionId
      || this.connectedWorkspaceId !== auth.workspace.id;
    if (needsReconnect && this.pending.size > 0) {
      throw new Error(`当前有 ${this.pending.size} 条本机模型调用正在进行；等待结束后再应用路由，避免中断请求。`);
    }
    const appliedRoutes = prepared.needsCommit
      ? await this.commitDesktopRoutes(prepared.routes as DesktopRoute[], routeState.policy_revision)
      : { routes: prepared.routes as DesktopRoute[], policy_revision: routeState.policy_revision };
    if (needsReconnect) await this.connect();
    if (this.channelState !== 'ready') throw new Error('本机 AI 通道尚未就绪，不能应用该模式。');
    const appliedRevision = appliedRoutes.policy_revision;
    workspace.appliedMode = 'desktop';
    workspace.appliedRouteRevision = appliedRevision;
    delete workspace.draftRoutes;
    delete workspace.draftRouteRevision;
    account.workspaces[auth.workspace.id] = workspace;
    await this.saveConfig();
    this.requestRouting = {
      mode: 'desktop',
      requestContext: { ...this.requestRouting.requestContext, routeRevision: appliedRevision }
    };
    this.appliedRouteRevision = appliedRevision;
  }

  async restoreAppliedMode(): Promise<'server' | 'desktop' | 'incompatible'> {
    let auth: AuthInfo;
    try {
      auth = await this.getAuthInfo();
    } catch {
      const hasSessionCookie = (await this.businessSession.cookies.get({
        url: this.businessOrigin,
        name: 'ops_session'
      })).length > 0;
      if (hasSessionCookie) {
        const config = await this.loadConfig();
        const hasAppliedDesktopMode = Object.values(config.accounts).some((account) =>
          Object.values(account.workspaces).some((workspace) => workspace.appliedMode === 'desktop')
        );
        if (hasAppliedDesktopMode) return 'incompatible';
      }
      if (!hasSessionCookie) this.disconnect();
      this.requestRouting = { mode: 'server', requestContext: {} };
      return 'server';
    }
    const { account, workspace } = await this.getWorkspace(auth);
    if ((this.connectedUserId && this.connectedUserId !== auth.user_id)
      || (this.connectedWorkspaceId && this.connectedWorkspaceId !== auth.workspace.id)) {
      this.disconnect();
    }
    if (workspace.appliedMode !== 'desktop') {
      this.requestRouting = { mode: 'server', requestContext: {} };
      return 'server';
    }

    const savedRevision = workspace.appliedRouteRevision ?? 0;
    this.appliedRouteRevision = savedRevision;
    this.requestRouting = {
      mode: 'desktop',
      requestContext: {
        ...(account.device ? { deviceId: account.device.id } : {}),
        ...(savedRevision > 0 ? { routeRevision: savedRevision } : {})
      }
    };
    try {
      const capability = await this.request<{ protocol_version: number }>('/desktop/capabilities');
      if (capability.protocol_version !== PROTOCOL_VERSION) return 'incompatible';
      await this.connect();
      return 'desktop';
    } catch {
      this.channelMessage = '已保留此客户端 AI 模式，但线上协议或本机通道未就绪；请在设置中检查后重新连接。';
      return 'incompatible';
    }
  }

  private async commitDesktopRoutes(routes: DesktopRoute[], expectedRevision: number): Promise<DesktopRouteState> {
    const auth = await this.getAuthInfo();
    const { account, accountKey } = await this.getWorkspace(auth);
    const device = await this.ensureDevice(auth, account, accountKey);
    return this.signedRequest<DesktopRouteState>(
      auth, device, 'routes.update', 'PUT', '/desktop/routes', routes, undefined,
      { 'X-OPS-Desktop-Policy': String(expectedRevision) }
    );
  }

  async listModels(): Promise<PublicModel[]> {
    const auth = await this.getAuthInfo();
    const workspace = (await this.getWorkspace(auth)).workspace;
    return workspace.models.map((model) => this.toPublicModel(model));
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

  async clearCurrentAccountData(expectedUserId: string): Promise<void> {
    const auth = await this.getAuthInfo();
    if (auth.user_id !== expectedUserId) throw new Error('当前登录账号已变化，请刷新设置后重试。');
    this.disconnect();
    const config = await this.loadConfig();
    const accountKey = `${this.businessOrigin}\n${auth.user_id}`;
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

  async saveModel(input: SaveModelInput): Promise<PublicModel[]> {
    const name = input.name.trim();
    if (!name || name.length > 80) throw new Error('模型配置名称不能为空，且不能超过 80 个字符。');
    const models = [...new Set(input.models.map((value) => value.trim()).filter(Boolean))];
    if (models.length === 0 || models.length > 100 || models.some((model) => model.length > 120)) {
      throw new Error('请填写 1 到 100 个有效的模型名称。');
    }

    const endpoint = normalizeBaseUrl(input.baseUrl);
    const allowedImageHosts = normalizeAllowedImageHosts(input.allowedImageHosts ?? []);
    const auth = await this.getAuthInfo();
    const { account, workspace, accountKey } = await this.getWorkspace(auth);
    const previous = input.providerId
      ? workspace.models.find((model) => model.providerId === input.providerId)
      : undefined;
    if (input.providerId && (!previous || previous.configRevision !== input.configRevision)) {
      throw new Error('本地模型配置已变化，请重新载入后再保存。');
    }
    if (this.pending.size > 0) {
      throw new Error(`当前有 ${this.pending.size} 条本机模型调用正在进行；等待结束后再保存模型配置。`);
    }
    if (input.apiKey && !safeStorage.isEncryptionAvailable()) {
      throw new Error('当前系统无法使用加密存储；为保护密钥，本客户端不会保存 API Key。');
    }
    const encryptedApiKey = input.apiKey
      ? safeStorage.encryptString(input.apiKey).toString('base64')
      : previous?.encryptedApiKey;
    const requestedProxyMode = input.proxyMode ?? previous?.proxyMode ?? 'direct';
    const proxyMode = endpoint.endpointKind === 'loopback' ? 'direct' : requestedProxyMode;
    if (!['system', 'manual', 'direct'].includes(proxyMode)) throw new Error('代理模式无效。');
    const proxyUrl = proxyMode === 'manual'
      ? normalizeProxyUrl(input.proxyUrl ?? previous?.proxyUrl ?? '')
      : '';
    const proxyUsername = input.proxyUsername ?? '';
    const proxyPassword = input.proxyPassword ?? '';
    if (Boolean(proxyUsername) !== Boolean(proxyPassword) || proxyUsername.length > 4096
      || proxyPassword.length > 4096 || /[\r\n]/.test(proxyUsername) || /[\r\n]/.test(proxyPassword)) {
      throw new Error('代理用户名和密码必须同时填写，且不能包含换行。');
    }
    if ((proxyUsername || proxyPassword) && !safeStorage.isEncryptionAvailable()) {
      throw new Error('当前系统无法使用加密存储；为保护代理凭证，本客户端不会保存代理认证信息。');
    }
    const encryptedProxyAuth = proxyMode === 'manual'
      ? (proxyUsername && proxyPassword
        ? safeStorage.encryptString(JSON.stringify({ username: proxyUsername, password: proxyPassword })).toString('base64')
        : previous?.proxyMode === 'manual' && previous.proxyUrl === proxyUrl ? previous.encryptedProxyAuth : undefined)
      : undefined;
    const proxyModel: StoredModel = {
      providerId: previous?.providerId ?? '', name, baseUrl: endpoint.baseUrl, models,
      configRevision: previous?.configRevision ?? 1,
      endpointKind: endpoint.endpointKind, proxyMode, proxyUrl,
      allowedImageHosts, encryptedApiKey, encryptedProxyAuth
    };
    await this.resolveModelProxy(endpoint.baseUrl, proxyModel);

    const device = await this.ensureDevice(auth, account, accountKey);
    const bodyValue = {
      name,
      models,
      endpoint_kind: endpoint.endpointKind,
      status: 'active',
      ...(previous ? { config_revision: previous.configRevision } : {})
    };
    const pathName = previous ? `/desktop/models/${previous.providerId}` : '/desktop/models';
    const saved = await this.signedRequest<ModelManifestEntry>(
      auth,
      device,
      previous ? 'model.update' : 'model.create',
      previous ? 'PUT' : 'POST',
      pathName,
      bodyValue
    );

    const nextModel: StoredModel = {
      providerId: saved.id,
      name,
      baseUrl: endpoint.baseUrl,
      models,
      allowedImageHosts,
      endpointKind: endpoint.endpointKind,
      proxyMode,
      ...(proxyUrl ? { proxyUrl } : {}),
      configRevision: saved.config_revision,
      encryptedApiKey,
      ...(encryptedProxyAuth ? { encryptedProxyAuth } : {})
    };
    this.disconnect();
    this.clearImageParents();
    this.worker?.postMessage({ type: 'clear-authorizations' });
    workspace.models = workspace.models.filter((model) => model.providerId !== saved.id);
    workspace.models.push(nextModel);
    account.workspaces[auth.workspace.id] = workspace;
    await this.saveConfig();
    return workspace.models.map((model) => this.toPublicModel(model));
  }

  async deleteModel(providerId: string, configRevision: number): Promise<PublicModel[]> {
    const auth = await this.getAuthInfo();
    const { account, workspace, accountKey } = await this.getWorkspace(auth);
    const model = workspace.models.find((item) => item.providerId === providerId);
    if (!model || model.configRevision !== configRevision) {
      throw new Error('本机模型配置已变化，请刷新后再删除。');
    }
    const device = await this.ensureDevice(auth, account, accountKey);
    await this.signedRequest<{ ok: boolean }>(
      auth, device, 'model.delete', 'DELETE', `/desktop/models/${encodeURIComponent(providerId)}`, {}
    );
    workspace.models = workspace.models.filter((item) => item.providerId !== providerId);
    delete workspace.draftRoutes;
    delete workspace.draftRouteRevision;
    account.workspaces[auth.workspace.id] = workspace;
    await this.saveConfig();
    this.disconnect();
    return workspace.models.map((item) => this.toPublicModel(item));
  }

  async connect(): Promise<void> {
    this.disconnect();
    const connectingAbort = new AbortController();
    this.connectingAbort = connectingAbort;
    const ensureCurrentAttempt = () => {
      if (this.connectingAbort !== connectingAbort || connectingAbort.signal.aborted) {
        throw connectingAbort.signal.reason ?? new Error('桌面通道连接已取消。');
      }
    };
    this.channelState = 'connecting';
    this.channelMessage = '正在验证账号、设备和模型配置…';

    try {
      const auth = await this.getAuthInfo(connectingAbort.signal);
      ensureCurrentAttempt();
      const { account, workspace, accountKey } = await this.getWorkspace(auth);
      ensureCurrentAttempt();
      const device = await this.ensureDevice(auth, account, accountKey, connectingAbort.signal);
      ensureCurrentAttempt();
      const header = { 'X-OPS-Desktop-Device': device.id };
      const manifest = await this.request<{ models: ModelManifestEntry[]; policy_revision: number }>(
        '/desktop/models', { headers: header, signal: connectingAbort.signal }
      );
      ensureCurrentAttempt();
      const localById = new Map(workspace.models.map((model) => [model.providerId, model]));
      const configs = manifest.models
        .filter((model) => model.status === 'active' && localById.has(model.id)
          && localById.get(model.id)?.configRevision === model.config_revision)
        .map((model) => ({ provider_id: model.id, config_revision: model.config_revision }));
      this.activeModels = new Map(
        configs.map((entry) => [entry.provider_id, localById.get(entry.provider_id)!])
      );

      const routeState = await this.request<{ policy_revision: number }>(
        '/desktop/routes', { headers: header, signal: connectingAbort.signal }
      );
      ensureCurrentAttempt();
      const ticketBody = { device_id: device.id, route_revision: routeState.policy_revision };
      const ticket = await this.signedRequest<{
        ticket: string;
        connection_id: string;
        generation: number;
        route_revision: number;
      }>(auth, device, 'connection.create', 'POST', '/desktop/connections', ticketBody, undefined, {}, connectingAbort.signal);
      ensureCurrentAttempt();

      this.startWorker();
      await this.openChannel(ticket.ticket, ticket.generation, ticket.route_revision, configs);
      ensureCurrentAttempt();
      this.connectingAbort = null;
      this.connectedUserId = auth.user_id;
      this.connectedWorkspaceId = auth.workspace.id;
      this.appliedRouteRevision = ticket.route_revision;
      this.requestRouting = {
        mode: workspace.appliedMode === 'desktop' ? 'desktop' : 'server',
        requestContext: {
          deviceId: device.id,
          connectionId: ticket.connection_id,
          generation: ticket.generation,
          routeRevision: ticket.route_revision
        }
      };
    } catch (error) {
      if (this.connectingAbort === connectingAbort) {
        this.disconnect();
        this.channelState = 'error';
        this.channelMessage = safeError(error);
      }
      throw error;
    }
  }

  disconnect(): void {
    this.connectingAbort?.abort(new Error('桌面通道连接已取消。'));
    this.connectingAbort = null;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (this.pendingReadyTimer) clearTimeout(this.pendingReadyTimer);
    this.pendingReadyTimer = null;
    this.pendingReady?.(new Error('客户端通道已关闭。'));
    this.pendingReady = null;

    for (const requestId of this.pending.keys()) {
      this.worker?.postMessage({ type: 'request-cancel', requestId });
    }
    this.worker?.postMessage({ type: 'clear-authorizations' });
    this.clearImageParents();
    this.pending.clear();
    this.completedRequestIds.clear();
    this.activeModels.clear();
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) {
      this.socket.close(1000, 'client disconnect');
    }
    this.socket = null;
    this.connectedUserId = null;
    this.connectedWorkspaceId = null;
    if (this.worker) {
      const worker = this.worker;
      worker.postMessage({ type: 'shutdown' });
      setTimeout(() => worker.kill(), 250).unref();
      this.worker = null;
    }
    this.channelState = 'disconnected';
    this.channelMessage = '通道尚未连接';
  }

  private async openChannel(
    ticket: string,
    generation: number,
    routeRevision: number,
    configs: Array<{ provider_id: string; config_revision: number }>
  ): Promise<void> {
    const websocketOrigin = this.businessOrigin.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
    const channelUrl = new URL(`${API_PREFIX}/desktop/channel`, websocketOrigin).toString();
    const target = new URL(channelUrl);
    const proxyLookupURL = channelUrl.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:');
    const systemProxy = parseSystemProxyResolution(await this.businessSession.resolveProxy(proxyLookupURL));
    let agent: https.Agent | undefined;
    if (target.protocol === 'wss:') {
      const addresses = await dnsLookup(target.hostname.replace(/^\[|\]$/g, ''), { all: true, verbatim: true });
      if (addresses.length === 0) throw new Error('线上服务域名解析失败，无法建立 WSS 通道。');
      agent = systemProxy
        ? createPinnedHttpsProxyAgent(systemProxy, target.hostname.replace(/^\[|\]$/g, ''), Number(target.port || 443), addresses[0].address)
        : createPinnedDirectHttpsAgent(addresses);
    } else if (systemProxy) {
      throw new Error('当前本地 HTTP 服务解析到了代理；请为本地服务配置直连例外。');
    }
    const socket = new WebSocket(channelUrl, {
      headers: { Authorization: `Bearer ${ticket}` },
      ...(agent ? { agent } : {}),
      perMessageDeflate: false,
      maxPayload: CHUNK_BYTES + 20,
      handshakeTimeout: 10_000
    });
    this.socket = socket;
    this.generation = generation;
    this.resetControlBudgets();

    await new Promise<void>((resolve, reject) => {
      let ready = false;
      const timeout = setTimeout(() => fail(new Error('桌面通道握手超时。')), 10_000);
      this.pendingReadyTimer = timeout;
      this.pendingReady = (error) => error ? fail(error) : finish();

      const finish = () => {
        if (ready) return;
        ready = true;
        clearTimeout(timeout);
        this.pendingReadyTimer = null;
        this.pendingReady = null;
        this.channelState = 'ready';
        this.channelMessage = 'WSS 通道已连接；业务 AI 路由尚未启用。';
        this.lastHeartbeatAck = Date.now();
        this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), 15_000);
        this.heartbeatTimer.unref();
        resolve();
      };
      const fail = (error: Error) => {
        if (ready) return;
        clearTimeout(timeout);
        this.pendingReadyTimer = null;
        this.pendingReady = null;
        socket.close();
        reject(error);
      };

      socket.on('message', (raw, isBinary) => {
        try {
          if (isBinary) this.handleDataFrame(asBuffer(raw));
          else this.handleControlFrame(asBuffer(raw), { generation, routeRevision, configs, finish, fail });
        } catch (error) {
          const cause = error instanceof Error ? error : new Error('桌面通道协议错误。');
          this.channelState = 'error';
          this.channelMessage = safeError(cause);
          socket.close(1002, 'protocol error');
          fail(cause);
        }
      });
      socket.on('error', () => fail(new Error('无法建立桌面 WSS 通道。')));
      socket.on('close', () => {
        if (this.socket !== socket) return;
        this.socket = null;
        this.stopWorkerRequests();
        if (this.channelState === 'ready' || this.channelState === 'connecting') {
          this.channelState = 'error';
          this.channelMessage = '桌面通道已断开，请检查网络并手动重连。';
        }
      });
    });
  }

  private handleControlFrame(
    raw: Buffer,
    state: {
      generation: number;
      routeRevision: number;
      configs: Array<{ provider_id: string; config_revision: number }>;
      finish: () => void;
      fail: (error: Error) => void;
    }
  ): void {
    if (!this.consumeControlToken(this.receivedControlBudget)) {
      throw new Error('服务端桌面通道控制帧超过频率限制。');
    }
    if (raw.length > MAX_CONTROL_BYTES) throw new Error('桌面通道控制消息超过限制。');
    const message = JSON.parse(raw.toString('utf8')) as WireMessage;
    switch (message.type) {
      case 'channel.hello':
        if (message.protocol_version !== PROTOCOL_VERSION
          || message.generation !== state.generation
          || message.route_revision !== state.routeRevision) {
          throw new Error('服务端桌面通道版本或配置不匹配。');
        }
        this.sendControl({ type: 'channel.ready', configs: state.configs });
        return;
      case 'channel.ready_ack':
        if (message.generation !== state.generation) throw new Error('服务端连接代次不匹配。');
        state.finish();
        return;
      case 'channel.heartbeat_ack':
        this.lastHeartbeatAck = Date.now();
        return;
      case 'request.open':
        void this.openRequest(message).catch((error) => this.closeProtocol(safeError(error)));
        return;
      case 'request.end':
        this.requestEnded(message);
        return;
      case 'response.credit': {
        const requestId = normalizeUuid(message.request_id);
        if (!requestId || message.direction !== 'response' || !isPositiveInt(message.count) || message.count > REQUEST_WINDOW) {
          throw new Error('服务端响应流控额度无效。');
        }
        const pending = this.pending.get(requestId);
        // A final credit may arrive after the Go reader consumes buffered bytes.
        if (!pending && this.completedRequestIds.has(requestId)) return;
        if (!pending) throw new Error('桌面通道收到未知请求。');
        if (pending.responseCredits + message.count > REQUEST_WINDOW) throw new Error('服务端响应流控额度无效。');
        pending.responseCredits += message.count;
        this.worker?.postMessage({ type: 'response-credit', requestId: pending.id, count: message.count });
        return;
      }
      case 'request.cancel': {
        const pending = this.pending.get(normalizeUuid(message.request_id));
        const requestId = normalizeUuid(message.request_id);
        if (requestId) this.clearImageParent(requestId);
        if (!pending) {
          if (requestId) this.worker?.postMessage({ type: 'clear-parent-authorization', requestId });
          return;
        }
        this.worker?.postMessage({ type: 'request-cancel', requestId: pending.id });
        if (requestId) this.worker?.postMessage({ type: 'clear-parent-authorization', requestId });
        if (pending.parentRequestId) {
          this.worker?.postMessage({ type: 'clear-parent-authorization', requestId: pending.parentRequestId });
        }
        this.removePending(pending);
        return;
      }
      default:
        throw new Error(`服务端发送了不支持的消息：${message.type ?? 'unknown'}`);
    }
  }

  private async openRequest(message: WireMessage): Promise<void> {
    const id = normalizeUuid(message.request_id);
    const providerId = normalizeUuid(message.provider_id);
    const model = typeof message.model === 'string' ? message.model : '';
    const operation = message.operation;
    const bodyLength = message.body_length;
    const deadlineMs = message.deadline_ms;
    const configRevision = message.config_revision;
    const openedAt = Date.now();
    const parentRequestId = normalizeUuid(message.parent_request_id);
    if (!id || this.pending.has(id) || this.pending.size >= 2 || !providerId || !model
      || !isPositiveInt(bodyLength)
      || bodyLength > (operation === 'generated_image_fetch' ? MAX_IMAGE_FETCH_BODY_BYTES : MAX_REQUEST_BYTES)
      || !isPositiveInt(deadlineMs) || deadlineMs > 10 * 60 * 1000
      || !isPositiveInt(configRevision)
      || !isDesktopOperation(operation)
      || message.generation !== this.generation
      || (operation === 'generated_image_fetch' && !parentRequestId)
      || (message.purpose !== 'business' && message.purpose !== 'self_test')) {
      throw new Error('服务端桌面 AI 请求参数无效。');
    }

    this.purgeImageParents();
    const parent = operation === 'generated_image_fetch' ? this.imageParents.get(parentRequestId) : undefined;
    if (operation === 'generated_image_fetch') this.clearImageParent(parentRequestId);
    const deadlineAt = operation === 'generated_image_fetch' && parent
      ? Math.min(parent.deadlineAt, openedAt + deadlineMs + DEADLINE_MATCH_TOLERANCE_MS)
      : openedAt + deadlineMs;

    const local = this.activeModels.get(providerId);
    const pending: PendingRequest = {
      id, providerId, model, configRevision, operation, bodyLength, deadlineMs, deadlineAt, openedAt,
      purpose: message.purpose,
      generation: this.generation,
      ...(operation === 'generated_image_fetch'
        ? { parentRequestId } : {}),
      receivedBytes: 0, nextRequestSequence: 0, requestCredits: 0, requestEnded: false,
      responseEnded: false,
      headersSent: false, responseCredits: 0, nextResponseSequence: 0, responseBytes: 0
    };
    const validImageParent = operation !== 'generated_image_fetch' || Boolean(parent
      && parent.expiresAt > Date.now()
      && parent.providerId === providerId
      && parent.model === model
      && parent.configRevision === message.config_revision
      && parent.generation === message.generation
      && parent.purpose === message.purpose
      && Math.abs(parent.deadlineAt - (openedAt + deadlineMs)) <= DEADLINE_MATCH_TOLERANCE_MS);
    if (!validImageParent) {
      this.worker?.postMessage({ type: 'clear-parent-authorization', requestId: parentRequestId });
      pending.rejectedCode = 'protocol';
      this.pending.set(id, pending);
      this.grantRequestCredit(pending, REQUEST_WINDOW);
      return;
    }
    if (!local || local.configRevision !== configRevision || !local.models.includes(model)) {
      if (pending.parentRequestId) {
        this.worker?.postMessage({ type: 'clear-parent-authorization', requestId: pending.parentRequestId });
      }
      pending.rejectedCode = 'protocol';
      this.pending.set(id, pending);
      this.grantRequestCredit(pending, REQUEST_WINDOW);
      return;
    }
    this.pending.set(id, pending);

    try {
      const apiKey = operation === 'generated_image_fetch' ? ''
        : local.encryptedApiKey ? this.decrypt(local.encryptedApiKey) : '';
      if (!this.worker) throw new Error('AI 网络工作进程不可用。');
      this.worker.postMessage({
        type: 'request-open', requestId: id, baseUrl: local.baseUrl, apiKey,
        model, operation, bodyLength, deadlineMs, providerId,
        configRevision, generation: this.generation,
        deadlineAt: pending.deadlineAt,
        purpose: pending.purpose, parentRequestId: pending.parentRequestId,
        allowedImageHosts: local.allowedImageHosts ?? []
      });
      this.grantRequestCredit(pending, REQUEST_WINDOW);
    } catch {
      if (pending.parentRequestId) {
        this.worker?.postMessage({ type: 'clear-parent-authorization', requestId: pending.parentRequestId });
      }
      pending.rejectedCode = 'offline';
      this.grantRequestCredit(pending, REQUEST_WINDOW);
    }
  }

  private handleDataFrame(frame: Buffer): void {
    if (frame.length <= 20 || frame.length > CHUNK_BYTES + 20) throw new Error('桌面通道数据块长度无效。');
    const id = bytesToUuid(frame.subarray(0, 16));
    const pending = this.getPending(id);
    const sequence = frame.readUInt32BE(16);
    const payload = frame.subarray(20);
    if (sequence !== pending.nextRequestSequence || pending.requestEnded
      || pending.requestCredits < CHUNK_BYTES || pending.receivedBytes + payload.length > pending.bodyLength) {
      throw new Error('服务端请求体分块乱序或超出流控额度。');
    }
    pending.nextRequestSequence++;
    pending.requestCredits -= CHUNK_BYTES;
    pending.receivedBytes += payload.length;

    if (pending.upstreamErrorCode) {
      this.grantRequestCredit(pending, CHUNK_BYTES);
      return;
    }

    if (pending.rejectedCode) {
      this.grantRequestCredit(pending, CHUNK_BYTES);
      return;
    }
    this.worker?.postMessage({ type: 'request-data', requestId: id, data: Uint8Array.from(payload) });
  }

  private handleWorkerMessage(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const message = raw as WorkerMessage;
    if (message.type === 'worker-ready') return;
    const pending = this.pending.get(normalizeUuid(message.requestId));
    if (!pending) return;

    switch (message.type) {
      case 'request-ready':
        this.grantRequestCredit(pending, REQUEST_WINDOW);
        return;
      case 'target-check':
        void this.resolveModelProxy(message.targetUrl, this.activeModels.get(pending.providerId))
          .then((proxy) => {
            this.worker?.postMessage({
              type: 'target-check-result', requestId: pending.id, allowed: true,
              ...(proxy ? { proxy } : {})
            });
          })
          .catch(() => this.worker?.postMessage({ type: 'target-check-result', requestId: pending.id, allowed: false }));
        return;
      case 'image-url-ready':
        if (pending.operation === 'image_generations' && pending.headersSent
          && pending.responseStatus === 200 && isJsonContentType(pending.responseContentType)
          && !pending.rejectedCode && !pending.upstreamErrorCode) {
          pending.imageUrlReady = true;
        } else {
          this.worker?.postMessage({ type: 'clear-parent-authorization', requestId: pending.id });
        }
        return;
      case 'request-consumed':
        if (pending.requestEnded) return;
        this.grantRequestCredit(pending, CHUNK_BYTES);
        return;
      case 'request-error':
        pending.rejectedCode = allowedErrorCode(message.code);
        this.worker?.postMessage({ type: 'request-cancel', requestId: pending.id });
        if (pending.requestEnded) this.sendRequestError(pending);
        else if (pending.requestCredits === 0) this.grantRequestCredit(pending, CHUNK_BYTES);
        return;
      case 'response-headers': {
        if (pending.headersSent || !isPositiveInt(message.status) || message.status < 100 || message.status > 599) {
          this.closeProtocol('上游响应头无效。');
          return;
        }
        const contentType = allowedContentType(message.contentType);
        if (!contentType) {
          pending.rejectedCode = 'protocol';
          if (pending.requestEnded) this.sendRequestError(pending);
          return;
        }
        pending.headersSent = true;
        pending.responseStatus = message.status;
        pending.responseContentType = contentType;
        this.sendControl({
          type: 'upstream.headers', request_id: pending.id, status: message.status,
          content_type: contentType, ...(validRetryAfter(message.retryAfter) ? { retry_after: message.retryAfter } : {})
        });
        return;
      }
      case 'response-data': {
        const data = message.data ? Buffer.from(message.data) : Buffer.alloc(0);
        const maxResponse = pending.operation === 'image_generations' ? MAX_IMAGE_RESPONSE_BYTES
          : pending.operation === 'generated_image_fetch' ? MAX_FETCHED_IMAGE_BYTES : MAX_RESPONSE_BYTES;
        if (!pending.headersSent || data.length === 0 || data.length > CHUNK_BYTES
          || data.length > pending.responseCredits || pending.responseBytes + data.length > maxResponse) {
          this.closeProtocol('上游响应超出流控或大小限制。');
          return;
        }
        pending.responseCredits -= data.length;
        pending.responseBytes += data.length;
        const uuidBytes = Buffer.from(pending.id.replace(/-/g, ''), 'hex');
        const frame = Buffer.allocUnsafe(20 + data.length);
        uuidBytes.copy(frame, 0);
        frame.writeUInt32BE(pending.nextResponseSequence++, 16);
        data.copy(frame, 20);
        if (this.requireSocket().bufferedAmount > MAX_WS_BUFFERED_BYTES) {
          this.closeProtocol('桌面通道待发送数据超过上限。');
          return;
        }
        this.requireSocket().send(frame, { binary: true });
        return;
      }
      case 'response-end':
        if (!pending.headersSent) {
          pending.rejectedCode = 'protocol';
          this.sendRequestError(pending);
          return;
        }
        pending.responseEnded = true;
        if (pending.imageUrlReady && pending.operation === 'image_generations'
          && pending.requestEnded && pending.responseStatus === 200
          && isJsonContentType(pending.responseContentType)
          && !pending.rejectedCode && !pending.upstreamErrorCode) {
          this.rememberImageParent(pending);
        }
        this.sendControl({ type: 'upstream.end', request_id: pending.id });
        if (pending.requestEnded) this.removePending(pending);
        return;
      case 'response-error':
        if (!pending.headersSent) {
          pending.rejectedCode = allowedErrorCode(message.code);
          if (pending.requestEnded) this.sendRequestError(pending);
          return;
        }
        pending.upstreamErrorCode = message.code === 'credential_echo'
          ? 'credential_echo' : 'upstream_stream_failed';
        if (pending.requestEnded) this.sendUpstreamError(pending);
        return;
      default:
        this.closeProtocol('AI 工作进程返回了未知消息。');
    }
  }

  private grantRequestCredit(pending: PendingRequest, count: number): void {
    if (pending.requestCredits + count > REQUEST_WINDOW) {
      this.closeProtocol('请求流控额度超过上限。');
      return;
    }
    pending.requestCredits += count;
    this.sendControl({ type: 'credit', request_id: pending.id, direction: 'request', count });
  }

  private requestEnded(message: WireMessage): void {
    const pending = this.getPending(message.request_id);
    if (pending.requestEnded || message.sequence !== pending.nextRequestSequence
      || pending.receivedBytes !== pending.bodyLength) {
      throw new Error('服务端请求体长度或结束序号不匹配。');
    }
    pending.requestEnded = true;
    if (pending.upstreamErrorCode) {
      this.sendUpstreamError(pending);
      return;
    }
    if (pending.rejectedCode) {
      if (!pending.headersSent) this.sendRequestError(pending);
      return;
    }
    this.worker?.postMessage({ type: 'request-end', requestId: pending.id });
    if (pending.responseEnded) this.removePending(pending);
  }

  private sendUpstreamError(pending: PendingRequest): void {
    if (!this.pending.has(pending.id) || !pending.upstreamErrorCode) return;
    this.sendControl({ type: 'upstream.error', request_id: pending.id, error_code: pending.upstreamErrorCode });
    this.removePending(pending);
  }

  private sendRequestError(pending: PendingRequest): void {
    if (!this.pending.has(pending.id)) return;
    this.sendControl({ type: 'request.error', request_id: pending.id, error_code: pending.rejectedCode ?? 'offline' });
    this.removePending(pending);
  }

  private sendHeartbeat(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    if (Date.now() - this.lastHeartbeatAck > 45_000) {
      this.closeProtocol('桌面通道心跳超时。');
      return;
    }
    this.sendControl({ type: 'channel.heartbeat' });
  }

  private sendControl(message: Record<string, unknown>): void {
    const socket = this.requireSocket();
    const raw = JSON.stringify(message);
    if (Buffer.byteLength(raw, 'utf8') > MAX_CONTROL_BYTES || socket.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
      throw new Error('桌面通道控制队列已满。');
    }
    if (!this.consumeControlToken(this.sentControlBudget)) {
      this.closeProtocol('客户端桌面通道控制帧超过频率限制。');
      return;
    }
    socket.send(raw);
  }

  private consumeControlToken(budget: ControlBudget): boolean {
    const now = performance.now();
    const elapsedMs = Math.max(0, now - budget.updatedAt);
    budget.tokens = Math.min(CONTROL_BURST, budget.tokens + elapsedMs * CONTROL_RATE_PER_SECOND / 1000);
    budget.updatedAt = now;
    if (budget.tokens < 1) return false;
    budget.tokens -= 1;
    return true;
  }

  private resetControlBudgets(): void {
    for (const budget of [this.sentControlBudget, this.receivedControlBudget]) {
      budget.tokens = CONTROL_BURST;
      budget.updatedAt = performance.now();
    }
  }

  private closeProtocol(message: string): void {
    this.channelState = 'error';
    this.channelMessage = message;
    this.socket?.close(1002, 'protocol error');
    this.stopWorkerRequests();
  }

  private stopWorkerRequests(): void {
    for (const requestId of this.pending.keys()) {
      this.worker?.postMessage({ type: 'request-cancel', requestId });
    }
    this.worker?.postMessage({ type: 'clear-authorizations' });
    this.clearImageParents();
    this.pending.clear();
    this.completedRequestIds.clear();
  }

  private removePending(pending: PendingRequest): void {
    this.pending.delete(pending.id);
    this.completedRequestIds.add(pending.id);
    if (this.completedRequestIds.size > MAX_COMPLETED_REQUEST_IDS) {
      const oldest = this.completedRequestIds.values().next().value;
      if (oldest) this.completedRequestIds.delete(oldest);
    }
  }

  private rememberImageParent(pending: PendingRequest): void {
    this.clearImageParent(pending.id);
    const expiresAt = pending.deadlineAt;
    const timer = setTimeout(() => this.clearImageParent(pending.id), Math.max(0, expiresAt - Date.now()));
    timer.unref();
    this.imageParents.set(pending.id, {
      providerId: pending.providerId,
      model: pending.model,
      configRevision: pending.configRevision,
      generation: pending.generation,
      purpose: pending.purpose,
      deadlineAt: expiresAt,
      expiresAt,
      timer
    });
    while (this.imageParents.size > 16) {
      const oldest = this.imageParents.keys().next().value as string | undefined;
      if (!oldest) break;
      this.clearImageParent(oldest);
    }
  }

  private purgeImageParents(): void {
    const now = Date.now();
    for (const [requestId, parent] of this.imageParents) {
      if (parent.expiresAt <= now) this.clearImageParent(requestId);
    }
  }

  private clearImageParent(requestId: string): void {
    const parent = this.imageParents.get(requestId);
    if (parent) clearTimeout(parent.timer);
    this.imageParents.delete(requestId);
  }

  private clearImageParents(): void {
    for (const parent of this.imageParents.values()) clearTimeout(parent.timer);
    this.imageParents.clear();
  }

  private startWorker(): void {
    if (this.worker) return;
    const workerEnvironment: NodeJS.ProcessEnv = { OPS_DESKTOP_WORKER: '1' };
    if (process.platform === 'win32') {
      const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
      if (systemRoot) workerEnvironment.SystemRoot = systemRoot;
    }
    const worker = utilityProcess.fork(path.join(__dirname, 'ai-worker.js'), [], {
      serviceName: 'OPS Desktop AI worker',
      env: workerEnvironment,
      stdio: 'ignore'
    });
    this.worker = worker;
    worker.on('message', (message) => this.handleWorkerMessage(message));
    worker.on('exit', () => {
      if (this.worker !== worker) return;
      this.worker = null;
      if (this.socket && this.channelState === 'ready') this.closeProtocol('AI 工作进程已退出。');
    });
  }

  private async resolveModelProxy(target: string | undefined, model: StoredModel | undefined): Promise<ProxyRoute | null> {
    if (!target || !model) throw new Error('模型网络配置不存在。');
    const parsed = new URL(target);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error('模型请求目标无效。');
    }
    if (model.endpointKind === 'loopback' || isLoopbackName(parsed.hostname)) return null;
    const mode = model.proxyMode ?? 'direct';
    if (mode === 'direct') return null;
    if (mode === 'system') return parseSystemProxyResolution(await this.businessSession.resolveProxy(parsed.toString()));
    if (mode !== 'manual' || !model.proxyUrl) throw new Error('手动代理配置不完整。');
    const proxy: ProxyRoute = { url: normalizeProxyUrl(model.proxyUrl) };
    if (model.encryptedProxyAuth) {
      let auth: unknown;
      try {
        auth = JSON.parse(this.decrypt(model.encryptedProxyAuth));
      } catch {
        throw new Error('本机代理凭证无法读取；请重新保存代理配置。');
      }
      if (!auth || typeof auth !== 'object'
        || typeof (auth as { username?: unknown }).username !== 'string'
        || typeof (auth as { password?: unknown }).password !== 'string') {
        throw new Error('本机代理凭证格式无效；请重新保存代理配置。');
      }
      proxy.username = (auth as { username: string }).username;
      proxy.password = (auth as { password: string }).password;
    }
    return proxy;
  }

  private async ensureDevice(auth: AuthInfo, account: StoredAccount, accountKey: string, signal?: AbortSignal): Promise<StoredDevice> {
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
  async platformSignedCall(operation: string, method: string, pathName: string, body: unknown): Promise<unknown> {
    const device = await this.ensurePlatformDevice();
    const auth = await this.getAuthInfo();
    return this.platformSignedRequest<unknown>(auth, device, operation, method, pathName, body);
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

  // platformSignedRequest 复用同一套设备证明：挑战 → 签名 → 带证明头请求。
  // 平台端点不传 purpose（只有登记类操作需要）。
  private async platformSignedRequest<T>(
    auth: AuthInfo,
    device: StoredDevice,
    operation: string,
    method: string,
    pathName: string,
    bodyValue: unknown
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
        'X-OPS-Desktop-Signature': signature
      },
      ...(hasBody ? { body } : {})
    });
  }

  private async signedRequest<T = unknown>(
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

  private async getAuthInfo(signal?: AbortSignal): Promise<AuthInfo> {
    return this.request<AuthInfo>('/auth/me', signal ? { signal } : {});
  }

  private async getWorkspace(auth: AuthInfo): Promise<{
    account: StoredAccount;
    workspace: StoredWorkspace;
    accountKey: string;
  }> {
    const config = await this.loadConfig();
    const accountKey = `${this.businessOrigin}\n${auth.user_id}`;
    const account = config.accounts[accountKey] ?? { workspaces: {} };
    account.workspaces[auth.workspace.id] ??= { models: [] };
    config.accounts[accountKey] = account;
    return { account, workspace: account.workspaces[auth.workspace.id], accountKey };
  }

  private async getAccount(auth: AuthInfo): Promise<StoredAccount> {
    return (await this.getWorkspace(auth)).account;
  }

  private async request<T>(pathName: string, init: RequestInit = {}): Promise<T> {
    const url = new URL(`${API_PREFIX}${pathName}`, this.businessOrigin).toString();
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

  private async loadConfig(): Promise<ConfigDocument> {
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

  private async saveConfig(): Promise<void> {
    const config = await this.loadConfig();
    const tempPath = `${this.configPath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(config), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tempPath, this.configPath);
  }

  private decrypt(encrypted: string): string {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密存储不可用。');
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
    } catch {
      throw new Error('本机密钥无法解密；请重新配置该密钥。');
    }
  }

  private toPublicModel(model: StoredModel): PublicModel {
    return {
      providerId: model.providerId,
      name: model.name,
      baseUrl: model.baseUrl,
      models: [...model.models],
      allowedImageHosts: [...(model.allowedImageHosts ?? [])],
      endpointKind: model.endpointKind,
      proxyMode: model.endpointKind === 'loopback' ? 'direct' : model.proxyMode ?? 'direct',
      proxyUrl: model.proxyUrl ?? '',
      configRevision: model.configRevision,
      hasKey: Boolean(model.encryptedApiKey),
      keyMask: model.encryptedApiKey ? '••••••••' : '',
      hasProxyAuth: Boolean(model.encryptedProxyAuth)
    };
  }

  private requireSocket(): WebSocket {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error('桌面通道不可用。');
    return this.socket;
  }

  private getPending(id?: string): PendingRequest {
    const requestId = normalizeUuid(id);
    const pending = this.pending.get(requestId);
    if (!pending) throw new Error('桌面通道收到未知请求。');
    return pending;
  }
}

function normalizeBaseUrl(value: string): { baseUrl: string; endpointKind: 'loopback' | 'public' } {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('模型服务地址不是有效 URL。');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('服务地址只允许无凭证、无查询参数的 HTTP(S) 基础 URL。');
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const endpointKind = isLoopbackName(hostname) ? 'loopback' : 'public';
  if (url.protocol === 'http:' && endpointKind !== 'loopback') {
    throw new Error('明文 HTTP 只允许回环地址，例如 http://127.0.0.1:1234/v1。');
  }
  if (isPrivateLiteral(hostname) && !isLoopbackName(hostname)) {
    throw new Error('不允许私网、链路本地或保留地址作为模型服务目标。');
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  return { baseUrl: url.toString(), endpointKind };
}

function normalizeAllowedImageHosts(values: string[]): string[] {
  if (!Array.isArray(values) || values.length > 50) throw new Error('图片 CDN 域名最多只能设置 50 个。');
  const hosts = new Set<string>();
  for (const raw of values) {
    const value = raw.trim().toLowerCase();
    if (!value) continue;
    let parsed: URL;
    try {
      parsed = new URL(`https://${value}`);
    } catch {
      throw new Error(`图片 CDN 域名无效：${value.slice(0, 100)}`);
    }
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (parsed.username || parsed.password || parsed.port || parsed.pathname !== '/' || parsed.search
      || parsed.hash || isIP(hostname) !== 0 || hostname === 'localhost' || hostname.endsWith('.localhost')
      || hostname.length > 253 || !hostname.includes('.')
      || !hostname.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
      throw new Error(`图片 CDN 只允许精确的公网域名：${value.slice(0, 100)}`);
    }
    hosts.add(hostname);
  }
  return [...hosts].sort();
}

function isLoopbackName(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '::1' || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

function isPrivateLiteral(hostname: string): boolean {
  if (isIP(hostname) === 6) return !isPublicIpv6(hostname);
  const octets = hostname.split('.').map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  const [a, b] = octets;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && [0, 2, 88, 168].includes(b)) || (a === 198 && [18, 19, 51].includes(b))
    || (a === 203 && b === 0) || a >= 224;
}

function isPublicIpv6(hostname: string): boolean {
  const halves = hostname.toLowerCase().split('::');
  if (halves.length > 2) return false;
  const parse = (part: string): number[] | null => {
    if (!part) return [];
    const values: number[] = [];
    for (const token of part.split(':')) {
      if (token.includes('.')) {
        const octets = token.split('.').map(Number);
        if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
        values.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(token)) return null;
        values.push(Number.parseInt(token, 16));
      }
    }
    return values;
  };
  const left = parse(halves[0]);
  const right = parse(halves[1] ?? '');
  if (!left || !right) return false;
  const missing = 8 - left.length - right.length;
  if (missing < 0 || halves.length === 1 && missing !== 0 || halves.length === 2 && missing < 1) return false;
  const words = [...left, ...Array<number>(missing).fill(0), ...right];
  if (words.length !== 8) return false;
  const loopback = words.slice(0, 7).every((word) => word === 0) && words[7] === 1;
  if (loopback) return false;
  const first = words[0];
  if ((first & 0xe000) !== 0x2000) return false;
  const first32 = words[0] * 0x10000 + words[1];
  if ((words[0] === 0x2001 && words[1] <= 0x01ff)
    || first32 === 0x20010db8 || words[0] === 0x2002 || (words[0] & 0xfff0) === 0x3ff0) {
    return false;
  }
  return true;
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
