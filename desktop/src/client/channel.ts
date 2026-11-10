import {
  safeStorage,
  utilityProcess,
  type Session,
  type UtilityProcess
} from 'electron';
import { lookup as dnsLookup } from 'node:dns/promises';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import WebSocket from 'ws';
import { channelReconnectDelayMs } from '../reconnect-policy';
import { createPinnedDirectHttpsAgent, createPinnedHttpsProxyAgent, normalizeProxyUrl, parseSystemProxyResolution } from '../proxy';
import type { DesktopMode } from '../request-context';
import type { AuthInfo, StoredAccount, StoredDevice, StoredModel, StoredWorkspace } from '../desktop-client';

// DT-08 片 A（docs/33 §10.7 / §10.8 DT-08；≡DEV-S02）：desktop-client.ts 的通道域拆分。
// connect/disconnect/teardown/reconnect/openChannel/控制帧/请求开启/数据帧/worker 消息/
// 流控预算/协议错误收口整体搬到 ChannelMixin；DesktopClient 继承它，公有 API 与私有
// 字段归属不变，行为逐字节搬移（含 DT-07 的重连状态如实显示与 TS 析构语义）。
// 本模块只承载通道域：不触达 config/models 路由决策/平台签名调用。

export const PROTOCOL_VERSION = 1;
export const CHUNK_BYTES = 64 * 1024;
export const REQUEST_WINDOW = 4 * CHUNK_BYTES;
export const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
export const MAX_IMAGE_RESPONSE_BYTES = 18 * 1024 * 1024;
export const MAX_FETCHED_IMAGE_BYTES = 12 * 1024 * 1024;
export const MAX_IMAGE_FETCH_BODY_BYTES = 8 * 1024;
export const MAX_CONTROL_BYTES = 16 * 1024;
export const MAX_WS_BUFFERED_BYTES = 1024 * 1024;
export const MAX_COMPLETED_REQUEST_IDS = 64;
export const CONTROL_RATE_PER_SECOND = 2048;
export const CONTROL_BURST = 4096;
export const DEADLINE_MATCH_TOLERANCE_MS = 2000;

export interface ChannelControlBudget {
  tokens: number;
  updatedAt: number;
}

export interface ChannelPendingRequest {
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

export interface ChannelCompletedImageParent {
  providerId: string;
  model: string;
  configRevision: number;
  generation: number;
  purpose: 'business' | 'self_test';
  deadlineAt: number;
  expiresAt: number;
  timer: NodeJS.Timeout;
}

export interface ChannelWorkerMessage {
  type: string;
  requestId?: string;
  data?: Uint8Array;
  status?: number;
  contentType?: string;
  retryAfter?: string;
  code?: string;
  count?: number;
  targetUrl?: string;
  proxy?: import('../proxy').ProxyRoute;
}

export interface ChannelWireMessage {
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

export type ChannelState = 'disconnected' | 'connecting' | 'ready' | 'error';

export function bytesToUuid(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function asBuffer(data: WebSocket.RawData): Buffer {
  return Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
}

export function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function isDesktopOperation(value: unknown): value is ChannelPendingRequest['operation'] {
  return value === 'chat_completions' || value === 'image_generations' || value === 'generated_image_fetch';
}

export function normalizeUuid(value: unknown): string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value) ? value : '';
}

export function allowedErrorCode(value: unknown): string {
  return value === 'protocol' || value === 'offline' || value === 'model_unavailable' ? value : 'offline';
}

export function allowedContentType(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 255) return null;
  return isJsonContentType(value) ? value : null;
}

export function isJsonContentType(value: string | undefined): boolean {
  return typeof value === 'string' && /^(?:application|text\/(?:plain|x-ndjson))\/json\b/i.test(value.trim());
}

export function validRetryAfter(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 60;
}

