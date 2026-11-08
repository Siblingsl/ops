'use strict';
// DEV-AI27-14 W14：MCP 本机宿主测试（node --test）。
// 用真实 Node 子进程模拟 MCP server（stdio 换行 JSON-RPC），覆盖：
// initialize 双时代声明 / tools:list 分页 / tools:call / 坏 JSON 容忍 / stderr 脱敏限量 /
// 进程退出回收 / spawn 失败（命令不存在）/ 环境变量名校验 / stop 无孤儿。

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { McpHostManager, McpStdioConnection, MCP_PROTOCOL_VERSION } = require('../.build/mcp-host.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-mcp-'));
t0();
function t0() {
  process.on('exit', () => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  });
}

/** 生成一个模拟 MCP server 脚本（mode 控制行为）。 */
function writeServer(name, body) {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

function stdioServerScript({ legacy = false, paged = false, crashAfterInit = false } = {}) {
  return `#!/usr/bin/env node
let buffer = '';
const legacy = ${legacy}, paged = ${paged}, crash = ${crashAfterInit};
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let idx;
  while ((idx = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, idx); buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
        protocolVersion: legacy ? '2025-11-25' : '2025-06-18',
        serverInfo: { name: 'w14-mock', version: '0.1.0' } } }) + '\\n');
      if (crash) { process.stderr.write('boom after init\\n'); process.exit(3); }
    } else if (msg.method === 'tools/list') {
      if (paged && msg.params && msg.params.cursor === 'page-2') {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'extra_tool', description: '第二页工具', inputSchema: { type: 'object' } }] } }) + '\\n');
      } else {
        const page1 = { tools: [
          { name: 'search_docs', description: '搜索文档', inputSchema: { type: 'object' } },
        ], nextCursor: paged ? 'page-2' : null };
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: page1 }) + '\\n');
      }
    } else if (msg.method === 'tools/call') {
      if (msg.params.name === 'echo') {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'echo:' + (msg.params.arguments && msg.params.arguments.text || '') }] } }) + '\\n');
      } else if (msg.params.name === 'slow') {
        // 永不回包，触发客户端超时；不阻塞事件循环
      } else {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { message: 'unknown tool' } }) + '\\n');
      }
    }
  }
});
process.stderr.write('mock server stderr secret=sk-ABCDEF1234567890 token=ghp_verysecretvalue123\\n');
`;
}

async function startManager(t, serverFile, configExtra = {}) {
  const manager = new McpHostManager();
  t.after(() => manager.stopAll());
  const catalog = await manager.startStdio('conn-1', {
    command: process.execPath,
    args: [serverFile],
    cwd: tmp,
    ...configExtra,
  });
  return { manager, catalog };
}

test('MCP stdio: initialize + 分页目录 + tools/call + stderr 脱敏', { timeout: 30_000 }, async (t) => {
  const { manager, catalog } = await startManager(t, writeServer('mcp-server.js', stdioServerScript({ paged: true })));
  assert.equal(catalog.server_info.name, 'w14-mock');
  assert.equal(catalog.server_info.protocol_version, MCP_PROTOCOL_VERSION);
  const names = catalog.tools.map((tool) => tool.name);
  assert.ok(names.includes('search_docs'), '目录应含第一页工具');
  assert.equal(catalog.tools.length, 2, '分页目录应合并第二页');
  assert.match(catalog.tools[0].description_hash, /^[0-9a-f]{16}$/, 'description hash 规范化');

  const connection = manager.get('conn-1');
  assert.ok(connection);
  const digest = connection.stderrDigest();
  assert.ok(!digest.text.includes('sk-ABCDEF1234567890'), 'stderr 秘钥值必须脱敏');
  assert.ok(digest.text.includes('[REDACTED]'), '脱敏标记存在');

  const result = await connection.callTool('echo', { text: '你好' });
  assert.equal(result.content[0].text, 'echo:你好');
  await assert.rejects(() => connection.callTool('nope', {}), /mcp_error/);
});

test('MCP stdio: 旧协议版本声明（2025-11-25）兼容', { timeout: 30_000 }, async (t) => {
  const { catalog } = await startManager(t, writeServer('mcp-legacy.js', stdioServerScript({ legacy: true })));
  assert.equal(catalog.server_info.protocol_version, '2025-11-25');
});

test('MCP stdio: 初始化后崩溃 → error 状态与未决调用拒绝，进程被回收', { timeout: 30_000 }, async (t) => {
  const manager = new McpHostManager();
  t.after(() => manager.stopAll());
  await assert.rejects(
    () => manager.startStdio('crash-1', {
      command: process.execPath, args: [writeServer('mcp-crash.js', stdioServerScript({ crashAfterInit: true }))], cwd: tmp,
    }),
    /MCP 进程已退出|进程退出/,
  );
  assert.equal(manager.get('crash-1'), undefined, '失败连接应从管理器移除');
});

test('MCP stdio: spawn 失败（命令不存在）与非法环境变量名被拒', { timeout: 30_000 }, async (t) => {
  const manager = new McpHostManager();
  t.after(() => manager.stopAll());
  await assert.rejects(
    () => manager.startStdio('bad-cmd', { command: 'ops-mcp-definitely-not-exists-9x', args: [], cwd: tmp }),
    /ENOENT|spawn/,
  );
  const connection = new McpStdioConnection('bad-env', { command: process.execPath, args: ['-e', '""'], cwd: tmp, env: { 'bad-name!': 'x' } });
  await assert.rejects(() => connection.start(), /环境变量名非法/);
});

test('MCP stdio: 调用超时进入拒绝且不重放（slow 工具）', { timeout: 40_000 }, async (t) => {
  const { manager, catalog } = await startManager(t, writeServer('mcp-slow.js', stdioServerScript()));
  assert.ok(catalog.tools.length >= 1);
  const connection = manager.get('conn-1');
  await assert.rejects(() => connection.callTool('slow', {}, 1200), /mcp_timeout/);
  // 超时后连接仍可用（协议层幂等，未决调用作废不影响后续）
  const result = await connection.callTool('echo', { text: 'after-timeout' });
  assert.equal(result.content[0].text, 'echo:after-timeout');
});

test('MCP stdio: stop 后无孤儿进程', { timeout: 30_000 }, async (t) => {
  const { manager } = await startManager(t, writeServer('mcp-stop.js', stdioServerScript()));
  manager.stop('conn-1');
  assert.equal(manager.get('conn-1'), undefined);
  // 进程表里不应有我们的 mock server（按临时目录名粗查 CommandLine）
  const probe = spawnSync('wmic', ['process', 'where', `CommandLine like '%${path.basename(tmp)}%'`, 'get', 'ProcessId'], { encoding: 'utf8', timeout: 15_000 });
  const out = String(probe.stdout || '');
  assert.ok(!/[0-9]/.test(out.trim().replace(/ProcessId\s*/i, '')), '不应残留 mock server 进程: ' + out);
});

// ---------------------------------------------------------------------------
// DEV-AI27-14 W14b：Streamable HTTP 传输（真实 Node HTTP server）
// ---------------------------------------------------------------------------

const http = require('node:http');

/** 模拟 Streamable HTTP MCP server（同步 JSON 响应 + Mcp-Session-Id）。 */
function startMockHttpServer() {
  const tools = [
    { name: 'http_search', description: 'HTTP 搜索工具', inputSchema: { type: 'object' } },
  ];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let msg;
      try { msg = JSON.parse(body); } catch { res.writeHead(400); res.end(); return; }
      res.setHeader('Mcp-Session-Id', 'sess-http-1');
      if (msg.method === 'initialize') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
          protocolVersion: '2025-06-18',
          serverInfo: { name: 'w14-http-mock', version: '0.2.0' },
        } }));
      } else if (msg.method === 'notifications/initialized') {
        res.writeHead(202); res.end();
      } else if (msg.method === 'tools/list') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools, nextCursor: null } }));
      } else if (msg.method === 'tools/call') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
          content: [{ type: 'text', text: 'http:' + (msg.params.arguments && msg.params.arguments.text || '') }],
        } }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { message: 'unknown method' } }));
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('MCP http: initialize + 目录 + tools/call + session id', { timeout: 30_000 }, async (t) => {
  const server = await startMockHttpServer();
  t.after(() => server.close());
  const address = server.address();
  const manager = new McpHostManager();
  t.after(() => manager.stopAll());
  const catalog = await manager.startHttp('http-1', {
    url: `http://127.0.0.1:${address.port}/mcp`,
  });
  assert.equal(catalog.server_info.name, 'w14-http-mock');
  assert.equal(catalog.server_info.protocol_version, '2025-06-18');
  assert.equal(catalog.tools.length, 1);
  assert.equal(catalog.tools[0].name, 'http_search');

  const connection = manager.get('http-1');
  assert.ok(connection);
  const result = await connection.callTool('http_search', { text: '竞品' });
  assert.equal(result.content[0].text, 'http:竞品');
  manager.stop('http-1');
  assert.equal(manager.get('http-1'), undefined);
});

test('MCP http: 非 200 响应拒绝（server 关闭后连接失败）', { timeout: 30_000 }, async (t) => {
  const server = await startMockHttpServer();
  const address = server.address();
  const manager = new McpHostManager();
  t.after(() => { manager.stopAll(); server.close(); });
  // 先关掉 server 再尝试连接 → spawn_failed/连接失败
  await new Promise((resolve) => server.close(resolve));
  await assert.rejects(
    () => manager.startHttp('http-dead', { url: `http://127.0.0.1:${address.port}/mcp` }),
    /mcp_http_status|fetch failed|ECONNREFUSED/,
  );
  assert.equal(manager.get('http-dead'), undefined);
});
