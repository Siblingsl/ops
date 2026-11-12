'use strict';
// DEV-CU P3-4：投递语义生成与统一回执（§4.1 / §4.3 / §P3-4）—— 备料版。
//
// 纯逻辑：不碰 channel.reply、不改 index.js。出口接线等 index.js 解冻后做，
// 但五态、retry 映射、unknown 收敛、recovery 生成、错误码常量表都在这里定死。
//
// 与上游 `crates/core/src/response/output.rs` 对齐：
//   recovery_for_code 仅当 disposition.retry == "safe" 才返回（:63-65）
//   StaleRef + process_state=exited → inspect_state；否则 → refresh_snapshot
//   PolicyDenied → request_explicit_policy
//   AppUnresponsive / Timeout → inspect_state + retry_after_ms 250
//   其它 → 不输出 recovery

const { WorkerError } = require('./refs');

/** §4.3 五态。 */
const DELIVERY = Object.freeze({
  NOT_DELIVERED: 'not_delivered',
  UNCERTAIN: 'delivery_uncertain',
  UNVERIFIED: 'delivered_unverified',
  VERIFIED: 'delivered_verified',
  UNKNOWN: 'unknown',
});

/** §4.3 三档重试语义。 */
const RETRY = Object.freeze({ SAFE: 'safe', UNSAFE: 'unsafe', UNKNOWN: 'unknown' });

/** 五态 → retry 的唯一映射（§4.3 表逐行）。 */
const RETRY_BY_DELIVERY = Object.freeze({
  not_delivered: 'safe',
  delivery_uncertain: 'unsafe',
  delivered_unverified: 'unsafe',
  delivered_verified: 'unsafe',
  unknown: 'unknown',
});

/** recovery.strategy 的三个取值（§4.2 注）。 */
const STRATEGY = Object.freeze({
  REFRESH: 'refresh_snapshot_then_retry_original',
  INSPECT: 'inspect_state_then_retry_original',
  POLICY: 'request_explicit_policy_then_retry_original',
});

/**
 * §4.2 错误码表（逐字照抄；Go 侧 P4-10 会建同名常量并做一致性测试）。
 * `requires_fresh_snapshot` / `retry_after_ms` 只用于 recovery 生成。
 */
const ERROR_CODES = Object.freeze({
  computer_stale_ref: { http: 409, requires_fresh_snapshot: true, retry_after_ms: null },
  computer_ambiguous_target: { http: 409, requires_fresh_snapshot: true, retry_after_ms: null },
  computer_target_changed: { http: 409, requires_fresh_snapshot: true, retry_after_ms: null },
  computer_approval_conflict: { http: 409, requires_fresh_snapshot: false, retry_after_ms: null },
  computer_foreground_busy: { http: 409, requires_fresh_snapshot: false, retry_after_ms: null },
  computer_action_not_supported: { http: 422, requires_fresh_snapshot: false, retry_after_ms: null },
  computer_ui_unsupported: { http: 422, requires_fresh_snapshot: false, retry_after_ms: null },
  computer_action_failed: { http: 422, requires_fresh_snapshot: false, retry_after_ms: null },
  computer_app_unresponsive: { http: 503, requires_fresh_snapshot: true, retry_after_ms: 250 },
  computer_timeout: { http: 504, requires_fresh_snapshot: true, retry_after_ms: 250 },
  computer_policy_denied: { http: 403, requires_fresh_snapshot: false, retry_after_ms: null },
  computer_scope_denied: { http: 403, requires_fresh_snapshot: false, retry_after_ms: null },
  computer_device_offline: { http: 503, requires_fresh_snapshot: false, retry_after_ms: null },
  computer_budget_exceeded: { http: 429, requires_fresh_snapshot: false, retry_after_ms: null },
  computer_invalid_args: { http: 422, requires_fresh_snapshot: false, retry_after_ms: null },
  computer_internal: { http: 500, requires_fresh_snapshot: false, retry_after_ms: null },
});

/** 只读 worker 命令：`settleUnknownDelivery` 用它决定是否收敛成 not_delivered。 */
const READ_ONLY_COMMANDS = Object.freeze([
  'ping',
  'list_windows',
  'uia_read',
  'uia_observe',
  'ref_store_stats',
  'capture_stats',
  'capture_evidence',
]);

/**
 * wire 层既有旧契约码（P3-4 之前就存在于 worker 回执、被测试与 IPC 层锁定的字符串）。
 * 它们表示「请求根本没进业务层」——参数/门禁/命令名错误，语义同为未投递；
 * wireFailure 原样保留，不收敛成 computer_internal（否则既有用例与 IPC 消费方全变）。
 */
const WIRE_LEGACY_CODES = Object.freeze(new Set([
  'worker_busy',
  'invalid_message',
  'unknown_cmd',
  'pid_invalid',
  'params_invalid',
  'hard_forbidden',
  'capture_failed',
  'grant_invalid',
  'not_found',
]));

