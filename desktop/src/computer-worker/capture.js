'use strict';
// CF-DESK-04｜窗口级截图能力（A-03 前置；docs/34 §5、docs/27 §11.5.2 / §11.5.4 C09）。
//
// 边界（27 §11.5.2 / §11.5.5 / §13.4）：
//  - 只承接「用户已选中的目标窗口」的窗口级截图；全屏截图不默认上送，遮挡 /
//    截入其它应用 / 目标失焦 / 窗口矩形变化时**拒绝该图**，不降级为全屏或坐标点击；
//  - 每个返回只含选中目标的必要摘要，不返回其它窗口、进程路径全集或截图原文；
//  - 原图只在隔离 worker 进程内存里以不透明 capture_id 可达，未接 host→IPC→preload
//    或服务端出口（DT-04 / T7 待立项），也不提供接受任意 hwnd / 坐标 / 脚本的开放接口；
//  - 逐次授权：grant_id 绑定读取与失效；失权即清空该 grant 下全部截图（C09 历史越权读取）。
//
// 本文件不碰消息协议；协议在 index.js。采集源按依赖注入，便于无真 GUI 的定向测试。

const { createHash, randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { isHardForbidden } = require('./policy');
const { REDACTION_SCHEMA, validateRedactionFrame, buildRedactionEvidence } = require('./redaction');

const CAPTURE_SCHEMA = 'ops-computer-capture/1';
const MAX_EDGE_PX = 1920;                 // 27 §14 资源上限：单次最长边 1920px
const MAX_BYTES = 2 * 1024 * 1024;        // 编码后 ≤2MiB
const MAX_PER_RUN = 10;                   // 每 run ≤10 张
const CAPTURE_TTL_MS = 10 * 60 * 1000;    // 本机临时证据，进程退出即失效；不落盘

// 开放式 GUI 执行接口禁区（27 §11.5.5）：不接受任意窗口句柄 / 坐标 / 脚本 / PowerShell。
const OPEN_ENDED_KEYS = ['hwnd', 'handle', 'script', 'command', 'shell', 'powershell', 'coordinates', 'rect', 'x', 'y'];

/** 请求校验：pid + 硬禁区 + grant/run，且拒绝一切开放式参数。 */
function validateCaptureRequest(msg) {
  if (!msg || typeof msg !== 'object') return { ok: false, error: 'params_invalid' };
  for (const key of OPEN_ENDED_KEYS) {
    if (Object.prototype.hasOwnProperty.call(msg, key)) return { ok: false, error: 'params_invalid' };
  }
  const pid = Number(msg.pid);
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, error: 'pid_invalid' };
  const targetSummary = String(msg.target_summary || '').slice(0, 256);
  if (isHardForbidden(targetSummary)) return { ok: false, error: 'hard_forbidden' };
  const grantId = String(msg.grant_id || '');
  const runId = String(msg.run_id || '');
  if (!grantId || grantId.length > 128) return { ok: false, error: 'grant_invalid' };
  if (!runId || runId.length > 128) return { ok: false, error: 'run_invalid' };
  return { ok: true, pid, targetSummary, grantId, runId };
}

/**
 * 截图帧校验：**先判定再入库**。任何一项不达标都不落明文，直接返回原因码。
 * frame = { ok, bounds, target_bounds, width, height, full_screen, occluded,
 *           foreground_ok, foreign_windows, bytes }
 */
function checkCaptureFrame(frame) {
  if (!frame || frame.ok !== true) {
    return { ok: false, error: (frame && frame.error) || 'capture_failed' };
  }
  if (frame.full_screen === true) return { ok: false, error: 'full_screen' };
  if (frame.occluded === true) return { ok: false, error: 'occluded' };
  if (frame.foreground_ok === false) return { ok: false, error: 'target_not_foreground' };
  if (Array.isArray(frame.foreign_windows) && frame.foreign_windows.length > 0) {
    return { ok: false, error: 'foreign_window' };
  }
  const b = frame.bounds;
  const t = frame.target_bounds;
  const keys = ['x', 'y', 'w', 'h'];
  if (!b || !t || keys.some((k) => !Number.isFinite(b[k]) || !Number.isFinite(t[k]))) {
    return { ok: false, error: 'parse_failed' };
  }
  if (keys.some((k) => b[k] !== t[k])) return { ok: false, error: 'target_changed' };
  if (b.w <= 0 || b.h <= 0 || b.w > MAX_EDGE_PX || b.h > MAX_EDGE_PX) {
    return { ok: false, error: 'oversize' };
  }
  const bytes = frame.bytes;
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) return { ok: false, error: 'empty_image' };
  if (bytes.length > MAX_BYTES) return { ok: false, error: 'oversize' };
  return { ok: true, bounds: b, bytes, width: Number(frame.width) || b.w, height: Number(frame.height) || b.h };
}

