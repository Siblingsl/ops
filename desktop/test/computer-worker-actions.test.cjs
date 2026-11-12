'use strict';
// DEV-CU P3-1：动作枚举与派发（备料版）。
// 覆盖：14 项枚举锁表、枚举外拒绝、静态命令表（无字符串拼接）、
//       文本转义（单引号翻倍 / 不插值）、32768 截断、目标字段黑名单、
//       ref 与 snapshot/grant/generation 绑定、旧 automation_id 开关。

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { fork } = require('node:child_process');

const {
  WORKER_ACTIONS, TEXT_ACTIONS, VALUE_LIMIT, FORBIDDEN_TARGET_KEYS, ACTION_COMMAND,
  isAction, assertAction, inferAction, normalizeTarget, normalizeArgs, dispatch, legacyTargetAllowed,
} = require('../src/computer-worker/actions.js');

const REF = '@s1abc:e3';
const TARGET = { ref: REF, grant_id: 'g-1', generation: 7 };
const EXPECTED = { snapshot_id: 's1abc', grant_id: 'g-1', generation: 7 };

test('P3-1: WORKER_ACTIONS 14 项逐字锁表（顺序也是契约）', () => {
  assert.deepEqual(WORKER_ACTIONS, [
    'observe', 'set_focus', 'scroll', 'scroll_to', 'select',
    'click', 'toggle', 'expand', 'collapse', 'check', 'uncheck',
    'set_value', 'type_text', 'clear',
  ]);
  assert.equal(WORKER_ACTIONS.length, 14);
  assert.equal(new Set(WORKER_ACTIONS).size, 14, '不得有重复项');
  for (const action of WORKER_ACTIONS) assert.equal(isAction(action), true, `${action} 应被识别`);

  for (const bad of ['launch', 'Click', '', 'click ', '@e1', null, undefined, 0, {}]) {
    assert.equal(isAction(bad), false, `${String(bad)} 不应被识别`);
  }
});

test('P3-1: 枚举外动作 → computer_action_not_supported', () => {
  for (const bad of ['tap', 'Click', '', undefined]) {
    assert.throws(() => assertAction(bad), (e) => {
      assert.equal(e.code, 'computer_action_not_supported');
      assert.doesNotMatch(e.message, /undefined/, '报错不要把 undefined 当成动作名糊出去');
      return true;
    });
  }
  assert.equal(assertAction('click'), 'click');
});

test('P3-1: 静态命令表全覆盖且无拼接', () => {
  assert.deepEqual(Object.keys(ACTION_COMMAND).sort(), WORKER_ACTIONS.slice().sort());
  const commands = Object.values(ACTION_COMMAND);
  assert.equal(new Set(commands).size, commands.length, '命令名不得重复');
  for (const cmd of commands) assert.match(cmd, /^UIA_[A-Z_]+$/, `${cmd} 应是固定常量`);

  for (const action of WORKER_ACTIONS) {
    const plan = dispatch(action, TARGET, {}, EXPECTED);
    assert.equal(plan.command, ACTION_COMMAND[action]);
    assert.equal(plan.mechanism, 'semantic_api', '不得出现物理投递分支');
    assert.equal(plan.ok, true);
  }
});

test('P3-1: 用户文本经单引号转义，$ 与反引号不插值', () => {
  const cases = [
    "it's",
    "a'; Remove-Item -Recurse -Force C:\\; '",
    '$(Get-Process)',
    '`whoami`',
    'a"b',
    'line1\nline2',
    '引号‘中文’',
  ];
  for (const raw of cases) {
    const plan = dispatch('set_value', TARGET, { value: raw }, EXPECTED);
    const quoted = plan.args.value_ps;
    assert.equal(plan.args.value, raw, '原始值不被改写（除截断）');
    assert.ok(quoted.startsWith("'") && quoted.endsWith("'"), `应整体加单引号：${quoted}`);
    // 单引号必须成对出现：去掉所有 '' 后，内部不得再残留裸单引号
    const inner = quoted.slice(1, -1).split("''").join('');
    assert.ok(!inner.includes("'"), `内部仍有裸单引号，可能被注入：${quoted}`);
  }
  // 具体形态：a'b → 'a''b'
  assert.equal(dispatch('set_value', TARGET, { value: "a'b" }, EXPECTED).args.value_ps, "'a''b'");
});

