'use strict';
// DEV-CU P3-4：投递语义生成与统一回执（备料版）。
// 覆盖：五态 × retry 全表、disposition 一致性校验、unknown 收敛、recovery 只在 safe 时输出、
//       成功/失败信封形状、错误码表与 §4.2 逐项比对。

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DELIVERY, RETRY, RETRY_BY_DELIVERY, STRATEGY, ERROR_CODES, READ_ONLY_COMMANDS,
  dispositionOf, parseDisposition, settleUnknownDelivery, recoveryFor,
  finishSuccess, finishFailure, finish,
} = require('../src/computer-worker/response.js');
const { WORKER_ACTIONS } = require('../src/computer-worker/actions.js');

test('P3-4: 五态 × retry 全表（§4.3 逐行）', () => {
  assert.deepEqual(Object.values(DELIVERY).sort(), [
    'delivered_unverified', 'delivered_verified', 'delivery_uncertain', 'not_delivered', 'unknown',
  ]);
  const table = [
    [DELIVERY.NOT_DELIVERED, RETRY.SAFE],
    [DELIVERY.UNCERTAIN, RETRY.UNSAFE],
    [DELIVERY.UNVERIFIED, RETRY.UNSAFE],
    [DELIVERY.VERIFIED, RETRY.UNSAFE],
    [DELIVERY.UNKNOWN, RETRY.UNKNOWN],
  ];
  for (const [delivery, retry] of table) {
    assert.deepEqual(dispositionOf(delivery), { delivery, retry }, `${delivery} 的 retry 应是 ${retry}`);
  }
  assert.equal(Object.keys(RETRY_BY_DELIVERY).length, 5);
  // 未知投递语义不猜
  assert.throws(() => dispositionOf('delivered'), (e) => e.code === 'computer_internal');
  assert.throws(() => dispositionOf(''), (e) => e.code === 'computer_internal');
});

test('P3-4: disposition 反序列化必须自洽', () => {
  assert.deepEqual(parseDisposition({ delivery: 'not_delivered', retry: 'safe' }),
    { delivery: 'not_delivered', retry: 'safe' });
  // 语义说 safe，实际表里是 unsafe → 内部错误，不能静默放过
  assert.throws(
    () => parseDisposition({ delivery: 'delivered_verified', retry: 'safe' }),
    (e) => e.code === 'computer_internal' && /不一致/.test(e.message),
  );
  assert.throws(() => parseDisposition({ delivery: 'not_delivered' }),
    (e) => e.code === 'computer_internal');
  assert.throws(() => parseDisposition(null), (e) => e.code === 'computer_internal');
  assert.throws(() => parseDisposition({ delivery: 'bogus', retry: 'safe' }),
    (e) => e.code === 'computer_internal');
});

test('P3-4: unknown 收敛（只读命令 / invalid_args → not_delivered）', () => {
  // 只读命令 + unknown → not_delivered/safe
  for (const command of READ_ONLY_COMMANDS) {
    assert.deepEqual(settleUnknownDelivery({ command, disposition: DELIVERY.UNKNOWN }),
      { delivery: 'not_delivered', retry: 'safe' }, `${command} 应收敛成 not_delivered`);
  }
  // 写命令 + unknown → 保持 unknown/unknown
  assert.deepEqual(settleUnknownDelivery({ command: 'uia_invoke', disposition: DELIVERY.UNKNOWN }),
    { delivery: 'unknown', retry: 'unknown' });
  // invalid_args 不论命令都收敛
  assert.deepEqual(
    settleUnknownDelivery({ command: 'uia_invoke', error_code: 'computer_invalid_args', disposition: DELIVERY.UNKNOWN }),
    { delivery: 'not_delivered', retry: 'safe' },
  );
  // 已经是确定的语义 → 原样返回
  assert.deepEqual(settleUnknownDelivery({ command: 'uia_invoke', disposition: DELIVERY.VERIFIED }),
    { delivery: 'delivered_verified', retry: 'unsafe' });
  // 没给 disposition → 按 unknown 处理
  assert.deepEqual(settleUnknownDelivery({ command: 'ping' }), { delivery: 'not_delivered', retry: 'safe' });
  assert.deepEqual(settleUnknownDelivery({ command: 'uia_invoke' }), { delivery: 'unknown', retry: 'unknown' });
  // 字符串形态也接受
  assert.deepEqual(settleUnknownDelivery('not_delivered'), { delivery: 'not_delivered', retry: 'safe' });
});

