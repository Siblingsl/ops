'use strict';
// DT-08 片 10（docs/33 §10.8 DT-08）：main.ts 的 settings:* 通道拆分。
// 28 个 settings:* 固定意图 + settings:local-state 事件搬入 ipc/settings.ts；
// 跨域依赖（客户端访问器/对话框宿主窗口/来源校验/导航/平台命令等）经 deps
// 依赖注入，契约与防线语义逐字节不变。

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const SETTINGS_CHANNELS = [
  'settings:local-state', 'settings:get-info', 'settings:export-diagnostics',
  'settings:get-models', 'settings:get-policy', 'settings:set-policy',
  'settings:get-devices', 'settings:revoke-device', 'settings:get-routes',
  'settings:save-routes', 'settings:start-model-test', 'settings:get-model-test',
  'settings:apply-mode', 'settings:reauthenticate', 'settings:get-accounts',
  'settings:change-account-type', 'settings:clear-account-data', 'settings:save-model',
  'settings:delete-model', 'settings:connect-ai', 'settings:disconnect-ai',
  'settings:retry-business-page', 'settings:open-login-page', 'settings:open-settings',
  'settings:take-platform-login-target', 'settings:close-local-window',
  'settings:platform-command', 'settings:platform-browser'
];

test('DT-08-10: ipc/settings.ts 存在且承载全部 28 个 settings 通道', () => {
  const settingsSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'ipc', 'settings.ts'), 'utf8');
  for (const channel of SETTINGS_CHANNELS) {
    if (channel === 'settings:local-state') {
      assert.ok(settingsSource.includes(`deps.ipcOn('${channel}'`), `settings.ts 应经 ipcOn 注册 ${channel}`);
    } else {
      assert.ok(settingsSource.includes(`ipcHandle('${channel}'`), `settings.ts 应注册 ${channel}`);
    }
  }
});

test('DT-08-10: main.ts 不再内联 settings 通道（校验/导航/平台命令经依赖注入）', () => {
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.ts'), 'utf8');
  for (const channel of SETTINGS_CHANNELS.slice(1)) {
    assert.ok(!mainSource.includes(`ipcHandle('${channel}'`), `${channel} 应已迁出 main.ts`);
  }
  assert.ok(!mainSource.includes("ipcMain.on('settings:local-state'"), 'local-state 应已迁出 main.ts');
  assert.ok(mainSource.includes('registerSettingsIpcHandlers'), 'main.ts 应接线 settings 模块');
  assert.ok(mainSource.includes('assertTrustedLocalSender'), '来源校验器应留 main.ts（依赖注入）');
});

test('DT-08-10: 防线语义逐字节保留（初始化守卫/输入校验文案/确认弹窗细节）', () => {
  const settingsSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'ipc', 'settings.ts'), 'utf8');
  assert.ok(settingsSource.includes("throw new Error('客户端设置尚未初始化。')"), '客户端未初始化守卫保留');
  assert.ok(settingsSource.includes('工作区策略字段无效。'), '策略字段校验保留');
  assert.ok(settingsSource.includes('设备回收字段无效。'), '设备回收校验保留');
  assert.ok(settingsSource.includes('账号已经是该内容类型。'), '内容类型幂等校验保留');
  assert.ok(settingsSource.includes('请先登录要清理的 OPS 账号。'), '清数据登录守卫保留');
  assert.ok(settingsSource.includes('清理会断开 AI 通道并终止这些调用'), '清数据计费提示保留');
  assert.ok(settingsSource.includes('任务映射版本或内容无效。'), '路由校验保留');
  assert.ok(settingsSource.includes('自检任务标识无效。'), '自检 ID 校验保留');
  assert.ok(settingsSource.includes("value !== 'server' && value !== 'desktop'"), '执行模式枚举校验保留');
});
