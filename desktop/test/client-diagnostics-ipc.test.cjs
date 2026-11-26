const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DESKTOP_UI_GET_CLIENT_DIAGNOSTICS_CHANNEL,
  DESKTOP_UI_EXPORT_CLIENT_DIAGNOSTICS_CHANNEL,
  registerClientDiagnosticsIpcHandlers,
} = require('../.build/ipc/client-diagnostics.js');

// POLISH-02（docs/43 §4 第 3.2 条）：本机连接/运行/版本诊断的两条固定通道。
// 1) 只有业务窗口主框架能调，五类非业务来源一律 not_business_window 且不触达任何依赖；
// 2) 客户端未就绪 / 读取失败 / 落盘失败都收敛为固定失败码，不泄漏堆栈与本机路径；
// 3) 读取只回严格 16 键摘要；导出只回取消与否，报告内容与 settings:export-diagnostics 同口径。

const APP_URL = 'https://ops.example/app';
const DIAGNOSTICS_KEYS = [
  'activeModelRequests', 'appVersion', 'arch', 'channelMessage', 'channelState',
  'connectionState', 'deviceRegistered', 'electronVersion', 'localConfigAvailable',
  'mode', 'modelCount', 'platform', 'reauthRequired', 'routeRevision',
  'signedIn', 'storageAvailable',
];
const FORBIDDEN_KEYS = ['service', 'apiOrigin', 'nodeVersion', 'deviceId', 'apiKey', 'filePath', 'token', 'cookie'];

function hostAndEvent({ destroyed = false, frameUrl = APP_URL, pageUrl = APP_URL, sameFrame = true, senderOverride } = {}) {
  const mainFrame = { url: frameUrl };
  const sender = { getURL: () => pageUrl, mainFrame };
  const host = { webContents: sender, isDestroyed: () => destroyed };
  return {
    host,
    event: { sender: senderOverride ?? sender, senderFrame: sameFrame ? sender.mainFrame : { url: frameUrl } },
  };
}

function diagnosticsSource(over = {}) {
  return {
    appVersion: '0.1.0',
    electronVersion: '44.9.1',
    nodeVersion: '22.12.0',
    platform: 'win32',
    arch: 'x64',
    service: 'https://ops.example/api',
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

function registerHarness(overrides = {}) {
  const handlers = new Map();
  const calls = { source: 0, save: 0 };
  const saved = [];
  registerClientDiagnosticsIpcHandlers({
    ipcHandle: (channel, handler) => handlers.set(channel, handler),
    businessWindow: () => null,
    isBusinessUrl: () => true,
    getDiagnosticsSource: async () => {
      calls.source += 1;
      return diagnosticsSource();
    },
    saveDiagnosticsFile: async (window, defaultName, content) => {
      calls.save += 1;
      saved.push({ window, defaultName, content });
      return { canceled: false };
    },
    ...overrides,
  });
  return { handlers, calls, saved };
}

test('POLISH-02: 五类非业务来源一律拒调，且不触达 getDiagnosticsSource / saveDiagnosticsFile', async () => {
  const missing = registerHarness();
  const { event: missingEvent } = hostAndEvent();
  assert.deepEqual(await missing.handlers.get(DESKTOP_UI_GET_CLIENT_DIAGNOSTICS_CHANNEL)(missingEvent), {
    ok: false, code: 'not_business_window', message: '不允许此窗口读取客户端诊断状态。',
  });
  assert.deepEqual(await missing.handlers.get(DESKTOP_UI_EXPORT_CLIENT_DIAGNOSTICS_CHANNEL)(missingEvent), {
    ok: false, code: 'not_business_window', message: '不允许此窗口导出客户端诊断信息。',
  });
  assert.deepEqual(missing.calls, { source: 0, save: 0 });

  const cases = [
    { label: '宿主已销毁', make: () => hostAndEvent({ destroyed: true }) },
    { label: '不同 webContents', make: () => hostAndEvent({ senderOverride: { getURL: () => APP_URL, mainFrame: { url: APP_URL } } }) },
    { label: 'senderFrame 非主框架', make: () => hostAndEvent({ sameFrame: false }) },
    { label: 'senderFrame URL 非业务站', make: () => hostAndEvent({ frameUrl: 'https://evil.example/x' }) },
    { label: '页面 URL 非业务站', make: () => hostAndEvent({ pageUrl: 'https://evil.example/x' }) },
  ];
  for (const item of cases) {
    const { host, event } = item.make();
    const harness = registerHarness({
      businessWindow: () => host,
      isBusinessUrl: (url) => url === APP_URL,
    });
    const read = await harness.handlers.get(DESKTOP_UI_GET_CLIENT_DIAGNOSTICS_CHANNEL)(event);
    assert.equal(read.ok, false, item.label);
    assert.equal(read.code, 'not_business_window', item.label);
    const write = await harness.handlers.get(DESKTOP_UI_EXPORT_CLIENT_DIAGNOSTICS_CHANNEL)(event);
    assert.equal(write.ok, false, item.label);
    assert.equal(write.code, 'not_business_window', item.label);
    assert.deepEqual(harness.calls, { source: 0, save: 0 }, `${item.label}：被拒调用不得触达依赖`);
  }
});

test('POLISH-02: 客户端未就绪回 client_unavailable，读取抛错收敛为 diagnostics_failed', async () => {
  const { host, event } = hostAndEvent();
  const base = { businessWindow: () => host, isBusinessUrl: (url) => url === APP_URL };

  const unavailable = registerHarness({ ...base, getDiagnosticsSource: async () => null });
  assert.deepEqual(await unavailable.handlers.get(DESKTOP_UI_GET_CLIENT_DIAGNOSTICS_CHANNEL)(event), {
    ok: false, code: 'client_unavailable', message: '本机客户端尚未就绪，请稍后重试。',
  });
  assert.equal(unavailable.calls.save, 0, '读取失败不得触达落盘');

  const failing = registerHarness({
    ...base,
    getDiagnosticsSource: async () => { throw new Error('ENOENT: C:\\Users\\me\\config.json'); },
  });
  const result = await failing.handlers.get(DESKTOP_UI_GET_CLIENT_DIAGNOSTICS_CHANNEL)(event);
  assert.deepEqual(result, {
    ok: false, code: 'diagnostics_failed', message: '读取客户端诊断状态失败，请稍后重试。',
  });
  assert.ok(!JSON.stringify(result).includes('C:\\'), '失败结果不得泄漏本机路径或堆栈');
});

test('POLISH-02: 成功读取严格只回 16 键，不夹带 service / nodeVersion / apiOrigin 等内部字段', async () => {
  const { host, event } = hostAndEvent();
  const harness = registerHarness({ businessWindow: () => host, isBusinessUrl: (url) => url === APP_URL });
  const result = await harness.handlers.get(DESKTOP_UI_GET_CLIENT_DIAGNOSTICS_CHANNEL)(event);
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.diagnostics).sort(), DIAGNOSTICS_KEYS);
  for (const key of FORBIDDEN_KEYS) {
    assert.equal(Object.hasOwn(result.diagnostics, key), false, `摘要不得包含 ${key}`);
  }
  assert.deepEqual(result.diagnostics, {
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
  });
  // 调用方传入的任何参数都必须被忽略（固定通道无参）。
  assert.equal((await harness.handlers.get(DESKTOP_UI_GET_CLIENT_DIAGNOSTICS_CHANNEL)(event, { path: 'C:\\tmp' })).ok, true);
  assert.equal(harness.calls.source, 2);
});

