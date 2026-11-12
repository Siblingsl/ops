'use strict';
// DEV-CU P3-3：读回验证与 postcondition。
// 覆盖：7 种 postcondition 各正/负/证据不足三例、值比对归一化、UTF-16 插入、
//       50ms 轮询 / 400ms 上限、not_delivered 提前返回、不确定错误补证据、绝不重放；
//       另含 native.readStateByPath 载体单测与 psStateScript 的 PS 解析 / UIA 成员求值。

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  READBACK_ACTIONS, POST_ACTION_POLL_MS, POST_ACTION_CAP_MS,
  requiresStateReadback, valueMatches, expectedInsertion,
  checkedOf, expandedOf, matchesPostcondition, secureValueRedacted,
  normalizeSelection, toObserved, throwIfFailed, executeWithReadback,
} = require('../src/computer-worker/post-action.js');
const native = require('../src/computer-worker/native.js');

const st = (over = {}) => ({
  role: 'textfield',
  states: ['enabled', 'visible'],
  states_complete: true,
  value: '',
  ...over,
});

/** 直接跑一次「执行 → 读回」。默认用假时钟，避免负数用例真的等 400ms。 */
async function run(action, opts = {}) {
  const { observed, before, ...rest } = opts;
  let clock = 0;
  return executeWithReadback({
    action,
    expectedValue: '',
    execute: async () => ({ ok: true }),
    read: async () => observed,
    before,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    ...rest,
  });
}

test('P3-3: 需要读回的动作恰好 8 个', () => {
  assert.deepEqual(READBACK_ACTIONS, [
    'set_value', 'type_text', 'clear', 'check', 'uncheck', 'toggle', 'expand', 'collapse',
  ]);
  for (const action of READBACK_ACTIONS) assert.equal(requiresStateReadback(action), true);
  for (const action of ['click', 'set_focus', 'scroll', 'observe', 'select']) {
    assert.equal(requiresStateReadback(action), false);
  }
});

test('P3-3 SetValue: 匹配 / 不符 / 证据不足', async () => {
  // 正：换行归一化后相等（RichEdit 把 \n 读回成 \r\n）
  const ok = await run('set_value', {
    expectedValue: 'a\nb', observed: st({ value: 'a\r\nb' }),
  });
  assert.equal(ok.delivery, 'delivered_verified');
  assert.equal(ok.verification_scope, 'element_value');

  // 负
  await assert.rejects(() => run('set_value', { expectedValue: 'x', observed: st({ value: 'y' }) }),
    (e) => {
      assert.equal(e.code, 'computer_action_failed');
      assert.deepEqual(e.detail.disposition, { delivery: 'delivered_unverified', retry: 'unsafe' });
      return true;
    });

  // 证据不足：读不到 value（安全字段）
  const unknown = await run('set_value', { expectedValue: 'x', observed: st({ value: undefined }) });
  assert.equal(unknown.delivery, 'delivered_unverified');
  assert.equal(unknown.verification_scope, 'unavailable');
  assert.equal(unknown.verification_reason, 'insufficient_evidence');
});

test('P3-3 Clear: 空串通过 / 非空失败 / 读不到为证据不足', async () => {
  assert.equal((await run('clear', { observed: st({ value: '' }) })).delivery, 'delivered_verified');
  await assert.rejects(() => run('clear', { observed: st({ value: 'x' }) }),
    (e) => e.code === 'computer_action_failed');
  const unknown = await run('clear', { observed: st({ value: null }) });
  assert.equal(unknown.verification_reason, 'insufficient_evidence');
});

