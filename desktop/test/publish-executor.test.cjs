const assert = require('node:assert/strict');
const test = require('node:test');

const { createXhsPublishAdapter } = require('../.build/publish/xhs.js');
const { createToutiaoPublishAdapter } = require('../.build/publish/toutiao.js');
const {
  DesktopPublishAdapterRegistry,
  createDefaultDesktopPublishAdapterRegistry
} = require('../.build/publish/registry.js');
const { runDesktopPublishTask } = require('../.build/publish/executor.js');
const { withPublishTimeout } = require('../.build/publish/errors.js');

function request(overrides = {}) {
  return {
    taskId: 'task-1',
    workspaceId: 'workspace-1',
    accountId: 'account-1',
    workId: 'work-1',
    platform: 'xhs',
    manifest: { title: '测试标题' },
    mode: 'desktop',
    accountName: 'OPS测试号',
    ...overrides
  };
}

function page(overrides = {}) {
  return {
    currentAccountName: async () => 'OPS测试号',
    hasAnchor: async () => true,
    ...overrides
  };
}

test('P8 桌面适配器：账号不匹配返回 account_mismatch', async () => {
  const adapter = createXhsPublishAdapter(page({ currentAccountName: async () => '另一个账号' }));
  await assert.rejects(
    () => adapter.preflight(request()),
    (err) => err.code === 'account_mismatch'
  );
});

test('P8 桌面适配器：页面锚点缺失返回 anchor_missing', async () => {
  const adapter = createXhsPublishAdapter(page({
    hasAnchor: async (anchor) => anchor !== 'xhs-upload'
  }));
  await assert.rejects(
    () => adapter.preflight(request()),
    (err) => err.code === 'anchor_missing'
  );
});

test('RC-05 小红书 preflight：默认视频页只有上传图文入口时通过，不误判 title/editor 缺失', async () => {
  // 真实发布页默认停在“上传视频”，标题/正文编辑器要上传图片后才出现。
  const adapter = createXhsPublishAdapter(page({
    hasAnchor: async (anchor) => anchor === 'xhs-account' || anchor === 'xhs-upload'
  }));
  const evidence = await adapter.preflight(request());
  assert.equal(evidence.anchors_ok, true);
});

test('P8 桌面适配器：单次动作超时返回 executor_timeout', async () => {
  const adapter = createXhsPublishAdapter(page({
    fillFields: async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }));
  await assert.rejects(
    () => withPublishTimeout(adapter.fill(request()), 10, 'fill'),
    (err) => err.code === 'executor_timeout'
  );
});

test('P8/P6 桌面适配器：API 显式 submit-now 才可提交；desktop 通道必须有匹配页校验', async () => {
  let submits = 0;
  const adapter = createToutiaoPublishAdapter(page({
    submitNow: async () => { submits += 1; }
  }));
  // desktop 通道未实现匹配页校验时不得提交（P6-A3 fail-closed）
  await assert.rejects(
    () => adapter.submit(request({ platform: 'toutiao', mode: 'desktop', explicitSubmitNow: true })),
    (err) => err.code === 'submit_not_configured'
  );
  await assert.rejects(
    () => adapter.submit(request({ platform: 'toutiao', mode: 'api', explicitSubmitNow: false })),
    (err) => err.code === 'submit_requires_user_action'
  );
  // desktop 即使有 countFilledPages，也必须由用户显式 submit-now 触发
  const counted = createToutiaoPublishAdapter(page({
    submitNow: async () => { submits += 1; },
    countFilledPages: async () => 1
  }));
  await assert.rejects(
    () => counted.submit(request({ platform: 'toutiao', mode: 'desktop' })),
    (err) => err.code === 'submit_requires_user_action'
  );
  const result = await adapter.submit(request({ platform: 'toutiao', mode: 'api', explicitSubmitNow: true }));
  assert.equal(result.state, 'submitted');
  assert.equal(submits, 1);
});

