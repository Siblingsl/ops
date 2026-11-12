'use strict';
// DEV-CU P2-0：Windows 本机执行层（从 computer-worker.js 原样搬出，零行为变更）。
// 内容：窗口枚举 + PowerShell UIA 桥（读树/单控件动作）。
// 隔离说明（27 §11.5.2）：UIA 具备进程级读取能力，不是应用沙箱——服务端逐动作校验
// 所选窗口与范围（agent_computer_grant + 硬禁区双层），worker 只按授权 PID 执行。
// 本文件不碰消息协议，只提供能力函数；协议与 busy 串行化在 index.js。

const { execFile } = require('node:child_process');

const { isHardForbidden } = require('./policy');
const { buildObserveTree, boundsHash } = require('./tree');
const {
  newSnapshotId, nextRevision, allocateTreeRefs, qualifyTreeRefs,
  assertTreeSize, countRefs, refsAreUnique, WorkerError,
} = require('./refs');
const {
  resolveWindowStrict, assertIdentityProof, FullPredicate, classifyTree, decideResolution,
} = require('./resolve');

/** 枚举可见顶层窗口（PowerShell：有主窗口的进程）。返回脱敏摘要（pid/标题/进程名）。 */
function listWindows() {
  return new Promise((resolve) => {
    const script =
      "Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | " +
      "Select-Object Id,ProcessName,MainWindowTitle | ConvertTo-Json -Compress";
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 10_000, windowsHide: true, maxBuffer: 512 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve({ ok: false, error: 'enum_failed: ' + err.message.slice(0, 120), windows: [] });
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(stdout || '[]');
        } catch {
          resolve({ ok: false, error: 'enum_parse_failed', windows: [] });
          return;
        }
        const list = Array.isArray(parsed) ? parsed : [parsed];
        const windows = list
          .filter((w) => w && w.Id && w.MainWindowTitle)
          .map((w) => ({
            pid: Number(w.Id),
            process: String(w.ProcessName || '').slice(0, 64),
            title: String(w.MainWindowTitle || '').slice(0, 120),
            forbidden: isHardForbidden(w.ProcessName) || isHardForbidden(w.MainWindowTitle),
          }));
        resolve({ ok: true, windows });
      });
  });
}

// ---------------------------------------------------------------------------
// DEV-CU P2-5：窗口身份采样与前台复核（§4.9）。
// 标题只在 PowerShell 内参与 sha256，不出进程；返回只有哈希与数字。
// ---------------------------------------------------------------------------

/**
 * 轻量窗口身份采样（不读整棵树）。用于「动作前重算一遍身份」与服务端 handle 核对。
 * 返回 `{ok, pid, hwnd, process_start_time, title_hash, target_handle, bounds, window_bounds_hash}`。
 */
function windowIdentity(pid) {
  const script = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$proc = Get-Process -Id ${pid} -ErrorAction Stop
$hwnd = $proc.MainWindowHandle
$start = ''
try { $start = $proc.StartTime.ToUniversalTime().ToString('o') } catch {}
${PS_HASH_FN}
$title = [string]$proc.MainWindowTitle
$bx = 0.0; $by = 0.0; $bw = 0.0; $bh = 0.0
$hx = [long]$hwnd
if ($hx -ne 0) {
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
    $r = $root.Current.BoundingRectangle
    if (-not [double]::IsNaN($r.X) -and -not [double]::IsInfinity($r.X)) { $bx = [double]$r.X }
    if (-not [double]::IsNaN($r.Y) -and -not [double]::IsInfinity($r.Y)) { $by = [double]$r.Y }
    if (-not [double]::IsNaN($r.Width) -and -not [double]::IsInfinity($r.Width)) { $bw = [double]$r.Width }
    if (-not [double]::IsNaN($r.Height) -and -not [double]::IsInfinity($r.Height)) { $bh = [double]$r.Height }
  } catch {}
}
@{ ok=$true; pid=${pid}; hwnd=$hx; process_start_time=$start; title_hash=(Hex32 $title).Substring(0,32); target_handle=(Hex32 (('' + ${pid}) + [char]0 + $title)).Substring(0,32); bounds=@{ x=$bx; y=$by; w=$bw; h=$bh } } | ConvertTo-Json -Compress -Depth 4
`;
  return runPowerShell(script).then((r) => {
    if (!r.ok) return r;
    try {
      const raw = JSON.parse(r.stdout || '{}');
      if (raw.ok !== true) return { ok: false, error: raw.error || 'window_identity_failed' };
      const bounds = raw.bounds || { x: 0, y: 0, w: 0, h: 0 };
      return {
        ok: true,
        pid: Number(raw.pid) || 0,
        hwnd: Number(raw.hwnd) || 0,
        process_start_time: String(raw.process_start_time || ''),
        title_hash: String(raw.title_hash || ''),
        target_handle: String(raw.target_handle || ''),
        bounds,
        // 与 refs.js 的 boundsHash 用同一个算法（四舍五入后拼接再 sha256 前 16 位）
        window_bounds_hash: boundsHash(bounds),
      };
    } catch {
      return { ok: false, error: 'uia_parse_failed' };
    }
  });
}

/** 前台窗口（hwnd + 所属 pid）。用于动作前复核与「前台已切走」判定。 */
function foregroundWindow() {
  const script = `