test('P3-3 TypeText: 按选区 splice 后的期望值比对', async () => {
  // 正：before='ab'，在 1..1 插入 'X' → 'aXb'
  const ok = await run('type_text', {
    expectedValue: 'X',
    selection: { start: 1, end: 1 },
    before: st({ value: 'ab' }),
    observed: st({ value: 'aXb' }),
  });
  assert.equal(ok.delivery, 'delivered_verified');

  // 负：实际没插进去
  await assert.rejects(() => run('type_text', {
    expectedValue: 'X', selection: { start: 1, end: 1 }, before: st({ value: 'ab' }), observed: st({ value: 'ab' }),
  }), (e) => e.code === 'computer_action_failed');

  // 证据不足：没给选区且 before 非空 → 无法推出期望值
  const unknown = await run('type_text', {
    expectedValue: 'X', before: st({ value: 'ab' }), observed: st({ value: 'aXb' }),
  });
  assert.equal(unknown.verification_reason, 'insufficient_evidence');

  // 替换选区（1..2 覆盖 'b'）
  assert.equal(expectedInsertion('ab', 'X', { start: 1, end: 2 }), 'aX');
  // before 为空时可省略选区
  assert.equal(expectedInsertion('', 'X'), 'X');
  // UTF-16：emoji 占 2 个单元；插入点 2 落在 emoji 之后（'🙂a' 长度 3）
  assert.equal(expectedInsertion('🙂a', 'X', { start: 2, end: 2 }), '🙂Xa');
  // 切在 emoji 中间（1）会产生孤立代理 → 返回 null
  assert.equal(expectedInsertion('🙂a', 'X', { start: 1, end: 1 }), null);
  // 越界 / 非整数 / 反向选区
  assert.equal(expectedInsertion('ab', 'X', { start: 0, end: 9 }), null);
  assert.equal(expectedInsertion('ab', 'X', { start: 0.5, end: 1 }), null);
  assert.equal(expectedInsertion('ab', 'X', { start: 2, end: 1 }), null);
});

test('P3-3 Check / Uncheck: 目标态与证据不足', async () => {
  assert.equal((await run('check', { observed: st({ checked: true }) })).delivery, 'delivered_verified');
  await assert.rejects(() => run('check', { observed: st({ checked: false }) }),
    (e) => e.code === 'computer_action_failed');
  const unknown = await run('check', { observed: st({ checked: true, states_complete: false }) });
  assert.equal(unknown.verification_reason, 'insufficient_evidence');
  // indeterminate 也算证据不足
  const indet = await run('check', { observed: st({ states: ['indeterminate'], states_complete: true }) });
  assert.equal(indet.verification_reason, 'insufficient_evidence');

  assert.equal((await run('uncheck', { observed: st({ checked: false }) })).delivery, 'delivered_verified');
  await assert.rejects(() => run('uncheck', { observed: st({ checked: true }) }),
    (e) => e.code === 'computer_action_failed');
});

test('P3-3 Toggle: before 与 after 必须相反，且改写为 Check/Uncheck', async () => {
  const seen = [];
  const ok = await run('toggle', {
    before: st({ checked: true }),
    observed: st({ checked: false }),
    execute: async (action) => { seen.push(action); return { ok: true }; },
  });
  assert.deepEqual(seen, ['uncheck'], '已知 checked=true → 动作改写成 uncheck');
  assert.equal(ok.action, 'toggle');
  assert.equal(ok.delivery, 'delivered_verified');
  assert.equal(ok.verification_scope, 'element_state', 'toggle 的 scope 是元素状态，不是值');

  // 负：前后一样（没变）→ 失败
  await assert.rejects(() => run('toggle', {
    before: st({ checked: true }), observed: st({ checked: true }),
  }), (e) => e.code === 'computer_action_failed');

  // 证据不足：before 状态不全
  const unknown = await run('toggle', {
    before: st({ checked: true, states_complete: false }), observed: st({ checked: false }),
  });
  assert.equal(unknown.verification_reason, 'insufficient_evidence');

  // before 未知时保持 toggle 原样，不改写
  const seen2 = [];
  await run('toggle', {
    before: st({ states_complete: false }), observed: st({ checked: true }),
    execute: async (a) => { seen2.push(a); return { ok: true }; },
  });
  assert.deepEqual(seen2, ['toggle']);
});

test('P3-3 Expand / Collapse: 要求 states_complete', async () => {
  assert.equal((await run('expand', { observed: st({ expanded: true }) })).delivery, 'delivered_verified');
  await assert.rejects(() => run('expand', { observed: st({ expanded: false }) }),
    (e) => e.code === 'computer_action_failed');
  const unknown = await run('expand', { observed: st({ expanded: true, states_complete: false }) });
  assert.equal(unknown.verification_reason, 'insufficient_evidence');

  assert.equal((await run('collapse', { observed: st({ expanded: false }) })).delivery, 'delivered_verified');
  await assert.rejects(() => run('collapse', { observed: st({ expanded: true }) }),
    (e) => e.code === 'computer_action_failed');
});

