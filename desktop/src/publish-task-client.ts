// REF41 P2：桌面发布任务协议客户端。
// 只负责 claim / heartbeat / results 的信封解析、租约状态与幂等键；
// 页面操作仍由 PublishPagePort/适配器负责，这里不碰 DOM、不写数据库。
import { randomUUID } from 'node:crypto';
import { resolvePlatformEndpoint, type PlatformCollectionCapability } from './platform-capability';
import type { PublishTaskEnvelope } from './publish/executor';
import type { BrowserPolicyCheckInput, PublishFillResult } from './publish/types';

export interface PublishTaskSignedRequest {
  (operation: string, method: string, path: string, body: unknown): Promise<unknown>;
}

export interface PublishTaskClaim extends PublishTaskEnvelope {
  /** 服务端任务状态版本；心跳与结果必须原样回传，不能用本地推断值。 */
  stateVersion: number;
  leaseExpiresAt: string | null;
  manifestRevision: number;
  manifestContentHash: string;
  /** 活跃平台连接的稳定身份；页面必须用它核对，不能用可改名的 OPS 账号名。 */
  externalAccountKey: string;
  /** 本次 claim 是普通填写还是用户显式 submit-now 的一次性提交。 */
  intent: 'fill' | 'submit';
  /** manifest 图片；服务端随 claim 下发，桌面写临时文件后交给 CDP 上传。 */
  assets: PublishTaskAsset[];
}

export interface PublishTaskAsset {
  assetId: string;
  role: string;
  mime: string;
  width: number;
  height: number;
  sha256: string;
  data: Buffer;
}

interface PublishTaskWire {
  id?: unknown;
  workspace_id?: unknown;
  account_id?: unknown;
  work_id?: unknown;
  platform?: unknown;
  state?: unknown;
  state_version?: unknown;
  mode?: unknown;
  manifest?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`发布任务缺少 ${field}`);
  return value;
}

function parseClaimAssets(value: unknown): PublishTaskAsset[] {
  if (!Array.isArray(value)) return [];
  const out: PublishTaskAsset[] = [];
  for (const item of value) {
    const record = asRecord(item);
    const assetId = typeof record.asset_id === 'string' ? record.asset_id : '';
    const encoded = typeof record.data === 'string' ? record.data : '';
    if (!assetId || !encoded) continue;
    const data = Buffer.from(encoded, 'base64');
    if (data.length === 0) continue;
    out.push({
      assetId,
      role: typeof record.role === 'string' ? record.role : 'inline',
      mime: typeof record.mime === 'string' ? record.mime : 'image/jpeg',
      width: typeof record.width === 'number' ? record.width : 0,
      height: typeof record.height === 'number' ? record.height : 0,
      sha256: typeof record.sha256 === 'string' ? record.sha256 : '',
      data
    });
  }
  return out;
}

export function parsePublishTaskClaim(payload: unknown): PublishTaskClaim | null {
  const root = asRecord(payload);
  if (root.task === null || root.task === undefined) return null;
  const task = asRecord(root.task) as PublishTaskWire;
  const stateVersion = task.state_version;
  if (typeof stateVersion !== 'number' || !Number.isInteger(stateVersion) || stateVersion < 1) {
    throw new Error('发布任务 state_version 无效');
  }
  const mode = requiredString(task.mode, 'mode');
  if (mode !== 'api' && mode !== 'desktop' && mode !== 'manual') throw new Error(`发布任务 mode 无效：${mode}`);
  const manifest = asRecord(root.manifest);
  if (Object.keys(manifest).length === 0) throw new Error('发布任务缺少 manifest');
  const revision = root.manifest_revision;
  const contentHash = root.manifest_content_hash;
  return {
    taskId: requiredString(task.id, 'task id'),
    workspaceId: requiredString(task.workspace_id, 'workspace_id'),
    accountId: requiredString(task.account_id, 'account_id'),
    workId: requiredString(task.work_id, 'work_id'),
    platform: requiredString(task.platform, 'platform'),
    manifest,
    mode,
    accountName: typeof root.account_name === 'string' ? root.account_name : undefined,
    stateVersion,
    leaseExpiresAt: typeof root.lease_expires_at === 'string' ? root.lease_expires_at : null,
    manifestRevision: typeof revision === 'number' ? revision : 0,
    manifestContentHash: typeof contentHash === 'string' ? contentHash : '',
    externalAccountKey: typeof root.external_account_key === 'string' ? root.external_account_key : '',
    intent: root.intent === 'submit' ? 'submit' : 'fill',
    assets: parseClaimAssets(root.assets)
  };
}

