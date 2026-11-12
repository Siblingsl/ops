'use strict';
// DEV-CU P3-1：动作枚举与派发（§4.7 / §P3-1）。
//
// 接线：index.js 的 `uia_invoke` 分支已改走本文件的 enum → dispatch 链
//   index.js → assertAction / inferAction → dispatch(action, target, args) → P3-2 的 pattern 链
// 本段只产出「派发计划」，不执行、不拼 PowerShell 命令名（命令名查静态表）。
// P3-2 的语义动作链在 chain.js，尚未接进执行路径。
//
// 硬化点（§P3-1 步骤 3/4）：
//   - 所有用户文本经 psQuote() 转义（单引号翻倍；PowerShell 单引号串不插值）
//   - value 截断到 32768（与 ipc/computer.ts:73 既有行为一致）
//   - 目标只接受本 grant 快照里的 ref；外部 automation_id / hwnd / 坐标 / 脚本一律拒绝

const { WorkerError, resolveRefTarget } = require('./refs');
const { psQuote } = require('./native');
const { CONTRACT_VERSION, legacyAutomationIdAllowed } = require('./contract');

/** §4.7 的 14 项 worker action，逐字照抄（顺序也是契约的一部分）。 */
const WORKER_ACTIONS = Object.freeze([
  'observe',
  'set_focus',
  'scroll',
  'scroll_to',
  'select',
  'click',
  'toggle',
  'expand',
  'collapse',
  'check',
  'uncheck',
  'set_value',
  'type_text',
  'clear',
]);

const ACTION_SET = new Set(WORKER_ACTIONS);

/** 需要携带文本的动作（其余动作带 value 视为调用方 bug，直接拒绝）。 */
const TEXT_ACTIONS = Object.freeze(['set_value', 'type_text']);

/** 文本上限（ipc/computer.ts:73：`String(value).slice(0, 32768)`）。 */
const VALUE_LIMIT = 32768;

/**
 * 外部目标字段黑名单：这些只能由本进程在观察阶段产生，绝不接受调用方传入。
 * 出现即拒绝（哪怕值是空串），避免「传了但没生效」被误读成支持。
 */
const FORBIDDEN_TARGET_KEYS = Object.freeze([
  'automation_id', 'hwnd', 'handle', 'window_handle',
  'x', 'y', 'point', 'coords', 'bounds',
  'script', 'command', 'powershell', 'ps',
]);

/** 静态命令表：dispatch 只查这张表，不拼字符串（§P3-1 步骤 2）。 */
const ACTION_COMMAND = Object.freeze({
  observe: 'UIA_OBSERVE',
  set_focus: 'UIA_SET_FOCUS',
  scroll: 'UIA_SCROLL',
  scroll_to: 'UIA_SCROLL_TO',
  select: 'UIA_SELECT',
  click: 'UIA_CLICK',
  toggle: 'UIA_TOGGLE',
  expand: 'UIA_EXPAND',
  collapse: 'UIA_COLLAPSE',
  check: 'UIA_CHECK',
  uncheck: 'UIA_UNCHECK',
  set_value: 'UIA_SET_VALUE',
  type_text: 'UIA_TYPE_TEXT',
  clear: 'UIA_CLEAR',
});

function isAction(value) {
  return typeof value === 'string' && ACTION_SET.has(value);
}

/** 枚举外的动作名一律 `computer_action_not_supported`（§4.7 末句）。 */
function assertAction(value) {
  if (!isAction(value)) {
    throw new WorkerError(
      'computer_action_not_supported',
      `动作 ${JSON.stringify(String(value === undefined ? '' : value))} 不在枚举内`,
    );
  }
  return value;
}

/**
 * 旧 IPC 的兼容推断：不带 `action` 时按 value 有无回落。
 * 这段逻辑原先内联在 index.js 的 `uia_invoke` 分支里，抽出来才能单测
 * （否则要起一个真实窗口才能观察到推断结果）。
 * 空串按「未提供」处理，与 `msg.action === ''` 的既有语义一致。
 */