test('P3-3: 不需要读回的动作直接执行，不读状态', async () => {
  let reads = 0;
  const result = await executeWithReadback({
    action: 'click',
    execute: async () => ({ ok: true }),
    read: async () => { reads += 1; return st(); },
  });
  assert.equal(reads, 0, 'click 不该读回');
  assert.equal(result.delivery, 'delivered_unverified');
  assert.equal(result.verification_scope, 'not_required');
});

test('P3-3: 50ms 轮询，未满足才继续，满足即停', async () => {
  let clock = 0;
  const sleeps = [];
  const seq = [st({ value: 'x' }), st({ value: 'x' }), st({ value: 'ok' })];
  let i = 0;
  const result = await executeWithReadback({
    action: 'set_value',
    expectedValue: 'ok',
    execute: async () => ({ ok: true }),
    read: async () => seq[Math.min(i++, seq.length - 1)],
    now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
  });
  assert.equal(result.delivery, 'delivered_verified');
  assert.deepEqual(sleeps, [POST_ACTION_POLL_MS, POST_ACTION_POLL_MS]);
  assert.equal(POST_ACTION_POLL_MS, 50);
});

test('P3-3: 一直不匹配 → 400ms 上限后失败（不无限轮询）', async () => {
  let clock = 0;
  const sleeps = [];
  await assert.rejects(
    () => executeWithReadback({
      action: 'set_value',
      expectedValue: 'never',
      execute: async () => ({ ok: true }),
      read: async () => st({ value: 'x' }),
      now: () => clock,
      sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    }),
    (e) => {
      assert.equal(e.code, 'computer_action_failed');
      assert.deepEqual(e.detail.disposition, { delivery: 'delivered_unverified', retry: 'unsafe' });
      assert.equal(e.detail.post_state.value, 'x');
      return true;
    },
  );
  assert.ok(clock <= POST_ACTION_CAP_MS, `不得超 400ms，实际 ${clock}`);
  assert.ok(sleeps.length >= 6, `应轮询若干次，实际 ${sleeps.length}`);
  assert.ok(sleeps.every((ms) => ms === POST_ACTION_POLL_MS));
  assert.equal(POST_ACTION_CAP_MS, 400);
});

test('P3-3: not_delivered 立即返回，不读回、不重试', async () => {
  let reads = 0;
  let executes = 0;
  const denied = Object.assign(new Error('门禁拒绝'), {
    code: 'computer_policy_denied',
    detail: { disposition: { delivery: 'not_delivered', retry: 'safe' } },
  });
  await assert.rejects(
    () => executeWithReadback({
      action: 'set_value',
      expectedValue: 'x',
      execute: async () => { executes += 1; throw denied; },
      read: async () => { reads += 1; return st({ value: 'x' }); },
    }),
    (e) => {
      assert.equal(e, denied, '原始错误对象应原样抛出');
      return true;
    },
  );
  assert.equal(reads, 0, 'not_delivered 不该读回');
  assert.equal(executes, 1, '绝不重试');
});

test('P3-3: 不确定错误仍读一次 after，把证据挂到错误上', async () => {
  let reads = 0;
  const uncertain = Object.assign(new Error('RPC 超时'), {
    code: 'computer_app_unresponsive',
    detail: { disposition: { delivery: 'delivery_uncertain', retry: 'unsafe' } },
  });
  await assert.rejects(
    () => executeWithReadback({
      action: 'set_value',
      expectedValue: 'x',
      execute: async () => { throw uncertain; },
      read: async () => { reads += 1; return st({ value: 'x' }); },
    }),
    (e) => {
      assert.equal(e.code, 'computer_app_unresponsive');
      assert.equal(e.detail.postcondition_satisfied, true, '读回其实已满足，要如实记录');
      assert.equal(e.detail.post_state.value, 'x');
      return true;
    },
  );
  assert.equal(reads, 1);
});

