const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DESKTOP_UI_OPEN_PLATFORM_LOGIN_CHANNEL,
  DESKTOP_UI_SETTINGS_PANEL_CHANNEL,
  registerDesktopUiIpcHandlers,
} = require('../.build/ipc/desktop-ui.js');

// OPT-U04（docs/43 §4）：平台重登 / 本机设置面板的固定 IPC。
// 1) 只有业务窗口主框架能调，非业务窗口一律 not_business_window；
// 2) 入参严格白名单（UUID、平台枚举、六个面板动作、多余键整份拒绝）；
// 3) 通过后只调用 applyIntent 一次，映射成既有的 settings-pane / settings-detach / settings-close / platform-login。

const APP_URL = 'https://ops.example/app';
const ACCOUNT_ID = '00000003-1111-4111-8111-111111111111';

function hostAndEvent({ destroyed = false, frameUrl = APP_URL, pageUrl = APP_URL, sameFrame = true, senderOverride } = {}) {
  const mainFrame = { url: frameUrl };
  const sender = { getURL: () => pageUrl, mainFrame };
  const host = { webContents: sender, isDestroyed: () => destroyed };
  return {
    host,
    event: { sender: senderOverride ?? sender, senderFrame: sameFrame ? sender.mainFrame : { url: frameUrl } },
  };
}

function registerHarness(deps) {
  const handlers = new Map();
  registerDesktopUiIpcHandlers({ ipcHandle: (channel, handler) => handlers.set(channel, handler), ...deps });
  return handlers;
}

test('OPT-U04: 非业务窗口一律拒调（宿主缺失/已销毁/不同 webContents/非主框架/非业务 URL）', async () => {
  const missing = registerHarness({ businessWindow: () => null, isBusinessUrl: () => true, applyIntent: () => {} });
  assert.deepEqual(await missing.get(DESKTOP_UI_OPEN_PLATFORM_LOGIN_CHANNEL)(hostAndEvent().event, {
    accountId: ACCOUNT_ID, platform: 'xhs',
  }), { ok: false, code: 'not_business_window', message: '不允许此窗口打开平台登录。' });

  const cases = [
    { label: '宿主已销毁', make: () => hostAndEvent({ destroyed: true }) },
    { label: '不同 webContents', make: () => hostAndEvent({ senderOverride: { getURL: () => APP_URL, mainFrame: { url: APP_URL } } }) },
    { label: 'senderFrame 非主框架', make: () => hostAndEvent({ sameFrame: false }) },
    { label: 'senderFrame URL 非业务站', make: () => hostAndEvent({ frameUrl: 'https://evil.example/x' }) },
    { label: '页面 URL 非业务站', make: () => hostAndEvent({ pageUrl: 'https://evil.example/x' }) },
  ];
  for (const item of cases) {
    const calls = [];
    const { host, event } = item.make();
    const handlers = registerHarness({
      businessWindow: () => host,
      isBusinessUrl: (url) => url === APP_URL,
      applyIntent: (window, intent) => calls.push({ window, intent }),
    });
    const login = await handlers.get(DESKTOP_UI_OPEN_PLATFORM_LOGIN_CHANNEL)(event, { accountId: ACCOUNT_ID, platform: 'xhs' });
    assert.equal(login.ok, false, item.label);
    assert.equal(login.code, 'not_business_window', item.label);
    const panel = await handlers.get(DESKTOP_UI_SETTINGS_PANEL_CHANNEL)(event, { action: 'connection' });
    assert.equal(panel.ok, false, item.label);
    assert.equal(panel.code, 'not_business_window', item.label);
    assert.deepEqual(calls, [], `${item.label}：被拒调用不得触发 applyIntent`);
  }
});

test('OPT-U04: 非法 UUID / 平台 / 面板动作 / 多余键一律 invalid_argument 且不触发 applyIntent', async () => {
  const calls = [];
  const { host, event } = hostAndEvent();
  const handlers = registerHarness({
    businessWindow: () => host,
    isBusinessUrl: (url) => url === APP_URL,
    applyIntent: (window, intent) => calls.push({ window, intent }),
  });
  const loginCases = [
    null,
    'xhs',
    {},
    { accountId: 'not-a-uuid', platform: 'xhs' },
    { accountId: ACCOUNT_ID, platform: 'weibo' },
    { accountId: ACCOUNT_ID, platform: 'xhs', extra: true },
    { accountId: ACCOUNT_ID, platform: 'xhs', account_id: ACCOUNT_ID },
    { accountId: '00000003111141118111111111111111', platform: 'xhs' },
  ];
  for (const input of loginCases) {
    const result = await handlers.get(DESKTOP_UI_OPEN_PLATFORM_LOGIN_CHANNEL)(event, input);
    assert.equal(result.ok, false, `应拒绝 ${JSON.stringify(input)}`);
    assert.equal(result.code, 'invalid_argument');
    assert.ok(!result.message.includes(ACCOUNT_ID), '失败文案不得回显账号 ID');
  }
  const panelCases = [
    null,
    'connection',
    {},
    { action: 'unknown' },
    { action: 'Connection' },
    { action: 'connection', panel: 'ai' },
    { action: 7 },
  ];
  for (const input of panelCases) {
    const result = await handlers.get(DESKTOP_UI_SETTINGS_PANEL_CHANNEL)(event, input);
    assert.equal(result.ok, false, `应拒绝 ${JSON.stringify(input)}`);
    assert.equal(result.code, 'invalid_argument');
  }
  assert.deepEqual(calls, [], '非法参数不得触发 applyIntent');
});

test('OPT-U04: 合法平台登录只调用一次 applyIntent，映射为 platform-login', async () => {
  const calls = [];
  const { host, event } = hostAndEvent();
  const handlers = registerHarness({
    businessWindow: () => host,
    isBusinessUrl: (url) => url === APP_URL,
    applyIntent: (window, intent) => calls.push({ window, intent }),
  });
  for (const platform of ['wechat_mp', 'xhs', 'toutiao']) {
    const result = await handlers.get(DESKTOP_UI_OPEN_PLATFORM_LOGIN_CHANNEL)(event, { accountId: ACCOUNT_ID, platform });
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(calls.at(-1), {
      window: host,
      intent: { type: 'platform-login', accountId: ACCOUNT_ID, platform },
    });
  }
  assert.equal(calls.length, 3);
});

test('OPT-U04: 合法面板动作精确映射 settings-pane / settings-detach / settings-close', async () => {
  const calls = [];
  const { host, event } = hostAndEvent();
  const handlers = registerHarness({
    businessWindow: () => host,
    isBusinessUrl: (url) => url === APP_URL,
    applyIntent: (window, intent) => calls.push({ window, intent }),
  });
  const expected = {
    connection: { type: 'settings-pane', panel: 'connection' },
    ai: { type: 'settings-pane', panel: 'ai' },
    'account-device': { type: 'settings-pane', panel: 'account-device' },
    diagnostics: { type: 'settings-pane', panel: 'diagnostics' },
    detach: { type: 'settings-detach' },
    close: { type: 'settings-close' },
  };
  for (const [action, intent] of Object.entries(expected)) {
    const result = await handlers.get(DESKTOP_UI_SETTINGS_PANEL_CHANNEL)(event, { action });
    assert.deepEqual(result, { ok: true }, action);
    assert.deepEqual(calls.at(-1), { window: host, intent }, action);
  }
  assert.equal(calls.length, Object.keys(expected).length);
});