function inferAction(action, value) {
  if (action === undefined || action === null || action === '') {
    return value === null || value === undefined ? 'click' : 'set_value';
  }
  return assertAction(String(action));
}

function invalid(message) {
  return new WorkerError('computer_invalid_args', message);
}

/**
 * 目标校验（§P3-1 步骤 4）：只认 `@<snapshot_id>:e<N>`，且必须落在本次 grant / generation
 * 的同一份快照上。`expected` 由调用方（RefStore 取出后）提供，避免这里再依赖存储。
 */
function normalizeTarget(target, expected = {}) {
  if (!target || typeof target !== 'object') throw invalid('缺少目标 ref');
  for (const key of FORBIDDEN_TARGET_KEYS) {
    if (Object.prototype.hasOwnProperty.call(target, key)) {
      throw invalid(`不接受外部传入的 ${key}；目标必须是本 grant 快照里的 ref`);
    }
  }
  const parsed = resolveRefTarget(target.ref);

  const wantSnapshot = expected.snapshot_id === undefined ? '' : String(expected.snapshot_id || '');
  if (wantSnapshot && parsed.snapshotId !== wantSnapshot) {
    throw invalid('ref 不属于本次快照');
  }
  if (expected.grant_id !== undefined && String(target.grant_id || '') !== String(expected.grant_id || '')) {
    throw invalid('ref 不属于本次授权');
  }
  if (expected.generation !== undefined
    && Number(target.generation || 0) !== Number(expected.generation || 0)) {
    // 代数变化不是「参数写错」，按 §4.9 归到 stale（要重新授权，不是重新观察）
    throw new WorkerError('computer_stale_ref', '租约 generation 已变化，请重新授权');
  }
  return {
    ref: String(target.ref),
    snapshot_id: parsed.snapshotId,
    index: parsed.index,
    grant_id: String(target.grant_id || expected.grant_id || ''),
    generation: Number(target.generation === undefined ? expected.generation : target.generation) || 0,
  };
}

/** 入参归一化：只有文本动作接受 value；统一截断并给出转义后的形态。 */
function normalizeArgs(action, args = {}) {
  const value = args && args.value;
  if (TEXT_ACTIONS.indexOf(action) >= 0) {
    const text = value === undefined || value === null ? '' : String(value);
    return { value: text.slice(0, VALUE_LIMIT), value_ps: psQuote(text.slice(0, VALUE_LIMIT)) };
  }
  if (value !== undefined && value !== null) {
    throw invalid(`动作 ${action} 不接受 value`);
  }
  return {};
}

/**
 * 派发计划（纯函数，不执行）。返回 `{ok, action, command, mechanism, target, args}`：
 *   - `command` 来自静态表，不存在字符串拼接出的命令名
 *   - `mechanism` 恒 `semantic_api`（不做物理投递）
 * P3-2 会用 pattern 链替换 command 的执行语义，输入输出形状保持不变。
 */
function dispatch(action, target, args = {}, expected = {}) {
  assertAction(action);
  const normalizedTarget = normalizeTarget(target, expected);
  const normalizedArgs = normalizeArgs(action, args);
  return {
    ok: true,
    action,
    command: ACTION_COMMAND[action],
    mechanism: 'semantic_api',
    target: normalizedTarget,
    args: normalizedArgs,
  };
}

/** 旧 `automation_id` 分支的开关（§P3-1 步骤 5）；由 contract.js 统一裁决。 */
function legacyTargetAllowed(version = CONTRACT_VERSION) {
  return legacyAutomationIdAllowed(version);
}


