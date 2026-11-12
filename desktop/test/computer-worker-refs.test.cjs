'use strict';
// DEV-CU P2-2：快照 ID 与 ref 分配的单测（不需要真实桌面）。
// 对应规格 §P2-2 的判据：@e1 起始、裸 @e8 被拒、role 全分配、只读 role 不分配、
// ubiquitous 不触发 primary action、1MiB 上限、snapshot_id 校验、ref_count 可复算。
// 注：role 白名单按用户裁决 A 为 18 项（规格写 19 项但只列 18 个名称）。

const assert = require('node:assert/strict');
const test = require('node:test');

const { INTERACTIVE_ROLES, buildObserveTree } = require('../src/computer-worker/tree.js');
const {
  MAX_REF_INDEX,
  RefMap,
  validateSnapshotId,
  newSnapshotId,
  nextRevision,
  qualifyRefId,
  resolveRefTarget,
  isRefAble,
  allocateTreeRefs,
  qualifyTreeRefs,
  countRefs,
  refsAreUnique,
  assertTreeSize,
  compactTree,
} = require('../src/computer-worker/refs.js');

function fixtureNodes() {
  return [
    { parent: -1, role_raw: 'ControlType.Window', name: '无标题 - 记事本', id: 'Win1', value: '', enabled: true, offscreen: false, bounds: { x: 0, y: 0, w: 800, h: 600 }, has_value: false, has_invoke: false, children_count: 4 },
    // 可分配：textfield（role 命中）
    { parent: 0, role_raw: 'ControlType.Document', name: '文本编辑器', id: '', value: 'hi', enabled: true, offscreen: false, bounds: { x: 8, y: 60, w: 780, h: 520 }, has_value: true, has_invoke: false, children_count: 0 },
    // 不可分配：unknown role、无 primary action
    { parent: 0, role_raw: 'ControlType.Pane', name: '容器', id: 'Pane1', value: '', enabled: true, offscreen: false, bounds: { x: 0, y: 0, w: 800, h: 40 }, has_value: false, has_invoke: false, children_count: 2 },
    // 可分配：button
    { parent: 2, role_raw: 'ControlType.Button', name: '设置', id: 'SettingsButton', value: '', enabled: true, offscreen: false, bounds: { x: 700, y: 4, w: 32, h: 32 }, has_value: false, has_invoke: true, children_count: 0 },
    // 可分配：unknown role 但带 primary action（Click）
    { parent: 2, role_raw: 'ControlType.Custom', name: '自定义', id: 'Custom1', value: '', enabled: true, offscreen: false, bounds: { x: 0, y: 0, w: 10, h: 10 }, has_value: false, has_invoke: true, children_count: 0 },
  ];
}

function buildTree(nodes = fixtureNodes()) {
  return buildObserveTree({
    window: '无标题 - 记事本', pid: 4242, hwnd: 777, process_start_time: '2026-11-12T05:00:00.000Z',
    tree_complete: true, nodes_observed: nodes.length, nodes,
  }).tree;
}

test('P2-2: snapshot_id 形状与校验', () => {
  const a = newSnapshotId();
  const b = newSnapshotId();
  assert.match(a, /^s[0-9a-z]{4,}$/);
  assert.ok(a.length <= 64);
  assert.notEqual(a, b, '连续两次观察不应得到同一 snapshot_id');
  assert.equal(validateSnapshotId(a), true);
  for (const bad of ['ab', '', 'x'.repeat(65), 'has space', 'bad/char', null, undefined, 123]) {
    assert.equal(validateSnapshotId(bad), false, `应拒绝：${String(bad)}`);
  }
});

test('P2-2: RefMap 从 @e1 起自增，达 u32 上限抛 computer_internal', () => {
  const map = new RefMap();
  assert.equal(map.allocateValidated({ role: 'button' }), '@e1');
  assert.equal(map.allocateValidated({ role: 'button' }), '@e2');
  assert.equal(map.size, 2);
  assert.equal(map.get('@e2').role, 'button');

  const full = new RefMap();
  full.counter = MAX_REF_INDEX;
  assert.throws(() => full.allocateValidated({ role: 'button' }), (e) => e.code === 'computer_internal');
});

test('P2-2: resolveRefTarget 拒绝裸 @e8 与畸形 ref，接受 @<sid>:e<N>', () => {
  const sid = 's0abc';
  assert.deepEqual(resolveRefTarget(`@${sid}:e8`), { snapshotId: sid, index: 8 });
  assert.equal(qualifyRefId(sid, '@e8'), `@${sid}:e8`);

  const bad = ['@e8', 'e8', '', '@', '@:e1', `@${sid}`, `@${sid}:e`, `@${sid}:e0`, `@${sid}:e-1`,
    `@${sid}:e12345678901`, '@ab:e1', '@bad space:e1'];
  for (const ref of bad) {
    assert.throws(() => resolveRefTarget(ref), (e) => e.code === 'computer_invalid_args',
      `应拒绝：${ref}`);
  }
  // 错误信息必须含期望形状（便于模型自我纠正）
  assert.throws(() => resolveRefTarget('@e8'), /@<snapshot_id>:e<N>/);
});

test('P2-2: 18 项 role 全部可分配；只读/泛化动作不触发分配', () => {
  assert.equal(INTERACTIVE_ROLES.length, 18);
  for (const role of INTERACTIVE_ROLES) {
    assert.equal(isRefAble(role, []), true, `${role} 应可分配`);
  }
  assert.equal(isRefAble('unknown', []), false);
  assert.equal(isRefAble('unknown', ['SetFocus']), false, 'SetFocus 属 ubiquitous');
  assert.equal(isRefAble('unknown', ['SetFocus', 'RightClick', 'ScrollTo']), false, 'ubiquitous 不应触发分配');
  assert.equal(isRefAble('unknown', ['SetFocus', 'Click']), true, '出现 primary action 即可分配');
  assert.equal(isRefAble('unknown', null), false);
});

