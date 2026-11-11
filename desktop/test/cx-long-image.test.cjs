const assert = require('node:assert/strict');
const test = require('node:test');
const { PNG } = require('pngjs');
const {
  CX_LONG_IMAGE_DPR,
  CX_LONG_IMAGE_MAX_PIXELS,
  CX_LONG_IMAGE_SEGMENT_MAX_HEIGHT,
  CX_LONG_IMAGE_WIDTH,
  planCXLongImage,
  stitchCXLongImageSegments,
} = require('../.build/cx-long-image-pure.js');

function png(width, height, paint) {
  const image = new PNG({ width, height, colorType: 6, inputColorType: 6 });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const color = paint(x, y);
      image.data[offset] = color[0];
      image.data[offset + 1] = color[1];
      image.data[offset + 2] = color[2];
      image.data[offset + 3] = color[3] ?? 255;
    }
  }
  return PNG.sync.write(image, { colorType: 6, inputColorType: 6 });
}

test('预检按输出物理像素分段，并在分配前拒绝高度上限外输入', () => {
  assert.equal(CX_LONG_IMAGE_DPR, 2);
  assert.equal(CX_LONG_IMAGE_WIDTH, 780);
  assert.equal(CX_LONG_IMAGE_SEGMENT_MAX_HEIGHT, 8_000);
  const boundary = planCXLongImage(4_000);
  assert.equal(boundary.height, 8_000);
  assert.deepEqual(boundary.segments, [{ y: 0, height: 8_000 }]);
  const afterBoundary = planCXLongImage(4_001);
  assert.deepEqual(afterBoundary.segments, [{ y: 0, height: 8_000 }, { y: 8_000, height: 2 }]);
  const maximum = planCXLongImage(30_000, 8 * 1024 * 1024);
  assert.equal(maximum.height, 60_000);
  assert.equal(maximum.totalPixels, CX_LONG_IMAGE_MAX_PIXELS);
  assert.equal(maximum.segments.length, 8);
  assert.throws(() => planCXLongImage(30_001), { code: 'image_too_tall' });
  assert.throws(() => planCXLongImage(10, 8 * 1024 * 1024 + 1), { code: 'image_too_tall' });
});

test('拼接检查 PNG 尺寸、保留分段颜色次序并检测纯色空白图', () => {
  const plan = planCXLongImage(2);
  const source = png(780, 4, (_x, y) => y < 2 ? [255, 255, 255] : [24, 38, 52]);
  const output = stitchCXLongImageSegments([source], plan);
  const decoded = PNG.sync.read(output);
  assert.equal(decoded.width, 780);
  assert.equal(decoded.height, 4);
  assert.deepEqual([...decoded.data.subarray(0, 4)], [255, 255, 255, 255]);
  assert.deepEqual([...decoded.data.subarray(2 * 780 * 4, 2 * 780 * 4 + 4)], [24, 38, 52, 255]);

  // Identical inputs must stay byte-identical after the pure-module extract.
  const again = stitchCXLongImageSegments([source], plan);
  assert.equal(Buffer.compare(output, again), 0);

  const solidWhite = png(780, 4, () => [255, 255, 255]);
  assert.throws(() => stitchCXLongImageSegments([solidWhite], plan), { code: 'long_image_invalid' });
  const alphaOnlyVariation = png(780, 4, (_x, y) => [24, 38, 52, y < 2 ? 0 : 255]);
  assert.doesNotThrow(() => stitchCXLongImageSegments([alphaOnlyVariation], plan));
  const wrongSize = png(390, 4, () => [0, 0, 0]);
  assert.throws(() => stitchCXLongImageSegments([wrongSize], plan), { code: 'long_image_invalid' });
  assert.throws(() => stitchCXLongImageSegments([Buffer.from('bad')], plan), { code: 'long_image_invalid' });
});