test('P6 桌面适配器：小红书必须拒绝一切 direct submit，绝不点击发布', async () => {
  let submits = 0;
  const adapter = createXhsPublishAdapter(page({
    submitNow: async () => { submits += 1; },
    countFilledPages: async () => 1
  }));
  await assert.rejects(
    () => adapter.submit(request({ mode: 'desktop', explicitSubmitNow: true })),
    (err) => err.code === 'direct_submit_not_supported'
  );
  assert.equal(submits, 0, '小红书不得点击发布');
});

test('RC-05 小红书：填写回读通过后只保存草稿，不调用 submit', async () => {
  let saves = 0;
  let submits = 0;
  const manifest = {
    fields: { title: '草稿标题', body_text: '草稿正文', tags: ['话题'], schedule_at: '' },
    assets: [{ role: 'cover', width: 900, height: 1200 }]
  };
  const adapter = createXhsPublishAdapter(page({
    fillFields: async () => {},
    readbackFields: async () => ({
      title: '草稿标题', body: '草稿正文', tags: ['话题'], cover: { present: true, ratio: 0.75 }, schedule: ''
    }),
    captureScreenshot: async () => 'AAAA',
    saveDraft: async () => { saves += 1; },
    submitNow: async () => { submits += 1; }
  }));
  const req = request({ manifest });
  const filled = await adapter.fill(req);
  assert.equal(filled.state, 'filled');
  const result = await adapter.readback(req);
  assert.equal(result.state, 'awaiting_user');
  assert.equal(result.readback.ok, true);
  assert.equal(result.evidence.draft_saved, true);
  assert.equal(saves, 1);
  assert.equal(submits, 0);
});

test('RC-05 小红书：草稿保存失败必须如实失败，不能冒充已保存', async () => {
  const manifest = {
    fields: { title: '草稿标题', body_text: '草稿正文', tags: [], schedule_at: '' },
    assets: [{ role: 'cover', width: 900, height: 1200 }]
  };
  const adapter = createXhsPublishAdapter(page({
    fillFields: async () => {},
    readbackFields: async () => ({
      title: '草稿标题', body: '草稿正文', tags: [], cover: { present: true, ratio: 0.75 }, schedule: ''
    }),
    captureScreenshot: async () => 'AAAA',
    saveDraft: async () => { throw new Error('未找到暂存离开'); }
  }));
  const result = await adapter.readback(request({ manifest }));
  assert.equal(result.state, 'failed');
  assert.equal(result.errorCode, 'draft_save_failed');
  assert.notEqual(result.evidence.draft_saved, true);
});

test('RC-05 桌面执行器：xhs 收到 submit intent 直接拒绝，不 preflight/readback/点击', async () => {
  let preflights = 0;
  let readbacks = 0;
  let submits = 0;
  const adapter = createXhsPublishAdapter(page({
    submitNow: async () => { submits += 1; }
  }));
  const originalPreflight = adapter.preflight;
  adapter.preflight = async (req) => { preflights += 1; return originalPreflight(req); };
  const originalReadback = adapter.readback;
  adapter.readback = async (req) => { readbacks += 1; return originalReadback(req); };
  const observed = [];
  const result = await runDesktopPublishTask({
    claim: async () => ({
      taskId: 'task-xhs-submit', workspaceId: 'workspace-1', accountId: 'account-1', workId: 'work-1',
      platform: 'xhs', manifest: { title: '测试标题' }, mode: 'desktop', accountName: 'OPS测试号', intent: 'submit'
    }),
    heartbeat: async () => {},
    result: async (taskId, payload) => { observed.push([taskId, payload]); },
    registry: { get: () => adapter }
  });
  assert.equal(result.state, 'failed');
  assert.equal(result.errorCode, 'direct_submit_not_supported');
  assert.equal(preflights, 0);
  assert.equal(readbacks, 0);
  assert.equal(submits, 0);
  assert.equal(observed.length, 1);
});

