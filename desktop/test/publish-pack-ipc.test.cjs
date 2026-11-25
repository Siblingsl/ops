const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  PUBLISH_PACK_XHS_IMAGES_CHANNEL,
  XHS_MANUAL_PACK_MAX_FILES,
  buildXhsManualImageFileName,
  exportXhsManualImageFolder,
  registerPublishPackIpcHandlers,
} = require('../.build/ipc/publish-pack.js');

// OPT-U03（docs/43 §4）：小红书人工接管包的本机导出通道。
// 1) 只有业务窗口主框架能调；2) workId / 张数 / 扩展名 / 字节上限全在本机二次校验；
// 3) 落盘只允许 tempRoot/<workId>-<ts>/，返回值只含张数与安全文件名（绝不回传绝对路径）；
// 4) shell.openPath 返回非空即失败，失败文案固定、不泄漏路径。

const APP_URL = 'https://ops.example/app';

function tempRootFor(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-xhs-pack-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function validInput(over = {}) {
  return {
    workId: 'work_1',
    files: [
      { ext: 'png', bytes: new Uint8Array([1, 2, 3]) },
      { ext: 'jpg', bytes: new Uint8Array([4, 5]) },
      { ext: 'webp', bytes: new Uint8Array([6]) },
    ],
    ...over,
  };
}

test('OPT-U03: 导出序号 01_封面 起、其余两位补零', () => {
  assert.equal(buildXhsManualImageFileName(0, 'png'), '01_封面.png');
  assert.equal(buildXhsManualImageFileName(1, 'jpg'), '02.jpg');
  assert.equal(buildXhsManualImageFileName(2, 'webp'), '03.webp');
  assert.equal(buildXhsManualImageFileName(17, 'gif'), '18.gif');
});

test('OPT-U03: workId / 张数 / 扩展名 / 字节上限非法时拒调且不落盘', async (t) => {
  const root = tempRootFor(t);
  const opened = [];
  const deps = { tempRoot: root, openPath: async (dir) => { opened.push(dir); return ''; }, now: () => 1_700_000_000_000 };
  const before = fs.readdirSync(root);
  const cases = [
    // 路径穿越与不合规 workId
    validInput({ workId: '../x' }),
    validInput({ workId: 'a/b' }),
    validInput({ workId: '' }),
    validInput({ workId: 'x'.repeat(65) }),
    validInput({ workId: 'a b' }),
    // 空列表 / 超 18 张
    validInput({ files: [] }),
    validInput({ files: Array.from({ length: XHS_MANUAL_PACK_MAX_FILES + 1 }, () => ({ ext: 'png', bytes: new Uint8Array([1]) })) }),
    // 扩展名白名单
    validInput({ files: [{ ext: 'bmp', bytes: new Uint8Array([1]) }] }),
    validInput({ files: [{ ext: '../png', bytes: new Uint8Array([1]) }] }),
    // 非 Uint8Array / 0 字节 / 单张超 20MB
    validInput({ files: [{ ext: 'png', bytes: 'not-bytes' }] }),
    validInput({ files: [{ ext: 'png', bytes: new Uint8Array(0) }] }),
    validInput({ files: [{ ext: 'png', bytes: new Uint8Array(20 * 1024 * 1024 + 1) }] }),
    // 多余键整份拒绝
    { ...validInput(), dir: 'C:\\Users\\me' },
    { workId: 'work_1', files: [{ ext: 'png', bytes: new Uint8Array([1]), name: 'x.png' }] },
    null,
    'work_1',
  ];
  for (const input of cases) {
    const result = await exportXhsManualImageFolder(input, deps);
    assert.equal(result.ok, false, `应拒绝 ${JSON.stringify(input)?.slice(0, 80)}`);
    assert.equal(result.code, 'invalid_argument');
    assert.ok(!result.message.includes(root), '失败文案不得包含本机路径');
  }
  assert.deepEqual(fs.readdirSync(root), before, '非法参数不得产生目录');
  assert.deepEqual(opened, [], '非法参数不得打开文件夹');
});

test('OPT-U03: 正常 3 张图按序落盘、字节一致并调用 openPath', async (t) => {
  const root = tempRootFor(t);
  const opened = [];
  const input = validInput();
  const result = await exportXhsManualImageFolder(input, {
    tempRoot: root,
    openPath: async (dir) => { opened.push(dir); return ''; },
    now: () => 1_700_000_000_000,
  });
  assert.deepEqual(result, { ok: true, count: 3, fileNames: ['01_封面.png', '02.jpg', '03.webp'] });
  const exportDir = path.join(root, 'work_1-1700000000000');
  assert.equal(opened.length, 1);
  assert.equal(opened[0], exportDir);
  assert.deepEqual((await fsp.readdir(exportDir)).sort(), ['01_封面.png', '02.jpg', '03.webp']);
  for (const [index, name] of ['01_封面.png', '02.jpg', '03.webp'].entries()) {
    const written = new Uint8Array(await fsp.readFile(path.join(exportDir, name)));
    assert.deepEqual([...written], [...input.files[index].bytes], `${name} 字节必须一致`);
  }
  // 返回值只含张数与安全文件名：不带目录、不带本机绝对路径。
  assert.deepEqual(Object.keys(result).sort(), ['count', 'fileNames', 'ok']);
  assert.ok(!JSON.stringify(result).includes(root));
});

test('OPT-U03: openPath 返回非空错误串时如实失败且不泄漏绝对路径', async (t) => {
  const root = tempRootFor(t);
  const result = await exportXhsManualImageFolder(validInput(), {
    tempRoot: root,
    openPath: async () => 'Failed to open path',
    now: () => 1_700_000_000_001,
  });
  assert.deepEqual(result, { ok: false, code: 'open_folder_failed', message: '无法打开系统文件夹，请重试' });
  assert.ok(!JSON.stringify(result).includes(root));
});

test('OPT-U03: openPath 抛错同样压成 open_folder_failed，不把异常原文透出', async (t) => {
  const root = tempRootFor(t);
  const result = await exportXhsManualImageFolder(validInput(), {
    tempRoot: root,
    openPath: async () => { throw new Error(`EACCES: ${root}\\work_1-1`); },
    now: () => 1_700_000_000_002,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'open_folder_failed');
  assert.ok(!result.message.includes(root));
});

function hostAndEvent({ destroyed = false, frameUrl = APP_URL, pageUrl = APP_URL, sameFrame = true, senderOverride } = {}) {
  const mainFrame = { url: frameUrl };
  const sender = { getURL: () => pageUrl, mainFrame };
  const host = { webContents: sender, isDestroyed: () => destroyed };
  return {
    host,
    event: { sender: senderOverride ?? sender, senderFrame: sameFrame ? sender.mainFrame : { url: frameUrl } },
  };
}

function registerHarness(deps) {
  const handlers = new Map();
  registerPublishPackIpcHandlers({ ipcHandle: (channel, handler) => handlers.set(channel, handler), ...deps });
  return handlers;
}

test('OPT-U03: 非业务窗口一律拒调（宿主缺失/已销毁/不同 webContents/非主框架/非业务 URL）', async (t) => {
  const root = tempRootFor(t);
  const opened = [];
  const base = { tempRoot: () => root, openPath: async (dir) => { opened.push(dir); return ''; }, now: () => 1 };

  const missing = registerHarness({ businessWindow: () => null, isBusinessUrl: () => true });
  const missingResult = await missing.get(PUBLISH_PACK_XHS_IMAGES_CHANNEL)(hostAndEvent().event, validInput());
  assert.deepEqual(missingResult, { ok: false, code: 'not_business_window', message: '不允许此窗口导出小红书图片。' });

  const cases = [
    { label: '宿主已销毁', make: () => hostAndEvent({ destroyed: true }) },
    { label: '不同 webContents', make: () => hostAndEvent({ senderOverride: { getURL: () => APP_URL, mainFrame: { url: APP_URL } } }) },
    { label: 'senderFrame 非主框架', make: () => hostAndEvent({ sameFrame: false }) },
    { label: 'senderFrame URL 非业务站', make: () => hostAndEvent({ frameUrl: 'https://evil.example/x' }) },
    { label: '页面 URL 非业务站', make: () => hostAndEvent({ pageUrl: 'https://evil.example/x' }) },
  ];
  for (const item of cases) {
    const { host, event } = item.make();
    const handlers = registerHarness({ businessWindow: () => host, isBusinessUrl: (url) => url === APP_URL, ...base });
    const result = await handlers.get(PUBLISH_PACK_XHS_IMAGES_CHANNEL)(event, validInput());
    assert.equal(result.ok, false, item.label);
    assert.equal(result.code, 'not_business_window', item.label);
  }
  assert.deepEqual(fs.readdirSync(root), [], '被拒调用不得落盘');
  assert.deepEqual(opened, [], '被拒调用不得打开文件夹');
});

test('OPT-U03: 业务窗口主框架调用的正常链路落盘并打开文件夹', async (t) => {
  const root = tempRootFor(t);
  const opened = [];
  const { host, event } = hostAndEvent();
  const handlers = registerHarness({
    businessWindow: () => host,
    isBusinessUrl: (url) => url === APP_URL,
    tempRoot: () => root,
    openPath: async (dir) => { opened.push(dir); return ''; },
    now: () => 1_700_000_000_003,
  });
  const result = await handlers.get(PUBLISH_PACK_XHS_IMAGES_CHANNEL)(event, validInput());
  assert.deepEqual(result, { ok: true, count: 3, fileNames: ['01_封面.png', '02.jpg', '03.webp'] });
  assert.deepEqual(fs.readdirSync(root), ['work_1-1700000000003']);
  assert.equal(opened[0], path.join(root, 'work_1-1700000000003'));
  assert.ok(!JSON.stringify(result).includes(root));
});
