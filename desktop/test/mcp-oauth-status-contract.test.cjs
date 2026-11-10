'use strict';
// DT-01（docs/33 §10.2）：MCP OAuth 状态查询契约。
// 主进程 mcp:oauth-status 必须返回 statusView() 的顶层三键，与 preload
// parseMcpOAuthStatus 白名单（state/expires_at/has_refresh）形状一致。
// 缺陷形态（修复前）：主进程包 {ok:true,status:{...}} 两键 → preload 逐键白名单
// 解析恒为 null → getMcpOAuthStatus 恒降级 unauthorized，已授权连接被误显示未授权。
// 令牌零泄漏断言（白名单三键、多余键整批拒绝）在 preload 侧，保持不动。

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const { McpOAuthClient } = require('../.build/mcp-oauth.js');

// ---------------------------------------------------------------------------
// 内存令牌仓：写入一条已授权令牌，让 statusView 呈现 authorized 语义
// ---------------------------------------------------------------------------

function authorizedStorage(connectionId) {
  const blob = Buffer.concat([
    Buffer.from('enc:'),
    Buffer.from(JSON.stringify({
      accessToken: 'at-contract-1',
      refreshToken: 'rt-contract-1',
      expiresAt: Date.now() + 3600_000,
      tokenType: 'Bearer',
    }), 'utf8'),
  ]);
  return {
    isEncryptionAvailable: () => true,
    encrypt: (plain) => Buffer.concat([Buffer.from('enc:'), Buffer.from(plain, 'utf8')]),
    decrypt: (b) => Buffer.from(b).toString('utf8').replace(/^enc:/, ''),
    read: (id) => (id === connectionId ? blob : null),
    write: () => { throw new Error('contract test 不应写入'); },
    remove: () => {},
  };
}

function loadPreload(electron) {
  const preloadPath = require.resolve('../.build/business-ui-preload.js');
  const originalLoad = Module._load;
  try {
    Module._load = function (request, parent, isMain) {
      if (request === 'electron') return electron;
      return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[preloadPath];
    require(preloadPath);
  } finally {
    Module._load = originalLoad;
  }
}

// ---------------------------------------------------------------------------
// 端到端语义：真实 statusView() 输出经 preload 解析后保持原状态
// ---------------------------------------------------------------------------

test('DT-01: authorized 的 statusView 经 preload 解析后仍为 authorized（不含令牌）', async () => {
  const connectionId = '00000001-1111-4111-8111-111111111111';
  const client = new McpOAuthClient(
    { connectionId, serverUrl: 'https://mcp.example.com/v1', clientId: 'ops-desktop' },
    authorizedStorage(connectionId),
  );
  client.load();
  const view = client.statusView();
  assert.equal(view.state, 'authorized');
  assert.equal(view.has_refresh, true);
  assert.ok(!JSON.stringify(view).includes('at-contract-1'), 'statusView 不得含 access token');
  assert.ok(!JSON.stringify(view).includes('rt-contract-1'), 'statusView 不得含 refresh token');

  const exposed = {};
  const contextBridge = { exposeInMainWorld(name, value) { exposed[name] = value; } };
  let respond = () => Promise.resolve(view);
  const ipcRenderer = {
    on() {},
    removeListener() {},
    invoke() { return respond(); },
  };
  loadPreload({ contextBridge, ipcRenderer });
  assert.deepEqual(await exposed.opsDesktopUI.getMcpOAuthStatus({
    connection_id: connectionId, server_url: 'https://mcp.example.com/v1',
  }), { state: 'authorized', expires_at: view.expires_at, has_refresh: true });
});

test('DT-01: 旧缺陷形状 {ok,status} 经 preload 仍被整批拒绝并降级（失败模式留痕）', async () => {
  const exposed = {};
  const contextBridge = { exposeInMainWorld(name, value) { exposed[name] = value; } };
  const ipcRenderer = {
    on() {},
    removeListener() {},
    invoke() {
      return Promise.resolve({
        ok: true,
        status: { state: 'authorized', expires_at: '2026-11-10T12:00:00.000Z', has_refresh: true },
      });
    },
  };
  loadPreload({ contextBridge, ipcRenderer });
  assert.deepEqual(await exposed.opsDesktopUI.getMcpOAuthStatus({
    connection_id: '00000001-1111-4111-8111-111111111111', server_url: 'https://mcp.example.com/v1',
  }), { state: 'unauthorized', expires_at: null, has_refresh: false });
});

// ---------------------------------------------------------------------------
// 主进程形状契约：handler 返回体必须直接是 statusView()，不得再包 {ok,status}
// ---------------------------------------------------------------------------

/** 从指定源文件里按大括号配平截取某个 ipcHandle 通道的 handler 块。 */
function extractIpcHandleBlock(source, channel) {
  const marker = `ipcHandle('${channel}'`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `源文件应注册 ${channel} 通道`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  assert.fail(`${channel} handler 块未闭合`);
}

test('DT-01: 主进程 mcp:oauth-status 直接返回 statusView()，无 {ok,status} 包装', () => {
  // DT-08 片 1：MCP 通道已拆至 src/ipc/mcp.ts（契约不变）；main.ts 不得再有该通道注册。
  const mcpSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'ipc', 'mcp.ts'), 'utf8');
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.ts'), 'utf8');
  const block = extractIpcHandleBlock(mcpSource, 'mcp:oauth-status');
  assert.ok(!mainSource.includes("ipcHandle('mcp:oauth-status'"), 'main.ts 不应残留 mcp:oauth-status 注册（已拆至 ipc/mcp.ts）');
  assert.ok(block.includes('return client.statusView()'), 'handler 应顶层返回 statusView()');
  assert.ok(!/status\s*:/.test(block), '不得把 statusView 包进 status 键（preload 白名单会整批拒绝）');
  assert.ok(!/ok\s*:\s*true/.test(block), '不得附加 ok 键（返回体必须恰为三键白名单）');
});

test('DT-01: preload 令牌零泄漏白名单保持三键，未被本次修复放宽', () => {
  const preloadSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'business-ui-preload.ts'), 'utf8',
  );
  assert.ok(
    preloadSource.includes("Object.keys(value).sort().join(',') !== 'expires_at,has_refresh,state'"),
    'parseMcpOAuthStatus 白名单应保持 state/expires_at/has_refresh 三键',
  );
});
