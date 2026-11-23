const assert = require('node:assert/strict');
const test = require('node:test');
const { promises: fs } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PNG } = require('pngjs');

const {
  MAX_IMAGE_BYTES,
  decodePng,
  comparePng,
  buildDiffPng,
  readPngHeader,
  BaselineImageError,
  BaselineMonitor,
  schemaSuspectStopReason
} = require('../.build/platforms/baseline-diff.js');
const { maybeCapturePlatformBaseline, BASELINE_REGIONS } = require('../.build/platforms/baseline-capture.js');

function makePng(width, height, paint = () => [100, 100, 100, 255]) {
  const image = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const [r, g, b, a] = paint(x, y);
      image.data[offset] = r;
      image.data[offset + 1] = g;
      image.data[offset + 2] = b;
      image.data[offset + 3] = a;
    }
  }
  return PNG.sync.write(image);
}

function patchPng(buffer, patches) {
  const image = PNG.sync.read(buffer);
  for (const [x, y, rgba] of patches) {
    const offset = (y * image.width + x) * 4;
    image.data[offset] = rgba[0];
    image.data[offset + 1] = rgba[1];
    image.data[offset + 2] = rgba[2];
    image.data[offset + 3] = rgba[3] ?? 255;
  }
  return PNG.sync.write(image);
}

test('B-05.1：同图零差异；4×4 改 2 个明显像素 + 1 个细微像素，阈值 0 时多计 1', () => {
  const base = makePng(4, 4);
  const same = comparePng(base, base);
  assert.equal(same.matches, true);
  assert.equal(same.changedPixels, 0);
  assert.equal(same.totalPixels, 16);
  assert.equal(same.changedRatio, 0);

  const changed = patchPng(base, [
    [0, 0, [200, 200, 200]],
    [1, 0, [200, 200, 200]],
    [2, 0, [100, 100, 101]]
  ]);
  const normal = comparePng(base, changed);
  assert.equal(normal.changedPixels, 2, '默认 threshold=0.1 时细微差异不计');
  const strict = comparePng(base, changed, { threshold: 0 });
  assert.equal(strict.changedPixels, 3, 'threshold=0 时细微差异也计入');
});

test('B-05.1：尺寸不一致直接报错并给出两边尺寸，不缩放', () => {
  const a = makePng(4, 4);
  const b = makePng(5, 4);
  assert.throws(() => comparePng(a, b), (error) => {
    assert.ok(error instanceof BaselineImageError);
    assert.equal(error.code, 'image_size_mismatch');
    assert.match(error.message, /4x4/);
    assert.match(error.message, /5x4/);
    return true;
  });
});

test('B-05.1：索引色 PNG 拒绝，32 MiB / 16 MP 上限生效', () => {
  const valid = makePng(2, 2);
  const indexed = Buffer.from(valid);
  indexed[25] = 3; // IHDR color type = 3（索引色）
  assert.throws(() => decodePng(indexed), (error) => error.code === 'png_color_type_unsupported');

  const tooLarge = Buffer.alloc(MAX_IMAGE_BYTES + 1);
  tooLarge[0] = 137;
  assert.throws(() => decodePng(tooLarge), (error) => error.code === 'image_too_large');

  const bomb = Buffer.alloc(33);
  for (const [index, byte] of [137, 80, 78, 71, 13, 10, 26, 10].entries()) bomb[index] = byte;
  bomb.writeUInt32BE(5000, 16);
  bomb.writeUInt32BE(4000, 20);
  bomb[24] = 8;
  bomb[25] = 6;
  assert.equal(readPngHeader(bomb).width, 5000);
  assert.throws(() => decodePng(bomb), (error) => error.code === 'image_too_many_pixels');
});

test('B-05.3：diff 图变化像素纯红，未变化像素淡灰 alpha 255', () => {
  const base = makePng(2, 1, () => [100, 100, 100, 255]);
  const after = patchPng(base, [[0, 0, [255, 0, 0]]]);
  const diff = buildDiffPng(base, after);
  const image = PNG.sync.read(diff);
  assert.deepEqual([...image.data.slice(0, 4)], [255, 0, 0, 255]);
  const gray = image.data[4];
  assert.equal(image.data[5], gray);
  assert.equal(image.data[6], gray);
  assert.equal(image.data[7], 255);
  assert.ok(gray > 200, '淡灰应接近白色（10% alpha）');
});

