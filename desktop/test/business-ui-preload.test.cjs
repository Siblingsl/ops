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
    'actComputerUIA',
    'captureLongImage',
    'confirmBrowserPairing',
    'getBrowserPairingState',
    'getMcpOAuthStatus',
    'invalidateComputerUIA',
    'invokeComputerUIA',
    'invokeInBrowse',
    'listBrowserTabs',
    'listComputerWindows',
    'observeComputerUIA',
    'onClientHealth',
    'onInBrowseSnapshot',
    'onLocalSettingsState',
    'onOpenSettings',
    'onPlatformIntentResult',
    'onRealtimeEvent',
    'onSidepanelDraft',
    'onSidepanelStop',
    'readComputerUIA',
    'revokeMcpOAuth',
    'startMcpOAuth',
    'validateMcpConnection'
  ]);
  // DEV-AI27-08（W08）：内置浏览意图白名单桥随 captureLongImage 一并暴露。
  // DEV-AI27-17（W17b，A12）：本机选窗是独立固定意图，不并入 invokeInBrowse 白名单。
  // DEV-AI27-A30：本机标签枚举同口径独立暴露。
  // DEV-AI27-A30b：桥配对快照/确认同口径独立暴露（快照白名单校验，无会话密钥）。
  // DEV-AI27-A3：MCP 验证与 OAuth 生命周期为独立固定意图（握手/授权在本机，秘密不进 IPC）。
  // DT-04（W17c）：UIA 读/调用同口径独立固定意图（C09 白名单逐控件校验）。
  assert.deepEqual(Object.keys(exposed.opsDesktopUI).filter((key) => !key.startsWith('on')).sort(),
    ['actComputerUIA', 'captureLongImage', 'confirmBrowserPairing', 'getBrowserPairingState',
     'getMcpOAuthStatus', 'invalidateComputerUIA', 'invokeComputerUIA', 'invokeInBrowse',
     'listBrowserTabs', 'listComputerWindows', 'observeComputerUIA', 'readComputerUIA',
     'revokeMcpOAuth', 'startMcpOAuth', 'validateMcpConnection']);
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

