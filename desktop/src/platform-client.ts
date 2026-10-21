// 平台采集的本机协议客户端（D-129 / 20 文档 §10.3、§11.2）。
// 只做「领取 → 续租 → 提交批次 → 查回执」的协议与租约，不含浏览器与 profile（属 PS04）。
// 每个请求都重新申请设备证明；已消费的挑战不能复用。

import type {
  PlatformCollectionCapability
} from './platform-capability';
import {
  PlatformCollectionUnsupportedError,
  resolvePlatformEndpoint
} from './platform-capability';

export const PLATFORM_PROTOCOL_VERSION = 1;

// 服务端下发的固定动作与冻结目标；客户端不得自行扩大。
export interface PlatformClaimedRun {
  id: string;
  connection_id: string;
  account_id: string;
  platform: 'wechat_mp' | 'xhs';
  trigger: 'manual' | 'daily' | 'node' | 'reconnect';
  task_kind: 'probe' | 'discover' | 'collect';
  lease_generation: number;
  lease_expires_at: string | null;
  deadline_at: string | null;
  authorization_revision: number;
  adapter_version: string;
  mapping_version: number;
  query_scope: unknown;
  binding_snapshot: unknown;
  budget: { max_rows: number; max_bytes: number; max_duration_seconds: number };
}

export interface PlatformObservationDraft {
  row_no: number;
  scope: 'account' | 'work';
  external_account_key: string;
  external_id?: string;
  binding_revision?: number;
  publish_revision?: number;
  source: string;
  temporal_kind: 'cumulative' | 'interval' | 'current_total';
  observed_at: string;
  as_of_at?: string;
  window_start?: string;
  window_end?: string;
  adapter_version: string;
  mapping_version: number;
  values: Record<string, unknown>;
  field_paths: Record<string, string>;
}

export interface PlatformResultBatch {
  protocol_version: number;
  lease_generation: number;
  authorization_revision: number;
  batch_seq: number;
  final_batch: boolean;
  run_status: 'succeeded' | 'partial' | 'failed' | 'canceled';
  stop_reason?: string | null;
  error_code?: string | null;
  coverage?: Record<string, unknown>;
  observations: PlatformObservationDraft[];
}

export interface PlatformReceipt {
  batch_seq: number;
  receipt_id: string;
  accepted: number;
  pending: number;
  rejected: number;
  duplicate: number;
  run_status: string;
  // auto_adopt 开启时，投影失败的行数与第一条原因（服务端 DEV-PS46 起返回）。
  // 观测本身已入库（accepted 仍计入），但没进正式指标。
  // 不消费这两个字段的话，用户只会看到"采集成功"，以为数据已生效——
  // 这类"静默半成功"比彻底失败更难发现。
  adopt_errors?: number;
  adopt_reason?: string;
}

// signedRequest 由主进程实现：拿到授权信息、设备密钥并完成一次挑战握手。
// 采集工作进程不持有 OPS Cookie、密码或设备私钥，全部由主进程代办。
export interface PlatformSignedRequest {
  (operation: string, method: string, path: string, body: unknown): Promise<unknown>;
}

const MAX_FINAL_BATCH_RETRIES = 1;

export class PlatformClient {
  private readonly capability: PlatformCollectionCapability;
  private readonly sign: PlatformSignedRequest;
  private currentRun: PlatformClaimedRun | null = null;
  private nextBatchSeq = 0;
  private acceptedRows = 0;

  constructor(capability: PlatformCollectionCapability, sign: PlatformSignedRequest) {
    if (!capability.enabled) {
      throw new PlatformCollectionUnsupportedError('服务端尚未启用平台数据采集。');
    }
    this.capability = capability;
    this.sign = sign;
  }

  async presence(): Promise<void> {
    const endpoint = resolvePlatformEndpoint(this.capability, 'platform.presence');
    await this.sign('platform.presence', endpoint.method, endpoint.path, {});
  }

  // adopt 接管一条**已经在别处领取**的 run。
  //
  // 后台循环先用一个 client 实例 claim，再把 run 交给采集流程；采集流程内部会新建自己的
  // client（它要独立的提交状态）。那个新实例必须知道"已经有一条 run 在手"，
  // 否则 heartbeat/submit 会报"当前没有已领取的平台采集任务"。
  adopt(run: PlatformClaimedRun): void {
    this.currentRun = run;
    this.nextBatchSeq = 0;
    this.acceptedRows = 0;
  }