export function safeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message.split('\n')[0].slice(0, 200)}` : String(error).slice(0, 200);
}

/** 通道域抽象基类：字段声明（供 façade 与 TS 编译器共用）+ 全部通道方法。
 * façade 类的私有字段是编译期可见性，本类内重新声明同名字段即可共享同一实例状态
 * （TS 结构化：实例上只有一个同名字段，两个声明互为兼容视图）。 */
export abstract class ChannelMixin {
  worker: UtilityProcess | null = null;
  socket: WebSocket | null = null;
  channelState: ChannelState = 'disconnected';
  channelMessage = '通道尚未连接';
  connectedUserId: string | null = null;
  connectedWorkspaceId: string | null = null;
  connectingAbort: AbortController | null = null;
  heartbeatTimer: NodeJS.Timeout | null = null;
  reconnectTimer: NodeJS.Timeout | null = null;
  reconnectAttempt = 0;
  reconnectSuppressed = false;
  lastHeartbeatAck = 0;
  generation = 0;
  activeModels = new Map<string, StoredModel>();
  pending = new Map<string, ChannelPendingRequest>();
  completedRequestIds = new Set<string>();
  imageParents = new Map<string, ChannelCompletedImageParent>();
  pendingReady: ((error?: Error) => void) | null = null;
  pendingReadyTimer: NodeJS.Timeout | null = null;
  readonly sentControlBudget: ChannelControlBudget = { tokens: CONTROL_BURST, updatedAt: performance.now() };
  readonly receivedControlBudget: ChannelControlBudget = { tokens: CONTROL_BURST, updatedAt: performance.now() };

  // businessSession / apiOrigin 由 façade 构造参数注入；基类用受保护抽象声明访问。
  protected abstract readonly businessSession: Session;
  protected abstract readonly apiOrigin: string;
  protected abstract appliedRouteRevision: number;
  requestRouting: { mode: DesktopMode; requestContext: import('../request-context').AppliedDesktopRequestContext } = { mode: 'server', requestContext: {} };

  protected abstract decrypt(encrypted: string): string;
  protected abstract request<T>(pathName: string, init?: RequestInit): Promise<T>;
  protected abstract getAuthInfo(signal?: AbortSignal): Promise<AuthInfo>;
  protected abstract getWorkspace(auth: AuthInfo): Promise<{ account: StoredAccount; workspace: StoredWorkspace; accountKey: string }>;
  protected abstract ensureDevice(auth: AuthInfo, account: StoredAccount, accountKey: string, signal?: AbortSignal): Promise<StoredDevice>;
  protected abstract signedRequest<T>(auth: AuthInfo, device: StoredDevice, operation: string, method: string, pathName: string, bodyValue?: unknown, extraHeader?: string, extraHeaders?: Record<string, string>, signal?: AbortSignal): Promise<T>;
  protected abstract saveConfig(): Promise<void>;

  async connect(automaticRetry = false): Promise<void> {
    this.reconnectSuppressed = false;
    this.clearReconnectTimer();
    if (!automaticRetry) this.reconnectAttempt = 0;
    this.teardownConnection();
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
      const manifest = await this.request<{ models: Array<{ id: string; models: string[]; status: string; config_revision: number }>; policy_revision: number }>(
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
      this.reconnectAttempt = 0;
      this.connectedUserId = auth.user_id;
      this.connectedWorkspaceId = auth.workspace.id;
      this.appliedRouteRevision = ticket.route_revision;
      this.requestRouting = {
        mode: workspace.appliedMode === 'desktop' ? 'desktop' : 'server',
        requestContext: this.requestRouting.requestContext
      };
      this.channelMessage = '桌面 AI 模式已连接（模型调用经本机工作进程）。';
      if (workspace.appliedMode !== 'desktop') {
        this.channelMessage = 'WSS 通道已连接；桌面 AI 模式尚未应用。';
      }
      this.channelState = 'ready';
    } catch (error) {
      if (this.connectingAbort === connectingAbort) {
        this.teardownConnection();
        this.channelState = 'error';
        this.channelMessage = safeError(error);
        this.scheduleReconnect();
      }
      throw error;
    }
  }

  async reconnectAfterResume(): Promise<void> {
    if (this.requestRouting.mode !== 'desktop') return;
    await this.connect();
  }

  getChannelHealth(): { state: ChannelState; message: string } {
    return { state: this.channelState, message: this.channelMessage };
  }

  disconnect(): void {
    this.reconnectSuppressed = true;
    this.reconnectAttempt = 0;
    this.clearReconnectTimer();
    this.teardownConnection();
  }

  /** 仅测试/夹具使用（DT-07）：挂起自动重连而不断开连接，模拟「断开后等待手动
   * 重连」的验证场景。生产路径不调用——自动重连策略（reconnect-policy）是正常
   * 产品行为；disconnect() 已含同语义抑制。 */
  suppressReconnectForTest(): void {
    this.reconnectSuppressed = true;
    this.clearReconnectTimer();
  }

  private teardownConnection(): void {
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

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private scheduleReconnect(): void {
    if (this.reconnectSuppressed || this.reconnectTimer) return;
    const delay = channelReconnectDelayMs(this.reconnectAttempt);
    if (delay === null) {
      this.channelState = 'error';
      this.channelMessage = '桌面通道已断开，自动重连失败，请在客户端菜单里重新连接。';
      return;
    }
    this.reconnectAttempt += 1;
    this.channelState = 'connecting';
    this.channelMessage = `桌面通道已断开，正在自动重连（第 ${this.reconnectAttempt} 次）。`;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect(true).then(() => {
        this.reconnectAttempt = 0;
      }).catch(() => this.scheduleReconnect());
    }, delay);
    this.reconnectTimer.unref();
  }

  private async openChannel(
    ticket: string,
    generation: number,
    routeRevision: number,
    configs: Array<{ provider_id: string; config_revision: number }>
  ): Promise<void> {
    const websocketOrigin = this.apiOrigin.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
    const channelUrl = new URL('/api/v1/desktop/channel', websocketOrigin).toString();
    const target = new URL(channelUrl);
    const proxyLookupURL = channelUrl.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:');
    const systemProxy = parseSystemProxyResolution(await this.businessSession.resolveProxy(proxyLookupURL));
    let agent: import('node:https').Agent | undefined;
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
        if (this.channelState !== 'disconnected') {
          this.channelState = 'error';
          // DT-07：suppressReconnectForTest（测试挂起自动重连）时如实显示等待手动重连，
          // 不排自动重连定时器；未抑制时走既有自动重连策略（reconnect-policy）。
          this.channelMessage = this.reconnectSuppressed
            ? '桌面通道已断开，等待手动重连。'
            : '桌面通道已断开，正在尝试自动重连。';
          if (!this.reconnectSuppressed) this.scheduleReconnect();
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
    const message = JSON.parse(raw.toString('utf8')) as ChannelWireMessage;
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

  private async openRequest(message: ChannelWireMessage): Promise<void> {
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
    const pending: ChannelPendingRequest = {
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
    const message = raw as ChannelWorkerMessage;
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

  private grantRequestCredit(pending: ChannelPendingRequest, count: number): void {
    if (pending.requestCredits + count > REQUEST_WINDOW) {
      this.closeProtocol('请求流控额度超过上限。');
      return;
    }
    pending.requestCredits += count;
    this.sendControl({ type: 'credit', request_id: pending.id, direction: 'request', count });
  }

  private requestEnded(message: ChannelWireMessage): void {
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

  private sendUpstreamError(pending: ChannelPendingRequest): void {
    if (!this.pending.has(pending.id) || !pending.upstreamErrorCode) return;
    this.sendControl({ type: 'upstream.error', request_id: pending.id, error_code: pending.upstreamErrorCode });
    this.removePending(pending);
  }

  private sendRequestError(pending: ChannelPendingRequest): void {
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

  private consumeControlToken(budget: ChannelControlBudget): boolean {
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

  private removePending(pending: ChannelPendingRequest): void {
    this.pending.delete(pending.id);
    this.completedRequestIds.add(pending.id);
    if (this.completedRequestIds.size > MAX_COMPLETED_REQUEST_IDS) {
      const oldest = this.completedRequestIds.values().next().value;
      if (oldest) this.completedRequestIds.delete(oldest);
    }
  }

  private rememberImageParent(pending: ChannelPendingRequest): void {
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
  }

  private purgeImageParents(): void {
    const now = Date.now();
    for (const [id, parent] of this.imageParents) {
      if (parent.expiresAt <= now) {
        clearTimeout(parent.timer);
        this.imageParents.delete(id);
      }
    }
  }

  private clearImageParent(requestId: string): void {
    const parent = this.imageParents.get(requestId);
    if (!parent) return;
    clearTimeout(parent.timer);
    this.imageParents.delete(requestId);
  }

  protected clearImageParents(): void {
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
    const worker = utilityProcess.fork(path.join(__dirname, '..', 'ai-worker.js'), [], {
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

  protected async resolveModelProxy(target: string | undefined, model: StoredModel | undefined): Promise<import('../proxy').ProxyRoute | null> {
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
    const proxy: import('../proxy').ProxyRoute = { url: normalizeProxyUrl(model.proxyUrl) };
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

  private requireSocket(): WebSocket {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('桌面通道未连接。');
    }
    return this.socket;
  }

  private getPending(id?: string): ChannelPendingRequest {
    const requestId = normalizeUuid(id);
    const pending = requestId ? this.pending.get(requestId) : undefined;
    if (!pending) throw new Error('桌面通道收到未知请求。');
    return pending;
  }
}

function isLoopbackName(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '::1' || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

void safeStorage;
