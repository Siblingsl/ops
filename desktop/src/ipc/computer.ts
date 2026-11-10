import { createHash } from 'node:crypto';
import type { IpcMainInvokeEvent } from 'electron';
import { ComputerWorkerHost, type WindowSummary } from '../computer-worker-host';

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
}
