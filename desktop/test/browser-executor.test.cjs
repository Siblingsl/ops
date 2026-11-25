'use strict';
// A30b 片 2：AI 浏览器命令执行器（桌面侧）单测——依赖注入 mock，无真实网络/桥。

const assert = require('node:assert/strict');
const test = require('node:test');

const executor = require('../.build/browser-executor.js');

function mkDeps(overrides = {}) {
  const calls = { listPending: 0, dispatch: [], receipt: [], waits: [] };
  const deps = {
    listPending: async () => { calls.listPending += 1; return { commands: [] }; },
    dispatch: async (id) => { calls.dispatch.push(id); return { id, claimed: true, conversation_id: 'conv-fixture', payload: {} }; },
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
    dispatch: async (id) => { calls.dispatch.push(id); return { id, claimed: true, conversation_id: 'conv-fixture', payload: { tab_id: 1 } }; },
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

// ---------------------------------------------------------------------------
// DT-05（docs/33 §10.5 / 12.2）：接收端自适应退避。
// 3s 固定轮询空闲期也每 3s 一次网络请求；改为「连续空轮指数退避（上限 12s）、
// 领到命令立即回 3s」。同步等待 ≤30s 场景下不破坏 deadline+sweep 兜底（命令最坏
// 延迟 < deadline）。scheduleNextMs 是纯函数：按「本轮是否执行了命令 + 连续空轮数」
// 给出下一轮间隔，主进程 setInterval 用它滚动排程。
// ---------------------------------------------------------------------------

test('DT-05: scheduleNextMs 存在且为导出纯函数', () => {
  assert.equal(typeof executor.scheduleNextMs, 'function', '应导出 scheduleNextMs（修复前不存在）');
});

test('DT-05: 领到命令立即回基础间隔（3s），连续空轮按指数退避', () => {
  const base = 3_000;
  const max = 12_000;
  // 执行了命令 → 基础间隔
  assert.equal(executor.scheduleNextMs(1, 0, base, max), base);
  // 空轮：3s → 6s → 12s（封顶）→ 12s
  assert.equal(executor.scheduleNextMs(0, 0, base, max), base);
  assert.equal(executor.scheduleNextMs(0, 1, base, max), 6_000);
  assert.equal(executor.scheduleNextMs(0, 2, base, max), 12_000);
  assert.equal(executor.scheduleNextMs(0, 3, base, max), 12_000, '封顶后不再增长');
  assert.equal(executor.scheduleNextMs(0, 10, base, max), 12_000);
  // 从退避中领到命令：立即回基础间隔（重置空轮计数）
  assert.equal(executor.scheduleNextMs(2, 3, base, max), base, '有命令执行立即恢复基础间隔');
});

test('DT-05: tick 返回本轮执行的命令数（退避判定输入，既有行为保持）', async () => {
  const { deps } = mkDeps({
    listPending: async () => ({ commands: [{ id: 'cmd-dt5', action_kind: 'observe', payload: {} }] }),
  });
  const ex = new executor.BrowserCommandExecutor(deps);
  assert.equal(await ex.tick(), 1);
});

test('DT-05: 主进程使用自适应间隔排程（源码契约）', () => {
  const fs = require('node:fs');
  const mainSource = fs.readFileSync(require('node:path').join(__dirname, '..', 'src', 'main', 'executors.ts'), 'utf8');
  assert.ok(mainSource.includes('scheduleNextMs'), '主进程应使用 scheduleNextMs 滚动排程');
  assert.ok(mainSource.includes('BROWSER_EXECUTOR_IDLE_MAX_MS'), '应声明空闲退避上限常量');
  assert.ok(!mainSource.includes('setInterval(() => { void executor.tick(); }, BROWSER_EXECUTOR_INTERVAL_MS)'),
    '不得再用固定 setInterval（退避需要每轮重排）');
});

test('DT-05: 环境变量可切回固定间隔（L2 回退分支存在）', () => {
  const fs = require('node:fs');
  const mainSource = fs.readFileSync(require('node:path').join(__dirname, '..', 'src', 'main', 'executors.ts'), 'utf8');
  assert.ok(mainSource.includes('OPS_BROWSER_EXECUTOR_FIXED_INTERVAL_MS'),
    '应支持环境变量切回固定间隔（回退 L2，docs/33 12.2）');
});

test('BR-04: observe 成功自动上报证据（真实命令号/origin/redacted_url/kind）', async () => {
  const evidence = [];
  const { deps } = mkDeps({
    listPending: async () => ({ commands: [{ id: 'cmd-ev-1', action_kind: 'observe', payload: { tab_id: 1, url: 'https://site.example/a?secret=1' }, deadline_at: new Date(Date.now() + 20_000).toISOString() }] }),
    dispatchAndWait: async () => ({ ok: true, result: { origin: 'https://site.example', url: 'https://site.example/a?secret=1', title: '站点 A', doc_rev: 'rev-9' } }),
    reportEvidence: async (ev) => { evidence.push(ev); },
  });
  const ex = new executor.BrowserCommandExecutor(deps);
  assert.equal(await ex.tick(), 1);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].commandId, 'cmd-ev-1');
  assert.equal(evidence[0].origin, 'https://site.example');
  assert.equal(evidence[0].redactedUrl, 'https://site.example/a', 'redacted_url 去查询串');
  assert.equal(evidence[0].kind, 'text');
  assert.equal(evidence[0].title, '站点 A');
  assert.equal(evidence[0].docRevision, 'rev-9');
});

