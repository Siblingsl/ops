const assert = require('node:assert/strict');
const test = require('node:test');

const {
  assertReadOnlyScript,
  parseEvaluateResponse,
  openLoginPage,
  probeIdentity,
  waitForLogin,
  PLATFORM_IDENTITY_SCRIPTS,
  PLATFORM_LOGIN_URLS,
  PLATFORM_LOGIN_POLL_MS,
  PLATFORM_LOGIN_TIMEOUT_MS,
  XHS_IDENTITY_SCRIPT,
  WECHAT_IDENTITY_SCRIPT
} = require('../.build/platform-login.js');
const { PlatformBrowserError } = require('../.build/platform-worker.js');

// 假 CDP 会话：记录请求，按方法返回预置结果，不启动任何浏览器。
// 必须实现 attachToPage：pipe 得到的是 Browser 级会话，Page/Runtime 域只在 page session 里可用。
function fakeSession(platform, handlers = {}) {
  const calls = [];
  const session = {
    platform,
    profileDir: 'C:\\profiles\\xhs\\probe',
    browser: { child: {}, send: () => {}, onMessage: () => {}, failure: () => null, close: async () => {} },
    cdp: {
      attachToPage: async () => {
        calls.push({ method: 'Target.attachToTarget' });
        return 'session-fixture';
      },
      detach: async () => {},
      request: async (method, params) => {
        calls.push({ method, params });
        const handler = handlers[method];
        if (typeof handler === 'function') return handler(params, calls);
        return {};
      },
      close: async () => {}
    }
  };
  return { calls, session };
}