export function toServerPublishResult(result: PublishFillResult): {
  to: 'filled' | 'failed' | 'not_logged_in' | 'submitted';
  evidence: Record<string, unknown>;
  errorCode: string;
  errorMessage: string;
} {
  const readbackOK = result.readback?.ok === true
    || (result.evidence?.readback_ok === true);
  const evidence = { ...(result.evidence ?? {}) };
  if (readbackOK) evidence.readback_ok = true;

  // P6-A3：只有显式 submit-now 的提交分支会返回 submitted；服务端还会校验
  // 任务处于 filled 且 submit_intent 已由本设备领取，客户端不能自行升级。
  if (result.state === 'submitted') {
    return { to: 'submitted', evidence, errorCode: '', errorMessage: '' };
  }
  // 服务端 publish.task.result 只接受 filled/failed/not_logged_in/submitted。
  // 适配器把“已填入、等待用户点发布”表达为 awaiting_user；桌面队列拿到
  // readback.ok=true 时必须落成 filled，不能把 awaiting_user 直接发给服务端。
  if (result.state === 'filled' || (result.state === 'awaiting_user' && readbackOK)) {
    return { to: 'filled', evidence, errorCode: result.errorCode ?? '', errorMessage: result.errorMessage ?? '' };
  }
  if (result.state === 'not_logged_in' || result.errorCode === 'platform_login_required') {
    return {
      to: 'not_logged_in',
      evidence,
      errorCode: result.errorCode || 'platform_login_required',
      errorMessage: result.errorMessage || '平台登录态已失效'
    };
  }
  return {
    to: 'failed',
    evidence,
    errorCode: (result.errorCode || 'desktop_publish_not_completed').slice(0, 80),
    errorMessage: (result.errorMessage || '桌面发布未完成，未向平台提交').slice(0, 500)
  };
}

export class PublishTaskClient {
  private current: PublishTaskClaim | null = null;

  constructor(
    private readonly capability: PlatformCollectionCapability,
    private readonly sign: PublishTaskSignedRequest
  ) {}

  adopt(task: PublishTaskClaim): void {
    this.current = task;
  }

  claimed(): PublishTaskClaim | null {
    return this.current;
  }

  async claim(): Promise<PublishTaskClaim | null> {
    const endpoint = resolvePlatformEndpoint(this.capability, 'publish.task.claim');
    const payload = await this.sign('publish.task.claim', endpoint.method, endpoint.path, {
      idempotency_key: randomUUID()
    });
    const task = parsePublishTaskClaim(payload);
    this.current = task;
    return task;
  }

  async heartbeat(): Promise<{ leaseExpiresAt: string | null }> {
    const task = this.requireTask();
    const endpoint = resolvePlatformEndpoint(this.capability, 'publish.task.heartbeat');
    const path = endpoint.path.replace('{id}', encodeURIComponent(task.taskId));
    const payload = asRecord(await this.sign('publish.task.heartbeat', endpoint.method, path, {
      state_version: task.stateVersion,
      idempotency_key: randomUUID()
    }));
    return { leaseExpiresAt: typeof payload.lease_expires_at === 'string' ? payload.lease_expires_at : null };
  }

  async result(result: PublishFillResult): Promise<void> {
    const task = this.requireTask();
    const endpoint = resolvePlatformEndpoint(this.capability, 'publish.task.result');
    const path = endpoint.path.replace('{id}', encodeURIComponent(task.taskId));
    const mapped = toServerPublishResult(result);
    await this.sign('publish.task.result', endpoint.method, path, {
      to: mapped.to,
      state_version: task.stateVersion,
      idempotency_key: randomUUID(),
      evidence: mapped.evidence,
      error_code: mapped.errorCode,
      error_message: mapped.errorMessage
    });
    this.current = null;
  }

  /** REF41 F5：Preflight 的三道闸检查。拒绝由服务端写审计；客户端只决定是否执行。 */
  async checkBrowserPolicy(input: BrowserPolicyCheckInput): Promise<{ ok: boolean; reason?: string }> {
    const endpoint = resolvePlatformEndpoint(this.capability, 'browser.policy.check');
    const payload = asRecord(await this.sign('browser.policy.check', endpoint.method, endpoint.path, {
      account_id: input.accountId,
      purpose: input.purpose,
      url: input.url,
      tab_count: input.tabCount,
      action: input.action ?? ''
    }));
    return {
      ok: payload.ok === true,
      reason: typeof payload.reason === 'string' ? payload.reason : undefined
    };
  }

  private requireTask(): PublishTaskClaim {
    if (!this.current) throw new Error('当前没有已领取的发布任务');
    return this.current;
  }
}
