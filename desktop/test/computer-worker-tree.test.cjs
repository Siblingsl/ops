'use strict';
// DEV-CU P2-1：观察树归一化与裁剪的单测（不需要真实桌面）。
// 覆盖规格 §P2-1 的判据：父子保留、深度裁剪、complete 计算、nodes_observed 不受裁剪影响；
// 另加 role 白名单、bounds 归一化与 hash 稳定性、兼容视图四键、失效节点丢弃。

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  INTERACTIVE_ROLES,
  roleFor,
  roundRect,
  boundsHash,
  buildObserveTree,
  projectWindow,
  projectPartial,
} = require('../src/computer-worker/tree.js');

/** 3 层夹具：Window → (Document, Pane → Text, Button)。 */
function fixture(overrides = {}) {
  return {
    window: '无标题 - 记事本',
    pid: 4242,
    hwnd: 777,
    process_start_time: '2026-11-12T05:00:00.000Z',
    tree_complete: true,
    nodes_observed: 5,
    nodes: [
      { parent: -1, role_raw: 'ControlType.Window', name: '无标题 - 记事本', id: '', value: '', enabled: true, offscreen: false, bounds: { x: 100, y: 100, w: 800, h: 600 }, has_value: false, has_invoke: false, children_count: 3 },
      { parent: 0, role_raw: 'ControlType.Document', name: '文本编辑器', id: '', value: 'hello', enabled: true, offscreen: false, bounds: { x: 108.6, y: 160.4, w: 780.2, h: 520 }, has_value: true, has_invoke: false, children_count: 0 },
      { parent: 0, role_raw: 'ControlType.Pane', name: '', id: 'StatusBar', value: '', enabled: true, offscreen: false, bounds: { x: 100, y: 660, w: 800, h: 24 }, has_value: false, has_invoke: false, children_count: 1 },
      { parent: 2, role_raw: 'ControlType.Text', name: '行 1，列 1', id: 'ContentTextBlock', value: '', enabled: true, offscreen: false, bounds: { x: 108, y: 662, w: 200, h: 18 }, has_value: false, has_invoke: false, children_count: 0 },
      { parent: 0, role_raw: 'ControlType.Button', name: '设置', id: 'SettingsButton', value: '', enabled: true, offscreen: false, bounds: { x: 860, y: 108, w: 32, h: 32 }, has_value: false, has_invoke: true, children_count: 0 },
    ],
    ...overrides,
  };
}

test('P2-1: 18 项 role 白名单唯一，且不含 ControlType 前缀', () => {
  assert.equal(INTERACTIVE_ROLES.length, 18);
  assert.equal(new Set(INTERACTIVE_ROLES).size, 18);
  for (const r of INTERACTIVE_ROLES) {
    assert.equal(typeof r, 'string');
    assert.ok(r.length > 0);
    assert.ok(!r.startsWith('ControlType.'), `role 不应带前缀：${r}`);
  }
});

test('P2-1: ControlType → role 映射，未知一律 unknown（不直传）', () => {
  assert.equal(roleFor('ControlType.Button'), 'button');
  assert.equal(roleFor('ControlType.CheckBox'), 'checkbox');
  // 新版记事本编辑区是 Document；Edit 与 Document 都要落到 textfield
  assert.equal(roleFor('ControlType.Document'), 'textfield');
  assert.equal(roleFor('ControlType.Edit'), 'textfield');
  assert.equal(roleFor('ControlType.Pane'), 'unknown');
  assert.equal(roleFor(''), 'unknown');
  assert.equal(roleFor('ControlType.SomethingCustom'), 'unknown');
});

test('P2-1: 夹具三层树保留父子关系，children_count 原样', () => {
  const { tree } = buildObserveTree(fixture());
  assert.equal(tree.role, 'unknown'); // Window 不在 18 项里
  assert.equal(tree.children.length, 3);
  assert.equal(tree.children_count, 3);

  const editor = tree.children[0];
  assert.equal(editor.role, 'textfield', 'Document 应归一化为 textfield');
  assert.equal(editor.value, 'hello');
  assert.deepEqual(editor.available_actions, ['SetValue']);
  assert.deepEqual(editor.states, ['enabled', 'visible']);

  const pane = tree.children[1];
  assert.equal(pane.role, 'unknown');
  assert.equal(pane.children.length, 1, '第三层必须挂回 Pane 下');
  assert.equal(pane.children[0].role, 'unknown');
  assert.equal(pane.children[0].name, '行 1，列 1');

  const button = tree.children[2];
  assert.equal(button.role, 'button');
  assert.deepEqual(button.available_actions, ['Click']);
});