test('P6 桌面适配器：submit-now 匹配页必须恰好 1 个（0/2 拒绝，1 个成功一次）', async () => {
  let submits = 0;
  const mk = (matches) => createToutiaoPublishAdapter(page({
    submitNow: async () => { submits += 1; },
    countFilledPages: async () => matches,
  }));
  // 0 个匹配页 → submit_ambiguous
  await assert.rejects(
    () => mk(0).submit(request({ platform: 'toutiao', mode: 'desktop', explicitSubmitNow: true })),
    (err) => err.code === 'submit_ambiguous'
  );
  // 2 个匹配页 → submit_ambiguous
  await assert.rejects(
    () => mk(2).submit(request({ platform: 'toutiao', mode: 'desktop', explicitSubmitNow: true })),
    (err) => err.code === 'submit_ambiguous'
  );
  assert.equal(submits, 0, 'ambiguous 情况不得点击');
  // 恰好 1 个 → 点击一次
  const result = await mk(1).submit(request({ platform: 'toutiao', mode: 'desktop', explicitSubmitNow: true }));
  assert.equal(result.state, 'submitted');
  assert.equal(submits, 1);
});

test('P8 注册表覆盖 xhs/toutiao 桌面适配器，版本写入结果证据', async () => {
  const registry = createDefaultDesktopPublishAdapterRegistry(page());
  const list = registry.list();
  assert.deepEqual(
    list.map((item) => [item.platform, item.version]),
    [['xhs', 'xhs-fill-v1'], ['toutiao', 'toutiao-fill-v1']]
  );
  const xhs = registry.get('xhs');
  const preflight = await xhs.preflight(request());
  assert.equal(preflight.adapter_version, 'xhs-fill-v1');
  assert.equal(registry.get('wechat_mp'), undefined);
});

test('P8 桌面执行器：xhs claim → preflight → fill → awaiting_user，不自动提交', async () => {
  let submits = 0;
  const registry = createDefaultDesktopPublishAdapterRegistry(page({
    submitNow: async () => { submits += 1; }
  }));
  const task = {
    taskId: 'task-xhs',
    workspaceId: 'workspace-1',
    accountId: 'account-1',
    workId: 'work-1',
    platform: 'xhs',
    manifest: { title: '测试标题' },
    mode: 'desktop',
    accountName: 'OPS测试号'
  };
  const observed = [];
  const result = await runDesktopPublishTask({
    claim: async () => task,
    heartbeat: async () => { observed.push('heartbeat'); },
    result: async (taskId, payload) => { observed.push([taskId, payload]); },
    registry,
    explicitSubmitNow: true
  });
  assert.equal(result.state, 'awaiting_user');
  assert.equal(result.evidence.adapter_version, 'xhs-fill-v1');
  assert.equal(result.evidence.fill, 'manual_handoff');
  assert.equal(observed[0], 'heartbeat');
  assert.deepEqual(observed[1], ['task-xhs', result]);
  assert.equal(submits, 0);
});

test('P3 桌面执行器：回读 ok=false 时不得提交，返回 readback_mismatch', async () => {
  let submits = 0;
  const adapter = {
    name: 'fake-api',
    version: 'fake-v1',
    preflight: async () => ({ ok: true }),
    fill: async () => ({ state: 'filled' }),
    readback: async () => ({ state: 'filled', readback: { ok: false } }),
    submit: async () => { submits += 1; return { state: 'submitted' }; }
  };
  const registry = { get: () => adapter };
  const result = await runDesktopPublishTask({
    claim: async () => ({
      taskId: 'task-p3',
      workspaceId: 'workspace-1',
      accountId: 'account-1',
      workId: 'work-1',
      platform: 'wechat_mp',
      manifest: { title: '测试标题' },
      mode: 'api'
    }),
    heartbeat: async () => {},
    result: async () => {},
    registry,
    explicitSubmitNow: true
  });
  assert.equal(result.state, 'failed');
  assert.equal(result.errorCode, 'readback_mismatch');
  assert.equal(submits, 0);
});

test('P8 桌面执行器：toutiao 同样从 claim 到 awaiting_user', async () => {
  const registry = createDefaultDesktopPublishAdapterRegistry(page());
  const task = {
    taskId: 'task-toutiao',
    workspaceId: 'workspace-1',
    accountId: 'account-1',
    workId: 'work-1',
    platform: 'toutiao',
    manifest: { title: '测试标题' },
    mode: 'desktop',
    accountName: 'OPS测试号'
  };
  const result = await runDesktopPublishTask({
    claim: async () => task,
    heartbeat: async () => {},
    result: async () => {},
    registry
  });
  assert.equal(result.state, 'awaiting_user');
  assert.equal(result.evidence.adapter_version, 'toutiao-fill-v1');
});

