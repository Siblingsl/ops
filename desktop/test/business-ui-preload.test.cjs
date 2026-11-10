const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

test('exposes one-shot long-image capture intent with a build ID and read-only subscriptions', async () => {
  const exposed = {};
  const handlers = new Map();
  const invokes = [];
  const contextBridge = {
    exposeInMainWorld(name, value) { exposed[name] = value; },
  };
  const ipcRenderer = {
    on(channel, handler) {
      const listeners = handlers.get(channel) ?? new Set();
      listeners.add(handler);
      handlers.set(channel, listeners);
    },
    removeListener(channel, handler) { handlers.get(channel)?.delete(handler); },
    invoke(channel, payload) {
      invokes.push({ channel, payload });
      return Promise.resolve({ ok: false, code: 'render_not_ready', message: '页面未就绪。' });
    },
  };
  const preloadPath = require.resolve('../.build/business-ui-preload.js');
  const originalLoad = Module._load;
  try {
    Module._load = function (request, parent, isMain) {
      if (request === 'electron') return { contextBridge, ipcRenderer };
      return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[preloadPath];
    require(preloadPath);
  } finally {
    Module._load = originalLoad;
  }

  assert.deepEqual(Object.keys(exposed), ['opsDesktopUI']);
  assert.deepEqual(Object.keys(exposed.opsDesktopUI).sort(), [
    'captureLongImage',
    'getMcpOAuthStatus',
    'invokeInBrowse',
    'listBrowserTabs',
    'listComputerWindows',
    'onClientHealth',
    'onInBrowseSnapshot',
    'onLocalSettingsState',
    'onOpenSettings',
    'onPlatformIntentResult',
    'onRealtimeEvent',
    'onSidepanelDraft',
    'onSidepanelStop',
    'revokeMcpOAuth',
    'startMcpOAuth',
    'validateMcpConnection'
  ]);
  // DEV-AI27-08（W08）：内置浏览意图白名单桥随 captureLongImage 一并暴露。
  // DEV-AI27-17（W17b，A12）：本机选窗是独立固定意图，不并入 invokeInBrowse 白名单。
  // DEV-AI27-A30：本机标签枚举同口径独立暴露。
  // DEV-AI27-A3：MCP 验证与 OAuth 生命周期为独立固定意图（握手/授权在本机，秘密不进 IPC）。
  assert.deepEqual(Object.keys(exposed.opsDesktopUI).filter((key) => !key.startsWith('on')),
    ['captureLongImage', 'listComputerWindows', 'listBrowserTabs', 'validateMcpConnection', 'startMcpOAuth', 'getMcpOAuthStatus', 'revokeMcpOAuth', 'invokeInBrowse']);
  const buildId = '00000008-1111-4111-8111-111111111111';
  assert.deepEqual(await exposed.opsDesktopUI.captureLongImage(buildId), {
    ok: false, code: 'render_not_ready', message: '页面未就绪。'
  });
  assert.deepEqual(invokes, [{ channel: 'cx-long-image:capture', payload: { buildId } }]);
  assert.deepEqual(await exposed.opsDesktopUI.captureLongImage('not-an-id'), {
    ok: false, code: 'invalid_input', message: '长图构建参数无效。'
  });
  assert.equal(invokes.length, 1);

  // A12：本机选窗走独立固定意图；Electron 侧失败要原样传到渲染器（不伪造空列表）。
  assert.deepEqual(await exposed.opsDesktopUI.listComputerWindows(), {
    ok: false, code: 'render_not_ready', message: '页面未就绪。'
  });
  assert.deepEqual(invokes.at(-1), { channel: 'computer:list-windows', payload: undefined });

  // A30：本机标签枚举同口径；Electron 侧失败（桥未启动/未配对）原样传到渲染器。
  assert.deepEqual(await exposed.opsDesktopUI.listBrowserTabs(), {
    ok: false, code: 'render_not_ready', message: '页面未就绪。'
  });
  assert.deepEqual(invokes.at(-1), { channel: 'browser:list-tabs', payload: undefined });

  // A3 第一片：MCP 验证失败原样透出（渲染器如实上报 last_error，不伪造已验证）。
  assert.deepEqual(await exposed.opsDesktopUI.validateMcpConnection({
    connection_id: '00000001-1111-4111-8111-111111111111', transport: 'http', url: 'https://mcp.example.com/v1',
  }), { ok: false, code: 'render_not_ready', message: '页面未就绪。' });
  assert.deepEqual(invokes.at(-1), { channel: 'mcp:validate', payload: { connection_id: '00000001-1111-4111-8111-111111111111', transport: 'http', url: 'https://mcp.example.com/v1' } });

  emit(handlers, 'desktop-ui:open-settings');
  let firstOpen = 0;
  let secondOpen = 0;
  const unsubscribeOpen = exposed.opsDesktopUI.onOpenSettings(() => { firstOpen += 1; });
  const unsubscribeSecondOpen = exposed.opsDesktopUI.onOpenSettings(() => { secondOpen += 1; });
  assert.equal(firstOpen, 1);
  assert.equal(secondOpen, 0);
  emit(handlers, 'desktop-ui:open-settings');
  assert.equal(firstOpen, 2);
  assert.equal(secondOpen, 1);
  unsubscribeOpen();
  emit(handlers, 'desktop-ui:open-settings');
  assert.equal(firstOpen, 2);
  assert.equal(secondOpen, 2);
  unsubscribeSecondOpen();

  emit(handlers, 'desktop-ui:local-settings-state', { dirty: true, busy: false });
  const states = [];
  const unsubscribeState = exposed.opsDesktopUI.onLocalSettingsState((state) => states.push(state));
  assert.deepEqual(states, [{ dirty: true, busy: false }]);
  emit(handlers, 'desktop-ui:local-settings-state', { dirty: false, busy: true });
  assert.deepEqual(states, [{ dirty: true, busy: false }, { dirty: false, busy: true }]);
  unsubscribeState();
  emit(handlers, 'desktop-ui:local-settings-state', { dirty: false, busy: false });
  assert.equal(states.length, 2);

  const results = [];
  const unsubscribeResult = exposed.opsDesktopUI.onPlatformIntentResult((result) => results.push(result));
  const requestId = '00000004-1111-4111-8111-111111111111';
  const accountId = '00000003-1111-4111-8111-111111111111';
  const operationId = '00000007-1111-4111-8111-111111111111';
  const channel = 'desktop-ui:platform-intent-result';
  emit(handlers, channel, { kind: 'platform-account-sync', requestId, accountId, status: 'queued' });
  emit(handlers, channel, { kind: 'platform-metrics-refresh', requestId, accountId, status: 'existing', operationId });
  emit(handlers, channel, { kind: 'platform-metrics-refresh', requestId, accountId, status: 'failed', message: '指标刷新服务未就绪。' });
  emit(handlers, channel, { kind: 'platform-sync-resume', requestId, accountId, status: 'queued', operationId });

  // Only the resume result requires an operation ID and only queued/failed are valid.
  emit(handlers, channel, { kind: 'platform-sync-resume', requestId, accountId, status: 'queued' });
  emit(handlers, channel, { kind: 'platform-sync-resume', requestId, accountId, status: 'existing', operationId });
  emit(handlers, channel, { kind: 'platform-sync-resume', requestId, accountId, status: 'queued', operationId: 'not-a-uuid' });
  emit(handlers, channel, { kind: 'platform-metrics-refresh', requestId, accountId, status: 'queued', operationId: 'not-a-uuid' });
  emit(handlers, channel, { kind: 'platform-account-sync', requestId: 'not-a-uuid', accountId, status: 'failed' });
  emit(handlers, channel, { kind: 'unknown', requestId, accountId, status: 'queued' });
  emit(handlers, channel, { kind: 'platform-account-sync', requestId, accountId, status: 'running' });
  emit(handlers, channel, { kind: 'platform-account-sync', requestId, accountId, status: 'failed', message: 'x'.repeat(201) });
  emit(handlers, channel, { kind: 'platform-account-sync', requestId, accountId, status: 'failed', message: '同步服务未就绪。' });

  assert.deepEqual(results, [
    { kind: 'platform-account-sync', requestId, accountId, status: 'queued' },
    { kind: 'platform-metrics-refresh', requestId, accountId, status: 'existing', operationId },
    { kind: 'platform-metrics-refresh', requestId, accountId, status: 'failed', message: '指标刷新服务未就绪。' },
    { kind: 'platform-sync-resume', requestId, accountId, status: 'queued', operationId },
    { kind: 'platform-account-sync', requestId, accountId, status: 'failed', message: '同步服务未就绪。' },
  ]);
  unsubscribeResult();
  emit(handlers, channel, { kind: 'platform-account-sync', requestId, accountId, status: 'queued' });
  assert.equal(results.length, 5);

  const healthResults = [];
  const unsubscribeHealth = exposed.opsDesktopUI.onClientHealth((health) => healthResults.push(health));
  const health = {
    channelState: 'ready', channelMessage: '连接正常',
    collection: { status: 'idle', message: '暂未运行', updatedAt: null },
    presence: { status: 'online', message: '在线', updatedAt: 1 },
  };
  emit(handlers, 'desktop-ui:client-health', health);
  emit(handlers, 'desktop-ui:client-health', { ...health, channelState: 'unexpected' });
  assert.deepEqual(healthResults, [health]);
  unsubscribeHealth();
});

function emit(handlers, channel, payload) {
  for (const listener of handlers.get(channel) ?? []) listener({}, payload);
}

// A12/C09：主进程返回的窗口列表必须逐项符合固定 schema；任何越界都整批拒绝，
// 不让渲染器拿到未校验的标题/进程信息。
test('rejects a window list that does not match the fixed schema', async () => {
  const exposed = {};
  const contextBridge = { exposeInMainWorld(name, value) { exposed[name] = value; } };
  const ipcRenderer = {
    on() {},
    removeListener() {},
    invoke() {
      return Promise.resolve({
        ok: true,
        windows: [{ handle: 'not-a-32-hex', process: 'notepad', title: '文档', forbidden: false }],
      });
    },
  };
  loadPreload({ contextBridge, ipcRenderer });
  assert.deepEqual(await exposed.opsDesktopUI.listComputerWindows(), {
    ok: false, code: 'computer_windows_invalid', message: 'Electron 返回的窗口列表无效。'
  });
});

// A30：主进程返回的标签列表同样逐项固定 schema；越界整批拒绝（不伪造列表）。
test('rejects a browser tab list that does not match the fixed schema', async () => {
  const exposed = {};
  const contextBridge = { exposeInMainWorld(name, value) { exposed[name] = value; } };
  const ipcRenderer = {
    on() {},
    removeListener() {},
    invoke() {
      return Promise.resolve({
        ok: true,
        tabs: [{ tab_id: 'not-a-number', title: '页面', origin: 'https://example.com', window_id: 1, active: true }],
      });
    },
  };
  loadPreload({ contextBridge, ipcRenderer });
  assert.deepEqual(await exposed.opsDesktopUI.listBrowserTabs(), {
    ok: false, code: 'browser_tabs_invalid', message: 'Electron 返回的标签列表无效。'
  });
});

// A3 第一片：MCP 验证结果同样逐项固定 schema——目录只含工具名/哈希/schema，越界整批拒绝；
// 渲染器拿不到未校验的 catalog，也不会把无效结果当成功上报。
test('rejects an mcp validate result that does not match the fixed schema', async () => {
  const exposed = {};
  const contextBridge = { exposeInMainWorld(name, value) { exposed[name] = value; } };
  const ipcRenderer = {
    on() {},
    removeListener() {},
    invoke() {
      return Promise.resolve({
        ok: true,
        catalog: {
          tools: [{ name: 'search_docs', description_hash: 'not-16-hex', input_schema: {} }],
          server_info: { name: 'srv', version: '1.0.0', protocol_version: '2025-06-18' },
          catalog_revision: 'rev-1',
        },
      });
    },
  };
  loadPreload({ contextBridge, ipcRenderer });
  assert.deepEqual(await exposed.opsDesktopUI.validateMcpConnection({
    connection_id: '00000001-1111-4111-8111-111111111111', transport: 'stdio', command: 'node', args: [],
  }), { ok: false, code: 'mcp_validate_invalid', message: 'Electron 返回的验证结果无效。' });
});

// A3 第二片：OAuth 状态摘要白名单 schema——任何多余键（access_token/refresh_token 等）
// 一律整批拒绝，令牌明文不可能经 status IPC 泄漏到渲染器。
test('rejects an oauth status that carries any field beyond the state summary', async () => {
  const exposed = {};
  const contextBridge = { exposeInMainWorld(name, value) { exposed[name] = value; } };
  const ipcRenderer = {
    on() {},
    removeListener() {},
    invoke() {
      return Promise.resolve({
        state: 'authorized',
        expires_at: '2026-11-10T12:00:00.000Z',
        has_refresh: true,
        access_token: 'SHOULD-NOT-LEAK',
      });
    },
  };
  loadPreload({ contextBridge, ipcRenderer });
  assert.deepEqual(await exposed.opsDesktopUI.getMcpOAuthStatus({
    connection_id: '00000001-1111-4111-8111-111111111111', server_url: 'https://mcp.example.com/v1',
  }), { state: 'unauthorized', expires_at: null, has_refresh: false });
});

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
