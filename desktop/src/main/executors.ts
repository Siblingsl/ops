// OPT-E04a：main.ts 的 MCP / 浏览器 / 电脑本机命令执行器拆出模块。
// 执行器实例与定时器归本模块所有；desktopClient、MCP 宿主与电脑 worker 由 main.ts 注入。
import type { DesktopClient } from '../desktop-client';
import { BrowserCommandExecutor, scheduleNextMs } from '../browser-executor';
import { ComputerCommandExecutor } from '../computer-command-executor';
import { McpCallExecutor } from '../mcp-call-executor';
import { clearComputerAuthorizations, computerAuthorizationGeneration, computerAuthorizationOf } from '../computer-authorizations';
import type { McpHostManager } from '../mcp-host';
import type { ComputerWorkerHost } from '../computer-worker-host';
import { getActiveBridge } from '../browser-bridge';

export interface ExecutorDeps {
  getDesktopClient(): DesktopClient | null;
  getMcpHostManager(): McpHostManager | null;
  getComputerWorkerHost(): ComputerWorkerHost | null;
}

let deps: ExecutorDeps | null = null;

export function configureExecutors(next: ExecutorDeps): void {
  deps = next;
}

function requireDeps(): ExecutorDeps {
  if (!deps) throw new Error('执行器模块尚未初始化。');
  return deps;
}

// A30b 片 2（拍板：账本存载荷+同步等待）：AI 浏览器命令执行器——桥配对后定时轮询
// 服务端 pending 命令并经本机桥执行；未配对跳过本轮（命令由服务端 deadline+sweep
// 兜底转 unknown_outcome，run 内等待方如实收到，不伪造执行成功）。
// DT-05（docs/33 §10.5）：接收端自适应退避——连续空轮指数退避（3s→上限 12s），
// 领到命令立即回 3s；服务端同步等待 ≤30s 命令的最坏延迟仍远小于 deadline，兜底
// 语义不变。OPS_BROWSER_EXECUTOR_FIXED_INTERVAL_MS 可切回固定间隔（L2 回退，
// docs/33 12.2；临时开关，docs/90 登记移除评审点）。
let browserExecutorTimer: NodeJS.Timeout | null = null;
const BROWSER_EXECUTOR_INTERVAL_MS = 3000;
const BROWSER_EXECUTOR_IDLE_MAX_MS = 12_000;
let browserExecutorIdleRounds = 0;

// P0-3（CF-DESK-03 桌面消费接线）：run 内 MCP 调用执行器轮询。
// plugin_mcp 特性默认关（D-187 C 档）；服务端按特性拒绝派发，这里轮询拿到的就是
// 空清单或 403——403 属预期停轮条件之一，记 lastError 不刷屏。连接实例归
// McpHostManager（ipc/mcp.ts 单例经 onManagerReady 回传）；执行器只做
// pending → claim → callTool → receipt 四步，失败即 failed 不重试（契约 §2.3）。
let mcpExecutorTimerStarted = false;
let mcpCallExecutor: McpCallExecutor | null = null;

export function startMcpCallExecutor(): void {
  if (mcpExecutorTimerStarted) return;
  mcpExecutorTimerStarted = true;
  const d = requireDeps();
  mcpCallExecutor = new McpCallExecutor({
    listPending: async () => {
      const desktopClient = d.getDesktopClient();
      return desktopClient ? await desktopClient.listPendingPluginCalls() : { calls: [] };
    },
    claim: async (id) => {
      const desktopClient = d.getDesktopClient();
      if (!desktopClient) throw new Error('desktop client unavailable');
      return await desktopClient.claimPluginCall(id);
    },
    receipt: async (id, body) => {
      const desktopClient = d.getDesktopClient();
      if (!desktopClient) throw new Error('desktop client unavailable');
      return await desktopClient.receiptPluginCall(id, body);
    },
    connections: async () => {
      const desktopClient = d.getDesktopClient();
      if (!desktopClient) return [];
      const page = await desktopClient.listPluginConnections().catch(() => ({ connections: [] }));
      return page.connections ?? [];
    },
    host: () => d.getMcpHostManager(),
    startConnection: async (input) => {
      // 连接启动委托 McpHostManager：配置来自服务端账本（env 键值本机 safeStorage
      // 不在账本里，stdio env 由 spawn 侧按 env_keys 组装为空——秘密值注入走
      // 设置页 validate 链路，运行中连接的 env 注入待本机 secret 存储接线后补）。
      const mcpHostManager = d.getMcpHostManager();
      if (!mcpHostManager) throw new Error('mcp_host_unavailable');
      if (input.transport === 'stdio') {
        return await mcpHostManager.startStdio(input.connectionId, {
          command: String(input.command ?? ''),
          args: Array.isArray(input.args) ? input.args.filter((a): a is string => typeof a === 'string') : [],
          cwd: typeof input.cwd === 'string' && input.cwd.trim() ? input.cwd.trim() : process.cwd(),
        });
      }
      if (input.transport === 'http') {
        const url = String(input.url ?? '');
        if (!url.startsWith('https://')) throw new Error('http 传输要求 https:// 地址');
        return await mcpHostManager.startHttp(input.connectionId, { url });
      }
      throw new Error('transport 只能是 stdio 或 http');
    },
    log: (line) => console.log(line)
  });
  mcpCallExecutor.start(10_000, 60_000);
}

