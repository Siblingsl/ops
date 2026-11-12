'use strict';
// DEV-CU P2-0：硬禁区策略（从 computer-worker.js 原样搬出，零行为变更）。
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

module.exports = { HARD_FORBIDDEN, isHardForbidden };