test('P3-1: value 截断到 32768（与既有 ipc 行为一致）', () => {
  assert.equal(VALUE_LIMIT, 32768);
  const long = 'a'.repeat(40000);
  const plan = dispatch('type_text', TARGET, { value: long }, EXPECTED);
  assert.equal(plan.args.value.length, 32768);
  assert.equal(plan.args.value_ps.length, 32768 + 2, '截断后才加引号');
  // 多字节字符按 UTF-16 单元截断，长度仍受上限约束，且不抛
  const emoji = '🙂'.repeat(20000);
  const cut = dispatch('type_text', TARGET, { value: emoji }, EXPECTED);
  assert.ok(cut.args.value.length <= 32768);
  // 缺省值按空串处理
  assert.equal(dispatch('set_value', TARGET, {}, EXPECTED).args.value, '');
  assert.equal(dispatch('set_value', TARGET, { value: null }, EXPECTED).args.value, '');
});

test('P3-1: 只有文本动作接受 value', () => {
  assert.deepEqual(TEXT_ACTIONS, ['set_value', 'type_text']);
  for (const action of WORKER_ACTIONS) {
    if (TEXT_ACTIONS.includes(action)) continue;
    assert.throws(() => dispatch(action, TARGET, { value: 'x' }, EXPECTED), (e) => {
      assert.equal(e.code, 'computer_invalid_args');
      return true;
    }, `${action} 不应接受 value`);
  }
});

test('P3-1: 外部 automation_id / hwnd / 坐标 / 脚本一律拒绝', () => {
  for (const key of FORBIDDEN_TARGET_KEYS) {
    assert.throws(() => normalizeTarget({ ...TARGET, [key]: 'x' }, EXPECTED), (e) => {
      assert.equal(e.code, 'computer_invalid_args');
      assert.match(e.message, new RegExp(key));
      return true;
    }, `target 带 ${key} 应被拒`);
  }
  // 即使值是空串也拒绝（避免「传了但没生效」被当成支持）
  assert.throws(() => normalizeTarget({ ...TARGET, hwnd: '' }, EXPECTED), /hwnd/);
  // 正常目标通过
  const ok = normalizeTarget(TARGET, EXPECTED);
  assert.deepEqual(ok, { ref: REF, snapshot_id: 's1abc', index: 3, grant_id: 'g-1', generation: 7 });
});

test('P3-1: ref 必须来自本 grant 的有效快照', () => {
  assert.throws(() => normalizeTarget({ ref: 'e3', grant_id: 'g-1', generation: 7 }, EXPECTED),
    (e) => e.code === 'computer_invalid_args');
  assert.throws(() => normalizeTarget({ ref: '@s2zzz:e1', grant_id: 'g-1', generation: 7 }, EXPECTED),
    (e) => e.code === 'computer_invalid_args' && /快照/.test(e.message));
  assert.throws(() => normalizeTarget({ ref: REF, grant_id: 'g-2', generation: 7 }, EXPECTED),
    (e) => e.code === 'computer_invalid_args' && /授权/.test(e.message));
  // 代数变化 → stale（要重新授权，不是参数错）
  assert.throws(() => normalizeTarget({ ref: REF, grant_id: 'g-1', generation: 8 }, EXPECTED),
    (e) => e.code === 'computer_stale_ref');
  assert.throws(() => normalizeTarget(null, EXPECTED), (e) => e.code === 'computer_invalid_args');
  assert.throws(() => normalizeTarget({}, EXPECTED), (e) => e.code === 'computer_invalid_args');
});

test('P3-1: 旧 automation_id 分支由契约版本控制', () => {
  assert.equal(legacyTargetAllowed('ops-computer/1'), true);
  assert.equal(legacyTargetAllowed('ops-computer/2'), false);
  assert.equal(legacyTargetAllowed(''), false);
  assert.equal(legacyTargetAllowed(), true, '默认用当前契约版本（1）放行旧分支');
});

test('P3-1: 缺 action 时按 value 回落到 click / set_value', () => {
  // 旧 IPC 只有「点一下」和「填值」两种语义，不能因为引入枚举就改变它们的含义。
  assert.equal(inferAction(undefined, null), 'click');
  assert.equal(inferAction(null, null), 'click');
  assert.equal(inferAction('', null), 'click');
  assert.equal(inferAction(undefined, ''), 'set_value', '空串也是显式值，按 set_value');
  assert.equal(inferAction(undefined, 'x'), 'set_value');
  // 显式给了 action 就以它为准，哪怕和 value 的形态不匹配（由 normalizeArgs 再拒）
  assert.equal(inferAction('click', 'x'), 'click');
  assert.equal(inferAction('scroll', null), 'scroll');
  // 显式但非法 → 与 assertAction 同一错误码
  for (const bad of ['tap', 'Click', '0']) {
    assert.throws(() => inferAction(bad, null), (e) => e.code === 'computer_action_not_supported', bad);
  }
});