test('P2-1: projectWindow 按深度裁剪，裁掉层级的 children_count 仍保留', () => {
  const { tree } = buildObserveTree(fixture());
  const d1 = projectWindow(tree, 1);
  assert.equal(d1.children.length, 3);
  for (const c of d1.children) assert.deepEqual(c.children, [], 'depth=1 时孙节点应被裁掉');
  assert.equal(d1.children[1].children_count, 1, 'children_count 是真实值，不随裁剪改动');

  const d0 = projectWindow(tree, 0);
  assert.deepEqual(d0.children, []);
  assert.equal(d0.children_count, 3);

  const full = projectPartial(tree);
  assert.equal(full.children[1].children.length, 1, 'projectPartial 不裁剪');
  assert.notEqual(full, tree, '应返回深拷贝，不共享引用');
});

test('P2-1: complete 与 nodes_observed 均来自原始观测，不受裁剪影响', () => {
  const okBuilt = buildObserveTree(fixture());
  assert.equal(okBuilt.complete, true);
  assert.equal(okBuilt.nodes_observed, 5);

  const cutBuilt = buildObserveTree(fixture({ tree_complete: false, nodes_observed: 200 }));
  assert.equal(cutBuilt.complete, false);
  assert.equal(cutBuilt.nodes_observed, 200, 'nodes_observed 是观测总数，不是裁剪后节点数');

  const pruned = projectWindow(cutBuilt.tree, 0);
  assert.equal(pruned.children.length, 0);
  assert.equal(cutBuilt.nodes_observed, 200, '裁剪不得回写 nodes_observed');
});

test('P2-1: bounds 四舍五入为整数，hash 稳定且随几何变化', () => {
  const { tree } = buildObserveTree(fixture());
  const editor = tree.children[0];
  assert.deepEqual(editor.bounds, { x: 109, y: 160, w: 780, h: 520 });
  assert.equal(editor.bounds_hash, boundsHash(editor.bounds));
  assert.equal(editor.bounds_hash, boundsHash({ x: 108.6, y: 160.4, w: 780.2, h: 520 }), '同几何应得同一 hash');
  assert.notEqual(editor.bounds_hash, boundsHash({ x: 110, y: 160, w: 780, h: 520 }));
  assert.deepEqual(roundRect({ x: NaN, y: Infinity, w: -5, h: undefined }), { x: 0, y: 0, w: 0, h: 0 });
});

test('P2-1: 兼容视图 controls 为四键、type 带前缀并按上限裁剪', () => {
  const longName = 'n'.repeat(600);
  const longValue = 'v'.repeat(5000);
  const raw = fixture();
  raw.nodes[1].name = longName;
  raw.nodes[1].value = longValue;
  const { controls } = buildObserveTree(raw);

  assert.equal(controls.length, 5);
  for (const c of controls) {
    assert.deepEqual(Object.keys(c).sort(), ['id', 'name', 'type', 'value']);
    assert.ok(c.type.startsWith('ControlType.'), `type 应带 ControlType. 前缀：${c.type}`);
    assert.ok(c.type.length <= 60);
    assert.ok(c.name.length <= 500);
    assert.ok(c.value.length <= 4000);
  }
  assert.equal(controls[1].name.length, 500);
  assert.equal(controls[1].value.length, 4000);
});

test('P2-1: window_identity 五字段，且不带进程路径/窗口标题', () => {
  const { window_identity } = buildObserveTree(fixture());
  assert.deepEqual(Object.keys(window_identity).sort(), ['hwnd', 'pid', 'process_start_time', 'target_handle', 'window_bounds_hash']);
  assert.equal(window_identity.pid, 4242);
  assert.equal(window_identity.hwnd, 777);
  assert.equal(window_identity.target_handle, 777);
  const serialized = JSON.stringify(window_identity);
  assert.ok(!serialized.includes('无标题'), 'identity 不应含窗口标题');
  assert.ok(!/process_path|exe_path/i.test(serialized), 'identity 不应含进程路径');
});

test('P2-1: 失效节点被丢弃，其子节点由上层接回（不断链）', () => {
  // PowerShell 侧失效节点不产出，并把 childParent 提升为最近的有效祖先；
  // 这里按同样口径构造：Pane（原 index 2）缺失后，Text 的 parent 直接指向 0。
  const raw = fixture();
  const nodes = raw.nodes.filter((_, i) => i !== 2);
  nodes[2].parent = 0; // 原 Text 节点接回 Window
  const built = buildObserveTree({ ...raw, nodes, nodes_observed: raw.nodes.length });

  assert.equal(built.tree.children.length, 3);
  assert.equal(built.tree.children[1].name, '行 1，列 1', '失效层级的子节点应挂到祖父下');
  assert.equal(built.controls.length, 4, '失效节点不进入兼容视图');

  // 防御：parent 指向不存在的下标（数据不自洽）时整支丢弃，不产出悬挂节点。
  const orphan = buildObserveTree({ ...raw, nodes: [
    raw.nodes[0],
    { ...raw.nodes[1], parent: 99 },
  ] });
  assert.equal(orphan.tree.children.length, 0);
});
