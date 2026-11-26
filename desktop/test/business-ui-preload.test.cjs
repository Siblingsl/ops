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
    'checkUpdate',
    'confirmBrowserPairing',
    'exportClientDiagnostics',
    'focusBrowserTab',
    'getBrowserPairingState',
    'getClientDiagnostics',
    'getMcpOAuthStatus',
    'getUpdateStatus',
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
    'onUpdateStatus',
    'openPlatformLogin',
    'openUpdateDownload',
    'openXhsManualImageFolder',
    'readComputerUIA',
    'revokeMcpOAuth',
    'setLocalSettingsPanel',
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
    ['actComputerUIA', 'captureLongImage', 'checkUpdate', 'confirmBrowserPairing', 'exportClientDiagnostics', 'focusBrowserTab', 'getBrowserPairingState',
     'getClientDiagnostics', 'getMcpOAuthStatus', 'getUpdateStatus', 'invalidateComputerUIA', 'invokeComputerUIA', 'invokeInBrowse',
     'listBrowserTabs', 'listComputerWindows', 'observeComputerUIA', 'openPlatformLogin', 'openUpdateDownload', 'openXhsManualImageFolder',
     'readComputerUIA', 'revokeMcpOAuth', 'setLocalSettingsPanel', 'startMcpOAuth', 'validateMcpConnection']);
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

  // BR-09：用户主动“查看操作”走独立固定意图；失败原样透出，不伪造已切换。
  assert.deepEqual(await exposed.opsDesktopUI.focusBrowserTab(42), {
    ok: false, code: 'render_not_ready', message: '页面未就绪。'
  });
  assert.deepEqual(invokes.at(-1), { channel: 'browser:focus-tab', payload: 42 });

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

// ---------------------------------------------------------------------------
// DEV-CU P3-7（docs/36 §P3-7）：observe/act/invalidate 三固定意图的白名单负例。
// C09：process_path / hwnd / class_name / native_id 等内部字段出现即整批拒绝；
// disposition 双字段不一致拒绝；长度上限逐项。
// ---------------------------------------------------------------------------

test('P3-7: observeComputerUIA 参数本机校验（pid/grant/generation/max_depth/root_ref）', async () => {
  const exposed = {};
  const contextBridge = { exposeInMainWorld(name, value) { exposed[name] = value; } };
  const invokes = [];
  const ipcRenderer = { on() {}, removeListener() {}, invoke: async (ch, payload) => { invokes.push({ ch, payload }); return { ok: false, code: 'worker_exit' }; } };
  loadPreload({ contextBridge, ipcRenderer });
  const ui = exposed.opsDesktopUI;
  const base = { pid: 12, target_summary: '记事本', grant_id: 'g-1', generation: 3 };
  let ipcCount = 0;
  for (const bad of [
    {}, { ...base, pid: 0 }, { ...base, grant_id: '' }, { ...base, generation: -1 },
    { ...base, max_depth: 51 }, { ...base, max_depth: -1 }, { ...base, root_ref: 'e1' },
  ]) {
    const out = await ui.observeComputerUIA(bad);
    assert.equal(out.ok, false, `应拒绝 ${JSON.stringify(bad).slice(0, 60)}`);
    assert.equal(out.code, 'computer_uia_invalid');
    assert.equal(invokes.length, ipcCount, '参数无效不得发起 IPC');
  }
  // 合法入参发起 IPC 且 payload 含 grant/generation
  await ui.observeComputerUIA(base);
  assert.equal(invokes.length, ipcCount + 1);
  assert.equal(invokes.at(-1).ch, 'computer:uia-observe');
  assert.equal(invokes.at(-1).payload.grant_id, 'g-1');
});

