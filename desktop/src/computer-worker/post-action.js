'use strict';
// DEV-CU P3-3：读回验证与 postcondition（§4.8 / §P3-3）—— 备料版。
//
// 纯逻辑：不读窗口、不发 PowerShell。调用方注入 execute / read / now / sleep，
// 便于用假时钟测「50ms 间隔、400ms 上限」而不真等。
//
// 与上游 `crates/core/src/actions/post_action.rs` 对齐：
//   requires_state_readback → 只读回这 8 个动作
//   before 只对 TypeText / Toggle 取
//   Toggle 已知 before.checked 时改写成 Check / Uncheck（上游 :21-29）
//   执行错误且 not_delivered → 立即返回，不读回（:49-53）
//   50ms 轮询 / 400ms 上限 / 未满足才继续（:56-73）
//   读回 true → delivered_verified；null → delivered_unverified（scope unavailable）；
//   false → computer_action_failed + delivered_unverified，**绝不自动重放**（:96-127）

const { WorkerError } = require('./refs');

/** §4.8：需要读回的动作（其余动作直接执行，标 delivered_unverified）。 */
const READBACK_ACTIONS = Object.freeze([
  'set_value', 'type_text', 'clear', 'check', 'uncheck', 'toggle', 'expand', 'collapse',
]);

/** 轮询常量（§4.10：读回轮询 / 上限 50ms / 400ms）。 */
const POST_ACTION_POLL_MS = 50;
const POST_ACTION_CAP_MS = 400;

/** 写值类动作：verified 时的 scope 是 element_value，不是 element_state。 */
const VALUE_WRITERS = Object.freeze(['set_value', 'type_text', 'clear']);

function requiresStateReadback(action) {
  return READBACK_ACTIONS.indexOf(String(action || '')) >= 0;
}