export function stopMcpCallExecutor(): void {
  mcpCallExecutor?.stop();
  mcpCallExecutor = null;
  mcpExecutorTimerStarted = false;
}

export function startBrowserCommandExecutor(): void {
  if (browserExecutorTimer) return;
  const d = requireDeps();
  const executor = new BrowserCommandExecutor({
    // 未登录（desktopClient 为 null）时领取返回空清单，不制造请求错误噪音。
    listPending: async () => {
      const desktopClient = d.getDesktopClient();
      return desktopClient ? await desktopClient.listPendingBrowserCommands() : { commands: [] };
    },
    dispatch: async (id) => {
      const desktopClient = d.getDesktopClient();
      if (!desktopClient) throw new Error('desktop client unavailable');
      return await desktopClient.dispatchBrowserCommand(id);
    },
    receipt: async (id, body) => {
      const desktopClient = d.getDesktopClient();
      if (!desktopClient) throw new Error('desktop client unavailable');
      return await desktopClient.receiptBrowserCommand(id, body);
    },
    bridgeState: () => (getActiveBridge()?.state === 'paired' ? 'paired' : 'other'),
    dispatchAndWait: (action, payload, timeoutMs) => {
      const bridge = getActiveBridge();
      if (!bridge) return Promise.resolve({ ok: false as const, code: 'browser_bridge_not_running' });
      return bridge.dispatchAndWait(action, payload, timeoutMs);
    },
    reportEvidence: async (input) => {
      const desktopClient = d.getDesktopClient();
      if (!desktopClient) throw new Error('desktop client unavailable');
      await desktopClient.reportBrowserEvidence({
        conversation_id: input.conversationId,
        command_id: input.commandId,
        origin: input.origin,
        redacted_url: input.redactedUrl,
        ...(input.title ? { title: input.title } : {}),
        ...(input.snippet ? { snippet: input.snippet } : {}),
        ...(input.docRevision ? { doc_revision: input.docRevision } : {}),
        kind: input.kind
      });
    },
    log: (line) => console.log(line)
  });
  const fixedInterval = Number(process.env.OPS_BROWSER_EXECUTOR_FIXED_INTERVAL_MS || '');
  if (Number.isInteger(fixedInterval) && fixedInterval > 0) {
    // L2 回退分支：固定间隔轮询（与改造前行为一致）。
    browserExecutorTimer = setInterval(() => { void executor.tick(); }, fixedInterval);
    browserExecutorTimer.unref?.();
    return;
  }
  // 自适应退避：每轮按 tick 结果滚动重排（setTimeout 链）。
  const runTick = async (): Promise<void> => {
    const startedAt = Date.now();
    const executed = await executor.tick().catch(() => 0);
    const elapsed = Date.now() - startedAt;
    const next = Math.max(scheduleNextMs(executed, browserExecutorIdleRounds, BROWSER_EXECUTOR_INTERVAL_MS, BROWSER_EXECUTOR_IDLE_MAX_MS) - elapsed, 250);
    browserExecutorIdleRounds = executed > 0 ? 0 : browserExecutorIdleRounds + 1;
    browserExecutorTimer = setTimeout(() => { void runTick(); }, next);
    browserExecutorTimer.unref?.();
  };
  browserExecutorTimer = setTimeout(() => { void runTick(); }, BROWSER_EXECUTOR_INTERVAL_MS);
  browserExecutorTimer.unref?.();
}

export function stopBrowserCommandExecutor(): void {
  if (!browserExecutorTimer) return;
  clearTimeout(browserExecutorTimer);
  clearInterval(browserExecutorTimer);
  browserExecutorTimer = null;
  browserExecutorIdleRounds = 0;
}

// DEV-CU P4-11 收口：电脑命令执行器接线。与 browser 同一套调度语义（3s 起、连续空轮
// 退避到 12s，领到命令立即回 3s）；一次 tick 最多 1 条写类由 executor 本体保证。
let computerExecutorTimer: NodeJS.Timeout | null = null;
const COMPUTER_EXECUTOR_INTERVAL_MS = 3000;
const COMPUTER_EXECUTOR_IDLE_MAX_MS = 12_000;
let computerExecutorIdleRounds = 0;

const COMPUTER_EXECUTOR_ERRORS = new Set([
  'hard_forbidden', 'pid_invalid', 'computer_invalid_args', 'computer_stale_ref',
  'computer_target_changed', 'computer_action_not_supported', 'computer_action_failed',
  'computer_policy_denied', 'computer_app_unresponsive', 'computer_timeout',
  'computer_internal', 'worker_timeout', 'worker_exit',
]);

