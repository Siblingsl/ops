'use strict';
// B-07 来源白名单与只读模式：桥侧前置 + 扩展第二道 + 访问模式下发。
// 运行：cd desktop && node --test test/allowlist.test.cjs

const assert = require('node:assert/strict');
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

async function startBridgeWithMockHost(t, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-bridge-allow-'));
  const b = new bridge.BrowserBridge(new bridge.CommandLedger(path.join(dir, 'ledger.json')), {
    port: 0, controlPort: null, autoPair: false, actionTimeoutMs: 500, ...opts,
  });
  await b.start();
  const address = b['server'].address();
  t.after(() => {
    b.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const socket = net.connect(address.port, '127.0.0.1');
  await new Promise((resolve, reject) => socket.once('connect', resolve).once('error', reject));
  const queue = [];
  let waiter = null;
  socket.setNoDelay(true);
  socket.on('data', (chunk) => {
    let s = (socket.__buf || '') + chunk.toString('utf8');
    let idx;
    while ((idx = s.indexOf('\n')) >= 0) {
      const line = s.slice(0, idx);
      s = s.slice(idx + 1);
      const msg = JSON.parse(line);
      if (waiter) { const w = waiter; waiter = null; w(msg); } else queue.push(msg);
    }
    socket.__buf = s;
  });
  const next = () => queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve) => { waiter = resolve; });
  const send = (obj) => socket.write(`${JSON.stringify(obj)}\n`);
  return { b, socket, queue, next, send };
}

async function paired(t, opts = {}) {
  const ctx = await startBridgeWithMockHost(t, opts);
  ctx.send({ v: 1, type: 'hello', payload: { host_instance_id: 'mock-host', protocol_version: 1 } });
  assert.equal((await ctx.next()).type, 'pairing_start');
  assert.equal(ctx.b.confirmPairing().ok, true);
  const confirm = await ctx.next();
  assert.equal(confirm.type, 'pairing_confirm');
  ctx.key = Buffer.from(confirm.payload.session_key, 'base64');
  return ctx;
}

test('B-07.1: 只读 + 来源白名单在桥侧前置拒绝，且不派发', { timeout: 20_000 }, async (t) => {
  const ctx = await paired(t, { readOnly: true, allowedOrigins: ['https://mp.weixin.qq.com'] });
  // 配对后下发的访问模式（因为配置非默认）
  const mode = await ctx.next();
  assert.equal(mode.type, 'page_status');
  assert.deepEqual(mode.payload, { op: 'mode', read_only: true, allowed_origins: ['https://mp.weixin.qq.com'], human_input: false, debugger_input: false });

  const click = ctx.b.dispatch('click', { tab_id: 1, ref: 'n1', doc_rev: 'r1' }, 'ro-click');
  assert.equal(click.accepted, false);
  assert.equal(click.error_code, 'browser_read_only');
  assert.ok(!ctx.queue.some((m) => m.type === 'command' && m.request_id === 'ro-click'), '只读不派发 click');

  const observe = ctx.b.dispatch('observe', { tab_id: 1 }, 'ro-observe');
  assert.equal(observe.accepted, true, '只读允许 observe');
  const obsCmd = await ctx.next();
  assert.equal(obsCmd.action, 'observe');

  // 退出只读但仍保留来源白名单：导航才可派发，越权仍拒绝。
  ctx.b.setAccessMode({ readOnly: false });
  const mode2 = await ctx.next();
  assert.equal(mode2.payload.read_only, false);
  assert.deepEqual(mode2.payload.allowed_origins, ['https://mp.weixin.qq.com']);

  const navAllowed = ctx.b.dispatch('navigate', { tab_id: 1, url: 'https://mp.weixin.qq.com/cgi-bin/home' }, 'nav-ok');
  assert.equal(navAllowed.accepted, true, '白名单内导航受理');
  const navCmd = await ctx.next();
  assert.equal(navCmd.type, 'command');
  assert.equal(navCmd.action, 'navigate');

  const navBad = ctx.b.dispatch('navigate', { tab_id: 1, url: 'https://example.com/' }, 'nav-bad');
  assert.equal(navBad.accepted, false);
  assert.equal(navBad.error_code, 'browser_origin_not_allowed');
  assert.ok(!ctx.queue.some((m) => m.type === 'command' && m.request_id === 'nav-bad'), '越权导航不打开 tab');
});

test('B-07.2: 访问模式可动态切换并回到旧行为', { timeout: 20_000 }, async (t) => {
  const ctx = await paired(t, { readOnly: true });
  await ctx.next(); // mode
  const changed = ctx.b.setAccessMode({ readOnly: false, allowedOrigins: [] });
  assert.equal(changed.readOnly, false);
  assert.deepEqual(changed.allowedOrigins, []);
  const mode = await ctx.next();
  assert.equal(mode.payload.op, 'mode');
  assert.equal(mode.payload.read_only, false);
  assert.deepEqual(mode.payload.allowed_origins, []);
  const click = ctx.b.dispatch('click', { tab_id: 1, ref: 'n1', doc_rev: 'r1' }, 'write-ok');
  assert.equal(click.accepted, true, '退出只读后可写');
  await ctx.next();
});

test('B-07.3: 扩展第二道只读/来源校验与 mode 处理已登记', () => {
  const bg = readExt('background.js');
  assert.match(bg, /const READ_ONLY_ACTIONS = new Set\(\['tabs_list', 'observe', 'observe_frames', 'extract', 'screenshot', 'activate_tab', 'scroll'\]\)/);
  assert.match(bg, /sw\.readOnly && !READ_ONLY_ACTIONS\.has\(msg\.action\)/, 'handleCommand 必须有第二道只读校验');
  assert.match(bg, /payload\.op === 'mode'/, 'page_status 必须处理 mode');
  assert.match(bg, /access_mode: \{ read_only: sw\.readOnly, allowed_origins/, '访问模式必须持久化');
  assert.match(bg, /parsed\.origin\.toLowerCase\(\).*sw\.allowedOrigins|sw\.allowedOrigins\.has\(parsed\.origin\.toLowerCase\(\)\)/, 'navigate 必须校验 origin');
  assert.match(bg, /origin_not_allowed/, '越权导航必须回稳定错误');
});

test('B-07.4: 桥无 cookie/storage 读写动作（比只读清单更严）', () => {
  const bg = readExt('background.js');
  assert.doesNotMatch(bg, /cookies|getCookies|setCookie|clearBrowserCookies/i, '不新增 cookie 动作');
  assert.ok(!bridge.ALLOWED_ACTIONS.has('get_cookies'));
  assert.ok(!bridge.ALLOWED_ACTIONS.has('set_cookie'));
  // 只读动作集不包含三个写动作
  for (const action of ['navigate', 'click', 'type', 'handoff_request']) {
    assert.equal(bridge.READ_ONLY_ACTIONS.has(action), false, `${action} 不得在只读动作集`);
  }
});

test('B-07.5: 来源白名单只做“防乱跑”，不宣称数据边界', () => {
  const doc = fs.readFileSync(path.resolve(__dirname, '..', '..', 'docs', '41-browse可借鉴实现清单.md'), 'utf8');
  assert.match(doc, /实施记录（B-07，2026-11-17）/);
  assert.match(doc, /不是.*数据.*边界|防乱跑.*不是.*防泄漏|不过滤页面自身发出的/);
});