$ErrorActionPreference='Stop'
Add-Type -Namespace OpsScope -Name Native -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint lpdwProcessId);
'@
$h = [OpsScope.Native]::GetForegroundWindow()
$p = 0
if ($h -ne [System.IntPtr]::Zero) { [void][OpsScope.Native]::GetWindowThreadProcessId($h, [ref]$p) }
@{ ok=$true; hwnd=[long]$h; pid=[int]$p } | ConvertTo-Json -Compress
`;
  return runPowerShell(script).then((r) => {
    if (!r.ok) return r;
    try {
      const raw = JSON.parse(r.stdout || '{}');
      if (raw.ok !== true) return { ok: false, error: raw.error || 'foreground_failed' };
      return { ok: true, hwnd: Number(raw.hwnd) || 0, pid: Number(raw.pid) || 0 };
    } catch {
      return { ok: false, error: 'uia_parse_failed' };
    }
  });
}

// ---------------------------------------------------------------------------
// DEV-AI27-17 UIA 桥（W17 第三批）：PowerShell + System.Windows.Automation。
// ---------------------------------------------------------------------------

const UIA_TIMEOUT_MS = 15_000;

function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function runPowerShell(script) {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: UIA_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          resolve({ ok: false, error: 'uia_failed: ' + String(err.message).slice(0, 120) });
          return;
        }
        resolve({ ok: true, stdout: stdout || '' });
      });
  });
}

/** P2-5：PowerShell 侧的 sha256 十六进制辅助函数（标题只在 PS 内参与哈希，不出进程）。 */
const PS_HASH_FN = `
function Hex32([string]$s) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { $h = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($s)) } finally { $sha.Dispose() }
  return ([System.BitConverter]::ToString($h) -replace '-','').ToLower()
}
`;

/**
 * P2-5 步骤 3/4：动作前的前台复核，直接嵌进执行动作的那一次 PS 调用，
 * 避免「先查再动」两次调用之间的窗口切换（TOCTOU）。
 */
function psForegroundGuard(pid) {
  return `
