const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

test('exposes only one-way settings subscriptions and replays early events once', () => {
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
  assert.deepEqual(Object.keys(exposed.opsDesktopUI).sort(), ['onLocalSettingsState', 'onOpenSettings']);

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
});

function emit(handlers, channel, payload) {
  for (const listener of handlers.get(channel) ?? []) listener({}, payload);
}
