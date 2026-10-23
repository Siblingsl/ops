const assert = require('node:assert/strict');
const test = require('node:test');

const { buildFailedBatch, PlatformClient, PLATFORM_PROTOCOL_VERSION, PLATFORM_PROTOCOL_V2 } = require('../.build/platform-client.js');
const { PLATFORM_REGISTER_PURPOSE, parsePlatformCollectionCapability } = require('../.build/platform-capability.js');

const capability = parsePlatformCollectionCapability({
  platform_collection: {
    protocol_version: 1,
    enabled: true,
    platforms: ['wechat_mp', 'xhs'],
    purpose: PLATFORM_REGISTER_PURPOSE,
    operations: [
      'platform.device.register',
      'platform.presence',
      'platform.run.claim',
      'platform.run.heartbeat',
      'platform.run.result',
      'platform.run.receipt'
    ],
    limits: { challenge_per_minute: 60, request_bytes: 65536, results_bytes: 524288 }
  }
}, 1);

const run = {
  id: '11111111-1111-4111-8111-111111111111',
  connection_id: '22222222-2222-4222-8222-222222222222',
  account_id: '33333333-3333-4333-8333-333333333333',
  platform: 'xhs',
  trigger: 'manual',
  task_kind: 'collect',
  lease_generation: 3,
  lease_expires_at: '2026-10-20T10:05:00Z',
  deadline_at: '2026-10-20T10:09:00Z',
  authorization_revision: 2,
  adapter_version: 'fixture-1',
  mapping_version: 1,
  query_scope: {},
  binding_snapshot: [],
  budget: { max_rows: 2, max_bytes: 2048, max_duration_seconds: 300 }
};

const v2Capability = parsePlatformCollectionCapability({
  platform_collection: {
    protocol_version: 1,
    enabled: true,
    platforms: ['wechat_mp', 'xhs'],
    purpose: PLATFORM_REGISTER_PURPOSE,
    operations: ['platform.run.claim', 'platform.run.heartbeat', 'platform.run.result', 'platform.run.receipt'],
    limits: {
      results_bytes: 2 << 20,
      v2_account_batch_bytes: 512 << 10,
      v2_catalog_batch_bytes: 512 << 10,
      v2_content_batch_bytes: 2 << 20
    },
    protocol_versions: [1, 2],
    v2: {
      protocol_version: 2,
      enabled: true,
      operations: [],
      task_kinds: ['account_sync', 'content'],
      result_types: ['account_snapshot', 'work_catalog', 'work_content', 'metrics', 'control'],
      account_sync_platforms: ['xhs'],
      metrics_refresh_platforms: ['xhs'],
      limits: {
        account_batch_bytes: 512 << 10,
        catalog_batch_bytes: 512 << 10,
        content_batch_bytes: 2 << 20,
        metrics_batch_bytes: 512 << 10,
        content_run_bytes: 8 << 20
      }
    }
  }
}, 1);

const v2Run = { ...run, task_kind: 'account_sync', wire_protocol_version: PLATFORM_PROTOCOL_V2, operation_stage: 'profile' };

function observation(rowNo) {
  return {
    row_no: rowNo, scope: 'work', external_account_key: 'xhs_user_id:fixture-self',
    external_id: '6f0000000000000000000001', binding_revision: 1, publish_revision: 1,
    source: 'xhs_browser', temporal_kind: 'cumulative',
    observed_at: '2026-10-20T10:05:00Z', as_of_at: '2026-10-20T10:04:00Z',
    adapter_version: 'fixture-1', mapping_version: 1,
    values: { view_times: { value: 320, precision: 'exact', unit: 'times' } },
    field_paths: { view_times: 'fixture.note.view_count' }
  };
}

function fakeSigner(responses) {
  const calls = [];
  const sign = async (operation, method, path, body) => {
    calls.push({ operation, method, path, body });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { sign, calls };
}

test('claim 返回空时置空当前任务，不伪造宿主数据', async () => {
  const { sign, calls } = fakeSigner([{ run: null }]);
  const client = new PlatformClient(capability, sign);
  assert.equal(await client.claim(), null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].operation, 'platform.run.claim');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].path, '/api/v1/desktop/platform/runs/claim');
  // 没有任务时不能提交或续租。
  await assert.rejects(() => client.submit({ final_batch: true, run_status: 'failed', observations: [] }), /没有已领取/);
});

