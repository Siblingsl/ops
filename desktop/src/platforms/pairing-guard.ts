// B-10：配对失败计数与串行队列（纯函数，不改变现有配对认证模型）。
//
// OPS 的短码只供人工核对，不是认证凭据：`confirmPairing()` 没有“输入短码”的参数，
// 因此不存在“在线爆破短码”的入口。本模块是低成本防回归工具：若未来新增
// 以短码/口令为凭据的配对入口，必须先用 `PairingAttemptGuard` 限制失败次数。
//
// 对齐 `docs/41-browse可借鉴实现清单.md` §10.1/§10.3：
//   * 连续 5 次失败清空所有 pending 配对（browse `MAX_PAIRING_FAILURES`）；
//   * 写并发串行（browse 进程级 Mutex），避免“读-改-写”丢条目。

export const MAX_PAIRING_FAILURES = 5;

export interface PendingPairing {
  id: string;
  code: string;
  expiresAt: number;
}

/** 失败计数 + 待配对作废。调用方在验证短码/口令失败时调用 `failure`。 */
export class PairingAttemptGuard {
  private failures = 0;
  private locked = false;
  private pending: PendingPairing[] = [];

  constructor(readonly maxFailures: number = MAX_PAIRING_FAILURES) {}

  addPending(pairing: PendingPairing, now = Date.now()): void {
    this.pending = this.pending.filter((p) => p.expiresAt > now);
    this.pending.push({ ...pairing });
  }

  pendingCount(now = Date.now()): number {
    this.pending = this.pending.filter((p) => p.expiresAt > now);
    return this.pending.length;
  }

  /** 成功即清零；已锁定时仍返回 false，必须显式 `reset`。 */
  success(): boolean {
    if (this.locked) return false;
    this.failures = 0;
    return true;
  }

  /** 失败累计；达到阈值后作废全部 pending 并锁定，直到 `reset`。 */
  failure(): { failures: number; locked: boolean; invalidated: number } {
    if (this.locked) return { failures: this.failures, locked: true, invalidated: 0 };
    this.failures += 1;
    if (this.failures >= this.maxFailures) {
      const invalidated = this.pending.length;
      this.pending = [];
      this.locked = true;
      return { failures: this.failures, locked: true, invalidated };
    }
    return { failures: this.failures, locked: false, invalidated: 0 };
  }

  isLocked(): boolean {
    return this.locked;
  }

  /** 用户显式重新发起配对时才解锁；不能靠“再试一次”自动恢复。 */
  reset(): void {
    this.failures = 0;
    this.locked = false;
    this.pending = [];
  }
}

/** 进程内串行队列：读-改-写共享同一把“锁”，异常也继续后续任务。 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T> | T): Promise<T> {
    const next = this.tail.then(task, task);
    this.tail = next.catch(() => undefined);
    return next as Promise<T>;
  }
}
