// B-09：标签页生命周期策略（纯函数，不直接调用 chrome API）。
//
// 对齐 `docs/41-browse可借鉴实现清单.md` §9.1（browse `tab-cleanup.ts` / `tab-identity.ts` /
// `debugger-hub.ts` / `grouping.ts`）。OPS 当前不创建 agent tab（采集浏览器由
// `platform-worker.ts` 以独立 profile 启动，任务结束在 finally 里关闭），因此本模块是
// “若未来复用采集窗口”的回收/身份策略与审计锚点，不接管现有浏览器进程。

export const DEFAULT_IDLE_MS = 10 * 60 * 1000;
export const RESTORE_QUERY_MS = 2000;
export const CLOSE_TIMEOUT_MS = RESTORE_QUERY_MS * 5;

export interface TabSnapshot {
  tabId: number;
  pinned?: boolean;
  audible?: boolean;
  active?: boolean;
  inAgentGroup?: boolean;
}

export interface TabIdentity {
  tabId: number;
  browseId: string;
  browseAgent: boolean;
  chosen?: string;
  generation: number;
}

export type SkipReason =
  | 'not_agent_tab'
  | 'chosen_tab'
  | 'active_tab'
  | 'pinned'
  | 'audible'
  | 'guarded'
  | 'not_idle';

interface TabRecord extends TabSnapshot {
  trackedAt: number;
  touchedAt: number;
  guards: Set<string>;
  identity: TabIdentity;
}

export interface CloseContext {
  /** 是否是当前焦点窗口的活动 tab（是则跳过）。 */
  isActiveTab?: boolean;
  /** 关闭后是否等于“最后一个窗口的最后一个 tab”。 */
  isLastTabInLastWindow?: boolean;
}

export interface ClosePlan {
  steps: Array<'open_replacement' | 'ungroup' | 'remove' | 'regroup_on_failure'>;
  groupId?: number;
  timeoutMs: number;
  serial: true;
}

export interface ShouldCloseResult {
  close: boolean;
  reason?: SkipReason;
  idleMs?: number;
}

let browseSeq = 0;

function nextBrowseId(tabId: number, now: number): string {
  browseSeq += 1;
  return `b${tabId}-${now}-${browseSeq}`;
}

/** agent 自己打开的 tab 生命周期；用户借出的 tab 不入表，永不自动关。 */
export class TabLifecycle {
  private readonly tabs = new Map<number, TabRecord>();

  constructor(readonly idleMs: number = DEFAULT_IDLE_MS) {}

  track(snapshot: TabSnapshot, now = Date.now(), options: { chosen?: string; generation?: number } = {}): TabIdentity {
    const identity: TabIdentity = {
      tabId: snapshot.tabId,
      browseId: nextBrowseId(snapshot.tabId, now),
      browseAgent: true,
      chosen: options.chosen,
      generation: options.generation ?? 0,
    };
    this.tabs.set(snapshot.tabId, {
      ...snapshot,
      trackedAt: now,
      touchedAt: now,
      guards: new Set(),
      identity,
    });
    return identity;
  }

  /** 被碰过：agent 发命令或用户切到该 tab。 */
  touch(tabId: number, now = Date.now()): boolean {
    const record = this.tabs.get(tabId);
    if (!record) return false;
    record.touchedAt = now;
    return true;
  }

  addGuard(tabId: number, reason: string): boolean {
    const record = this.tabs.get(tabId);
    if (!record) return false;
    record.guards.add(String(reason || 'guard'));
    return true;
  }

  removeGuard(tabId: number, reason: string): boolean {
    const record = this.tabs.get(tabId);
    if (!record) return false;
    record.guards.delete(String(reason || 'guard'));
    return true;
  }

  refresh(tabId: number, patch: Partial<TabSnapshot>): boolean {
    const record = this.tabs.get(tabId);
    if (!record) return false;
    Object.assign(record, patch, { tabId });
    return true;
  }

  identity(tabId: number): TabIdentity | null {
    return this.tabs.get(tabId)?.identity ?? null;
  }

  /** 浏览器重启后 tab id 全变：由 onStartup 清空；扩展重载不清（tab id 不变）。 */
  onStartup(): void {
    this.tabs.clear();
  }

