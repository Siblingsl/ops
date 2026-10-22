// D-131 / DEV-IL02：本人启动、本人核对、本人确认。状态查询不访问平台。
import { randomUUID } from 'node:crypto';
import { PlatformBrowserError } from './platform-worker';
import type { AccountProfileScope } from './platform-profile';
import type { LoginBrowserFamily } from './platform-browser-trust';

export type LoginStage = 'opening' | 'waiting' | 'probing' | 'review' | 'mismatch' | 'saving' | 'recovering' | 'connected' | 'cancelled' | 'expired' | 'unsupported' | 'failed';
export type LoginAction = 'status' | 'show' | 'probe' | 'confirm' | 'cancel' | 'back' | 'recover';
export interface LoginIdentity {
  externalAccountKey: string;
  displayName: string;
  capabilities: Record<string, unknown>;
}
export interface LoginView {
  operationId: string;
  accountId: string;
  accountName: string;
  platform: string;
  browserFamily: LoginBrowserFamily;
  browserVersion: string;
  stage: LoginStage;
  deadlineAt: number;
  externalAccountKey: string | null;
  displayName: string | null;
  connectionId: string | null;
  expectedKey: string | null;
  errorCode: string | null;
  cleanupPending: boolean;
  autoCollect: boolean;
  autoAdopt: boolean;
}
export interface LoginHandle {
  browserFamily: LoginBrowserFamily;
  browserVersion: string;
  expectedKey: string | null;
  supported: boolean;
  show(): Promise<void>;
  probe(): Promise<LoginIdentity | null>;
  close(): Promise<void>;
  onClosed(callback: () => void): void;
}
export interface LoginFlowDependencies {
  context(): Promise<Omit<AccountProfileScope, 'accountId' | 'platform'>>;
  account(accountId: string, platform: string): Promise<{ name: string }>;
  start(scope: AccountProfileScope, family?: LoginBrowserFamily, operationId?: string): Promise<LoginHandle>;
  save(scope: AccountProfileScope, identity: LoginIdentity, handle: LoginHandle, recoverOnly: boolean, signal: AbortSignal): Promise<{ id: string; autoCollect: boolean; autoAdopt: boolean }>;
  now?: () => number;
}

const TERMINAL = new Set<LoginStage>(['connected', 'cancelled', 'expired', 'failed']);
const fail = (code: string) => new PlatformBrowserError(code, '登录操作无法继续，请查看连接状态');

