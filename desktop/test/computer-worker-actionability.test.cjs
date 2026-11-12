'use strict';
// DEV-CU P2-6：可操作性门禁与稳定采样（§4.6 / §P2-6）。
// 覆盖：需求矩阵 7 行、6 个实际判定 gate 各正/负例、3 个恒 pass / not_applicable 的锁定断言、
//       稳定采样 3 次才通过、deadline 耗尽、失败时 disposition.delivery=not_delivered。

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  SAMPLE_INTERVAL_MS, MIN_SPAN_MS, CONSECUTIVE_REQUIRED, GEOMETRY_TOLERANCE,
  GATE_ORDER, REQUIREMENT_KEYS, REQUIREMENTS, CURSOR_REQUIRED_ACTIONS, GATE_ERROR_CODE,
  normalizeAction, requirementsFor, geometryMatches, StabilitySampler,
  evaluateActionability, assertActionable, onlyBlockingCheckIsStability, sampleUntilStable,
} = require('../src/computer-worker/actionability.js');

/** 一个「正常可点」的按钮证据。 */
const BUTTON = {
  role: 'button', states: ['enabled', 'visible'], enabled: true,
  bounds: { x: 10, y: 20, w: 80, h: 24 }, available_actions: ['Click'],
};
/** 一个正常可写的编辑区。 */
const FIELD = {
  role: 'textfield', states: ['enabled', 'visible'], enabled: true,
  bounds: { x: 0, y: 0, w: 300, h: 120 }, available_actions: ['SetValue'],
};
const stamp = (n) => `第 ${n} 项`;

// ---------------------------------------------------------------------------
// 1. 需求矩阵：7 行各一条（写死表，改表必红）
// ---------------------------------------------------------------------------
test('P2-6: 需求矩阵 7 行逐项锁定', () => {
  const rows = [
    [['click', 'double_click', 'right_click', 'triple_click'], [true, true, true, false, true]],
    [['hover', 'drag'], [true, true, false, false, true]],
    [['set_value', 'type_text', 'clear'], [true, false, true, true, false]],
    [['select'], [true, false, true, false, false]],
    [['expand', 'collapse', 'toggle', 'check', 'uncheck', 'scroll'], [true, true, true, false, false]],
    [['scroll_to'], [false, true, false, false, false]],
    [['set_focus', 'press_key'], [false, false, false, false, false]],
  ];
  for (const [actions, expected] of rows) {
    for (const action of actions) {
      const req = requirementsFor(action);
      assert.ok(req, `${action} 应在矩阵内`);
      assert.deepEqual(
        REQUIREMENT_KEYS.map((k) => req[k]), expected,
        `${action} 的五元组与 §4.6 表不一致`,
      );
    }
  }
  // 7 行展开成 19 个动作；表里没有的写法会被归一化后命中同一行
  assert.equal(Object.keys(REQUIREMENTS).length, 19, '矩阵应有 19 个动作（7 行展开）');
  assert.deepEqual(requirementsFor('SetValue'), requirementsFor('set_value'), 'CamelCase 与 snake_case 同表');
  assert.deepEqual(requirementsFor('Double Click'), requirementsFor('double_click'));
  assert.equal(requirementsFor('launch_missile'), null, '未知动作不在矩阵内');
  assert.equal(normalizeAction(''), '');
});

test('P2-6: 每个动作都有 gate 需要的错误码映射', () => {
  // 六个实际判定 gate 都要有错误码；其余 gate 不得出现在映射里（改错地方会红）
  assert.deepEqual(Object.keys(GATE_ERROR_CODE).sort(), [
    'action_supported', 'editable', 'enabled', 'policy', 'stable', 'visible',
  ]);
  assert.equal(GATE_ERROR_CODE.editable, 'computer_action_not_supported');
  assert.equal(GATE_ERROR_CODE.action_supported, 'computer_action_not_supported');
  assert.equal(GATE_ERROR_CODE.policy, 'computer_policy_denied');
});