function isKnownErrorCode(code) {
  return Object.prototype.hasOwnProperty.call(ERROR_CODES, String(code || ''));
}

function isKnownDelivery(delivery) {
  return Object.prototype.hasOwnProperty.call(RETRY_BY_DELIVERY, String(delivery || ''));
}

/** `delivery` → `{delivery, retry}`。未知值 → computer_internal（不猜）。 */
function dispositionOf(delivery) {
  const key = String(delivery || '');
  if (!isKnownDelivery(key)) {
    throw new WorkerError('computer_internal', `未知的投递语义：${key || '(空)'}`);
  }
  return { delivery: key, retry: RETRY_BY_DELIVERY[key] };
}

/**
 * 反序列化校验（§P3-4 步骤 1）：delivery 与 retry 必须与 §4.3 表一致。
 * 不一致 → computer_internal，避免「回执说 safe、语义其实是 unsafe」这种静默错配。
 */
function parseDisposition(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new WorkerError('computer_internal', '缺少 disposition');
  }
  const expected = dispositionOf(raw.delivery);
  if (String(raw.retry || '') !== expected.retry) {
    throw new WorkerError(
      'computer_internal',
      `disposition 不一致：${expected.delivery} 必须是 ${expected.retry}，收到 ${raw.retry}`,
    );
  }
  return expected;
}

/**
 * unknown 收敛（§P3-4 步骤 2 / §§4.3 末行）：
 * 只读命令或 `computer_invalid_args` → 强制 not_delivered；其它保持 unknown。
 * 输入 `{command, error_code?, disposition}`，也接受只有 delivery 字符串。
 */
function settleUnknownDelivery(input) {
  const raw = typeof input === 'string' ? { disposition: input } : (input || {});
  const current = typeof raw.disposition === 'string'
    ? { delivery: raw.disposition, retry: RETRY_BY_DELIVERY[raw.disposition] }
    : (raw.disposition || {});
  // 没给 disposition 的调用方按 unknown 处理，再走收敛规则
  const delivery = current.delivery || DELIVERY.UNKNOWN;
  const retry = current.retry || RETRY_BY_DELIVERY[delivery];
  if (delivery !== DELIVERY.UNKNOWN) {
    return retry ? { delivery, retry } : dispositionOf(delivery);
  }
  const command = String(raw.command || '');
  const code = String(raw.error_code || '');
  const readonly = READ_ONLY_COMMANDS.indexOf(command) >= 0;
  if (readonly || code === 'computer_invalid_args') {
    return dispositionOf(DELIVERY.NOT_DELIVERED);
  }
  return dispositionOf(DELIVERY.UNKNOWN);
}

/**
 * recovery 生成（§P3-4 步骤 3）：**仅 retry === 'safe'** 时输出。
 * 策略与常量对齐上游 `recovery_for_code`，`requires_fresh_snapshot` / `retry_after_ms`
 * 取 §4.2 表；表里没有的码不编造 strategy。
 */
function recoveryFor(code, disposition, details) {
  const disp = disposition && disposition.retry
    ? disposition
    : dispositionOf(disposition);
  if (disp.retry !== RETRY.SAFE) return null;

  const key = String(code || '');
  const meta = ERROR_CODES[key];
  if (!meta) return null;

  const base = {
    retryable: true,
    requires_fresh_snapshot: meta.requires_fresh_snapshot === true,
    retry_after_ms: meta.retry_after_ms === null ? undefined : meta.retry_after_ms,
  };
  const hint = (strategy, extra = {}) => {
    const out = { strategy, ...base, ...extra };
    if (out.retry_after_ms === undefined) delete out.retry_after_ms;
    return out;
  };

  const processExited = Boolean(details && details.process_state === 'exited');
  switch (key) {
    case 'computer_stale_ref':
      return hint(processExited ? STRATEGY.INSPECT : STRATEGY.REFRESH);
    case 'computer_ambiguous_target':
    case 'computer_target_changed':
      return hint(STRATEGY.REFRESH);
    case 'computer_policy_denied':
    case 'computer_scope_denied':
      return hint(STRATEGY.POLICY);
    case 'computer_app_unresponsive':
    case 'computer_timeout':
      return hint(STRATEGY.INSPECT);
    default:
      return null;
  }
}

function normalizeDisposition(input) {
  if (!input) return null;
  if (typeof input === 'string') return dispositionOf(input);
  return parseDisposition(input);
}

/**
 * 统一成功出口（§P3-4 步骤 4）：`{ok:true, ...data, disposition}`。
 * 旧字段原样保留（不删旧字段），只追加 disposition。
 */