test('P3-3: 值比对移植上游口径（换行 / 数值容差 / 大整数）', () => {
  // 换行归一化
  assert.equal(valueMatches('textfield', 'a\nb', 'a\r\nb'), true);
  assert.equal(valueMatches('textfield', 'a\nb', 'a\rb'), true);
  assert.equal(valueMatches('textfield', 'a\nb\nc', 'a\r\nb\rc'), true);
  assert.equal(valueMatches('textfield', 'hello 123', 'hello 123 '), false);
  assert.equal(valueMatches('textfield', 'a\n', 'a'), false);
  // 数值控件容差
  assert.equal(valueMatches('slider', '50', '50.00'), true);
  assert.equal(valueMatches('slider', '50', '50.0000004'), true);
  assert.equal(valueMatches('incrementor', '1000000000', '1000000001'), false);
  assert.equal(valueMatches('incrementor', '1000000000', '1000000001.0'), false);
  assert.equal(valueMatches('incrementor', '9007199254740993', '9007199254740992'), false);
  assert.equal(valueMatches('slider', '1', 'inf'), false);
  // 非数值角色不做数值兜底
  assert.equal(valueMatches('textfield', '001', '1'), false);
  // 读不到一律 false（是否算证据不足由 matchesPostcondition 决定）
  assert.equal(valueMatches('textfield', 'x', null), false);
  // checked / expanded 三态
  assert.equal(checkedOf(st({ checked: true })), true);
  assert.equal(checkedOf(st({ checked: true, states_complete: false })), null);
  assert.equal(checkedOf(st({ states: ['indeterminate'] })), null);
  assert.equal(checkedOf(st({ states: ['checked'] })), true);
  assert.equal(expandedOf(st({ expanded: false })), false);
  assert.equal(expandedOf(st({ expanded: false, states_complete: false })), null);
  // 未知动作没有 postcondition
  assert.equal(matchesPostcondition({ action: 'click', observed: st() }), null);
});

test('P3-3: normalizeSelection 形状归一（非法形状不越界校验）', () => {
  assert.deepEqual(normalizeSelection({ start: 1, end: 2 }), { start: 1, end: 2 });
  assert.deepEqual(normalizeSelection([3, 4]), [3, 4]);
  assert.equal(normalizeSelection(undefined), undefined);
  assert.equal(normalizeSelection(null), undefined);
  assert.equal(normalizeSelection('0..1'), undefined, '字符串不是合法形状');
  assert.equal(normalizeSelection({ start: 1 }), undefined, '缺 end');
  assert.equal(normalizeSelection([1]), undefined, '长度 1 的数组');
  // 归一只转数字，越界/反向留给 expectedInsertion 判 null
  assert.deepEqual(normalizeSelection('5'), undefined);
  const loose = normalizeSelection({ start: '2', end: '7' });
  assert.deepEqual(loose, { start: 2, end: 7 });
});

test('P3-3: toObserved 把 readStateByPath 结果归一成判定侧形状', () => {
  // ok:false → null（证据不足），绝不折成「不符」
  assert.equal(toObserved(null), null);
  assert.equal(toObserved({ ok: false, error: 'control_not_found' }), null);
  assert.equal(toObserved({ ok: true, state: null }), null);
  assert.equal(toObserved({ ok: true }), null);
  // states_complete 必须显式 === true，1 / 'true' / undefined 都不算。
  // role 归一发生在 native.normalizeStateRecord（readStateByPath 内）；toObserved 只做
  // 形状适配并透传——roleFor 对已归一的角色不幂等（'textfield' 会变 unknown），不能在这里重做。
  const full = toObserved({
    ok: true,
    states_complete: true,
    state: { role: 'textfield', states: ['enabled'], value: 'x' },
  });
  assert.equal(full.states_complete, true);
  assert.equal(full.role, 'textfield');
  assert.deepEqual(full.states, ['enabled']);
  // ConvertTo-Json 的 null 漂移由 native.normalizeStateRecord 归一（见下一用例）；
  // toObserved 对缺省字段透传 undefined，判定侧（checkedOf/expandedOf/valueMatches）
  // 对 undefined 与 null 同样落「证据不足」。
  const partial = toObserved({ ok: true, states_complete: false, state: { states: [] } });
  assert.equal(partial.states_complete, false);
  assert.equal(partial.value ?? null, null);
  assert.equal(partial.checked ?? null, null);
  assert.equal(partial.enabled ?? null, null);
  assert.equal(partial.hidden ?? null, null);
  assert.equal(partial.offscreen ?? null, null);
  assert.equal(partial.expanded ?? null, null);
  assert.equal(Boolean(partial.secure), false);
  assert.equal(Boolean(partial.focused), false);
  assert.equal(Boolean(partial.selected), false);
  assert.equal(Boolean(partial.value_writable), false);
});

