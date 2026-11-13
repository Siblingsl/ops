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

/** DEV-CU P2-7：§4.5 观察树节点。字段集照契约，不含 process_path / class_name / 标题。 */
export interface ObserveNode {
  role: string;
  name: string;
  value: string;
  ref_id: string;
  available_actions: string[];
  states: string[];
  bounds: { x: number; y: number; w: number; h: number };
  bounds_hash?: string;
  children: ObserveNode[];
  children_count: number;
}

/** DEV-CU P2-7：`uia_observe` 输出视图（§4.5）。 */
export interface ObserveView {
  ok: boolean;
  snapshot_id?: string;
  revision?: number;
  ref_count?: number;
  complete?: boolean;
  nodes_observed?: number;
  truncated?: boolean;
  identity_unproven?: boolean;
  tree?: ObserveNode;
  error?: string;
}

export interface ObserveRequest {
  pid: number;
  target_summary: string;
  grant_id: string;
  generation: number;
  max_depth?: number;
  root_ref?: string;
  interactive_only?: boolean;
  compact?: boolean;
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
      // 必须继承主进程环境：worker 内要用 powershell 做 UIA/窗口枚举，
      // 只传 OPS_DESKTOP_WORKER 会丢掉 PATH/SystemRoot，execFile 直接 ENOENT。
      env: { ...process.env, OPS_DESKTOP_WORKER: '1' },
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

  /** DEV-CU P2-7（§P2-7 步骤 4）：`uia_observe` 转发。超时按 §4.10 常量表取 3s——
   * 一次整窗读树 + 裁剪 + 分配 ref 都在这个预算内，超过就当目标应用无响应。
   * 不做业务判断：入参合法性由调用方（IPC 层）与 worker 各校验一次。 */
  async observe(input: ObserveRequest): Promise<ObserveView> {
    return await this.call('uia_observe', {
      pid: input.pid,
      target_summary: input.target_summary,
      grant_id: input.grant_id,
      generation: input.generation,
      ...(input.max_depth === undefined ? {} : { max_depth: input.max_depth }),
      ...(input.root_ref === undefined ? {} : { root_ref: input.root_ref }),
      ...(input.interactive_only === undefined ? {} : { interactive_only: input.interactive_only }),
      ...(input.compact === undefined ? {} : { compact: input.compact }),
    }, 3000) as ObserveView;
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

  /** DEV-CU P3-6（§P3-6 步骤 1）：单控件动作转发（ref 路径，§4.7 枚举）。
   * 走既有 private call()，不开放任意 cmd 透传；动作语义由 worker 侧
   * dispatch + 读回验证承载，本层只按协议转发。 */
  async act(input: {
    pid: number; ref: string; grant_id: string; generation: number;
    action: string; value: string | null; selection?: unknown; target_summary: string;
  }): Promise<unknown> {
    return await this.call('uia_invoke', {
      pid: input.pid,
      ref: input.ref,
      grant_id: input.grant_id,
      generation: input.generation,
      action: input.action,
      value: input.value,
      target_summary: input.target_summary,
      ...(input.selection === undefined ? {} : { selection: input.selection }),
    }, 15000);
  }

  /** DEV-CU P3-6（§P3-6 步骤 1）：撤销该 grant 下全部快照（C02：授权撤销即失效）。
   * worker 命令 uia_invalidate 的固定意图转发，不开放任意 cmd 透传。 */
  async invalidate(grantId: string): Promise<{ ok: boolean; cleared?: number; error?: string }> {
    return await this.call('uia_invalidate', { grant_id: grantId }) as { ok: boolean; cleared?: number; error?: string };
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
