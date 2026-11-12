'use strict';
// CF-DESK-04｜窗口级截图能力（A-03 前置）定向测试。
// 全部用注入式采集源 / 确定性时钟，无真实 GUI 依赖；真窗口旅程未跑，交% 不抬。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { fork } = require('node:child_process');

const WORKER = path.resolve(__dirname, '..', 'src', 'computer-worker', 'index.js');
const {
  CAPTURE_SCHEMA, MAX_EDGE_PX, MAX_BYTES, MAX_PER_RUN, CAPTURE_TTL_MS, OPEN_ENDED_KEYS,
  validateCaptureRequest, checkCaptureFrame, buildCaptureScript, createCaptureService,
} = require('../src/computer-worker/capture.js');

const BOUNDS = { x: 100, y: 80, w: 900, h: 640 };
// CF-DESK-05 配套：夹具从「仅 8 字节 PNG 魔数」升级为含 IHDR 宽高的 33 字节最小 PNG 头，
// 使 C09 脱敏复核能独立解析图像尺寸；本文件所有断言一字未改、未放宽。
function pngStub(width, height) {
  const buf = Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}
const PNG_STUB = pngStub(BOUNDS.w, BOUNDS.h);

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
    bytes: PNG_STUB,
    ...overrides,
  };
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

// ---------------------------------------------------------------------------
// 决策层：正常摘要 + 原图只在 worker 内可达
// ---------------------------------------------------------------------------

test('CF-DESK-04 窗口截图：只回选中目标必要摘要，原图须凭同一 grant 在进程内读取', async () => {
  const { svc } = service();
  const out = await svc.capture(req());
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.schema, CAPTURE_SCHEMA);
  assert.equal(out.capture_id, 'cap-1');
  assert.equal(out.byte_size, PNG_STUB.length);
  assert.deepEqual(out.bounds, BOUNDS);
  assert.equal(out.revision, 1);
  assert.equal(typeof out.window_digest, 'string');
  assert.equal(out.window_digest.length, 32);

  // C09：不得回原图、进程路径、窗口标题、其它窗口清单或未选目标全集。
  for (const forbidden of ['bytes', 'bytes_b64', 'image', 'data', 'title', 'process', 'path', 'windows', 'foreign_windows']) {
    assert.equal(Object.prototype.hasOwnProperty.call(out, forbidden), false, `摘要不得含 ${forbidden}`);
  }
  assert.equal(JSON.stringify(out).includes('记事本'), false, '摘要不得夹带窗口标题');

  const local = svc.read(out.capture_id, 'grant-A');
  assert.equal(local.ok, true);
  assert.deepEqual(local.bytes, PNG_STUB);
  assert.equal(svc.read(out.capture_id, 'grant-B').error, 'grant_invalid', '换 grant 不得越权读取');
  assert.equal(svc.read('cap-missing', 'grant-A').error, 'not_found');
  assert.deepEqual(svc.stats(), { captures: 1, runs: 1, revision: 1 });
});

test('CF-DESK-04 摘要字段集合固定（新增字段必须显式评审，防脱敏回退）', async () => {
  const { svc } = service();
  const out = await svc.capture(req());
  assert.deepEqual(Object.keys(out).sort(), [
    'bounds', 'byte_size', 'capture_id', 'captured_at', 'height', 'ok',
    'revision', 'run_id', 'schema', 'width', 'window_digest',
  ].sort());
});

// ---------------------------------------------------------------------------
// 请求校验：硬禁区 / pid / grant / run / 开放式接口禁区
// ---------------------------------------------------------------------------

test('CF-DESK-04 请求校验：硬禁区、pid、grant、run 与开放式参数一律拒绝', () => {
  const cases = [
    [req({ target_summary: '凭据管理器' }), 'hard_forbidden'],
    [req({ target_summary: '命令提示符' }), 'hard_forbidden'],
    [req({ target_summary: 'regedit' }), 'hard_forbidden'],
    [req({ pid: 0 }), 'pid_invalid'],
    [req({ pid: -1 }), 'pid_invalid'],
    [req({ pid: 1.5 }), 'pid_invalid'],
    [req({ grant_id: '' }), 'grant_invalid'],
    [req({ run_id: '' }), 'run_invalid'],
    [null, 'params_invalid'],
  ];
  for (const [input, want] of cases) {
    assert.equal(validateCaptureRequest(input).error, want, JSON.stringify(input));
  }
  for (const key of OPEN_ENDED_KEYS) {
    assert.equal(validateCaptureRequest(req({ [key]: 'x' })).error, 'params_invalid',
      `不得接受开放式参数 ${key}（27 §11.5.5）`);
  }
  assert.equal(validateCaptureRequest(req()).ok, true);
});