test('P3-7: observe 结果白名单——树节点键集合整批拒绝（C09 负例）', async () => {
  const exposed = {};
  const contextBridge = { exposeInMainWorld(name, value) { exposed[name] = value; } };
  const ipcRenderer = { on() {}, removeListener() {}, invoke: async () => null };
  loadPreload({ contextBridge, ipcRenderer });
  const ui = exposed.opsDesktopUI;
  const node = (over = {}) => ({
    role: 'button', name: '保存', value: '', ref_id: '@s1:e1',
    available_actions: ['Click'], states: ['enabled'], bounds: { x: 0, y: 0, w: 10, h: 10 },
    children: [], children_count: 0, depth: 1, ...over,
  });
  const result = (tree) => ({ ok: true, snapshot_id: 's1', revision: 1, ref_count: 1, complete: true, nodes_observed: 1, tree });
  const base = { pid: 12, target_summary: '记事本', grant_id: 'g-1', generation: 3 };

  const good = node();
  // negative：C09 禁止字段逐个注入（process_path/hwnd/class_name/native_id/title_hash）
  for (const [key, val] of [
    ['process_path', 'C:/Windows/notepad.exe'],
    ['hwnd', 12345],
    ['class_name', 'Notepad'],
    ['native_id', 'abc'],
    ['title_hash', 'deadbeef'],
    ['bounds_hash', 'deadbeef'],
  ]) {
    const bad = node({ [key]: val });
    const r = await new Promise((resolve) => {
      const ui2 = exposed.opsDesktopUI;
      // 直接用 parseComputerUiaObserveResult 不可达（模块闭包内），走 IPC 注入：
      const exposed2 = {};
      const ctx2 = { exposeInMainWorld(name, value) { exposed2[name] = value; } };
      const ipc2 = { on() {}, removeListener() {}, invoke: async () => result(bad) };
      loadPreload({ contextBridge: ctx2, ipcRenderer: ipc2 });
      resolve(exposed2.opsDesktopUI.observeComputerUIA(base));
    });
    assert.equal(r.ok, false, `树节点含 ${key} 应整批拒绝`);
    assert.equal(r.code, 'computer_uia_invalid');
  }
});

test('P3-7: act 结果 disposition 双字段一致性与 steps 机制校验', async () => {
  const exposed = {};
  const contextBridge = { exposeInMainWorld(name, value) { exposed[name] = value; } };
  loadPreload({ contextBridge, ipcRenderer: { on() {}, removeListener() {}, invoke: async () => null } });
  const ui = exposed.opsDesktopUI;
  const base = { pid: 12, ref: '@sabc123:e1', grant_id: 'g-1', generation: 3, action: 'click', target_summary: '记事本' };
  const act = (body) => ({ ok: true, action: 'click', disposition: body });
  for (const bad of [
    { delivery: 'not_delivered', retry: 'unsafe' },
    { delivery: 'delivered_verified', retry: 'safe' },
    { delivery: 'bogus', retry: 'safe' },
    { delivery: 'not_delivered' },
  ]) {
    const exposed2 = {};
    loadPreload({ contextBridge: { exposeInMainWorld(n, v) { exposed2[n] = v; } },
      ipcRenderer: { on() {}, removeListener() {}, invoke: async () => act(bad) } });
    const r = await exposed2.opsDesktopUI.actComputerUIA(base);
    assert.equal(r.ok, false, `disposition ${JSON.stringify(bad)} 应拒`);
  }
  // steps 出现时 mechanism 必须是 semantic_api（无物理投递分支）
  const exposed3 = {};
  loadPreload({ contextBridge: { exposeInMainWorld(n, v) { exposed3[n] = v; } },
    ipcRenderer: { on() {}, removeListener() {}, invoke: async () => ({
      ok: true, action: 'click', disposition: { delivery: 'delivered_verified', retry: 'unsafe' },
      steps: [{ label: 'UIInvokePattern.Invoke', outcome: 'succeeded', mechanism: 'physical_synthetic' }],
    }) } });
  const r3 = await exposed3.opsDesktopUI.actComputerUIA(base);
  assert.equal(r3.ok, false, 'mechanism 不得是 physical_synthetic');
});

test('P3-7: invalidateComputerUIA grant 校验与 cleared 白名单', async () => {
  const exposed = {};
  const contextBridge = { exposeInMainWorld(name, value) { exposed[name] = value; } };
  loadPreload({ contextBridge, ipcRenderer: { on() {}, removeListener() {}, invoke: async () => null } });
  const ui = exposed.opsDesktopUI;
  for (const bad of ['', 'x'.repeat(65)]) {
    const r = await ui.invalidateComputerUIA(bad);
    assert.equal(r.ok, false);
  }
  // cleared 非整数 → 拒
  const exposed2 = {};
  loadPreload({ contextBridge: { exposeInMainWorld(n, v) { exposed2[n] = v; } },
    ipcRenderer: { on() {}, removeListener() {}, invoke: async () => ({ ok: true, cleared: 1.5 }) } });
  const r = await exposed2.opsDesktopUI.invalidateComputerUIA('g-1');
  assert.equal(r.ok, false);
});

// ---------------------------------------------------------------------------
// OPT-U03（docs/43 §4）：小红书人工接管包的有序图片导出。
// preload 侧与主进程同口径：workId ^[a-zA-Z0-9_-]{1,64}$、1–18 张、png/jpg/webp/gif、
// 单张 1B–20MB、总量 ≤100MB；非法参数不发 IPC；返回值只允许 count/fileNames 或 code/message。
// ---------------------------------------------------------------------------