/**
 * 生成窗口级 PowerShell 采集脚本：PrintWindow 只抓目标窗口自身（天然不夹带其它窗口），
 * 不用 CopyFromScreen 全屏/矩形抓屏；GetWindowRect 给出目标矩形并用于严格身份比对；
 * GetForegroundWindow + GetWindowThreadProcessId 判目标是否仍在前台。
 * 脚本以纯函数产出，便于无真 GUI 时核验「窗口级 / 非全屏 / 非开放式」边界。
 */
function buildCaptureScript(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('pid_invalid');
  return [
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.Drawing',
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -TypeDefinition @\'',
    'using System; using System.Runtime.InteropServices;',
    'public static class OpsWinCap {',
    '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }',
    '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
    '  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);',
    '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
    '}',
    "'@",
    '$proc = Get-Process -Id ' + pid + ' -ErrorAction Stop',
    '$hwnd = $proc.MainWindowHandle',
    'if ($hwnd -eq [IntPtr]::Zero) { Write-Output \'{"ok":false,"error":"capture_failed"}\'; exit }',
    '$r = New-Object OpsWinCap+RECT',
    'if (-not [OpsWinCap]::GetWindowRect($hwnd, [ref]$r)) { Write-Output \'{"ok":false,"error":"capture_failed"}\'; exit }',
    '$w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top',
    'if ($w -le 0 -or $h -le 0) { Write-Output \'{"ok":false,"error":"empty_image"}\'; exit }',
    '$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen',
    '$screenBounds = @{ x=$vs.Left; y=$vs.Top; w=$vs.Width; h=$vs.Height }',
    '$fullScreen = ($r.Left -le $vs.Left -and $r.Top -le $vs.Top -and $r.Right -ge $vs.Right -and $r.Bottom -ge $vs.Bottom)',
    '$fg = [OpsWinCap]::GetForegroundWindow()',
    '$fgPid = [uint32]0',
    '$null = [OpsWinCap]::GetWindowThreadProcessId($fg, [ref]$fgPid)',
    '$foregroundOk = ($fgPid -eq [uint32]$proc.Id)',
    '$bmp = New-Object System.Drawing.Bitmap($w, $h)',
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    '$hdc = $g.GetHdc()',
    '$null = [OpsWinCap]::PrintWindow($hwnd, $hdc, 0)',
    '$g.ReleaseHdc($hdc); $g.Dispose()',
    '$ms = New-Object System.IO.MemoryStream',
    '$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)',
    '$b64 = [Convert]::ToBase64String($ms.ToArray())',
    '$bmp.Dispose(); $ms.Dispose()',
    '$bounds = @{ x=$r.Left; y=$r.Top; w=$w; h=$h }',
    // CF-DESK-05：回传虚拟屏矩形供独立几何复核；**不**伪造 other_windows 空数组冒充逐窗枚举。
    '@{ ok=$true; bounds=$bounds; target_bounds=$bounds; width=$w; height=$h; full_screen=$fullScreen; occluded=(-not $foregroundOk); foreground_ok=$foregroundOk; foreign_windows=@(); screen_bounds=$screenBounds; bytes_b64=$b64 } | ConvertTo-Json -Compress',
  ].join('\n');
}

/** 默认本机 backend：隔离 worker 内执行窗口级 PowerShell 脚本。真 GUI 旅程未实测。 */
function powershellWindowBackend(req) {
  let script;
  try {
    script = buildCaptureScript(req.pid);
  } catch {
    return Promise.resolve({ ok: false, error: 'pid_invalid' });
  }
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 15_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) { resolve({ ok: false, error: 'capture_failed' }); return; }
        let parsed;
        try { parsed = JSON.parse(stdout || '{}'); }
        catch { resolve({ ok: false, error: 'parse_failed' }); return; }
        if (parsed.ok !== true) { resolve({ ok: false, error: parsed.error || 'capture_failed' }); return; }
        let bytes;
        try { bytes = Buffer.from(String(parsed.bytes_b64 || ''), 'base64'); }
        catch { resolve({ ok: false, error: 'parse_failed' }); return; }
        delete parsed.bytes_b64;
        resolve({ ...parsed, bytes });
      });
  });
}

/**
 * 进程内截图服务。store 永不落盘；进程退出由 index.js 统一 clear。
 * backend 可注入，纯决策层可在无真 Windows GUI 环境下定向验证。
 */