// ---------------------------------------------------------------------------
// 截图帧判定：全屏 / 遮挡 / 夹带 / 失焦 / 矩形变化 / 尺寸 / 空图
// ---------------------------------------------------------------------------

test('CF-DESK-04 帧判定：任何越界情形都拒绝该图且不落明文', async () => {
  const cases = [
    [{ full_screen: true }, 'full_screen'],
    [{ occluded: true }, 'occluded'],
    [{ foreground_ok: false }, 'target_not_foreground'],
    [{ foreign_windows: [{ pid: 999 }] }, 'foreign_window'],
    [{ bounds: { ...BOUNDS, x: 101 } }, 'target_changed'],
    [{ target_bounds: { ...BOUNDS, h: 641 } }, 'target_changed'],
    // 最长边超限必须两侧矩形同步超限；只改一侧会先命中 target_changed（判定顺序正确）。
    [{ bounds: { ...BOUNDS, w: MAX_EDGE_PX + 1 }, target_bounds: { ...BOUNDS, w: MAX_EDGE_PX + 1 } }, 'oversize'],
    [{ bounds: { ...BOUNDS, w: MAX_EDGE_PX + 1 } }, 'target_changed'],
    [{ bytes: Buffer.alloc(0) }, 'empty_image'],
    [{ bytes: Buffer.alloc(MAX_BYTES + 1) }, 'oversize'],
    [{ bounds: null }, 'parse_failed'],
    [{ ok: false, error: 'permission_denied' }, 'permission_denied'],
  ];
  for (const [overrides, want] of cases) {
    assert.equal(checkCaptureFrame(frame(overrides)).error, want, JSON.stringify(Object.keys(overrides)));
  }
  const { svc } = service({ full_screen: true });
  const out = await svc.capture(req());
  assert.equal(out.error, 'full_screen');
  assert.equal(svc.stats().captures, 0, '被拒的图不得落进内存');
  assert.equal(checkCaptureFrame(frame()).ok, true);
});

// ---------------------------------------------------------------------------
// 配额 / 过期 / 失权
// ---------------------------------------------------------------------------

test('CF-DESK-04 每 run ≤10 张，超出拒绝且不新增批量入口', async () => {
  const { svc } = service();
  for (let i = 0; i < MAX_PER_RUN; i += 1) {
    const out = await svc.capture(req());
    assert.equal(out.ok, true, `第 ${i + 1} 张应成功`);
  }
  const denied = await svc.capture(req());
  assert.equal(denied.error, 'budget_exceeded');
  assert.equal(svc.stats().captures, MAX_PER_RUN);
  const other = await svc.capture(req({ run_id: 'run-2' }));
  assert.equal(other.ok, true, '配额按 run 计，不因另一 run 被拒');
});

test('CF-DESK-04 过期与失权：拒绝历史越权读取（C09）', async () => {
  const { svc, advance } = service();
  const one = await svc.capture(req());
  const two = await svc.capture(req({ grant_id: 'grant-B' }));
  assert.equal(svc.invalidate('grant-A'), 1, '失权应清空该 grant 下截图');
  assert.equal(svc.read(one.capture_id, 'grant-A').error, 'not_found');
  assert.equal(svc.read(two.capture_id, 'grant-B').ok, true, '别的 grant 不受影响');
  assert.equal(svc.invalidate(''), 0, '空 grant 不得清空全部（防误操作）');

  advance(CAPTURE_TTL_MS + 1);
  assert.equal(svc.read(two.capture_id, 'grant-B').error, 'expired');
  assert.equal(svc.stats().captures, 0, '惰性清理应回收过期条目');
});

