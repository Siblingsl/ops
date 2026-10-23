const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

test('exposes only one-way settings, platform intent and client health subscriptions', () => {
  const exposed = {};
  const handlers = new Map();
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
    'onClientHealth',
    'onLocalSettingsState',
    'onOpenSettings',
    'onPlatformIntentResult'
  ]);
  assert.deepEqual(Object.keys(exposed.opsDesktopUI).filter((key) => !key.startsWith('on')), []);

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
