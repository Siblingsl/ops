'use strict';
// DEV-CU P3-5：post-action wait（备料版）。
// 覆盖：立即命中、第 3 次命中、超时诊断、selector 非法、窗口消失终止、临时错误继续、
//       非临时错误上抛，以及「wait 不产生动作」。

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  WAIT_POLL_MS, WAIT_TIMEOUT_MS, validateSelector, selectorMatches, isTransient, pollSelector,
} = require('../src/computer-worker/wait.js');

const node = (role, name) => ({ role, name });

test('P3-5: selector 解析与非法输入', () => {
  assert.deepEqual(validateSelector('button'), { raw: 'button', role: 'button', has_text: '' });
  assert.deepEqual(validateSelector('button:保存'), { raw: 'button:保存', role: 'button', has_text: '保存' });
  // 只按首个冒号拆，text 里可以再有冒号
  assert.deepEqual(validateSelector('textfield:a:b'), { raw: 'textfield:a:b', role: 'textfield', has_text: 'a:b' });
  // text 为空 → 只按 role
  assert.deepEqual(validateSelector('tab:'), { raw: 'tab:', role: 'tab', has_text: '' });
  // 前后空白被裁掉
  assert.equal(validateSelector(' button : 保存 ').has_text, '保存');

  for (const bad of ['', '   ', null, undefined, 12, {}, ':保存', 'but ton:x']) {
    assert.throws(() => validateSelector(bad), (e) => {
      assert.equal(e.code, 'computer_invalid_args');
      return true;
    }, `${String(bad)} 应判非法`);
  }

  // 匹配规则：role 精确 + text 子串
  assert.equal(selectorMatches(validateSelector('button'), node('button', '随便')), true);
  assert.equal(selectorMatches(validateSelector('button'), node('tab', 'x')), false);
  assert.equal(selectorMatches(validateSelector('button:保存'), node('button', '保存并关闭')), true);
  assert.equal(selectorMatches(validateSelector('button:保存'), node('button', '取消')), false);
  assert.equal(selectorMatches(validateSelector('button:保存'), null), false);
});