// ---------------------------------------------------------------------------
// 2. 三个「恒 pass / not_applicable」gate：锁定 OPS 裁剪，防止被改成物理投递
// ---------------------------------------------------------------------------
test('P2-6: headed_requirement / pointer_delivery / receives_events 三态锁定', () => {
  const report = evaluateActionability({ action: 'click', node: BUTTON, stability: { stable: true } });
  const byName = Object.fromEntries(report.checks.map((c) => [c.check, c]));

  assert.equal(byName.headed_requirement.status, 'pass');
  assert.equal(byName.headed_requirement.reason, 'headless', 'OPS 恒 headless，不得出现 headed 分支');

  assert.equal(byName.pointer_delivery.status, 'pass');
  assert.equal(report.pointer_delivery, 'semantic', '有 Click 能力 → 语义投递');
  assert.equal(byName.receives_events.status, 'not_applicable', '不做 5 点 hit-test');
  assert.ok(!report.blocking.includes('receives_events'), 'not_applicable 不得阻塞');

  // 不需要指针的动作用 not_applicable，也恒 pass
  const typing = evaluateActionability({ action: 'set_value', node: FIELD });
  const typingByName = Object.fromEntries(typing.checks.map((c) => [c.check, c]));
  assert.equal(typing.pointer_delivery, 'not_applicable');
  assert.equal(typingByName.pointer_delivery.status, 'pass');
  assert.equal(typingByName.headed_requirement.status, 'pass');
  assert.equal(typingByName.receives_events.status, 'not_applicable');

  // gate 顺序固定，且恰好 9 个
  assert.deepEqual(report.checks.map((c) => c.check), GATE_ORDER);
  assert.equal(GATE_ORDER.length, 9);
});

// ---------------------------------------------------------------------------
// 3. visible gate
// ---------------------------------------------------------------------------
test('P2-6 visible: hidden / offscreen / 零尺寸 fail，缺 bounds 三态', () => {
  const run = (node) => evaluateActionability({ action: 'click', node, stability: { stable: true } })
    .checks.find((c) => c.check === 'visible');

  assert.equal(run(BUTTON).status, 'pass');
  assert.equal(run({ ...BUTTON, hidden: true }).status, 'fail');
  assert.equal(run({ ...BUTTON, offscreen: true }).status, 'fail');
  assert.equal(run({ ...BUTTON, states: ['enabled', 'offscreen'] }).status, 'fail');
  assert.equal(run({ ...BUTTON, bounds: { x: 0, y: 0, w: 0, h: 24 } }).status, 'fail', '宽为 0 不可见');
  assert.equal(run({ ...BUTTON, bounds: { x: 0, y: 0, w: 80, h: 0 } }).status, 'fail', '高为 0 不可见');

  const noBounds = run({ ...BUTTON, bounds: undefined });
  assert.equal(noBounds.status, 'unknown', 'bounds 缺失且没声明 visible_without_bounds → unknown');
  assert.equal(noBounds.code, 'computer_action_failed');
  assert.equal(run({ ...BUTTON, bounds: undefined, visible_without_bounds: true }).status, 'pass');
  assert.equal(run({ ...BUTTON, states: ['enabled'] }).status, 'unknown', 'states 未声明 visible → unknown');
});

// ---------------------------------------------------------------------------
// 4. stable gate
// ---------------------------------------------------------------------------
test('P2-6 stable: 未采样 unknown，采样成功 pass', () => {
  const run = (stability) => evaluateActionability({ action: 'click', node: BUTTON, stability })
    .checks.find((c) => c.check === 'stable');
  assert.equal(run(undefined).status, 'unknown', '没采样不得判 pass');
  assert.equal(run({ stable: false }).status, 'unknown');
  assert.equal(run({ stable: true }).status, 'pass');

  // 矩阵不要求 stable 的动作 → pass + not_required，且不影响结论
  const typing = evaluateActionability({ action: 'set_value', node: FIELD });
  const stable = typing.checks.find((c) => c.check === 'stable');
  assert.equal(stable.status, 'pass');
  assert.equal(stable.reason, 'not_required');
});

