const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildChallengeProbe,
  classifyChallenge,
  challengeErrorCode,
  ensureNoChallenge,
  waitForChallengeClear,
  ChallengeStopError,
  CHALLENGE_PROBE_SCRIPT,
  CHALLENGE_SIGNAL_MAX,
  PROBE_SELECTORS
} = require('../.build/platforms/challenge-detect.js');

// B-03 fixture：8 家厂商的公开可见特征（HTML 文案/选择器/iframe/script），不抓取真实页面。
// 每个 fixture 只声明「页面能看到什么」，分类结论由纯函数给出。
function probe(overrides = {}) {
  const base = {
    url: 'https://creator.xiaohongshu.com/new/note-manager',
    title: '创作中心',
    text: '笔记管理 数据概览 发布笔记',
    frameUrls: [],
    scriptSrcs: [],
    selectors: [],
    visibleSelectors: []
  };
  return buildChallengeProbe({ ...base, ...overrides });
}

test('B-03.1：探针是固定脚本，只读页面且包含全部登记选择器', () => {
  assert.match(CHALLENGE_PROBE_SCRIPT, /document\.querySelectorAll/);
  assert.match(CHALLENGE_PROBE_SCRIPT, /getBoundingClientRect/);
  assert.match(CHALLENGE_PROBE_SCRIPT, /offsetParent/);
  for (const selector of PROBE_SELECTORS) {
    assert.ok(CHALLENGE_PROBE_SCRIPT.includes(JSON.stringify(selector)), `脚本必须含选择器 ${selector}`);
  }
  // 探针不改 DOM、不发请求、不挂全局。
  for (const forbidden of ['innerHTML', 'appendChild', 'fetch(', 'XMLHttpRequest', 'window.', 'globalThis.']) {
    assert.equal(CHALLENGE_PROBE_SCRIPT.includes(forbidden), false, `探针不得包含 ${forbidden}`);
  }
});

test('B-03.2：Cloudflare 过渡页 non-interactive，Turnstile 可见 interactive，block 页 stop', () => {
  const transition = classifyChallenge(probe({
    title: 'Just a moment...',
    text: 'Checking your browser before accessing the site.',
    selectors: ['#challenge-form'],
    visibleSelectors: ['#challenge-form']
  }));
  assert.equal(transition.vendor, 'cloudflare');
  assert.equal(transition.kind, 'non-interactive');
  assert.equal(transition.recommendation, 'wait');

  const turnstile = classifyChallenge(probe({
    title: 'Just a moment...',
    text: 'Verify you are human by completing the action below.',
    selectors: ['.cf-turnstile'],
    visibleSelectors: ['.cf-turnstile']
  }));
  assert.equal(turnstile.vendor, 'cloudflare');
  assert.equal(turnstile.kind, 'interactive');
  assert.equal(turnstile.status, 'handoff');

  const blocked = classifyChallenge(probe({
    title: 'Attention Required! | Cloudflare',
    text: 'Sorry, you have been blocked. You are unable to access this site.',
    selectors: ['#cf-error-details']
  }));
  assert.equal(blocked.vendor, 'cloudflare');
  assert.equal(blocked.kind, 'block');
  assert.equal(blocked.recommendation, 'stop');
});

test('B-03.2：PerimeterX 的 press & hold 识别为 interactive', () => {
  const result = classifyChallenge(probe({
    text: 'Press & Hold to confirm you are a human (and not a bot).',
    selectors: ['#px-captcha']
  }));
  assert.equal(result.vendor, 'perimeterx');
  assert.equal(result.kind, 'interactive');
});