  shouldClose(tabId: number, now = Date.now(), context: CloseContext = {}): ShouldCloseResult {
    const record = this.tabs.get(tabId);
    if (!record) return { close: false, reason: 'not_agent_tab' };
    if (record.identity.chosen) return { close: false, reason: 'chosen_tab' };
    if (context.isActiveTab || record.active) return { close: false, reason: 'active_tab' };
    if (record.pinned) return { close: false, reason: 'pinned' };
    if (record.audible) return { close: false, reason: 'audible' };
    if (record.guards.size > 0) return { close: false, reason: 'guarded' };
    const idleMs = now - record.touchedAt;
    if (idleMs < this.idleMs) return { close: false, reason: 'not_idle', idleMs };
    return { close: true, idleMs };
  }

  /**
   * 关闭顺序：最后窗口先开替代 tab；在组里先 ungroup 再 remove；失败回滚 regroup；
   * 串行 + 超时（查询类 2s，关闭超时 10s）。
   */
  planClose(tabId: number, context: CloseContext = {}): ClosePlan | null {
    const record = this.tabs.get(tabId);
    if (!record) return null;
    const steps: ClosePlan['steps'] = [];
    if (context.isLastTabInLastWindow) steps.push('open_replacement');
    if (record.inAgentGroup) {
      steps.push('ungroup', 'remove', 'regroup_on_failure');
    } else {
      steps.push('remove');
    }
    return {
      steps,
      ...(record.inAgentGroup ? { groupId: tabId } : {}),
      timeoutMs: CLOSE_TIMEOUT_MS,
      serial: true,
    };
  }
}

/**
 * 稳定 tab 身份映射。读取超时按“未知”而非“没有”处理；写入前校验 generation，
 * 避免旧任务覆盖新状态。
 */
export class TabIdentityStore {
  private readonly entries = new Map<number, TabIdentity>();

  set(identity: TabIdentity): boolean {
    const current = this.entries.get(identity.tabId);
    if (current && current.generation > identity.generation) return false;
    this.entries.set(identity.tabId, { ...identity });
    return true;
  }

  get(tabId: number, options: { timedOut?: boolean } = {}): { status: 'known' | 'unknown'; identity?: TabIdentity } {
    if (options.timedOut) return { status: 'unknown' };
    const identity = this.entries.get(tabId);
    return identity ? { status: 'known', identity: { ...identity } } : { status: 'unknown' };
  }

  clearOnStartup(): void {
    this.entries.clear();
  }

  /** 扩展重载后只信任仍在自有 group 的 tab（双重校验由调用方提供）。 */
  trustIfInGroup(tabId: number, inOwnGroup: boolean): TabIdentity | null {
    if (!inOwnGroup) return null;
    return this.entries.get(tabId) ?? null;
  }
}

export type DebuggerAttachDecision =
  | { code: 'already_attached_self'; action: 'reattach'; retryable: true }
  | { code: 'debugger_conflict'; action: 'fail_with_user_hint'; retryable: false }
  | { code: 'attach_ok'; action: 'attach'; retryable: true };

/**
 * `already attached` 可能来自自己（SW 重启）或 DevTools/其他扩展。
 * 只有确认是自己时才重附；否则明确失败并提示用户关掉 DevTools，不静默重试。
 */
export function classifyDebuggerAttachFailure(errorText: string, selfProbe: boolean): DebuggerAttachDecision {
  const text = String(errorText || '').toLowerCase();
  if (text.includes('already attached')) {
    return selfProbe
      ? { code: 'already_attached_self', action: 'reattach', retryable: true }
      : { code: 'debugger_conflict', action: 'fail_with_user_hint', retryable: false };
  }
  if (text.includes('another debugger') || text.includes('devtools')) {
    return { code: 'debugger_conflict', action: 'fail_with_user_hint', retryable: false };
  }
  return { code: 'attach_ok', action: 'attach', retryable: true };
}

/**
 * SW 重启后恢复附着：先 detach 再 attach；只有 URL 一致才重附，
 * 避免 tab id 被别的页面复用。
 */
export function debuggerRestorePlan(input: {
  storedUrl: string;
  currentUrl: string;
  attached: boolean;
}): { steps: Array<'detach' | 'attach'>; reason?: 'url_mismatch' } {
  if (input.storedUrl !== input.currentUrl) return { steps: [], reason: 'url_mismatch' };
  return { steps: input.attached ? ['detach', 'attach'] : ['attach'] };
}

/** 每个 agent session 一个组；handoff 时展开，完成后折叠。 */
export function groupPlan(input: { sessionId: string; existingGroupId?: number; collapsed: boolean; handoffActive?: boolean }): {
  action: 'reuse' | 'create';
  collapsed: boolean;
} {
  return {
    action: typeof input.existingGroupId === 'number' ? 'reuse' : 'create',
    collapsed: input.handoffActive ? false : input.collapsed,
  };
}
