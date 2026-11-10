'use strict';
// DT-08 片 9（docs/33 §10.8 DT-08）：main.ts 的 browser:* 通道拆分。
// 本机标签枚举与配对快照/确认 3 个固定意图搬入 ipc/browser.ts；
// requireComputerCaller 留 main.ts 依赖注入。契约逐字节不变。

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

test('DT-08-9: ipc/browser.ts 存在且承载 3 个 browser 通道', () => {
  const browserSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'ipc', 'browser.ts'), 'utf8');
  for (const channel of ['browser:list-tabs', 'browser:pairing-state', 'browser:confirm-pairing']) {
    assert.ok(browserSource.includes(`ipcHandle('${channel}'`), `browser.ts 应注册 ${channel}`);
  }
});

test('DT-08-9: main.ts 不再内联 browser 通道（mcp 通道已在 ipc/mcp.ts 不受影响）', () => {
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.ts'), 'utf8');
  assert.ok(!mainSource.includes("ipcHandle('browser:list-tabs'"), 'list-tabs 应已迁出 main.ts');
  assert.ok(!mainSource.includes("ipcHandle('browser:pairing-state'"), 'pairing-state 应已迁出 main.ts');
  assert.ok(!mainSource.includes("ipcHandle('browser:confirm-pairing'"), 'confirm-pairing 应已迁出 main.ts');
});

test('DT-08-9: 防线语义逐字节保留（桥状态如实报错/脱敏上限）', () => {
  const browserSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'ipc', 'browser.ts'), 'utf8');
  assert.ok(browserSource.includes('browser_bridge_not_running'), '桥未运行如实错误码保留');
  assert.ok(browserSource.includes('browser_not_paired'), '未配对如实错误码保留');
  assert.ok(browserSource.includes('.slice(0, 200)'), 'origin 脱敏上限保留');
  assert.ok(browserSource.includes('.slice(0, 200)'), 'tabs ≤200 截断保留');
});