export class PlatformLoginFlow {
  private current: { view: LoginView; scope: AccountProfileScope; handle?: LoginHandle; identity?: LoginIdentity; timer?: NodeJS.Timeout; busy: boolean; abort: AbortController; startedAt: number } | null = null;
  constructor(private readonly deps: LoginFlowDependencies) {}
  get active(): boolean { return !!this.current && (this.current.busy || !TERMINAL.has(this.current.view.stage) || this.current.view.cleanupPending); }
  private now(): number { return (this.deps.now ?? Date.now)(); }
  async open(accountId: string, platform: string, family?: LoginBrowserFamily, operationId: string = randomUUID()): Promise<LoginView> {
    if (this.active) throw fail('platform_profile_busy');
    // 先占位防止两个异步 open 在读取 OPS 上下文时同时穿透。
    const startedAt = this.now();
    const op: NonNullable<PlatformLoginFlow['current']> = {
      view: { operationId, accountId, accountName: '', platform, browserFamily: family ?? 'chrome', browserVersion: '', stage: 'opening' as LoginStage, deadlineAt: startedAt + 180_000, externalAccountKey: null, displayName: null, connectionId: null, expectedKey: null, errorCode: null, cleanupPending: false, autoCollect: false, autoAdopt: false },
      scope: {} as AccountProfileScope, handle: undefined as LoginHandle | undefined, identity: undefined as LoginIdentity | undefined,
      timer: undefined as NodeJS.Timeout | undefined, busy: true, abort: new AbortController(), startedAt
    };
    this.current = op;
    op.timer = setTimeout(() => { void this.stop('expired'); }, 180_000);
    try {
      const context = await this.deps.context();
      const account = await this.deps.account(accountId, platform);
      if (op.abort.signal.aborted) throw fail('platform_login_cancelled');
      op.scope = { ...context, accountId, platform };
      op.view.accountName = account.name;
      const handle = await this.deps.start(op.scope, family, operationId);
      op.handle = handle;
      if (op.abort.signal.aborted || this.current !== op) { await this.close(op); return { ...op.view }; }
      Object.assign(op.view, { browserFamily: handle.browserFamily, browserVersion: handle.browserVersion, expectedKey: handle.expectedKey, stage: handle.supported ? 'waiting' : 'unsupported' });
      handle.onClosed(() => { if (this.current === op && !TERMINAL.has(op.view.stage)) void this.stop('cancelled'); });
      return { ...op.view };
    } catch (error) {
      if (!op.abort.signal.aborted) { op.view.stage = 'failed'; op.view.errorCode = errorCode(error); }
      clearTimeout(op.timer);
      if (op.handle) await this.close(op);
      return { ...op.view };
    } finally { op.busy = false; }
  }
  async action(operationId: string, action: LoginAction): Promise<LoginView> {
    const op = this.current;
    if (!op || op.view.operationId !== operationId) throw fail('platform_login_stale');
    if (action === 'cancel') { await this.stop('cancelled'); return { ...op.view, externalAccountKey: null, displayName: null, expectedKey: null, connectionId: null }; }
    if (!TERMINAL.has(op.view.stage) && this.now() >= op.view.deadlineAt) await this.stop('expired');
    const context = await this.deps.context();
    // 状态查询也可能跨越取消和新操作。旧查询绝不能 stop 当前新操作。
    if (this.current !== op) throw fail('platform_login_stale');
    if (Object.entries(context).some(([key, value]) => op.scope[key as keyof AccountProfileScope] !== value)) {
      await this.stop('cancelled');
      Object.assign(op.view, { externalAccountKey: null, displayName: null, connectionId: null, accountName: '', expectedKey: null });
      throw fail('platform_login_context_changed');
    }
    if (TERMINAL.has(op.view.stage) || op.abort.signal.aborted) return { ...op.view };
    if (action === 'status') return { ...op.view };
    if (op.busy) throw fail('platform_profile_busy');
    op.busy = true;
    try {
      if (!op.handle) throw fail('platform_login_required');
      if (action === 'show') await op.handle.show();
      if (action === 'back') {
        if (!['review', 'mismatch'].includes(op.view.stage)) throw fail('platform_login_stale');
        op.identity = undefined;
        Object.assign(op.view, { stage: 'waiting', externalAccountKey: null, displayName: null, expectedKey: op.handle.expectedKey, errorCode: null });
        await op.handle.show();
      }
      if (action === 'probe') {
        if (!['waiting', 'review', 'mismatch'].includes(op.view.stage)) throw fail('platform_capability_denied');
        op.view.stage = 'probing';
        const identity = await op.handle.probe();
        if (op.abort.signal.aborted || this.current !== op) return { ...op.view };
        op.identity = identity ?? undefined;
        Object.assign(op.view, { externalAccountKey: identity?.externalAccountKey ?? null, displayName: identity?.displayName ?? null, errorCode: identity ? null : 'platform_login_required' });
        op.view.stage = !identity ? 'waiting' : op.view.expectedKey && op.view.expectedKey !== identity.externalAccountKey ? 'mismatch' : 'review';
      }
      if (action === 'confirm' || action === 'recover') {
        if (!op.identity || (action === 'confirm' ? op.view.stage !== 'review' : op.view.stage !== 'recovering')) throw fail('platform_login_stale');
        // review 是快照，确认前本人触发一次有界复核，防止官方窗口已切号。
        const reviewed = op.identity;
        const currentIdentity = await op.handle.probe();
        if (op.abort.signal.aborted || this.current !== op) return { ...op.view };
        if (!currentIdentity || currentIdentity.externalAccountKey !== reviewed.externalAccountKey) {
          op.identity = undefined;
          Object.assign(op.view, { stage: currentIdentity ? 'mismatch' : 'waiting', expectedKey: reviewed.externalAccountKey, externalAccountKey: currentIdentity?.externalAccountKey ?? null, displayName: currentIdentity?.displayName ?? null, errorCode: 'platform_identity_mismatch' });
          return { ...op.view };
        }
        op.identity = currentIdentity;
        op.view.stage = 'saving';
        // 身份核对以后最多使用活动总预算210秒，不重新给180秒。
        clearTimeout(op.timer);
        op.view.deadlineAt = op.startedAt + 210_000;
        op.timer = setTimeout(() => { void this.stop('expired'); }, Math.max(0, op.view.deadlineAt - this.now()));
        const saved = await this.deps.save(op.scope, op.identity, op.handle, action === 'recover', op.abort.signal);
        if (op.abort.signal.aborted || this.current !== op) return { ...op.view };
        Object.assign(op.view, { stage: 'connected', connectionId: saved.id, errorCode: null, autoCollect: saved.autoCollect, autoAdopt: saved.autoAdopt });
        clearTimeout(op.timer);
        await this.close(op);
      }
    } catch (error) {
      if (!op.abort.signal.aborted) {
        op.view.errorCode = errorCode(error);
        op.view.stage = op.view.stage === 'saving' ? 'recovering' : op.view.stage === 'probing' ? 'waiting' : op.view.stage;
      }
    } finally { op.busy = false; }
    return { ...op.view };
  }
  async stop(stage: 'cancelled' | 'expired' = 'cancelled'): Promise<void> {
    const op = this.current;
    if (!op) return;
    if (TERMINAL.has(op.view.stage)) {
      if (op.view.cleanupPending && op.handle) await this.close(op);
      if (op.view.stage === 'connected') {
        op.abort.abort(); op.identity = undefined;
        Object.assign(op.view, { stage: 'cancelled', externalAccountKey: null, displayName: null, connectionId: null, accountName: '', expectedKey: null });
      }
      return;
    }
    op.abort.abort();
    clearTimeout(op.timer);
    op.view.stage = stage;
    if (op.handle) await this.close(op);
  }
  private async close(op: NonNullable<PlatformLoginFlow['current']>): Promise<void> {
    op.view.cleanupPending = true;
    try { await op.handle!.close(); op.view.cleanupPending = false; }
    catch { op.view.errorCode = 'platform_cleanup_pending'; }
  }
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^(platform_|ipc_|profile_)[a-z_]+$/.test(code) ? code : 'platform_network_unavailable';
}