test('提交批次绑定冻结的 generation 与授权版本，批次号自增', async () => {
  const { sign, calls } = fakeSigner([
    { run },
    { batch_seq: 0, receipt_id: 'r0', accepted: 1, pending: 0, rejected: 0, duplicate: 0, run_status: 'running' },
    { batch_seq: 1, receipt_id: 'r1', accepted: 1, pending: 0, rejected: 0, duplicate: 0, run_status: 'succeeded' }
  ]);
  const client = new PlatformClient(capability, sign);
  await client.claim();
  await client.submit({ final_batch: false, run_status: 'partial', observations: [observation(0)] });
  await client.submit({ final_batch: true, run_status: 'succeeded', observations: [observation(0)] });

  const first = calls[1].body;
  assert.equal(first.protocol_version, PLATFORM_PROTOCOL_VERSION);
  assert.equal(first.lease_generation, 3);
  assert.equal(first.authorization_revision, 2);
  assert.equal(first.batch_seq, 0);
  assert.equal(calls[2].body.batch_seq, 1);
  // 路径必须以领取到的 run ID 为准，不能被外部改写。
  assert.equal(calls[1].path, `/api/v1/desktop/platform/runs/${run.id}/results`);
});

test('超出 run 预算时拒绝提交，不把超额数据发出去', async () => {
  const { sign } = fakeSigner([{ run }]);
  const client = new PlatformClient(capability, sign);
  await client.claim();
  await assert.rejects(
    () => client.submit({ final_batch: true, run_status: 'succeeded', observations: [observation(0), observation(1), observation(2)] }),
    /读取预算/
  );
});

test('非终批失败不重试，避免批次序号错位', async () => {
  const { sign, calls } = fakeSigner([{ run }, new Error('network down')]);
  const client = new PlatformClient(capability, sign);
  await client.claim();
  await assert.rejects(() => client.submit({ final_batch: false, run_status: 'partial', observations: [observation(0)] }), /network down/);
  assert.equal(calls.filter((c) => c.operation === 'platform.run.result').length, 1);
});

test('终批失败只按相同内容重试一次，服务端幂等去重', async () => {
  const { sign, calls } = fakeSigner([
    { run },
    new Error('response lost'),
    { batch_seq: 0, receipt_id: 'r0', accepted: 1, pending: 0, rejected: 0, duplicate: 0, run_status: 'succeeded' }
  ]);
  const client = new PlatformClient(capability, sign);
  await client.claim();
  const receipt = await client.submit({ final_batch: true, run_status: 'succeeded', observations: [observation(0)] });
  assert.equal(receipt.receipt_id, 'r0');
  const resultCalls = calls.filter((c) => c.operation === 'platform.run.result');
  assert.equal(resultCalls.length, 2);
  assert.deepEqual(resultCalls[0].body, resultCalls[1].body);
});

test('heartbeat 的取消状态与回执查询路径正确', async () => {
  const { sign, calls } = fakeSigner([
    { run },
    { canceled: true, lease_expires_at: '2026-10-20T10:06:00Z' },
    { batch_seq: 0, receipt_id: 'r0', accepted: 1, run_status: 'succeeded' }
  ]);
  const client = new PlatformClient(capability, sign);
  await client.claim();
  const beat = await client.heartbeat();
  assert.equal(beat.canceled, true);
  const receipt = await client.receipt(0);
  assert.equal(receipt.receipt_id, 'r0');
  assert.equal(calls[2].path, `/api/v1/desktop/platform/runs/${run.id}/receipts/0`);
  assert.equal(calls[2].method, 'GET');
  // 非法序号不发请求。
  await assert.rejects(() => client.receipt(-1), /序号无效/);
});

