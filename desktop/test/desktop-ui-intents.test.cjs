const assert = require('node:assert/strict');
const test = require('node:test');
const { isBusinessWindowOnlyIntent, parseDesktopUiIntent } = require('../.build/ui-intents.js');

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
  assert.deepEqual(parseDesktopUiIntent('ops-desktop://ui/platform-account-sync/00000003-1111-4111-8111-111111111111/incremental/7/00000004-1111-4111-8111-111111111111'), {
    type: 'platform-account-sync', accountId: '00000003-1111-4111-8111-111111111111', mode: 'incremental',
    connectionRevision: 7, requestId: '00000004-1111-4111-8111-111111111111'
  });
  assert.deepEqual(parseDesktopUiIntent('ops-desktop://ui/platform-account-sync/00000003-1111-4111-8111-111111111111/full_reconcile/12/00000004-1111-4111-8111-111111111111'), {
    type: 'platform-account-sync', accountId: '00000003-1111-4111-8111-111111111111', mode: 'full_reconcile',
    connectionRevision: 12, requestId: '00000004-1111-4111-8111-111111111111'
  });
});

test('accepts the fixed metrics refresh and sync resume intents', () => {
  assert.deepEqual(parseDesktopUiIntent('ops-desktop://ui/platform-metrics-refresh/00000003-1111-4111-8111-111111111111/9/00000004-1111-4111-8111-111111111111'), {
    type: 'platform-metrics-refresh', accountId: '00000003-1111-4111-8111-111111111111',
    connectionRevision: 9, requestId: '00000004-1111-4111-8111-111111111111'
  });
  assert.deepEqual(parseDesktopUiIntent('ops-desktop://ui/platform-metrics-refresh/00000003-1111-4111-8111-111111111111/9/00000005-1111-4111-8111-111111111111/00000004-1111-4111-8111-111111111111'), {
    type: 'platform-metrics-refresh', accountId: '00000003-1111-4111-8111-111111111111', connectionRevision: 9,
    platformWorkId: '00000005-1111-4111-8111-111111111111', requestId: '00000004-1111-4111-8111-111111111111'
  });
  assert.deepEqual(parseDesktopUiIntent('ops-desktop://ui/platform-sync-resume/00000003-1111-4111-8111-111111111111/00000006-1111-4111-8111-111111111111/3/00000004-1111-4111-8111-111111111111'), {
    type: 'platform-sync-resume', accountId: '00000003-1111-4111-8111-111111111111',
    operationId: '00000006-1111-4111-8111-111111111111', expectedOperationRevision: 3,
    requestId: '00000004-1111-4111-8111-111111111111'
  });
});

test('all three platform operations are restricted to the business window', () => {
  for (const url of [
    'ops-desktop://ui/platform-account-sync/00000003-1111-4111-8111-111111111111/incremental/7/00000004-1111-4111-8111-111111111111',
    'ops-desktop://ui/platform-metrics-refresh/00000003-1111-4111-8111-111111111111/9/00000004-1111-4111-8111-111111111111',
    'ops-desktop://ui/platform-sync-resume/00000003-1111-4111-8111-111111111111/00000006-1111-4111-8111-111111111111/3/00000004-1111-4111-8111-111111111111',
  ]) {
    const intent = parseDesktopUiIntent(url);
    assert.ok(intent);
    assert.equal(isBusinessWindowOnlyIntent(intent), true);
  }
  assert.equal(isBusinessWindowOnlyIntent(parseDesktopUiIntent('ops-desktop://ui/menu/client')), false);
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
    'ops-desktop://ui/platform-account-sync/../../incremental/7/00000004-1111-4111-8111-111111111111',
    'ops-desktop://ui/platform-account-sync/00000003-1111-4111-8111-111111111111/unknown/7/00000004-1111-4111-8111-111111111111',
    'ops-desktop://ui/platform-account-sync/00000003-1111-4111-8111-111111111111/incremental/0/00000004-1111-4111-8111-111111111111',
    'ops-desktop://ui/platform-account-sync/00000003-1111-4111-8111-111111111111/incremental/9007199254740992/00000004-1111-4111-8111-111111111111',
    'ops-desktop://ui/platform-account-sync/00000003-1111-4111-8111-111111111111/incremental/7/not-a-uuid',
    'ops-desktop://ui/platform-account-sync/00000003-1111-4111-8111-111111111111/incremental/7/00000004-1111-4111-8111-111111111111?next=https://evil.example',
    'ops-desktop://ui/platform-metrics-refresh/../../9/00000004-1111-4111-8111-111111111111',
    'ops-desktop://ui/platform-metrics-refresh/00000003-1111-4111-8111-111111111111/0/00000004-1111-4111-8111-111111111111',
    'ops-desktop://ui/platform-metrics-refresh/00000003-1111-4111-8111-111111111111/9/not-a-uuid/00000004-1111-4111-8111-111111111111',
    'ops-desktop://ui/platform-metrics-refresh/00000003-1111-4111-8111-111111111111/9/00000004-1111-4111-8111-111111111111?next=https://evil.example',
    'ops-desktop://ui/platform-sync-resume/00000003-1111-4111-8111-111111111111/00000006-1111-4111-8111-111111111111/0/00000004-1111-4111-8111-111111111111',
    'ops-desktop://ui/platform-sync-resume/00000003-1111-4111-8111-111111111111/not-a-uuid/3/00000004-1111-4111-8111-111111111111',
    'ops-desktop://ui/platform-sync-resume/00000003-1111-4111-8111-111111111111/00000006-1111-4111-8111-111111111111/9007199254740992/00000004-1111-4111-8111-111111111111',
    'ops-desktop://ui/platform-sync-resume/00000003-1111-4111-8111-111111111111/00000006-1111-4111-8111-111111111111/3/00000004-1111-4111-8111-111111111111?next=https://evil.example',
  ]) assert.equal(parseDesktopUiIntent(url), null, url);
});
