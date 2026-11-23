// REF41 I1-A5：桌面端竞对观测任务协议客户端。
//
// 只接受渲染主进程注入的签名调用（platformSignedCall），不自行发 HTTP；
// claim/heartbeat/results 的路径与设备证明操作由服务端 desktop_proof.go 登记。
// 解析失败/页面失败也走 results，把 quality_state 如实写成 failed，绝不伪造 ok。

import type { PublicBenchmarkNote } from './benchmark-observe';

export interface BenchmarkObserveTask {
  task_id: string;
  target_id: string;
  url: string;
  platform: string;
  lease_token: string;
  lease_expires_at?: string | null;
}

export interface BenchmarkObserveResultInput {
  external_id: string;
  title: string;
  url: string;
  published_at: string | null;
  values: Record<string, number>;
  quality_state: 'ok' | 'partial' | 'failed';
  structure: Record<string, unknown>;
}

export type SignedBenchmarkCall = (
  operation: string, method: string, path: string, body: unknown
) => Promise<unknown>;

const CLAIM_PATH = '/api/v1/desktop/benchmark/tasks/claim';

export class BenchmarkObserveClient {
  constructor(private readonly sign: SignedBenchmarkCall) {}

  async claim(): Promise<BenchmarkObserveTask | null> {
    const payload = await this.sign('benchmark.observe.claim', 'POST', CLAIM_PATH, {}) as {
      task?: BenchmarkObserveTask | null;
    };
    const task = payload?.task;
    if (!task || typeof task !== 'object') return null;
    if (!task.task_id || !task.lease_token || !task.url || !task.platform) {
      throw new Error('benchmark claim 返回的任务字段不完整。');
    }
    return task;
  }

  async heartbeat(task: BenchmarkObserveTask): Promise<void> {
    await this.sign(
      'benchmark.observe.heartbeat', 'POST',
      `/api/v1/desktop/benchmark/tasks/${encodeURIComponent(task.task_id)}/heartbeat`,
      { lease_token: task.lease_token }
    );
  }

  async results(task: BenchmarkObserveTask, note: PublicBenchmarkNote): Promise<void> {
    const values: Record<string, number> = {};
    for (const [key, value] of Object.entries(note.values)) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) values[key] = value;
    }
    const body: BenchmarkObserveResultInput & { lease_token: string } = {
      lease_token: task.lease_token,
      external_id: note.externalId,
      title: note.title,
      url: note.url,
      published_at: note.publishedAt,
      values: note.quality === 'failed' ? {} : values,
      quality_state: note.quality,
      structure: { source: 'public_page', platform: task.platform, error_code: note.errorCode ?? null }
    };
    await this.sign(
      'benchmark.observe.result', 'POST',
      `/api/v1/desktop/benchmark/tasks/${encodeURIComponent(task.task_id)}/results`,
      body
    );
  }
}

export function publicNoteFromTask(task: BenchmarkObserveTask, note: PublicBenchmarkNote): PublicBenchmarkNote {
  return {
    ...note,
    title: note.title || `竞对公开页 ${task.platform}`,
    url: note.url || task.url
  };
}
