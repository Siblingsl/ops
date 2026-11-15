// P0-3（CF-DESK-03 桌面消费接线，D-186 已批准）：run 内 MCP tools/call 的桌面执行器。
//
// 契约 §2.5：连接实例（stdio 子进程 / HTTP 会话）由桌面主进程 McpHostManager 独占，
// 服务端只保存配置。本执行器对齐 browser/computer 命令的三步协议：
//   pending（GET /agent/plugin-calls/pending，含脱敏 args 与连接配置）
//   → claim（POST {id}/claim，CAS：先到者 claimed=true 拿执行权）
//   → 执行（McpHostManager.callTool）→ receipt（POST {id}/receipt，终态幂等）。
//
// 红线与边界：
//   - `plugin_mcp` 特性默认关（D-187 C 档禁开）；服务端已按特性拒绝派发，
//     本执行器在开关关闭时轮询到 403 也会如实停轮（见 start 的 lastError 记录），
//     不在客户端侧绕过特性闸门。
//   - 调用结果不进模型/事件流（服务端 waitForMCPCall 已把 result 回给等待方），
//     本执行器只回执，不重放、不重试：失败即 failed，崩溃不补发（unknown_outcome 由
//     服务端 sweep 收敛，契约 §2.3）。
//   - 连接复用：同一 connection_id 的配置（command/args/cwd/url）未变化时复用
//     既有实例；配置变化即 stop 后重启（契约 §2.5 第 2 点）。
import { scheduleNextMs } from './browser-executor';
import type { McpHostManager } from './mcp-host';

export interface McpCallRow {
  id: string;
  connection_id: string;
  tool_name: string;
  args?: unknown;
  transport: string;
  command?: string;
  conn_args?: string[];
  cwd?: string;
  url?: string;
  [key: string]: unknown;
}

// mcpCallExecutorName 是动态工具的 mcp__ 前缀（服务端 resolveMCPDynamicTool 只认这个形状）；
// 工具全名形如 mcp__<conn_short>__<tool>，执行时把前缀剥掉得到 MCP 侧的真实工具名。
export function mcpToolNameOf(toolName: string, connectionName: string): string | null {
  const prefix = `mcp__${connectionName}__`;
  if (!toolName.startsWith(prefix)) return null;
  const local = toolName.slice(prefix.length);
  return local !== '' ? local : null;
}

export interface McpCallExecutorDeps {
  listPending: () => Promise<{ calls: McpCallRow[] }>;
  claim: (id: string) => Promise<{ claimed: boolean }>;
  receipt: (id: string, body: { state: string; error_code?: string; duration_ms?: number; result?: unknown }) => Promise<unknown>;
  connections: () => Promise<Array<{ id: string; name: string; state: string }>>;
  host: () => McpHostManager | null;
  // 连接启动配置解析：连接名（sanitize 前缀来源）与 stdio/http 参数。
  // 连接必须在服务端 enabled；这里只做本机启动，不回写状态机（validate 走既有 actions API）。
  startConnection: (input: { connectionId: string; transport: string; command?: string; args?: string[]; cwd?: string; url?: string }) => Promise<unknown>;
  log: (line: string) => void;
}

export class McpCallExecutor {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private idleRounds = 0;
  private lastExecuted = 1;
  private lastError = '';
  // 已在本机启动的连接（connectionId → 配置指纹），供复用判断。
  private started = new Map<string, string>();

  constructor(private deps: McpCallExecutorDeps) {}

  lastErrorText(): string {
    return this.lastError;
  }

  start(intervalMs = 10_000, maxIntervalMs = 60_000): void {
    if (this.timer) return;
    const tick = async () => {
      if (this.running) return;
      this.running = true;
      try {
        const executed = await this.pollOnce();
        // DT-05 同款指数退避：领到调用回 base，空轮翻倍封顶。
        this.idleRounds = executed > 0 ? 0 : this.idleRounds + 1;
        this.lastError = '';
        this.lastExecuted = executed;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.deps.log(`[mcp-executor] poll failed: ${this.lastError}`);
      } finally {
        this.running = false;
        const next = scheduleNextMs(this.lastExecuted, this.idleRounds, intervalMs, maxIntervalMs);
        this.timer = setTimeout(tick, next);
      }
    };
    this.timer = setTimeout(tick, 0);
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  // pollOnce：一轮领取与执行。公开供单测直接驱动。
  async pollOnce(): Promise<number> {
    const { calls } = await this.deps.listPending();
    let executed = 0;
    for (const call of calls) {
      let claimed = false;
      try {
        const outcome = await this.deps.claim(call.id);
        claimed = outcome.claimed === true;
      } catch (error) {
        // claim 失败（连接被撤销、run 已过期等）：跳过这一条，下轮再看。
        this.deps.log(`[mcp-executor] claim ${call.id} failed: ${error instanceof Error ? error.message : error}`);
        continue;
      }
      if (!claimed) continue;
      executed += 1;
      const began = Date.now();
      try {
        const result = await this.execute(call);
        await this.deps.receipt(call.id, { state: 'succeeded', duration_ms: Date.now() - began, result });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.deps.log(`[mcp-executor] call ${call.id} failed: ${message}`);
        await this.deps.receipt(call.id, {
          state: 'failed', error_code: 'mcp_tool_error', duration_ms: Date.now() - began,
        }).catch((receiptError) => {
          this.deps.log(`[mcp-executor] receipt ${call.id} rejected: ${receiptError instanceof Error ? receiptError.message : receiptError}`);
        });
      }
    }
    return executed;
  }

  // execute：确保连接在本机可用，再按 MCP 工具名分发调用。
  private async execute(call: McpCallRow): Promise<unknown> {
    const manager = this.deps.host();
    if (!manager) throw new Error('mcp_host_unavailable');
    const config = this.fingerprint(call);
    const existing = this.started.get(call.connection_id);
    if (existing !== undefined && existing !== config) {
      // 配置变化：停旧实例再重启（契约 §2.5 第 2 点：catalog_revision 未变才复用）。
      manager.stop(call.connection_id);
      this.started.delete(call.connection_id);
    }
    if (!this.started.has(call.connection_id)) {
      await this.deps.startConnection({
        connectionId: call.connection_id,
        transport: call.transport,
        command: call.command,
        args: call.conn_args,
        cwd: call.cwd,
        url: call.url,
      });
      this.started.set(call.connection_id, config);
    }
    const connection = manager.get(call.connection_id);
    if (!connection) throw new Error('mcp_connection_not_running');
    // pending 响应不带连接名；用服务端目录工具名的 mcp__<short>__ 前缀反查——
    // claim 后的 call 只含 tool_name。这里按「最后一个 __ 分段」取本地工具名：
    // 服务端 sanitize 保证段内无下划线歧义（conn_short 不含下划线之外的 _
    // 由 [A-Za-z0-9_-] 白名单保证，双下划线分隔符唯一）。
    const localName = localMcpToolName(call.tool_name);
    if (!localName) throw new Error('mcp_tool_name_invalid');
    return await connection.callTool(localName, isRecord(call.args) ? call.args : {});
  }

  private fingerprint(call: McpCallRow): string {
    return JSON.stringify([call.transport, call.command ?? '', call.conn_args ?? [], call.cwd ?? '', call.url ?? '']);
  }
}

// localMcpToolName 从 mcp__<conn>__<tool> 取最后一段；形状不符返回 null。
export function localMcpToolName(toolName: string): string | null {
  const match = /^mcp__[A-Za-z0-9_-]+__([A-Za-z0-9_-]+)$/.exec(toolName);
  return match ? match[1] : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