test('OPT-U03: openXhsManualImageFolder 参数本机拦截，非法一律不发 IPC', async () => {
  const exposed = {};
  const invokes = [];
  const ipcRenderer = {
    on() {},
    removeListener() {},
    invoke(channel, payload) { invokes.push({ channel, payload }); return Promise.resolve({ ok: true, count: 1, fileNames: ['01_封面.png'] }); },
  };
  loadPreload({ contextBridge: { exposeInMainWorld(n, v) { exposed[n] = v; } }, ipcRenderer });
  const ui = exposed.opsDesktopUI;
  const bytes = new Uint8Array([1, 2, 3]);
  const cases = [
    null,
    'work_1',
    { workId: '../x', files: [{ ext: 'png', bytes }] },
    { workId: 'a/b', files: [{ ext: 'png', bytes }] },
    { workId: '', files: [{ ext: 'png', bytes }] },
    { workId: 'x'.repeat(65), files: [{ ext: 'png', bytes }] },
    { workId: 'work_1', files: [] },
    { workId: 'work_1', files: Array.from({ length: 19 }, () => ({ ext: 'png', bytes })) },
    { workId: 'work_1', files: [{ ext: 'bmp', bytes }] },
    { workId: 'work_1', files: [{ ext: 'png', bytes: 'not-bytes' }] },
    { workId: 'work_1', files: [{ ext: 'png', bytes: new Uint8Array(0) }] },
    { workId: 'work_1', files: [{ ext: 'png', bytes: new Uint8Array(20 * 1024 * 1024 + 1) }] },
    { workId: 'work_1', files: [{ ext: 'png', bytes, name: 'x.png' }] },
    { workId: 'work_1', files: [{ ext: 'png', bytes }], dir: 'C:\\Users\\me' },
  ];
  for (const input of cases) {
    const result = await ui.openXhsManualImageFolder(input);
    assert.equal(result.ok, false, `应拒绝 ${JSON.stringify(input)?.slice(0, 80)}`);
    assert.equal(result.code, 'invalid_argument');
  }
  assert.deepEqual(invokes, [], '非法参数不得发起 IPC');
});

test('OPT-U03: 合法参数透传 workId 与图片字节，返回值原样收敛', async () => {
  const exposed = {};
  const invokes = [];
  const fileNames = ['01_封面.png', '02.jpg', '03.webp'];
  const ipcRenderer = {
    on() {},
    removeListener() {},
    invoke(channel, payload) { invokes.push({ channel, payload }); return Promise.resolve({ ok: true, count: 3, fileNames }); },
  };
  loadPreload({ contextBridge: { exposeInMainWorld(n, v) { exposed[n] = v; } }, ipcRenderer });
  const files = [
    { ext: 'png', bytes: new Uint8Array([1]) },
    { ext: 'jpg', bytes: new Uint8Array([2, 3]) },
    { ext: 'webp', bytes: new Uint8Array([4]) },
  ];
  const result = await exposed.opsDesktopUI.openXhsManualImageFolder({ workId: 'work_1', files });
  assert.deepEqual(result, { ok: true, count: 3, fileNames });
  assert.equal(invokes.length, 1);
  assert.equal(invokes[0].channel, 'publish-pack:open-xhs-images');
  assert.equal(invokes[0].payload.workId, 'work_1');
  assert.equal(invokes[0].payload.files.length, 3);
  assert.deepEqual(Object.keys(invokes[0].payload).sort(), ['files', 'workId'], '只透传白名单键');
});

