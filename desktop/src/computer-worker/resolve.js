'use strict';
// DEV-CU P2-4：严格再解析（§4.4 / §P2-4）。
// 目标：不再用 AutomationId 猜目标，而是拿快照里的 RefEntry 当身份谓词，在**同一窗口**的
// 重新观察树里找唯一活元素。本文件是纯逻辑（无 IO），便于用夹具覆盖零/多/未知三类结局。
//
// 判等规则在 identity.js（上游 FullPredicate 的移植）；本文件只负责：
//   ① 窗口身份四要素严格比对（§4.9）
//   ② 遍历统计 Match / Unknown 计数
//   ③ 按「多匹配 → 树不完整/身份未知 → 不存在」的优先级出结论（上游 unique_live_match 顺序）
//   ④ 身份不可证的 ref 在进入树比较前就拒绝（规格步骤 7）

const { WorkerError } = require('./refs');
const { windowChangeReasons, scopeDetail } = require('./scope');
const {
  MATCH, UNKNOWN, NOMATCH, nonBlank, FullPredicate, hasMeaningfulIdentity,
} = require('./identity');

/** 失败时 detail.kind 的取值（§P2-4 步骤 5；末两项见证据材料 §20.2）。 */
const RESOLVE_KIND = Object.freeze({
  ABSENT: 'saved_ref_absent',
  AMBIGUOUS: 'saved_ref_ambiguous',
  UNKNOWN: 'resolution_identity_unknown',
  WINDOW: 'window_identity_changed',
  NOT_UNIQUE: 'identity_not_unique',
  UNPROVEN: 'identity_unproven',
});

/** 窗口身份四要素（§4.9）。 */
const WINDOW_IDENTITY_FIELDS = ['pid', 'process_start_time', 'hwnd', 'window_bounds_hash'];

function staleError(message, detail) {
  const err = new WorkerError('computer_stale_ref', message);
  err.detail = detail;
  return err;
}

function ambiguousError(message, detail) {
  const err = new WorkerError('computer_ambiguous_target', message);
  err.detail = detail;
  return err;
}

function unknownError(message, detail) {
  const err = new WorkerError('computer_timeout', message);
  err.detail = detail;
  return err;
}

/** 失败 detail 的公共四字段（规格步骤 8：snapshot_id / ref / role / complete）。 */
function detailBase(entry, snapshotId, ref, complete) {
  return {
    snapshot_id: String(snapshotId || ''),
    ref: String(ref || ''),
    role: String((entry && entry.role) || ''),
    complete: complete === true,
  };
}

/**
 * 严格窗口身份比对（步骤 2）。四要素任一不一致即 stale，`detail.reason` 是
 * `scope.js` 的封闭枚举（window_gone / pid_reused / hwnd_changed / bounds_changed）。
 * 约定：expected 里为空（'' / 0 / null）表示「当时没采到」，跳过该字段而不是判为不一致。
 */
function resolveWindowStrict(expected, actual) {
  const reasons = windowChangeReasons(expected, actual);
  if (reasons.length > 0) {
    throw staleError(`窗口身份已变化（${reasons.join(',')}），请重新观察`, {
      kind: RESOLVE_KIND.WINDOW,
      reason: reasons,
      retryable: true,
      requires_fresh_snapshot: true,
      ...scopeDetail(expected, actual),
    });
  }
  return true;
}

/**
 * 步骤 7 的前置闸门：该 ref 是否具备可再解析的身份证据。两种情况直接拒绝：
 *   - 除 role 外没有任何身份字段（无 AutomationId / 名称 / 描述 / 稳定 value）；
 *   - 无 AutomationId 且捕获时未被证明唯一（同名双子、或捕获时树不完整）。
 * 这两条对应上游 `has_meaningful_identity` 与 `observe_saved_ref:97` 的
 * `identity_not_unique`，都在读树前判定，避免白跑一次 PowerShell。
 */
function assertIdentityProof(entry, snapshotId, ref) {
  const base = detailBase(entry, snapshotId, ref, true);
  if (!hasMeaningfulIdentity(entry)) {
    throw staleError('该 ref 没有任何可复验的身份字段，无法安全再解析，请重新观察', {
      ...base, kind: RESOLVE_KIND.UNPROVEN, retryable: false,
    });
  }
  if (!nonBlank(entry && entry.native_id) && entry && entry.unique_at_capture !== true) {
    throw ambiguousError('该 ref 在捕获时未被证明唯一，不允许按身份再解析，请重新观察并选择唯一目标', {
      ...base, kind: RESOLVE_KIND.NOT_UNIQUE, retryable: false,
    });
  }
  return true;
}

/**
 * 在树里遍历比对。返回 { matches:[{node,path}], unknownCount, visited }。
 * complete=false 表示树被截断，未访问部分可能还有匹配（步骤 5 的「树不完整」）。
 */
function classifyTree(tree, predicate) {
  const matches = [];
  let unknownCount = 0;
  let visited = 0;
  const walk = (node, path) => {
    if (!node) return;
    visited += 1;
    const verdict = predicate.compare(node);
    if (verdict === MATCH) matches.push({ node, path: path.slice() });
    else if (verdict === UNKNOWN) unknownCount += 1;
    else if (verdict !== NOMATCH) throw new Error(`未知的身份判定结果：${verdict}`);
    const kids = node.children || [];
    for (let i = 0; i < kids.length; i++) walk(kids[i], path.concat(i));
  };
  walk(tree, []);
  return { matches, unknownCount, visited };
}

/**
 * 汇总判定（步骤 5）。顺序照上游 `unique_live_match`，而不是照规格字面的列举顺序：
 *   ≥2 个 match → ambiguous（已经确定不唯一，看没看全不影响结论）
 *   有 unknown 或树不完整 → timeout（无法证明唯一，也无法证明不存在）
 *   0 个 match → stale（absent，只有读全了才能断言「不存在」）
 * 规格字面把「0 个 match」写在最前，但那样「树被截断 + 0 匹配」会给出 retryable:false
 * 的「元素已消失」，与同一段「树不完整 → timeout」自相矛盾；取上游顺序（§20.2 D-20-2）。
 */
function decideResolution({ matches, unknownCount, complete }, entry, snapshotId, ref) {
  const base = detailBase(entry, snapshotId, ref, complete);

  if (matches.length >= 2) {
    throw ambiguousError(`有 ${matches.length} 个元素同时匹配该 ref，ref 无法区分它们`, {
      ...base, kind: RESOLVE_KIND.AMBIGUOUS, retryable: false,
      candidate_count: matches.length,
    });
  }
  if (unknownCount > 0 || complete !== true) {
    throw unknownError('目标身份无法确认（存在状态漂移或树被截断），请重新观察', {
      ...base, kind: RESOLVE_KIND.UNKNOWN, retryable: true,
      requires_fresh_snapshot: true, unknown_count: unknownCount,
    });
  }
  if (matches.length === 0) {
    throw staleError('保存的 ref 已找不到对应元素，请重新观察', {
      ...base, kind: RESOLVE_KIND.ABSENT, retryable: false,
    });
  }
  return matches[0];
}

module.exports = {
  RESOLVE_KIND,
  WINDOW_IDENTITY_FIELDS,
  FullPredicate,
  hasMeaningfulIdentity,
  assertIdentityProof,
  resolveWindowStrict,
  classifyTree,
  decideResolution,
};
