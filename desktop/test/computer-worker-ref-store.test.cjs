'use strict';
// DEV-CU P2-3：进程内 RefStore 的单测（不需要真实桌面）。
// 对应规格 §P2-3 判据：8 个上限、latest 不被删、跨 grant 拒绝、generation 变化拒绝、
// uia_invalidate 清空；另加「文件系统零新增写入」与 worker 命令入口。

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');

const { RefStore, DEFAULT_MAX_PER_GRANT } = require('../src/computer-worker/ref-store.js');

function seed(store, grantId, n, generation = 1) {
  const ids = [];
  for (let i = 1; i <= n; i++) {
    const sid = `s${grantId}${i}`;
    store.save(grantId, sid, { generation, createdAt: 1000 + i });
    ids.push(sid);
  }
  return ids;
}

test('P2-3: 单 grant 最多 8 个快照，超出淘汰最旧', () => {
  assert.equal(DEFAULT_MAX_PER_GRANT, 8);
  const store = new RefStore();
  const ids = seed(store, 'g1', 9);
  assert.equal(store.stats().snapshots, 8);
  assert.throws(() => store.load(ids[0], 'g1', 1), (e) => e.code === 'computer_stale_ref');
  assert.equal(store.load(ids[1], 'g1', 1).snapshot_id, ids[1]);
  assert.equal(store.load(ids[8], 'g1', 1).snapshot_id, ids[8]);
});

test('P2-3: 淘汰永不删 latest（maxPerGrant=0 也保留最新一次）', () => {
  const store = new RefStore({ maxPerGrant: 0 });
  store.save('g1', 'sA', { generation: 1, createdAt: 1 });
  const r = store.save('g1', 'sB', { generation: 1, createdAt: 2 });
  assert.deepEqual(r.evicted, ['sA']);
  assert.equal(store.stats().snapshots, 1);
  assert.equal(store.load('sB', 'g1', 1).snapshot_id, 'sB');
});

test('P2-3: 跨 grant 一律拒绝', () => {
  const store = new RefStore();
  store.save('g1', 'sA', { generation: 1 });
  assert.throws(() => store.load('sA', 'g2', 1), (e) => e.code === 'computer_stale_ref');
  assert.equal(store.load('sA', 'g1', 1).snapshot_id, 'sA');
});

test('P2-3: generation 变化直接 stale，不进入树比较', () => {
  const store = new RefStore();
  store.save('g1', 'sA', { generation: 7, tree: { role: 'button' } });
  assert.throws(() => store.load('sA', 'g1', 8), (e) => e.code === 'computer_stale_ref');
  assert.throws(() => store.load('sA', 'g1', 6), /generation/);
  assert.equal(store.load('sA', 'g1', 7).generation, 7);
});

test('P2-3: uia_invalidate 清空指定 grant，不影响其它 grant', () => {
  const store = new RefStore();
  seed(store, 'g1', 2);
  seed(store, 'g2', 1);
  assert.equal(store.invalidate('g1'), 2);
  assert.equal(store.stats().snapshots, 1);
  assert.throws(() => store.load('sg11', 'g1', 1), (e) => e.code === 'computer_stale_ref');
  assert.equal(store.load('sg21', 'g2', 1).snapshot_id, 'sg21');
  assert.equal(store.invalidate('nope'), 0);
  assert.equal(store.clear(), 1);
  assert.equal(store.stats().snapshots, 0);
});

test('P2-3: save 拒绝空 grant_id / snapshot_id', () => {
  const store = new RefStore();
  assert.throws(() => store.save('', 'sA', {}), (e) => e.code === 'computer_invalid_args');
  assert.throws(() => store.save('g1', '', {}), (e) => e.code === 'computer_invalid_args');
});

test('P2-3: 不落盘——不创建 ~/.agent-desktop', () => {
  const store = new RefStore();
  seed(store, 'g1', 3);
  store.load('sg11', 'g1', 1);
  store.invalidate('g1');
  assert.equal(fs.existsSync(path.join(os.homedir(), '.agent-desktop')), false,
    'RefStore 不得写 ~/.agent-desktop');
});

test('P2-3: worker 命令 uia_invalidate / ref_store_stats 可用', async () => {
  const entry = path.resolve(__dirname, '..', 'src', 'computer-worker', 'index.js');
  const child = fork(entry, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const call = (cmd, extra = {}) => new Promise((resolve, reject) => {
    const id = 't' + Math.random().toString(36).slice(2, 8);
    const timer = setTimeout(() => reject(new Error('timeout')), 10000);
    const onMsg = (m) => { if (m && m.id === id) { clearTimeout(timer); child.off('message', onMsg); resolve(m); } };
    child.on('message', onMsg);
    child.send({ id, cmd, ...extra });
  });
  try {
    const bad = await call('uia_invalidate');
    assert.equal(bad.ok, false);
    assert.equal(bad.error, 'params_invalid');

    const ok = await call('uia_invalidate', { grant_id: 'g-1' });
    assert.equal(ok.ok, true);
    assert.equal(ok.cleared, 0);

    const stats = await call('ref_store_stats');
    assert.equal(stats.ok, true);
    assert.equal(stats.grants, 0);
    assert.equal(stats.snapshots, 0);
    assert.equal(stats.maxPerGrant, 8);
  } finally {
    child.kill();
  }
});