test('OPT-U03: 主进程返回路径或多余字段时整份拒绝（不泄漏本机目录）', async () => {
  const exposed = {};
  const ipcRenderer = {
    on() {},
    removeListener() {},
    invoke() { return Promise.resolve({ ok: true, count: 3, fileNames: ['01_封面.png', '02.jpg', '03.webp'], dir: 'C:\\Users\\me\\AppData\\Local\\Temp\\ops-xhs-manual-pack' }); },
  };
  loadPreload({ contextBridge: { exposeInMainWorld(n, v) { exposed[n] = v; } }, ipcRenderer });
  const files = [
    { ext: 'png', bytes: new Uint8Array([1]) },
    { ext: 'jpg', bytes: new Uint8Array([2]) },
    { ext: 'webp', bytes: new Uint8Array([3]) },
  ];
  assert.deepEqual(await exposed.opsDesktopUI.openXhsManualImageFolder({ workId: 'work_1', files }), {
    ok: false, code: 'publish_pack_invalid', message: 'Electron 返回的图片导出结果无效。',
  });

  const exposedPath = {};
  loadPreload({ contextBridge: { exposeInMainWorld(n, v) { exposedPath[n] = v; } },
    ipcRenderer: { on() {}, removeListener() {}, invoke: async () => ({
      ok: true, count: 3, fileNames: ['C:\\Users\\me\\01_封面.png', '02.jpg', '03.webp'],
    }) } });
  assert.deepEqual(await exposedPath.opsDesktopUI.openXhsManualImageFolder({ workId: 'work_1', files }), {
    ok: false, code: 'publish_pack_invalid', message: 'Electron 返回的图片导出结果无效。',
  });

  const exposedMismatch = {};
  loadPreload({ contextBridge: { exposeInMainWorld(n, v) { exposedMismatch[n] = v; } },
    ipcRenderer: { on() {}, removeListener() {}, invoke: async () => ({ ok: true, count: 2, fileNames: ['01_封面.png'] }) } });
  assert.equal((await exposedMismatch.opsDesktopUI.openXhsManualImageFolder({ workId: 'work_1', files })).ok, false);

  const exposedFail = {};
  loadPreload({ contextBridge: { exposeInMainWorld(n, v) { exposedFail[n] = v; } },
    ipcRenderer: { on() {}, removeListener() {}, invoke: async () => ({ ok: false, code: 'open_folder_failed', message: '无法打开系统文件夹，请重试' }) } });
  assert.deepEqual(await exposedFail.opsDesktopUI.openXhsManualImageFolder({ workId: 'work_1', files }), {
    ok: false, code: 'open_folder_failed', message: '无法打开系统文件夹，请重试',
  });

  const exposedThrow = {};
  loadPreload({ contextBridge: { exposeInMainWorld(n, v) { exposedThrow[n] = v; } },
    ipcRenderer: { on() {}, removeListener() {}, invoke: async () => { throw new Error('no handler'); } } });
  assert.deepEqual(await exposedThrow.opsDesktopUI.openXhsManualImageFolder({ workId: 'work_1', files }), {
    ok: false, code: 'publish_pack_unavailable', message: '本机图片导出暂不可用，请重试。',
  });
});

// ---------------------------------------------------------------------------
// OPT-U04（docs/43 §4）：桌面平台重登 / 本机设置面板的固定意图。
// 参数本机校验（非法即回 invalid_argument 且不发 IPC）；返回值只允许
// {ok:true} 或 {ok:false,code,message}；invoke 抛错压成 desktop_ui_unavailable。
// ---------------------------------------------------------------------------

test('OPT-U04: openPlatformLogin / setLocalSettingsPanel 参数本机拦截，非法一律不发 IPC', async () => {
  const exposed = {};
  const invokes = [];
  const ipcRenderer = {
    on() {},
    removeListener() {},
    invoke(channel, payload) { invokes.push({ channel, payload }); return Promise.resolve({ ok: true }); },
  };
  loadPreload({ contextBridge: { exposeInMainWorld(n, v) { exposed[n] = v; } }, ipcRenderer });
  const ui = exposed.opsDesktopUI;
  const accountId = '00000003-1111-4111-8111-111111111111';
  const loginCases = [
    null,
    'xhs',
    {},
    { accountId: 'not-a-uuid', platform: 'xhs' },
    { accountId, platform: 'weibo' },
    { accountId, platform: 1 },
    { accountId, platform: 'xhs', remember: true },
    { accountId, platform: 'xhs', account_id: accountId },
  ];
  for (const input of loginCases) {
    const result = await ui.openPlatformLogin(input);
    assert.equal(result.ok, false, `应拒绝 ${JSON.stringify(input)}`);
    assert.equal(result.code, 'invalid_argument');
  }
  const panelCases = [
    null,
    'unknown',
    'Connection',
    { action: 'connection' },
    7,
    ['connection'],
  ];
  for (const input of panelCases) {
    const result = await ui.setLocalSettingsPanel(input);
    assert.equal(result.ok, false, `应拒绝 ${JSON.stringify(input)}`);
    assert.equal(result.code, 'invalid_argument');
  }
  assert.deepEqual(invokes, [], '非法参数不得发起 IPC');
});

