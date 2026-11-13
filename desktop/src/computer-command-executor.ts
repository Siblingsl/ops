'use strict';
// DEV-CU P4-11（docs/36 §P4-11）：电脑控制命令执行器——复制 browser-executor.ts 的
// 轮询模式到 computer 域。领取 /agent/computer/commands/pending → 逐条 CAS 领取 →
// 调 host 的 observe/act → 如实回执（带 worker 的 disposition 与 error.code）。
//
// 红线（§P4-11 步骤 2）：**逐条执行，不批量**——一次 tick 最多处理 1 条写类命令；
// 读类可到 10 条但逐条领取。领取后校验 generation 与本机当前授权一致，不一致直接回
// unknown_outcome，不派发给 worker（不重放）。断网 / 租约撤销时停止轮询并清 RefStore。
//
// 明确不改 BrowserCommandExecutor 本体；轮询调度沿用 scheduleNextMs（browser-executor 导出）。

import { scheduleNextMs } from './browser-executor';

export interface ComputerCommandRow {
  id: string;
  action_kind: string;
  grant_id?: string;
  generation?: number;
  deadline_at?: string;
  claimed?: boolean;
  payload?: unknown;
  [key: string]: unknown;
}

export interface ComputerExecutorDeps {
  listPending: () => Promise<{ commands: ComputerCommandRow[] }>;
  dispatch: (id: string) => Promise<ComputerCommandRow>;
  receipt: (id: string, body: { state: string; error_code?: string; result?: unknown; disposition?: unknown }) => Promise<unknown>;
  /** 本机当前授权：grant_id → generation；领取的命令 generation 不一致即拒派发。 */
  localGenerationOf: (grantId: string) => number | null;
  /** 执行一次命令：observe（只读）或 act（含 ref 的写类）。worker 超时由调用方按 computer_timeout 处理。
   * grant 明确传回，供 main 侧从本机授权登记表取 pid/target_summary（命令载荷本身不含归属）。 */
  execute: (actionKind: string, payload: unknown, timeoutMs: number, grant: { grant_id: string; generation: number }) =>
    Promise<{ ok: true; result: unknown; disposition?: unknown } | { ok: false; code: string; message?: string }>;
  /** 桥是否处于可执行状态（登录且桌面客户端可用）；其他状态跳过本轮并清 RefStore。 */
  ready: () => boolean;
  /** 断网 / 租约撤销时清空本机 RefStore（C02：授权撤销即失效）。 */
  invalidate: () => void;
  log?: (line: string) => void;
}

// 单命令执行等待上限：取 deadline 剩余与 15s 的较小者（服务端预算 30s，回执要留出余量）。
const MAX_COMMAND_WAIT_MS = 15_000;

/** 写类动作（§4.3：invoke/type 走 D-117 确认后才进账本；executor 侧一次一条）。 */
const WRITE_ACTIONS = Object.freeze(['invoke', 'type']);

export class ComputerCommandExecutor {
  private running = false;

  constructor(private readonly deps: ComputerExecutorDeps) {}

  /** 执行一轮：领取→逐条串行执行→回执。返回本轮执行的命令数（跳过不计）。 */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      if (!this.deps.ready()) {
        this.deps.invalidate();
        return 0;
      }
      const { commands } = await this.deps.listPending();
      let executed = 0;
      let writeExecuted = 0;
      for (const cmd of commands.slice(0, 10)) {
        const kind = String(cmd.action_kind ?? '');
        // 一次 tick 最多处理 1 条写类（红线：逐张执行，不批量）。
        if (WRITE_ACTIONS.indexOf(kind) >= 0) {
          if (writeExecuted >= 1) break;
          if (await this.executeOne(cmd)) { writeExecuted += 1; executed += 1; }
          continue;
        }
        if (await this.executeOne(cmd)) executed += 1;
      }
      return executed;
    } catch (err) {
      this.deps.log?.(`[computer-executor] tick 失败：${err instanceof Error ? err.message : err}`);
      return 0;
    } finally {
      this.running = false;
    }
  }

  private async executeOne(cmd: ComputerCommandRow): Promise<boolean> {
    const id = String(cmd.id ?? '');
    const action = String(cmd.action_kind ?? '');
    if (!id || !action) return false;
    let claimed: ComputerCommandRow | null = null;
    try {
      claimed = await this.deps.dispatch(id);
    } catch (err) {
      // 派发失败（409=已被他人领取/租约失效/状态推进过）：不回执——服务端状态机
      // 已处理或 sweep 兜底；重复回执反而制造 409 冲突噪音。
      this.deps.log?.(`[computer-executor] ${id.slice(0, 8)} 派发失败：${err instanceof Error ? err.message : err}`);
      return false;
    }
    if (!claimed || claimed.claimed !== true) return false;

    // 领取后校验 generation 与本机当前授权一致；不一致 → unknown_outcome，不派发 worker。
    const grantId = String(claimed.grant_id ?? '');
    const expected = Number(claimed.generation ?? 0);
    const local = grantId ? this.deps.localGenerationOf(grantId) : null;
    if (local === null || Number.isNaN(expected) || local !== expected) {
      try {
        await this.deps.receipt(id, { state: 'unknown_outcome', error_code: 'computer_stale_ref' });
      } catch (err) {
        this.deps.log?.(`[computer-executor] ${id.slice(0, 8)} generation 失配回执失败：${err instanceof Error ? err.message : err}`);
        return false;
      }
      this.deps.invalidate();
      return false;
    }

    const remaining = cmd.deadline_at
      ? new Date(String(cmd.deadline_at)).getTime() - Date.now()
      : MAX_COMMAND_WAIT_MS;
    const timeoutMs = Math.max(3_000, Math.min(MAX_COMMAND_WAIT_MS, Number.isFinite(remaining) ? remaining : MAX_COMMAND_WAIT_MS));
    const result = await this.deps.execute(action, claimed.payload ?? {}, timeoutMs, {
      grant_id: grantId,
      generation: expected,
    });
    try {
      if (result.ok) {
        await this.deps.receipt(id, {
          state: 'succeeded',
          result: result.result,
          ...(result.disposition !== undefined ? { disposition: result.disposition } : {}),
        });
      } else if (result.code === 'computer_timeout') {
        // worker 超时：unknown_outcome（不假装成功、不重放）。
        await this.deps.receipt(id, { state: 'unknown_outcome', error_code: 'computer_timeout' });
      } else {
        await this.deps.receipt(id, {
          state: 'failed',
          error_code: result.code,
          ...(result.message ? { result: { message: result.message } } : {}),
        });
      }
    } catch (err) {
      this.deps.log?.(`[computer-executor] ${id.slice(0, 8)} 回执失败：${err instanceof Error ? err.message : err}`);
      return false;
    }
    return true;
  }
}

export { scheduleNextMs };