// ---------------------------------------------------------------------------
// 5. enabled gate
// ---------------------------------------------------------------------------
test('P2-6 enabled: 三态判定', () => {
  const run = (node) => evaluateActionability({ action: 'click', node, stability: { stable: true } })
    .checks.find((c) => c.check === 'enabled');
  assert.equal(run(BUTTON).status, 'pass');
  assert.equal(run({ ...BUTTON, enabled: false }).status, 'fail');
  // 夹具要同时去掉显式 enabled，否则「enabled:true」优先，测不到 states 分支
  assert.equal(run({ ...BUTTON, enabled: undefined, states: ['disabled', 'visible'] }).status, 'fail');
  assert.equal(run({ ...BUTTON, enabled: undefined, states: ['visible'] }).status, 'unknown');

  // 矩阵不要求 enabled 的动作不受影响（Hover）
  const hover = evaluateActionability({ action: 'hover', node: { ...BUTTON, enabled: false } });
  assert.equal(hover.checks.find((c) => c.check === 'enabled').reason, 'not_required');
});

// ---------------------------------------------------------------------------
// 6. editable gate
// ---------------------------------------------------------------------------
test('P2-6 editable: 只有写类动作受检', () => {
  const run = (action, node) => {
    const report = evaluateActionability({ action, node, stability: { stable: true } });
    return { check: report.checks.find((c) => c.check === 'editable'), report };
  };

  assert.equal(run('set_value', FIELD).check.status, 'pass');
  assert.equal(run('type_text', { ...FIELD, role: 'combobox' }).check.status, 'pass');
  assert.equal(run('clear', FIELD).check.status, 'pass');

  const buttonWrite = run('set_value', BUTTON);
  assert.equal(buttonWrite.check.status, 'fail');
  assert.equal(buttonWrite.check.code, 'computer_action_not_supported');
  assert.equal(buttonWrite.report.actionable, false);
  assert.equal(buttonWrite.report.disposition.delivery, 'not_delivered');

  // 没有 ValuePattern 但 role 是 textfield：editable 过，action_supported 拦
  const noPattern = run('set_value', { ...FIELD, available_actions: [] });
  assert.equal(noPattern.check.status, 'pass');
  assert.equal(noPattern.report.checks.find((c) => c.check === 'action_supported').status, 'fail');

  // 非写类动作恒 pass，且注明 not_required
  assert.equal(run('click', BUTTON).check.reason, '本动作不要求可编辑');
  assert.equal(run('click', { ...BUTTON, role: 'unknown' }).check.status, 'pass');
});

// ---------------------------------------------------------------------------
// 7. action_supported gate
// ---------------------------------------------------------------------------
test('P2-6 action_supported: 枚举 + 能力', () => {
  const run = (action, node) => evaluateActionability({ action, node, stability: { stable: true } })
    .checks.find((c) => c.check === 'action_supported');

  assert.equal(run('click', BUTTON).status, 'pass');
  assert.equal(run('click', { ...BUTTON, available_actions: [] }).status, 'fail');
  assert.equal(run('click', { ...BUTTON, available_actions: ['Invoke'] }).status, 'pass', 'Invoke 也是点击能力');
  assert.equal(run('toggle', { ...BUTTON, available_actions: ['Toggle'] }).status, 'pass');
  assert.equal(run('toggle', BUTTON).status, 'fail');
  assert.equal(run('expand', { ...BUTTON, available_actions: ['ExpandCollapse'] }).status, 'pass');
  assert.equal(run('select', { ...FIELD, role: 'option', available_actions: ['Select'] }).status, 'pass');
  assert.equal(run('scroll', { ...BUTTON, available_actions: ['Scroll'] }).status, 'pass');

  const unknownAction = run('launch_missile', BUTTON);
  assert.equal(unknownAction.status, 'fail');
  assert.equal(unknownAction.code, 'computer_action_not_supported');

  // 语义 API 直达的动作不需要元素自报能力
  assert.equal(run('set_focus', { ...BUTTON, available_actions: [] }).status, 'pass');
  assert.equal(run('press_key', { ...BUTTON, available_actions: [] }).status, 'pass');
});