test('登录页只用内置常量，且都在允许的官方域名内', () => {
  assert.equal(PLATFORM_LOGIN_URLS.xhs, 'https://creator.xiaohongshu.com/new/note-manager');
  assert.equal(PLATFORM_LOGIN_URLS.wechat_mp, 'https://mp.weixin.qq.com/');
  for (const url of Object.values(PLATFORM_LOGIN_URLS)) {
    assert.match(url, /^https:\/\//);
    assert.doesNotMatch(url, /localhost|127\.0\.0\.1|192\.168|10\./);
  }
});

test('登录页不在允许域名内时拒绝导航，不发出 Page.navigate', async () => {
  // 直接把常量改成非法地址（模拟常量被篡改或以后误改），导航必须被拦下。
  const saved = PLATFORM_LOGIN_URLS.xhs;
  try {
    // Object.freeze 的对象无法改，这里改用伪造 session 的 platform 触发未登记分支：
    // 未登记的 platform 在 isAllowedPlatformUrl 里没有允许域名，必须拒绝。
    const { calls, session } = fakeSession('xhs');
    session.platform = 'toutiao';
    await assert.rejects(
      () => openLoginPage(session),
      (err) => err instanceof PlatformBrowserError && err.code === 'platform_network_unavailable'
    );
    assert.equal(calls.length, 0, '被拒绝时不能发出任何 CDP 请求');
  } finally {
    assert.equal(PLATFORM_LOGIN_URLS.xhs, saved);
  }
});

test('只读脚本是固定常量：同源 GET、无写操作、无凭据读取', () => {
  for (const [platform, script] of Object.entries(PLATFORM_IDENTITY_SCRIPTS)) {
    assert.doesNotThrow(() => assertReadOnlyScript(script, platform), platform);
    // 只允许 GET，且必须同源（相对路径）。
    assert.doesNotMatch(script, /method:\s*['"](POST|PUT|PATCH|DELETE)['"]/i, platform);
    assert.match(script, /credentials:\s*'same-origin'/, platform);
    assert.match(script, /fetch\('\/[^']*'/, platform);
    // 绝不读凭据、绝不点击、绝不开长连接。
    for (const forbidden of ['document.cookie', 'localStorage', 'sessionStorage', '.click(', '.submit(', 'XMLHttpRequest', 'WebSocket']) {
      assert.ok(!script.includes(forbidden), `${platform} 不应包含 ${forbidden}`);
    }
    // 不出现绝对 URL：脚本必须相对当前页面，避免被当成通用代理。
    assert.doesNotMatch(script, /fetch\('https?:/, platform);
  }
});

test('脚本被替换或拼接时拒绝执行', () => {
  // 任何与内置常量不一致的内容都不能下发。
  assert.throws(
    () => assertReadOnlyScript(`${XHS_IDENTITY_SCRIPT}; steal()`, 'xhs'),
    (err) => err instanceof PlatformBrowserError && err.code === 'platform_schema_changed'
  );
  assert.throws(
    () => assertReadOnlyScript(WECHAT_IDENTITY_SCRIPT, 'xhs'),
    (err) => err instanceof PlatformBrowserError && err.code === 'platform_schema_changed'
  );
  assert.throws(
    () => assertReadOnlyScript("fetch('/api/galaxy/user/info', { method: 'POST' })", 'xhs'),
    (err) => err instanceof PlatformBrowserError
  );
});

test('求值结果解析：只认字符串形态的成功响应', () => {
  const ok = parseEvaluateResponse({
    result: { type: 'string', value: JSON.stringify({ ok: true, status: 200, body: '{"data":{"userId":"abc"}}' }) }
  });
  assert.equal(ok.loggedIn, true);
  assert.equal(ok.payload, '{"data":{"userId":"abc"}}');

  // 未登录：平台回 200 但业务码非 0。
  const denied = parseEvaluateResponse({
    result: { type: 'string', value: JSON.stringify({ ok: true, status: 200, body: '{"base_resp":{"ret":-1}}' }) }
  });
  assert.equal(denied.loggedIn, false);

  // HTTP 失败、空 body、非 JSON、缺字段都算“还没登录”，不抛异常。
  for (const value of [
    JSON.stringify({ ok: false, status: 401, body: '' }),
    // ok:false 但带了 body 也不能当成功：401 页面同样可能返回 HTML 或错误 JSON。
    JSON.stringify({ ok: false, status: 401, body: '{"data":{"userId":"stale"}}' }),
    JSON.stringify({ ok: true, status: 200, body: '' }),
    JSON.stringify({ ok: true, status: 200, body: '   ' }),
    JSON.stringify({ ok: true, status: 200, body: 'not json' }),
    'not json at all',
    ''
  ]) {
    const result = parseEvaluateResponse({ result: { type: 'string', value } });
    assert.equal(result.loggedIn, false, value);
    assert.equal(result.payload, null, value);
  }
  // 异常/缺字段的 CDP 返回也不能崩。
  assert.equal(parseEvaluateResponse(null).loggedIn, false);
  assert.equal(parseEvaluateResponse({}).loggedIn, false);
  assert.equal(parseEvaluateResponse({ result: { type: 'undefined' } }).loggedIn, false);
});

test('打开登录页必须先连到具体页面再导航', async () => {
  const { calls, session } = fakeSession('xhs', {
    'Runtime.evaluate': (params) => {
      if (params.expression === 'document.readyState') return { result: { value: 'complete' } };
      if (params.expression.startsWith('JSON.stringify({ url')) {
        return { result: { value: JSON.stringify({ url: 'https://creator.xiaohongshu.com/new/note-manager', title: '小红书创作服务平台' }) } };
      }
      return { result: { value: '' } };
    }
  });
  const info = await openLoginPage(session);
  assert.equal(info.title, '小红书创作服务平台');
  const methods = calls.map((c) => c.method);
  // attach 必须发生在任何 Page.* 调用之前：否则会拿到 -32601 'Page.enable' wasn't found。
  assert.equal(methods[0], 'Target.attachToTarget', '必须先 attach 到 page session');
  assert.ok(methods.includes('Page.enable'));
  assert.ok(methods.includes('Page.navigate'));
  assert.ok(
    methods.indexOf('Target.attachToTarget') < methods.indexOf('Page.enable'),
    'attach 必须在 Page.enable 之前'
  );
  const navigate = calls.find((c) => c.method === 'Page.navigate');
  assert.equal(navigate.params.url, PLATFORM_LOGIN_URLS.xhs);
});

test('身份探测在页面内执行固定脚本，未登录时如实返回 false', async () => {
  const loggedInPayload = JSON.stringify({ ok: true, status: 200, body: '{"data":{"userId":"5f1c"}}' });
  const { calls, session } = fakeSession('xhs', {
    'Runtime.evaluate': () => ({ result: { type: 'string', value: loggedInPayload } })
  });
  const probe = await probeIdentity(session);
  assert.equal(probe.loggedIn, true);
  const evaluate = calls.find((c) => c.method === 'Runtime.evaluate');
  // 发送的脚本必须与内置常量逐字一致，且要求 awaitPromise + returnByValue。
  assert.equal(evaluate.params.expression, XHS_IDENTITY_SCRIPT);
  assert.equal(evaluate.params.awaitPromise, true);
  assert.equal(evaluate.params.returnByValue, true);

  const { session: denied } = fakeSession('xhs', {
    'Runtime.evaluate': () => ({ result: { type: 'string', value: JSON.stringify({ ok: false, status: 401, body: '' }) } })
  });
  assert.equal((await probeIdentity(denied)).loggedIn, false);
});

test('等待登录：读到身份立即返回，超时如实标记且不抛异常', async () => {
  // 前两次未登录，第三次成功。
  let attempt = 0;
  const { session } = fakeSession('xhs', {
    'Runtime.evaluate': () => {
      attempt += 1;
      if (attempt < 3) return { result: { type: 'string', value: JSON.stringify({ ok: false, status: 200, body: '' }) } };
      return { result: { type: 'string', value: JSON.stringify({ ok: true, status: 200, body: '{"data":{"userId":"abc"}}' }) } };
    }
  });
  const ticks = [];
  const ok = await waitForLogin(session, { timeoutMs: 5_000, pollMs: 1, onTick: (n) => ticks.push(n) });
  assert.equal(ok.loggedIn, true);
  assert.equal(ok.timedOut, false);
  assert.equal(ok.attempts, 3);
  assert.deepEqual(ticks, [1, 2, 3]);

  // 一直读不到：超时返回，不抛异常。
  const { session: stuck } = fakeSession('xhs', {
    'Runtime.evaluate': () => ({ result: { type: 'string', value: JSON.stringify({ ok: false, status: 200, body: '' }) } })
  });
  const timedOut = await waitForLogin(stuck, { timeoutMs: 50, pollMs: 10 });
  assert.equal(timedOut.loggedIn, false);
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.payload, null);
});

test('轮询参数符合确认的取值：3 分钟、每 3 秒', () => {
  assert.equal(PLATFORM_LOGIN_TIMEOUT_MS, 180_000);
  assert.equal(PLATFORM_LOGIN_POLL_MS, 3_000);
});