/** 命令执行：只按本机授权登记表取 pid/摘要；载荷只有 ref/text，命令本身不含归属。 */
async function executeComputerCommand(
  actionKind: string,
  payload: unknown,
  _timeoutMs: number,
  grant: { grant_id: string; generation: number },
): Promise<{ ok: true; result: unknown; disposition?: unknown } | { ok: false; code: string; message?: string }> {
  const computerWorkerHost = requireDeps().getComputerWorkerHost();
  const auth = computerAuthorizationOf(grant.grant_id);
  if (!auth || auth.generation !== grant.generation) {
    return { ok: false, code: 'computer_stale_ref', message: '本机授权版本已变化' };
  }
  if (!computerWorkerHost) return { ok: false, code: 'computer_worker_unavailable' };
  const body = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const ref = typeof body.ref === 'string' ? body.ref : '';
  if (!ref) return { ok: false, code: 'computer_invalid_args', message: '命令缺少 ref' };
  try {
    if (actionKind === 'observe') {
      const view = await computerWorkerHost.observe({
        pid: auth.pid,
        target_summary: auth.targetSummary,
        grant_id: auth.grantId,
        generation: auth.generation,
      });
      if (!view.ok) return { ok: false, code: view.error || 'computer_action_failed' };
      return { ok: true, result: view };
    }
    const act = await computerWorkerHost.act({
      pid: auth.pid,
      ref,
      grant_id: auth.grantId,
      generation: auth.generation,
      // 服务端只发六语义（observe/focus/scroll/select/invoke/type，P4-3），
      // worker 动作链用 click/set_focus/set_value。适配只在这一处做。
      action: ({ focus: 'set_focus', invoke: 'click', type: 'set_value' } as Record<string, string>)[actionKind] || actionKind,
      value: typeof body.text === 'string' ? body.text : null,
      target_summary: auth.targetSummary,
    }) as { ok?: boolean; error?: string; message?: string; disposition?: unknown };
    if (act && act.ok === false) {
      const code = typeof act.error === 'string' ? act.error : 'computer_action_failed';
      return { ok: false, code, message: act.message };
    }
    return { ok: true, result: act, disposition: act?.disposition };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const code = COMPUTER_EXECUTOR_ERRORS.has(message) ? message : 'computer_internal';
    return { ok: false, code, message };
  }
}

export function startComputerCommandExecutor(): void {
  if (computerExecutorTimer) return;
  const d = requireDeps();
  const executor = new ComputerCommandExecutor({
    listPending: async () => {
      const desktopClient = d.getDesktopClient();
      return desktopClient ? await desktopClient.listPendingComputerCommands() : { commands: [] };
    },
    dispatch: async (id) => {
      const desktopClient = d.getDesktopClient();
      if (!desktopClient) throw new Error('desktop client unavailable');
      return await desktopClient.dispatchComputerCommand(id);
    },
    receipt: async (id, body) => {
      const desktopClient = d.getDesktopClient();
      if (!desktopClient) throw new Error('desktop client unavailable');
      return await desktopClient.receiptComputerCommand(id, body);
    },
    localGenerationOf: (grantId) => computerAuthorizationGeneration(grantId),
    execute: executeComputerCommand,
    ready: () => !!d.getDesktopClient() && !!d.getComputerWorkerHost(),
    invalidate: () => {
      const ids = clearComputerAuthorizations();
      const host = d.getComputerWorkerHost();
      for (const id of ids) {
        try { void host?.invalidate(id); } catch { /* 清理失败不影响下一轮 */ }
      }
    },
    log: (line) => console.log(line),
  });
  const runTick = async (): Promise<void> => {
    const startedAt = Date.now();
    const executed = await executor.tick().catch(() => 0);
    const elapsed = Date.now() - startedAt;
    const next = Math.max(scheduleNextMs(executed, computerExecutorIdleRounds, COMPUTER_EXECUTOR_INTERVAL_MS, COMPUTER_EXECUTOR_IDLE_MAX_MS) - elapsed, 250);
    computerExecutorIdleRounds = executed > 0 ? 0 : computerExecutorIdleRounds + 1;
    computerExecutorTimer = setTimeout(() => { void runTick(); }, next);
    computerExecutorTimer.unref?.();
  };
  computerExecutorTimer = setTimeout(() => { void runTick(); }, COMPUTER_EXECUTOR_INTERVAL_MS);
  computerExecutorTimer.unref?.();
}

export function stopComputerCommandExecutor(): void {
  if (!computerExecutorTimer) return;
  clearTimeout(computerExecutorTimer);
  clearInterval(computerExecutorTimer);
  computerExecutorTimer = null;
  computerExecutorIdleRounds = 0;
}
