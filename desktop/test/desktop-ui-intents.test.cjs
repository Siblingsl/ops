const assert = require('node:assert/strict');
const test = require('node:test');
const { parseDesktopUiIntent } = require('../.build/ui-intents.js');

test('accepts only explicitly defined native menu and settings intents', () => {
  assert.deepEqual(parseDesktopUiIntent('ops-desktop://ui/menu/client'), { type: 'menu', menu: 'client' });
  assert.deepEqual(parseDesktopUiIntent('ops-desktop://ui/menu/edit'), { type: 'menu', menu: 'edit' });
  assert.deepEqual(parseDesktopUiIntent('ops-desktop://ui/menu/view'), { type: 'menu', menu: 'view' });
  assert.deepEqual(parseDesktopUiIntent('ops-desktop://ui/settings'), { type: 'settings' });
  for (const panel of ['connection', 'ai', 'account-device', 'diagnostics']) {
    assert.deepEqual(parseDesktopUiIntent(`ops-desktop://ui/settings/${panel}`), { type: 'settings-pane', panel });
  }
  assert.deepEqual(parseDesktopUiIntent('ops-desktop://ui/settings/detach'), { type: 'settings-detach' });
  assert.deepEqual(parseDesktopUiIntent('ops-desktop://ui/settings/close'), { type: 'settings-close' });
  assert.deepEqual(parseDesktopUiIntent('ops-desktop://ui/platform-login/00000003-1111-4111-8111-111111111111/toutiao'), {
    type: 'platform-login', accountId: '00000003-1111-4111-8111-111111111111', platform: 'toutiao'
  });
});

test('accepts only light and dark native titlebar theme intents', () => {
  assert.deepEqual(parseDesktopUiIntent('ops-desktop://ui/theme/light'), { type: 'theme', theme: 'light' });
  assert.deepEqual(parseDesktopUiIntent('ops-desktop://ui/theme/dark'), { type: 'theme', theme: 'dark' });
});

test('accepts only the two shared motion preference intents', () => {
  assert.deepEqual(parseDesktopUiIntent('ops-desktop://ui/motion/reduce'), { type: 'motion', reduced: true });
  assert.deepEqual(parseDesktopUiIntent('ops-desktop://ui/motion/soft'), { type: 'motion', reduced: false });
});

test('rejects arbitrary commands, origins, query strings, fragments, credentials and ports', () => {
  for (const url of [
    'ops-desktop://ui/menu/quit',
    'ops-desktop://ui/theme/system',
    'ops-desktop://ui/motion/system',
    'ops-desktop://ui/motion/reduce?enabled=false',
    'ops-desktop://ui/menu/client?command=quit',
    'ops-desktop://ui/menu/client#quit',
    'ops-desktop://ui/settings/connection?next=https://evil.example',
    'ops-desktop://ui/settings/connection#other',
    'ops-desktop://ui/settings/unknown',
    'ops-desktop://evil/menu/client',
    'https://ops-desktop/ui/menu/client',
    'ops-desktop://user@ui/menu/client',
    'ops-desktop://ui:444/menu/client',
    'ops-desktop://ui/menu/client/extra',
    'ops-desktop://ui/platform-login/../../etc/passwd/toutiao',
    'ops-desktop://ui/platform-login/00000003-1111-4111-8111-111111111111/unknown',
    'ops-desktop://ui/platform-login/00000003-1111-4111-8111-111111111111/toutiao?next=https://evil.example',
  ]) assert.equal(parseDesktopUiIntent(url), null, url);
});