test('OPT-U04: 合法参数只透传白名单键，两条固定通道分别转发', async () => {
  const exposed = {};
  const invokes = [];
  const ipcRenderer = {
    on() {},
    removeListener() {},
    invoke(channel, payload) { invokes.push({ channel, payload }); return Promise.resolve({ ok: true }); },
  };
  loadPreload({ contextBridge: { exposeInMainWorld(n, v) { exposed[n] = v; } }, ipcRenderer });
  const ui = exposed.opsDesktopUI;
  const accountId = '00000003-1111-4111-8111-111111111111';
  assert.deepEqual(await ui.openPlatformLogin({ accountId, platform: 'toutiao' }), { ok: true });
  assert.deepEqual(invokes.at(-1), { channel: 'desktop-ui:open-platform-login', payload: { accountId, platform: 'toutiao' } });
  assert.deepEqual(Object.keys(invokes.at(-1).payload).sort(), ['accountId', 'platform']);
  for (const action of ['connection', 'ai', 'account-device', 'diagnostics', 'detach', 'close']) {
    assert.deepEqual(await ui.setLocalSettingsPanel(action), { ok: true });
    assert.deepEqual(invokes.at(-1), { channel: 'desktop-ui:settings-panel', payload: { action } });
    assert.deepEqual(Object.keys(invokes.at(-1).payload), ['action']);
  }
  assert.equal(invokes.length, 7);
});

test('OPT-U04: 主进程返回值收敛——只接受 {ok:true} 或 {ok:false,code,message}', async () => {
  const invalidPanel = { ok: false, code: 'desktop_ui_invalid', message: 'Electron 返回的本机设置结果无效。' };
  const invalidLogin = { ok: false, code: 'desktop_ui_invalid', message: 'Electron 返回的平台登录结果无效。' };
  const refusal = { ok: false, code: 'not_business_window', message: '不允许此窗口调用本机设置。' };
  const cases = [
    { label: '成功但带多余键', raw: { ok: true, panel: 'ai' }, panel: invalidPanel, login: invalidLogin },
    { label: '失败码超长', raw: { ok: false, code: 'x'.repeat(41), message: '原因' }, panel: invalidPanel, login: invalidLogin },
    { label: '空结果', raw: null, panel: invalidPanel, login: invalidLogin },
    { label: '非业务窗口失败原样透出', raw: refusal, panel: refusal, login: refusal },
  ];
  for (const item of cases) {
    const exposed = {};
    const ipcRenderer = { on() {}, removeListener() {}, invoke: async () => item.raw };
    loadPreload({ contextBridge: { exposeInMainWorld(n, v) { exposed[n] = v; } }, ipcRenderer });
    assert.deepEqual(await exposed.opsDesktopUI.setLocalSettingsPanel('connection'), item.panel, `${item.label}（本机设置）`);
    assert.deepEqual(await exposed.opsDesktopUI.openPlatformLogin({
      accountId: '00000003-1111-4111-8111-111111111111', platform: 'xhs',
    }), item.login, `${item.label}（平台登录）`);
  }
  // 唯一合法成功形状必须原样返回。
  const exposedOk = {};
  loadPreload({ contextBridge: { exposeInMainWorld(n, v) { exposedOk[n] = v; } },
    ipcRenderer: { on() {}, removeListener() {}, invoke: async () => ({ ok: true }) } });
  assert.deepEqual(await exposedOk.opsDesktopUI.setLocalSettingsPanel('connection'), { ok: true });
  assert.deepEqual(await exposedOk.opsDesktopUI.openPlatformLogin({
    accountId: '00000003-1111-4111-8111-111111111111', platform: 'xhs',
  }), { ok: true });
});

test('OPT-U04: invoke 抛错压成 desktop_ui_unavailable，不把异常原文透出', async () => {
  const exposed = {};
  const ipcRenderer = { on() {}, removeListener() {}, invoke: async () => { throw new Error('No handler registered for desktop-ui:settings-panel'); } };
  loadPreload({ contextBridge: { exposeInMainWorld(n, v) { exposed[n] = v; } }, ipcRenderer });
  assert.deepEqual(await exposed.opsDesktopUI.setLocalSettingsPanel('diagnostics'), {
    ok: false, code: 'desktop_ui_unavailable', message: '本机设置面板暂不可用，请重试。',
  });
  assert.deepEqual(await exposed.opsDesktopUI.openPlatformLogin({
    accountId: '00000003-1111-4111-8111-111111111111', platform: 'wechat_mp',
  }), {
    ok: false, code: 'desktop_ui_unavailable', message: '本机平台登录暂不可用，请重试。',
  });
});

// ---------------------------------------------------------------------------
// OPT-E02（docs/43 §5）：版本更新检查——4 个白名单方法、9 键状态严格校验、
// 推送缓存回放、invoke 抛错压码；状态里任何多余键或非法类型都整份拒绝。
// ---------------------------------------------------------------------------