test('P2-2: allocateTreeRefs 按 role/动作分配，并回填 RefEntry 字段', () => {
  const tree = buildTree();
  const snapshotId = 's0abc';
  const { map, count } = allocateTreeRefs(tree, {
    snapshotId, revision: 7, grantId: 'g-1', generation: 3,
    identity: { pid: 4242, process_start_time: 't0', target_handle: 'th', hwnd: 777, window_bounds_hash: 'wh' },
  });

  assert.equal(count, 3, 'textfield + button + 带 Click 的 custom 共 3 个');
  assert.equal(tree.children[0].ref_id, '@e1');
  assert.equal(tree.children[1].ref_id, '', 'unknown 且无 primary action 不分配');
  assert.equal(tree.children[1].children[0].ref_id, '@e2');
  assert.equal(tree.children[1].children[1].ref_id, '@e3');

  const entry = map.get('@e2');
  assert.equal(entry.role, 'button');
  assert.equal(entry.native_id, 'SettingsButton');
  assert.equal(entry.unique_at_capture, true);
  assert.deepEqual(entry.path, [1, 0]);
  assert.equal(entry.path_is_absolute, true);
  assert.equal(entry.root_ref, '', '根 Window 不可分配 → root_ref 为空，不借用子节点');
  assert.equal(entry.pid, 4242);
  assert.equal(entry.hwnd, 777);
  assert.equal(entry.target_handle, 'th');
  assert.equal(entry.bounds_space, 'screen');
  assert.equal(entry.grant_id, 'g-1');
  assert.equal(entry.generation, 3);
  assert.equal(entry.snapshot_id, snapshotId);
  assert.equal(entry.revision, 7);
  assert.deepEqual(entry.available_actions, ['Click']);
});

test('P2-2: root_ref 指向根 ref（根可分配时），qualify 后全树带 snapshot 前缀', () => {
  const nodes = fixtureNodes();
  nodes[0].role_raw = 'ControlType.Button'; // 让根可分配
  const tree = buildTree(nodes);
  const snapshotId = 's0abc';
  const { map } = allocateTreeRefs(tree, { snapshotId, identity: { pid: 1 } });
  const rootRef = tree.ref_id;
  assert.equal(rootRef, '@e1');
  for (const entry of map.inner.values()) assert.equal(entry.root_ref, rootRef);

  qualifyTreeRefs(tree, snapshotId);
  assert.equal(tree.ref_id, `@${snapshotId}:e1`);
  const refs = [];
  (function walk(n) { if (n.ref_id) refs.push(n.ref_id); for (const c of n.children) walk(c); })(tree);
  assert.equal(refs.length, countRefs(tree));
  assert.equal(refsAreUnique(tree), true);
  for (const r of refs) assert.match(r, new RegExp(`^@${snapshotId}:e[0-9]+$`));
});

test('P2-2: ref_count 与树中 ref_id 数量可复算相等', () => {
  const tree = buildTree();
  const { count } = allocateTreeRefs(tree, { snapshotId: 's0abc' });
  assert.equal(count, countRefs(tree));
  assert.equal(refsAreUnique(tree), true);

  // 人为制造重复 ref → 唯一性检查必须发现
  tree.children[1].children[0].ref_id = tree.children[0].ref_id;
  assert.equal(refsAreUnique(tree), false);
});

test('P2-2: 序列化超 1MiB 抛 computer_internal 并提示 --root / max_depth', () => {
  const big = {
    role: 'button', name: 'x'.repeat(1024 * 1024 + 16), value: '', ref_id: '', available_actions: ['Click'],
    states: [], bounds: { x: 0, y: 0, w: 1, h: 1 }, bounds_hash: 'h', children: [], children_count: 0,
  };
  assert.throws(() => assertTreeSize(big), (e) => e.code === 'computer_internal' && /1MiB/.test(e.message) && /--root/.test(e.message));
  assert.ok(assertTreeSize(buildTree()) > 0);
});

test('P2-2: compact 模式折叠无 ref 的单子 wrapper，保留有 ref 的节点', () => {
  const nodes = fixtureNodes();
  // 在 Window 下插一个「无 ref 且只有一个子节点」的 Pane 包装
  const wrapped = buildTree(nodes);
  const tree = {
    role: 'unknown', name: 'root', value: '', ref_id: '', available_actions: [], states: [],
    bounds: { x: 0, y: 0, w: 1, h: 1 }, bounds_hash: 'h', children: [wrapped], children_count: 1,
  };
  const compacted = compactTree(tree);
  assert.equal(compacted.name, '无标题 - 记事本', '外层 wrapper 应被折叠掉，根换成原被包装的节点');
  assert.equal(compacted.children.length, 2, '折叠后被包装节点的子节点上提一层');
  assert.equal(compacted.children[0].role, 'textfield');

  // 有 ref 的节点即使只有一个子节点也不折叠（不被其子节点替代）
  const keep = { ...wrapped, ref_id: '@e9' };
  const holder = { ...tree, children: [keep] };
  const kept = compactTree(holder);
  assert.equal(kept.ref_id, '@e9');
  assert.equal(kept.children.length, 2, '有 ref 节点的子节点不应被上提替代它');
});