// ===========================================================================
// DEV-CU P3-2：语义动作链（§4.7 pattern 链）
// 本段只落「链顺序 + 可用性守卫 + 执行器 + HRESULT 分类」，纯声明与纯函数：
//   - 不执行任何真实动作（`executeChain` 的 run 由调用方注入）
//   - 不拼 PowerShell 命令名，不引入 SendInput / user32 / 坐标点击（§P3-2 明确不改）
// 执行路径的接线（native.js 的 pattern 片段 + index.js 的调用点）在 P3-2 完成。
//
// 与上游 `crates/linux/src/actions/chain/mod.rs::execute_chain` 一致：
//   absent   → 记 skipped，试下一 rung
//   satisfied→ 立即返回 satisfied_without_delivery（AlreadyInState，无副作用）
//   delivered→ 立即返回（verified 决定 delivered_verified / delivered_unverified）
//   耗尽     → computer_action_failed + detail.steps
//   deadline → 立刻停，not_delivered

/** §4.7 的链顺序。label 用表里的英文常量，guard 是可用性守卫。 */
const CHAIN_SPEC = Object.freeze({
  observe: Object.freeze([]),
  click: Object.freeze([
    { label: 'UIInvokePattern.Invoke', guard: 'invoke' },
    { label: 'UILegacyIAccessiblePattern.DoDefaultAction', guard: 'legacy' },
  ]),
  double_click: Object.freeze([
    { label: 'UIInvokePattern.Invoke', guard: 'invoke' },
    { label: 'UILegacyIAccessiblePattern.DoDefaultAction', guard: 'legacy' },
  ]),
  right_click: Object.freeze([
    { label: 'UIInvokePattern.Invoke', guard: 'invoke' },
    { label: 'UILegacyIAccessiblePattern.DoDefaultAction', guard: 'legacy' },
  ]),
  triple_click: Object.freeze([
    { label: 'UIInvokePattern.Invoke', guard: 'invoke' },
    { label: 'UILegacyIAccessiblePattern.DoDefaultAction', guard: 'legacy' },
  ]),
  set_value: Object.freeze([
    { label: 'UIValuePattern.SetValue', guard: 'value_writable' },
    { label: 'UIRangeValuePattern.SetValue', guard: 'range_numeric' },
  ]),
  type_text: Object.freeze([
    { label: 'UIValuePattern.SetValue', guard: 'value_writable' },
    { label: 'UIRangeValuePattern.SetValue', guard: 'range_numeric' },
  ]),
  clear: Object.freeze([
    { label: 'UIValuePattern.SetValue', guard: 'value_writable' },
  ]),
  select: Object.freeze([
    { label: 'UISelectionItemPattern.Select', guard: 'selection_item' },
    { label: 'UIExpandCollapsePattern.Expand', guard: 'expand_collapse' },
  ]),
  toggle: Object.freeze([
    { label: 'UITogglePattern.Toggle', guard: 'toggle' },
    { label: 'UIInvokePattern.Invoke', guard: 'invoke' },
  ]),
  check: Object.freeze([
    { label: 'UITogglePattern.Toggle', guard: 'toggle' },
    { label: 'UIInvokePattern.Invoke', guard: 'invoke' },
  ]),
  uncheck: Object.freeze([
    { label: 'UITogglePattern.Toggle', guard: 'toggle' },
    { label: 'UIInvokePattern.Invoke', guard: 'invoke' },
  ]),
  expand: Object.freeze([
    { label: 'UIExpandCollapsePattern.Expand', guard: 'expand_collapse' },
    { label: 'UIInvokePattern.Invoke', guard: 'invoke' },
  ]),
  collapse: Object.freeze([
    { label: 'UIExpandCollapsePattern.Collapse', guard: 'expand_collapse' },
    { label: 'UIInvokePattern.Invoke', guard: 'invoke' },
  ]),
  scroll: Object.freeze([
    { label: 'UIScrollPattern.Scroll', guard: 'scroll' },
    { label: 'UIScrollItemPattern.ScrollIntoView', guard: 'scroll_item' },
    { label: 'AncestorScrollPattern.Scroll', guard: 'ancestor_scroll' },
  ]),
  scroll_to: Object.freeze([
    { label: 'UIScrollItemPattern.ScrollIntoView', guard: 'scroll_item' },
    { label: 'UIScrollPattern.Scroll', guard: 'scroll' },
    { label: 'AncestorScrollPattern.Scroll', guard: 'ancestor_scroll' },
  ]),
  set_focus: Object.freeze([
    { label: 'UIAutomationElement.SetFocus', guard: 'always' },
  ]),
  press_key: Object.freeze([
    { label: 'UIAutomationElement.SetFocus', guard: 'always' },
  ]),
});

