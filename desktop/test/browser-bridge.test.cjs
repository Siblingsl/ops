'use strict';
// DEV-AI27-02 W02：浏览器桥与宿主单元/集成测试（node --test）。
// 覆盖：长度前缀帧、信封校验（版本/类型/HMAC/seq 防重放）、命令账本幂等与状态单向、
// 桥↔宿主 TCP 集成（配对→派发→回执→幂等→unknown_outcome→撤销拒绝）。

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const host = require('../src/native-host/host.js');
const bridge = require('../.build/browser-bridge.js');

function mkKey() {
  return crypto.randomBytes(32);
}

function signed(key, seq, type, payload) {
  return { v: 1, type, payload, seq, hmac: host.hmacSign(key, seq, type, payload) };
}

test('frame codec roundtrip and size limit', () => {
  const decoder = host.createFrameDecoder(1024);
  const msgs = [{ a: 1 }, { b: '中文' }, { list: [1, 2, 3] }];
  const chunk = Buffer.concat(msgs.map((m) => host.encodeFrame(m)));
  assert.deepEqual(decoder.feed(chunk), msgs);
  assert.throws(() => host.encodeFrame({ big: 'x'.repeat(5 * 1024 * 1024) }), /frame too large/);
  const huge = Buffer.alloc(4);
  huge.writeUInt32LE(2048, 0);
  assert.throws(() => decoder.feed(huge), /frame length invalid/);
});

test('envelope validator: version, types, hmac, replay', () => {
  const key = mkKey();
  const validator = host.createEnvelopeValidator({ getSessionKey: () => key });
  assert.match(validator.check({ v: 2, type: 'command' }), /version mismatch/);
  assert.match(validator.check({ v: 1, type: 'evil' }), /type not allowed/);
  // 缺 seq/hmac 拒绝
  assert.match(validator.check({ v: 1, type: 'command', payload: {} }), /hmac verification failed|missing/);
  // 正确签名通过
  const ok = signed(key, 1, 'command', { x: 1 });
  ok.hmac = host.hmacSign(key, ok.seq, ok.type, ok.payload);
  assert.equal(validator.check(ok), null);
  // 重放同 seq 拒绝
  const replay = signed(key, 1, 'command', { x: 1 });
  replay.hmac = host.hmacSign(key, replay.seq, replay.type, replay.payload);
  assert.match(validator.check(replay), /replayed or out-of-order/);
  // 篡改 payload 拒绝
  const tampered = signed(key, 2, 'command', { x: 1 });
  tampered.hmac = host.hmacSign(key, tampered.seq, tampered.type, { x: 2 });
  assert.match(validator.check(tampered), /hmac verification failed/);
});

test('command ledger: idempotency, conflict, one-way states, unknown sweep', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-bridge-ledger-'));
  const ledger = new bridge.CommandLedger(path.join(dir, 'ledger.json'));
  const hashA = 'aa'.repeat(32);
  const hashB = 'bb'.repeat(32);

  const first = ledger.record('r1', 'observe', hashA, 1000);
  assert.equal(first.entry.state, 'queued');
  // 同 id 同载荷幂等
  const replay = ledger.record('r1', 'observe', hashA, 2000);
  assert.equal(replay.entry, first.entry);
  // 同 id 异载荷冲突
  assert.deepEqual(ledger.record('r1', 'observe', hashB, 3000), { conflict: true });

  assert.equal(ledger.transition('r1', 'succeeded'), null, 'queued 不能跳到 succeeded');
  assert.equal(ledger.transition('r1', 'dispatched', { dispatched_at: 1500, deadline_at: 2500 }).state, 'dispatched');
  assert.equal(ledger.transition('r1', 'dispatched'), null, '状态不能回退');
  assert.equal(ledger.transition('r1', 'succeeded', { result: { ok: true } }).state, 'succeeded');
  assert.equal(ledger.transition('r1', 'failed'), null, '终态不可再迁移');

  ledger.record('r2', 'click', hashB, 1000);
  ledger.transition('r2', 'dispatched', { dispatched_at: 1000, deadline_at: 1100 });
  const unknown = ledger.sweepUnknown(5000);
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].request_id, 'r2');
  assert.equal(ledger.sweepUnknown(6000).length, 0, 'unknown_outcome 不再重复扫描');

  // 持久化读回
  const ledger2 = new bridge.CommandLedger(path.join(dir, 'ledger.json'));
  assert.equal(ledger2.get('r1').state, 'succeeded');
  assert.equal(ledger2.get('r2').state, 'unknown_outcome');
  fs.rmSync(dir, { recursive: true, force: true });
});