test('B-03.2：DataDome interstitial 与 captcha-delivery 分开判定', () => {
  const interstitial = classifyChallenge(probe({
    url: 'https://creator.xiaohongshu.com/interstitial/?redirect=notes',
    title: '请稍候',
    text: '正在验证您的浏览器…'
  }));
  assert.equal(interstitial.vendor, 'datadome');
  assert.equal(interstitial.kind, 'non-interactive');

  const captcha = classifyChallenge(probe({
    title: '确认您是真人',
    text: '请完成以下验证',
    frameUrls: ['https://geo.captcha-delivery.com/captcha/?initialCid=abc']
  }));
  assert.equal(captcha.vendor, 'datadome');
  assert.equal(captcha.kind, 'interactive');
});

test('B-03.2：Akamai 拒绝页与验证容器分开判定', () => {
  const denied = classifyChallenge(probe({
    title: 'Access Denied',
    text: 'You don\'t have permission to access this server. Reference #18.abc123'
  }));
  assert.equal(denied.vendor, 'akamai');
  assert.equal(denied.kind, 'block');

  const challenge = classifyChallenge(probe({
    title: '请稍候',
    text: '正在检查您的浏览器',
    selectors: ['#sec-if-cpt-container'],
    visibleSelectors: ['#sec-if-cpt-container']
  }));
  assert.equal(challenge.vendor, 'akamai');
  assert.equal(challenge.kind, 'interactive');
});

test('B-03.2：Imperva 的 _Incapsula_Resource iframe 与 incident id 分开判定', () => {
  const challenge = classifyChallenge(probe({
    text: '正在验证请求',
    frameUrls: ['https://www.example.com/_Incapsula_Resource?CWUDNSAI=23']
  }));
  assert.equal(challenge.vendor, 'imperva');
  assert.equal(challenge.kind, 'interactive');

  const blocked = classifyChallenge(probe({
    text: 'Incapsula incident ID: 1234-5678'
  }));
  assert.equal(blocked.vendor, 'imperva');
  assert.equal(blocked.kind, 'block');
});

test('B-03.2：AWS WAF 验证控件与脚本过渡页分开判定', () => {
  const captcha = classifyChallenge(probe({
    text: '请完成下面的安全检查',
    selectors: ['awswaf-captcha'],
    visibleSelectors: ['awswaf-captcha']
  }));
  assert.equal(captcha.vendor, 'awswaf');
  assert.equal(captcha.kind, 'interactive');

  const transition = classifyChallenge(probe({
    text: '正在加载…',
    scriptSrcs: ['https://xxxxx.awswaf.com/xxxxx/challenge.js']
  }));
  assert.equal(transition.vendor, 'awswaf');
  assert.equal(transition.kind, 'non-interactive');
});

test('B-03.2：hCaptcha / reCAPTCHA 只在短页面墙文案下判 interactive', () => {
  const hcaptcha = classifyChallenge(probe({
    text: 'Please verify you are a human',
    frameUrls: ['https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html']
  }));
  assert.equal(hcaptcha.vendor, 'hcaptcha');
  assert.equal(hcaptcha.kind, 'interactive');

  const recaptcha = classifyChallenge(probe({
    text: 'Our systems have detected unusual traffic from your computer network.',
    frameUrls: ['https://www.google.com/recaptcha/api2/anchor?k=abc']
  }));
  assert.equal(recaptcha.vendor, 'recaptcha');
  assert.equal(recaptcha.kind, 'interactive');
});

test('B-03.3：短页面 <1500 才用通用文案；长文里的 unusual traffic/captcha 不误判', () => {
  const longArticle = probe({
    title: '如何应对网站风控',
    textLength: 3000,
    text: '本文讨论 unusual traffic 与 captcha 的关系，并给出运营建议。'.repeat(80)
  });
  const outcome = classifyChallenge(longArticle);
  assert.equal(outcome.kind, 'none');
  assert.equal(outcome.vendor, 'none');

  const shortWall = probe({
    title: '安全验证',
    text: 'Our systems have detected unusual traffic from your computer network.'
  });
  assert.equal(classifyChallenge(shortWall).kind, 'interactive');

  const normal = probe();
  assert.equal(classifyChallenge(normal).kind, 'none');
});