Add-Type -Namespace OpsScope -Name Native -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint lpdwProcessId);
'@
$hwnd = $proc.MainWindowHandle
$fg = [OpsScope.Native]::GetForegroundWindow()
$fgPid = 0
if ($fg -ne [System.IntPtr]::Zero) { [void][OpsScope.Native]::GetWindowThreadProcessId($fg, [ref]$fgPid) }
if ($fgPid -ne ${pid}) { Write-Output '{"ok":false,"error":"computer_target_changed","detail":{"kind":"target_changed","reason":["foreground_changed"],"retryable":true}}'; exit }
if ([long]$fg -ne [long]$hwnd) { Write-Output '{"ok":false,"error":"computer_target_changed","detail":{"kind":"target_changed","reason":["hwnd_changed"],"retryable":true}}'; exit }
`;
}

/** 读取 PID 主窗口的原始控件树（RawViewWalker 递归，带三重上限）。P2-4 的再解析复用它。 */
function readRawTree(pid) {
  const script = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$proc = Get-Process -Id ${pid} -ErrorAction Stop
$hwnd = $proc.MainWindowHandle
$startTime = ''
try { $startTime = $proc.StartTime.ToUniversalTime().ToString('o') } catch {}
${PS_HASH_FN}
# P2-5 步骤 1/2：标题只在 PS 内参与哈希，不落进 JSON；handle 与 ipc/computer.ts:31 同一公式。
$title = [string]$proc.MainWindowTitle
$titleHash = (Hex32 $title).Substring(0,32)
$targetHandle = (Hex32 (('' + ${pid}) + [char]0 + $title)).Substring(0,32)
$root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
$walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
# DEV-CU P1-1 步骤 4：四字段强制字符串并裁剪，上限对齐 business-ui-preload.ts:192-195（200/60/500/4000）。
function Clip([string]$s, [int]$n) { if ($null -eq $s) { return '' }; if ($s.Length -gt $n) { return $s.Substring(0,$n) }; return $s }
# P2-1：UIA 的 BoundingRectangle 在虚拟化/屏外元素上可能返回 NaN 或 Infinity，
# ConvertTo-Json 会原样写出 Infinity 导致整段 JSON 非法（实测 W17c 报 uia_parse_failed）。
function SafeNum([double]$v) { if ([double]::IsNaN($v) -or [double]::IsInfinity($v)) { return 0.0 }; return $v }
$MAX_NODES = 200
$MAX_DEPTH = 50
$MAX_SIBLINGS = 10000
$complete = $true
# P2-1 步骤 1：RawViewWalker 逐层遍历，记录 depth/parent，不再 FindAll 平铺。
# 队列元素 parent 指向「已产出节点」的下标；节点自身失效时子节点继承其 parent，避免断链。
$queue = New-Object System.Collections.ArrayList
$null = $queue.Add(@{ el=$root; depth=0; parent=-1 })
$emitted = New-Object System.Collections.ArrayList
$qi = 0
while ($qi -lt $queue.Count) {
  $item = $queue[$qi]
  $qi++
  $el = $item.el
  $roleRaw = ''
  $name = ''; $id = ''; $value = ''
  $enabled = $false; $offscreen = $false
  $bx = 0; $by = 0; $bw = 0; $bh = 0
  $hasValue = $false; $hasInvoke = $false
  # 快照条目可能在枚举期间失效：读不到 ControlType 就不产出该节点（同 P1-1 的空行修复）。
  try {
    $roleRaw = [string]$el.Current.ControlType.ProgrammaticName
    $name = [string]$el.Current.Name
    $id = [string]$el.Current.AutomationId
    $enabled = [bool]$el.Current.IsEnabled
    $offscreen = [bool]$el.Current.IsOffscreen
    $r = $el.Current.BoundingRectangle
    $bx = SafeNum ([double]$r.X); $by = SafeNum ([double]$r.Y)
    $bw = SafeNum ([double]$r.Width); $bh = SafeNum ([double]$r.Height)
  } catch { $roleRaw = '' }
  $ownIndex = -1
  if (-not [string]::IsNullOrEmpty($roleRaw)) {
    $vpObj = $null
    try { $hasValue = [bool]$el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vpObj) } catch { $hasValue = $false }
    if ($hasValue) { try { $value = [string]$vpObj.Current.Value } catch { $value = '' } }
    $ipObj = $null
    try { $hasInvoke = [bool]$el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$ipObj) } catch { $hasInvoke = $false }
    $rec = @{
      parent=$item.parent; depth=$item.depth; role_raw=$roleRaw; name=(Clip $name 500); id=(Clip $id 200);
      value=(Clip $value 4000); enabled=$enabled; offscreen=$offscreen;
      bounds=@{ x=$bx; y=$by; w=$bw; h=$bh }; has_value=$hasValue; has_invoke=$hasInvoke;
      children_count=0; stale=$false
    }
    $null = $emitted.Add($rec)
    $ownIndex = $emitted.Count - 1
  }
  $childParent = $item.parent
  if ($ownIndex -ge 0) { $childParent = $ownIndex }
  # 深度上限：还有子节点就置 complete=false，不再深入。
  if ($item.depth -ge $MAX_DEPTH) {
    try { if ($null -ne $walker.GetFirstChild($el)) { $complete = $false } } catch { }
    continue
  }
  $count = 0
  $child = $null
  try { $child = $walker.GetFirstChild($el) } catch { $child = $null }
  while ($null -ne $child) {
    $count++
    if ($count -gt $MAX_SIBLINGS) { $complete = $false; break }
    if ($queue.Count -lt $MAX_NODES) {
      $null = $queue.Add(@{ el=$child; depth=$item.depth+1; parent=$childParent })
    } else { $complete = $false }
    try { $child = $walker.GetNextSibling($child) } catch { $child = $null }
  }
  if ($ownIndex -ge 0) { $emitted[$ownIndex].children_count = $count }
}
$winName = ''
try { $winName = [string]$root.Current.Name } catch {}
@{ ok=$true; window=$winName; pid=${pid}; hwnd=[long]$hwnd; process_start_time=$startTime; title_hash=$titleHash; target_handle=$targetHandle; tree_complete=$complete; nodes_observed=$queue.Count; nodes=$emitted } | ConvertTo-Json -Compress -Depth 6
`;
  return runPowerShell(script).then((r) => {
    if (!r.ok) return r;
    try {
      const parsed = JSON.parse(r.stdout || '{}');
      if (parsed.ok !== true) return { ok: false, error: parsed.error || 'uia_failed' };
      return { ok: true, raw: parsed };
    } catch {
      return { ok: false, error: 'uia_parse_failed' };
    }
  });
}

