'use strict';
// DT-08 片 7（docs/33 §10.8 DT-08）：desktop-client.ts 平台域拆分。
// 平台采集能力/平台设备登记/连接 CRUD/同步触发/presence/平台签名请求（约 350 行）
// 搬到 client/platform.ts 的 PlatformMixin；façade 继承。

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

test('DT-08C: client/platform.ts 存在且承载平台方法', () => {
  const platformSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'client', 'platform.ts'), 'utf8');
  for (const symbol of ['getPlatformCollectionCapability(', 'ensurePlatformDevice(', 'platformSignedCall(', 'platformSignedRequest', 'requestPlatformAccountSync(', 'presence(', 'listPlatformConnections(']) {
    assert.ok(platformSource.includes(symbol), `platform.ts 应包含 ${symbol}`);
  }
});

test('DT-08C: DesktopClient 继承 PlatformMixin，desktop-client.ts 不再内联平台方法体', () => {
  const clientSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'desktop-client.ts'), 'utf8');
  assert.ok(clientSource.includes('PlatformMixin'), 'DesktopClient 应继承 PlatformMixin');
  assert.ok(!clientSource.includes('async ensurePlatformDevice('), 'ensurePlatformDevice 应已迁出');
  assert.ok(!clientSource.includes('private async platformSignedRequest<'), 'platformSignedRequest 应已迁出');
});

test('DT-08C: 平台域防线保留（不支持旧服务器的如实报错与 GET 空体摘要）', () => {
  const platformSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'client', 'platform.ts'), 'utf8');
  assert.ok(platformSource.includes('服务端尚未启用平台数据采集。'), '能力未开启如实报错保留');
  assert.ok(platformSource.includes('GET/HEAD 不能带 body'), 'GET 空体摘要注释保留（防验签失败回归）');
});
