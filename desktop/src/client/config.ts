import { app, safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ManagementRequestRegistry } from '../request-context';
import { ChannelMixin } from './channel';
import type { AuthInfo, StoredAccount, StoredWorkspace, ConfigDocument } from '../desktop-client';

// DT-08 片 11（docs/33 §10.8 DT-08）：desktop-client.ts 的 config/管理请求域拆分。
// 本机配置文档（desktop-config.json）的读取/原子写、safeStorage 解密、工作区定位、
// 会话 fetch 封装（含桌面管理请求标记）与标记核验整体搬到 ConfigMixin。
// DesktopClient 继承链变为 ConfigMixin ← ChannelMixin ← ModelsMixin ← PlatformMixin：
// 本类是链底层（不依赖上层域），行为逐字节搬移。

export const API_PREFIX = '/api/v1';

export function apiErrorMessage(payload: unknown, status: number): string {
  if (payload && typeof payload === 'object' && 'error' in payload) {
    const error = (payload as { error?: { message?: unknown; code?: unknown } }).error;
    if (error && typeof error.message === 'string') return error.message.slice(0, 300);
  }
  return `线上服务请求失败（HTTP ${status}）。`;
}

export function ConfigMixin<T extends abstract new (...args: any[]) => ChannelMixin>(Base: T) {
  abstract class ConfigMixin extends Base {
    readonly configPath = path.join(app.getPath('userData'), 'desktop-config.json');
    configPromise: Promise<ConfigDocument> | null = null;
    readonly managementRequests: ManagementRequestRegistry = new ManagementRequestRegistry('');

    protected abstract readonly businessSession: import('electron').Session;
    protected abstract readonly apiOrigin: string;
    protected abstract readonly serviceNamespace: string;

    consumeManagementRequestMarker(marker: string, requestUrl: string, method: string): boolean {
      return this.managementRequests.consume(marker, requestUrl, method);
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

    async getAccount(auth: AuthInfo): Promise<StoredAccount> {
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
  return ConfigMixin;
}