test('平台页面长时间打开期间持续续租，并传回取消状态', async () => {
  const calls = [];
  let heartbeatCount = 0;
  const client = new PlatformClient(v2Capability, async (operation, method, path, body) => {
    calls.push({ operation, method, path, body });
    if (operation === 'platform.run.heartbeat') {
      heartbeatCount += 1;
      return { canceled: heartbeatCount >= 2, lease_expires_at: '2026-10-20T10:06:00Z' };
    }
    return {};
  });
  client.adopt(v2Run);

  const result = await client.withHeartbeat(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    return 'page-ready';
  }, 5);

  assert.equal(result.value, 'page-ready');
  assert.equal(result.canceled, true);
  assert.ok(calls.filter((call) => call.operation === 'platform.run.heartbeat').length >= 2);
});

test('失败终批可以带 0 条观测，并携带停止原因与错误码', () => {
  const batch = buildFailedBatch(4, 7, 2, {
    status: 'failed', stopReason: 'challenge_required', errorCode: 'platform_challenge_required'
  });
  assert.equal(batch.final_batch, true);
  assert.equal(batch.run_status, 'failed');
  assert.equal(batch.stop_reason, 'challenge_required');
  assert.equal(batch.error_code, 'platform_challenge_required');
  assert.deepEqual(batch.observations, []);
  assert.equal(batch.lease_generation, 4);
  assert.equal(batch.authorization_revision, 7);
  assert.equal(batch.batch_seq, 2);
});

test('服务端未启用时不允许构造客户端', () => {
  const disabled = parsePlatformCollectionCapability({
    platform_collection: {
      protocol_version: 1, enabled: false, platforms: ['xhs'], purpose: PLATFORM_REGISTER_PURPOSE,
      operations: ['platform.run.claim'], limits: {}
    }
  }, 1);
  assert.throws(() => new PlatformClient(disabled, async () => ({})), /尚未启用/);
});

test('v2 claim 显式协商类型化结果与内置适配器版本', async () => {
  const { sign, calls } = fakeSigner([
    { run: v2Run },
    { batch_seq: 0, receipt_id: 'v2-r0', accepted: 1, pending: 0, rejected: 0, duplicate: 0, run_status: 'running' }
  ]);
  const client = new PlatformClient(v2Capability, sign);
  await client.claim();
  assert.deepEqual(calls[0].body.protocol_versions, [PLATFORM_PROTOCOL_VERSION, PLATFORM_PROTOCOL_V2]);
  assert.deepEqual(calls[0].body.result_types, v2Capability.v2.result_types);
  assert.deepEqual(calls[0].body.adapter_versions, { xhs: 'xhs-1', wechat_mp: 'wechat-mp-1' });
  await client.submitV2('account_snapshot', { identity_external_account_key: 'xhs_user_id:fixture-self' });
  assert.equal(calls[1].body.result_type, 'account_snapshot');
  assert.equal(calls[1].body.protocol_version, PLATFORM_PROTOCOL_V2);
});

test('v2 拒绝超过类型批次上限或未公布的结果类型，且不发送', async () => {
  const { sign, calls } = fakeSigner([]);
  const client = new PlatformClient(v2Capability, sign);
  client.adopt(v2Run);
  await assert.rejects(() => client.submitV2('account_snapshot', {
    identity_external_account_key: 'xhs_user_id:fixture-self', pad: 'x'.repeat(520 << 10)
  }), /超过本机协商上限/);
  assert.equal(calls.length, 0);

  const restricted = parsePlatformCollectionCapability({
    platform_collection: {
      protocol_version: 1, enabled: true, platforms: ['xhs'], purpose: PLATFORM_REGISTER_PURPOSE,
      operations: ['platform.run.claim'], limits: { results_bytes: 2 << 20 }, protocol_versions: [1, 2],
      v2: { protocol_version: 2, enabled: true, operations: [], task_kinds: ['account_sync'], result_types: ['control'], limits: {} }
    }
  }, 1);
  const restrictedClient = new PlatformClient(restricted, sign);
  restrictedClient.adopt(v2Run);
  await assert.rejects(() => restrictedClient.submitV2('account_snapshot', {}), /未公布此 v2 结果类型/);
  assert.equal(calls.length, 0);
});
