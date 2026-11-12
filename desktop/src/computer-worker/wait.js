'use strict';
// DEV-CU P3-5：post-action wait（限定 selector，§P3-5）。
//
// 纯逻辑：观察由调用方注入（固定 §4.9 的 pinned scope，本文件不跟随焦点）。
// 只支持 `role` 与 `role:text` 两维，不实现上游完整 selector 语法。
//
// 约定：
//   - 先观察一次，命中即返回；未命中才看 deadline、再等 100ms
//   - 超时（600ms detached deadline）补一次诊断快照，抛 computer_timeout +
//     detail.kind = "wait_timeout" + predicate = "selector" + last_error
//   - 临时错误（computer_timeout / computer_app_unresponsive 且 retryable !== false）继续
//   - 进程/窗口消失 → 立即终止，不空转到超时
//   - wait 本身不产生任何动作（不点击、不输入）

const { WorkerError } = require('./refs');

const WAIT_POLL_MS = 100;
const WAIT_TIMEOUT_MS = 600;

/** 临时错误：可以继续等；其它错误一律终止。 */
const TRANSIENT_ERRORS = Object.freeze(['computer_timeout', 'computer_app_unresponsive']);

/**
 * 解析调用方传入的 wait 入参（§P3-5 步骤 1 的归一层，dispatch 侧只管校验与透传）。
 * 接受 `false/undefined/null`（不等待）、字符串 selector（默认超时）、
 * `{selector, timeout_ms?}` 对象；其它形状 → computer_invalid_args。
 */
function normalizeWaitInput(raw, { maxTimeoutMs = WAIT_TIMEOUT_MS } = {}) {
  if (raw === undefined || raw === null || raw === false) return null;
  if (typeof raw === 'string') return { selector: raw, timeout_ms: maxTimeoutMs };
  if (typeof raw === 'object' && typeof raw.selector === 'string') {
    let ms = maxTimeoutMs;
    if (raw.timeout_ms !== undefined && raw.timeout_ms !== null) {
      ms = Number(raw.timeout_ms);
      if (!Number.isInteger(ms) || ms <= 0 || ms > maxTimeoutMs) {
        throw new WorkerError('computer_invalid_args', `wait.timeout_ms 必须是 1..${maxTimeoutMs} 的整数`);
      }
    }
    return { selector: raw.selector, timeout_ms: ms };
  }
  throw new WorkerError('computer_invalid_args', 'wait 必须是 selector 字符串或 {selector, timeout_ms?}');
}

/**
 * 解析 selector：非空字符串，按**首个** `:` 拆成 role 与 has_text。
 * `role:text` 的 text 为空时视为只按 role 匹配。其余形态 → computer_invalid_args。
 */
function validateSelector(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new WorkerError('computer_invalid_args', 'selector 不能为空');
  }
  const value = raw.trim();
  const i = value.indexOf(':');
  const role = (i < 0 ? value : value.slice(0, i)).trim();
  const hasText = i < 0 ? '' : value.slice(i + 1).trim();
  if (!role) {
    throw new WorkerError('computer_invalid_args', 'selector 缺少 role');
  }
  if (/\s/.test(role)) {
    throw new WorkerError('computer_invalid_args', `selector 的 role 不能含空白：${role}`);
  }
  return { raw: value, role, has_text: hasText };
}

/** 节点是否命中 selector（role 精确、text 子串）。 */
function selectorMatches(selector, node) {
  if (!node || String(node.role || '') !== selector.role) return false;
  if (!selector.has_text) return true;
  return String(node.name || '').indexOf(selector.has_text) >= 0;
}

function isTransient(obs) {
  if (!obs) return false;
  if (obs.retryable === false) return false;
  return TRANSIENT_ERRORS.indexOf(String(obs.error_code || '')) >= 0;
}

function goneEvidence(obs) {
  const state = (obs && (obs.process_state || (obs.gone ? 'exited' : ''))) || 'unavailable';
  return { owner_unavailable: state };
}

/**
 * 轮询到命中 / 终止 / 超时。
 * `observe(selector)` 返回：
 *   `{ok:true, node, complete}`            一次观察
 *   `{ok:false, error_code, retryable}`    观察失败
 *   `{ok:false, gone:true, process_state}` 窗口/进程消失
 * `diagnose(selector)` 可选，超时时补一次诊断快照。
 */
async function pollSelector({
  selector, observe, diagnose, now = () => Date.now(), sleep, timeoutMs = WAIT_TIMEOUT_MS,
} = {}) {
  if (typeof observe !== 'function') throw new WorkerError('computer_invalid_args', 'pollSelector 需要 observe');
  const parsed = validateSelector(selector);
  const waiter = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const deadline = now() + (Number(timeoutMs) > 0 ? Number(timeoutMs) : WAIT_TIMEOUT_MS);

  let attempts = 0;
  let lastError = null;
  let lastComplete = false;

  for (;;) {
    attempts += 1;
    const obs = await observe(parsed);

    if (obs && obs.ok && obs.node) {
      lastComplete = obs.complete === true;
      if (selectorMatches(parsed, obs.node)) {
        return {
          ok: true,
          matched: true,
          selector: parsed,
          attempts,
          evidence: { matches: true, complete: lastComplete },
        };
      }
      lastError = { kind: 'no_match', role: String(obs.node.role || '') };
    } else if (obs && obs.ok) {
      lastComplete = obs.complete === true;
      lastError = { kind: 'no_match' };
    } else if (obs && (obs.gone === true || obs.process_state === 'exited')) {
      // 窗口/进程没了：继续等只会空转到超时，立即终止
      return {
        ok: false,
        matched: false,
        reason: 'gone',
        selector: parsed,
        attempts,
        evidence: goneEvidence(obs),
        last_error: { kind: 'owner_unavailable', process_state: obs.process_state || 'exited' },
      };
    } else if (isTransient(obs)) {
      lastError = { kind: 'transient_error', error_code: obs.error_code };
    } else {
      // 非临时错误：原样上抛，由调用方按 §4.2 映射
      const err = new WorkerError(
        String((obs && obs.error_code) || 'computer_action_failed'),
        `wait 观察失败：${String((obs && obs.error_code) || 'unknown')}`,
      );
      err.detail = { kind: 'wait_observe_failed', selector: parsed, attempts, last_error: obs || null };
      throw err;
    }

    if (now() >= deadline) {
      let diagnostic = null;
      if (typeof diagnose === 'function') {
        try {
          diagnostic = await diagnose(parsed);
        } catch (e) {
          diagnostic = { error: String((e && e.code) || 'diagnose_failed') };
        }
      }
      const err = new WorkerError('computer_timeout', `等待 ${parsed.raw} 超时（${WAIT_TIMEOUT_MS}ms）`);
      err.detail = {
        kind: 'wait_timeout',
        predicate: 'selector',
        selector: parsed,
        attempts,
        last_error: lastError,
        evidence: { matches: false, complete: lastComplete },
        diagnostic,
      };
      throw err;
    }
    await waiter(WAIT_POLL_MS);
  }
}

module.exports = {
  WAIT_POLL_MS,
  WAIT_TIMEOUT_MS,
  TRANSIENT_ERRORS,
  normalizeWaitInput,
  validateSelector,
  selectorMatches,
  isTransient,
  pollSelector,
};
