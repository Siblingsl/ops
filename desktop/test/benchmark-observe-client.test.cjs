const assert = require('node:assert/strict');
const test = require('node:test');

const { BenchmarkObserveClient } = require('../.build/benchmark-observe-client.js');

const task = {
  task_id: '11111111-1111-1111-1111-111111111111',
  target_id: '22222222-2222-2222-2222-222222222222',
  url: 'https://www.xiaohongshu.com/user/profile/demo',
  platform: 'xhs',
  lease_token: 'lease-token',
  lease_expires_at: '2026-11-18T12:00:00Z'
};

test('claim 顶层 task 为 null 时返回 null，不伪造任务', async () => {
  const calls = [];
  const client = new BenchmarkObserveClient(async (...args) => {
    calls.push(args);
    return { task: null };
  });
  assert.equal(await client.claim(), null);
  assert.equal(calls[0][0], 'benchmark.observe.claim');
  assert.equal(calls[0][1], 'POST');
  assert.equal(calls[0][2], '/api/v1/desktop/benchmark/tasks/claim');
});

test('claim 返回完整任务时原样带回 lease_token', async () => {
  const client = new BenchmarkObserveClient(async () => ({ task }));
  const claimed = await client.claim();
  assert.equal(claimed.task_id, task.task_id);
  assert.equal(claimed.lease_token, 'lease-token');
});

test('heartbeat 使用任务 ID 与 lease_token，不额外发平台 profile 请求', async () => {
  const calls = [];
  const client = new BenchmarkObserveClient(async (...args) => {
    calls.push(args);
    return {};
  });
  await client.heartbeat(task);
  assert.deepEqual(calls[0], [
    'benchmark.observe.heartbeat',
    'POST',
    `/api/v1/desktop/benchmark/tasks/${task.task_id}/heartbeat`,
    { lease_token: task.lease_token }
  ]);
});

test('results 提交公开页字段；failed 时 values 强制为空', async () => {
  const calls = [];
  const client = new BenchmarkObserveClient(async (...args) => {
    calls.push(args);
    return {};
  });
  await client.results(task, {
    externalId: 'e2e-note-1',
    title: '公开页样本',
    url: 'https://www.xiaohongshu.com/explore/e2e-note-1',
    publishedAt: '2026-11-10T01:12:00.000Z',
    values: { likes: 21, comments: 3 },
    quality: 'ok'
  });
  const body = calls[0][3];
  assert.equal(calls[0][0], 'benchmark.observe.result');
  assert.equal(calls[0][2], `/api/v1/desktop/benchmark/tasks/${task.task_id}/results`);
  assert.equal(body.external_id, 'e2e-note-1');
  assert.equal(body.quality_state, 'ok');
  assert.deepEqual(body.values, { likes: 21, comments: 3 });
  assert.equal(body.structure.source, 'public_page');

  await client.results(task, {
    externalId: 'e2e-note-1',
    title: '公开页样本',
    url: 'https://www.xiaohongshu.com/explore/e2e-note-1',
    publishedAt: null,
    values: { likes: 21 },
    quality: 'failed',
    errorCode: 'login_wall'
  });
  assert.equal(calls[1][3].quality_state, 'failed');
  assert.deepEqual(calls[1][3].values, {});
  assert.equal(calls[1][3].structure.error_code, 'login_wall');
});