/**
 * 一次观察（不分配 ref）。P2-4 的严格再解析用它重读**同一窗口**；
 * 与 readUIA 的区别只有「不生成 snapshot、不分配 ref」。
 */
function observeOnce(pid) {
  return readRawTree(pid).then((r) => {
    if (!r.ok) return r;
    const built = buildObserveTree(r.raw);
    return {
      ok: true,
      window: r.raw.window,
      tree: built.tree,
      complete: built.complete,
      nodes_observed: built.nodes_observed,
      window_identity: built.window_identity,
      controls: built.controls,
    };
  });
}

/** C01/C03 + P2-2：观察 + 绑定 snapshot + 分配 ref。 */
function readUIA(pid) {
  return observeOnce(pid).then((built) => {
    if (!built.ok) return built;
    // P2-2：一次观察绑定一个 snapshot_id + 单调 revision；ref 在本进程内分配后立即限定。
    const snapshotId = newSnapshotId();
    const revision = nextRevision();
    let allocated;
    try {
      allocated = allocateTreeRefs(built.tree, {
        snapshotId, revision, identity: built.window_identity, complete: built.complete,
      });
      qualifyTreeRefs(allocated.tree, snapshotId);
      assertTreeSize(allocated.tree);
    } catch (e) {
      if (e instanceof WorkerError) return { ok: false, error: e.code, message: e.message };
      throw e;
    }
    // 自检：ref_count 必须与树中 ref_id 数量一致、且两两不同（P2-2 完成判据）。
    if (countRefs(allocated.tree) !== allocated.count || !refsAreUnique(allocated.tree)) {
      return { ok: false, error: 'computer_internal', message: 'ref 分配自检失败' };
    }
    const result = {
      ok: true,
      window: built.window,
      // P2-2 新增
      snapshot_id: snapshotId,
      revision,
      ref_count: allocated.count,
      tree: allocated.tree,
      // P2-1 字段
      complete: built.complete,
      nodes_observed: built.nodes_observed,
      window_identity: built.window_identity,
      // 兼容视图：P1-3 的 preload 集成用例仍按四键平铺校验，P3-7 切树后移除
      controls: built.controls,
    };
    // P2-3：RefMap 以不可枚举属性挂回，供 index.js 存入 RefStore；
    // 不可枚举 → 不进入 postMessage/JSON，不会外泄到 preload 或渲染器。
    Object.defineProperty(result, 'refmap', {
      value: allocated.map, enumerable: false, configurable: true, writable: true,
    });
    return result;
  });
}

