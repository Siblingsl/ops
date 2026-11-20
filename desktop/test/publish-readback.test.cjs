const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildPublishReadback,
  normalizePublishText,
  normalizePublishBody,
  stripTrailingFallbackTags,
} = require('../.build/publish/readback.js');
const { createXhsPublishAdapter } = require('../.build/publish/xhs.js');
const { parsePublishTaskClaim, toServerPublishResult } = require('../.build/publish-task-client.js');

function manifest(overrides = {}) {
  return {
    fields: {
      title: '测试标题',
      body_text: '第一段正文。第二段正文。',
      tags: ['账号名', '测试'],
      schedule_at: '',
      ...overrides,
    },
    assets: [{ asset_id: 'asset-1', role: 'cover', width: 900, height: 1200 }],
  };
}

function actual(overrides = {}) {
  return {
    title: '测试标题',
    body: '第一段正文。\n\n第二段正文。',
    tags: ['账号名', '测试'],
    cover: { present: true, ratio: 900 / 1200 },
    schedule: '',
    ...overrides,
  };
}

test('P3 归一化：全角转半角、去零宽、空白折叠', () => {
  assert.equal(normalizePublishText('　全角ＡＢＣ\u200b  多个   空格 '), '全角ABC 多个 空格');
  assert.equal(normalizePublishBody('第一段 正文\n\n第二段'), '第一段正文第二段');
});

test('P3 真实页：从正文尾部剥离回退 hashtags，标签仍单独核对', () => {
  const body = '第一段正文。\n\n第二段正文。\n\n#验收号 #回读验证';
  assert.equal(stripTrailingFallbackTags(body, ['验收号', '回读验证']), '第一段正文。\n\n第二段正文。');
  assert.equal(stripTrailingFallbackTags('正文 #不是尾部标签 #x\n后续', ['不是尾部标签']), '正文 #不是尾部标签 #x\n后续');
  assert.equal(stripTrailingFallbackTags(body, []), body);
});

test('P3 回读五字段：标题/正文/标签/封面/定时全一致才 ok', () => {
  const result = buildPublishReadback(manifest(), actual());
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.fields).sort(), ['body', 'cover', 'schedule', 'tags', 'title']);
  for (const field of Object.values(result.fields)) assert.equal(field.ok, true);
});

test('P3 回读：正文空白差异视为一致，截断与推广语边界正确', () => {
  const same = buildPublishReadback(manifest(), actual({ body: '第一段正文。第二段正文。  ' }));
  assert.equal(same.fields.body.ok, true);

  const truncated = buildPublishReadback(manifest(), actual({ body: '第一段正文。' }));
  assert.equal(truncated.fields.body.ok, false);
  assert.equal(truncated.ok, false);

  const promo = buildPublishReadback(manifest(), actual({ body: '第一段正文。第二段正文。本文为推广内容' }));
  assert.equal(promo.fields.body.ok, true);

  const injected = buildPublishReadback(manifest(), actual({ body: '第一段正文。第二段正文。点击下载APP' }));
  assert.equal(injected.fields.body.ok, false);
});

test('P3 回读：标签数量与首项必须一致，封面比例容差 0.02', () => {
  const reordered = buildPublishReadback(manifest(), actual({ tags: ['账号名', '测试'] }));
  assert.equal(reordered.fields.tags.ok, true);
  const firstChanged = buildPublishReadback(manifest(), actual({ tags: ['测试', '账号名'] }));
  assert.equal(firstChanged.fields.tags.ok, false);
  const missing = buildPublishReadback(manifest(), actual({ tags: ['账号名'] }));
  assert.equal(missing.fields.tags.ok, false);

  const close = buildPublishReadback(manifest(), actual({ cover: { present: true, ratio: 0.73 } }));
  assert.equal(close.fields.cover.ok, true);
  const far = buildPublishReadback(manifest(), actual({ cover: { present: true, ratio: 0.5 } }));
  assert.equal(far.fields.cover.ok, false);
  const absent = buildPublishReadback(manifest(), actual({ cover: { present: false, ratio: 0 } }));
  assert.equal(absent.fields.cover.ok, false);
});

test('P3 适配器回读：自动生成五字段与截图证据；不一致时拒绝提交', async () => {
  const page = {
    currentAccountName: async () => 'OPS测试号',
    hasAnchor: async () => true,
    readbackFields: async () => actual(),
    captureScreenshot: async () => 'ZmFrZS1qcGVn',
    submitNow: async () => undefined,
  };
  const adapter = createXhsPublishAdapter(page);
  const ok = await adapter.readback({
    taskId: 't1', workspaceId: 'w1', accountId: 'a1', workId: 'k1',
    platform: 'xhs', manifest: manifest(), mode: 'desktop', accountName: 'OPS测试号'
  });
  assert.equal(ok.readback.ok, true);
  assert.equal(ok.evidence.readback_ok, true);
  assert.equal(ok.evidence.screenshot_base64, 'ZmFrZS1qcGVn');
  assert.equal(ok.evidence.readback.fields.title.ok, true);

  const mismatch = await createXhsPublishAdapter({
    ...page,
    readbackFields: async () => actual({ title: '另一个标题' }),
  }).readback({
    taskId: 't2', workspaceId: 'w1', accountId: 'a1', workId: 'k1',
    platform: 'xhs', manifest: manifest(), mode: 'desktop', accountName: 'OPS测试号'
  });
  assert.equal(mismatch.readback.ok, false);
  assert.equal(mismatch.state, 'failed');
  assert.equal(mismatch.errorCode, 'readback_mismatch');
});

test('P2 claim 解析：intent=submit 与随任务下发的图片字节', () => {
  const data = Buffer.from('image').toString('base64');
  const claim = parsePublishTaskClaim({
    task: {
      id: 'task-1', workspace_id: 'ws-1', account_id: 'ac-1', work_id: 'wk-1',
      platform: 'xhs', mode: 'desktop', state_version: 5,
    },
    intent: 'submit',
    manifest: manifest(),
    assets: [{ asset_id: 'asset-1', role: 'cover', mime: 'image/jpeg', width: 900, height: 1200, sha256: 'x', data }],
  });
  assert.equal(claim.intent, 'submit');
  assert.equal(claim.stateVersion, 5);
  assert.equal(claim.assets.length, 1);
  assert.equal(claim.assets[0].role, 'cover');
  assert.equal(claim.assets[0].data.toString('utf8'), 'image');
  assert.equal(parsePublishTaskClaim({ task: null }), null);
});

test('P6 结果映射：submitted 只由显式提交分支产生', () => {
  const submitted = toServerPublishResult({ state: 'submitted', evidence: { submit_verified: true } });
  assert.equal(submitted.to, 'submitted');
  assert.equal(submitted.evidence.submit_verified, true);
  const filled = toServerPublishResult({ state: 'awaiting_user', readback: { ok: true } });
  assert.equal(filled.to, 'filled');
});