test('P3-3: throwIfFailed 只做形状转换，不改码与 detail', async () => {
  // ok:true 原样透传
  const ok = { ok: true, label: 'UIValuePattern.SetValue' };
  assert.equal(throwIfFailed(ok), ok);
  // ok:false → 抛 WorkerError，码/detail 原样
  await assert.rejects(async () => {
    throwIfFailed({
      ok: false,
      error: 'computer_policy_denied',
      message: '门禁拒绝',
      detail: { kind: 'denied', disposition: { delivery: 'not_delivered', retry: 'safe' } },
    });
  }, (e) => {
    assert.equal(e.code, 'computer_policy_denied');
    assert.equal(e.message, '门禁拒绝');
    assert.deepEqual(e.detail.disposition, { delivery: 'not_delivered', retry: 'safe' });
    return true;
  });
  // 缺 error 码时兜底 computer_action_failed，不吞原始语义
  await assert.rejects(async () => { throwIfFailed({ ok: false, message: 'x' }); },
    (e) => e.code === 'computer_action_failed');
});

test('P3-3: readStateByPath 归一 PS 输出（夹具注入，不依赖真窗口）', async () => {
  // 只验证 native.readStateByPath 的归一层：用 undefined pid 会在 psJson 里失败，
  // 但归一逻辑与 toObserved 相同，这里直接用返回形状断言锁住接口面。
  assert.equal(typeof native.readStateByPath, 'function');
  assert.equal(typeof native.psStateScript, 'function');
  assert.equal(typeof native.normalizeStateRecord, 'function');
  // normalizeStateRecord 的口径与 toObserved 一致：ProgrammaticName → role、null 归一
  const rec = native.normalizeStateRecord({
    role: 'ControlType.Edit',
    states: ['enabled'],
    value: 'v',
    enabled: true,
    checked: null,
  });
  assert.equal(rec.role, 'textfield');
  assert.deepEqual(rec.states, ['enabled']);
  assert.equal(rec.value, 'v');
  assert.equal(rec.checked, null);
  assert.equal(rec.states_complete, undefined, 'states_complete 不在 state 内，由外层承载');
});