function normalizeNewlines(value) {
  return String(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * 值读回比对（移植上游 `tree/value_matches.rs`）：
 *   - 完全相等 → true
 *   - 换行归一化后相等 → true（RichEdit 系把 \n 读回成 \r / \r\n）
 *   - 数值控件（slider / incrementor / scrollbar / handle）允许 1e-6 容差，
 *     但大整数必须精确（超 2^53 一律 false）
 */
function valueMatches(role, expected, observed) {
  if (observed === undefined || observed === null) return false;
  const exp = String(expected);
  const obs = String(observed);
  if (exp === obs) return true;
  if (normalizeNewlines(exp) === normalizeNewlines(obs)) return true;
  if (!['slider', 'incrementor', 'scrollbar', 'handle'].includes(String(role || ''))) return false;
  const intRe = /^-?[0-9]+$/;
  if (intRe.test(exp) && intRe.test(obs)) {
    try {
      return BigInt(exp) === BigInt(obs);
    } catch {
      return false;
    }
  }
  const a = Number(exp);
  const b = Number(obs);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  if (Math.max(Math.abs(a), Math.abs(b)) >= 9007199254740992) return false;
  return Math.abs(a - b) <= 1e-6;
}

/** UTF-16 索引切分是否落在代理对中间（上游用 from_utf16 的合法性做同一件事）。 */
function hasLoneSurrogate(value) {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(String(value));
}

/**
 * TypeText 的期望文本（上游 `expected_insertion`）：
 *   `before.value` 按选区（UTF-16 索引）splice 插入 `text`。
 * 没给选区时，只有 before 为空才假定插入到 0..0；否则返回 null（证据不足）。
 */
function expectedInsertion(beforeValue, text, selection) {
  const before = beforeValue === undefined || beforeValue === null ? '' : String(beforeValue);
  let start;
  let end;
  if (selection === undefined || selection === null) {
    if (before !== '') return null;
    start = 0;
    end = 0;
  } else if (Array.isArray(selection)) {
    [start, end] = selection;
  } else {
    start = selection.start;
    end = selection.end;
  }
  start = Number(start);
  end = Number(end);
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 0 || end < start || end > before.length) return null;
  const merged = before.slice(0, start) + String(text === undefined || text === null ? '' : text) + before.slice(end);
  if (hasLoneSurrogate(merged)) return null;
  return merged;
}

function hasState(states, name) {
  return Array.isArray(states) && states.indexOf(name) >= 0;
}

/** 三态 checked：states_complete=false 或 indeterminate → null。 */
function checkedOf(state) {
  if (!state || state.states_complete !== true) return null;
  if (typeof state.checked === 'boolean') return state.checked;
  if (hasState(state.states, 'indeterminate')) return null;
  if (hasState(state.states, 'checked')) return true;
  return false;
}

/** 三态 expanded：states_complete=false → null。 */
function expandedOf(state) {
  if (!state || state.states_complete !== true) return null;
  if (typeof state.expanded === 'boolean') return state.expanded;
  return hasState(state.states, 'expanded');
}

/**
 * §4.8 的 postcondition 判定，返回 true / false / null（null = 证据不足）。
 * `before` 只对 toggle / type_text 有意义。
 */
function matchesPostcondition({ action, before, expectedText, expectedValue, observed } = {}) {
  const state = observed || null;
  switch (String(action || '')) {
    case 'set_value':
      // value 读不到 ≠ 不符：安全字段 / 无 ValuePattern 时只能判「证据不足」
      if (!state || state.value === undefined || state.value === null) return null;
      return valueMatches(state.role, expectedValue === undefined ? '' : expectedValue, state.value);
    case 'clear':
      if (!state) return null;
      if (state.value === undefined || state.value === null) return null;
      return String(state.value) === '';
    case 'type_text':
      if (expectedText === null || expectedText === undefined) return null;
      if (!state || state.value === undefined || state.value === null) return null;
      return String(state.value) === expectedText;
    case 'check':
    case 'uncheck': {
      const c = checkedOf(state);
      if (c === null) return null;
      return c === (action === 'check');
    }
    case 'toggle': {
      const b = checkedOf(before);
      const a = checkedOf(state);
      if (b === null || a === null) return null;
      return b !== a;
    }
    case 'expand':
    case 'collapse': {
      const e = expandedOf(state);
      if (e === null) return null;
      return e === (action === 'expand');
    }
    default:
      return null;
  }
}

/** 安全字段（密码框）：value 读不到且带 secure 状态 → 只能判「证据不足」。 */
function secureValueRedacted(action, state) {
  if (VALUE_WRITERS.indexOf(String(action || '')) < 0) return false;
  if (!state) return false;
  const noValue = state.value === undefined || state.value === null;
  return noValue && hasState(state.states, 'secure');
}

/**
 * 选区归一：接受 `[start, end]` 或 `{start, end}`；其它形状返回 `undefined`
 * （→ TypeText 的期望值推不出来 → 证据不足）。只做形状归一，不做越界校验，
 * 越界由 `expectedInsertion` 判 null。
 */
function normalizeSelection(raw) {
  if (raw === undefined || raw === null) return undefined;
  if (Array.isArray(raw) && raw.length === 2) return [Number(raw[0]), Number(raw[1])];
  if (typeof raw === 'object' && 'start' in raw && 'end' in raw) {
    return { start: Number(raw.start), end: Number(raw.end) };
  }
  return undefined;
}

function isNotDelivered(error) {
  return Boolean(error && error.detail && error.detail.disposition
    && error.detail.disposition.delivery === 'not_delivered');
}

function invalid(message) {
  return new WorkerError('computer_invalid_args', message);
}

/**
 * `native.readStateByPath` 的结果 → `matchesPostcondition` 需要的 observed 形状。
 * 读不到（`ok:false` / 无 state）一律返回 `null`：证据不足，不是「不符」。
 */
function toObserved(result) {
  if (!result || result.ok !== true || !result.state) return null;
  return { ...result.state, states_complete: result.states_complete === true };
}

/**
 * `executeActionChain` 把失败包成返回值（`{ok:false, error, detail}`），
 * 而读回流程要靠**异常**才能识别 `not_delivered` 并提前返回（§4.8 步骤 4）。
 * 这里只做形状转换，不改错误码、不改 detail。
 */
function throwIfFailed(result) {
  if (!result || result.ok !== false) return result;
  const code = result.error || 'computer_action_failed';
  const err = new WorkerError(code, result.message || String(code));
  if (result.detail) err.detail = result.detail;
  throw err;
}

/**
 * 执行一次动作并按 §4.8 读回验证（不重放）。
 * 返回 `{ok, action, delivery, verification_scope, verification_reason?, post_state, before}`；
 * 读回不符时抛 `computer_action_failed`（detail 带 post_state 与 delivered_unverified）。
 */
async function executeWithReadback({
  action, expectedValue = '', selection, before: injectedBefore,
  execute, read, now = () => Date.now(), sleep, deadlineAt,
} = {}) {
  if (typeof execute !== 'function') throw invalid('executeWithReadback 需要 execute');
  if (typeof read !== 'function') throw invalid('executeWithReadback 需要 read');
  const waiter = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const act = String(action || '');
  const range = normalizeSelection(selection);

  // 不需要读回：直接执行，按未验证投递返回（§4.8「其它」行）
  if (!requiresStateReadback(act)) {
    const executed = await execute(act);
    return {
      ok: true,
      action: act,
      delivery: 'delivered_unverified',
      verification_scope: 'not_required',
      verification_reason: 'no_postcondition',
      post_state: null,
      before: null,
      executed,
    };
  }

  const wantBefore = act === 'type_text' || act === 'toggle';
  const before = injectedBefore !== undefined
    ? injectedBefore
    : (wantBefore ? await safeRead(read) : null);

  // Toggle 已知当前态 → 改写成 Check / Uncheck（上游 :21-29）
  let effective = act;
  if (act === 'toggle') {
    const c = checkedOf(before);
    if (c !== null) effective = c ? 'uncheck' : 'check';
  }

  let expectedText = null;
  if (act === 'type_text') {
    // before 读不到 → 期望值无从推导，只能判证据不足；
    // 不能把 null 当空串，否则会把「文档本来就非空」的情况误判成不符。
    expectedText = before && before.value !== undefined && before.value !== null
      ? expectedInsertion(before.value, expectedValue, range)
      : null;
  }

  let execution;
  try {
    execution = await execute(effective);
  } catch (error) {
    // 未投递：立即返回，不读回、不重试（上游 :49-53）
    if (isNotDelivered(error)) throw error;
    // 投递结果不确定：仍读一次 after，把证据挂到错误上再抛
    const observed = await safeRead(read);
    const verdict = matchesPostcondition({ action: act, before, expectedText, expectedValue, observed });
    const detail = (error && error.detail) || {};
    error.detail = {
      ...detail,
      kind: detail.kind || 'post_action_verification',
      post_state: observed ? observed.state || observed : null,
    };
    if (verdict !== null) error.detail.postcondition_satisfied = verdict;
    throw error;
  }

  const started = now();
  const hardCap = started + POST_ACTION_CAP_MS;
  const cap = deadlineAt === undefined ? hardCap : Math.min(Number(deadlineAt), hardCap);
  let observed = await safeRead(read);
  while (matchesPostcondition({ action: act, before, expectedText, expectedValue, observed }) === false
    && (cap - now()) > POST_ACTION_POLL_MS) {
    await waiter(POST_ACTION_POLL_MS);
    observed = await safeRead(read);
  }

  const verdict = matchesPostcondition({ action: act, before, expectedText, expectedValue, observed });
  const postState = observed ? (observed.state || observed) : null;

  if (verdict === true) {
    return {
      ok: true,
      action: act,
      delivery: 'delivered_verified',
      verification_scope: VALUE_WRITERS.indexOf(act) >= 0 ? 'element_value' : 'element_state',
      post_state: postState,
      before,
      executed: execution,
    };
  }

  if (verdict === false) {
    const err = new WorkerError('computer_action_failed', '读回状态与期望不符');
    err.detail = {
      kind: 'post_action_verification',
      action: act,
      post_state: postState,
      disposition: { delivery: 'delivered_unverified', retry: 'unsafe' },
      retryable: false,
    };
    throw err;
  }

  // null：证据不足（含安全字段 / states 不全 / 读不到 after）
  return {
    ok: true,
    action: act,
    delivery: 'delivered_unverified',
    verification_scope: 'unavailable',
    verification_reason: secureValueRedacted(act, observed) ? 'secure_field' : 'insufficient_evidence',
    post_state: postState,
    before,
    executed: execution,
  };
}

/** 读不到就返回 null，不把异常泄漏给验证流程（证据不足 ≠ 动作失败）。 */
async function safeRead(read) {
  try {
    return await read();
  } catch {
    return null;
  }
}

module.exports = {
  READBACK_ACTIONS,
  POST_ACTION_POLL_MS,
  POST_ACTION_CAP_MS,
  requiresStateReadback,
  valueMatches,
  hasLoneSurrogate,
  expectedInsertion,
  normalizeSelection,
  checkedOf,
  expandedOf,
  matchesPostcondition,
  secureValueRedacted,
  toObserved,
  throwIfFailed,
  executeWithReadback,
};