test('P3-4: recovery 只在 retry === safe 时输出', () => {
  // unsafe / unknown 一律不输出
  for (const delivery of [DELIVERY.UNCERTAIN, DELIVERY.UNVERIFIED, DELIVERY.VERIFIED, DELIVERY.UNKNOWN]) {
    assert.equal(recoveryFor('computer_stale_ref', dispositionOf(delivery)), null, `${delivery} 不应有 recovery`);
  }
  // safe 且码在表内 → 输出
  assert.ok(recoveryFor('computer_stale_ref', dispositionOf(DELIVERY.NOT_DELIVERED)));
});

test('P3-4: recovery 策略与常量照上游 recovery_for_code', () => {
  const safe = dispositionOf(DELIVERY.NOT_DELIVERED);
  const of = (code, details) => recoveryFor(code, safe, details);

  assert.deepEqual(of('computer_stale_ref'), {
    strategy: STRATEGY.REFRESH, retryable: true, requires_fresh_snapshot: true,
  });
  // 进程已退出：重新取快照没用，要先查进程状态
  assert.deepEqual(of('computer_stale_ref', { process_state: 'exited' }), {
    strategy: STRATEGY.INSPECT, retryable: true, requires_fresh_snapshot: true,
  });
  assert.equal(STRATEGY.REFRESH, 'refresh_snapshot_then_retry_original');
  assert.equal(STRATEGY.INSPECT, 'inspect_state_then_retry_original');
  assert.equal(STRATEGY.POLICY, 'request_explicit_policy_then_retry_original');

  assert.equal(of('computer_ambiguous_target').strategy, STRATEGY.REFRESH);
  assert.equal(of('computer_target_changed').strategy, STRATEGY.REFRESH);

  assert.deepEqual(of('computer_policy_denied'), {
    strategy: STRATEGY.POLICY, retryable: true, requires_fresh_snapshot: false,
  });
  assert.equal(of('computer_scope_denied').strategy, STRATEGY.POLICY);

  // 超时 / 无响应：safe 时也要 250ms 后再试
  assert.deepEqual(of('computer_timeout'), {
    strategy: STRATEGY.INSPECT, retryable: true, requires_fresh_snapshot: true, retry_after_ms: 250,
  });
  assert.equal(of('computer_app_unresponsive').retry_after_ms, 250);

  // 表里没有 strategy 的码不编造
  for (const code of ['computer_action_failed', 'computer_action_not_supported', 'computer_invalid_args',
    'computer_internal', 'computer_ui_unsupported', 'computer_budget_exceeded']) {
    assert.equal(of(code), null, `${code} 不应有 recovery`);
  }
  assert.equal(of('computer_not_a_code'), null);
});

test('P3-4: 成功信封保留旧字段并追加 disposition', () => {
  const out = finishSuccess({ window: 'x', pid: 42, ok: true }, dispositionOf(DELIVERY.NOT_DELIVERED));
  assert.equal(out.ok, true);
  assert.equal(out.window, 'x');
  assert.equal(out.pid, 42);
  assert.deepEqual(out.disposition, { delivery: 'not_delivered', retry: 'safe' });

  // 没给 disposition 时按未验证投递（读操作不需要验证，但也不能声称已验证）
  assert.deepEqual(finishSuccess({ pid: 1 }).disposition, { delivery: 'delivered_unverified', retry: 'unsafe' });

  // finish() 的扁平平铺：旧 cmd 的字段不能被塞进 data 里
  const flat = finish({ ok: true, pid: 7, windows: [] });
  assert.equal(flat.pid, 7);
  assert.ok(Array.isArray(flat.windows));
  assert.equal(flat.data, undefined);
  // finish() 带 data 时按 data 走
  const boxed = finish({ ok: true, data: { pid: 8 } });
  assert.equal(boxed.pid, 8);
});

