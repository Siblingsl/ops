'use strict';
// DT-08 片 11（docs/33 §10.8 DT-08）：desktop-client.ts 的 config/管理请求域拆分。
// loadConfig/saveConfig/decrypt/getWorkspace/getAccount/request/consumeManagementRequestMarker
// + ManagementRequestRegistry 持有搬入 client/config.ts 的 ConfigMixin（链底层）；
// DesktopClient 继承链改为 ConfigMixin ← ChannelMixin ← ModelsMixin ← PlatformMixin。

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

test('DT-08-11: client/config.ts 存在且承载 config/管理请求域', () => {
  const configSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'client', 'config.ts'), 'utf8');
  for (const symbol of ['loadConfig(', 'saveConfig(', 'decrypt(', 'getWorkspace(', 'consumeManagementRequestMarker(', 'ManagementRequestRegistry']) {
    assert.ok(configSource.includes(symbol), `config.ts 应包含 ${symbol}`);
  }
});

test('DT-08-11: DesktopClient 继承 ConfigMixin，desktop-client.ts 不再内联 config 方法体', () => {
  const clientSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'desktop-client.ts'), 'utf8');
  assert.ok(clientSource.includes('ConfigMixin'), 'DesktopClient 应继承 ConfigMixin');
  assert.ok(!clientSource.includes('protected async loadConfig('), 'loadConfig 应已迁出');
  assert.ok(!clientSource.includes('protected async saveConfig('), 'saveConfig 应已迁出');
  assert.ok(!clientSource.includes('protected decrypt('), 'decrypt 应已迁出');
  assert.ok(!clientSource.includes('protected async request<T>(pathName'), 'request 应已迁出');
});

test('DT-08-11: config 域防线逐字节保留（原子写/加密不可用拒绝/管理请求标记）', () => {
  const configSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'client', 'config.ts'), 'utf8');
  assert.ok(configSource.includes("throw new Error('本机设置文件无法读取。')"), '配置读取失败如实报错保留');
  assert.ok(configSource.includes("mode: 0o600"), '原子写临时文件 0600 权限保留');
  assert.ok(configSource.includes('系统加密存储不可用。'), '加密不可用拒绝保留');
  assert.ok(configSource.includes('本机密钥无法解密；请重新配置该密钥。'), '解密失败如实报错保留');
  assert.ok(configSource.includes('X-OPS-Desktop-Management-Request'), '管理请求标记头保留');
});
