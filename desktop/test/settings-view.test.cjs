const assert = require('node:assert/strict');
const test = require('node:test');
const {
  EmbeddedSettingsSenderRegistry,
  createLocalSettingsViewController,
  getEmbeddedSettingsBounds,
  parseEmbeddedSettingsPanel,
} = require('../.build/settings-view.js');

test('accepts only exact embedded settings panel URLs', () => {
  for (const panel of ['connection', 'ai', 'account-device', 'diagnostics']) {
    assert.equal(parseEmbeddedSettingsPanel(`ops-desktop://settings/embedded/${panel}`), panel);
  }
  for (const url of [
    'ops-desktop://settings/embedded/connection/',
    'ops-desktop://settings/embedded/unknown',
    'ops-desktop://settings/embedded/connection?next=https://evil.example',
    'ops-desktop://settings/embedded/connection#other',
    'ops-desktop://evil/embedded/connection',
    'ops-desktop://user@settings/embedded/connection',
    'ops-desktop://settings:444/embedded/connection',
    'ops-desktop://settings/embedded/%2e%2e/connection',
    'https://settings/embedded/connection',
  ]) assert.equal(parseEmbeddedSettingsPanel(url), null, url);
});

test('positions the embedded pane inside the unified settings content area', () => {
  assert.deepEqual(getEmbeddedSettingsBounds(960, 640), { x: 237, y: 151, width: 706, height: 408 });
  assert.deepEqual(getEmbeddedSettingsBounds(1440, 900), { x: 381, y: 153, width: 898, height: 664 });
});

test('trusts only the registered WebContents main frame at its registered panel URL', () => {
  const registry = new EmbeddedSettingsSenderRegistry();
  const url = 'ops-desktop://settings/embedded/connection';
  const mainFrame = { url };
  const sender = { id: 7, mainFrame, getURL: () => url, isDestroyed: () => false };
  const unregister = registry.register(sender, 'connection');
  assert.equal(registry.isTrusted({ sender, senderFrame: mainFrame }), true);
  assert.equal(registry.isTrusted({ sender: { ...sender }, senderFrame: mainFrame }), false);
  assert.equal(registry.isTrusted({ sender, senderFrame: { url } }), false);
  assert.equal(registry.isTrusted({ sender, senderFrame: { url: 'ops-desktop://settings/embedded/ai' } }), false);
  assert.equal(registry.isTrusted({ sender: { ...sender, getURL: () => `${url}?x=1` }, senderFrame: mainFrame }), false);
  unregister();
  assert.equal(registry.isTrusted({ sender, senderFrame: mainFrame }), false);
});

test('reuses one view across pane changes, host changes and detach, then destroys it once', async () => {
  let created = 0;
  let destroyed = 0;
  const loaded = [];
  const setBounds = [];
  const registry = new EmbeddedSettingsSenderRegistry();
  let controller;
  controller = createLocalSettingsViewController({
    registry,
    createView: () => {
      created += 1;
      return {
        webContents: {
          id: created,
          mainFrame: { url: '' },
          getURL: () => loaded.at(-1) ?? '',
          isDestroyed: () => false,
          loadURL: async (url) => {
            assert.ok(controller.currentHost, 'view must be attached before its document can report local state');
            loaded.push(url);
          },
          close: () => { destroyed += 1; },
        },
        setBounds: (bounds) => setBounds.push(bounds),
      };
    },
  });
  const first = createHost(960, 640);
  const second = createHost(1440, 900);

  await controller.show(first, 'connection');
  await controller.show(first, 'connection');
  await controller.show(first, 'ai');
  assert.equal(created, 1);
  assert.deepEqual(loaded, [
    'ops-desktop://settings/embedded/connection',
    'ops-desktop://settings/embedded/ai',
  ]);
  assert.equal(first.added.length, 1);
  assert.deepEqual(setBounds.at(-1), { x: 237, y: 151, width: 706, height: 408 });

  controller.detach();
  assert.equal(first.removed.length, 1);
  await controller.show(second, 'diagnostics');
  assert.equal(created, 1);
  assert.equal(second.added.length, 1);
  assert.deepEqual(setBounds.at(-1), { x: 381, y: 153, width: 898, height: 664 });
  controller.destroy();
  controller.destroy();
  assert.equal(second.removed.length, 1);
  assert.equal(destroyed, 1);
  assert.equal(controller.isTrusted({ sender: {}, senderFrame: {} }), false);
});

function createHost(width, height) {
  const listeners = new Map();
  const host = {
    added: [],
    removed: [],
    contentView: {
      addChildView(view) { this.parent.added.push(view); },
      removeChildView(view) { this.parent.removed.push(view); },
      parent: null,
    },
    getContentSize: () => [width, height],
    isDestroyed: () => false,
    on(event, listener) { listeners.set(event, listener); },
    removeListener(event, listener) { if (listeners.get(event) === listener) listeners.delete(event); },
    _listeners: listeners,
  };
  host.contentView.parent = host;
  return host;
}
