'use strict';
// CF-DESK-05｜C09 截图脱敏校验（A-03）；docs/27 §11.5.2 / §11.5.4 T-AI27-C09 / §11.5.5 / §13.4。
//
// 与 CF-DESK-04 的分工：capture.checkCaptureFrame 是「采集帧准入」，信任 backend 声明；
// 本文件是独立的「脱敏复核」，**不信任** backend 自报的布尔 / 数组：
//  - 独立解析 PNG IHDR 宽高，与窗口矩形 / 声明尺寸交叉核验，防止「声明小窗口、实传全屏图」；
//  - 显式布尔与 foreign_windows 数组必须存在（缺失即 redaction_unverifiable，不默认放行）；
//  - 可选 screen_bounds / other_windows 做独立几何相交核验（不回传标题 / 路径 / 其它窗口清单）；
//  - 只产出固定白名单的脱敏证据；**原图、base64、窗口标题、进程路径一律不出 worker**。
//
// 注意：只解析 IHDR 宽高，不校验 CRC、不解码像素、不做 OCR；真 GUI / 真图像完整性未验。

const { createHash } = require('node:crypto');

const REDACTION_SCHEMA = 'ops-computer-redaction/1';
const PNG_MAGIC = Buffer.from('89504e470d0a1a0a', 'hex');
const MAX_EDGE_PX = 1920;

// 脱敏证据字段白名单：新增字段必须显式评审，防止把原文 / 敏感清单塞回出口（C09）。
const EVIDENCE_KEYS = [
  'byte_size', 'capture_id', 'captured_at', 'checks', 'coverage', 'height',
  'image_digest', 'ok', 'revision', 'run_id', 'schema', 'width', 'window_digest',
].sort();

/** 解析 PNG IHDR 宽高。返回 null 表示不是可核验的 PNG（不猜、不默认放行）。 */
function pngDimensions(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 33) return null;
  if (!bytes.subarray(0, 8).equals(PNG_MAGIC)) return null;
  if (bytes.readUInt32BE(8) !== 13) return null;
  if (bytes.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (width <= 0 || height <= 0 || width > MAX_EDGE_PX || height > MAX_EDGE_PX) return null;
  return { width, height };
}

function rectOf(v) {
  if (!v || typeof v !== 'object') return null;
  const keys = ['x', 'y', 'w', 'h'];
  for (const k of keys) {
    if (!Number.isFinite(v[k])) return null;
  }
  if (v.w <= 0 || v.h <= 0) return null;
  return { x: v.x, y: v.y, w: v.w, h: v.h };
}

function rectsIntersect(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * 脱敏复核。**失败一律拒绝该图且不落明文**：调用方据此不写 store、不回原文。
 * @param {object} frame  backend 原始返回（只读）
 * @param {object} checked capture.checkCaptureFrame 已准入的 { bounds, bytes, width, height }
 */
function validateRedactionFrame(frame, checked) {
  const fail = (error) => ({ ok: false, error, checks: [], coverage: 'none' });
  if (!frame || typeof frame !== 'object' || !checked || checked.ok === false) {
    return fail('redaction_unverifiable');
  }

  // ① 图像层：独立解析 IHDR，尺寸必须与窗口矩形严格一致。
  const dims = pngDimensions(checked.bytes);
  if (!dims) return fail('image_invalid');
  if (dims.width !== checked.bounds.w || dims.height !== checked.bounds.h) {
    return fail('image_mismatch');
  }
  // ② 声明尺寸不得与矩形矛盾（防止用「小声明」掩盖大图）。
  if (Number.isFinite(frame.width) && Number(frame.width) !== checked.bounds.w) return fail('dimensions_mismatch');
  if (Number.isFinite(frame.height) && Number(frame.height) !== checked.bounds.h) return fail('dimensions_mismatch');

  // ③ 元数据完整性：显式布尔 + foreign_windows 数组，缺失即不可核验（不默认放行）。
  for (const key of ['full_screen', 'occluded', 'foreground_ok']) {
    if (typeof frame[key] !== 'boolean') return fail('redaction_unverifiable');
  }
  if (!Array.isArray(frame.foreign_windows)) return fail('redaction_unverifiable');

  // ④ backend 自报的越界标志独立复核（不因 T6 已判就跳过）。
  if (frame.full_screen === true) return fail('full_screen');
  if (frame.occluded === true) return fail('occluded');
  if (frame.foreground_ok === false) return fail('target_not_foreground');
  if (frame.foreign_windows.length > 0) return fail('foreign_window');

  const checks = ['png_ihdr', 'bounds_match', 'declared_dimensions', 'explicit_flags', 'foreign_declared_empty', 'no_plaintext'];
  let coverage = 'metadata+png_ihdr';

  // ⑤ 可选几何层：虚拟屏边界与「其它窗口矩形」独立相交核验。
  //    只消费矩形，不接收 / 不回传窗口标题、进程名、路径或窗口全集（27 §11.5.2）。
  if (frame.screen_bounds !== undefined) {
    const screen = rectOf(frame.screen_bounds);
    if (!screen) return fail('redaction_unverifiable');
    const b = checked.bounds;
    if (b.x < screen.x || b.y < screen.y || b.x + b.w > screen.x + screen.w || b.y + b.h > screen.y + screen.h) {
      return fail('outside_screen');
    }
    if (b.x <= screen.x && b.y <= screen.y && b.x + b.w >= screen.x + screen.w && b.y + b.h >= screen.y + screen.h) {
      return fail('full_screen');
    }
    checks.push('screen_bounds');
    coverage = 'metadata+png_ihdr+screen';
  }
  if (frame.other_windows !== undefined) {
    if (!Array.isArray(frame.other_windows)) return fail('redaction_unverifiable');
    for (const raw of frame.other_windows) {
      const other = rectOf(raw);
      if (!other) return fail('redaction_unverifiable');
      if (rectsIntersect(checked.bounds, other)) return fail('foreign_window');
    }
    checks.push('other_windows');
    coverage = 'metadata+png_ihdr+geometry';
  }

  return { ok: true, checks, coverage };
}

/** 生成脱敏证据：只含固定白名单字段，image_digest 是原图的不可逆摘要，不含原文。 */
function buildRedactionEvidence(entry, verdict) {
  const checks = (verdict && Array.isArray(verdict.checks)) ? verdict.checks.slice() : [];
  const coverage = (verdict && typeof verdict.coverage === 'string') ? verdict.coverage : 'none';
  return {
    ok: true,
    schema: REDACTION_SCHEMA,
    capture_id: entry.id,
    run_id: entry.runId,
    window_digest: entry.windowDigest,
    image_digest: createHash('sha256').update(entry.bytes).digest('hex').slice(0, 32),
    width: entry.width,
    height: entry.height,
    byte_size: entry.byteSize,
    checks,
    coverage,
    revision: entry.revision,
    captured_at: entry.capturedAt,
  };
}

module.exports = {
  REDACTION_SCHEMA, EVIDENCE_KEYS, PNG_MAGIC,
  pngDimensions, rectOf, rectsIntersect,
  validateRedactionFrame, buildRedactionEvidence,
};
