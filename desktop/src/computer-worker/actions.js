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
};
