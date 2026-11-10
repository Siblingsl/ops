import { app, safeStorage, shell, type IpcMainInvokeEvent } from 'electron';
import { McpHostManager, type McpCatalog } from '../mcp-host';
import { McpOAuthClient, SafeStorageTokenStorage } from '../mcp-oauth';

// DT-08 片 1（≡DEV-S02，docs/33 §10.7 / §10.8 DT-08）：MCP 固定意图拆分。
// 从 main.ts registerIpcHandlers 原样搬出（含 DT-01 修复后的 oauth-status 顶层三键
// 与 A3 两片注释）；mcpHostManager / mcpOAuthClients 提升为本模块单例供退出清理
// （disposeApplicationResources）触达。契约与返回值形状逐字节不变。

let mcpHostManagerRef: McpHostManager | null = null;
let mcpOAuthClientsRef = new Map<string, McpOAuthClient>();

/** 退出清理（DT-03）触达句柄：stopAll 停 stdio/http 连接。 */
export function stopAllMcpHosts(): void {
  mcpHostManagerRef?.stopAll();
}

export function registerMcpIpcHandlers(deps: {
  ipcHandle: <T>(channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => T | Promise<T>) => void;
  requireComputerCaller: (event: IpcMainInvokeEvent) => void;
  onManagerReady?: (manager: McpHostManager) => void;
}): void {
  const { ipcHandle, requireComputerCaller } = deps;
  // DEV-AI27-A3 第一片（27 §11.2，P01 前置）：MCP 宿主最小接线——"验证连接"在本机
  // 真实握手（McpHostManager：stdio spawn / Streamable HTTP initialize+tools/list），
  // 目录回传渲染器，由渲染器经既有 actions API 上报服务端状态机（validate 由本机桥
  // 握手后上报目录/错误）。验证完即停（enable 后的运行中连接属调用执行片，另行接线）。
  // 失败返回真实错误码，渲染器如实上报 last_error（服务端失败不推进状态）。
  const mcpHosts = new McpHostManager();
  mcpHostManagerRef = mcpHosts;
  deps.onManagerReady?.(mcpHosts);
  ipcHandle('mcp:validate', async (event, raw) => {
    requireComputerCaller(event);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('mcp_validate_args_invalid');
    const body = raw as { connection_id?: unknown; transport?: unknown; command?: unknown; args?: unknown; cwd?: unknown; url?: unknown; oauth_client_id?: unknown; oauth_scopes?: unknown };
    const connectionId = typeof body.connection_id === 'string' && /^[0-9a-fA-F-]{36}$/.test(body.connection_id) ? body.connection_id : '';
    if (!connectionId) throw new Error('mcp_validate_connection_id_invalid');
    try {
      let catalog: McpCatalog;
      if (body.transport === 'stdio') {
        const command = typeof body.command === 'string' ? body.command.trim() : '';
        const args = Array.isArray(body.args) ? body.args.filter((a): a is string => typeof a === 'string').slice(0, 32) : [];
        const cwd = typeof body.cwd === 'string' && body.cwd.trim() ? body.cwd.trim() : process.cwd();
        if (!command) throw new Error('stdio 连接必须提供 command');
        catalog = await mcpHosts.startStdio(connectionId, { command, args, cwd });
      } else if (body.transport === 'http') {
        const url = typeof body.url === 'string' ? body.url.trim() : '';
        if (!url.startsWith('https://')) throw new Error('http 传输要求 https:// 地址');
        // A3 第二片：连接已配 OAuth（渲染端带 client_id）时注入 client——已授权自动带
        // Bearer，401 单次刷新（mcp-host 传输层语义）；无令牌时匿名请求按服务器策略处理。
        const oauthClientId = typeof body.oauth_client_id === 'string' && body.oauth_client_id.trim() ? body.oauth_client_id.trim() : undefined;
        const oauthScopes = Array.isArray(body.oauth_scopes)
          ? body.oauth_scopes.filter((s): s is string => typeof s === 'string').slice(0, 16)
          : undefined;
        const oauth = oauthClientId ? mcpOAuthClientOf(connectionId, url, oauthClientId, oauthScopes) : undefined;
        catalog = await mcpHosts.startHttp(connectionId, { url, ...(oauth ? { oauth } : {}) });
      } else {
        throw new Error('transport 只能是 stdio 或 http');
      }
      // 验证即停：stdio 不留常驻进程；目录已拿到，enable 后的运行中连接另行接线。
      mcpHosts.stop(connectionId);
      return { ok: true as const, catalog };
    } catch (error) {
      return { ok: false as const, code: 'mcp_validate_failed', message: String(error instanceof Error ? error.message : error).slice(0, 300) };
    }
  });
  // DEV-AI27-A3 第二片（27 §11.2，P01）：MCP OAuth 授权生命周期。http+OAuth 连接的
  // 授权全在本机：safeStorage 令牌仓（userData/mcp-tokens/<id>.bin）+ 系统浏览器授权 +
  // 回环回调收 code。IPC 返回值只含状态与过期时间（statusView 语义），绝不含令牌明文。
  // client 实例按连接缓存——authorize / validate 注入 / revoke 共享同一实例，刷新后
  // 的令牌落盘与内存状态保持一致。本片只支持 public client（PKCE，无需 client_secret）；
  // confidential client 的秘密录入需专门的本机安全设计，另行处理。
  const mcpOAuthStorage = new SafeStorageTokenStorage(app.getPath('userData'), safeStorage);
  const mcpOAuthClients = new Map<string, McpOAuthClient>();
  mcpOAuthClientsRef = mcpOAuthClients;
  const requireUuid = (value: unknown, what: string): string => {
    if (typeof value !== 'string' || !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value)) {
      throw new Error(`${what}_invalid`);
    }
    return value;
  };
  const mcpOAuthClientOf = (connectionId: string, serverUrl: string, clientId?: string, scopes?: string[]): McpOAuthClient => {
    const existing = mcpOAuthClients.get(connectionId);
    if (existing) return existing;
    const client = new McpOAuthClient(
      { connectionId, serverUrl, ...(clientId ? { clientId } : {}), ...(scopes?.length ? { scopes } : {}) },
      mcpOAuthStorage,
    );
    client.load(); // 重启后从落盘令牌恢复 authorized 状态
    mcpOAuthClients.set(connectionId, client);
    return client;
  };
  const parseOAuthInput = (raw: unknown): { connectionId: string; serverUrl: string; clientId?: string; scopes?: string[] } => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('mcp_oauth_args_invalid');
    const body = raw as { connection_id?: unknown; server_url?: unknown; client_id?: unknown; scopes?: unknown };
    const connectionId = requireUuid(body.connection_id, 'mcp_oauth_connection_id');
    const serverUrl = typeof body.server_url === 'string' ? body.server_url.trim() : '';
    if (!serverUrl.startsWith('https://')) throw new Error('mcp_oauth_server_url_invalid');
    const clientId = typeof body.client_id === 'string' && body.client_id.trim() ? body.client_id.trim() : undefined;
    const scopes = Array.isArray(body.scopes)
      ? body.scopes.filter((s): s is string => typeof s === 'string' && /^[\x21-\x7E]+$/.test(s)).slice(0, 16)
      : undefined;
    return { connectionId, serverUrl, clientId, scopes };
  };
  ipcHandle('mcp:oauth-start', async (event, raw) => {
    requireComputerCaller(event);
    const input = parseOAuthInput(raw);
    try {
      const client = mcpOAuthClientOf(input.connectionId, input.serverUrl, input.clientId, input.scopes);
      // authorize 走系统浏览器（回环收 code，上限 5 分钟）；阻塞至用户完成或超时。
      const outcome = await client.authorize((url) => { void shell.openExternal(url); });
      return { ok: outcome.state === 'authorized', state: outcome.state, reason: outcome.reason ?? '' };
    } catch (error) {
      return { ok: false as const, state: 'needs_reauth', reason: String(error instanceof Error ? error.message : error).slice(0, 200) };
    }
  });
  ipcHandle('mcp:oauth-status', async (event, raw) => {
    requireComputerCaller(event);
    const input = parseOAuthInput(raw);
    const client = mcpOAuthClientOf(input.connectionId, input.serverUrl, input.clientId, input.scopes);
    // DT-01（docs/33 §10.2）：返回体必须恰为 preload parseMcpOAuthStatus 白名单的
    // 顶层三键（state/expires_at/has_refresh）。此前包 {ok,status} 两层 → 白名单
    // 整批拒绝 → 渲染器恒降级 unauthorized。与 mcp:oauth-start 的顶层形状同风格。
    return client.statusView();
  });
  ipcHandle('mcp:oauth-revoke', async (event, raw) => {
    requireComputerCaller(event);
    const input = parseOAuthInput(raw);
    const client = mcpOAuthClientOf(input.connectionId, input.serverUrl, input.clientId, input.scopes);
    await client.revoke(); // 端点可达则服务端撤销；本地令牌文件无条件清零
    mcpOAuthClients.delete(input.connectionId);
    return { ok: true as const };
  });
}
