import { safeStorage } from 'electron';
import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { app } from 'electron';
import {
  PlatformCollectionUnsupportedError,
  parsePlatformCollectionCapability,
  resolvePlatformEndpoint,
  type PlatformCollectionCapability
} from '../platform-capability';
import { ModelsMixin } from './models';
import type { AuthInfo, StoredDevice } from '../desktop-client';

// DT-08 片 7（docs/33 §10.8 DT-08）：desktop-client.ts 的平台域拆分。
// 平台采集能力/平台设备登记/连接 CRUD/同步触发/presence/平台签名请求整体搬到
// PlatformMixin（基于 ModelsMixin 链）；行为逐字节搬移。跨域抽象（request/getAuthInfo/
// getWorkspace/saveConfig/decrypt/signedRequest）由下层提供。

const PLATFORM_PROTOCOL_VERSION = 1;
const API_PREFIX = '/api/v1';

export function stableUuid(input: string): string {
  const hex = createHash('sha256').update(input).digest('hex');
  const variant = ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

type ChannelInstance = import('./channel').ChannelMixin;

export function PlatformMixin<T extends abstract new (...args: any[]) => ChannelInstance>(Base: T) {
  abstract class PlatformMixin extends Base {
    protected abstract getAuthInfo(signal?: AbortSignal): Promise<AuthInfo>;
    protected abstract getWorkspace(auth: AuthInfo): Promise<{ account: import('../desktop-client').StoredAccount; workspace: import('../desktop-client').StoredWorkspace; accountKey: string }>;
    protected abstract saveConfig(): Promise<void>;
    protected abstract decrypt(encrypted: string): string;
    protected abstract request<T>(pathName: string, init?: RequestInit): Promise<T>;
    protected abstract signedRequest<T>(auth: AuthInfo, device: StoredDevice, operation: string, method: string, pathName: string, bodyValue?: unknown, publicKey?: string, extraHeaders?: Record<string, string>, signal?: AbortSignal, purpose?: string): Promise<T>;
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
  }
  return PlatformMixin;
}
