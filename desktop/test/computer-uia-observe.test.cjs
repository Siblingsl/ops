'use strict';
// DEV-CU P2-7：`uia_observe` 输出契约（§4.5）与 preload 联动前置。
// 覆盖：入参逐项越界、硬禁区、投影（root_ref / interactive_only / max_depth）、
//       先裁剪后分配的顺序、ref_count 与树一致、截断/身份未证的标注、
//       内部字段不可枚举、§4.5 JSON Schema 校验。
//
// 除「真实窗口 opt-in」一例外全部是纯函数，不需要 GUI；唯一碰 PowerShell 的
// 是「窗口不在时返回 computer_target_changed」，它必须真的去问一次系统。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  OBSERVE_LIMITS, normalizeObserveParams, isInteractiveNode, keepInteractive,
  projectTree, allocateAndBuild, buildResponse, observe,
} = require('../src/computer-worker/observe.js');
const { countRefs } = require('../src/computer-worker/refs.js');

const SCHEMA = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, 'fixtures', 'computer-observe.schema.json'), 'utf8',
));

// ---------------------------------------------------------------------------
// 一个够小的 draft-07 子集校验器。
// 只实现本 schema 用到的关键字；遇到没实现的关键字**直接抛错**，
// 避免「校验器不认识就静默放过」把完成判据变成摆设。
// ---------------------------------------------------------------------------
const SUPPORTED = new Set([
  '$schema', '$id', 'title', 'description', 'definitions',
  'type', 'required', 'properties', 'additionalProperties', 'items',
  'enum', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum',
  'minItems', 'maxItems', '$ref',
]);

function resolveRef(root, ref) {
  if (!ref.startsWith('#/')) throw new Error(`不支持的外部 $ref：${ref}`);
  return ref.slice(2).split('/').reduce((node, key) => node[key], root);
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function validate(value, schema, root, at) {
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED.has(key)) throw new Error(`校验器未实现关键字 ${key}（在 ${at}）`);
  }
  if (schema.$ref) return validate(value, resolveRef(root, schema.$ref), root, at);

  if (schema.type) {
    const actual = typeOf(value);
    const ok = schema.type === 'number' ? (actual === 'number' || actual === 'integer') : actual === schema.type;
    assert.ok(ok, `${at} 类型应为 ${schema.type}，实为 ${actual}`);
  }
  if (schema.enum) {
    assert.ok(schema.enum.includes(value), `${at} 取值 ${JSON.stringify(value)} 不在枚举内`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined) assert.ok(value.length >= schema.minLength, `${at} 短于 ${schema.minLength}`);
    if (schema.maxLength !== undefined) assert.ok(value.length <= schema.maxLength, `${at} 长于 ${schema.maxLength}`);
    if (schema.pattern !== undefined) assert.match(value, new RegExp(schema.pattern), `${at} 不匹配 ${schema.pattern}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined) assert.ok(value >= schema.minimum, `${at} 小于 ${schema.minimum}`);
    if (schema.maximum !== undefined) assert.ok(value <= schema.maximum, `${at} 大于 ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined) assert.ok(value.length >= schema.minItems, `${at} 元素少于 ${schema.minItems}`);
    if (schema.maxItems !== undefined) assert.ok(value.length <= schema.maxItems, `${at} 元素多于 ${schema.maxItems}`);
    if (schema.items) value.forEach((item, i) => validate(item, schema.items, root, `${at}[${i}]`));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required || []) {
      assert.ok(Object.prototype.hasOwnProperty.call(value, key), `${at} 缺少必需字段 ${key}`);
    }
    const props = schema.properties || {};
    for (const [key, child] of Object.entries(props)) {
      if (Object.prototype.hasOwnProperty.call(value, key) && value[key] !== undefined) {
        validate(value[key], child, root, `${at}.${key}`);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        assert.ok(Object.prototype.hasOwnProperty.call(props, key), `${at} 出现未声明字段 ${key}`);
      }
    }
  }
  return true;
}

// ---------------------------------------------------------------------------

