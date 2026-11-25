const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  defaultXhsRulePackPath,
  loadDefaultXhsRulePack,
  loadXhsRulePack,
  validateXhsRulePack
} = require('../.build/platforms/rules/loader.js');

const BUILD_PACK_PATH = path.join(__dirname, '..', '.build', 'platforms', 'rules', 'xhs.default.json');
const BASE_PACK = JSON.parse(fs.readFileSync(BUILD_PACK_PATH, 'utf8'));

function clone() {
  return JSON.parse(JSON.stringify(BASE_PACK));
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ops-xhs-rulepack-'));
}

function writeJSON(dir, name, value) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
}

function loadFallback(cachePath) {
  const observed = [];
  const result = loadXhsRulePack({
    cachePath,
    onFallback: (reason) => observed.push(reason)
  });
  assert.equal(result.source, 'default');
  assert.equal(typeof result.fallbackReason, 'string');
  assert.ok(result.fallbackReason.length > 0, 'fallbackReason 必须非空');
  assert.equal(observed.length, 1, 'onFallback 必须被调用一次');
  assert.equal(observed[0], result.fallbackReason);
  assert.equal(result.pack, loadDefaultXhsRulePack(), '必须回落到内置冻结规则包');
  return result;
}

function withTemp(fn) {
  const dir = tempDir();
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('内置 xhs.default.json 存在、通过校验且深度冻结', () => {
  const defaultPath = defaultXhsRulePackPath();
  assert.equal(path.basename(defaultPath), 'xhs.default.json');
  assert.ok(fs.existsSync(defaultPath), '内置规则包必须随包存在');
  assert.ok(fs.existsSync(BUILD_PACK_PATH), '.build 必须复制内置规则包');

  // 文档登记的 8 项必填顶层键，加上本任务扩展的 4 项。
  for (const key of [
    'schema_version', 'platform', 'adapter_version', 'mapping_version',
    'updated_at', 'urls', 'anchors', 'selectors'
  ]) {
    assert.ok(Object.prototype.hasOwnProperty.call(BASE_PACK, key), `缺少顶层键 ${key}`);
  }
  for (const key of ['publish_adapter_version', 'api_paths', 'share_hosts', 'readback']) {
    assert.ok(Object.prototype.hasOwnProperty.call(BASE_PACK, key), `缺少扩展顶层键 ${key}`);
  }

  const validated = validateXhsRulePack(BASE_PACK);
  assert.equal(validated.ok, true, validated.ok ? '' : validated.reason);
  assert.equal(Object.isFrozen(validated.pack), true, '规则包顶层必须冻结');
  assert.equal(Object.isFrozen(validated.pack.urls), true);
  assert.equal(Object.isFrozen(validated.pack.selectors), true);
  assert.equal(Object.isFrozen(validated.pack.selectors.title), true);
  assert.equal(Object.isFrozen(validated.pack.anchors.prefill), true);
  assert.equal(Object.isFrozen(validated.pack.readback.observation_field_paths), true);

  const first = loadDefaultXhsRulePack();
  const second = loadDefaultXhsRulePack();
  assert.equal(first, second, '内置规则必须缓存为同一冻结对象');
});

test('合法热更新缓存优先加载，且按优先级覆盖 overrideDir 与环境变量', () => withTemp((dir) => {
  const explicit = clone();
  explicit.updated_at = '2026-11-26T00:00:00Z';
  explicit.anchors.account = 'xhs-account-explicit';
  explicit.selectors.note_card = '.note-card-explicit';
  explicit.urls.publish = 'https://creator.xiaohongshu.com/publish/publish?source=official&rulepack=explicit';
  const explicitPath = writeJSON(dir, 'explicit.json', explicit);

  const overrideDir = path.join(dir, 'override');
  fs.mkdirSync(overrideDir);
  const viaOverride = clone();
  viaOverride.anchors.account = 'xhs-account-override';
  writeJSON(overrideDir, 'xhs.json', viaOverride);

  const envDir = path.join(dir, 'env');
  fs.mkdirSync(envDir);
  const viaEnv = clone();
  viaEnv.anchors.account = 'xhs-account-env';
  const envPath = writeJSON(envDir, 'env.json', viaEnv);

  const savedEnv = process.env.OPS_XHS_RULEPACK_PATH;
  try {
    process.env.OPS_XHS_RULEPACK_PATH = envPath;

    const explicitResult = loadXhsRulePack({ cachePath: explicitPath, overrideDir });
    assert.equal(explicitResult.source, 'cache');
    assert.equal(explicitResult.cachePath, explicitPath);
    assert.equal(explicitResult.pack.anchors.account, 'xhs-account-explicit');
    assert.equal(explicitResult.pack.updated_at, '2026-11-26T00:00:00Z');
    assert.equal(explicitResult.pack.urls.publish, explicit.urls.publish);
    assert.equal(Object.isFrozen(explicitResult.pack), true);

    const overrideResult = loadXhsRulePack({ overrideDir });
    assert.equal(overrideResult.source, 'cache');
    assert.equal(overrideResult.pack.anchors.account, 'xhs-account-override');

    const envResult = loadXhsRulePack();
    assert.equal(envResult.source, 'cache');
    assert.equal(envResult.pack.anchors.account, 'xhs-account-env');
  } finally {
    if (savedEnv === undefined) delete process.env.OPS_XHS_RULEPACK_PATH;
    else process.env.OPS_XHS_RULEPACK_PATH = savedEnv;
  }
}));

test('缓存文件不存在时静默回落 default，不调用 onFallback', () => withTemp((dir) => {
  const observed = [];
  const result = loadXhsRulePack({
    cachePath: path.join(dir, 'missing.json'),
    onFallback: (reason) => observed.push(reason)
  });
  assert.equal(result.source, 'default');
  assert.equal(result.fallbackReason, undefined);
  assert.equal(observed.length, 0);
  assert.equal(result.pack, loadDefaultXhsRulePack());
}));

test('坏 JSON 语法安全回落且不抛异常', () => withTemp((dir) => {
  const file = writeJSON(dir, 'broken.json', '{ "schema_version": 1,');
  loadFallback(file);
}));

test('schema_version 或 platform 非法安全回落', () => withTemp((dir) => {
  const wrongSchema = clone();
  wrongSchema.schema_version = 2;
  loadFallback(writeJSON(dir, 'schema.json', wrongSchema));

  const wrongPlatform = clone();
  wrongPlatform.platform = 'wechat_mp';
  loadFallback(writeJSON(dir, 'platform.json', wrongPlatform));
}));

test('缺少必填键（anchors.prefill / selectors.note_card）安全回落', () => withTemp((dir) => {
  const missingPrefill = clone();
  delete missingPrefill.anchors.prefill;
  loadFallback(writeJSON(dir, 'prefill.json', missingPrefill));

  const missingCard = clone();
  delete missingCard.selectors.note_card;
  loadFallback(writeJSON(dir, 'card.json', missingCard));
}));

test('恶意 URL 注入全部拒收并安全回落', () => withTemp((dir) => {
  const variants = [
    ['suffix.example.json', 'https://xiaohongshu.com.evil.example/publish'],
    ['http.json', 'http://creator.xiaohongshu.com/publish'],
    ['credentials.json', 'https://user:pass@creator.xiaohongshu.com/publish'],
    ['private-ip.json', 'https://127.0.0.1/publish']
  ];
  for (const [name, url] of variants) {
    const pack = clone();
    pack.urls.publish = url;
    loadFallback(writeJSON(dir, name, pack));
  }
}));

test('非法 api_paths（.. 或绝对地址）安全回落', () => withTemp((dir) => {
  const dotDot = clone();
  dotDot.api_paths.posted_notes = '/api/galaxy/../note/user/posted';
  loadFallback(writeJSON(dir, 'dotdot.json', dotDot));

  const absolute = clone();
  absolute.api_paths.user_info = 'https://evil.com/api/galaxy/user/info';
  loadFallback(writeJSON(dir, 'absolute.json', absolute));
}));

test('D-222：草稿保存文案混入“立即发布”直接拒绝并回落', () => withTemp((dir) => {
  const pack = clone();
  pack.selectors.draft_save_texts = ['暂存离开', '立即发布'];
  const result = loadFallback(writeJSON(dir, 'publish-word.json', pack));
  assert.match(result.fallbackReason, /发布/, '回落原因必须点名发布词禁令');
}));

test('超过 256 KiB 的超大缓存被拒绝并安全回落', () => withTemp((dir) => {
  const pack = clone();
  pack.padding = 'x'.repeat(300 * 1024);
  const file = writeJSON(dir, 'oversized.json', pack);
  assert.ok(fs.statSync(file).size > 256 * 1024);
  const result = loadFallback(file);
  assert.match(result.fallbackReason, /cache_too_large/);
}));

test('消费端常量与内置规则包逐项对齐，D-222 submit 仍强拒', async () => {
  const rulePack = loadDefaultXhsRulePack();
  const xhs = require('../.build/platforms/xhs.js');
  const publishXhs = require('../.build/publish/xhs.js');
  const { PLATFORM_PUBLISH_URLS } = require('../.build/publish/platform-urls.js');
  const { PLATFORM_LOGIN_URLS } = require('../.build/platform-login.js');
  const { isXhsImageTabText } = require('../.build/publish-page.js');

  assert.equal(xhs.XHS_ADAPTER_VERSION, rulePack.adapter_version);
  assert.equal(xhs.XHS_MAPPING_VERSION, rulePack.mapping_version);
  assert.deepEqual({ ...xhs.XHS_API }, {
    userInfo: rulePack.api_paths.user_info,
    postedNotes: rulePack.api_paths.posted_notes,
    personalInfo: rulePack.api_paths.personal_info
  });
  assert.deepEqual([...xhs.XHS_SHARE_HOSTS], [...rulePack.share_hosts]);

  assert.equal(publishXhs.XHS_ADAPTER_VERSION, 'xhs-fill-v1');
  assert.equal(publishXhs.XHS_ADAPTER_VERSION, rulePack.publish_adapter_version);
  assert.equal(PLATFORM_PUBLISH_URLS.xhs, rulePack.urls.publish);
  assert.equal(PLATFORM_LOGIN_URLS.xhs, rulePack.urls.note_manager);

  assert.equal(isXhsImageTabText(rulePack.selectors.image_tab_texts[0]), true);
  assert.equal(isXhsImageTabText('上传视频'), false);

  // 源码级漂移守卫：publish-page / platform-login 不得把已外置的选择器与文案重新硬编码。
  const publishPageSource = fs.readFileSync(path.join(__dirname, '../src/publish-page.ts'), 'utf8');
  assert.match(publishPageSource, /title: \[\.\.\.rulePack\.selectors\.title\]/);
  assert.match(publishPageSource, /editor: \[\.\.\.rulePack\.selectors\.editor\]/);
  assert.match(publishPageSource, /tag: \[\.\.\.rulePack\.selectors\.tag_input\]/);
  assert.match(publishPageSource, /const draftSaveTexts = getXhsRulePack\(\)\.selectors\.draft_save_texts;/);
  assert.match(publishPageSource, /const shadowSaveHost = rulePackSelectors\.shadow_save_host;/);
  assert.match(publishPageSource, /const shadowSaveButtonClass = rulePackSelectors\.shadow_save_button_class;/);
  assert.match(publishPageSource, /getXhsRulePack\(\)\.selectors\.tag_chips/);
  assert.doesNotMatch(publishPageSource, /DRAFT_SAVE_TEXTS|XHS_IMAGE_TAB_TEXTS/);
  const loginSource = fs.readFileSync(path.join(__dirname, '../src/platform-login.ts'), 'utf8');
  assert.match(loginSource, /getXhsRulePack\(\)\.selectors\.note_card/);
  assert.match(loginSource, /getXhsRulePack\(\)\.urls\.note_manager/);
  assert.match(loginSource, /getXhsRulePack\(\)\.api_paths\.comment_page/);

  const anchorsSeen = [];
  const page = {
    currentAccountName: async () => 'OPS测试号',
    hasAnchor: async (anchor) => { anchorsSeen.push(anchor); return true; }
  };
  const request = {
    taskId: 'task-rulepack', workspaceId: 'w', accountId: 'a', workId: 'work',
    platform: 'xhs', manifest: { fields: { title: '标题' } }, mode: 'desktop', accountName: 'OPS测试号'
  };
  const adapter = publishXhs.createXhsPublishAdapter(page);
  const evidence = await adapter.preflight(request);
  assert.equal(evidence.adapter_version, rulePack.publish_adapter_version);
  assert.deepEqual(anchorsSeen, [rulePack.anchors.account, ...rulePack.anchors.prefill]);

  await assert.rejects(
    () => adapter.submit({ ...request, explicitSubmitNow: true }),
    (error) => error.code === 'direct_submit_not_supported'
  );
});

test('createXhsPublishAdapter 接受覆盖 RulePack，锚点/版本随覆盖值变化且 submit 仍强拒', async () => {
  const customRaw = clone();
  customRaw.publish_adapter_version = 'xhs-fill-cache-v2';
  customRaw.anchors.account = 'xhs-account-cache';
  customRaw.anchors.prefill = ['xhs-upload-cache'];
  customRaw.urls.publish = 'https://creator.xiaohongshu.com/publish/publish?source=official&rulepack=override';
  const validated = validateXhsRulePack(customRaw);
  assert.equal(validated.ok, true, validated.ok ? '' : validated.reason);

  const anchorsSeen = [];
  const page = {
    currentAccountName: async () => 'OPS测试号',
    hasAnchor: async (anchor) => { anchorsSeen.push(anchor); return true; }
  };
  const adapter = require('../.build/publish/xhs.js').createXhsPublishAdapter(page, undefined, validated.pack);
  assert.equal(adapter.version, 'xhs-fill-cache-v2');
  const request = {
    taskId: 'task-rulepack-override', workspaceId: 'w', accountId: 'a', workId: 'work',
    platform: 'xhs', manifest: { fields: { title: '标题' } }, mode: 'desktop', accountName: 'OPS测试号'
  };
  const evidence = await adapter.preflight(request);
  assert.equal(evidence.adapter_version, 'xhs-fill-cache-v2');
  assert.deepEqual(anchorsSeen, ['xhs-account-cache', 'xhs-upload-cache']);

  await assert.rejects(
    () => adapter.submit({ ...request, explicitSubmitNow: true }),
    (error) => error.code === 'direct_submit_not_supported'
  );
});

test('本机热更新缓存真实生效：重新加载后 URL / 版本 / 文案全部来自缓存', async () => {
  const dir = tempDir();
  const custom = clone();
  custom.adapter_version = 'xhs-cache-2';
  custom.mapping_version = 2;
  custom.urls.note_manager = 'https://creator.xiaohongshu.com/new/note-manager?rulepack=cache';
  custom.urls.publish = 'https://creator.xiaohongshu.com/publish/publish?source=official&rulepack=cache';
  custom.selectors.image_tab_texts = ['上传图文缓存版'];
  const cachePath = writeJSON(dir, 'hot.json', custom);
  assert.equal(validateXhsRulePack(custom).ok, true);

  const savedEnv = process.env.OPS_XHS_RULEPACK_PATH;
  const cachedModules = [
    '../.build/platforms/rules/loader.js',
    '../.build/platforms/xhs.js',
    '../.build/publish/xhs.js',
    '../.build/publish/platform-urls.js',
    '../.build/platform-login.js',
    '../.build/publish-page.js'
  ];
  for (const id of cachedModules) delete require.cache[require.resolve(id)];

  try {
    process.env.OPS_XHS_RULEPACK_PATH = cachePath;
    const loader = require('../.build/platforms/rules/loader.js');
    const xhs = require('../.build/platforms/xhs.js');
    const { PLATFORM_PUBLISH_URLS } = require('../.build/publish/platform-urls.js');
    const { PLATFORM_LOGIN_URLS } = require('../.build/platform-login.js');
    const { isXhsImageTabText } = require('../.build/publish-page.js');
    const { createXhsPublishAdapter } = require('../.build/publish/xhs.js');

    assert.equal(loader.getXhsRulePack().adapter_version, 'xhs-cache-2');
    assert.equal(xhs.XHS_ADAPTER_VERSION, 'xhs-cache-2');
    assert.equal(xhs.XHS_MAPPING_VERSION, 2);
    assert.equal(PLATFORM_PUBLISH_URLS.xhs, custom.urls.publish);
    assert.equal(PLATFORM_LOGIN_URLS.xhs, custom.urls.note_manager);
    assert.equal(isXhsImageTabText('上传图文缓存版'), true);
    assert.equal(
      createXhsPublishAdapter({ currentAccountName: async () => '', hasAnchor: async () => true }).version,
      'xhs-fill-v1'
    );

    loader.resetXhsRulePackCache();
    assert.equal(loader.getXhsRulePack().urls.publish, custom.urls.publish);
  } finally {
    if (savedEnv === undefined) delete process.env.OPS_XHS_RULEPACK_PATH;
    else process.env.OPS_XHS_RULEPACK_PATH = savedEnv;
    for (const id of cachedModules) delete require.cache[require.resolve(id)];
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
