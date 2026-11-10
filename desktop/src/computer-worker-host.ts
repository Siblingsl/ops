import { utilityProcess, type UtilityProcess } from 'electron';
import { EventEmitter } from 'node:events';
import * as path from 'node:path';

// DEV-AI27-17 第二批（W17b）：电脑控制 worker 宿主（Electron utilityProcess 桥）。
// 与 ai-worker 同模式：独立进程 + 固定消息协议 {id, cmd} → {id, ok, ...}。
// worker 只回收自己启动的实例；渲染器经固定 IPC（main.ts 接线）间接访问，无直接通道。
// 用 utilityProcess 而不是 child_process.fork：前者能加载 asar 内的 worker 文件，
// 且不需要在 worker 里额外处理 ELECTRON_RUN_AS_NODE。

export interface WindowSummary {
  pid: number;
  process: string;
  title: string;
  forbidden: boolean;
}

export class ComputerWorkerHost extends EventEmitter {
  private worker: UtilityProcess | null = null;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private nextID = 1;

  private ensureWorker(): UtilityProcess {
    if (this.worker) return this.worker;
    const child = utilityProcess.fork(path.join(__dirname, 'computer-worker.js'), [], {
      serviceName: 'OPS Desktop computer worker',
      stdio: 'ignore',
      env: { OPS_DESKTOP_WORKER: '1' },
    });
    this.worker = child;
    child.on('message', (msg: { id?: string; ok?: boolean; error?: string; [k: string]: unknown }) => {
      if (!msg || typeof msg.id !== 'string') return;
      const call = this.pending.get(msg.id);
      if (!call) return;
      this.pending.delete(msg.id);
      clearTimeout(call.timer);
      if (msg.ok) call.resolve(msg);
      else call.reject(new Error(String(msg.error ?? 'worker_error')));
    });
    child.on('exit', () => {
      if (this.worker !== child) return;
      this.worker = null;
      for (const [, call] of this.pending) {
        clearTimeout(call.timer);
        call.reject(new Error('worker_exit'));
      }
      this.pending.clear();
      this.emit('exit');
    });
    return child;
  }

  private call(cmd: string, timeoutMs = 15_000): Promise<unknown> {
    const worker = this.ensureWorker();
    const id = `w${this.nextID++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('worker_timeout'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, cmd });
    });
  }

  /** 枚举本机可见窗口（脱敏摘要 + 硬禁区标记）。C09：清单不上传服务端。 */
  async listWindows(): Promise<WindowSummary[]> {
    const result = (await this.call('list_windows')) as { windows?: WindowSummary[] };
    return result.windows ?? [];
  }

  async ping(): Promise<boolean> {
    const result = (await this.call('ping', 5000)) as { pong?: boolean };
    return Boolean(result.pong);
  }

  stop(): void {
    if (this.worker) {
      try {
        this.worker.kill();
      } catch { /* 已退出 */ }
      this.worker = null;
    }
  }
}
