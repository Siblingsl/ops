'use strict';
// CF-DESK-05｜C09 截图脱敏校验（A-03）定向测试。
// 依据：docs/27 §11.5.2 / §11.5.4 T-AI27-C09 / §11.5.5 / §13.4；docs/31:34；docs/08:4079 DEV-A12。
// 全部用注入式采集源 + 确定性时钟 + 最小 PNG 头，无真 GUI / 真模型 / 默认部署依赖。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { fork } = require('node:child_process');

const WORKER = path.resolve(__dirname, '..', 'src', 'computer-worker', 'index.js');
const {
  REDACTION_SCHEMA, EVIDENCE_KEYS, pngDimensions, validateRedactionFrame,
} = require('../src/computer-worker/redaction.js');
const {
  CAPTURE_SCHEMA, checkCaptureFrame, buildCaptureScript, createCaptureService,
} = require('../src/computer-worker/capture.js');

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'desk05-redaction-cases.json'), 'utf8'));
const BOUNDS = FIXTURE.bounds;

function pngStub(width, height) {
  const buf = Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function frame(overrides = {}) {
  return {
    ok: true,
    bounds: { ...BOUNDS },
    target_bounds: { ...BOUNDS },
    width: BOUNDS.w,
    height: BOUNDS.h,
    full_screen: false,
    occluded: false,
    foreground_ok: true,
    foreign_windows: [],
    screen_bounds: { ...FIXTURE.screen_bounds },
    bytes: pngStub(BOUNDS.w, BOUNDS.h),
    ...overrides,
  };
}

function frameFor(c) {
  const f = frame();
  const o = c.override || {};
  for (const k of (o.unset || [])) delete f[k];
  for (const [k, v] of Object.entries(o)) {
    if (['unset', 'png_width', 'png_height', 'bytes_kind'].includes(k)) continue;
    f[k] = v;
  }
  if (o.bytes_kind === 'text') f.bytes = Buffer.from('明文敏感：客户清单与窗口标题', 'utf8');
  else f.bytes = pngStub(o.png_width ?? BOUNDS.w, o.png_height ?? BOUNDS.h);
  return f;
}

/** 独立复核层不依赖 CF-DESK-04 的准入结果：手工给出已准入的 checked，单独验证判定。 */
function checkedFor(f) {
  return { ok: true, bounds: { ...BOUNDS }, bytes: f.bytes, width: BOUNDS.w, height: BOUNDS.h };
}

function req(overrides = {}) {
  return { pid: 4321, target_summary: '文档 - 记事本', grant_id: 'grant-A', run_id: 'run-1', ...overrides };
}

function service(overrides = {}, options = {}) {
  let clock = 1_700_000_000_000;
  let seq = 0;
  const svc = createCaptureService({
    backend: async () => frame(overrides),
    now: () => clock,
    makeId: () => `cap-${++seq}`,
    ...options,
  });
  return { svc, advance: (ms) => { clock += ms; return clock; } };
}

/** 反例专用：直接把夹具构造出的 frame 交给 backend，避免 override 里的辅助键混进采集帧。 */
function serviceFor(f) {
  let clock = 1_700_000_000_000;
  let seq = 0;
  const svc = createCaptureService({
    backend: async () => f,
    now: () => clock,
    makeId: () => `cap-${++seq}`,
  });
  return { svc, advance: (ms) => { clock += ms; return clock; } };
}

// ---------------------------------------------------------------------------
// 正反例夹具（34 §5 验收「正反例夹具」）：1 正 + 10 负
// ---------------------------------------------------------------------------

test('CF-DESK-05 夹具自身：schema / 1 正 / 10 负 / 每条都有 expect 与说明', () => {
  assert.equal(FIXTURE.schema, 'desk05-redaction-cases-v1');
  assert.equal(FIXTURE.positive.length, 1);
  assert.equal(FIXTURE.negative.length, 10);
  for (const c of [...FIXTURE.positive, ...FIXTURE.negative]) {
    assert.equal(typeof c.id, 'string');
    assert.equal(typeof c.expect, 'object');
    assert.equal(typeof c.note, 'string', `夹具 ${c.id} 须写明判定依据`);
  }
});

test('CF-DESK-05 独立脱敏复核：正例通过、10 条反例逐条命中原因码', () => {
  for (const c of FIXTURE.positive) {
    const f = frameFor(c);
    const out = validateRedactionFrame(f, checkedFor(f));
    assert.equal(out.ok, true, `${c.id}: ${JSON.stringify(out)}`);
    assert.ok(out.checks.includes('png_ihdr'));
    assert.ok(out.checks.includes('bounds_match'));
    assert.equal(out.coverage, 'metadata+png_ihdr+screen');
  }
  for (const c of FIXTURE.negative) {
    const f = frameFor(c);
    const out = validateRedactionFrame(f, checkedFor(f));
    assert.equal(out.ok, false, `${c.id} 必须拒绝`);
    assert.equal(out.error, c.expect.error, `${c.id} 原因码`);
    assert.deepEqual(out.checks, [], '失败不得回传「已通过」的核验项');
  }
});

test('CF-DESK-05 失败不落明文敏感：不入库、不回原图、主动丢弃明文引用', async () => {
  for (const c of FIXTURE.negative) {
    // 必须用 serviceFor(frameFor(c))：frameFor 会把 png_width / bytes_kind / unset 等
    // 夹具辅助键真正作用到图像字节与字段上；service(c.override) 只会把它们当普通字段
    // 展开，bytes 仍是合法小图，属于测试夹具误用（首轮 10/11 的唯一失败根因）。
    const { svc } = serviceFor(frameFor(c));
    const out = await svc.capture(req());
    assert.equal(out.ok, false, `${c.id} 必须被链路拒绝`);
    assert.ok(['redaction_rejected', 'foreign_window'].includes(out.error),
      `${c.id} 须给出拒绝原因码：脱敏复核拒绝，或 T6 采集准入先拒（实得 ${out.error}）`);
    assert.equal(svc.stats().captures, 0, `${c.id} 被拒的图不得落进内存`);
    assert.equal(svc.read('cap-1', 'grant-A').error, 'not_found');
    assert.equal(Object.prototype.hasOwnProperty.call(out, 'bytes'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(out, 'bytes_b64'), false);
    assert.equal(JSON.stringify(out).includes('明文敏感'), false, `${c.id} 不得回显敏感明文`);
  }
  // 直接验证「主动丢弃」：backend 返回的同一个 frame 对象在复核失败后 bytes 被清空。
  const f = frameFor(FIXTURE.negative[0]);
  const svc = createCaptureService({ backend: async () => f, now: () => 1_700_000_000_000, makeId: () => 'cap-1' });
  const out = await svc.capture(req());
  assert.equal(out.reason, 'image_mismatch');
  assert.equal(f.bytes, null, '复核失败后必须清空原图引用，不留在 backend 对象里');
  assert.equal(checkedFor(frame()).ok, true);
});

// ---------------------------------------------------------------------------
// 脱敏证据出口（C09「上传/证据路径」）
// ---------------------------------------------------------------------------

test('CF-DESK-05 脱敏证据：字段白名单固定，不含原文 / 标题 / 进程路径 / 其它窗口清单', async () => {
  const { svc } = service();
  const cap = await svc.capture(req());
  assert.equal(cap.ok, true, JSON.stringify(cap));
  const ev = svc.evidence(cap.capture_id, 'grant-A');
  assert.equal(ev.ok, true);
  assert.equal(ev.schema, REDACTION_SCHEMA);
  assert.deepEqual(Object.keys(ev).sort(), EVIDENCE_KEYS);
  for (const forbidden of ['bytes', 'bytes_b64', 'image', 'data', 'title', 'process', 'path', 'windows', 'other_windows', 'foreign_windows']) {
    assert.equal(Object.prototype.hasOwnProperty.call(ev, forbidden), false, `证据不得含 ${forbidden}`);
  }
  assert.equal(JSON.stringify(ev).includes('记事本'), false, '证据不得夹带窗口标题');
  assert.match(ev.image_digest, /^[0-9a-f]{32}$/);
  assert.equal(ev.image_digest.length, 32);
  assert.equal(ev.window_digest, cap.window_digest);
  assert.equal(ev.byte_size, cap.byte_size);
  assert.ok(ev.checks.includes('png_ihdr'), '证据须声明已做 IHDR 交叉核验');
  assert.equal(ev.coverage, 'metadata+png_ihdr+screen');
});

test('CF-DESK-05 image_digest 是不可逆摘要，不等于原图也不等于 window_digest', async () => {
  const { svc } = service();
  const cap = await svc.capture(req());
  const ev = svc.evidence(cap.capture_id, 'grant-A');
  assert.notEqual(ev.image_digest, ev.window_digest);
  assert.equal(Buffer.from(ev.image_digest, 'hex').length, 16);
  assert.equal(JSON.stringify(ev).includes(pngStub(BOUNDS.w, BOUNDS.h).toString('hex')), false,
    '证据不得把原图字节以任何编码夹带');
  assert.equal(svc.read(cap.capture_id, 'grant-A').bytes.length, 33, '原图仍只在 worker 进程内可达');
});

test('CF-DESK-05 证据读取权限：换 grant / 不存在 / 过期 / 失权一律拒绝且不含敏感字段', async () => {
  const { svc, advance } = service();
  const cap = await svc.capture(req());
  assert.equal(svc.evidence(cap.capture_id, 'grant-B').error, 'grant_invalid');
  assert.equal(svc.evidence('cap-missing', 'grant-A').error, 'not_found');
  assert.equal(svc.evidence('', 'grant-A').error, 'not_found');
  assert.equal(svc.invalidate('grant-A'), 1);
  assert.equal(svc.evidence(cap.capture_id, 'grant-A').error, 'not_found', '失权必须拒绝历史越权读取');

  const two = service();
  const cap2 = await two.svc.capture(req());
  two.advance(10 * 60 * 1000 + 1);
  const expired = two.svc.evidence(cap2.capture_id, 'grant-A');
  assert.equal(expired.error, 'expired');
  assert.equal(Object.keys(expired).length, 2, '失败响应只含 ok / error');
});

// ---------------------------------------------------------------------------
// 不回退 CF-DESK-04 的既有脱敏约束
// ---------------------------------------------------------------------------

test('CF-DESK-05 未回退 T6：摘要仍是 11 键白名单、采集准入仍生效', async () => {
  const { svc } = service();
  const out = await svc.capture(req());
  assert.equal(out.schema, CAPTURE_SCHEMA);
  assert.deepEqual(Object.keys(out).sort(), [
    'bounds', 'byte_size', 'capture_id', 'captured_at', 'height', 'ok',
    'revision', 'run_id', 'schema', 'width', 'window_digest',
  ].sort());
  assert.equal(checkCaptureFrame(frame()).ok, true);
  assert.equal(checkCaptureFrame(frame({ full_screen: true })).error, 'full_screen');
  assert.equal(svc.evidence(out.capture_id, 'grant-A').ok, true);
});

test('CF-DESK-05 pngDimensions 边界：只认合法 IHDR，不猜、不默认放行', () => {
  assert.deepEqual(pngDimensions(pngStub(900, 640)), { width: 900, height: 640 });
  assert.equal(pngDimensions(Buffer.from('89504e470d0a1a0a', 'hex')), null, '仅魔数不足以核验尺寸');
  assert.equal(pngDimensions(Buffer.from('not a png at all, 客户清单', 'utf8')), null);
  assert.equal(pngDimensions(pngStub(0, 640)), null);
  assert.equal(pngDimensions(pngStub(1921, 640)), null);
  const badChunk = pngStub(900, 640);
  badChunk.write('JDHR', 12, 'ascii');
  assert.equal(pngDimensions(badChunk), null);
});

test('CF-DESK-05 默认 backend 脚本：提供虚拟屏几何证据，不伪造逐窗枚举、不采标题 / 路径', () => {
  const script = buildCaptureScript(4321);
  assert.match(script, /PrintWindow/, '仍是窗口级抓图');
  assert.match(script, /screen_bounds=\$screenBounds/, '须回传虚拟屏矩形供独立几何复核');
  assert.match(script, /foreign_windows=@\(\)/, 'T6 的夹带声明仍在');
  assert.ok(!/other_windows=/.test(script), '默认 backend 不得输出空数组冒充已做其它窗口逐窗枚举');
  assert.ok(!/MainWindowTitle|ProcessName|Get-Process.*\|\s*Select/.test(script), '不得采集窗口标题 / 进程路径清单');
  assert.ok(!/CopyFromScreen|GetDesktopWindow|BitBlt/.test(script), '不得退化为全屏 / 屏幕矩形抓屏');
  assert.ok(!/Invoke-Expression|iex\b/.test(script), '不得变成任意脚本执行');
});

// ---------------------------------------------------------------------------
// worker 协议 / 出口边界（真 fork，不触发真 GUI）
// ---------------------------------------------------------------------------

function withWorker(t) {
  const child = fork(WORKER, [], { stdio: 'ignore', env: { OPS_DESKTOP_WORKER: '1' } });
  let nextID = 1;
  const pending = new Map();
  child.on('message', (msg) => {
    if (!msg || typeof msg.id !== 'string') return;
    const call = pending.get(msg.id);
    if (!call) return;
    pending.delete(msg.id);
    clearTimeout(call.timer);
    call.resolve(msg);
  });
  t.after(() => child.kill());
  return {
    call(cmd, extra = {}) {
      const id = `r${nextID++}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('worker_timeout')); }, 20_000);
        pending.set(id, { resolve, timer });
        child.send({ id, cmd, ...extra });
      });
    },
  };
}

test('CF-DESK-05 worker 协议 capture_evidence：缺参 / 开放式参数 / 无授权一律拒绝', { timeout: 40_000 }, async (t) => {
  const w = withWorker(t);
  assert.equal((await w.call('capture_evidence', { grant_id: 'grant-A' })).error, 'params_invalid');
  assert.equal((await w.call('capture_evidence', { capture_id: 'cap-x' })).error, 'params_invalid');
  assert.equal((await w.call('capture_evidence', { capture_id: 'cap-x', grant_id: 'grant-A', hwnd: 1 })).error,
    'params_invalid', '不得接受任意窗口句柄 / 开放式参数');
  const missing = await w.call('capture_evidence', { capture_id: 'cap-x', grant_id: 'grant-A' });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'not_found');
  assert.equal(Object.prototype.hasOwnProperty.call(missing, 'bytes'), false);
  assert.equal((await w.call('capture_stats')).captures, 0);
});

test('CF-DESK-05 出口边界：无原文命令、未新增 main IPC / preload / 服务端截图通道', () => {
  const indexSrc = fs.readFileSync(WORKER, 'utf8');
  assert.ok(!/case 'capture_read'|case 'capture_bytes'/.test(indexSrc),
    'worker 不得把截图原文做成消息出口（C09）');
  assert.match(indexSrc, /case 'capture_evidence'/, '本项只新增脱敏证据固定命令');
  const hostSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'computer-worker-host.ts'), 'utf8');
  assert.match(hostSrc, /async captureEvidence\(/, 'host 只暴露固定意图方法');
  const ipcSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'ipc', 'computer.ts'), 'utf8');
  assert.ok(!/capture_evidence|capture_window|computer:capture/.test(ipcSrc),
    '本项不新增 main IPC 通道（DT-04 / T7 待立项）');
  const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'business-ui-preload.ts'), 'utf8');
  assert.ok(!/captureEvidence|captureWindow|computer:capture/.test(preloadSrc),
    '本项不新增 preload 白名单（渲染器仍拿不到截图或证据原文）');
});
