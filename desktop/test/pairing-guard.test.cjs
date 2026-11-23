const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { PairingAttemptGuard, SerialQueue, MAX_PAIRING_FAILURES } = require('../.build/platforms/pairing-guard.js');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('B-10.1 连续 5 次失败作废全部 pending；原正确短码也失效', () => {
  const guard = new PairingAttemptGuard();
  guard.addPending({ id: 'p1', code: 'ABCD-EFGH', expiresAt: 2_000 }, 1_000);
  guard.addPending({ id: 'p2', code: 'WXYZ-2345', expiresAt: 2_000 }, 1_000);
  assert.equal(guard.pendingCount(1_000), 2);
  assert.equal(MAX_PAIRING_FAILURES, 5);
  for (let i = 1; i < 5; i += 1) {
    const r = guard.failure();
    assert.equal(r.locked, false, `第 ${i} 次不应锁定`);
    assert.equal(r.invalidated, 0);
  }
  const fifth = guard.failure();
  assert.equal(fifth.locked, true);
  assert.equal(fifth.invalidated, 2);
  assert.equal(guard.pendingCount(1_000), 0, '正确短码也失效');
  assert.equal(guard.success(), false, '锁定后即使“验证成功”也不恢复');
});

test('B-10.1 成功清零；用户显式 reset 才解锁', () => {
  const guard = new PairingAttemptGuard();
  guard.failure();
  guard.failure();
  assert.equal(guard.success(), true);
  assert.equal(guard.failure().failures, 1, '成功后重新计数');
  guard.failure();
  guard.failure();
  guard.failure();
  guard.failure();
  assert.equal(guard.isLocked(), true);
  guard.reset();
  assert.equal(guard.isLocked(), false);
  assert.equal(guard.failure().failures, 1);
});

test('B-10.2 过期 pending 自动剔除，不参与计数', () => {
  const guard = new PairingAttemptGuard();
  guard.addPending({ id: 'p1', code: 'C1', expiresAt: 500 });
  guard.addPending({ id: 'p2', code: 'C2', expiresAt: 5_000 });
  assert.equal(guard.pendingCount(1_000), 1);
});

test('B-10.3 串行队列保证读-改-写不丢条目，异常不阻塞后续', async () => {
  const queue = new SerialQueue();
  const order = [];
  let state = 0;
  const tasks = [];
  for (let i = 1; i <= 5; i += 1) {
    tasks.push(queue.run(async () => {
      const readValue = state;
      await new Promise((resolve) => setTimeout(resolve, 10));
      state = readValue + 1;
      order.push(i);
    }));
  }
  await Promise.all(tasks);
  assert.equal(state, 5, '并发读改写全部生效');
  assert.deepEqual(order, [1, 2, 3, 4, 5], '严格按入队顺序');
  await assert.rejects(queue.run(() => { throw new Error('boom'); }), /boom/);
  const after = await queue.run(() => 'ok');
  assert.equal(after, 'ok', '异常后队列继续');
});

test('B-10.4 短码仍不作为认证凭据；ECDH/token 掩码不引入', () => {
  const bridge = read('src/browser-bridge.ts');
  assert.match(bridge, /confirmPairing\(\): \{ ok: boolean; reason\?: string \}/, 'confirmPairing 不接收短码');
  assert.doesNotMatch(bridge, /ecdh|ECDH|wrap_token|PBKDF2/i, '不引入 ECDH/token 包装');
  const readme = read('chrome-extension/README.md');
  assert.match(readme, /短码.*人工|人工.*短码|不是认证凭据/, 'README 保持“短码只供人工核对”');
});
