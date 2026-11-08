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
    case 'ping':
      finish({ ok: true, pong: true });
      return;
    default:
      finish({ ok: false, error: 'unknown_cmd' });
  }
});