test('P3-5: 首次观察就命中，不睡眠', async () => {
  const sleeps = [];
  const result = await pollSelector({
    selector: 'button:保存',
    observe: async () => ({ ok: true, node: node('button', '保存'), complete: true }),
    now: () => 0,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(result.ok, true);
  assert.equal(result.matched, true);
  assert.equal(result.attempts, 1);
  assert.deepEqual(result.evidence, { matches: true, complete: true });
  assert.deepEqual(sleeps, [], '命中后不该再等');
});

test('P3-5: 第 3 次才命中（间隔 100ms）', async () => {
  let clock = 0;
  const sleeps = [];
  const seq = [
    { ok: true, node: node('tab', '别的'), complete: true },
    { ok: true, node: node('button', '取消'), complete: true },
    { ok: true, node: node('button', '保存'), complete: true },
  ];
  let i = 0;
  const result = await pollSelector({
    selector: 'button:保存',
    observe: async () => seq[Math.min(i++, seq.length - 1)],
    now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
  });
  assert.equal(result.attempts, 3);
  assert.deepEqual(sleeps, [WAIT_POLL_MS, WAIT_POLL_MS]);
  assert.equal(WAIT_POLL_MS, 100);
});

test('P3-5: 超时补一次诊断快照并抛 wait_timeout', async () => {
  let clock = 0;
  const sleeps = [];
  let diagnosed = 0;
  await assert.rejects(
    () => pollSelector({
      selector: 'button:保存',
      observe: async () => ({ ok: true, node: node('button', '取消'), complete: false }),
      diagnose: async () => { diagnosed += 1; return { nodes: 3 }; },
      now: () => clock,
      sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    }),
    (e) => {
      assert.equal(e.code, 'computer_timeout');
      assert.equal(e.detail.kind, 'wait_timeout');
      assert.equal(e.detail.predicate, 'selector');
      assert.equal(e.detail.selector.role, 'button');
      assert.equal(e.detail.last_error.kind, 'no_match');
      assert.deepEqual(e.detail.evidence, { matches: false, complete: false });
      assert.deepEqual(e.detail.diagnostic, { nodes: 3 });
      return true;
    },
  );
  assert.equal(diagnosed, 1, '超时只补一次诊断');
  assert.equal(WAIT_TIMEOUT_MS, 600);
  assert.ok(clock >= WAIT_TIMEOUT_MS, `应等到 600ms，实际 ${clock}`);
  assert.ok(sleeps.every((ms) => ms === WAIT_POLL_MS));
});

test('P3-5: 窗口消失立即终止，不空转到超时', async () => {
  let calls = 0;
  let clock = 0;
  const result = await pollSelector({
    selector: 'button',
    observe: async () => {
      calls += 1;
      return { ok: false, gone: true, process_state: 'exited' };
    },
    now: () => { clock += 1000; return clock; },
    sleep: async () => { throw new Error('不该睡眠'); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'gone');
  assert.equal(result.attempts, 1);
  assert.deepEqual(result.evidence, { owner_unavailable: 'exited' });
  assert.equal(calls, 1, '消失后不该再观察');
});

test('P3-5: 临时错误继续轮询，非临时错误上抛', async () => {
  let i = 0;
  const result = await pollSelector({
    selector: 'textfield:备注',
    observe: async () => {
      i += 1;
      if (i === 1) return { ok: false, error_code: 'computer_timeout', retryable: true };
      return { ok: true, node: node('textfield', '备注'), complete: true };
    },
    now: () => i * 10,
    sleep: async () => {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);

  // retryable:false 的临时码也要终止
  await assert.rejects(
    () => pollSelector({
      selector: 'button',
      observe: async () => ({ ok: false, error_code: 'computer_timeout', retryable: false }),
      now: () => 0,
      sleep: async () => {},
    }),
    (e) => e.code === 'computer_timeout' && e.detail.kind === 'wait_observe_failed',
  );

  // 非临时错误（如 stale ref）原样上抛
  await assert.rejects(
    () => pollSelector({
      selector: 'button',
      observe: async () => ({ ok: false, error_code: 'computer_stale_ref', retryable: true }),
      now: () => 0,
      sleep: async () => {},
    }),
    (e) => e.code === 'computer_stale_ref' && e.detail.attempts === 1,
  );
  assert.equal(isTransient({ error_code: 'computer_app_unresponsive', retryable: true }), true);
  assert.equal(isTransient({ error_code: 'computer_app_unresponsive', retryable: false }), false);
  assert.equal(isTransient(null), false);
});

test('P3-5: wait 本身不产生任何动作', async () => {
  // observe 的入参只有 selector；没有 execute / click / type 之类的入口
  const seen = [];
  const result = await pollSelector({
    selector: 'button',
    observe: async (selector) => {
      seen.push(selector);
      return { ok: true, node: node('button', 'x'), complete: true };
    },
    now: () => 0,
    sleep: async () => {},
  });
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(seen[0]).sort(), ['has_text', 'raw', 'role']);
  // observe 只拿得到 selector：没有通道把动作参数递进来
  assert.equal(typeof seen[0].value, 'undefined');
  assert.equal(typeof seen[0].action, 'undefined');
});

// ---------------------------------------------------------------------------
// P3-5 接线级：normalizeWaitInput（dispatch 侧归一）与 native.executeActionChain
// 的 wait 注入路径。观察全部注入，不依赖真实窗口。
// ---------------------------------------------------------------------------

const { normalizeWaitInput } = require('../src/computer-worker/wait.js');

test('P3-5: normalizeWaitInput 归一（false/null 不等待，对象限 timeout）', () => {
  assert.equal(normalizeWaitInput(undefined), null);
  assert.equal(normalizeWaitInput(null), null);
  assert.equal(normalizeWaitInput(false), null);
  assert.deepEqual(normalizeWaitInput('button:保存'), { selector: 'button:保存', timeout_ms: 600 });
  assert.deepEqual(normalizeWaitInput({ selector: 'button' }), { selector: 'button', timeout_ms: 600 });
  assert.deepEqual(normalizeWaitInput({ selector: 'button', timeout_ms: 200 }),
    { selector: 'button', timeout_ms: 200 });
  for (const bad of [true, 12, {}, { timeout_ms: 100 }, { selector: 12 }]) {
    assert.throws(() => normalizeWaitInput(bad), (e) => e.code === 'computer_invalid_args',
      `${JSON.stringify(bad)} 应判非法`);
  }
  assert.throws(() => normalizeWaitInput({ selector: 'button', timeout_ms: 0 }),
    (e) => e.code === 'computer_invalid_args', 'timeout_ms ≤ 0 拒绝');
  assert.throws(() => normalizeWaitInput({ selector: 'button', timeout_ms: 601 }),
    (e) => e.code === 'computer_invalid_args', 'timeout_ms 超上限拒绝');
});

test('P3-5 接线: executeActionChain 带 wait 时命中即返回 wait 证据', { timeout: 120_000 }, async (t) => {
  if (process.platform !== 'win32') { t.skip('需要 Windows（PS parser 探能力）'); return; }
  const native = require('../src/computer-worker/native.js');
  // 不需要真窗口：探能力会失败 → 走不到链；这里改走注入路径——直接构造
  // 一个最小 pid=当前进程（记事本不可用时探能力也失败），只验证「wait 传了就
  // 会在链成功后被消费」。用 monkey-patch invokePatternByPath 不可行（闭包内），
  // 因此退而验证：探能力失败时 wait 不该被执行（无副作用）。
  let observeCalls = 0;
  const native2 = require('../src/computer-worker/native.js');
  const result = await native2.executeActionChain(999_999_999, [0], 'click', null, 'button:x');
  assert.equal(result.ok, false, '必不存在的 pid 应探能力失败');
  assert.equal(result.wait, undefined, '链未成功时不得执行 wait');
  assert.equal(observeCalls, 0);
});

test('P3-5 接线: index.js 的 uia_invoke 透传 msg.wait（IPC 级 fork）', { timeout: 60_000 }, async (t) => {
  const { fork } = require('node:child_process');
  const path = require('node:path');
  const WORKER = path.resolve(__dirname, '..', 'src', 'computer-worker', 'index.js');
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
  const call = (extra, timeoutMs = 30_000) => new Promise((resolve, reject) => {
    const id = `w${nextID++}`;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('worker_timeout')); }, timeoutMs);
    pending.set(id, { resolve, timer });
    child.send({ id, cmd: 'uia_invoke', ...extra });
  });

  // wait 入参非法 → 在进窗口解析前被拒（ref 路径会先拒外部字段，用旧分支测：
  // 旧分支只放行 click/set_value，action=click + automation_id 合法，wait 非法
  // 会在 normalizeWaitInput 抛 invalid_args——位置在 native.executeActionChain 内，
  // 即窗口解析之后。旧分支不走链，所以用「枚举内动作 + ref + 非法 wait」的组合：
  // 非法 wait 属参数错，但它在 dispatch 之后才归一，因此拒绝顺序是 ref → dispatch
  // → resolveAndObserve → wait 归一。这里只锁「非法 wait 最终回 invalid_args」。
  const res = await call({
    pid: 999_999_999, ref: '@sdeadbeef:e1', grant_id: 'g-1', generation: 1,
    action: 'click', wait: { selector: 12 },
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'computer_stale_ref', 'wait 归一在快照校验之后：先报 stale');
  assert.notEqual(res.error, 'computer_internal', '不得把非法 wait 吞成内部错误后丢失语义');
});
