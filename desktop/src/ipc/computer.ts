import { createHash } from 'node:crypto';
import type { IpcMainInvokeEvent } from 'electron';
import { ComputerWorkerHost, type WindowSummary, type ObserveRequest } from '../computer-worker-host';

// DT-08 片 3（≡DEV-S02）：computer:* 固定意图拆分。从 main.ts 原样搬出（W17b 选窗器
// + DT-04 UIA 主链路），返回值形状与调用方校验逐字节不变。computerWorkerHost 单例由
// main.ts 创建后传入（退出清理 disposeApplicationResources 直接持有 main.ts 侧引用）。

let computerWorkerHostRef: ComputerWorkerHost | null = null;

/** main.ts 创建 ComputerWorkerHost 后登记。 */
export function setComputerWorkerHost(host: ComputerWorkerHost): void {
  computerWorkerHostRef = host;
}

export function registerComputerIpcHandlers(deps: {
  ipcHandle: <T>(channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => T | Promise<T>) => void;
  requireComputerCaller: (event: IpcMainInvokeEvent) => void;
}): void {
  const { ipcHandle, requireComputerCaller } = deps;
  // DEV-AI27-17（W17b，A12）：本机选窗器。枚举只在本机发生（27 §11.5.1/C09）——
  // 渲染器只拿不透明 handle 与脱敏摘要，不上传窗口全集、进程路径或截图。
  // handle = sha256(pid + 标题) 前 32 位：服务端与模型拿不到明文，本机可重算核对。
  ipcHandle('computer:list-windows', async (event) => {
    requireComputerCaller(event);
    try {
      const windows = await computerWorkerHostRef!.listWindows();
      return {
        ok: true as const,
        windows: windows.map((w: WindowSummary) => ({
          handle: createHash('sha256').update(`${w.pid}\u0000${w.title}`).digest('hex').slice(0, 32),
          process: w.process.slice(0, 120),
          title: w.title.slice(0, 256),
          forbidden: w.forbidden,
        })),
      };
    } catch (error) {
      const code = error instanceof Error && /worker_(timeout|exit)/.test(error.message) ? error.message : 'computer_worker_unavailable';
      return { ok: false as const, code, message: '本机窗口枚举不可用；请确认电脑控制组件已随客户端安装。' };
    }
  });
  // DT-04（W17c / 27 §11.5.2）：UIA 主链路本机通道。worker 的 uia_read/uia_invoke
  // 已实现（硬禁区二次校验 + 200 项上限 + 15s 超时），此前断在 host→IPC 一段。
  // 与 computer:list-windows 同构：固定意图、仅业务窗主框架、结果只回本机渲染器
  // （C09：不外发服务端/模型；服务端 UIA 执行接口属第二批，本轮不新增）。
  const parseUiaPid = (raw: unknown): number => {
    const pid = Number((raw as { pid?: unknown } | null)?.pid);
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('computer_uia_params_invalid');
    return pid;
  };
  const parseUiaSummary = (raw: unknown): string => {
    const summary = (raw as { target_summary?: unknown } | null)?.target_summary;
    return typeof summary === 'string' ? summary.slice(0, 256) : '';
  };
  // DEV-CU P2-7：observe 的入参与 worker 侧同口径（长度 / 区间 / 布尔都校验一遍）。
  // 两层校验不是重复劳动：IPC 层拒绝能少起一次 worker 调用，worker 层拒绝才是安全边界
  // （渲染器不是唯一调用方）。上下限与 computer-worker/observe.js 的 OBSERVE_LIMITS 对齐。
  const parseObserveParams = (raw: unknown, pid: number): ObserveRequest => {
    const body = raw as Record<string, unknown>;
    const summary = typeof body.target_summary === 'string' ? body.target_summary.slice(0, 256) : '';
    const grantId = typeof body.grant_id === 'string' ? body.grant_id : '';
    if (!grantId || grantId.length > 64) throw new Error('computer_uia_params_invalid');
    const generation = body.generation === undefined || body.generation === null ? 0 : Number(body.generation);
    if (!Number.isInteger(generation) || generation < 0) throw new Error('computer_uia_params_invalid');
    const out: ObserveRequest = { pid, target_summary: summary, grant_id: grantId, generation };
    if (body.max_depth !== undefined && body.max_depth !== null) {
      const depth = Number(body.max_depth);
      if (!Number.isInteger(depth) || depth < 0 || depth > 50) throw new Error('computer_uia_params_invalid');
      out.max_depth = depth;
    }
    if (body.root_ref !== undefined && body.root_ref !== null && body.root_ref !== '') {
      if (typeof body.root_ref !== 'string' || body.root_ref.length > 128) throw new Error('computer_uia_params_invalid');
      out.root_ref = body.root_ref;
    }
    if (body.interactive_only !== undefined && body.interactive_only !== null) {
      if (typeof body.interactive_only !== 'boolean') throw new Error('computer_uia_params_invalid');
      out.interactive_only = body.interactive_only;
    }
    if (body.compact !== undefined && body.compact !== null) {
      if (typeof body.compact !== 'boolean') throw new Error('computer_uia_params_invalid');
      out.compact = body.compact;
    }
    return out;
  };
  ipcHandle('computer:uia-read', async (event, raw) => {
    requireComputerCaller(event);
    if (!raw || typeof raw !== 'object') throw new Error('computer_uia_params_invalid');
    const pid = parseUiaPid(raw);
    try {
      return await computerWorkerHostRef!.readUIA(pid, parseUiaSummary(raw));
    } catch (error) {
      const code = error instanceof Error && /worker_(timeout|exit)/.test(error.message) ? error.message : 'computer_worker_unavailable';
      return { ok: false as const, error: code };
    }
  });
  // DEV-CU P2-7：`uia_observe`（§4.5 观察树）。仅本机通道，不接服务端——
  // 与 computer:uia-read / uia-invoke 同构；本包**不扩 preload 白名单**（P3-7 统一扩展），
  // 所以渲染器暂时还够不到这条通道，先用 desktop/test 直接测 host。
  ipcHandle('computer:uia-observe', async (event, raw) => {
    requireComputerCaller(event);
    if (!raw || typeof raw !== 'object') throw new Error('computer_uia_params_invalid');
    const pid = parseUiaPid(raw);
    const observeParams = parseObserveParams(raw, pid);
    try {
      return await computerWorkerHostRef!.observe(observeParams);
    } catch (error) {
      // 既有错误映射：worker 的语义错误码原样回传，其余统一成「组件不可用」。
      const message = error instanceof Error ? error.message : '';
      const known = [
        'hard_forbidden', 'pid_invalid', 'computer_invalid_args', 'computer_stale_ref',
        'computer_target_changed', 'computer_timeout', 'computer_internal',
        'worker_timeout', 'worker_exit',
      ];
      const code = known.includes(message) ? message : 'computer_worker_unavailable';
      return { ok: false as const, error: code };
    }
  });
  ipcHandle('computer:uia-invoke', async (event, raw) => {
    requireComputerCaller(event);
    if (!raw || typeof raw !== 'object') throw new Error('computer_uia_params_invalid');
    const pid = parseUiaPid(raw);
    const body = raw as { automation_id?: unknown; value?: unknown };
    const automationId = typeof body.automation_id === 'string' && body.automation_id.length > 0 && body.automation_id.length <= 200 ? body.automation_id : '';
    if (!automationId) throw new Error('computer_uia_params_invalid');
    const value = body.value === undefined || body.value === null ? null : String(body.value).slice(0, 32768);
    try {
      return await computerWorkerHostRef!.invokeUIA(pid, automationId, value, parseUiaSummary(raw));
    } catch (error) {
      const code = error instanceof Error && /worker_(timeout|exit|hard_forbidden)/.test(error.message) ? error.message : 'computer_worker_unavailable';
      return { ok: false as const, error: code };
    }
  });

  // DEV-CU P3-6（§P3-6 步骤 2）：ref 路径单控件动作通道。参数逐个校验
  // （pid / grant_id / generation / target_ref 格式 / action 枚举 / value 长度），
  // 结果与 §4.1 信封对齐；错误映射复用既有 worker_* 分支并补语义码。
  ipcHandle('computer:uia-act', async (event, raw) => {
    requireComputerCaller(event);
    if (!raw || typeof raw !== 'object') throw new Error('computer_uia_params_invalid');
    const body = raw as Record<string, unknown>;
    const pid = parseUiaPid(body);
    const grantId = typeof body.grant_id === 'string' && body.grant_id.length > 0 && body.grant_id.length <= 64 ? body.grant_id : '';
    if (!grantId) throw new Error('computer_uia_params_invalid');
    const generation = body.generation === undefined || body.generation === null ? 0 : Number(body.generation);
    if (!Number.isInteger(generation) || generation < 0) throw new Error('computer_uia_params_invalid');
    const ref = typeof body.ref === 'string' && /^@[A-Za-z0-9_-]{3,64}:e[1-9][0-9]{0,9}$/.test(body.ref) ? body.ref : '';
    if (!ref) throw new Error('computer_uia_params_invalid');
    const action = typeof body.action === 'string' && body.action.length > 0 && body.action.length <= 32 ? body.action : '';
    if (!action) throw new Error('computer_uia_params_invalid');
    const value = body.value === undefined || body.value === null ? null : String(body.value).slice(0, 32768);
    try {
      return await computerWorkerHostRef!.act({
        pid, ref, grant_id: grantId, generation, action, value,
        ...(body.selection === undefined ? {} : { selection: body.selection }),
        target_summary: parseUiaSummary(body),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const known = [
        'hard_forbidden', 'pid_invalid', 'computer_invalid_args', 'computer_stale_ref',
        'computer_target_changed', 'computer_action_not_supported', 'computer_action_failed',
        'computer_policy_denied', 'computer_app_unresponsive', 'computer_timeout',
        'computer_internal', 'worker_timeout', 'worker_exit',
      ];
      const code = known.includes(message) ? message : 'computer_worker_unavailable';
      return { ok: false as const, error: code };
    }
  });

  // DEV-CU P3-6（§P3-6 步骤 2）：撤销该 grant 全部快照（C02）。固定意图，无任意透传。
  ipcHandle('computer:uia-invalidate', async (event, raw) => {
    requireComputerCaller(event);
    if (!raw || typeof raw !== 'object') throw new Error('computer_uia_params_invalid');
    const grantId = typeof (raw as { grant_id?: unknown }).grant_id === 'string'
      && (raw as { grant_id?: unknown }).grant_id !== ''
      && ((raw as { grant_id?: string }).grant_id as string).length <= 64
      ? (raw as { grant_id: string }).grant_id : '';
    if (!grantId) throw new Error('computer_uia_params_invalid');
    try {
      return await computerWorkerHostRef!.invalidate(grantId);
    } catch (error) {
      const code = error instanceof Error && /worker_(timeout|exit)/.test(error.message) ? error.message : 'computer_worker_unavailable';
      return { ok: false as const, error: code };
    }
  });
}