test('P6 桌面执行器：intent=submit 不走填写心跳，回读通过后只提交一次', async () => {
  let heartbeats = 0;
  let submits = 0;
  const observed = [];
  const adapter = {
    name: 'fake-desktop',
    version: 'fake-v1',
    preflight: async () => ({ ok: true }),
    fill: async () => ({ state: 'filled' }),
    readback: async () => ({ state: 'awaiting_user', readback: { ok: true }, evidence: { readback_ok: true } }),
    submit: async () => {
      submits += 1;
      return { state: 'submitted', evidence: { submit_verified: true, matched_pages: 1 } };
    },
  };
  const result = await runDesktopPublishTask({
    claim: async () => ({
      taskId: 'task-submit',
      workspaceId: 'workspace-1',
      accountId: 'account-1',
      workId: 'work-1',
      platform: 'toutiao',
      manifest: { fields: { title: '测试标题' } },
      mode: 'desktop',
      intent: 'submit',
    }),
    heartbeat: async () => { heartbeats += 1; },
    result: async (taskId, payload) => { observed.push([taskId, payload]); },
    registry: { get: () => adapter },
  });
  assert.equal(heartbeats, 0, 'submit intent 不是 filling，不能发填写心跳');
  assert.equal(submits, 1, '用户显式 submit-now 只点一次');
  assert.equal(result.state, 'submitted');
  assert.deepEqual(observed, [['task-submit', result]]);
});

test('P6 桌面执行器：小红书 intent=submit 直接拒绝，连 preflight/readback 都不执行', async () => {
  let called = 0;
  const observed = [];
  const adapter = {
    name: 'fake-xhs',
    version: 'fake-v1',
    preflight: async () => { called += 1; return { ok: true }; },
    fill: async () => { called += 1; return { state: 'filled' }; },
    readback: async () => { called += 1; return { state: 'awaiting_user', readback: { ok: true } }; },
    submit: async () => { called += 1; return { state: 'submitted' }; },
  };
  const result = await runDesktopPublishTask({
    claim: async () => ({
      taskId: 'task-xhs-submit',
      workspaceId: 'workspace-1',
      accountId: 'account-1',
      workId: 'work-1',
      platform: 'xhs',
      manifest: { fields: { title: '测试标题' } },
      mode: 'desktop',
      intent: 'submit',
    }),
    heartbeat: async () => {},
    result: async (taskId, payload) => { observed.push([taskId, payload]); },
    registry: { get: () => adapter },
  });
  assert.equal(called, 0);
  assert.equal(result.state, 'failed');
  assert.equal(result.errorCode, 'direct_submit_not_supported');
  assert.deepEqual(observed, [['task-xhs-submit', result]]);
});

test('P6 桌面执行器：submit intent 回读不一致时绝不点击', async () => {
  let submits = 0;
  const adapter = {
    name: 'fake-desktop',
    version: 'fake-v1',
    preflight: async () => ({ ok: true }),
    fill: async () => ({ state: 'filled' }),
    readback: async () => ({ state: 'failed', readback: { ok: false }, errorCode: 'readback_mismatch' }),
    submit: async () => { submits += 1; return { state: 'submitted' }; },
  };
  const result = await runDesktopPublishTask({
    claim: async () => ({
      taskId: 'task-submit-bad',
      workspaceId: 'workspace-1',
      accountId: 'account-1',
      workId: 'work-1',
      platform: 'toutiao',
      manifest: { fields: { title: '测试标题' } },
      mode: 'desktop',
      intent: 'submit',
    }),
    heartbeat: async () => {},
    result: async () => {},
    registry: { get: () => adapter },
  });
  assert.equal(submits, 0);
  assert.equal(result.state, 'failed');
  assert.equal(result.errorCode, 'readback_mismatch');
});