function finishSuccess(data, disposition) {
  const disp = normalizeDisposition(disposition) || dispositionOf(DELIVERY.UNVERIFIED);
  return { ok: true, ...(data && typeof data === 'object' ? data : {}), disposition: disp };
}

/**
 * 统一失败出口：`{ok:false, error:{code, message, detail:{..., disposition, recovery, report}}}`。
 * `report` 只在传入时出现（P2-6 的门禁 report 走这里）。
 */
function finishFailure({ code, message, detail, disposition, report } = {}) {
  const key = String(code || 'computer_internal');
  if (!isKnownErrorCode(key)) {
    // 未知码不往上游泄：收敛成 internal，同时把原码留在 detail 里便于排查
    return finishFailure({
      code: 'computer_internal',
      message: message || `未知错误码：${key}`,
      detail: { ...(detail || {}), original_code: key },
      disposition: { delivery: DELIVERY.NOT_DELIVERED, retry: RETRY.SAFE },
      report,
    });
  }
  const disp = normalizeDisposition(disposition) || dispositionOf(DELIVERY.NOT_DELIVERED);
  const merged = { ...(detail || {}), disposition: disp };
  if (report !== undefined) merged.report = report;
  const recovery = recoveryFor(key, disp, merged);
  if (recovery) merged.recovery = recovery;
  return { ok: false, error: { code: key, message: String(message || ''), detail: merged } };
}

/** 成功/失败统一入口，便于 index.js 的每个 cmd 出口只调一次。 */
function finish(result) {
  const r = result || {};
  if (r.ok === true) return finishSuccess(r.data === undefined ? stripEnvelope(r) : r.data, r.disposition);
  return finishFailure(r);
}

/** 成功结果里除 ok/data/disposition 之外的字段，按旧形状平铺回去。 */
function stripEnvelope(result) {
  const out = {};
  for (const [k, v] of Object.entries(result)) {
    if (k === 'ok' || k === 'disposition') continue;
    out[k] = v;
  }
  return out;
}

/**
 * wire 层失败回执（P3-4 步骤 5 的通道适配）：旧协议 `error` 是字符串码
 * （computer-worker-host.ts 与 preload 白名单都按字符串消费），**不得改成嵌套对象**。
 * 本函数保持 `{ok:false, error:<码>, message, detail}` 旧形状，只追加：
 *   - `detail.disposition`（缺省补 not_delivered/safe；已有则按 §4.3 表重算 retry，防不自洽外泄）
 *   - `detail.recovery`（仅当 disposition.retry === 'safe' 且码在 §4.2 表内）
 * 表外旧码（pid_invalid / params_invalid / hard_forbidden / capture_failed 等 wire 既有契约）
 * 原样保留：它们是「请求根本没进业务」的参数/门禁错误，语义同为未投递，不收敛改码。
 */
function wireFailure(input = {}) {
  // worker 回执的旧字段名是 error（字符串码）；finishFailure 风格的调用方传 code。两者都收。
  const code = input.code !== undefined ? input.code : input.error;
  const { message, detail, report } = input;
  let key = String(code || 'computer_internal');
  // 表外码：若是 wire 既有旧契约码（请求没进业务层的参数/门禁/命令错误）原样保留；
  // 真正的未知码收敛成 computer_internal，原码留 detail 便于排查。
  if (!isKnownErrorCode(key) && !WIRE_LEGACY_CODES.has(key)) {
    const original = key;
    key = 'computer_internal';
    return finishWire(key, message, { ...(detail || {}), original_code: original }, report);
  }
  return finishWire(key, message, detail, report);
}

/** wire 形状组装：error 保持字符串；disposition 兜底；safe 码补 recovery。 */
function finishWire(key, message, detail, report) {
  const base = { ...(detail && typeof detail === 'object' ? detail : {}) };
  if (report !== undefined) base.report = report;
  if (base.disposition && typeof base.disposition === 'object') {
    // 产出侧信任 delivery、retry 以 §4.3 表为准：既不外泄不自洽组合，也不丢原始错误码。
    base.disposition = dispositionOf(base.disposition.delivery);
  } else {
    base.disposition = dispositionOf(DELIVERY.NOT_DELIVERED);
  }
  if (isKnownErrorCode(key)) {
    const recovery = recoveryFor(key, base.disposition, base);
    if (recovery) base.recovery = recovery;
  }
  return {
    ok: false,
    error: key,
    message: message === undefined || message === null ? '' : String(message),
    detail: base,
  };
}

module.exports = {
  DELIVERY,
  RETRY,
  RETRY_BY_DELIVERY,
  STRATEGY,
  ERROR_CODES,
  READ_ONLY_COMMANDS,
  isKnownErrorCode,
  isKnownDelivery,
  dispositionOf,
  parseDisposition,
  settleUnknownDelivery,
  recoveryFor,
  finishSuccess,
  finishFailure,
  finish,
  wireFailure,
};
