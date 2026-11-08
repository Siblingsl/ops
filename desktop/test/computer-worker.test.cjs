'use strict';
// DEV-AI27-17 W17b：电脑控制 worker 测试（真实 utilityProcess 子进程枚举真实窗口）。

const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const WORKER = path.resolve(__dirname, '..', 'src', 'computer-worker.js');

function withWorker(t) {
  const child = fork(WORKER, [], { stdio: 'ignore', env: { OPS_DESKTOP_WORKER: '1' } });
  let nextID = 1;
  const pending = new Map();
  child.on('message', (msg) => {
    if (!msg || typeof msg.id !== 'string') return;
    const call = pending.get(msg.id);
    if (!call) return;
    pending.delete(msg.id);
    call.resolve(msg);
  });
  t.after(() => child.kill());
  return {
    call(cmd, timeoutMs = 20_000) {
      const id = `t${nextID++}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('worker_timeout'));
        }, timeoutMs);
        pending.set(id, { resolve, reject: (e) => reject(new Error(e)) , timer });
        child.send({ id, cmd });
      });
    },
  };
}

test('W17 worker: ping 响应', { timeout: 30_000 }, async (t) => {
  const worker = withWorker(t);
  const result = await worker.call('ping');
  assert.equal(result.ok, true);
  assert.equal(result.pong, true);
});

test('W17 worker: 枚举真实窗口（Windows 本机）', { timeout: 40_000 }, async (t) => {
  if (process.platform !== 'win32') t.skip('需要 Windows');
  const worker = withWorker(t);
  const result = await worker.call('list_windows');
  assert.equal(result.ok, true, result.error || '');
  assert.ok(Array.isArray(result.windows));
  // 本机一定有部分可见窗口；每项含 pid/process/title/forbidden
  for (const w of result.windows) {
    assert.equal(typeof w.pid, 'number');
    assert.equal(typeof w.process, 'string');
    assert.equal(typeof w.title, 'string');
    assert.equal(typeof w.forbidden, 'boolean');
    assert.ok(w.title.length > 0, '枚举只返回有标题窗口');
  }
  // 硬禁区标记正确：cmd/powershell 等进程名应标 forbidden
  for (const w of result.windows) {
    if (/cmd|powershell|regedit/i.test(w.process)) {
      assert.equal(w.forbidden, true, `${w.process} 应标记硬禁区`);
    }
  }
});

test('W17 worker: 未知命令拒绝', { timeout: 20_000 }, async (t) => {
  const worker = withWorker(t);
  const result = await worker.call('execute_shell');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'unknown_cmd');
});