function createCaptureService(options = {}) {
  const backend = options.backend || powershellWindowBackend;
  const now = options.now || Date.now;
  const makeId = options.makeId || (() => randomUUID());
  // CF-DESK-05：脱敏复核器可注入以便定向测试；生产默认走独立的 validateRedactionFrame。
  const redactor = options.redactor || validateRedactionFrame;
  const store = new Map();
  const runCounts = new Map();
  let revision = 0;

  function prune(current) {
    for (const [id, entry] of store) {
      if (entry.expiresAt <= current) store.delete(id);
    }
  }

  /** 只回选中目标的必要摘要：不含原图、进程路径、窗口标题或其它窗口清单。 */
  function summarize(entry) {
    return {
      ok: true,
      schema: CAPTURE_SCHEMA,
      capture_id: entry.id,
      run_id: entry.runId,
      window_digest: entry.windowDigest,
      byte_size: entry.byteSize,
      width: entry.width,
      height: entry.height,
      bounds: { ...entry.bounds },
      captured_at: entry.capturedAt,
      revision: entry.revision,
    };
  }

  async function capture(msg) {
    const req = validateCaptureRequest(msg);
    if (!req.ok) return req;
    const current = now();
    prune(current);
    if ((runCounts.get(req.runId) || 0) >= MAX_PER_RUN) return { ok: false, error: 'budget_exceeded' };
    let frame;
    try { frame = await backend(req); }
    catch { return { ok: false, error: 'capture_failed' }; }
    const checked = checkCaptureFrame(frame);
    if (!checked.ok) return checked;

    // CF-DESK-05｜C09 脱敏复核：**先校验再入库**。失败立即丢弃明文，不写 store、不回原图、
    // 不生成证据，reason 只给原因码；capture() 返回体不含任何图像字节。
    const redaction = redactor(frame, checked);
    if (!redaction.ok) {
      if (frame && typeof frame === 'object') frame.bytes = null;
      checked.bytes = null;
      return { ok: false, error: 'redaction_rejected', reason: redaction.error };
    }

    const id = makeId();
    revision += 1;
    const windowDigest = createHash('sha256')
      .update(['CF-DESK-04', String(req.pid), req.grantId, req.runId,
        checked.bounds.x, checked.bounds.y, checked.bounds.w, checked.bounds.h].join('\x1f'), 'utf8')
      .digest('hex').slice(0, 32);
    const entry = {
      id,
      bytes: checked.bytes,
      byteSize: checked.bytes.length,
      width: checked.width,
      height: checked.height,
      bounds: checked.bounds,
      grantId: req.grantId,
      runId: req.runId,
      pid: req.pid,
      windowDigest,
      capturedAt: new Date(current).toISOString(),
      revision,
      expiresAt: current + CAPTURE_TTL_MS,
      redaction: { checks: redaction.checks, coverage: redaction.coverage },
    };
    store.set(id, entry);
    runCounts.set(req.runId, (runCounts.get(req.runId) || 0) + 1);
    return summarize(entry);
  }

  /** 原图只在 worker 进程内可达；grant 不匹配 / 已过期 / 已失效一律拒绝。 */
  function read(captureId, grantId) {
    const current = now();
    const key = String(captureId || '');
    const entry = store.get(key);
    if (!entry) return { ok: false, error: 'not_found' };
    // 先给出可读的原因码再回收：过期与失权都不得退回「静默成功」。
    if (entry.expiresAt <= current) { store.delete(key); return { ok: false, error: 'expired' }; }
    if (String(grantId || '') !== entry.grantId) return { ok: false, error: 'grant_invalid' };
    return { ok: true, bytes: entry.bytes, meta: summarize(entry) };
  }

  /**
   * CF-DESK-05｜脱敏证据出口（C09「上传/证据路径」）。
   * 与 read() 同样的 grant / TTL 校验，但**只回固定白名单摘要**：
   * image_digest 是原图的不可逆哈希，不含原文、base64、标题、进程路径或其它窗口清单。
   */
  function evidence(captureId, grantId) {
    const current = now();
    const key = String(captureId || '');
    const entry = store.get(key);
    if (!entry) return { ok: false, error: 'not_found' };
    if (entry.expiresAt <= current) { store.delete(key); return { ok: false, error: 'expired' }; }
    if (String(grantId || '') !== entry.grantId) return { ok: false, error: 'grant_invalid' };
    return buildRedactionEvidence(entry, entry.redaction);
  }

  /** 失权 / handoff / 锁屏：清空该 grant 下全部截图与历史越权读取。 */
  function invalidate(grantId) {
    const gid = String(grantId || '');
    if (!gid) return 0;
    let cleared = 0;
    for (const [id, entry] of store) {
      if (entry.grantId === gid) { store.delete(id); cleared += 1; }
    }
    return cleared;
  }

  function stats() { return { captures: store.size, runs: runCounts.size, revision }; }
  function clear() { store.clear(); runCounts.clear(); }

  return { capture, read, evidence, invalidate, stats, clear, CAPTURE_SCHEMA };
}

module.exports = {
  CAPTURE_SCHEMA, MAX_EDGE_PX, MAX_BYTES, MAX_PER_RUN, CAPTURE_TTL_MS, OPEN_ENDED_KEYS,
  REDACTION_SCHEMA, validateRedactionFrame, buildRedactionEvidence,
  validateCaptureRequest, checkCaptureFrame, buildCaptureScript,
  powershellWindowBackend, createCaptureService,
};
