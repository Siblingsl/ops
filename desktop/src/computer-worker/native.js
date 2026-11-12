'use strict';
// DEV-CU P2-0：Windows 本机执行层（从 computer-worker.js 原样搬出，零行为变更）。
// 内容：窗口枚举 + PowerShell UIA 桥（读树/单控件动作）。
// 隔离说明（27 §11.5.2）：UIA 具备进程级读取能力，不是应用沙箱——服务端逐动作校验
// 所选窗口与范围（agent_computer_grant + 硬禁区双层），worker 只按授权 PID 执行。
// 本文件不碰消息协议，只提供能力函数；协议与 busy 串行化在 index.js。

const { execFile } = require('node:child_process');

const { isHardForbidden } = require('./policy');

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

/** C01/C03：读取 PID 主窗口 UIA 控件树（Name/ControlType/Value/AutomationId，限 200 项）。 */
function readUIA(pid) {
  const script = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$proc = Get-Process -Id ${pid} -ErrorAction Stop
$root = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
$all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
# DEV-CU P1-1 步骤 4：四字段强制字符串并裁剪，上限对齐 business-ui-preload.ts:192-195（200/60/500/4000）；
# 原写法在属性缺失时返回 $null，会让 preload 白名单整批拒绝。
function Clip([string]$s, [int]$n) { if ($null -eq $s) { return '' }; if ($s.Length -gt $n) { return $s.Substring(0,$n) }; return $s }
$out = @()
$limit = [Math]::Min(200, $all.Count)
for ($i=0; $i -lt $limit; $i++) {
  $el = $all.Item($i)
  # 快照条目可能在枚举期间失效（目标窗口正在重绘/关闭）：此时 $el 为空，或 $el.Current 抛
  # ElementNotAvailableException。旧写法对空元素静默取到 $null 并产出 {id:'',type:'',name:'',value:''}
  # 的空行——既占满 200 项预算，也污染模型对控件的判断；而抛异常时整次读取直接失败。
  # 这里逐项容错：标识字段读不全或取不到 ControlType 的条目一律跳过（不是可操作控件）。
  $id = ''; $name = ''; $ct = $null
  try {
    $ct = $el.Current.ControlType
    $id = [string]$el.Current.AutomationId
    $name = [string]$el.Current.Name
  } catch { continue }
  if ($null -eq $ct) { continue }
  $type = Clip ([string]$ct.ProgrammaticName) 60
  if ([string]::IsNullOrEmpty($type)) { continue }
  $v = ''
  try { $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); $v = $vp.Current.Value } catch {}
  $out += @{ id=(Clip $id 200); type=$type; name=(Clip $name 500); value=(Clip ([string]$v) 4000) }
}
@{ ok=$true; window=$root.Current.Name; controls=$out } | ConvertTo-Json -Compress -Depth 4
`;
  return runPowerShell(script).then((r) => {
    if (!r.ok) return r;
    try {
      const parsed = JSON.parse(r.stdout || '{}');
      return { ok: true, window: parsed.window, controls: parsed.controls || [] };
    } catch {
      return { ok: false, error: 'uia_parse_failed' };
    }
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

module.exports = { listWindows, readUIA, invokeUIA, runPowerShell, psQuote, UIA_TIMEOUT_MS };
