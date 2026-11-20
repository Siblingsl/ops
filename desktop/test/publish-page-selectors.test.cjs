const assert = require('node:assert/strict');
const test = require('node:test');
const { isXhsImageTabText, isXhsImageAccept } = require('../.build/publish-page.js');

test('P3 真实页：只识别“上传图文”，不误点“上传视频”', () => {
  assert.equal(isXhsImageTabText('上传图文'), true);
  assert.equal(isXhsImageTabText(' 上传图文 '), true);
  assert.equal(isXhsImageTabText('上传视频'), false);
  assert.equal(isXhsImageTabText('写长文'), false);
});

test('P3 真实页：图片 accept 与视频 accept 分开判定', () => {
  assert.equal(isXhsImageAccept('.jpg,.jpeg,.png,.webp'), true);
  assert.equal(isXhsImageAccept('image/*'), true);
  assert.equal(isXhsImageAccept(''), true);
  assert.equal(isXhsImageAccept('.mp4,.mov,.flv,.mkv'), false);
  assert.equal(isXhsImageAccept('video/mp4'), false);
});