function validUpdateStatus(over = {}) {
  return {
    status: 'update-available',
    currentVersion: '0.1.0',
    latestVersion: '0.2.0',
    updateAvailable: true,
    releaseNotes: '新版说明',
    downloadUrl: 'https://downloads.example.com/ops.exe',
    sha256: 'a'.repeat(64),
    checkedAt: 1,
    error: '',
    ...over,
  };
}

function loadUpdatePreload(respond) {
  const exposed = {};
  const handlers = new Map();
  const invokes = [];
  const ipcRenderer = {
    on(channel, handler) {
      const listeners = handlers.get(channel) ?? new Set();
      listeners.add(handler);
      handlers.set(channel, listeners);
    },
    removeListener(channel, handler) { handlers.get(channel)?.delete(handler); },
    invoke(channel, payload) {
      invokes.push({ channel, payload });
      return Promise.resolve(respond(channel));
    },
  };
  loadPreload({ contextBridge: { exposeInMainWorld(n, v) { exposed[n] = v; } }, ipcRenderer });
  return { exposed, handlers, invokes };
}

test('OPT-E02: getUpdateStatus 只用固定通道并严格收敛 9 键状态', async () => {
  const { exposed, invokes } = loadUpdatePreload(() => ({ ok: true, status: validUpdateStatus() }));
  assert.deepEqual(await exposed.opsDesktopUI.getUpdateStatus(), { ok: true, status: validUpdateStatus() });
  assert.deepEqual(invokes.at(-1), { channel: 'desktop-ui:get-update-status', payload: undefined });

  for (const badStatus of [
    validUpdateStatus({ extra: 'SHOULD-NOT-LEAK' }),
    validUpdateStatus({ status: 'unknown' }),
    validUpdateStatus({ checkedAt: -1 }),
    validUpdateStatus({ checkedAt: 1.5 }),
    validUpdateStatus({ updateAvailable: 'true' }),
    validUpdateStatus({ downloadUrl: 'http://127.0.0.1/ops.exe' }),
    validUpdateStatus({ sha256: 'not-a-sha' }),
    validUpdateStatus({ releaseNotes: 'x'.repeat(2001) }),
    validUpdateStatus({ error: 'x'.repeat(201) }),
  ]) {
    const local = loadUpdatePreload(() => ({ ok: true, status: badStatus }));
    assert.deepEqual(await local.exposed.opsDesktopUI.getUpdateStatus(), {
      ok: false, code: 'desktop_update_invalid', message: 'Electron 返回的更新状态无效。',
    }, `应拒绝 ${JSON.stringify(badStatus).slice(0, 80)}`);
  }
  // checkedAt=null 是合法初始值；上面用例把它放进负例集合时同时带了其它字段，
  // 这里单独验证「未检查」形状可以透出。
  const initial = loadUpdatePreload(() => ({
    ok: true,
    status: validUpdateStatus({ status: 'idle', updateAvailable: false, latestVersion: '', releaseNotes: '', downloadUrl: '', sha256: '', checkedAt: null }),
  }));
  assert.equal((await initial.exposed.opsDesktopUI.getUpdateStatus()).ok, true);
});

test('OPT-E02: checkUpdate 与 openUpdateDownload 的异常收敛', async () => {
  const ok = loadUpdatePreload((channel) => channel === 'desktop-ui:check-update'
    ? { ok: true, status: validUpdateStatus() }
    : { ok: true });
  assert.deepEqual(await ok.exposed.opsDesktopUI.checkUpdate(), { ok: true, status: validUpdateStatus() });
  assert.deepEqual(await ok.exposed.opsDesktopUI.openUpdateDownload(), { ok: true });

  const refused = { ok: false, code: 'download_unavailable', message: '当前没有可用的下载链接，请联系管理员获取最新安装包。' };
  const fail = loadUpdatePreload(() => refused);
  assert.deepEqual(await fail.exposed.opsDesktopUI.openUpdateDownload(), refused);

  const extra = loadUpdatePreload(() => ({ ok: true, url: 'https://evil.example.com/malware.exe' }));
  assert.deepEqual(await extra.exposed.opsDesktopUI.openUpdateDownload(), {
    ok: false, code: 'desktop_update_invalid', message: 'Electron 返回的下载结果无效。',
  });
  assert.deepEqual(await extra.exposed.opsDesktopUI.checkUpdate(), {
    ok: false, code: 'desktop_update_invalid', message: 'Electron 返回的更新状态无效。',
  });

  const thrower = loadUpdatePreload(() => { throw new Error('No handler registered'); });
  assert.deepEqual(await thrower.exposed.opsDesktopUI.checkUpdate(), {
    ok: false, code: 'desktop_update_unavailable', message: '本机客户端更新检查暂不可用，请重试。',
  });
  assert.deepEqual(await thrower.exposed.opsDesktopUI.openUpdateDownload(), {
    ok: false, code: 'desktop_update_unavailable', message: '本机下载页打开暂不可用，请重试。',
  });
});