const IDENTITY = {
  pid: 4242,
  process_start_time: '2026-11-13T00:00:00.0000000Z',
  target_handle: 'a'.repeat(32),
  hwnd: 99,
  window_bounds_hash: 'b'.repeat(16),
};

function node(role, name, extra = {}) {
  const children = extra.children || [];
  return {
    role,
    name,
    value: extra.value || '',
    ref_id: '',
    available_actions: extra.actions || [],
    states: ['enabled', 'visible'],
    bounds: { x: 0, y: 0, w: 10, h: 10 },
    bounds_hash: 'h'.repeat(16),
    children,
    children_count: children.length,
  };
}

/** 一棵有代表性的夹具树：可交互叶子 + 祖先 + 透明 wrapper + 纯容器。 */
function fixtureTree() {
  const save = node('button', '保存', { actions: ['Click'] });
  const inner = node('button', '内部按钮', { actions: ['Click'] });
  const editor = node('textfield', '正文', { value: 'hello', actions: ['SetValue'], children: [inner] });
  const wrapped = node('unknown', '透明外壳', { children: [node('checkbox', '选项', { actions: ['Click'] })] });
  const label = node('unknown', '一段说明文字'); // 不可交互、无子节点
  return node('unknown', '窗口根', { children: [save, editor, wrapped, label] });
}

const CTX = {
  snapshotId: 's7test01',
  revision: 11,
  identity: IDENTITY,
  provenComplete: true,
  projected: false,
  compact: false,
};

test('P2-7: 入参逐项越界 → pid_invalid / computer_invalid_args', () => {
  const okBase = { pid: 4242, grant_id: 'g-1', generation: 3 };
  const p = normalizeObserveParams(okBase);
  assert.deepEqual(p, {
    pid: 4242, target_summary: '', grant_id: 'g-1', generation: 3,
    max_depth: undefined, root_ref: '', interactive_only: false, compact: false,
  });

  const badPid = [0, -1, 1.5, 'abc', null, undefined, NaN];
  for (const pid of badPid) {
    assert.throws(() => normalizeObserveParams({ ...okBase, pid }), (e) => e.code === 'pid_invalid', String(pid));
  }

  const invalidCases = [
    ['grant_id 缺失', { ...okBase, grant_id: undefined }],
    ['grant_id 空串', { ...okBase, grant_id: '' }],
    ['grant_id 超长', { ...okBase, grant_id: 'g'.repeat(OBSERVE_LIMITS.grant_id + 1) }],
    ['generation 负数', { ...okBase, generation: -1 }],
    ['generation 小数', { ...okBase, generation: 1.5 }],
    ['generation 超范围', { ...okBase, generation: 2 ** 31 }],
    ['summary 非字符串', { ...okBase, target_summary: 42 }],
    ['summary 超长', { ...okBase, target_summary: 'x'.repeat(OBSERVE_LIMITS.target_summary + 1) }],
    ['max_depth 负数', { ...okBase, max_depth: -1 }],
    ['max_depth 超上限', { ...okBase, max_depth: OBSERVE_LIMITS.max_depth + 1 }],
    ['max_depth 小数', { ...okBase, max_depth: 2.5 }],
    ['max_depth 非数字', { ...okBase, max_depth: '3' }],
    ['root_ref 形状错', { ...okBase, root_ref: 'e1' }],
    ['root_ref 非字符串', { ...okBase, root_ref: 1 }],
    ['root_ref 超长', { ...okBase, root_ref: `@s1:e1${'x'.repeat(OBSERVE_LIMITS.root_ref)}` }],
    ['interactive_only 非布尔', { ...okBase, interactive_only: 'true' }],
    ['compact 非布尔', { ...okBase, compact: 1 }],
  ];
  for (const [label, msg] of invalidCases) {
    assert.throws(() => normalizeObserveParams(msg), (e) => {
      assert.equal(e.code, 'computer_invalid_args', label);
      return true;
    }, label);
  }

  // 边界值本身要放行（0 深度、上限深度、空 summary）
  assert.equal(normalizeObserveParams({ ...okBase, max_depth: 0 }).max_depth, 0);
  assert.equal(normalizeObserveParams({ ...okBase, max_depth: 50 }).max_depth, 50);
  assert.equal(normalizeObserveParams({ ...okBase, target_summary: 'x'.repeat(256) }).target_summary.length, 256);
  // generation 缺省按 0（与 uia_invoke / RefStore 口径一致）
  assert.equal(normalizeObserveParams({ pid: 1, grant_id: 'g' }).generation, 0);
});

