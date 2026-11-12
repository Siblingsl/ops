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

/** DT-04：UIA 控件树读取视图（C09 脱敏口径：不含进程路径/窗口全集/截图）。 */
export interface UiaView {
  ok: boolean;
  window?: string;
  controls?: Array<{ id: string; type: string; name: string; value: string }>;
  error?: string;
}

/** CF-DESK-04：窗口级截图摘要（C09：只含选中目标的必要摘要，绝不含截图原文）。 */
export interface WindowCaptureView {
  ok: boolean;
  schema?: string;
  capture_id?: string;
  run_id?: string;
  window_digest?: string;
  byte_size?: number;
  width?: number;
  height?: number;
  bounds?: { x: number; y: number; w: number; h: number };
  captured_at?: string;
  revision?: number;
  error?: string;
}

export interface WindowCaptureRequest {
  pid: number;
  target_summary: string;
  grant_id: string;
  run_id: string;
}

/** CF-DESK-05：C09 脱敏证据（固定白名单；不含原图 / 标题 / 进程路径 / 其它窗口清单）。 */
export interface CaptureRedactionEvidence {
  ok: boolean;
  schema?: string;
  capture_id?: string;
  run_id?: string;
  window_digest?: string;
  image_digest?: string;
  width?: number;
  height?: number;
  byte_size?: number;
  checks?: string[];
  coverage?: string;
  revision?: number;
  captured_at?: string;
  error?: string;
}

export class ComputerWorkerHost extends EventEmitter {
  private worker: UtilityProcess | null = null;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private nextID = 1;

  private ensureWorker(): UtilityProcess {
    if (this.worker) return this.worker;
    // DEV-CU P2-0：worker 已拆为目录（index/native/policy），入口指向目录内的 index.js。
    const child = utilityProcess.fork(path.join(__dirname, 'computer-worker', 'index.js'), [], {
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

  private call(cmd: string, payload?: Record<string, unknown>, timeoutMs = 15_000): Promise<unknown> {
    const worker = this.ensureWorker();
    const id = `w${this.nextID++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('worker_timeout'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, cmd, ...(payload ?? {}) });
    });
  }

  /** 枚举本机可见窗口（脱敏摘要 + 硬禁区标记）。C09：清单不上传服务端。 */
  async listWindows(): Promise<WindowSummary[]> {
    const result = (await this.call('list_windows')) as { windows?: WindowSummary[] };
    return result.windows ?? [];
  }

  async ping(): Promise<boolean> {
    const result = (await this.call('ping', undefined, 5000)) as { pong?: boolean };
    return Boolean(result.pong);
  }

  /** DT-04（W17c / 27 §11.5.2）：读取目标进程主窗口 UIA 控件树。worker 侧已有
   * 硬禁区二次校验与 200 项上限；此处只按协议转发，不做业务判断。 */
  async readUIA(pid: number, targetSummary: string): Promise<UiaView> {
    return await this.call('uia_read', { pid, target_summary: targetSummary }) as UiaView;
  }

  /** DT-04：单控件动作（ValuePattern.SetValue / InvokePattern.Invoke）。
   * 服务端批准票据属第二批（agent_computer.go:18）；本层只暴露本机通道。 */
  async invokeUIA(pid: number, automationId: string, value: string | null, targetSummary: string): Promise<{ ok: boolean; action?: string; error?: string }> {
    return await this.call('uia_invoke', { pid, automation_id: automationId, value, target_summary: targetSummary }) as { ok: boolean; action?: string; error?: string };
  }

  /** CF-DESK-04（A-03 前置）：窗口级截图，固定意图、只回脱敏摘要。
   * 刻意**不新增** main IPC / preload 白名单 / 服务端出口：原图只在隔离 worker 进程内可达，
   * 渲染器与模型通道的接线属 DT-04 / 后续立项（27 §11.5.2「Electron 只暴露固定意图」）。 */
  async captureWindow(input: WindowCaptureRequest): Promise<WindowCaptureView> {
    return await this.call('capture_window', {
      pid: input.pid,
      target_summary: input.target_summary,
      grant_id: input.grant_id,
      run_id: input.run_id,
    }) as WindowCaptureView;
  }

  /** 失权 / handoff / 锁屏：撤销该 grant 下全部窗口截图（C09 拒绝历史越权读取）。 */
  async invalidateCaptures(grantId: string): Promise<{ ok: boolean; cleared?: number; error?: string }> {
    return await this.call('capture_invalidate', { grant_id: grantId }) as { ok: boolean; cleared?: number; error?: string };
  }

  /** CF-DESK-05（C09 脱敏校验）：取该次截图的脱敏证据。固定意图，只回摘要，不回原文；
   * 同样不新增 main IPC / preload 白名单 / 服务端出口（DT-04 仍待立项）。 */
  async captureEvidence(captureId: string, grantId: string): Promise<CaptureRedactionEvidence> {
    return await this.call('capture_evidence', { capture_id: captureId, grant_id: grantId }) as CaptureRedactionEvidence;
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