test('OPT-E02: onUpdateStatus 缓存回放、非法推送丢弃、退订生效', async () => {
  const { exposed, handlers } = loadUpdatePreload(() => ({ ok: true }));
  const channel = 'desktop-ui:update-status';
  // 订阅前推送：缓存最新状态，订阅时立即回放。
  emit(handlers, channel, validUpdateStatus());
  const seen = [];
  const unsubscribe = exposed.opsDesktopUI.onUpdateStatus((status) => seen.push(status));
  assert.deepEqual(seen, [validUpdateStatus()]);

  emit(handlers, channel, validUpdateStatus({ latestVersion: '0.3.0' }));
  emit(handlers, channel, validUpdateStatus({ extra: 'SHOULD-NOT-LEAK' }));
  emit(handlers, channel, { ...validUpdateStatus(), downloadUrl: 'http://127.0.0.1/ops.exe' });
  assert.deepEqual(seen.at(-1).latestVersion, '0.3.0');
  assert.equal(seen.length, 2);

  unsubscribe();
  emit(handlers, channel, validUpdateStatus());
  assert.equal(seen.length, 2);
});

// ---------------------------------------------------------------------------
// POLISH-02（docs/43 §4 第 3.2 条）：本机诊断——16 键摘要与导出结果的白名单收敛。
// 多余键（apiKey/filePath/deviceId/cookie/apiOrigin…）整份拒绝；枚举/长度/非负整数逐项校验；
// invoke 抛错压成 desktop_diagnostics_unavailable，不把异常原文透出。
// ---------------------------------------------------------------------------

function validDiagnostics(over = {}) {
  return {
    appVersion: '0.1.0',
    electronVersion: '44.9.1',
    platform: 'win32',
    arch: 'x64',
    connectionState: 'online',
    mode: 'server',
    channelState: 'ready',
    channelMessage: '连接正常',
    routeRevision: 3,
    signedIn: true,
    reauthRequired: false,
    storageAvailable: true,
    localConfigAvailable: true,
    deviceRegistered: true,
    modelCount: 2,
    activeModelRequests: 0,
    ...over,
  };
}

function loadDiagnosticsPreload(respond) {
  const exposed = {};
  const invokes = [];
  const ipcRenderer = {
    on() {},
    removeListener() {},
    invoke(channel, payload) {
      invokes.push({ channel, payload });
      return Promise.resolve(respond(channel));
    },
  };
  loadPreload({ contextBridge: { exposeInMainWorld(n, v) { exposed[n] = v; } }, ipcRenderer });
  return { exposed, invokes };
}

test('POLISH-02: getClientDiagnostics / exportClientDiagnostics 合法透传且无参', async () => {
  const { exposed, invokes } = loadDiagnosticsPreload((channel) => (channel === 'desktop-ui:export-client-diagnostics'
    ? { ok: true, canceled: false }
    : { ok: true, diagnostics: validDiagnostics() }));
  assert.deepEqual(await exposed.opsDesktopUI.getClientDiagnostics(), { ok: true, diagnostics: validDiagnostics() });
  assert.deepEqual(invokes.at(-1), { channel: 'desktop-ui:get-client-diagnostics', payload: undefined });
  assert.deepEqual(await exposed.opsDesktopUI.exportClientDiagnostics(), { ok: true, canceled: false });
  assert.deepEqual(invokes.at(-1), { channel: 'desktop-ui:export-client-diagnostics', payload: undefined });
  assert.equal(invokes.length, 2);
  // 取消也是合法结果，原样透出（渲染器据此静默返回）。
  const canceled = loadDiagnosticsPreload(() => ({ ok: true, canceled: true }));
  assert.deepEqual(await canceled.exposed.opsDesktopUI.exportClientDiagnostics(), { ok: true, canceled: true });
});