test('P3-3: psStateScript 可被 PS parser 解析，且引用的 UIA 成员都存在', { timeout: 120_000 }, async (t) => {
  if (process.platform !== 'win32') { t.skip('需要 Windows'); return; }
  const os = require('node:os');
  const fsx = require('node:fs');
  const dir = fsx.mkdtempSync(path.join(os.tmpdir(), 'ops-p33-'));
  t.after(() => { try { fsx.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  // 每条路径深度各生成一次真实脚本文本（含单引号场景由 psQuote 在 pid/path 之外不涉及，
  // state 脚本无文本入参；路径深度覆盖 0/1/多级）
  const files = [];
  const depths = [[], [0], [0, 1, 2]];
  depths.forEach((p, i) => {
    const name = `state_${i}.ps1`;
    fsx.writeFileSync(path.join(dir, name), native.psStateScript(4242, p), 'utf8');
    files.push(name);
  });

  // ① 语法：用脚本引擎自己的 parser 解析每个片段
  const parseScript = [
    '$out = @()',
    `foreach ($f in Get-ChildItem -LiteralPath ${native.psQuote(dir)} -Filter *.ps1) {`,
    '  $errs = $null',
    '  [void][System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$null, [ref]$errs)',
    '  $msgs = @()',
    '  if ($errs) { foreach ($e in $errs) { $msgs += [string]$e.Message } }',
    '  $out += @{ name = $f.Name; errors = $msgs }',
    '}',
    '@{ files = $out } | ConvertTo-Json -Compress -Depth 4',
  ].join('\n');
  const parsed = await native.runPowerShell(parseScript);
  assert.equal(parsed.ok, true, parsed.error || '');
  const report = JSON.parse(parsed.stdout || '{"files":[]}');
  assert.equal(report.files.length, files.length, '每条路径深度都应生成一个片段文件');
  for (const item of report.files) {
    assert.deepEqual(item.errors, [], `${item.name} 有语法错误`);
  }

  // ② 引用：psStateScript 引用的 UIA 类型/枚举/属性逐个求值（照抄 P3-2 的验证口径）
  const refScript = [
    "Add-Type -AssemblyName UIAutomationClient",
    "Add-Type -AssemblyName UIAutomationTypes",
    '$checks = [ordered]@{}',
    "try { $checks['ValuePattern'] = [System.Windows.Automation.ValuePattern].Name } catch { $checks['ValuePattern'] = 'ABSENT' }",
    "try { $checks['RangeValuePattern'] = [System.Windows.Automation.RangeValuePattern].Name } catch { $checks['RangeValuePattern'] = 'ABSENT' }",
    "try { $checks['TogglePattern'] = [System.Windows.Automation.TogglePattern].Name } catch { $checks['TogglePattern'] = 'ABSENT' }",
    "try { $checks['ExpandCollapse'] = [System.Windows.Automation.ExpandCollapsePattern].Name } catch { $checks['ExpandCollapse'] = 'ABSENT' }",
    "try { $checks['SelectionItem'] = [System.Windows.Automation.SelectionItemPattern].Name } catch { $checks['SelectionItem'] = 'ABSENT' }",
    "try { $checks['ToggleState.On'] = [string][System.Windows.Automation.ToggleState]::On } catch { $checks['ToggleState.On'] = 'ABSENT' }",
    "try { $checks['ToggleState.Off'] = [string][System.Windows.Automation.ToggleState]::Off } catch { $checks['ToggleState.Off'] = 'ABSENT' }",
    "try { $checks['ToggleState.Indet'] = [string][System.Windows.Automation.ToggleState]::Indeterminate } catch { $checks['ToggleState.Indet'] = 'ABSENT' }",
    "try { $checks['Expanded'] = [string][System.Windows.Automation.ExpandCollapseState]::Expanded } catch { $checks['Expanded'] = 'ABSENT' }",
    "try { $checks['Collapsed'] = [string][System.Windows.Automation.ExpandCollapseState]::Collapsed } catch { $checks['Collapsed'] = 'ABSENT' }",
    "try { $checks['PartiallyExpanded'] = [string][System.Windows.Automation.ExpandCollapseState]::PartiallyExpanded } catch { $checks['PartiallyExpanded'] = 'ABSENT' }",
    "try { $checks['IsValueAvailable'] = [string][System.Windows.Automation.AutomationElement]::IsValuePatternAvailableProperty } catch { $checks['IsValueAvailable'] = 'ABSENT' }",
    "try { $checks['IsRangeAvailable'] = [string][System.Windows.Automation.AutomationElement]::IsRangeValuePatternAvailableProperty } catch { $checks['IsRangeAvailable'] = 'ABSENT' }",
    "try { $checks['IsToggleAvailable'] = [string][System.Windows.Automation.AutomationElement]::IsTogglePatternAvailableProperty } catch { $checks['IsToggleAvailable'] = 'ABSENT' }",
    "try { $checks['IsExpandAvailable'] = [string][System.Windows.Automation.AutomationElement]::IsExpandCollapsePatternAvailableProperty } catch { $checks['IsExpandAvailable'] = 'ABSENT' }",
    "try { $checks['IsSelectionAvailable'] = [string][System.Windows.Automation.AutomationElement]::IsSelectionItemPatternAvailableProperty } catch { $checks['IsSelectionAvailable'] = 'ABSENT' }",
    '@{ checks = $checks } | ConvertTo-Json -Compress -Depth 4',
  ].join('\n');
  const refs = await native.runPowerShell(refScript);
  assert.equal(refs.ok, true, `${refs.error || ''}（说明有 UIA 成员不存在，脚本已中断）`);
  const found = JSON.parse(refs.stdout || '{"checks":{}}').checks || {};
  for (const [key, value] of Object.entries(found)) {
    assert.notEqual(value, 'ABSENT', `UIA 成员不存在：${key}`);
    assert.ok(String(value).length > 0, `UIA 成员不存在或为空：${key}`);
  }
  assert.equal(Object.keys(found).length, 16, '成员清单不得缩水');
});

test('P3-3: 真实记事本上的读回验证（OPS_UIA_SPAWN=1 opt-in）', { timeout: 180_000 }, async (t) => {
  if (process.platform !== 'win32') { t.skip('需要 Windows'); return; }
  if (process.env.OPS_UIA_SPAWN !== '1') { t.skip('未设 OPS_UIA_SPAWN=1'); return; }

  const { spawn } = require('node:child_process');

  const findNotepad = async () => {
    const listed = await native.listWindows();
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
  t.after(() => { if (spawned) { try { spawned.kill(); } catch { /* 已退出 */ } } });
  assert.ok(pid > 0, '没有可用的记事本窗口');

  // 与 P3-2 相同：真实动作前必须把目标提到前台，做不到就跳过，不当失败。
  // activate 脚本与 computer-worker-chain.test.cjs 的已验证版本保持一致。
  const activate = async (hwnd, targetPid) => {
    const script = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName Microsoft.VisualBasic
Add-Type -Namespace OpsAct -Name N -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr hWnd);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint lpdwProcessId);
[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
'@
$h = [System.IntPtr]${Number(hwnd)}
$fg = [OpsAct.N]::GetForegroundWindow()
$fgPid = 0
$fgThread = [OpsAct.N]::GetWindowThreadProcessId($fg, [ref]$fgPid)
$myThread = [OpsAct.N]::GetCurrentThreadId()
[void][OpsAct.N]::AttachThreadInput($myThread, $fgThread, $true)
$set = [OpsAct.N]::SetForegroundWindow($h)
[void][OpsAct.N]::AttachThreadInput($myThread, $fgThread, $false)
Start-Sleep -Milliseconds 200
$now = [long][OpsAct.N]::GetForegroundWindow()
if ($now -ne [long]$h) {
  try { [void][Microsoft.VisualBasic.Interaction]::AppActivate(${Number(targetPid)}) } catch {}
}
Start-Sleep -Milliseconds 200
$now2 = [long][OpsAct.N]::GetForegroundWindow()
@{ ok = ($now2 -eq [long]$h); set = $set; before = $now; foreground = $now2 } | ConvertTo-Json -Compress
`;
    const r = await native.runPowerShell(script);
    if (!r.ok) return { ok: false };
    try { return JSON.parse(r.stdout || '{}'); } catch { return { ok: false }; }
  };

  // 读树，找编辑区（role=textfield）
  let snap = null;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    snap = await native.readUIA(pid);
    if (snap.ok && snap.refmap && [...snap.refmap.inner.values()].some((e) => e.role === 'textfield')) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.ok(snap && snap.ok, '读树应成功');
  const entry = [...snap.refmap.inner.values()].find((e) => e.role === 'textfield');
  assert.ok(entry, '记事本应有可编辑区');

  const hwnd = (snap.window_identity && snap.window_identity.hwnd) || 0;
  assert.ok(hwnd > 0, '应采到窗口 hwnd');
  const act = await activate(hwnd, pid);
  if (!act.ok) { t.skip(`无法把记事本提到前台（${JSON.stringify(act)}），本机当前会话不可交互`); return; }

  const { executeWithReadback, throwIfFailed, toObserved } = require('../src/computer-worker/post-action.js');
  const stamp = `P33-${Date.now()}`;

  // 1) set_value + 读回：应当 delivered_verified，且读回值含写入串
  const done = await executeWithReadback({
    action: 'set_value',
    expectedValue: stamp,
    execute: (effective) => native.executeActionChain(pid, entry.path, effective, stamp).then(throwIfFailed),
    read: () => native.readStateByPath(pid, entry.path).then(toObserved),
  });
  assert.equal(done.delivery, 'delivered_verified', `读回应验证通过：${JSON.stringify(done.post_state || {})}`);
  assert.equal(done.verification_scope, 'element_value');
  assert.ok(String((done.post_state && done.post_state.value) || '').includes(stamp), '读回应含写入文本');
  assert.equal(done.action, 'set_value');

  // 2) clear + 读回：值应清空 → delivered_verified
  const cleared = await executeWithReadback({
    action: 'clear',
    execute: (effective) => native.executeActionChain(pid, entry.path, effective, '').then(throwIfFailed),
    read: () => native.readStateByPath(pid, entry.path).then(toObserved),
  });
  assert.equal(cleared.delivery, 'delivered_verified', `clear 读回应验证：${JSON.stringify(cleared.post_state || {})}`);
  assert.equal(String((cleared.post_state && cleared.post_state.value) || ''), '', '读回值应为空');

  // 3) 读回不符（把 expectedValue 换成没写入的串）→ computer_action_failed + retry unsafe
  await assert.rejects(() => executeWithReadback({
    action: 'set_value',
    expectedValue: `${stamp}-MISMATCH`,
    execute: (effective) => native.executeActionChain(pid, entry.path, effective, `${stamp}-ACTUAL`).then(throwIfFailed),
    read: () => native.readStateByPath(pid, entry.path).then(toObserved),
  }), (e) => {
    assert.equal(e.code, 'computer_action_failed');
    assert.deepEqual(e.detail.disposition, { delivery: 'delivered_unverified', retry: 'unsafe' });
    assert.ok(String((e.detail.post_state && e.detail.post_state.value) || '').includes(`${stamp}-ACTUAL`));
    return true;
  });
});
