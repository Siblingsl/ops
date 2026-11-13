'use strict';
// DEV-CU P4-11 收口：本机授权登记表（无窗口/网络）。
const assert = require('node:assert/strict');
const test = require('node:test');

const registry = require('../src/computer-authorizations-loader.cjs');

test('登记后可按 grant 取 pid/generation/摘要', () => {
  registry.clearComputerAuthorizations();
  registry.recordComputerAuthorization({ grantId: 'g1', generation: 3, pid: 42, targetSummary: '记事本 - 无标题' });
  const entry = registry.computerAuthorizationOf('g1');
  assert.equal(entry.pid, 42);
  assert.equal(entry.generation, 3);
  assert.equal(entry.targetSummary, '记事本 - 无标题');
  assert.equal(registry.computerAuthorizationGeneration('g1'), 3);
});

test('旧 generation 不覆盖新授权', () => {
  registry.clearComputerAuthorizations();
  registry.recordComputerAuthorization({ grantId: 'g2', generation: 5, pid: 7, targetSummary: 'A' });
  registry.recordComputerAuthorization({ grantId: 'g2', generation: 3, pid: 8, targetSummary: 'B' });
  assert.equal(registry.computerAuthorizationOf('g2').generation, 5);
  assert.equal(registry.computerAuthorizationOf('g2').pid, 7);
});

test('未登记/已撤销返回 null（executor 据此回 unknown_outcome）', () => {
  registry.clearComputerAuthorizations();
  assert.equal(registry.computerAuthorizationGeneration('missing'), null);
  registry.recordComputerAuthorization({ grantId: 'g3', generation: 0, pid: 9, targetSummary: 'C' });
  registry.forgetComputerAuthorization('g3');
  assert.equal(registry.computerAuthorizationGeneration('g3'), null);
});

test('非法 pid 不登记；clear 返回被清理的 grant 列表', () => {
  registry.clearComputerAuthorizations();
  registry.recordComputerAuthorization({ grantId: 'bad', generation: 1, pid: -1, targetSummary: 'X' });
  assert.equal(registry.computerAuthorizationOf('bad'), undefined);
  registry.recordComputerAuthorization({ grantId: 'g4', generation: 1, pid: 10, targetSummary: 'D' });
  registry.recordComputerAuthorization({ grantId: 'g5', generation: 2, pid: 11, targetSummary: 'E' });
  const cleared = registry.clearComputerAuthorizations().sort();
  assert.deepEqual(cleared, ['g4', 'g5']);
});
