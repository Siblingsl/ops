'use strict';
// DEV-CU P2-5：窗口身份与 pinned scope（§4.9 / §P2-5）。
//
// 目标：把「这个动作还能不能落在这个窗口上」判清楚，防弹窗越权与 PID 复用。
// 本文件是纯逻辑（不读窗口、不发 PowerShell）；采集在 native.js：
//   windowIdentity(pid)  轻量采样（pid / start_time / hwnd / title_hash / target_handle / 窗口矩形）
//   foregroundWindow()   前台窗口（hwnd + pid）
//
// 硬约定：detail 里**只放哈希与数字**，绝不出现窗口标题、进程名、进程路径（C09）。
// 标题只以 sha256 前 32 位（title_hash）与 pid+\0+标题 的前 32 位（target_handle）出现。

const crypto = require('node:crypto');

const { WorkerError } = require('./refs');

/** `detail.reason` 的取值（§P2-5 步骤 6，封闭枚举）。 */
const SCOPE_REASON = Object.freeze({
  WINDOW_GONE: 'window_gone',
  PID_REUSED: 'pid_reused',
  HWND_CHANGED: 'hwnd_changed',
  DOCUMENT_CHANGED: 'document_changed',
  BOUNDS_CHANGED: 'bounds_changed',
  FOREGROUND_CHANGED: 'foreground_changed',
  GENERATION_CHANGED: 'generation_changed',
});

/** 固定顺序：同一情形多次判定得到同一个数组，便于断言与日志比对。 */
const REASON_ORDER = Object.freeze([
  SCOPE_REASON.WINDOW_GONE,
  SCOPE_REASON.PID_REUSED,
  SCOPE_REASON.HWND_CHANGED,
  SCOPE_REASON.DOCUMENT_CHANGED,
  SCOPE_REASON.BOUNDS_CHANGED,
  SCOPE_REASON.FOREGROUND_CHANGED,
  SCOPE_REASON.GENERATION_CHANGED,
]);

function text(value) {
  return String(value === undefined || value === null ? '' : value);
}

/** 正整数（pid / hwnd）；0、空、非数字一律 null，表示「没有这个值」。 */
function positiveInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

function sha256(textValue) {
  return crypto.createHash('sha256').update(textValue, 'utf8').digest('hex');
}

/** 窗口标题摘要：sha256(标题) 前 32 位（§P2-5 步骤 1）。 */
function titleHash(title) {
  return sha256(text(title)).slice(0, 32);
}

/**
 * 选窗器句柄：sha256(pid + "\u0000" + 标题) 前 32 位（§P2-5 步骤 2）。
 * 必须与 desktop/src/ipc/computer.ts:31 逐字节一致，服务端与本机才能各算各的对上。
 */
function targetHandle(pid, title) {
  return sha256(`${text(pid)}\u0000${text(title)}`).slice(0, 32);
}

/**
 * 期望窗口身份 vs 实际采样，返回命中的原因数组（空数组 = 一致）。
 * 语义：
 *   - 实际 hwnd 为 0（窗口没了）或 pid 已对不上 → window_gone；
 *   - pid 相同但进程启动时间变了 → pid_reused（PID 已被别的进程占用）；
 *   - 期望记录了 start_time 而实际读不到 → window_gone（无法证明还是同一个进程实例）；
 *   - hwnd 变了 → hwnd_changed；bounds 哈希变了 → bounds_changed（移动 / 缩放 / DPI）。
 * 期望侧为空（'' / 0）表示「当时没采到」，跳过该字段而不是判为不一致。
 */
function windowChangeReasons(expected, actual) {
  const e = expected || {};
  const a = actual || {};
  const ePid = positiveInt(e.pid);
  const aPid = positiveInt(a.pid);
  const eHwnd = positiveInt(e.hwnd);
  const aHwnd = positiveInt(a.hwnd);

  if (!aHwnd) return [SCOPE_REASON.WINDOW_GONE];
  if (ePid && aPid && ePid !== aPid) return [SCOPE_REASON.WINDOW_GONE];

  const reasons = [];
  if (ePid && aPid && ePid === aPid) {
    const eStart = text(e.process_start_time);
    const aStart = text(a.process_start_time);
    if (eStart && aStart && eStart !== aStart) reasons.push(SCOPE_REASON.PID_REUSED);
    else if (eStart && !aStart) return [SCOPE_REASON.WINDOW_GONE];
  }
  if (eHwnd && eHwnd !== aHwnd) reasons.push(SCOPE_REASON.HWND_CHANGED);

  // 跨文档：标题摘要（去掉未保存星号）变了，说明同一窗口换了文档/页面。
  // 只在双方都采到摘要时比较；夹具/旧 ref 没有摘要时跳过。
  const eDoc = text(e.document_hash);
  const aDoc = text(a.document_hash);
  if (eDoc && aDoc && eDoc !== aDoc) reasons.push(SCOPE_REASON.DOCUMENT_CHANGED);

  const eBounds = text(e.window_bounds_hash);
  const aBounds = text(a.window_bounds_hash);
  if (eBounds && aBounds && eBounds !== aBounds) reasons.push(SCOPE_REASON.BOUNDS_CHANGED);

  return reasons.sort((x, y) => REASON_ORDER.indexOf(x) - REASON_ORDER.indexOf(y));
}

