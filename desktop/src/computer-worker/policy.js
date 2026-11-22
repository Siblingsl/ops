'use strict';
// DEV-CU P2-0：硬禁区策略（从 computer-worker.js 原样搬出，零行为变更）。
// 硬禁区（27 §11.5.2）：与 server/internal/app/agent_computer.go 保持一致。
// Q-17（docs/41）：补齐文档点名的「终端」（Windows Terminal）与常见系统管理/滥用面
// 进程（wmic、证书/服务/计划任务/用户组等 MSC、下载执行链 certutil/bitsadmin/mshta）。

const HARD_FORBIDDEN = [
  'winlogon', 'csrss', 'wininit', 'lsass', 'smss',
  'taskmgr', 'cmd', 'powershell', 'pwsh',
  'regedit', 'secpol', 'gpedit',
  'credential', 'vault', 'uac', 'consent',
  '凭据管理', '密码管理', '命令提示符', '注册表', '安全中心',
  // Q-17：终端（docs/16 §11.5.2 点名）与系统管理/滥用面。
  'wt.exe', 'windowsterminal', 'terminal',
  'wmic', 'certutil', 'bitsadmin', 'mshta', 'rundll32',
  'reg add', 'reg delete', 'net user', 'net localgroup',
  'taskschd', 'lusrmgr', 'eventvwr', 'diskmgmt', 'services.msc', 'devmgmt', 'ncpa.cpl',
  '任务计划', '服务管理', '设备管理', '事件查看', '本地用户',
];

function isHardForbidden(text) {
  const lower = String(text || '').toLowerCase();
  return HARD_FORBIDDEN.some((p) => lower.includes(p));
}

module.exports = { HARD_FORBIDDEN, isHardForbidden };