test('P3-4: 失败信封形状与 recovery / report 落点', () => {
  const out = finishFailure({
    code: 'computer_stale_ref',
    message: '目标已变化',
    detail: { snapshot_id: 's1', ref: '@s1:e2', role: 'button', complete: true },
    disposition: dispositionOf(DELIVERY.NOT_DELIVERED),
    report: { actionable: false, checks: [] },
  });
  assert.equal(out.ok, false);
  assert.equal(out.error.code, 'computer_stale_ref');
  assert.equal(out.error.message, '目标已变化');
  assert.equal(out.error.detail.snapshot_id, 's1');
  assert.deepEqual(out.error.detail.disposition, { delivery: 'not_delivered', retry: 'safe' });
  assert.equal(out.error.detail.report.actionable, false);
  assert.equal(out.error.detail.recovery.strategy, STRATEGY.REFRESH);

  // unsafe 失败：不给 recovery，但仍给 disposition
  const unsafe = finishFailure({
    code: 'computer_app_unresponsive',
    message: 'RPC',
    disposition: dispositionOf(DELIVERY.UNCERTAIN),
  });
  assert.equal(unsafe.error.detail.recovery, undefined);
  assert.deepEqual(unsafe.error.detail.disposition, { delivery: 'delivery_uncertain', retry: 'unsafe' });

  // 未知错误码：收敛成 internal，原码留在 detail
  const unknown = finishFailure({ code: 'computer_boom', message: 'boom' });
  assert.equal(unknown.error.code, 'computer_internal');
  assert.equal(unknown.error.detail.original_code, 'computer_boom');
  assert.deepEqual(unknown.error.detail.disposition, { delivery: 'not_delivered', retry: 'safe' });

  // 没给 disposition 的失败按 not_delivered（门禁/参数类失败都是未投递）
  assert.deepEqual(finishFailure({ code: 'computer_invalid_args', message: 'x' }).error.detail.disposition,
    { delivery: 'not_delivered', retry: 'safe' });

  // finish() 的失败分支等价
  const viaFinish = finish({ ok: false, code: 'computer_policy_denied', message: 'denied' });
  assert.equal(viaFinish.error.code, 'computer_policy_denied');
  assert.equal(viaFinish.error.detail.recovery.strategy, STRATEGY.POLICY);
});

test('P3-4: 错误码表与 §4.2 逐项一致（16 个）', () => {
  const expected = [
    ['computer_stale_ref', 409, true, null],
    ['computer_ambiguous_target', 409, true, null],
    ['computer_target_changed', 409, true, null],
    ['computer_approval_conflict', 409, false, null],
    ['computer_foreground_busy', 409, false, null],
    ['computer_action_not_supported', 422, false, null],
    ['computer_ui_unsupported', 422, false, null],
    ['computer_action_failed', 422, false, null],
    ['computer_app_unresponsive', 503, true, 250],
    ['computer_timeout', 504, true, 250],
    ['computer_policy_denied', 403, false, null],
    ['computer_scope_denied', 403, false, null],
    ['computer_device_offline', 503, false, null],
    ['computer_budget_exceeded', 429, false, null],
    ['computer_invalid_args', 422, false, null],
    ['computer_internal', 500, false, null],
  ];
  assert.equal(Object.keys(ERROR_CODES).length, 16, '§4.2 共 16 个错误码');
  for (const [code, http, fresh, retryAfter] of expected) {
    const meta = ERROR_CODES[code];
    assert.ok(meta, `缺少错误码 ${code}`);
    assert.equal(meta.http, http, `${code} 的 HTTP`);
    assert.equal(meta.requires_fresh_snapshot, fresh, `${code} 的 requires_fresh_snapshot`);
    assert.equal(meta.retry_after_ms, retryAfter, `${code} 的 retry_after_ms`);
  }
  // 反面：动作枚举里的名字不能被误当成错误码
  for (const action of WORKER_ACTIONS) assert.equal(ERROR_CODES[action], undefined);
});
