const assert = require('node:assert/strict');
const test = require('node:test');
const {
  PublishTaskClient,
  parsePublishTaskClaim,
  toServerPublishResult
} = require('../.build/publish-task-client.js');
const { PLATFORM_OPERATION_PATHS } = require('../.build/platform-capability.js');

const capability = {
  protocol_version: 1,
  enabled: true,
  platforms: ['xhs'],
  purpose: 'platform_collection',
  operations: ['browser.policy.check', 'publish.task.claim', 'publish.task.heartbeat', 'publish.task.result'],
  limits: {},
  protocol_versions: [1]
};

function claimEnvelope(extra = {}) {
  return {
    task: {
      id: '11111111-1111-4111-8111-111111111111',
      workspace_id: '22222222-2222-4222-8222-222222222222',
      account_id: '33333333-3333-4333-8333-333333333333',
      work_id: '44444444-4444-4444-8444-444444444444',
      platform: 'xhs',
      state: 'filling',
      state_version: 4,
      mode: 'desktop'
    },
    lease_expires_at: '2026-11-19T09:00:00Z',
    manifest: { fields: { title: '真实标题' }, assets: [] },
    manifest_revision: 2,
    manifest_content_hash: 'abc123',
    account_name: '验收号',
    external_account_key: 'xhs_user_id:real-account',
    ...extra
  };
}

test('P2 桌面 claim 解析 manifest、账号名与稳定外部身份', () => {
  assert.equal(PLATFORM_OPERATION_PATHS['publish.task.claim'].path, '/api/v1/desktop/platform/publish/tasks/claim');
  assert.equal(PLATFORM_OPERATION_PATHS['publish.task.heartbeat'].path, '/api/v1/desktop/platform/publish/tasks/{id}/heartbeat');
  assert.equal(PLATFORM_OPERATION_PATHS['publish.task.result'].path, '/api/v1/desktop/platform/publish/tasks/{id}/results');
  assert.equal(
    PLATFORM_OPERATION_PATHS['browser.policy.check'].path,
    '/api/v1/desktop/platform/browser-policy/check'
  );
  const parsed = parsePublishTaskClaim(claimEnvelope());
  assert.equal(parsed.taskId, '11111111-1111-4111-8111-111111111111');
  assert.equal(parsed.stateVersion, 4);
  assert.equal(parsed.mode, 'desktop');
  assert.equal(parsed.accountName, '验收号');
  assert.equal(parsed.externalAccountKey, 'xhs_user_id:real-account');
  assert.equal(parsed.manifestRevision, 2);
  assert.equal(parsed.manifestContentHash, 'abc123');
  assert.equal(parsed.manifest.fields.title, '真实标题');
  assert.equal(parsePublishTaskClaim({ task: null }), null);
});

test('P2 桌面结果只发送服务端允许的 filled/failed/not_logged_in', () => {
  const filled = toServerPublishResult({
    state: 'awaiting_user',
    readback: { ok: true },
    evidence: { adapter_version: 'xhs-fill-v1' }
  });
  assert.equal(filled.to, 'filled');
  assert.equal(filled.evidence.readback_ok, true);

  const manual = toServerPublishResult({
    state: 'awaiting_user',
    errorCode: 'manual_fill_required',
    errorMessage: '等待用户手动填写'
  });
  assert.equal(manual.to, 'failed');
  assert.equal(manual.errorCode, 'manual_fill_required');

  const login = toServerPublishResult({
    state: 'failed',
    errorCode: 'platform_login_required',
    errorMessage: '登录失效'
  });
  assert.equal(login.to, 'not_logged_in');
});

test('F5 桌面 client 用签名端点检查浏览器策略并透传 reason', async () => {
  const calls = [];
  const client = new PublishTaskClient(capability, async (operation, method, path, body) => {
    calls.push({ operation, method, path, body });
    return { ok: false, reason: 'policy_url_not_allowed' };
  });
  const result = await client.checkBrowserPolicy({
    accountId: '33333333-3333-4333-8333-333333333333',
    purpose: 'publish_fill',
    url: 'https://creator.xiaohongshu.com/publish/publish?source=official',
    tabCount: 1,
    action: 'fill'
  });
  assert.deepEqual(result, { ok: false, reason: 'policy_url_not_allowed' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].operation, 'browser.policy.check');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].path, '/api/v1/desktop/platform/browser-policy/check');
  assert.equal(calls[0].body.tab_count, 1);
  assert.equal(calls[0].body.action, 'fill');
});

test('P2 桌面 client 用固定操作路径与 state_version 回传', async () => {
  const calls = [];
  const client = new PublishTaskClient(capability, async (operation, method, path, body) => {
    calls.push({ operation, method, path, body });
    if (operation === 'publish.task.claim') return claimEnvelope();
    if (operation === 'publish.task.heartbeat') return { lease_expires_at: '2026-11-19T09:01:00Z' };
    return { ok: true };
  });
  const claimed = await client.claim();
  assert.equal(claimed.taskId, '11111111-1111-4111-8111-111111111111');
  const heartbeat = await client.heartbeat();
  assert.equal(heartbeat.leaseExpiresAt, '2026-11-19T09:01:00Z');
  await client.result({ state: 'awaiting_user', readback: { ok: true } });

  assert.deepEqual(calls.map((call) => call.operation), [
    'publish.task.claim',
    'publish.task.heartbeat',
    'publish.task.result'
  ]);
  assert.equal(calls[0].path, '/api/v1/desktop/platform/publish/tasks/claim');
  assert.equal(
    calls[1].path,
    '/api/v1/desktop/platform/publish/tasks/11111111-1111-4111-8111-111111111111/heartbeat'
  );
  assert.equal(calls[1].body.state_version, 4);
  assert.equal(calls[2].body.to, 'filled');
  assert.equal(calls[2].body.state_version, 4);
  assert.equal(client.claimed(), null);
});
