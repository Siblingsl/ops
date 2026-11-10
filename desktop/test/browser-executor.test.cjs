'use strict';
// A30b 片 2：AI 浏览器命令执行器（桌面侧）单测——依赖注入 mock，无真实网络/桥。

const assert = require('node:assert/strict');
const test = require('node:test');

const executor = require('../.build/browser-executor.js');

function mkDeps(overrides = {}) {
  const calls = { listPending: 0, dispatch: [], receipt: [], waits: [] };
  const deps = {
    listPending: async () => { calls.listPending += 1; return { commands: [] }; },
    dispatch: async (id) => { calls.dispatch.push(id); return { id, claimed: true, payload: {} }; },
    receipt: async (id, body) => { calls.receipt.push({ id, body }); return {}; },
    bridgeState: () => 'paired',
    dispatchAndWait: async (action, payload, timeoutMs) => {
      calls.waits.push({ action, payload, timeoutMs });
      return { ok: true, result: { echoed: payload } };
    },
    log: () => {},
    ...overrides,
  };
  return { deps, calls };
}

test('bridge not paired: skips the whole tick without touching the server', async () => {
  const { deps, calls } = mkDeps({ bridgeState: () => 'other' });
  const ex = new executor.BrowserCommandExecutor(deps);
  assert.equal(await ex.tick(), 0);
  assert.equal(calls.listPending, 0, '未配对不得拉取 pending');
});

test('executes a pending command end to end: claim -> run -> receipt with result', async () => {
  const { deps, calls } = mkDeps({
    listPending: async () => ({ commands: [{ id: 'cmd-1', action_kind: 'observe', payload: { tab_id: 1 }, deadline_at: new Date(Date.now() + 20_000).toISOString() }] }),
    dispatch: async (id) => { calls.dispatch.push(id); return { id, claimed: true, payload: { tab_id: 1 } }; },
  });
  const ex = new executor.BrowserCommandExecutor(deps);
  assert.equal(await ex.tick(), 1);
  assert.deepEqual(calls.dispatch, ['cmd-1']);
  assert.equal(calls.waits.length, 1);
  assert.equal(calls.waits[0].action, 'observe');
  assert.deepEqual(calls.waits[0].payload, { tab_id: 1 });
  assert.ok(calls.waits[0].timeoutMs <= 15_000, '等待上限不超过 15s');
  assert.equal(calls.receipt.length, 1);
  assert.equal(calls.receipt[0].id, 'cmd-1');
  assert.deepEqual(calls.receipt[0].body, { state: 'succeeded', result: { echoed: { tab_id: 1 } } });
});

test('skips execution when another desktop won the claim', async () => {
  const { deps, calls } = mkDeps({
    listPending: async () => ({ commands: [{ id: 'cmd-2', action_kind: 'click', payload: {} }] }),
    dispatch: async (id) => ({ id, claimed: false }),
  });
  const ex = new executor.BrowserCommandExecutor(deps);
  assert.equal(await ex.tick(), 0);
  assert.equal(calls.waits.length, 0, '未赢得领取不得派发扩展');
  assert.equal(calls.receipt.length, 0, '未执行不得回执');
});

test('receipts a real failure with the extension error code', async () => {
  const { deps, calls } = mkDeps({
    listPending: async () => ({ commands: [{ id: 'cmd-3', action_kind: 'type', payload: {} }] }),
    dispatchAndWait: async () => ({ ok: false, code: 'ref_not_found', message: '节点已失效' }),
  });
  const ex = new executor.BrowserCommandExecutor(deps);
  assert.equal(await ex.tick(), 1);
  assert.deepEqual(calls.receipt[0].body, {
    state: 'failed',
    error_code: 'ref_not_found',
    result: { message: '节点已失效' },
  });
});

test('dispatch failure: no receipt (server state machine owns the outcome)', async () => {
  const { deps, calls } = mkDeps({
    listPending: async () => ({ commands: [{ id: 'cmd-4', action_kind: 'observe', payload: {} }] }),
    dispatch: async () => { throw new Error('409: browser_lease_conflict'); },
  });
  const ex = new executor.BrowserCommandExecutor(deps);
  assert.equal(await ex.tick(), 0);
  assert.equal(calls.waits.length, 0);
  assert.equal(calls.receipt.length, 0, '派发失败不得回执');
});

test('wait timeout is clamped to the remaining command deadline', async () => {
  const { deps, calls } = mkDeps({
    listPending: async () => ({ commands: [{ id: 'cmd-5', action_kind: 'observe', payload: {}, deadline_at: new Date(Date.now() + 4_000).toISOString() }] }),
  });
  const ex = new executor.BrowserCommandExecutor(deps);
  await ex.tick();
  assert.ok(calls.waits[0].timeoutMs <= 4_000 && calls.waits[0].timeoutMs >= 3_000, `等待应钳到 deadline 剩余（3~4s）：${calls.waits[0].timeoutMs}`);
});

test('tick reentry is guarded while a round is in flight', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { deps } = mkDeps({
    dispatchAndWait: async () => { await gate; return { ok: true, result: {} }; },
    listPending: async () => ({ commands: [{ id: 'cmd-6', action_kind: 'observe', payload: {} }] }),
  });
  const ex = new executor.BrowserCommandExecutor(deps);
  const first = ex.tick();
  assert.equal(await ex.tick(), 0, '进行中的一轮不得重入');
  release();
  assert.equal(await first, 1);
});