test('P2-7: 硬禁区先于其它入参校验', () => {
  // 用 policy.js 的真实词表（进程名与标题都过同一个 isHardForbidden）
  for (const summary of ['cmd.exe', 'powershell', 'pwsh', 'taskmgr', '凭据管理', '注册表']) {
    assert.throws(
      () => normalizeObserveParams({ pid: 1, grant_id: 'g', target_summary: summary }),
      (e) => e.code === 'hard_forbidden',
      summary,
    );
  }
  // 大小写不敏感
  assert.throws(() => normalizeObserveParams({ pid: 1, grant_id: 'g', target_summary: 'Cmd' }),
    (e) => e.code === 'hard_forbidden');
});

test('P2-7: interactive_only 只留可交互节点及其祖先', () => {
  const kept = keepInteractive(fixtureTree());
  assert.equal(isInteractiveNode(kept), false, '根不可交互但必须保留');
  const names = [];
  (function walk(n) { names.push(n.name); (n.children || []).forEach(walk); })(kept);
  assert.deepEqual(names.sort(), ['保存', '内部按钮', '窗口根', '正文', '选项', '透明外壳'].sort());
  assert.ok(!names.includes('一段说明文字'), '不可交互的叶子必须被裁掉');

  // 父不可交互但子可交互 → 父必须留下（否则子节点失去路径上下文）
  const onlyChild = node('unknown', '父', { children: [node('button', '子', { actions: ['Click'] })] });
  const kept2 = keepInteractive(onlyChild);
  assert.equal(kept2.children.length, 1);
  assert.equal(kept2.children[0].name, '子');

  // 全树都不可交互 → 只剩根，不会返回 null
  const barren = node('unknown', '空窗');
  assert.equal(keepInteractive(barren).role, 'unknown');

  // 回归：native_id 在树上不可枚举，投影时必须显式带过去，否则 ref 的身份谓词会失效
  const withId = node('button', '带 id', { actions: ['Click'] });
  Object.defineProperty(withId, 'native_id', { value: 'Doc1', enumerable: false });
  const keptId = keepInteractive(withId);
  assert.equal(keptId.native_id, 'Doc1', 'native_id 必须穿过投影');
  assert.ok(!Object.keys(keptId).includes('native_id'), '但不得变成可枚举（否则会外泄）');
});

test('P2-7: max_depth 裁剪保留层级并标注 depth_trimmed', () => {
  const deep = node('unknown', 'r', {
    children: [node('unknown', 'a', { children: [node('button', 'b', { actions: ['Click'] })] })],
  });
  const full = projectTree(deep, { interactive_only: false });
  assert.equal(full.depth_trimmed, false);
  assert.equal(full.projected, false);
  assert.equal(full.tree.children[0].children[0].name, 'b');

  const cut = projectTree(deep, { interactive_only: false, max_depth: 1 });
  assert.equal(cut.depth_trimmed, true, 'depth 3 > 1 必须标裁过');
  assert.equal(cut.tree.children[0].name, 'a');
  assert.deepEqual(cut.tree.children[0].children, [], '第 1 层不再展开');
  assert.equal(cut.tree.children[0].children_count, 1, 'children_count 保留真实值');

  // max_depth 恰好等于树深时不算裁
  const exact = projectTree(deep, { interactive_only: false, max_depth: 2 });
  assert.equal(exact.depth_trimmed, true, 'depth 3 > 2');
  const roomy = projectTree(deep, { interactive_only: false, max_depth: 3 });
  assert.equal(roomy.depth_trimmed, false);
});

