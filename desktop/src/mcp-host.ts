import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';

// DEV-AI27-14（W14）：MCP 本机连接宿主（27 文档 §11.2.2/§12.1）。
// stdio 传输：spawn(命令, 独立参数数组)，不拼接 shell；显式 cwd 与最小环境；
// stdout 只走换行分隔 JSON-RPC；stderr 限量脱敏采集；只回收自己启动的进程。
// 协议：initialize 握手（支持 2025-06-18 与 2025-11-25 双时代声明）+ tools/list 分页 + tools/call。
// 目录规范化记录 tool_name/input_schema/output_schema/description_hash，供服务端目录与变更复审比对。

export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const MCP_LEGACY_PROTOCOL_VERSION = '2025-11-25';
const START_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 60_000;
const STDERR_LIMIT_BYTES = 64 * 1024;

export interface McpStdioConfig {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>; // 最小环境注入（含用户选定的 secret 引用解析值，不落日志）
}

export interface McpToolDescriptor {
  name: string;
  description_hash: string;
  input_schema: unknown;
  output_schema?: unknown;
}

export interface McpCatalog {
  tools: McpToolDescriptor[];
  server_info: { name: string; version: string; protocol_version: string };
  catalog_revision: string;
}

export type McpConnectionState = 'starting' | 'ready' | 'error' | 'stopped';

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function describeErrorHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** 单条 stdio MCP 连接：spawn → initialize → 目录/调用。 */
export class McpStdioConnection extends EventEmitter {
  state: McpConnectionState = 'starting';
  serverInfo: { name: string; version: string; protocol_version: string } | null = null;
  lastError = '';