// DEV-CU P5-2（用户选定方案①）：窗口项必须带正整数 pid（observe/act 的必填入参）；
// 缺失或非法整批拒绝，pid 存在时只透出白名单五键，其它字段不进渲染器。
test('requires a positive integer pid on every window item', async () => {
  for (const pid of [undefined, 0, -1, 1.5, '4242']) {
    const exposed = {};
    const contextBridge = { exposeInMainWorld(name, value) { exposed[name] = value; } };
    const ipcRenderer = {
      on() {},
      removeListener() {},
      invoke() {
        return Promise.resolve({
          ok: true,
          windows: [{
            pid, handle: 'a'.repeat(32), process: 'notepad', title: '文档', forbidden: false,
          }],
        });
      },
    };
    loadPreload({ contextBridge, ipcRenderer });
    assert.deepEqual(await exposed.opsDesktopUI.listComputerWindows(), {
      ok: false, code: 'computer_windows_invalid', message: 'Electron 返回的窗口列表无效。',
    }, `pid=${String(pid)} 必须整批拒绝`);
  }

  const exposed = {};
  const contextBridge = { exposeInMainWorld(name, value) { exposed[name] = value; } };
  const ipcRenderer = {
    on() {},
    removeListener() {},
    invoke() {
      return Promise.resolve({
        ok: true,
        windows: [{
          pid: 4242, handle: 'a'.repeat(32), process: 'notepad', title: '文档', forbidden: false,
          process_path: 'C:\\Windows\\notepad.exe', hwnd: 987654,
        }],
      });
    },
  };
  loadPreload({ contextBridge, ipcRenderer });
  assert.deepEqual(await exposed.opsDesktopUI.listComputerWindows(), {
    ok: true,
    windows: [{ pid: 4242, handle: 'a'.repeat(32), process: 'notepad', title: '文档', forbidden: false }],
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

// A30b：桥配对快照白名单 schema——任何多余键（session_key/hkdf_salt 等）整批拒绝，
// 会话密钥不可能经 pairing-state IPC 泄漏到渲染器；确认结果同样只允许实例 ID。
test('rejects a browser pairing snapshot that carries any field beyond the whitelist', async () => {
  const exposed = {};
  const contextBridge = { exposeInMainWorld(name, value) { exposed[name] = value; } };
  const ipcRenderer = {
    on() {},
    removeListener() {},
    invoke() {
      return Promise.resolve({
        ok: true,
        snapshot: {
          state: 'pairing',
          pairing: { code: '012345', expires_at: 9999999999999, expired: false },
          extension_instance_id: 'ext-abc',
          host_pid: 4321,
          session_key: 'SHOULD-NOT-LEAK',
        },
      });
    },
  };
  loadPreload({ contextBridge, ipcRenderer });
  assert.deepEqual(await exposed.opsDesktopUI.getBrowserPairingState(), {
    ok: false, code: 'browser_pairing_state_invalid', message: 'Electron 返回的配对状态无效。',
  });
});

test('passes a well-formed browser pairing snapshot through and rejects a malformed code', async () => {
  const exposed = {};
  const contextBridge = { exposeInMainWorld(name, value) { exposed[name] = value; } };
  let respond = () => Promise.resolve({
    ok: true,
    snapshot: {
      state: 'pairing',
      pairing: { code: '012345', expires_at: 9999999999999, expired: false },
      extension_instance_id: 'ext-abc',
      host_pid: 4321,
    },
  });
  const ipcRenderer = {
    on() {},
    removeListener() {},
    invoke: (...args) => respond(...args),
  };
  loadPreload({ contextBridge, ipcRenderer });
  const result = await exposed.opsDesktopUI.getBrowserPairingState();
  assert.deepEqual(result, {
    ok: true,
    snapshot: {
      state: 'pairing',
      pairing: { code: '012345', expires_at: 9999999999999, expired: false },
      extension_instance_id: 'ext-abc',
      host_pid: 4321,
    },
  });
  // 短码形态不符（桥固定 6 位数字）→ 整份拒绝。
  respond = () => Promise.resolve({
    ok: true,
    snapshot: {
      state: 'pairing',
      pairing: { code: '12ab45', expires_at: 9999999999999, expired: false },
      extension_instance_id: 'ext-abc',
      host_pid: 4321,
    },
  });
  assert.deepEqual(await exposed.opsDesktopUI.getBrowserPairingState(), {
    ok: false, code: 'browser_pairing_state_invalid', message: 'Electron 返回的配对状态无效。',
  });
});

test('rejects a browser pairing confirm result that carries fields beyond the instance id', async () => {
  const exposed = {};
  const contextBridge = { exposeInMainWorld(name, value) { exposed[name] = value; } };
  const ipcRenderer = {
    on() {},
    removeListener() {},
    invoke() {
      return Promise.resolve({ ok: true, extension_instance_id: 'ext-abc', session_key: 'SHOULD-NOT-LEAK' });
    },
  };
  loadPreload({ contextBridge, ipcRenderer });
  assert.deepEqual(await exposed.opsDesktopUI.confirmBrowserPairing(), {
    ok: false, code: 'browser_pairing_confirm_invalid', message: 'Electron 返回的配对确认结果无效。',
  });
});

// DEV-CU P3-7（§4.12 / C09）：observe 树节点键集合整批拒绝——
// 进程路径 / 窗口句柄 / 类名等越界字段一旦出现，整份结果作废，渲染器拿不到任何节点。
test('rejects an observe tree whose node carries a field beyond the whitelist', async () => {
  for (const extra of ['process_path', 'hwnd', 'class_name']) {
    const exposed = {};
    const contextBridge = { exposeInMainWorld(name, value) { exposed[name] = value; } };
    const ipcRenderer = {
      on() {},
      removeListener() {},
      invoke() {
        return Promise.resolve({
          ok: true,
          snapshot_id: 's1abc',
          revision: 1,
          ref_count: 1,
          complete: true,
          nodes_observed: 1,
          tree: { ...observeNode(), [extra]: 'SHOULD-NOT-LEAK' },
        });
      },
    };
    loadPreload({ contextBridge, ipcRenderer });
    assert.deepEqual(await exposed.opsDesktopUI.observeComputerUIA({
      pid: 4321, target_summary: '记事本', grant_id: 'g-1', generation: 1,
    }), {
      ok: false, code: 'computer_uia_invalid', message: 'Electron 返回的 UIA 观察结果无效。',
    }, `多余字段 ${extra} 必须整批拒绝`);
  }
});

// DEV-CU P3-7 步骤 3：长度上限逐项（name ≤500、value ≤4000、snapshot_id ≤64、节点 ≤200、树深 ≤50）。
test('rejects observe results that exceed the per-field or tree limits', async () => {
  const cases = [
    { label: 'name 501', mutate: (r) => { r.tree.name = 'n'.repeat(501); } },
    { label: 'value 4001', mutate: (r) => { r.tree.value = 'v'.repeat(4001); } },
    { label: 'snapshot_id 65', mutate: (r) => { r.snapshot_id = 's'.repeat(65); } },
    { label: 'ref_id 65', mutate: (r) => { r.tree.ref_id = 'e'.repeat(65); } },
    { label: '节点 201', mutate: (r) => { r.tree.children = Array.from({ length: 200 }, () => observeNode()); } },
    { label: '树深 51', mutate: (r) => { r.tree = observeChain(51); } },
    { label: 'available_actions 越界', mutate: (r) => { r.tree.available_actions = ['Click', 'RunScript']; } },
    { label: 'states 越界', mutate: (r) => { r.tree.states = ['enabled', 'hijacked']; } },
  ];
  for (const item of cases) {
    const exposed = {};
    const contextBridge = { exposeInMainWorld(name, value) { exposed[name] = value; } };
    const ipcRenderer = {
      on() {},
      removeListener() {},
      invoke() {
        const result = {
          ok: true, snapshot_id: 's1abc', revision: 1, ref_count: 1,
          complete: true, nodes_observed: 1, tree: observeNode(),
        };
        item.mutate(result);
        return Promise.resolve(result);
      },
    };
    loadPreload({ contextBridge, ipcRenderer });
    assert.deepEqual(await exposed.opsDesktopUI.observeComputerUIA({
      pid: 4321, target_summary: '记事本', grant_id: 'g-1', generation: 1,
    }), {
      ok: false, code: 'computer_uia_invalid', message: 'Electron 返回的 UIA 观察结果无效。',
    }, item.label);
  }
});

// DEV-CU P3-7 步骤 1：合法 observe 结果原样透出白名单字段（含可选 truncated / identity_unproven）。
test('passes a well-formed observe result through with only the whitelisted fields', async () => {
  const exposed = {};
  const contextBridge = { exposeInMainWorld(name, value) { exposed[name] = value; } };
  const ipcRenderer = {
    on() {},
    removeListener() {},
    invoke() {
      return Promise.resolve({
        ok: true, snapshot_id: 's1abc', revision: 3, ref_count: 2, complete: false,
        nodes_observed: 2, truncated: true, identity_unproven: true,
        tree: { ...observeNode(), children: [observeNode()], children_count: 1 },
      });
    },
  };
  loadPreload({ contextBridge, ipcRenderer });
  const result = await exposed.opsDesktopUI.observeComputerUIA({
    pid: 4321, target_summary: '记事本', grant_id: 'g-1', generation: 1,
    max_depth: 3, interactive_only: true, compact: false,
  });
  assert.equal(result.ok, true);
  assert.equal(result.snapshot_id, 's1abc');
  assert.equal(result.revision, 3);
  assert.equal(result.ref_count, 2);
  assert.equal(result.complete, false);
  assert.equal(result.nodes_observed, 2);
  assert.equal(result.truncated, true);
  assert.equal(result.identity_unproven, true);
  assert.deepEqual(Object.keys(result.tree).sort(), [
    'available_actions', 'bounds', 'children', 'children_count', 'depth',
    'name', 'ref_id', 'role', 'states', 'value',
  ]);
  assert.equal(result.tree.children.length, 1);
});

// DEV-CU P3-7：act 结果的 disposition 双字段必须自洽（五态×retry 全表）；
// 不自洽即整份拒绝，避免渲染器把「可能已生效」当成可重试。
test('rejects an act result whose disposition pair is inconsistent', async () => {
  const exposed = {};
  const contextBridge = { exposeInMainWorld(name, value) { exposed[name] = value; } };
  const ipcRenderer = {
    on() {},
    removeListener() {},
    invoke() {
      return Promise.resolve({
        ok: true, action: 'Click', disposition: { delivery: 'delivered_verified', retry: 'safe' },
      });
    },
  };
  loadPreload({ contextBridge, ipcRenderer });
  assert.deepEqual(await exposed.opsDesktopUI.actComputerUIA({
    pid: 4321, ref: '@s1abc:e1', grant_id: 'g-1', generation: 1, action: 'Click', target_summary: '记事本',
  }), { ok: false, code: 'computer_uia_invalid', message: 'Electron 返回的 UIA 动作结果无效。' });
});

test('passes a well-formed act result through and keeps the disposition pair', async () => {
  const exposed = {};
  const contextBridge = { exposeInMainWorld(name, value) { exposed[name] = value; } };
  const ipcRenderer = {
    on() {},
    removeListener() {},
    invoke() {
      return Promise.resolve({
        ok: true, action: 'SetValue', snapshot_id: 's1abc', ref: '@s1abc:e1',
        disposition: { delivery: 'delivered_verified', retry: 'unsafe' },
        verification_scope: 'element_value',
        steps: [{ label: 'ValuePattern', outcome: 'ok', mechanism: 'semantic_api' }],
      });
    },
  };
  loadPreload({ contextBridge, ipcRenderer });
  assert.deepEqual(await exposed.opsDesktopUI.actComputerUIA({
    pid: 4321, ref: '@s1abc:e1', grant_id: 'g-1', generation: 1, action: 'SetValue', value: '你好', target_summary: '记事本',
  }), {
    ok: true, action: 'SetValue', snapshot_id: 's1abc', ref: '@s1abc:e1',
    disposition: { delivery: 'delivered_verified', retry: 'unsafe' },
    verification_scope: 'element_value',
    steps: [{ label: 'ValuePattern', outcome: 'ok', mechanism: 'semantic_api' }],
  });
});

// DEV-CU P3-7：invalidate 结果只允许 {ok, cleared} 形状；非法即拒绝。
test('rejects an invalidate result that does not match the fixed shape', async () => {
  const exposed = {};
  const contextBridge = { exposeInMainWorld(name, value) { exposed[name] = value; } };
  const ipcRenderer = {
    on() {},
    removeListener() {},
    invoke() {
      return Promise.resolve({ ok: true, cleared: '2' });
    },
  };
  loadPreload({ contextBridge, ipcRenderer });
  assert.deepEqual(await exposed.opsDesktopUI.invalidateComputerUIA('g-1'), {
    ok: false, code: 'computer_uia_invalid', message: 'Electron 返回的撤销结果无效。',
  });
});

test('passes a well-formed invalidate result through', async () => {
  const exposed = {};
  const contextBridge = { exposeInMainWorld(name, value) { exposed[name] = value; } };
  const ipcRenderer = {
    on() {},
    removeListener() {},
    invoke() {
      return Promise.resolve({ ok: true, cleared: 2 });
    },
  };
  loadPreload({ contextBridge, ipcRenderer });
  assert.deepEqual(await exposed.opsDesktopUI.invalidateComputerUIA('g-1'), { ok: true, cleared: 2 });
});

// DEV-CU P3-7 步骤 4：三个固定意图在转发 IPC 前先本地校验参数——
// 非法参数一律回 computer_uia_invalid，且不产生任何 IPC 调用。
test('validates observe/act/invalidate arguments locally before forwarding to main', async () => {
  const exposed = {};
  const contextBridge = { exposeInMainWorld(name, value) { exposed[name] = value; } };
  const invokes = [];
  const ipcRenderer = {
    on() {},
    removeListener() {},
    invoke(channel, payload) { invokes.push({ channel, payload }); return Promise.resolve({ ok: true, cleared: 0 }); },
  };
  loadPreload({ contextBridge, ipcRenderer });
  const observeInvalid = [
    { pid: 0, target_summary: 'x', grant_id: 'g', generation: 0 },
    { pid: 1, target_summary: 'x', grant_id: '', generation: 0 },
    { pid: 1, target_summary: 'x', grant_id: 'g', generation: 0, max_depth: 51 },
    { pid: 1, target_summary: 'x', grant_id: 'g', generation: 0, root_ref: 'r'.repeat(65) },
  ];
  for (const input of observeInvalid) {
    const result = await exposed.opsDesktopUI.observeComputerUIA(input);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'computer_uia_invalid');
  }
  const actInvalid = [
    { pid: 1, ref: 'not-a-ref', grant_id: 'g', generation: 0, action: 'Click', target_summary: 'x' },
    { pid: 1, ref: '@s1abc:e0', grant_id: 'g', generation: 0, action: 'Click', target_summary: 'x' },
    { pid: 1, ref: '@s1abc:e1', grant_id: '', generation: 0, action: 'Click', target_summary: 'x' },
    { pid: 1, ref: '@s1abc:e1', grant_id: 'g', generation: 0, action: '', target_summary: 'x' },
  ];
  for (const input of actInvalid) {
    const result = await exposed.opsDesktopUI.actComputerUIA(input);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'computer_uia_invalid');
  }
  assert.deepEqual(await exposed.opsDesktopUI.invalidateComputerUIA(''), {
    ok: false, code: 'computer_uia_invalid', message: '撤销参数无效。',
  });
  assert.deepEqual(invokes, []);

  // 合法参数才转发，且只带白名单键。
  await exposed.opsDesktopUI.actComputerUIA({
    pid: 1, ref: '@s1abc:e1', grant_id: 'g', generation: 0, action: 'Click', target_summary: 'x', value: 'v'.repeat(40000),
  });
  assert.equal(invokes.length, 1);
  assert.equal(invokes[0].channel, 'computer:uia-act');
  assert.equal(invokes[0].payload.value.length, 32768);
});

function observeNode() {
  return {
    role: 'textfield',
    name: '文本编辑器',
    value: '',
    ref_id: '@s1abc:e1',
    available_actions: ['Click', 'SetValue'],
    states: ['enabled', 'visible'],
    bounds: { x: 1, y: 2, w: 3, h: 4 },
    children: [],
    children_count: 0,
    depth: 0,
  };
}

function observeChain(depth) {
  let node = observeNode();
  // 生成 depth+1 个节点，最外层 depth 字段 = depth；解析器按递归层级判 50 上限。
  for (let i = 1; i <= depth; i += 1) {
    node = { ...observeNode(), children: [node], children_count: 1, depth: i };
  }
  return node;
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
