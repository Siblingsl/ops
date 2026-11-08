'use strict';
// DEV-AI27-17 第二批（W17b）：Windows 电脑控制执行 worker（utilityProcess 隔离进程）。
// 职责（27 §11.5.2）：窗口枚举（选窗器数据源）+ 目标窗口脱敏摘要。
// 边界：worker 只做读取与父进程授权后的受控动作；不开放任意 Win32/PowerShell RPC；
// 硬禁区在服务端（agent_computer.go）与本机双重校验；UIA 完整读写经 PowerShell UIA 桥分批引入。
// 本批实现窗口枚举（EnumWindows via PowerShell Get-Process | 窗口标题过滤），
// 动作执行（focus/type/click）经 UIA 脚本在后续批引入——本批先交付枚举+校验骨架。

// 兼容 utilityProcess（parentPort）与 child_process.fork（process.send）两种宿主。
const { parentPort } = require('node:worker_threads');
const { execFile } = require('node:child_process');
const channel = parentPort ?? process;

// 硬禁区（27 §11.5.2）：与 server/internal/app/agent_computer.go 保持一致。
const HARD_FORBIDDEN = [
  'winlogon', 'csrss', 'wininit', 'lsass', 'smss',
  'taskmgr', 'cmd', 'powershell', 'pwsh',
  'regedit', 'secpol', 'gpedit',
  'credential', 'vault', 'uac', 'consent',
  '凭据管理', '密码管理', '命令提示符', '注册表', '安全中心',
];

function isHardForbidden(text) {
  const lower = String(text || '').toLowerCase();
  return HARD_FORBIDDEN.some((p) => lower.includes(p));
}

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

let busy = false;

channel.on('message', (msg) => {
  if (busy) {
    channel.postMessage ? channel.postMessage({ id: msg && msg.id, ok: false, error: 'worker_busy' }) : channel.send({ id: msg && msg.id, ok: false, error: 'worker_busy' });
    return;
  }
  busy = true;
  const finish = (result) => {
    busy = false;
    channel.postMessage ? channel.postMessage({ id: msg && msg.id, ...result }) : channel.send({ id: msg && msg.id, ...result });
  };
  if (!msg || typeof msg !== 'object' || typeof msg.id !== 'string') {
    finish({ ok: false, error: 'invalid_message' });
    return;
  }
  switch (msg.cmd) {
    case 'list_windows':
      // 不上传全部清单到服务端（C09）：枚举在本机完成，OPS 只拿到用户选中项。
      listWindows().then(finish);
      return;
    case 'uia_read': {
      // C01/C03：读取目标进程主窗口的 UIA 控件树（ControlType/Name/Value，限 200 项）。
      // 硬禁区在服务端已拒（agent_computer.go），此处再校验一次（纵深防御，27 §11.5.2）。
      const summary = String(msg.target_summary || '');
      if (isHardForbidden(summary)) { finish({ ok: false, error: 'hard_forbidden' }); return; }
      const pid = Number(msg.pid);
      if (!Number.isInteger(pid) || pid <= 0) { finish({ ok: false, error: 'pid_invalid' }); return; }
      readUIA(pid).then(finish);
      return;
    }
    case 'uia_invoke': {
      // C05/C06：单控件动作（ValuePattern.SetValue 或 InvokePattern.Invoke）。
      // 单次批准绑定 action hash 由服务端票据管理；worker 只按授权 PID+AutomationId 执行。
      const summary2 = String(msg.target_summary || '');
      if (isHardForbidden(summary2)) { finish({ ok: false, error: 'hard_forbidden' }); return; }
      const pid2 = Number(msg.pid);
      const autoId = String(msg.automation_id || '');
      const value = msg.value === undefined ? null : String(msg.value);
      if (!Number.isInteger(pid2) || pid2 <= 0 || !autoId) { finish({ ok: false, error: 'params_invalid' }); return; }
      invokeUIA(pid2, autoId, value).then(finish);
      return;
    }
    case 'ping':
      finish({ ok: true, pong: true });
      return;
    default:
      finish({ ok: false, error: 'unknown_cmd' });
  }
});

// ---------------------------------------------------------------------------
// DEV-AI27-17 UIA 桥（W17 第三批）：PowerShell + System.Windows.Automation。
// 隔离说明（27 §11.5.2）：UIA 具备进程级读取能力，不是应用沙箱——服务端逐动作校验
// 所选窗口与范围（agent_computer_grant + 硬禁区双层），worker 只按授权 PID 执行。
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
$out = @()
$limit = [Math]::Min(200, $all.Count)
for ($i=0; $i -lt $limit; $i++) {
  $el = $all.Item($i)
  $v = ''
  try { $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); $v = $vp.Current.Value } catch {}
  $out += @{ id=$el.CurrentAutomationId; type=$el.CurrentControlType.ProgrammaticName; name=$el.CurrentName; value=$v }
}
@{ ok=$true; window=$root.CurrentName; controls=$out } | ConvertTo-Json -Compress -Depth 4
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