test('POLISH-02: 成功导出写出的脱敏报告字段完整、末尾换行，且只回 { ok, canceled: false }', async () => {
  const { host, event } = hostAndEvent();
  const harness = registerHarness({ businessWindow: () => host, isBusinessUrl: (url) => url === APP_URL });
  const result = await harness.handlers.get(DESKTOP_UI_EXPORT_CLIENT_DIAGNOSTICS_CHANNEL)(event);
  assert.deepEqual(result, { ok: true, canceled: false });
  assert.equal(harness.saved.length, 1);
  const saved = harness.saved[0];
  assert.equal(saved.window, host);
  assert.match(saved.defaultName, /^ops-desktop-diagnostics-\d{4}-\d{2}-\d{2}\.json$/);
  assert.ok(saved.content.endsWith('\n'), '报告必须以换行结尾（与 settings:export-diagnostics 同口径）');
  const report = JSON.parse(saved.content);
  assert.deepEqual(Object.keys(report).sort(), ['app', 'business_connection', 'client', 'generated_at', 'service']);
  assert.match(report.generated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.deepEqual(report.app, {
    version: '0.1.0', electron: '44.9.1', node: '22.12.0', platform: 'win32', architecture: 'x64',
  });
  assert.equal(report.service, 'https://ops.example/api');
  assert.equal(report.business_connection, 'online');
  assert.deepEqual(report.client, {
    signed_in: true,
    reauth_required: false,
    secure_storage_available: true,
    local_config_available: true,
    device_registered: true,
    model_count: 2,
    active_model_requests: 0,
    channel_state: 'ready',
    mode: 'server',
    route_revision: 3,
  });
  // 返回值里不得出现本机路径。
  assert.equal(JSON.stringify(result).includes('\\'), false);
});

test('POLISH-02: 用户取消返回 { ok, canceled: true }，落盘抛错收敛为 export_failed 且不泄漏路径', async () => {
  const { host, event } = hostAndEvent();
  const base = { businessWindow: () => host, isBusinessUrl: (url) => url === APP_URL };

  const canceled = registerHarness({ ...base, saveDiagnosticsFile: async () => ({ canceled: true }) });
  assert.deepEqual(await canceled.handlers.get(DESKTOP_UI_EXPORT_CLIENT_DIAGNOSTICS_CHANNEL)(event), {
    ok: true, canceled: true,
  });

  const writeFail = registerHarness({
    ...base,
    saveDiagnosticsFile: async () => { throw new Error('EACCES: C:\\Users\\me\\ops-desktop-diagnostics.json'); },
  });
  const failed = await writeFail.handlers.get(DESKTOP_UI_EXPORT_CLIENT_DIAGNOSTICS_CHANNEL)(event);
  assert.deepEqual(failed, {
    ok: false, code: 'export_failed', message: '导出脱敏诊断信息失败，请稍后重试。',
  });
  assert.ok(!JSON.stringify(failed).includes('C:\\'), '失败结果不得泄漏本机路径或堆栈');

  // 读不到客户端时导出同样回 client_unavailable，不弹保存框。
  const unavailable = registerHarness({ ...base, getDiagnosticsSource: async () => null });
  assert.deepEqual(await unavailable.handlers.get(DESKTOP_UI_EXPORT_CLIENT_DIAGNOSTICS_CHANNEL)(event), {
    ok: false, code: 'client_unavailable', message: '本机客户端尚未就绪，请稍后重试。',
  });
  assert.equal(unavailable.calls.save, 0);
});