test('B-05.3：掩码区域不参与比对', () => {
  const base = makePng(4, 1);
  const after = patchPng(base, [[0, 0, [255, 0, 0]], [1, 0, [255, 0, 0]]]);
  const masked = comparePng(base, after, { mask: [{ x: 0, y: 0, width: 2, height: 1 }] });
  assert.equal(masked.changedPixels, 0);
  assert.equal(masked.matches, true);
});

test('B-05.4：基线按区域存盘；超 2% 记 schema_suspect，连续 3 次建议 schema_changed，稳定后清零', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ops-baseline-'));
  const monitor = new BaselineMonitor({ dir });
  const base = makePng(4, 4);
  const first = await monitor.checkRegion('main', base);
  assert.equal(first.status, 'baseline_created');
  const second = await monitor.checkRegion('main', base);
  assert.equal(second.status, 'stable');
  assert.equal(second.streak, 0);

  const changed = patchPng(base, [[0, 0, [255, 0, 0]], [1, 0, [255, 0, 0]]]);
  const one = await monitor.checkRegion('main', changed);
  assert.equal(one.status, 'schema_suspect');
  assert.equal(one.streak, 1);
  assert.ok(one.changedRatio > 0.02);
  assert.equal(one.recommendation, 'watch');

  await monitor.checkRegion('main', changed);
  const three = await monitor.checkRegion('main', changed);
  assert.equal(three.status, 'schema_changed_suggested');
  assert.equal(three.streak, 3);
  assert.equal(three.recommendation, 'check_mapping');
  assert.equal(schemaSuspectStopReason([three]), 'schema_changed');

  const stable = await monitor.checkRegion('main', base);
  assert.equal(stable.status, 'stable');
  assert.equal(stable.streak, 0);
  // 基线文件与 meta 都真实落盘。
  const files = await fs.readdir(dir);
  assert.ok(files.includes('main.png'));
  assert.ok(files.includes('meta.json'));
});

test('B-05.4：尺寸变化不硬比，rebase 重建该区域基线', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ops-baseline-rebase-'));
  const monitor = new BaselineMonitor({ dir });
  await monitor.checkRegion('main', makePng(4, 4));
  const result = await monitor.rebaseRegion('main', makePng(8, 8));
  assert.equal(result.status, 'baseline_created');
  assert.match(result.message, /重建基线/);
  const stable = await monitor.checkRegion('main', makePng(8, 8));
  assert.equal(stable.status, 'stable');
});

function fakeSession(profileDir, { failCapture = false } = {}) {
  const calls = [];
  return {
    platform: 'xhs',
    profileDir,
    browser: { child: {}, send: () => {}, onMessage: () => {}, failure: () => null, close: async () => {} },
    cdp: {
      request: async (method, params) => {
        calls.push({ method, params });
        if (method === 'Page.getLayoutMetrics') {
          return { cssLayoutViewport: { clientWidth: 400, clientHeight: 300 }, layoutViewport: { clientWidth: 400, clientHeight: 300 } };
        }
        if (method === 'Page.captureScreenshot') {
          if (failCapture) throw new Error('capture disabled');
          return { data: makePng(8, 8).toString('base64') };
        }
        throw new Error(`unexpected ${method}`);
      }
    },
    calls
  };
}

test('B-05.5：采集前置每日一次；三个固定区域；同日第二次跳过；可 force', async () => {
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ops-baseline-capture-'));
  const session = fakeSession(profileDir);
  const first = await maybeCapturePlatformBaseline(session);
  assert.equal(first.checked, true);
  assert.equal(first.regions.length, BASELINE_REGIONS.length);
  assert.deepEqual([...new Set(first.regions.map((item) => item.status))], ['baseline_created']);
  assert.equal(first.viewport.width, 400);
  assert.equal(first.viewport.height, 300);

  const second = await maybeCapturePlatformBaseline(session);
  assert.equal(second.checked, false);
  assert.equal(second.reason, 'already_checked_today');

  const forced = await maybeCapturePlatformBaseline(session, { force: true });
  assert.equal(forced.checked, true);
});

test('B-05.5：捕获不可用时安静跳过，不抛出到采集主链路', async () => {
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ops-baseline-fail-'));
  const session = fakeSession(profileDir, { failCapture: true });
  const summary = await maybeCapturePlatformBaseline(session);
  assert.equal(summary.checked, false);
  assert.equal(summary.reason, 'no_regions');
});