/** C05/C06：单控件动作——ValuePattern.SetValue（有 value 时）或 InvokePattern.Invoke。 */
function invokeUIA(pid, automationId, value) {
  const valueBlock = value === null
    ? `try { $ip = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern); $ip.Invoke(); Write-Output '{"ok":true,"action":"invoke"}' } catch { Write-Output '{"ok":false,"error":"no_invoke_pattern"}' }`
    : `try { $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); $vp.SetValue(${psQuote(value)}); Write-Output '{"ok":true,"action":"setvalue"}' } catch { Write-Output '{"ok":false,"error":"no_value_pattern"}' }`;
  const script = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$proc = Get-Process -Id ${pid} -ErrorAction Stop
$root = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
${psForegroundGuard(pid)}
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, ${psQuote(automationId)})
$el = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
if (-not $el) { Write-Output '{"ok":false,"error":"control_not_found"}'; exit }
${valueBlock}
`;
  return runPowerShell(script).then((r) => {
    if (!r.ok) return r;
    try { return JSON.parse(r.stdout || '{"ok":false,"error":"empty"}'); }
    catch { return { ok: false, error: 'uia_parse_failed' }; }
  });
}

/**
 * P2-4：严格再解析——用快照里的 RefEntry 当身份谓词，在**同一窗口**的新观察里找唯一活元素。
 * 返回 { ok:true, path } 或 { ok:false, error, message, detail }。
 * 不做动作，动作由 invokeByPath 执行（两步分开，便于先判定再落手）。
 */
function resolveAndObserve(pid, entry, snapshotId, ref) {
  const fail = (e) => ({
    ok: false,
    error: (e && e.code) || 'computer_internal',
    message: (e && e.message) || String(e),
    detail: e && e.detail,
  });
  return Promise.resolve()
    // 步骤 7：身份不可证的 ref 在读树前拒绝（无身份字段 / 无 id 且捕获时不唯一）。
    .then(() => assertIdentityProof(entry, snapshotId, ref))
    .then(() => observeOnce(pid))
    .then((obs) => {
      if (!obs.ok) return { ok: false, error: obs.error || 'uia_failed' };
      try {
        // 步骤 2：窗口身份四要素严格比对（pid / start_time / hwnd / bounds_hash）
        resolveWindowStrict(entry.window_identity || {}, obs.window_identity);
        // 步骤 4/5：身份谓词 + 零/多/未知判定
        const predicate = FullPredicate.ofEntry(entry);
        const classified = classifyTree(obs.tree, predicate);
        const match = decideResolution(
          { ...classified, complete: obs.complete }, entry, snapshotId, ref,
        );
        return { ok: true, path: match.path, node: match.node, window: obs.window };
      } catch (e) {
        return fail(e);
      }
    })
    .catch(fail);
}

/** P2-4：按路径（相对根的下标链）定位元素并执行动作；与旧 AutomationId 分支并行存在。 */
function invokeByPath(pid, path, value) {
  const chain = Array.isArray(path) && path.length ? path.map((n) => Number(n)).join(',') : '';
  const valueBlock = value === null
    ? `try { $ip = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern); $ip.Invoke(); Write-Output '{"ok":true,"action":"invoke"}' } catch { Write-Output '{"ok":false,"error":"no_invoke_pattern"}' }`
    : `try { $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); $vp.SetValue(${psQuote(value)}); Write-Output '{"ok":true,"action":"setvalue"}' } catch { Write-Output '{"ok":false,"error":"no_value_pattern"}' }`;
  const script = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$proc = Get-Process -Id ${pid} -ErrorAction Stop
$root = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
${psForegroundGuard(pid)}
$walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
$el = $root
$path = @(${chain})
foreach ($i in $path) {
  $found = $null
  $next = $null
  try { $next = $walker.GetFirstChild($el) } catch { $next = $null }
  $k = 0
  while ($null -ne $next) {
    if ($k -eq $i) { $found = $next; break }
    $k++
    try { $next = $walker.GetNextSibling($next) } catch { $next = $null }
  }
  if ($null -eq $found) { Write-Output '{"ok":false,"error":"control_not_found"}'; exit }
  $el = $found
}
${valueBlock}
`;
  return runPowerShell(script).then((r) => {
    if (!r.ok) return r;
    try { return JSON.parse(r.stdout || '{"ok":false,"error":"empty"}'); }
    catch { return { ok: false, error: 'uia_parse_failed' }; }
  });
}

module.exports = {
  listWindows, windowIdentity, foregroundWindow,
  readRawTree, observeOnce, readUIA, invokeUIA, invokeByPath, resolveAndObserve,
  runPowerShell, psQuote, UIA_TIMEOUT_MS,
};