test('B-03.3：输出含 vendor/kind/signal/waitedMs/recommendation，signal 截断 160', () => {
  const outcome = classifyChallenge(probe({
    title: 'Just a moment...',
    text: 'x'.repeat(2000),
    selectors: ['#challenge-form']
  }));
  assert.ok(outcome.signal.length <= CHALLENGE_SIGNAL_MAX);
  assert.equal(outcome.signal, 'cloudflare transition page');
  assert.equal(outcome.waitedMs, 0);
  assert.equal(outcome.url, 'https://creator.xiaohongshu.com/new/note-manager');
});

test('B-03.4：block 错误码 platform_blocked；interactive/non-interactive 为 platform_challenge_required', () => {
  const block = classifyChallenge(probe({
    title: 'Access Denied',
    text: 'Reference #18.abc'
  }));
  assert.equal(challengeErrorCode(block), 'platform_blocked');
  const interactive = classifyChallenge(probe({ selectors: ['#px-captcha'], text: 'press & hold' }));
  assert.equal(challengeErrorCode(interactive), 'platform_challenge_required');
  assert.equal(challengeErrorCode(classifyChallenge(probe())), null);
});

test('B-03.5：ensureNoChallenge 无探针放行；过渡页有上限等待；interactive 先交人再复核', async () => {
  // 无探针：不阻断既有平台链路。
  let calls = 0;
  const silent = { probeChallenge: async () => { calls += 1; return null; } };
  assert.equal(await ensureNoChallenge(silent), null);
  assert.equal(calls, 1);

  // 过渡页：第一次命中，第二次消退；waitMs 足够。
  let step = 0;
  const clearing = {
    probeChallenge: async () => (step++ === 0
      ? { title: 'Just a moment...', text: 'checking', selectors: ['#challenge-form'] }
      : { title: '创作中心', text: '笔记管理' })
  };
  const settled = await ensureNoChallenge(clearing, { waitMs: 1000, pollMs: 100, sleep: async () => {} });
  assert.equal(settled.kind, 'none');

  // interactive：requestHandoff 被调用一次，人工完成后复核通过。
  let handoffs = 0;
  let after = false;
  const interactive = {
    probeChallenge: async () => (after
      ? { title: '创作中心', text: '笔记管理' }
      : { text: 'press & hold', selectors: ['#px-captcha'] }),
    requestHandoff: async () => { handoffs += 1; after = true; }
  };
  const done = await ensureNoChallenge(interactive, { waitMs: 1000, pollMs: 100, sleep: async () => {} });
  assert.equal(handoffs, 1);
  assert.equal(done.kind, 'none');

  // interactive 无人接管：抛出 challenge_required，不自动解题。
  await assert.rejects(
    () => ensureNoChallenge({ probeChallenge: async () => ({ text: 'press & hold', selectors: ['#px-captcha'] }) }, { waitMs: 0 }),
    (error) => error instanceof ChallengeStopError && error.code === 'platform_challenge_required'
  );

  // block：立即抛出 platform_blocked。
  await assert.rejects(
    () => ensureNoChallenge({ probeChallenge: async () => ({ title: 'Access Denied', text: 'Reference #18' }) }, { waitMs: 0 }),
    (error) => error instanceof ChallengeStopError && error.code === 'platform_blocked'
  );
});

test('B-03.5：waitForChallengeClear 记录 waitedMs 且不超过上限', async () => {
  let clock = 0;
  const source = {
    probeChallenge: async () => ({ title: 'Just a moment...', text: 'checking', selectors: ['#challenge-form'] })
  };
  const outcome = await waitForChallengeClear(source, {
    waitMs: 300,
    pollMs: 100,
    now: () => clock,
    sleep: async (ms) => { clock += ms; }
  });
  assert.equal(outcome.kind, 'non-interactive');
  assert.ok(outcome.waitedMs <= 300);
});