/** guard → features 里的开关名。`always` 无开关。 */
const GUARD_FEATURE = Object.freeze({
  invoke: 'invoke_available',
  legacy: 'legacy_default_action',
  value_writable: 'value_writable',
  range_numeric: 'range_numeric',
  selection_item: 'selection_item_available',
  expand_collapse: 'expand_collapse_available',
  toggle: 'toggle_available',
  scroll: 'scroll_available',
  scroll_item: 'scroll_item_available',
  ancestor_scroll: 'ancestor_scroll_available',
});

/** 只有显式 false / '' / 0 / null 才算「不可用」；未知一律尝试，由 PS 回 absent。 */
function guardOpen(guard, features) {
  if (guard === 'always' || !features) return true;
  const key = GUARD_FEATURE[guard];
  if (!key) return true;
  const v = features[key];
  return !(v === false || v === '' || v === 0 || v === null);
}

/**
 * 生成某个动作的 rung 列表。不给 features 时是「规划视图」（全 rung），
 * 给了 features 时按守卫过滤（执行视图）。
 */
function chainFor(action, features) {
  const spec = CHAIN_SPEC[action];
  if (!spec) return [];
  return spec
    .filter((rung) => guardOpen(rung.guard, features))
    .map((rung) => ({ label: rung.label, guard: rung.guard, mechanism: 'semantic_api' }));
}

/** §4.7 / §P3-2 步骤 10 的 HRESULT 表（值与上游 hresult.rs 一致）。 */
const HRESULT = Object.freeze({
  E_ACCESSDENIED: 0x80070005,
  E_INVALIDARG: 0x80070057,
  UIA_E_ELEMENTNOTENABLED: 0x80040200,
  UIA_E_ELEMENTNOTAVAILABLE: 0x80040201,
  UIA_E_NOTSUPPORTED: 0x80040204,
  UIA_E_TIMEOUT: 0x80131505,
  RPC_E_SERVERFAULT: 0x80010105,
  RPC_E_DISCONNECTED: 0x80010108,
  RPC_S_SERVER_UNAVAILABLE: 0x800706ba,
  RPC_S_CALL_FAILED: 0x800706be,
});

function hresultValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n >>> 0; // 兼容有符号表示（-2147024891 → 0x80070005）
}

/**
 * HRESULT → 结论。返回 `{absent:true}` 表示「这个 rung 不支持，继续下一个」，
 * 其余返回 `{error_code, disposition, retryable}`。
 */
function classifyHresult(value) {
  const h = hresultValue(value);
  const notDelivered = { delivery: 'not_delivered', retry: 'safe' };
  const uncertain = { delivery: 'delivery_uncertain', retry: 'unsafe' };
  if (h === HRESULT.UIA_E_NOTSUPPORTED) return { absent: true };
  switch (h) {
    case HRESULT.E_ACCESSDENIED:
      return { error_code: 'computer_policy_denied', disposition: notDelivered, retryable: false };
    case HRESULT.UIA_E_ELEMENTNOTAVAILABLE:
      return { error_code: 'computer_stale_ref', disposition: notDelivered, retryable: true };
    case HRESULT.E_INVALIDARG:
      return { error_code: 'computer_invalid_args', disposition: notDelivered, retryable: false };
    case HRESULT.UIA_E_ELEMENTNOTENABLED:
      return { error_code: 'computer_action_failed', disposition: notDelivered, retryable: false };
    case HRESULT.RPC_E_SERVERFAULT:
    case HRESULT.RPC_E_DISCONNECTED:
    case HRESULT.RPC_S_SERVER_UNAVAILABLE:
    case HRESULT.RPC_S_CALL_FAILED:
      return { error_code: 'computer_app_unresponsive', disposition: uncertain, retryable: true };
    case HRESULT.UIA_E_TIMEOUT:
      return { error_code: 'computer_timeout', disposition: uncertain, retryable: true };
    default:
      // 未分类：调用方不知道动作有没有落到目标上，只能记 unknown_outcome
      return { error_code: 'computer_action_failed', disposition: uncertain, retryable: false };
  }
}

