'use strict';
// Q-22（docs/41）：真实 Chrome 首装复跑暴露 native host 启动竞态——扩展 hello 在
// 桥 TCP 连接建立前到达会被旧实现直接 drop，桥端 extension_instance_id 恒为 null，
// W04 首次连接向导 confirm 报“实例标识必须是 UUID”。本用例模拟“先 hello、后连桥”，
// 断言宿主连接后先发自己的 hello、再补发扩展 hello（携带实例 ID）。
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { encodeFrame, PROTOCOL_VERSION } = require('../src/native-host/host.js');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function waitFor(predicate, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`timeout: ${label}`));
      }
    }, 20);
  });
}

test('Q-22：扩展 hello 早于桥连接时缓冲补发，桥先收宿主 hello 再收实例 ID', async () => {
  const port = await freePort();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-native-host-'));
  const instanceId = crypto.randomUUID();
  const hostPath = path.join(__dirname, '../src/native-host/host.js');
  let child;
  let bridge;

  try {
    child = spawn(process.execPath, [hostPath], {
      env: {
        ...process.env,
        OPS_DESKTOP_BRIDGE_PORT: String(port),
        OPS_BROWSER_BRIDGE_STATE_DIR: stateDir,
      },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.on('error', () => undefined);
    child.stdin.on('error', () => undefined);
    // 宿主尚未连上桥时扩展就发 hello（复现真实首装时序）。
    await new Promise((resolve) => setTimeout(resolve, 150));
    child.stdin.write(encodeFrame({
      v: PROTOCOL_VERSION,
      type: 'hello',
      payload: {
        extension_instance_id: instanceId,
        protocol_version: PROTOCOL_VERSION,
        crypto_versions: [1, 2],
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 250));

    const received = [];
    bridge = net.createServer((socket) => {
      socket.on('error', () => undefined);
      socket.on('data', (chunk) => {
        for (const line of chunk.toString('utf8').split('\n')) {
          if (line.trim()) received.push(JSON.parse(line));
        }
      });
    });
    bridge.on('error', () => undefined);
    await new Promise((resolve) => bridge.listen(port, '127.0.0.1', resolve));

    await waitFor(() => received.length >= 2, 10_000, `host + extension hello (got ${received.length})`);
    assert.equal(received[0].type, 'hello', '第二条链路消息必须是宿主 hello');
    assert.ok(received[0].payload?.host_instance_id, '宿主 hello 必须带 host_instance_id');
    assert.equal(received[1].type, 'hello', '补发的必须是扩展 hello');
    assert.equal(received[1].payload?.extension_instance_id, instanceId, '扩展实例 ID 必须原样到达桥端');
  } finally {
    if (child) child.kill();
    if (bridge) await new Promise((resolve) => bridge.close(resolve));
    await fs.promises.rm(stateDir, { recursive: true, force: true }).catch(() => undefined);
  }
});