// ---------------------------------------------------------------------------
// 默认本机 backend 的脚本边界（真 GUI 未实测，只核验生成文本）
// ---------------------------------------------------------------------------

test('CF-DESK-04 默认采集脚本：窗口级 PrintWindow，不做全屏抓屏 / 不接受开放式输入', () => {
  const script = buildCaptureScript(4321);
  assert.match(script, /GetWindowRect/, '必须按目标窗口矩形取图');
  assert.match(script, /PrintWindow/, '只抓目标窗口自身');
  assert.match(script, /GetForegroundWindow/, '必须核验前台归属');
  assert.match(script, /GetWindowThreadProcessId/, '前台窗口必须按 PID 归属判定');
  assert.match(script, /Get-Process -Id 4321/, 'PID 由 worker 内部传入，不接受外部句柄');
  assert.match(script, /foreign_windows=@\(\)/, 'PrintWindow 结果天然不夹带其它窗口');
  assert.ok(!/CopyFromScreen|GetDesktopWindow|BitBlt/.test(script), '不得退化为全屏 / 屏幕矩形抓屏');
  assert.ok(!/Invoke-Expression|iex\b/.test(script), '不得变成任意脚本执行');
  assert.throws(() => buildCaptureScript(0), /pid_invalid/);
  assert.equal(buildCaptureScript(4321), buildCaptureScript(4321), '同一 PID 脚本应确定性一致');
});

// ---------------------------------------------------------------------------
// worker 协议层（真 fork，不触发真 GUI：只用校验分支）
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
      const id = `c${nextID++}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('worker_timeout')); }, 20_000);
        pending.set(id, { resolve, timer });
        child.send({ id, cmd, ...extra });
      });
    },
  };
}

test('CF-DESK-04 worker 协议：硬禁区 / 非法参数 / 缺授权在 backend 前即拒绝', { timeout: 40_000 }, async (t) => {
  const w = withWorker(t);
  const base = req();
  // P3-4 起失败回执统一带 detail.disposition（§P3-4 步骤 4/5）与 message；error 仍为字符串旧码。
  assert.deepEqual(await w.call('capture_window', { ...base, target_summary: '凭据管理器' }), {
    id: 'c1', ok: false, error: 'hard_forbidden', message: '',
    detail: { disposition: { delivery: 'not_delivered', retry: 'safe' } },
  });
  assert.equal((await w.call('capture_window', { ...base, hwnd: 12345 })).error, 'params_invalid',
    'worker 不得接受任意窗口句柄');
  assert.equal((await w.call('capture_window', { ...base, grant_id: '' })).error, 'grant_invalid');
  assert.equal((await w.call('capture_window', { ...base, pid: 0 })).error, 'pid_invalid');
  assert.equal((await w.call('capture_invalidate', { grant_id: '' })).error, 'params_invalid');
});

test('CF-DESK-04 worker 协议：撤销与计数可用、原图无 worker 出口、未知命令不变', { timeout: 40_000 }, async (t) => {
  const w = withWorker(t);
  const inv = await w.call('capture_invalidate', { grant_id: 'grant-A' });
  assert.equal(inv.ok, true);
  assert.equal(inv.cleared, 0);
  const stats = await w.call('capture_stats');
  assert.equal(stats.ok, true);
  assert.equal(stats.captures, 0);
  assert.equal((await w.call('execute_shell')).error, 'unknown_cmd', '不得新增开放式命令');

  const indexSrc = fs.readFileSync(WORKER, 'utf8');
  assert.ok(!/case 'capture_read'|case 'capture_bytes'/.test(indexSrc),
    'worker 不得把截图原文做成消息出口（C09）');
  const hostSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'computer-worker-host.ts'), 'utf8');
  assert.match(hostSrc, /async captureWindow\(/, 'host 只暴露固定意图方法');
  const ipcSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'ipc', 'computer.ts'), 'utf8');
  assert.ok(!/computer:capture|capture_window/.test(ipcSrc),
    '本项不新增 main IPC 通道（DT-04 / T7 待立项）');
  const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'business-ui-preload.ts'), 'utf8');
  assert.ok(!/computer:capture|captureWindow/.test(preloadSrc),
    '本项不新增 preload 白名单（渲染器仍拿不到截图）');
});