test('POLISH-02: 摘要夹带任何越界字段都整份拒绝（apiKey/filePath/deviceId/cookie/apiOrigin）', async () => {
  for (const key of ['apiKey', 'filePath', 'deviceId', 'cookie', 'apiOrigin', 'service']) {
    const leaked = validDiagnostics({ [key]: 'SHOULD-NOT-LEAK' });
    const { exposed } = loadDiagnosticsPreload(() => ({ ok: true, diagnostics: leaked }));
    assert.deepEqual(await exposed.opsDesktopUI.getClientDiagnostics(), {
      ok: false, code: 'desktop_diagnostics_invalid', message: 'Electron 返回的客户端诊断状态无效。',
    }, `多余字段 ${key} 必须整份拒绝`);
  }
});

test('POLISH-02: 非法枚举 / 超长字符串 / 非布尔 / 负整数一律拒绝', async () => {
  const cases = [
    validDiagnostics({ connectionState: 'up' }),
    validDiagnostics({ connectionState: 'ONLINE' }),
    validDiagnostics({ mode: 'local' }),
    validDiagnostics({ channelState: 'idle' }),
    validDiagnostics({ appVersion: 'v'.repeat(65) }),
    validDiagnostics({ electronVersion: 'v'.repeat(65) }),
    validDiagnostics({ platform: 'p'.repeat(33) }),
    validDiagnostics({ arch: 'a'.repeat(33) }),
    validDiagnostics({ channelMessage: 'm'.repeat(201) }),
    validDiagnostics({ signedIn: 'true' }),
    validDiagnostics({ reauthRequired: 1 }),
    validDiagnostics({ storageAvailable: null }),
    validDiagnostics({ localConfigAvailable: undefined }),
    validDiagnostics({ deviceRegistered: 'yes' }),
    validDiagnostics({ routeRevision: -1 }),
    validDiagnostics({ activeModelRequests: 1.5 }),
    validDiagnostics({ modelCount: -3 }),
  ];
  for (const diagnostics of cases) {
    const { exposed } = loadDiagnosticsPreload(() => ({ ok: true, diagnostics }));
    assert.deepEqual(await exposed.opsDesktopUI.getClientDiagnostics(), {
      ok: false, code: 'desktop_diagnostics_invalid', message: 'Electron 返回的客户端诊断状态无效。',
    }, `应拒绝 ${JSON.stringify(diagnostics).slice(0, 90)}`);
  }
  // null 是合法值（读不到设备登记 / 模型数时如实透出），不能被误判为非法。
  const { exposed: nullable } = loadDiagnosticsPreload(() => ({
    ok: true, diagnostics: validDiagnostics({ deviceRegistered: null, modelCount: null }),
  }));
  assert.equal((await nullable.opsDesktopUI.getClientDiagnostics()).ok, true);
});

test('POLISH-02: 导出结果只接受 {ok, canceled}，失败码超长或多余键拒绝', async () => {
  for (const raw of [
    { ok: true, canceled: 'no' },
    { ok: true, canceled: false, filePath: 'C:\\Users\\me\\diag.json' },
    { ok: false, code: 'x'.repeat(41), message: '原因' },
    { ok: false, code: 'export_failed' },
  ]) {
    const { exposed } = loadDiagnosticsPreload(() => raw);
    assert.deepEqual(await exposed.opsDesktopUI.exportClientDiagnostics(), {
      ok: false, code: 'desktop_diagnostics_invalid', message: 'Electron 返回的诊断导出结果无效。',
    }, `应拒绝 ${JSON.stringify(raw).slice(0, 80)}`);
  }
  // 主进程收敛后的失败码原样透出（渲染器再加中文提示）。
  const { exposed } = loadDiagnosticsPreload(() => ({ ok: false, code: 'export_failed', message: '导出脱敏诊断信息失败，请稍后重试。' }));
  assert.deepEqual(await exposed.opsDesktopUI.exportClientDiagnostics(), {
    ok: false, code: 'export_failed', message: '导出脱敏诊断信息失败，请稍后重试。',
  });
});

test('POLISH-02: 诊断两通道 invoke 抛错压成 desktop_diagnostics_unavailable', async () => {
  const { exposed } = loadDiagnosticsPreload(() => { throw new Error('No handler registered for desktop-ui:get-client-diagnostics'); });
  assert.deepEqual(await exposed.opsDesktopUI.getClientDiagnostics(), {
    ok: false, code: 'desktop_diagnostics_unavailable', message: '本机客户端诊断状态暂不可用，请重试。',
  });
  assert.deepEqual(await exposed.opsDesktopUI.exportClientDiagnostics(), {
    ok: false, code: 'desktop_diagnostics_unavailable', message: '本机诊断信息导出暂不可用，请重试。',
  });
});