// ---------------------------------------------------------------------------
// 8. policy gate
// ---------------------------------------------------------------------------
test('P2-6 policy: 需要物理光标或显式要求抢焦点时拒绝', () => {
  const run = (action, policy) => evaluateActionability({
    action, node: BUTTON, policy, stability: { stable: true },
  }).checks.find((c) => c.check === 'policy');

  assert.equal(run('click', undefined).status, 'pass');
  assert.equal(run('click', { headed: false }).status, 'pass');

  const hover = run('hover', undefined);
  assert.equal(hover.status, 'fail');
  assert.equal(hover.code, 'computer_policy_denied');
  assert.equal(run('drag', undefined).status, 'fail');
  assert.ok(CURSOR_REQUIRED_ACTIONS.includes('hover') && CURSOR_REQUIRED_ACTIONS.includes('drag'));

  assert.equal(run('click', { allow_cursor_move: true }).status, 'fail', '不得静默降级成物理投递');
  assert.equal(run('click', { allow_focus_steal: true }).status, 'fail');
  assert.equal(run('click', { headed: true }).status, 'fail');
});

// ---------------------------------------------------------------------------
// 9. 结论、report 与 disposition
// ---------------------------------------------------------------------------
test('P2-6: 全部 pass 时 actionable，任一门禁失败则 not_delivered', () => {
  const okReport = evaluateActionability({ action: 'click', node: BUTTON, stability: { stable: true } });
  assert.equal(okReport.actionable, true);
  assert.deepEqual(okReport.blocking, []);
  assert.equal(okReport.disposition, undefined, '可操作时不带 disposition');

  const badReport = evaluateActionability({
    action: 'click', node: { ...BUTTON, enabled: false }, stability: { stable: true },
  });
  assert.equal(badReport.actionable, false);
  assert.deepEqual(badReport.blocking, ['enabled']);
  assert.deepEqual(badReport.disposition, { delivery: 'not_delivered', retry: 'safe' });
  assert.equal(badReport.error_code, 'computer_action_failed');
  assert.match(badReport.failure_reasons, /enabled/);

  // 永久拒绝优先于暂时性 unknown（用 click：它同时要求 stable 与 Click 能力）
  const mixed = evaluateActionability({
    action: 'click', node: { ...BUTTON, available_actions: [] }, stability: { stable: false },
  });
  assert.deepEqual(mixed.blocking.sort(), ['action_supported', 'stable']);
  assert.equal(mixed.error_code, 'computer_action_not_supported', 'fail 的错误码压过 unknown');

  // 断言入口：抛 WorkerError，detail 带完整 report
  assert.throws(
    () => assertActionable({ action: 'click', node: { ...BUTTON, hidden: true }, stability: { stable: true } }),
    (e) => {
      assert.equal(e.code, 'computer_action_failed');
      assert.equal(e.detail.disposition.delivery, 'not_delivered');
      assert.equal(e.detail.disposition.retry, 'safe');
      assert.equal(e.detail.report.checks.length, 9, '失败也要带完整 9 个 gate');
      assert.deepEqual(e.detail.report.checks.map((c) => c.check), GATE_ORDER);
      return true;
    },
  );
  // 通过时不抛
  assert.equal(assertActionable({ action: 'click', node: BUTTON, stability: { stable: true } }).actionable, true);
});

test('P2-6: 唯一阻塞项是 stable 时才进采样循环', () => {
  const onlyStable = evaluateActionability({ action: 'click', node: BUTTON });
  assert.deepEqual(onlyStable.blocking, ['stable']);
  assert.equal(onlyBlockingCheckIsStability(onlyStable), true);

  const two = evaluateActionability({ action: 'click', node: { ...BUTTON, enabled: false } });
  assert.equal(onlyBlockingCheckIsStability(two), false);
  assert.equal(onlyBlockingCheckIsStability({ blocking: [] }), false);
  assert.equal(onlyBlockingCheckIsStability({}), false);
});