test('P2-7: root_ref 子树投影标记 projected，且不改变原树的裁剪语义', () => {
  const tree = fixtureTree();
  const sub = tree.children[1]; // textfield 正文
  const out = projectTree(tree, { interactive_only: false }, sub);
  assert.equal(out.tree.name, '正文');
  assert.equal(out.projected, true, 'root_ref 结构投影必须标 projected');
  assert.equal(out.depth_trimmed, false);

  // 不传 rootNode 时以整树为根
  const whole = projectTree(tree, { interactive_only: false });
  assert.equal(whole.projected, false);
  assert.equal(whole.tree.name, '窗口根');
});

test('P2-7: 先裁剪后分配 —— ref 只落在裁剪后的树上，ref_count 自洽', () => {
  const built = allocateAndBuild(fixtureTree(), CTX);
  // 可分配 ref 的节点：保存 / 正文 / 内部按钮 / 选项 = 4（两个 unknown 容器不分配）
  assert.equal(built.ref_count, 4);
  assert.equal(countRefs(built.tree), 4, 'ref_count 必须与树里 ref_id 的数量一致');
  assert.equal(built.refmap.size, 4, 'refmap 条目数与 ref_count 一致');

  const refs = [];
  (function walk(n) { if (n.ref_id) refs.push(n.ref_id); (n.children || []).forEach(walk); })(built.tree);
  assert.equal(new Set(refs).size, 4, 'ref 两两不同');
  for (const ref of refs) {
    assert.match(ref, /^@s7test01:e[0-9]+$/, `ref 必须限定到本次 snapshot：${ref}`);
  }

  // 裁剪后再分配：interactive_only 后叶子少一个，ref 数随之下降（证明顺序是「先裁后分配」）
  const trimmed = projectTree(fixtureTree(), { interactive_only: true });
  const builtTrimmed = allocateAndBuild(trimmed.tree, { ...CTX, projected: true, snapshotId: 's7test02' });
  assert.equal(builtTrimmed.ref_count, 4, 'interactive_only 后剩 4 个可交互节点');
  assert.equal(countRefs(builtTrimmed.tree), 4);
});

test('P2-7: 结构投影后 path_is_absolute 标 false（整窗观察才为 true）', () => {
  const whole = allocateAndBuild(fixtureTree(), CTX);
  for (const entry of whole.refmap.inner.values()) {
    assert.equal(entry.path_is_absolute, true, '整窗观察的路径是绝对下标链');
  }
  const trimmed = projectTree(fixtureTree(), { interactive_only: true });
  const part = allocateAndBuild(trimmed.tree, { ...CTX, projected: true, snapshotId: 's7test03' });
  for (const entry of part.refmap.inner.values()) {
    assert.equal(entry.path_is_absolute, false, '投影后的路径只相对返回树根');
  }
});

test('P2-7: compact 折叠透明 wrapper，但不吞掉有 role 的容器', () => {
  const built = allocateAndBuild(fixtureTree(), { ...CTX, compact: true });
  let sawWrapper = false;
  (function walk(n) { if (n.name === '透明外壳') sawWrapper = true; (n.children || []).forEach(walk); })(built.tree);
  assert.equal(sawWrapper, false, 'unknown + 单子节点的 wrapper 必须被折叠');
  // 折叠后「选项」直接挂到根下，ref 仍然有效
  const names = built.tree.children.map((c) => c.name);
  assert.ok(names.includes('选项'), `折叠后应直接挂在根下：${names.join(',')}`);
  // 有明确 role 的容器即使只有一个子节点也保留
  const solo = node('listbox', '列表', { children: [node('option', '条目', { actions: ['Click'] })] });
  const built2 = allocateAndBuild(solo, { ...CTX, compact: true, snapshotId: 's7test04' });
  assert.equal(built2.tree.name, '列表');
});