async function startBridgeWithMockHost(t, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-bridge-e2e-'));
  const ledger = new bridge.CommandLedger(path.join(dir, 'ledger.json'));
  const b = new bridge.BrowserBridge(ledger, { port: 0, controlPort: null, actionTimeoutMs: 500, ...opts });
  await b.start();
  const address = b['server'].address();
  t.after(() => {
    b.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const socket = net.connect(address.port, '127.0.0.1');
  await new Promise((resolve, reject) => socket.once('connect', resolve).once('error', reject));
  const lines = [];
  let waiter = null;
  socket.setNoDelay(true);
  socket.on('data', (chunk) => {
    let s = (socket.__buf || '') + chunk.toString('utf8');
    let idx;
    while ((idx = s.indexOf('\n')) >= 0) {
      const line = s.slice(0, idx);
      s = s.slice(idx + 1);
      const msg = JSON.parse(line);
      lines.push(msg);
      if (waiter) waiter(msg);
    }
    socket.__buf = s;
  });
  const next = () => new Promise((resolve) => { waiter = resolve; });
  const send = (obj) => socket.write(`${JSON.stringify(obj)}\n`);
  return { b, socket, lines, next, send };
}

test('bridge e2e: pairing -> dispatch -> result -> idempotent -> unknown -> revoke', { timeout: 20_000 }, async (t) => {
  const { b, lines, next, send } = await startBridgeWithMockHost(t);

  // 宿主 hello -> OPS 回 pairing_start
  send({ v: 1, type: 'hello', payload: { host_instance_id: 'mock-host', protocol_version: 1 } });
  const pairingStart = await next();
  assert.equal(pairingStart.type, 'pairing_start');
  assert.match(pairingStart.payload.code, /^\d{6}$/);
  assert.equal(b.state, 'pairing');

  // 配对过期拒绝
  b.pairing.expires_at = Date.now() - 1;
  assert.deepEqual(b.confirmPairing(), { ok: false, reason: 'pairing expired' });

  // 未配对时 dispatch 拒绝
  assert.equal(b.dispatch('tabs_list', {}).accepted, false);

  // 重新 hello -> 确认配对 -> pairing_confirm（含 session_key）
  send({ v: 1, type: 'hello', payload: { host_instance_id: 'mock-host', protocol_version: 1 } });
  await next();
  const confirmed = b.confirmPairing();
  assert.equal(confirmed.ok, true);
  const pairingConfirm = await next();
  assert.equal(pairingConfirm.type, 'pairing_confirm');
  const sessionKey = Buffer.from(pairingConfirm.payload.session_key, 'base64');

  // 宿主用 session_key 签名的消息被接受；无签名/坏签名被拒。ping 为单向消息无回包，
  // 用桥的 reject 事件计数断言。
  const rejectCount = () => b.snapshot().events.filter((e) => e.message.includes('reject')).length;
  const beforeUnsigned = rejectCount();
  send({ v: 1, type: 'ping', payload: {} });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(rejectCount(), beforeUnsigned + 1, '未签名 ping 应被拒');
  const beforeSigned = rejectCount();
  send(signed(sessionKey, 1, 'ping', {}));
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(rejectCount(), beforeSigned, '签名 ping 应被接受');

  // dispatch -> 宿主收到 command（含 generation/deadline）-> 回 result
  const accepted = b.dispatch('tabs_list', {}, 'req-1');
  assert.equal(accepted.accepted, true);
  const command = await next();
  assert.equal(command.type, 'command');
  assert.equal(command.request_id, 'req-1');
  assert.equal(command.action, 'tabs_list');
  assert.equal(typeof command.deadline_at, 'number');
  const resultPayload = { ok: true, payload: { tabs: [] } };
  send({ v: 1, type: 'result', request_id: 'req-1', seq: 2, hmac: host.hmacSign(sessionKey, 2, 'result', resultPayload), payload: resultPayload });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(b.ledger.get('req-1').state, 'succeeded');

  // 同 id 同载荷幂等重放：返回原状态，不再派发
  const commandsBefore = lines.filter((m) => m.type === 'command').length;
  const replay = b.dispatch('tabs_list', {}, 'req-1');
  assert.equal(replay.state, 'succeeded');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(lines.filter((m) => m.type === 'command').length, commandsBefore, '幂等重放不重发 command');

  // 同 id 异载荷 409 语义
  const conflict = b.dispatch('observe', { tab_id: 2 }, 'req-1');
  assert.equal(conflict.accepted, false);
  assert.match(conflict.reason, /conflict/);

  // 超时无回执 -> unknown_outcome（deadline 500ms + 2s 时钟误差窗），不自动重发
  b.dispatch('click', { tab_id: 1, ref: 'n1', doc_rev: 'r1' }, 'req-2');
  await new Promise((r) => setTimeout(r, 900));
  b.sweep();
  assert.equal(b.ledger.get('req-2').state, 'dispatched', '时钟误差窗内不提前判未知');
  await new Promise((r) => setTimeout(r, 2700));
  b.sweep();
  assert.equal(b.ledger.get('req-2').state, 'unknown_outcome');
  assert.equal(lines.filter((m) => m.type === 'command' && m.request_id === 'req-2').length, 1, 'unknown_outcome 不重放');

  // revoke：generation 递增，queued 清空，host 收到 revoke
  const genBefore = b.generation.n;
  b.revoke('test');
  const revokeMsg = await next();
  assert.equal(revokeMsg.type, 'revoke');
  assert.equal(b.generation.n, genBefore + 1);
  assert.equal(b.state, 'revoked');
  assert.equal(b.dispatch('tabs_list', {}, 'req-3').accepted, false, '撤销后拒绝新命令');
});
