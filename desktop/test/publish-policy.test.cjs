const assert = require('node:assert/strict');
const test = require('node:test');

const { createDefaultDesktopPublishAdapterRegistry } = require('../.build/publish/registry.js');
const { runDesktopPublishTask } = require('../.build/publish/executor.js');
const { PLATFORM_PUBLISH_URLS } = require('../.build/publish/platform-urls.js');

function request(overrides = {}) {
  return {
    taskId: 'task-policy',
    workspaceId: 'workspace-policy',
    accountId: 'account-policy',
    workId: 'work-policy',
    platform: 'xhs',
    manifest: {
      fields: { title: '策略闸测试标题', body_text: '正文' },
      assets: [{ role: 'cover', width: 900, height: 1200 }],
    },
    mode: 'desktop',
    accountName: 'OPS策略测试号',
    ...overrides
  };
}

function page(overrides = {}) {
  return {
    currentAccountName: async () => 'OPS策略测试号',
    hasAnchor: async () => true,
    tabCount: async () => 1,
    ...overrides
  };
}

test('F5 桌面 Preflight：policy_denied 不填写、不提交，结果回执 failed', async () => {
  let fills = 0;
  let submits = 0;
  let receipts = 0;
  const seen = [];
  const policy = {
    check: async (input) => {
      seen.push(input);
      return { ok: false, reason: 'policy_missing_or_expired' };
    }
  };
  const registry = createDefaultDesktopPublishAdapterRegistry(page({
    fillFields: async () => { fills += 1; },
    submitNow: async () => { submits += 1; },
  }), policy);
  const task = request();
  const result = await runDesktopPublishTask({
    claim: async () => task,
    heartbeat: async () => undefined,
    result: async (_id, payload) => { receipts += 1; assert.equal(payload.state, 'failed'); },
    registry,
  });

  assert.equal(result.state, 'failed');
  assert.equal(result.errorCode, 'policy_denied');
  assert.match(result.errorMessage, /policy_missing_or_expired/);
  assert.equal(fills, 0);
  assert.equal(submits, 0);
  assert.equal(receipts, 1);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], {
    accountId: 'account-policy',
    purpose: 'publish_fill',
    url: PLATFORM_PUBLISH_URLS.xhs,
    tabCount: 1,
    action: 'fill',
  });
});

test('F5 桌面 Preflight：submit-now 先过策略闸，拒绝时不回读也不点击', async () => {
  let readbacks = 0;
  let submits = 0;
  const seen = [];
  const policy = {
    check: async (input) => {
      seen.push(input);
      return { ok: false, reason: 'single_tab_required' };
    }
  };
  const registry = createDefaultDesktopPublishAdapterRegistry(page({
    tabCount: async () => 2,
    readbackFields: async () => { readbacks += 1; return { title: '', body: '', tags: [], cover: { present: false, ratio: 0 }, schedule: '' }; },
    submitNow: async () => { submits += 1; },
  }), policy);
  const result = await runDesktopPublishTask({
    claim: async () => ({ ...request({ intent: 'submit', explicitSubmitNow: true }) }),
    heartbeat: async () => undefined,
    result: async () => undefined,
    registry,
  });

  assert.equal(result.state, 'failed');
  assert.equal(result.errorCode, 'policy_denied');
  assert.equal(readbacks, 0, '策略拒绝后不得回读页面');
  assert.equal(submits, 0, '策略拒绝后不得点击发布');
  assert.equal(seen[0].action, 'publish');
  assert.equal(seen[0].tabCount, 2);
});

test('F5 桌面 Preflight：策略通过后才进入账号/锚点检查', async () => {
  let checks = 0;
  let fills = 0;
  let readbacks = 0;
  const policy = { check: async () => { checks += 1; return { ok: true }; } };
  const registry = createDefaultDesktopPublishAdapterRegistry(page({
    fillFields: async () => { fills += 1; },
    captureScreenshot: async () => 'base64-jpeg',
    readbackFields: async () => {
      readbacks += 1;
      return { title: '策略闸测试标题', body: '正文', tags: [], cover: { present: true, ratio: 0.75 }, schedule: '' };
    },
  }), policy);
  const result = await runDesktopPublishTask({
    claim: async () => request(),
    heartbeat: async () => undefined,
    result: async () => undefined,
    registry,
  });

  assert.equal(checks, 1);
  assert.equal(fills, 1);
  assert.equal(readbacks, 1);
  assert.ok(result.state === 'approved' || result.state === 'awaiting_user' || result.state === 'filled', result.state);
});