  // claim 一次只取一条 run；没有任务时返回 null，调用方等下个 60 秒轮询。
  async claim(): Promise<PlatformClaimedRun | null> {
    const endpoint = resolvePlatformEndpoint(this.capability, 'platform.run.claim');
    const payload = (await this.sign('platform.run.claim', endpoint.method, endpoint.path, {})) as {
      run?: PlatformClaimedRun | null;
    };
    if (!payload.run) {
      this.currentRun = null;
      return null;
    }
    this.currentRun = payload.run;
    this.nextBatchSeq = 0;
    this.acceptedRows = 0;
    return payload.run;
  }

  // heartbeat 返回取消状态；取消后必须立即停止并在终批报告 canceled。
  async heartbeat(): Promise<{ canceled: boolean; leaseExpiresAt: string | null }> {
    const run = this.requireRun();
    const endpoint = this.runEndpoint(run, 'heartbeat');
    const payload = (await this.sign('platform.run.heartbeat', endpoint.method, endpoint.path, {
      lease_generation: run.lease_generation
    })) as { canceled?: boolean; lease_expires_at?: string | null };
    return { canceled: payload.canceled === true, leaseExpiresAt: payload.lease_expires_at ?? null };
  }

  // submit 提交一个批次。终批失败（响应丢失）时只在同内容下重试一次，
  // 服务端按 (run, generation, batch_seq) 幂等，重试不会重复写观测。
  async submit(batch: Omit<PlatformResultBatch, 'protocol_version' | 'lease_generation' | 'authorization_revision' | 'batch_seq'>): Promise<PlatformReceipt> {
    const run = this.requireRun();
    if (this.acceptedRows + batch.observations.length > run.budget.max_rows) {
      throw new Error('本次任务已达读取预算，请以 partial 结束并保存游标。');
    }
    const body: PlatformResultBatch = {
      protocol_version: PLATFORM_PROTOCOL_VERSION,
      lease_generation: run.lease_generation,
      authorization_revision: run.authorization_revision,
      batch_seq: this.nextBatchSeq,
      ...batch
    };
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_FINAL_BATCH_RETRIES; attempt += 1) {
      try {
        const receipt = await this.sendBatch(run, body);
        this.nextBatchSeq += 1;
        this.acceptedRows += receipt.accepted;
        return receipt;
      } catch (error) {
        lastError = error;
        // 只在终批重试：非终批重试会让游标与批次序错位。
        if (!body.final_batch) break;
      }
    }
    throw lastError;
  }

  // receipt 在网络失败后查询已提交批次的回执；它不延长租约。
  async receipt(batchSeq: number): Promise<PlatformReceipt | null> {
    const run = this.requireRun();
    const endpoint = this.runEndpoint(run, 'receipt', batchSeq);
    try {
      return (await this.sign('platform.run.receipt', endpoint.method, endpoint.path, {})) as PlatformReceipt;
    } catch {
      return null;
    }
  }

  private async sendBatch(run: PlatformClaimedRun, body: PlatformResultBatch): Promise<PlatformReceipt> {
    const endpoint = this.runEndpoint(run, 'results');
    return (await this.sign('platform.run.result', endpoint.method, endpoint.path, body)) as PlatformReceipt;
  }

  private runEndpoint(run: PlatformClaimedRun, action: 'heartbeat' | 'results' | 'receipt', seq?: number): { method: string; path: string } {
    switch (action) {
      case 'heartbeat':
        return { method: 'POST', path: `/api/v1/desktop/platform/runs/${encodeURIComponent(run.id)}/heartbeat` };
      case 'results':
        return { method: 'POST', path: `/api/v1/desktop/platform/runs/${encodeURIComponent(run.id)}/results` };
      case 'receipt':
        if (!Number.isInteger(seq) || (seq as number) < 0) throw new Error('回执序号无效。');
        return { method: 'GET', path: `/api/v1/desktop/platform/runs/${encodeURIComponent(run.id)}/receipts/${seq}` };
    }
  }

  private requireRun(): PlatformClaimedRun {
    if (!this.currentRun) throw new Error('当前没有已领取的平台采集任务。');
    return this.currentRun;
  }
}

// buildFailedBatch 是失败终批的固定形状：可以带 0 条观测，服务端据此把 run 置终态。
export function buildFailedBatch(
  leaseGeneration: number,
  authorizationRevision: number,
  batchSeq: number,
  outcome: { status: 'failed' | 'canceled' | 'partial'; stopReason: string; errorCode: string | null; observations?: PlatformObservationDraft[] }
): PlatformResultBatch {
  return {
    protocol_version: PLATFORM_PROTOCOL_VERSION,
    lease_generation: leaseGeneration,
    authorization_revision: authorizationRevision,
    batch_seq: batchSeq,
    final_batch: true,
    run_status: outcome.status,
    stop_reason: outcome.stopReason,
    error_code: outcome.errorCode,
    observations: outcome.observations ?? []
  };
}
