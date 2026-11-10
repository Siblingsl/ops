// A30b 片 2（用户拍板：账本存载荷+同步等待）：AI 浏览器命令执行器（桌面侧）。
// 定时轮询服务端 pending 命令 → CAS 派发领取（claimed=true 才拿到载荷，多桌面防重复
// 执行）→ 经本机桥 dispatchAndWait 派发扩展 → 回执（含 result）。
// 失败也如实回执 failed + 真实 error_code；桥未配对时跳过本轮——命令由服务端
// deadline+sweep 兜底转 unknown_outcome，run 内等待方如实收到，不伪造执行成功。

export interface BrowserCommandRow {
  id: string;
  action_kind: string;
  deadline_at?: string;
  claimed?: boolean;
  payload?: unknown;
  [key: string]: unknown;
}

export interface BrowserExecutorDeps {
  listPending: () => Promise<{ commands: BrowserCommandRow[] }>;
  dispatch: (id: string) => Promise<BrowserCommandRow>;
  receipt: (id: string, body: { state: string; error_code?: string; result?: unknown }) => Promise<unknown>;
  /** 桥是否处于可执行状态（paired）；其他状态跳过本轮。 */
  bridgeState: () => 'paired' | 'other';
  dispatchAndWait: (action: string, payload: unknown, timeoutMs?: number) =>
    Promise<{ ok: true; result: unknown } | { ok: false; code: string; message?: string }>;
  log?: (line: string) => void;
}

// 单命令执行等待上限：取 deadline 剩余与 15s 的较小者（服务端预算 30s，回执要留出余量）。
const MAX_COMMAND_WAIT_MS = 15_000;

/** DT-05（docs/33 §10.5 / 12.2）：下一轮轮询间隔。连续空轮指数退避：首个空轮保持
 * base（不改变既有单空环节奏），之后 2^n·base 封顶 max；领到任何命令立即回 base。
 * 纯函数：主进程按返回值滚动排程（setTimeout 链），替代空闲期每 3s 一次的固定轮询。
 * 同步等待 ≤30s 的命令在退避上限 12s 时仍满足 deadline+sweep 兜底语义（超时兜底由
 * 服务端保证，不重放）。 */
export function scheduleNextMs(executedCount: number, idleRounds: number, baseMs: number, maxMs: number): number {
  if (executedCount > 0) return baseMs;
  if (idleRounds <= 0) return baseMs;
  const backoff = baseMs * 2 ** Math.min(idleRounds, 20);
  return Math.min(backoff, maxMs);
}

export class BrowserCommandExecutor {
  private running = false;

  constructor(private readonly deps: BrowserExecutorDeps) {}

  /** 执行一轮：领取→逐条串行执行→回执。返回本轮执行的命令数（跳过不计）。 */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      if (this.deps.bridgeState() !== 'paired') return 0;
      const { commands } = await this.deps.listPending();
      let executed = 0;
      for (const cmd of commands.slice(0, 10)) {
        if (await this.executeOne(cmd)) executed += 1;
      }
      return executed;
    } catch (err) {
      this.deps.log?.(`[browser-executor] tick 失败：${err instanceof Error ? err.message : err}`);
      return 0;
    } finally {
      this.running = false;
    }
  }

  private async executeOne(cmd: BrowserCommandRow): Promise<boolean> {
    const id = String(cmd.id ?? '');
    const action = String(cmd.action_kind ?? '');
    if (!id || !action) return false;
    let claimed: BrowserCommandRow | null = null;
    try {
      claimed = await this.deps.dispatch(id);
    } catch (err) {
      // 派发失败（409=已被他人领取/租约失效/状态推进过）：不回执——服务端状态机
      // 已处理或 sweep 兜底；重复回执反而制造 409 冲突噪音。
      this.deps.log?.(`[browser-executor] ${id.slice(0, 8)} 派发失败：${err instanceof Error ? err.message : err}`);
      return false;
    }
    if (!claimed || claimed.claimed !== true) return false;
    const remaining = cmd.deadline_at
      ? new Date(String(cmd.deadline_at)).getTime() - Date.now()
      : MAX_COMMAND_WAIT_MS;
    const timeoutMs = Math.max(3_000, Math.min(MAX_COMMAND_WAIT_MS, Number.isFinite(remaining) ? remaining : MAX_COMMAND_WAIT_MS));
    const result = await this.deps.dispatchAndWait(action, claimed.payload ?? {}, timeoutMs);
    try {
      if (result.ok) {
        await this.deps.receipt(id, { state: 'succeeded', result: result.result });
      } else {
        await this.deps.receipt(id, {
          state: 'failed',
          error_code: result.code,
          ...(result.message ? { result: { message: result.message } } : {}),
        });
      }
    } catch (err) {
      this.deps.log?.(`[browser-executor] ${id.slice(0, 8)} 回执失败：${err instanceof Error ? err.message : err}`);
      return false;
    }
    return true;
  }
}