/**
 * 执行链（依赖注入，便于单测）。`run(rung)` 返回：
 *   `{kind:'absent'}`                 rung 不支持 → 下一个
 *   `{kind:'satisfied'}`              已满足目标态（AlreadyInState）
 *   `{kind:'delivered', verified}`    已投递
 *   `{hresult}`                       失败 → 按表分类
 */
async function executeChain(rungs, { run, now = () => Date.now(), deadlineAt } = {}) {
  if (typeof run !== 'function') {
    throw new WorkerError('computer_invalid_args', 'executeChain 需要 run');
  }
  const steps = [];
  const list = Array.isArray(rungs) ? rungs : [];
  for (const rung of list) {
    if (deadlineAt !== undefined && now() >= Number(deadlineAt)) {
      const err = new WorkerError('computer_timeout', `动作链在 ${rung.label} 前到达 deadline`);
      err.detail = { steps, rung: rung.label, disposition: { delivery: 'not_delivered', retry: 'safe' } };
      throw err;
    }
    const res = await run(rung);
    if (res && res.kind === 'absent') {
      steps.push({ label: rung.label, outcome: 'skipped', cause: 'affordance_absent', mechanism: 'semantic_api' });
      continue;
    }
    if (res && res.kind === 'satisfied') {
      steps.push({ label: rung.label, outcome: 'satisfied', verified: true, mechanism: 'semantic_api' });
      return {
        ok: true, action_satisfied: true, satisfied_without_delivery: true, verified: true, steps,
      };
    }
    if (res && (res.kind === 'delivered' || res.ok === true)) {
      const verified = res.verified === true;
      steps.push({
        label: rung.label, outcome: 'succeeded', verified, mechanism: 'semantic_api',
      });
      return {
        ok: true, action_satisfied: false, satisfied_without_delivery: false, verified, steps,
      };
    }
    const classified = classifyHresult(res && res.hresult);
    if (classified.absent) {
      steps.push({ label: rung.label, outcome: 'skipped', cause: 'uia_not_supported', mechanism: 'semantic_api' });
      continue;
    }
    const err = new WorkerError(classified.error_code, `动作链在 ${rung.label} 失败`);
    err.detail = {
      steps,
      rung: rung.label,
      hresult: hresultValue(res && res.hresult),
      disposition: classified.disposition,
      retryable: classified.retryable,
    };
    throw err;
  }
  const err = new WorkerError('computer_action_failed', '动作链全部耗尽：没有 rung 成功');
  err.detail = {
    steps,
    steps_tried: steps.map((s) => s.label),
    disposition: { delivery: 'not_delivered', retry: 'safe' },
  };
  throw err;
}

module.exports = {
  WORKER_ACTIONS,
  TEXT_ACTIONS,
  VALUE_LIMIT,
  FORBIDDEN_TARGET_KEYS,
  ACTION_COMMAND,
  isAction,
  assertAction,
  inferAction,
  normalizeTarget,
  normalizeArgs,
  dispatch,
  legacyTargetAllowed,
  // P3-2（尚未接线，仅单测直调）
  CHAIN_SPEC,
  GUARD_FEATURE,
  HRESULT,
  guardOpen,
  chainFor,
  classifyHresult,
  executeChain,
};