// ---------------------------------------------------------------------------
// 10. 稳定采样：常量、3 次、34ms、0.5px
// ---------------------------------------------------------------------------
test('P2-6: 稳定采样常量与 3 次/34ms 判据', () => {
  assert.equal(SAMPLE_INTERVAL_MS, 17);
  assert.equal(MIN_SPAN_MS, 34);
  assert.equal(CONSECUTIVE_REQUIRED, 3);
  assert.equal(GEOMETRY_TOLERANCE, 0.5);
  assert.ok(MIN_SPAN_MS >= SAMPLE_INTERVAL_MS * 2, '34ms 至少覆盖两个采样间隔');

  const b = { x: 10, y: 10, w: 100, h: 40 };
  const s = new StabilitySampler();
  assert.equal(s.observe(b, 0), false, '第 1 次不够');
  assert.equal(s.observe(b, 17), false, '第 2 次不够');
  assert.equal(s.observe(b, 34), true, '第 3 次且跨度 34ms → 稳定');
  assert.equal(s.samples, 3);
  assert.equal(s.stableSpan(34), 34);

  // 3 次但跨度不足 34ms → 不稳定（防止「连读三次」蒙过）
  const fast = new StabilitySampler();
  assert.equal(fast.observe(b, 0), false);
  assert.equal(fast.observe(b, 1), false);
  assert.equal(fast.observe(b, 2), false, '3 次但跨度只有 2ms，不得判稳定');

  // 抖动超容差 → 重新计数
  const jitter = new StabilitySampler();
  jitter.observe(b, 0);
  jitter.observe(b, 17);
  assert.equal(jitter.observe({ ...b, x: b.x + 2 }, 34), false, '位移 2px > 0.5 → 重新计时');
  assert.equal(jitter.samples, 1);

  // 读不到 bounds → 清零
  const blank = new StabilitySampler();
  blank.observe(b, 0);
  assert.equal(blank.observe(null, 17), false);
  assert.equal(blank.samples, 0);
  assert.equal(blank.previous, null);
});

test('P2-6: 0.5px 容差逐项判定', () => {
  const a = { x: 1, y: 2, w: 3, h: 4 };
  assert.equal(geometryMatches(a, a), true);
  assert.equal(geometryMatches(a, { x: 1.5, y: 2.5, w: 3.5, h: 4.5 }), true, '边界值 0.5 算一致');
  assert.equal(geometryMatches(a, { x: 1.6, y: 2, w: 3, h: 4 }), false, '1.6 > 0.5');
  assert.equal(geometryMatches(a, { x: 1, y: 2, w: 3, h: 4.6 }), false);
  assert.equal(geometryMatches(a, { x: NaN, y: 2, w: 3, h: 4 }), false, 'NaN 不算一致');
  assert.equal(geometryMatches(a, null), false);
});

test('P2-6: sampleUntilStable 采到 3 次才返回，deadline 耗尽返回失败', async () => {
  // 假时钟：每次 read 推进 17ms
  let clock = 0;
  const sleep = async (ms) => { clock += ms; };
  const stableRead = (() => {
    let n = 0;
    return () => ({ x: 5, y: 5, w: 50, h: 20, n: ++n });
  })();

  const ok = await sampleUntilStable({
    read: stableRead, deadlineAt: 1000, now: () => clock, sleep,
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.samples, 3);
  assert.ok(ok.span_ms >= MIN_SPAN_MS);
  assert.ok(clock <= 100, `应在 3 次采样后立即返回，实际 elapsed=${clock}`);

  // 一直抖动 → deadline 耗尽
  clock = 0;
  let i = 0;
  const movingRead = () => ({ x: 5 + (i++) * 10, y: 5, w: 50, h: 20 });
  const bad = await sampleUntilStable({
    read: movingRead, deadlineAt: 200, now: () => clock, sleep,
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'deadline_exceeded');
  assert.ok(clock >= 200, '应跑到 deadline 才放弃');

  // 一直读不到 bounds → no_bounds
  clock = 0;
  const none = await sampleUntilStable({ read: () => null, deadlineAt: 100, now: () => clock, sleep });
  assert.equal(none.ok, false);
  assert.equal(none.reason, 'no_bounds');

  // read 抛错按「读不到」处理，不把异常漏给调用方
  clock = 0;
  const boom = await sampleUntilStable({
    read: () => { throw new Error('uia boom'); }, deadlineAt: 60, now: () => clock, sleep,
  });
  assert.equal(boom.ok, false);

  // 参数校验
  await assert.rejects(() => sampleUntilStable({}), (e) => e.code === 'computer_invalid_args');
});