  private proc: ChildProcess | null = null;
  private pending = new Map<number, PendingCall>();
  private nextID = 1;
  private stderrBuffer = Buffer.alloc(0);
  private stderrTruncated = false;
  private buffer = '';
  private startingTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly connectionId: string,
    private readonly config: McpStdioConfig,
  ) {
    super();
  }

  /** stderr 限量脱敏视图：环境变量值/令牌形状打码，只保留前 64KiB。 */
  stderrDigest(): { text: string; truncated: boolean } {
    let text = this.stderrBuffer.toString('utf8');
    text = text
      .replace(/(Bearer|sk-|token=|key=|authorization:)\s*\S+/gi, '$1 [REDACTED]')
      .replace(/(sk|ghp|gho|xox)[A-Za-z0-9_-]{8,}/g, '[REDACTED]');
    return { text, truncated: this.stderrTruncated };
  }

  async start(): Promise<void> {
    if (this.state !== 'starting') throw new Error(`连接 ${this.connectionId} 已启动（state=${this.state}）`);
    const cwd = this.config.cwd ? path.resolve(this.config.cwd) : process.cwd();
    if (!fs.existsSync(cwd)) throw new Error(`cwd 不存在：${cwd}`);
    // 最小环境：SystemRoot（Windows 子进程基本运行需要）+ PATH + 用户注入项；不继承完整父环境。
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '' };
    if (process.platform === 'win32' && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    for (const [key, value] of Object.entries(this.config.env ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`环境变量名非法：${key}`);
      env[key] = value;
    }
    const proc = spawn(this.config.command, this.config.args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false, // 红线：绝不拼接 shell
    });
    this.proc = proc;
    proc.on('error', (err) => {
      this.lastError = err.message;
      for (const [, call] of this.pending) {
        clearTimeout(call.timer);
        call.reject(new Error('spawn_failed: ' + err.message));
      }
      this.pending.clear();
      this.setState('error');
    });
    proc.on('exit', (code) => {
      this.lastError = this.lastError || `进程退出 code=${code}`;
      for (const [, call] of this.pending) {
        clearTimeout(call.timer);
        call.reject(new Error('MCP 进程已退出，未决调用作废'));
      }
      this.pending.clear();
      this.setState(this.state === 'ready' ? 'stopped' : 'error');
    });
    proc.stdout?.on('data', (chunk: Buffer) => this.onStdout(chunk));
    proc.stderr?.on('data', (chunk: Buffer) => {
      if (this.stderrBuffer.length < STDERR_LIMIT_BYTES) {
        this.stderrBuffer = Buffer.concat([this.stderrBuffer, chunk]).subarray(0, STDERR_LIMIT_BYTES);
      } else {
        this.stderrTruncated = true;
      }
    });

    // initialize 握手：先按现行版本声明，服务端回其版本（双时代兼容，27 §11.2.2）。
    const init = await this.call('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'ops-desktop', version: '0.1.0' },
    }, START_TIMEOUT_MS) as { serverInfo?: { name?: string; version?: string }; protocolVersion?: string };
    this.serverInfo = {
      name: String(init.serverInfo?.name ?? 'unknown'),
      version: String(init.serverInfo?.version ?? ''),
      protocol_version: String(init.protocolVersion ?? MCP_PROTOCOL_VERSION),
    };
    // initialized 通知（无 id，无需等待）。
    this.notify('notifications/initialized', {});
    this.setState('ready');
  }

  private setState(state: McpConnectionState): void {
    this.state = state;
    this.emit('state', state);
  }

  private onStdout(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let message: { id?: number | string; result?: unknown; error?: { message?: string } };
      try {
        message = JSON.parse(line);
      } catch {
        continue; // 非协议行忽略（stdout 只该有 JSON-RPC，容错不崩溃）
      }
      if (typeof message.id !== 'number') continue;
      const call = this.pending.get(message.id);
      if (!call) continue;
      this.pending.delete(message.id);
      clearTimeout(call.timer);
      if (message.error) {
        call.reject(new Error(`mcp_error: ${message.error.message ?? 'unknown'}`));
      } else {
        call.resolve(message.result);
      }
    }
    if (this.buffer.length > 4 * 1024 * 1024) this.buffer = ''; // 防御性上限
  }

  private call(method: string, params: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
    const proc = this.proc;
    if (!proc || !proc.stdin || this.state === 'stopped' || this.state === 'error') {
      return Promise.reject(new Error(`连接不可用（state=${this.state}）`));
    }
    const id = this.nextID++;
    const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mcp_timeout: ${method} 超过 ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      proc.stdin!.write(frame);
    });
  }

  private notify(method: string, params: unknown): void {
    this.proc?.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  /** 分页拉全 tools/list 并规范化（description hash 供服务端目录比对）。 */
  async catalog(): Promise<McpCatalog> {
    const tools: McpToolDescriptor[] = [];
    let cursor: string | undefined;
    do {
      const page = (await this.call('tools/list', cursor ? { cursor } : {})) as {
        tools?: Array<{ name: string; description?: string; inputSchema?: unknown; outputSchema?: unknown }>;
        nextCursor?: string;
      };
      for (const tool of page.tools ?? []) {
        tools.push({
          name: String(tool.name),
          description_hash: describeErrorHash(tool.description ?? ''),
          input_schema: tool.inputSchema ?? {},
          output_schema: tool.outputSchema,
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
    if (!this.serverInfo) throw new Error('未完成 initialize');
    return {
      tools,
      server_info: this.serverInfo,
      catalog_revision: describeErrorHash(JSON.stringify(tools.map((t) => [t.name, t.description_hash, t.input_schema]))),
    };
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    return this.call('tools/call', { name, arguments: args }, timeoutMs);
  }

  stop(): void {
    if (this.startingTimer) clearTimeout(this.startingTimer);
    if (this.proc && this.proc.exitCode === null) {
      try {
        this.proc.kill();
      } catch { /* 已退出 */ }
      // 3 秒未退则强杀，确保不留孤儿进程树。
      const proc = this.proc;
      setTimeout(() => {
        try {
          if (proc.exitCode === null) proc.kill('SIGKILL');
        } catch { /* 已退出 */ }
      }, 3000).unref?.();
    }
    this.setState('stopped');
  }
}

/** HTTP 传输配置（27 §11.2.2：默认 https；本机开发明文由 server 校验拒绝）。 */
export interface McpHttpConfig {
  url: string;
  headers?: Record<string, string>; // 不含秘密值（秘密经 env 注入或 OAuth，另行处理）
  /** OAuth 客户端（P01）：提供时请求自动带 Authorization，401 单次刷新（mcp-oauth.ts）。 */
  oauth?: McpOAuthClient;
}

// 延迟 import 环：mcp-oauth.ts 不引用本文件，这里只引类型。
import { McpOAuthClient } from './mcp-oauth';

/**
 * Streamable HTTP 连接（27 §11.2.2）：POST JSON-RPC 单次请求；SSE 响应按行解析。
 * W14b 首版仅实现同步 JSON 响应模式（最常见），SSE 流式按需扩展。
 */
export class McpHttpConnection extends EventEmitter {
  state: McpConnectionState = 'starting';
  serverInfo: { name: string; version: string; protocol_version: string } | null = null;
  lastError = '';
  private sessionID: string | null = null;
  private nextID = 1;

  constructor(
    readonly connectionId: string,
    readonly config: McpHttpConfig,
  ) {
    super();
  }

  private async post(body: unknown, timeoutMs: number, allowAuthRetry = true): Promise<{ status: number; json: unknown; sessionID: string | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // P01：OAuth 令牌注入（拿不到时不带 Authorization，匿名请求按服务器策略处理）。
      let authHeader: string | null = null;
      if (this.config.oauth) {
        authHeader = await this.config.oauth.authorizationHeader();
      }
      const response = await fetch(this.config.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(authHeader ? { Authorization: authHeader } : {}),
          ...(this.sessionID ? { 'Mcp-Session-Id': this.sessionID } : {}),
          ...this.config.headers,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      // P01：401 只刷新一次重试（刷新失败转 needs_reauth，错误原样返回，不无限重试）。
      if (response.status === 401 && this.config.oauth && allowAuthRetry) {
        const refreshed = await this.config.oauth.refreshOnce();
        if (refreshed) {
          return this.post(body, timeoutMs, false);
        }
      }
      const sessionID = response.headers.get('mcp-session-id');
      if (sessionID) this.sessionID = sessionID;
      const contentType = response.headers.get('content-type') ?? '';
      if (!response.ok) {
        throw new Error(`mcp_http_status: ${response.status}`);
      }
      if (contentType.includes('text/event-stream')) {
        // SSE 响应：取第一个 data: 行的 JSON（W14b 简化；流式多消息按需扩展）。
        const text = await response.text();
        for (const line of text.split('\n')) {
          if (line.startsWith('data:')) {
            return { status: response.status, json: JSON.parse(line.slice(5).trim()), sessionID };
          }
        }
        throw new Error('mcp_http_sse_empty');
      }
      return { status: response.status, json: await response.json(), sessionID };
    } finally {
      clearTimeout(timer);
    }
  }

  private call(method: string, params: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
    const id = this.nextID++;
    return this.post({ jsonrpc: '2.0', id, method, params }, timeoutMs).then(({ json }) => {
      const msg = json as { result?: unknown; error?: { message?: string } };
      if (msg.error) throw new Error(`mcp_error: ${msg.error.message ?? 'unknown'}`);
      return msg.result;
    });
  }

  async start(): Promise<void> {
    const init = (await this.call('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'ops-desktop', version: '0.1.0' },
    }, START_TIMEOUT_MS)) as { serverInfo?: { name?: string; version?: string }; protocolVersion?: string };
    this.serverInfo = {
      name: String(init.serverInfo?.name ?? 'unknown'),
      version: String(init.serverInfo?.version ?? ''),
      protocol_version: String(init.protocolVersion ?? MCP_PROTOCOL_VERSION),
    };
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, 5000).catch(() => undefined);
    this.setState('ready');
  }

  async catalog(): Promise<McpCatalog> {
    const tools: McpToolDescriptor[] = [];
    let cursor: string | undefined;
    do {
      const page = (await this.call('tools/list', cursor ? { cursor } : {})) as {
        tools?: Array<{ name: string; description?: string; inputSchema?: unknown; outputSchema?: unknown }>;
        nextCursor?: string;
      };
      for (const tool of page.tools ?? []) {
        tools.push({
          name: String(tool.name),
          description_hash: describeErrorHash(tool.description ?? ''),
          input_schema: tool.inputSchema ?? {},
          output_schema: tool.outputSchema,
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
    if (!this.serverInfo) throw new Error('未完成 initialize');
    return {
      tools,
      server_info: this.serverInfo,
      catalog_revision: describeErrorHash(JSON.stringify(tools.map((t) => [t.name, t.description_hash, t.input_schema]))),
    };
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    return this.call('tools/call', { name, arguments: args }, timeoutMs);
  }

  stop(): void {
    this.setState('stopped');
  }

  private setState(state: McpConnectionState): void {
    this.state = state;
    this.emit('state', state);
  }
}

/** 连接管理器：只管理自己启动的连接实例。 */
export class McpHostManager extends EventEmitter {
  private connections = new Map<string, McpStdioConnection | McpHttpConnection>();

  list(): Array<{ id: string; state: McpConnectionState; server: McpCatalog['server_info'] | null }> {
    return [...this.connections.values()].map((c) => ({ id: c.connectionId, state: c.state, server: c.serverInfo }));
  }

  get(id: string): McpStdioConnection | McpHttpConnection | undefined {
    return this.connections.get(id);
  }

  async startStdio(connectionId: string, config: McpStdioConfig): Promise<McpCatalog> {
    if (this.connections.has(connectionId)) throw new Error(`连接 ${connectionId} 已存在`);
    const connection = new McpStdioConnection(connectionId, config);
    this.connections.set(connectionId, connection);
    connection.on('state', (state) => this.emit('state', { connectionId, state }));
    try {
      await connection.start();
      return await connection.catalog();
    } catch (err) {
      connection.stop();
      this.connections.delete(connectionId);
      throw err;
    }
  }

  async startHttp(connectionId: string, config: McpHttpConfig): Promise<McpCatalog> {
    if (this.connections.has(connectionId)) throw new Error(`连接 ${connectionId} 已存在`);
    const connection = new McpHttpConnection(connectionId, config);
    this.connections.set(connectionId, connection);
    connection.on('state', (state) => this.emit('state', { connectionId, state }));
    try {
      await connection.start();
      return await connection.catalog();
    } catch (err) {
      connection.stop();
      this.connections.delete(connectionId);
      throw err;
    }
  }

  stop(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    connection.stop();
    this.connections.delete(connectionId);
    // P01：连接删除时清 OAuth 令牌文件（令牌零残留）。
    if (connection instanceof McpHttpConnection) {
      connection.config.oauth?.cleanup();
    }
  }

  stopAll(): void {
    for (const id of [...this.connections.keys()]) this.stop(id);
  }
}
