'use strict';
// B-01 人工接管：桥侧握手 + 扩展卡片静态契约（closed root / isTrusted / 注入范围）。
// 真实点击纵切在 test/browser-bridge.chrome.e2e.cjs 的 Handoff 用例（真实 Chrome + MV3 扩展）。

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const host = require('../src/native-host/host.js');
const bridge = require('../.build/browser-bridge.js');

function readExt(name) {
  return fs.readFileSync(path.resolve(__dirname, '..', 'chrome-extension', name), 'utf8');
}

async function startBridgeWithMockHost(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-bridge-handoff-'));
  const ledger = new bridge.CommandLedger(path.join(dir, 'ledger.json'));
  const b = new bridge.BrowserBridge(ledger, { port: 0, controlPort: null, autoPair: false, actionTimeoutMs: 500 });
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

async function paired(t) {
  const ctx = await startBridgeWithMockHost(t);
  ctx.send({ v: 1, type: 'hello', payload: { host_instance_id: 'mock-host', protocol_version: 1 } });
  assert.equal((await ctx.next()).type, 'pairing_start');
  assert.equal(ctx.b.confirmPairing().ok, true);
  const confirm = await ctx.next();
  assert.equal(confirm.type, 'pairing_confirm');
  ctx.key = Buffer.from(confirm.payload.session_key, 'base64');
  return ctx;
}

function signed(key, seq, type, payload) {
  return { v: 1, type, payload, seq, hmac: host.hmacSign(key, seq, type, payload) };
}

test('B-01: 扩展卡片安全契约（closed root / isTrusted / 注入范围 / 抗移除）', () => {
  const card = readExt('page-status.js');
  assert.match(card, /attachShadow\(\{\s*mode:\s*'closed'\s*\}\)/, '卡片必须用 closed shadow root');
  assert.match(card, /host\.popover\s*=\s*'manual'/, '卡片必须挂 popover=manual');
  assert.doesNotMatch(card, /host\.id\s*=/, '宿主不得设置可猜测的 id');
  assert.match(card, /if \(!event\.isTrusted\) return;/, '非可信点击必须直接返回');
  assert.match(card, /isTrusted/, '只认 isTrusted');
  assert.match(card, /new MutationObserver/, '必须有 MutationObserver 抗移除');
  assert.match(card, /RETOPS_PER_SECOND\s*=\s*10/, '重排限流 10 次/秒');
  assert.match(card, /z-index:\s*2147483647/, '卡片必须在顶层层级');
  assert.match(card, /pointer-events:\s*none/, '宿主不得拦截页面点击');
  assert.match(card, /all:\s*initial/, ':host 必须 all:initial');
  assert.match(card, /fullscreenchange/, 'fullscreenchange 必须重顶');
  assert.match(card, /queueMicrotask/, 'popover 被关闭后必须在 microtask 重开');
  assert.match(card, /location\.origin/, '卡片必须显示来源域');

  const bg = readExt('background.js');
  assert.match(bg, /handoff_request:\s*actionHandoffRequest/, '扩展登记表必须有 handoff_request');
  assert.match(bg, /'page_status'/, '入站白名单必须有 page_status');
  assert.match(bg, /sw\.agentTabs\.has\(tabId\)/, '注入范围只限 agentTabs');
  assert.match(bg, /chrome\.tabs\.onUpdated\.addListener/, '导航 loading/complete 必须重新注入');
  assert.match(bg, /type:\s*'handoff_complete'/, '完成事件必须上行');
  assert.match(bg, /record\.handoffId\s*!==\s*handoffId/, '完成事件必须校验 pending handoff');
  assert.match(bg, /claimedTabId\s*!==\s*tabId/, '完成事件必须校验来源 tab');
  assert.match(bg, /showHandoffNotification/, '录制冲突必须出系统通知');
  assert.match(bg, /requireInteraction:\s*true/, '通知必须常驻');
  assert.match(bg, /notification_failed/, '通知失败必须回退卡片并留痕');
  assert.match(bg, /chrome\.notifications\.onClicked/, '点击通知必须聚焦 tab');
});

test('B-01: 宿主固定信封接受 page_status / handoff_complete', () => {
  const key = crypto.randomBytes(32);
  const validator = host.createEnvelopeValidator({ getSessionKey: () => key });
  for (const type of ['page_status', 'handoff_complete']) {
    const msg = signed(key, type === 'page_status' ? 1 : 2, type, { ok: true });
    assert.equal(validator.check(msg), null, `${type} 必须是宿主可信类型`);
  }
});

test('B-01: 桥白名单登记 handoff_request，不登记任意 JS', () => {
  assert.equal(bridge.ALLOWED_ACTIONS.has('handoff_request'), true);
  assert.equal(bridge.ALLOWED_ACTIONS.has('execute_arbitrary_js'), false);
});

test('B-01: requestHandoff -> command -> handoff_complete 完成', { timeout: 20_000 }, async (t) => {
  const ctx = await paired(t);
  const events = [];
  ctx.b.onHandoff((r) => events.push(r));
  const wait = ctx.b.requestHandoff({ tab_id: 7, message: '请在页面完成验证码' });
  const command = await ctx.next();
  assert.equal(command.type, 'command');
  assert.equal(command.action, 'handoff_request');
  assert.equal(command.payload.tab_id, 7);
  assert.match(command.payload.handoff_id, /^[0-9a-f-]{36}$/);

  const resultPayload = { ok: true, payload: { waiting: true, handoff_id: command.payload.handoff_id, tab_id: 7 } };
  ctx.send({
    v: 1, type: 'result', request_id: command.request_id,
    nonce: command.nonce, payload_hash: command.payload_hash,
    seq: 1, hmac: host.hmacSign(ctx.key, 1, 'result', resultPayload, command.nonce, command.payload_hash),
    payload: resultPayload,
  });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(ctx.b.ledger.get(command.request_id).state, 'succeeded', 'handoff_request 命令本身应立即受理');

  const complete = {
    handoff_id: command.payload.handoff_id,
    tab_id: 7,
    origin: 'https://creator.xiaohongshu.com',
    completed_at: Date.now(),
  };
  ctx.send({ v: 1, type: 'handoff_complete', payload: complete, seq: 2, hmac: host.hmacSign(ctx.key, 2, 'handoff_complete', complete) });
  const outcome = await wait;
  assert.equal(outcome.completed, true, '收到 handoff_complete 后完成');
  assert.equal(outcome.handoff_id, complete.handoff_id);
  assert.equal(outcome.origin, 'https://creator.xiaohongshu.com');
  assert.equal(events.length, 1, 'onHandoff 订阅收到事件');
  assert.ok(ctx.b.snapshot().events.some((e) => e.kind === 'handoff' && e.message.startsWith('completed')), '桥事件留痕');
});

test('B-01: 未知 handoffId / tab 不匹配的完成被丢弃', { timeout: 20_000 }, async (t) => {
  const ctx = await paired(t);
  const wait = ctx.b.requestHandoff({ tab_id: 9, timeoutMs: 1200 });
  const command = await ctx.next();
  const complete = { handoff_id: command.payload.handoff_id, tab_id: 99, origin: 'x', completed_at: Date.now() };
  ctx.send({ v: 1, type: 'handoff_complete', payload: complete, seq: 1, hmac: host.hmacSign(ctx.key, 1, 'handoff_complete', complete) });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(ctx.b['pendingHandoffs'].size, 1, 'tab 不匹配不得结束等待');
  const unknown = { handoff_id: crypto.randomUUID(), tab_id: 9, origin: 'x', completed_at: Date.now() };
  ctx.send({ v: 1, type: 'handoff_complete', payload: unknown, seq: 2, hmac: host.hmacSign(ctx.key, 2, 'handoff_complete', unknown) });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(ctx.b['pendingHandoffs'].size, 1, '未知 handoffId 不得结束等待');
  const outcome = await wait;
  assert.equal(outcome.completed, false);
  assert.equal(outcome.timedOut, true, '超时如实返回 timedOut');
});

test('B-01: 未配对 / 非法 tab 的 requestHandoff 直接失败，不伪造完成', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-bridge-handoff-unpaired-'));
  const b = new bridge.BrowserBridge(new bridge.CommandLedger(path.join(dir, 'ledger.json')), { port: 0, controlPort: null });
  const unpaired = await b.requestHandoff({ tab_id: 1 });
  assert.equal(unpaired.completed, false);
  assert.equal(unpaired.error, 'browser_not_paired');
  const bad = await b.requestHandoff({ tab_id: 0 });
  assert.equal(bad.completed, false);
  assert.equal(bad.error, 'tab_id_required');
  assert.equal(b.setPageStatus(1, { state: 'running' }), false, '未配对不得假装下发');
  fs.rmSync(dir, { recursive: true, force: true });
});