// ===========================================================================
// IPC 级：从 index.js 的消息入口走一遍，锁住「谁先拒、报什么码」。
// 这些用例都在碰窗口之前返回，所以不需要真实 GUI，也不会拉起 PowerShell。
// ===========================================================================

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
    call(extra, timeoutMs = 20_000) {
      const id = `a${nextID++}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('worker_timeout'));
        }, timeoutMs);
        pending.set(id, { resolve, timer });
        child.send({ id, ...extra });
      });
    },
  };
}

// 一个必然不存在的 pid：用例都在解析目标前就返回，写死比用 process.pid 更安全
// （万一哪天前置校验被削弱，也不会误操作到测试进程自己的窗口）。
const DEAD_PID = 999_999_999;

test('P3-1 IPC: 枚举外动作在进入窗口解析前被拒', { timeout: 30_000 }, async (t) => {
  const worker = withWorker(t);
  for (const bad of ['tap', 'Click', 'press_key', 'double_click']) {
    const res = await worker.call({ cmd: 'uia_invoke', pid: DEAD_PID, action: bad, value: null });
    assert.equal(res.ok, false, `${bad} 应被拒`);
    assert.equal(res.error, 'computer_action_not_supported', `${bad} 错误码`);
    assert.match(res.message || '', /不在枚举内/);
    assert.ok(!/undefined/.test(res.message || ''), '报错不得把 undefined 当动作名');
  }
});

test('P3-1 IPC: 拒绝顺序 —— 硬禁区 > pid > 动作枚举', { timeout: 30_000 }, async (t) => {
  const worker = withWorker(t);
  // 硬禁区先于一切：即使动作也非法，也不该泄露「动作是否合法」这一层信息
  const forbidden = await worker.call({
    cmd: 'uia_invoke', pid: DEAD_PID, action: 'tap', target_summary: 'cmd.exe',
  });
  assert.equal(forbidden.error, 'hard_forbidden');

  const badPid = await worker.call({ cmd: 'uia_invoke', pid: 0, action: 'tap' });
  assert.equal(badPid.error, 'pid_invalid');

  const floatPid = await worker.call({ cmd: 'uia_invoke', pid: 1.5, action: 'tap' });
  assert.equal(floatPid.error, 'pid_invalid');
});

test('P3-1 IPC: ref 路径拒绝一切外部目标字段', { timeout: 30_000 }, async (t) => {
  const worker = withWorker(t);
  const externals = { automation_id: 'x', hwnd: 1, x: 10, y: 20, script: 'Get-Process', coordinates: [1, 2], rect: {} };
  for (const [key, val] of Object.entries(externals)) {
    const res = await worker.call({
      cmd: 'uia_invoke', pid: DEAD_PID, ref: REF, grant_id: 'g-1', generation: 7, action: 'click', [key]: val,
    });
    assert.equal(res.ok, false, `${key} 应被拒`);
    assert.equal(res.error, 'computer_invalid_args', `${key} 错误码`);
    assert.match(res.message || '', new RegExp(key), `${key} 报错要点名`);
  }
  // 值为空串 / 0 也拒（避免「传了但没生效」被当成支持）
  for (const [key, val] of [['hwnd', ''], ['x', 0]]) {
    const res = await worker.call({ cmd: 'uia_invoke', pid: DEAD_PID, ref: REF, action: 'click', [key]: val });
    assert.equal(res.error, 'computer_invalid_args', `${key}=${JSON.stringify(val)} 仍应被拒`);
  }
});

test('P3-1 IPC: ref 不属于本 grant 的快照 → stale', { timeout: 30_000 }, async (t) => {
  const worker = withWorker(t);
  // 从未观察过这个快照
  const res = await worker.call({
    cmd: 'uia_invoke', pid: DEAD_PID, ref: '@snever:e1', grant_id: 'g-1', generation: 7, action: 'click',
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'computer_stale_ref');
  // 形状不对的 ref 是参数错，不是 stale
  const bad = await worker.call({ cmd: 'uia_invoke', pid: DEAD_PID, ref: 'e1', action: 'click' });
  assert.equal(bad.error, 'computer_invalid_args');
});

test('P3-1 IPC: 旧 automation_id 分支只放行 click / set_value', { timeout: 30_000 }, async (t) => {
  const worker = withWorker(t);
  const res = await worker.call({
    cmd: 'uia_invoke', pid: DEAD_PID, automation_id: 'Document', action: 'scroll', value: null,
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'computer_action_not_supported');
  assert.match(res.message || '', /scroll/, '报错要说明收到的是什么动作');

  // 缺 automation_id 且动作合法 → 参数错（不是动作不支持）
  const noTarget = await worker.call({ cmd: 'uia_invoke', pid: DEAD_PID, action: 'click' });
  assert.equal(noTarget.error, 'params_invalid');

  // 非文本动作带 value → 参数错（在旧分支也一致）
  const withValue = await worker.call({
    cmd: 'uia_invoke', pid: DEAD_PID, automation_id: 'Document', action: 'click', value: 'x',
  });
  assert.equal(withValue.error, 'computer_invalid_args');
});

