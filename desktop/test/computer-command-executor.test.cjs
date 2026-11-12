'use strict';
// DEV-CU P4-11：电脑控制命令执行器（mock deps，无真实窗口/网络）。
// 覆盖：正常终态、CAS 失败不派发、写类一次一条（计数断言）、断网停控清 RefStore、
//       generation 变化不派发回 unknown_outcome、worker 超时 → unknown_outcome。

const assert = require('node:assert/strict');
const test = require('node:test');

const { ComputerCommandExecutor, scheduleNextMs } = require('../src/computer-executor-loader.cjs');

/** 构造可观测的 deps。 */
function makeDeps(over = {}) {
  const calls = {
    pending: 0, dispatch: [], receipt: [], execute: [], invalidate: 0,
  };
  const deps = {
    listPending: async () => { calls.pending += 1; return { commands: [] }; },
    dispatch: async (id) => {
      calls.dispatch.push(id);
      // 真实 CAS 响应是整行视图（含 grant_id/generation）——mock 按传入命令回显。
      const row = (lastCommands || []).find((c) => c.id === id) || { id, grant_id: 'g-1', generation: 7 };
      return { ...row, id, claimed: true };
    },
    receipt: async (id, body) => { calls.receipt.push({ id, body }); return {}; },
    localGenerationOf: () => 7,
    execute: async () => { calls.execute.push(1); return { ok: true, result: { snapshot_id: 's1' } }; },
    ready: () => true,
    invalidate: () => { calls.invalidate += 1; },
    log: () => {},
    ...over,
    calls,
  };
  return deps;
}

/** 本轮清单 + 默认 dispatch 回显（记录走 deps.calls.dispatch）；over 可覆盖任何 dep。 */
function makeDepsWith(commands, over = {}) {
  const seen = { dispatch: [], receipt: [] };
  const deps = makeDeps({
    listPending: async () => ({ commands }),
    dispatch: async (id) => {
      seen.dispatch.push(id);
      const row = commands.find((c) => c.id === id) || { id, grant_id: 'g-1', generation: 7 };
      return { ...row, id, claimed: true };
    },
    receipt: async (id, body) => { seen.receipt.push({ id, body }); return {}; },
    ...over,
  });
  deps.seen = seen;
  return deps;
}

const cmd = (id, over = {}) => ({ id, action_kind: 'observe', grant_id: 'g-1', generation: 7, ...over });

test('P4-11: 正常终态——领取→执行→回执 succeeded 带 result', async () => {
  const deps = makeDepsWith([cmd('c1')]);
  const executor = new ComputerCommandExecutor(deps);
  const n = await executor.tick();
  assert.equal(n, 1);
  assert.deepEqual(deps.seen.dispatch, ['c1']);
  assert.equal(deps.seen.receipt.length, 1);
  assert.equal(deps.seen.receipt[0].body.state, 'succeeded');
  assert.deepEqual(deps.seen.receipt[0].body.result, { snapshot_id: 's1' });
});

test('P4-11: CAS 失败（claimed!=true）不派发、不回执', async () => {
  const deps = makeDeps({
    listPending: async () => { lastCommands = [cmd('c1')]; return { commands: lastCommands }; },
    dispatch: async () => ({ id: 'c1', claimed: false, state: 'dispatched' }),
  });
  const executor = new ComputerCommandExecutor(deps);
  assert.equal(await executor.tick(), 0);
  assert.equal(deps.calls.execute.length, 0, '不得派发给 worker');
  assert.equal(deps.calls.receipt.length, 0, '不得回执');
});

test('P4-11: 一次 tick 最多执行 1 条写类（计数断言，红线 2）', async () => {
  const writes = [cmd('w1', { action_kind: 'invoke' }), cmd('w2', { action_kind: 'type' }), cmd('w3', { action_kind: 'invoke' })];
  const deps = makeDeps({
    listPending: async () => { lastCommands = writes; return { commands: writes }; },
  });
  const executor = new ComputerCommandExecutor(deps);
  await executor.tick();
  const writeExecuted = deps.calls.execute.length;
  assert.ok(writeExecuted <= 1, `一次 tick 写类执行数应 ≤1，实际 ${writeExecuted}`);
  assert.equal(deps.calls.receipt.filter((r) => r.body.state === 'succeeded').length, writeExecuted);
});

test('P4-11: generation 失配 → unknown_outcome 不派发 + invalidate', async () => {
  const deps = makeDepsWith([cmd('c1', { generation: 9 })]);
  const executor = new ComputerCommandExecutor(deps);
  assert.equal(await executor.tick(), 0);
  assert.equal(deps.calls.execute.length, 0, '不得派发给 worker');
  assert.equal(deps.seen.receipt.length, 1);
  assert.equal(deps.seen.receipt[0].body.state, 'unknown_outcome');
  assert.equal(deps.seen.receipt[0].body.error_code, 'computer_stale_ref');
  assert.ok(deps.calls.invalidate >= 1, '失配应清 RefStore');
});

test('P4-11: 断网/未就绪 → 不领取 + invalidate', async () => {
  const deps = makeDeps({ ready: () => false });
  const executor = new ComputerCommandExecutor(deps);
  assert.equal(await executor.tick(), 0);
  assert.equal(deps.calls.pending, 0, '未就绪不得拉清单');
  assert.ok(deps.calls.invalidate >= 1);
});

test('P4-11: worker 超时 → unknown_outcome + computer_timeout', async () => {
  const deps = makeDepsWith([cmd('c1')], {
    execute: async () => ({ ok: false, code: 'computer_timeout' }),
  });
  const executor = new ComputerCommandExecutor(deps);
  await executor.tick();
  assert.equal(deps.seen.receipt[0].body.state, 'unknown_outcome');
  assert.equal(deps.seen.receipt[0].body.error_code, 'computer_timeout');
});

test('P4-11: 读类可到 10 条但逐条领取', async () => {
  const reads = [];
  for (let i = 0; i < 10; i++) reads.push(cmd(`r${i}`));
  const deps = makeDepsWith(reads);
  const executor = new ComputerCommandExecutor(deps);
  assert.equal(await executor.tick(), 10);
  assert.equal(deps.calls.execute.length, 10);
  assert.deepEqual(deps.seen.dispatch, reads.map((c) => c.id), '逐条领取');
});

test('P4-11: scheduleNextMs 退避语义与 browser 同款（复用同一函数）', () => {
  assert.equal(scheduleNextMs(1, 0, 3000, 12000), 3000, '领到命令立即回 base');
  assert.equal(scheduleNextMs(0, 0, 3000, 12000), 3000);
  assert.equal(scheduleNextMs(0, 1, 3000, 12000), 6000);
  assert.equal(scheduleNextMs(0, 5, 3000, 12000), 12000, '封顶 max');
});