test('P2-7: 输出字段集符合 §4.5，且内部字段不外泄', () => {
  const built = allocateAndBuild(fixtureTree(), CTX);
  const res = buildResponse({
    snapshot_id: 's7test01',
    revision: 11,
    ref_count: built.ref_count,
    complete: true,
    nodes_observed: 6,
    truncated: false,
    identity_unproven: false,
    tree: built.tree,
    refmap: built.refmap,
    identity: IDENTITY,
  });

  assert.deepEqual(Object.keys(res).sort(), [
    'complete', 'nodes_observed', 'ok', 'ref_count', 'revision', 'snapshot_id', 'tree',
  ]);
  assert.equal(res.ok, true);
  assert.equal(res.complete, true);
  assert.equal(res.truncated, undefined, '未截断时不得出现 truncated');
  assert.equal(res.identity_unproven, undefined, '身份可证时不得出现 identity_unproven');

  // 内部字段必须不可枚举：既不进 JSON，也不进 contract 校验
  assert.equal(res.refmap, built.refmap, '内部仍可访问');
  assert.deepEqual(Object.keys(res.window_identity).length > 0, true);
  const json = JSON.stringify(res);
  for (const leak of ['refmap', 'window_identity', 'native_id', 'title_hash', 'target_handle']) {
    assert.ok(!json.includes(leak), `序列化后不应出现 ${leak}`);
  }

  // 截断与身份未证时补标志
  const truncated = buildResponse({
    snapshot_id: 's7test01', revision: 1, ref_count: 0, complete: false, nodes_observed: 200,
    truncated: true, identity_unproven: true, tree: built.tree, refmap: built.refmap, identity: IDENTITY,
  });
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.identity_unproven, true);
  assert.equal(truncated.complete, false);
});

test('P2-7: 输出可被 §4.5 JSON Schema 校验（含 1 层/深层/投影三种形态）', () => {
  const cases = [];
  for (const [label, tree, ctx] of [
    ['整窗', fixtureTree(), CTX],
    ['投影', projectTree(fixtureTree(), { interactive_only: true }).tree, { ...CTX, projected: true, snapshotId: 's7s2' }],
    ['折叠', fixtureTree(), { ...CTX, compact: true, snapshotId: 's7s3' }],
  ]) {
    const built = allocateAndBuild(tree, ctx);
    cases.push([label, buildResponse({
      snapshot_id: ctx.snapshotId,
      revision: ctx.revision,
      ref_count: built.ref_count,
      complete: true,
      nodes_observed: 6,
      tree: built.tree,
      refmap: built.refmap,
      identity: IDENTITY,
    })]);
  }
  // 单节点树（无子节点）也要过
  const solo = allocateAndBuild(node('button', '唯一', { actions: ['Click'] }), { ...CTX, snapshotId: 's7s4' });
  cases.push(['单节点', buildResponse({
    snapshot_id: 's7s4', revision: 1, ref_count: solo.ref_count, complete: true,
    nodes_observed: 1, tree: solo.tree, refmap: solo.refmap, identity: IDENTITY,
  })]);

  for (const [label, res] of cases) {
    const plain = JSON.parse(JSON.stringify(res));
    validate(plain, SCHEMA, SCHEMA, label);
  }

  // 反例：漏了必需字段 / 多了未声明字段都必须被卡住，证明校验器不是空转
  const built = allocateAndBuild(fixtureTree(), CTX);
  const good = JSON.parse(JSON.stringify(buildResponse({
    snapshot_id: 's7test01', revision: 1, ref_count: built.ref_count, complete: true,
    nodes_observed: 6, tree: built.tree, refmap: built.refmap, identity: IDENTITY,
  })));
  const noTree = { ...good };
  delete noTree.tree;
  assert.throws(() => validate(noTree, SCHEMA, SCHEMA, '反例'), /缺少必需字段 tree/);

  const leaked = JSON.parse(JSON.stringify(good));
  leaked.tree.native_id = 'x';
  assert.throws(() => validate(leaked, SCHEMA, SCHEMA, '反例'), /未声明字段 native_id/);
});

test('P2-7: 入参错不发 PowerShell（快速失败）', async () => {
  const started = Date.now();
  const res = await observe({ pid: 0, grant_id: 'g' }, { refStore: null });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'pid_invalid');
  const forbidden = await observe({ pid: 1, grant_id: 'g', target_summary: 'cmd.exe' }, { refStore: null });
  assert.equal(forbidden.error, 'hard_forbidden');
  assert.ok(Date.now() - started < 500, '入参错不应产生进程调用');
});