/** 只含哈希与数字的 detail 底座；调用方补 snapshot_id / ref / role / complete。 */
function scopeDetail(expected, actual) {
  const e = expected || {};
  const a = actual || {};
  return {
    expected_pid: positiveInt(e.pid) || 0,
    actual_pid: positiveInt(a.pid) || 0,
    expected_hwnd: positiveInt(e.hwnd) || 0,
    actual_hwnd: positiveInt(a.hwnd) || 0,
  };
}

function staleScopeError(reasons, detail) {
  const err = new WorkerError('computer_stale_ref');
  err.detail = {
    kind: 'window_identity_changed',
    reason: reasons.slice(),
    retryable: true,
    requires_fresh_snapshot: true,
    ...detail,
  };
  return err;
}

/** 断言窗口身份未变；变了就抛 `computer_stale_ref` + 枚举 reason。 */
function assertWindowScope(expected, actual, detail) {
  const reasons = windowChangeReasons(expected, actual);
  if (reasons.length > 0) throw staleScopeError(reasons, detail || scopeDetail(expected, actual));
  return true;
}

/**
 * 前台窗口判定（步骤 3/4）：
 *   - 前台不属于已授权 pid → foreground_changed（切到别的应用了，停控）；
 *   - 前台仍是同一进程但不是被授权的那个窗口（弹窗 / sheet / 另一个窗口）→ hwnd_changed，
 *     默认拒绝，要求重新确认归属。
 * `expectedHwnd` 为空时只判 pid。
 */
function foregroundReasons(targetPid, foreground, expectedHwnd) {
  const wantPid = positiveInt(targetPid);
  const fgPid = positiveInt(foreground && foreground.pid);
  if (!wantPid || fgPid !== wantPid) return [SCOPE_REASON.FOREGROUND_CHANGED];
  const fgHwnd = positiveInt(foreground && foreground.hwnd);
  const wantHwnd = positiveInt(expectedHwnd);
  if (wantHwnd && fgHwnd && fgHwnd !== wantHwnd) return [SCOPE_REASON.HWND_CHANGED];
  return [];
}

function targetChangedError(reasons, detail) {
  const err = new WorkerError('computer_target_changed');
  err.detail = {
    kind: 'target_changed',
    reason: reasons.slice(),
    retryable: true,
    ...detail,
  };
  return err;
}

/** 动作前断言前台仍属于授权窗口；不满足就抛 `computer_target_changed`。 */
function assertForeground(targetPid, foreground, expectedHwnd, detail) {
  const reasons = foregroundReasons(targetPid, foreground, expectedHwnd);
  if (reasons.length > 0) throw targetChangedError(reasons, detail || scopeDetail({ pid: targetPid, hwnd: expectedHwnd }, foreground));
  return true;
}

/**
 * 租约代数断言。RefStore.load 已按 generation 拒绝（P2-3），这里供只有数值的调用方复用，
 * 保证 reason 也落在同一个枚举里。
 */
function assertGeneration(expected, actual, detail) {
  const e = Number(expected || 0);
  const a = Number(actual || 0);
  if (e !== a) {
    throw staleScopeError([SCOPE_REASON.GENERATION_CHANGED], {
      // 代数变化不是「重新观察」能解决的：要重新走授权，所以 requires_fresh_snapshot=false
      kind: SCOPE_REASON.GENERATION_CHANGED,
      requires_fresh_snapshot: false,
      retryable: false,
      expected_generation: e, actual_generation: a, ...(detail || {}),
    });
  }
  return true;
}

module.exports = {
  SCOPE_REASON,
  REASON_ORDER,
  positiveInt,
  titleHash,
  targetHandle,
  windowChangeReasons,
  scopeDetail,
  assertWindowScope,
  foregroundReasons,
  assertForeground,
  assertGeneration,
};