test('BR-04: 命令失败也生成证据（snippet 记失败原因），不伪造成功', async () => {
  const evidence = [];
  const { deps, calls } = mkDeps({
    listPending: async () => ({ commands: [{ id: 'cmd-ev-2', action_kind: 'observe', payload: { tab_id: 1, url: 'https://site.example/b' }, deadline_at: new Date(Date.now() + 20_000).toISOString() }] }),
    dispatch: async (id) => ({ id, claimed: true, conversation_id: 'conv-ev-2', payload: { tab_id: 1, url: 'https://site.example/b' } }),
    dispatchAndWait: async () => ({ ok: false, code: 'bridge_timeout', message: '扩展超时' }),
    reportEvidence: async (ev) => { evidence.push(ev); },
  });
  const ex = new executor.BrowserCommandExecutor(deps);
  await ex.tick();
  assert.equal(calls.receipt[0].body.state, 'failed');
  assert.equal(evidence.length, 1, '失败也上报证据');
  assert.equal(evidence[0].commandId, 'cmd-ev-2');
  assert.ok(evidence[0].snippet.includes('bridge_timeout'), 'snippet 记录失败原因');
});

test('BR-04: 非读取类动作（click）不生成证据', async () => {
  const evidence = [];
  const { deps } = mkDeps({
    listPending: async () => ({ commands: [{ id: 'cmd-ev-3', action_kind: 'click', payload: {} }] }),
    reportEvidence: async (ev) => { evidence.push(ev); },
  });
  const ex = new executor.BrowserCommandExecutor(deps);
  await ex.tick();
  assert.equal(evidence.length, 0, 'click 不上报');
});

test('R11-D2: 同一轮询错误连续出现只记一条，恢复后重新告警', async () => {
  const logs = [];
  let failing = true;
  const { deps } = mkDeps({
    listPending: async () => {
      if (failing) throw new Error('该工作台功能尚未开放');
      return { commands: [] };
    },
    log: (line) => logs.push(line),
  });
  const ex = new executor.BrowserCommandExecutor(deps);
  await ex.tick();
  await ex.tick();
  await ex.tick();
  assert.equal(logs.length, 1, '连续同样的失败只能记一条日志');
  assert.match(logs[0], /该工作台功能尚未开放/);

  failing = false;
  await ex.tick();
  failing = true;
  await ex.tick();
  assert.equal(logs.length, 2, '恢复后再次失败必须重新记录');
});