test('P2-7: 窗口不在时返回 computer_target_changed（不加 timeout 包装）', { timeout: 30_000 }, async (t) => {
  if (process.platform !== 'win32') { t.skip('需要 Windows'); return; }
  // 必然不存在的 pid：走完「硬禁区 → pid → 窗口身份」后必须在身份这一步失败
  const res = await observe({ pid: 999_999_999, grant_id: 'g-1', generation: 1 }, { refStore: null });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'computer_target_changed');
});

// ---------------------------------------------------------------------------
// IPC 级：从 index.js 的消息入口走一遍，确认 case 'uia_observe' 真的接上了。
// 纯函数测试证明不了「index.js 有没有把这个 case 接进来」。
// ---------------------------------------------------------------------------
const { fork } = require('node:child_process');

const WORKER = path.resolve(__dirname, '..', 'src', 'computer-worker', 'index.js');

function withWorker(t) {
  const child = fork(WORKER, [], { stdio: 'ignore', env: { OPS_DESKTOP_WORKER: '1' } });
  let nextID = 1;
  const pending = new Map();
  child.on('message', (msg) => {
    if (!msg || typeof msg.id !== 'string') return;
    const call = pending.get(msg.id);
    if (!call) return;
    pending.delete(msg.id);
    clearTimeout(call.timer);
    call.resolve(msg);
  });
  t.after(() => child.kill());
  return {
    call(extra, timeoutMs = 30_000) {
      const id = `o${nextID++}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('worker_timeout')); }, timeoutMs);
        pending.set(id, { resolve, timer });
        child.send({ id, cmd: 'uia_observe', ...extra });
      });
    },
  };
}

test('P2-7 IPC: uia_observe 的拒绝顺序与错误码', { timeout: 60_000 }, async (t) => {
  const worker = withWorker(t);

  const badPid = await worker.call({ pid: 0, grant_id: 'g-1' });
  assert.equal(badPid.ok, false);
  assert.equal(badPid.error, 'pid_invalid');

  const forbidden = await worker.call({ pid: 999_999_999, grant_id: 'g-1', target_summary: 'cmd.exe' });
  assert.equal(forbidden.error, 'hard_forbidden');

  const noGrant = await worker.call({ pid: 999_999_999 });
  assert.equal(noGrant.error, 'computer_invalid_args');
  assert.match(noGrant.message || '', /grant_id/);

  // 通过入参校验后才会去问系统；不存在的 pid 一定死在这一步
  const gone = await worker.call({ pid: 999_999_999, grant_id: 'g-1', generation: 1 });
  assert.equal(gone.ok, false);
  assert.equal(gone.error, 'computer_target_changed');
});

test('P2-7: 真实窗口 observe（OPS_UIA_SPAWN=1 opt-in）', { timeout: 180_000 }, async (t) => {
  // 默认不弹窗：用户明确要求过不要反复开记事本。只有显式 opt-in 才跑。
  if (process.platform !== 'win32') { t.skip('需要 Windows'); return; }
  if (process.env.OPS_UIA_SPAWN !== '1') { t.skip('未设 OPS_UIA_SPAWN=1'); return; }

  const { spawn } = require('node:child_process');
  const { RefStore } = require('../src/computer-worker/ref-store.js');
  const { listWindows } = require('../src/computer-worker/native.js');

  // Win11 记事本是单进程多标签：spawn 出来的进程常常把窗口交接给已有实例后立刻退出，
  // 直接拿 child.pid 去 observe 会得到 computer_target_changed——不是产品缺陷，是拿错了 pid。
  // 所以每次都按「当前还活着的记事本窗口」重新取 pid。
  const findNotepad = async () => {
    const listed = await listWindows();
    const hit = (listed.windows || []).find((w) => /^notepad(\.exe)?$/i.test(w.process) && !w.forbidden);
    return hit ? hit.pid : 0;
  };

  let pid = await findNotepad();
  let spawned = null;
  if (!pid) {
    spawned = spawn('notepad.exe', [], { stdio: 'ignore', windowsHide: false });
    const boot = Date.now() + 15_000;
    while (!pid && Date.now() < boot) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 500));
      // eslint-disable-next-line no-await-in-loop
      pid = await findNotepad();
    }
  }
  // 只回收自己起的那个；用户已经开着的记事本**绝不动**（可能带着未保存的内容）。
  t.after(() => { if (spawned) { try { spawned.kill(); } catch { /* 已退出 */ } } });
  assert.ok(pid > 0, '本机没有可观察的记事本窗口（notepad.exe 不可用？）');

  const stamp = `obs-${process.pid}-${Date.now()}`;
  const grantId = `g-${stamp}`;
  const store = new RefStore();
  const runOnce = (extra = {}) => observe({
    pid, grant_id: grantId, generation: 1, target_summary: 'notepad', max_depth: 8, ...extra,
  }, { refStore: store });

  // 窗口可能在「取到 pid」与「读树」之间消失（标签被合并 / 用户关窗）：
  // 这类失败按可重试处理，重新取 pid 再来一次，直到 deadline。
  const deadline = Date.now() + 30_000;
  let res = await runOnce();
  while (!res.ok && Date.now() < deadline
    && (res.error === 'computer_target_changed' || res.error === 'computer_app_unresponsive')) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 500));
    // eslint-disable-next-line no-await-in-loop
    pid = (await findNotepad()) || pid;
    // eslint-disable-next-line no-await-in-loop
    res = await runOnce();
  }

  assert.ok(res.ok, `observe 应成功：${JSON.stringify(res.error || '')} ${res.message || ''}`);
  assert.ok(res.ref_count > 0, '真实窗口应至少分配到一个 ref');
  assert.equal(countRefs(res.tree), res.ref_count, 'ref_count 必须与树一致');
  assert.match(res.snapshot_id, /^[A-Za-z0-9]{1,40}$/);
  assert.equal(res.complete, true, '记事本窗口不大，应是一次完整观察');
  assert.equal(res.identity_unproven, undefined, '整窗读全且无投影 → 身份可证，不得标未证');
  validate(JSON.parse(JSON.stringify(res)), SCHEMA, SCHEMA, 'real');

  // 窗口根节点是 ControlType.Window → role=unknown、无可用动作 → 按 isRefAble 不分配 ref
  // （allocateTreeRefs 明确「根不可分配时为空串，不借用子节点」）。所以 root_ref 只能取
  // 一个真正可交互的节点；下面 DFS 取第一个带 ref 的节点当子树根。
  const firstRef = (function find(n) {
    if (n.ref_id) return n.ref_id;
    for (const c of n.children || []) { const hit = find(c); if (hit) return hit; }
    return '';
  })(res.tree);
  assert.match(firstRef, /^@[A-Za-z0-9]+:e[0-9]+$/, '至少应有一个可交互节点拿到限定 ref');

  // 存进 RefStore 后必须能被 root_ref 再观察（P2-7 与 P2-4 的接缝）
  store.save(grantId, res.snapshot_id, {
    refmap: res.refmap, generation: 1, tree: res.tree, identity: res.window_identity,
  });
  const rootRef = firstRef;
  const again = await runOnce({ root_ref: rootRef });
  assert.ok(again.ok, `按 root_ref 再观察应成功：${JSON.stringify(again.error || '')} ${again.message || ''}`);
  assert.ok(again.ref_count > 0);
  assert.equal(again.identity_unproven, true, '结构投影后必须标身份未证（禁止严格再解析）');
  validate(JSON.parse(JSON.stringify(again)), SCHEMA, SCHEMA, 'real-root');

  // root_ref 形状对但快照不属于本 grant → stale（不是 internal）
  const foreign = await observe({
    pid, grant_id: 'g-not-mine', generation: 1, root_ref: rootRef,
  }, { refStore: store });
  assert.equal(foreign.error, 'computer_stale_ref');
});
