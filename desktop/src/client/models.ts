import { safeStorage } from 'electron';
import { prepareDesktopRouteApplication, type DesktopRouteSelection } from '../request-context';
import { normalizeProxyUrl } from '../proxy';
import { isIP } from 'node:net';
import WebSocket from 'ws';
import type { DesktopMode } from '../request-context';
import { ChannelMixin, PROTOCOL_VERSION } from './channel';
import type {
  AuthInfo,
  BusinessAccount,
  AccountTypeChangeResult,
  DesktopRoute,
  DesktopRouteState,
  ModelManifestEntry,
  PublicModel,
  SaveModelInput,
  StoredAccount,
  StoredDevice,
  StoredModel,
  StoredWorkspace,
  ConfigDocument
} from '../desktop-client';

// DT-08 片 6（docs/33 §10.8 DT-08）：desktop-client.ts 的模型/路由域拆分。
// routes/test/applyMode/restoreAppliedMode/listModels/saveModel/deleteModel 与
// 模型端点/CDN 白名单校验助手整体搬到 ModelsMixin；façade 继承之，行为逐字节搬移。
// 跨域抽象方法（通道/签名/配置）由 ChannelMixin 与 façade 提供。

type ChannelCtor = abstract new (...args: any[]) => ChannelMixin;

export function ModelsMixin<T extends ChannelCtor>(Base: T) {
  abstract class ModelsMixin extends Base {
  abstract readonly configPath: string;
  abstract configPromise: Promise<ConfigDocument> | null;

  protected abstract loadConfig(): Promise<ConfigDocument>;
  protected abstract saveConfig(): Promise<void>;

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
        url: this.apiOrigin,
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

  protected toPublicModel(model: StoredModel): PublicModel {
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
    const missing = 8 - values.length;
    if (missing < 0 || halves.length === 1 && missing !== 0 || halves.length === 2 && missing < 1) return null;
    return [...values, ...Array<number>(missing).fill(0)];
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

  return ModelsMixin;
}
