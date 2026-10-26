const assert = require('node:assert/strict');
const test = require('node:test');

const {
  assertReadOnlyPath,
  buildReadOnlyFetchScript,
  createPageResponseSource,
  parseRawEnvelope,
  READ_ONLY_PATH_PREFIXES,
  SCROLL_LIST_TO_END_SCRIPT,
  SIGNED_PATH_TRIGGERS
} = require('../.build/platform-login.js');
const { PlatformBrowserError } = require('../.build/platform-worker.js');

function fakeSession(handler) {
  const calls = [];
  return {
    calls,
    session: {
      platform: 'xhs',
      profileDir: 'C:\\profiles\\xhs',
      browser: { child: {}, send: () => {}, onMessage: () => {}, failure: () => null, close: async () => {} },
      cdp: {
        attachToPage: async () => 's',
        detach: async () => {},
        request: async (method, params) => {
          calls.push({ method, params });
          return handler ? handler(method, params) : null;
        },
        close: async () => {}
      }
    }
  };
}

test('只读路径只接受同源相对路径与允许的接口前缀', () => {
  assert.deepEqual([...READ_ONLY_PATH_PREFIXES], ['/api/', '/cgi-bin/']);
  // 适配器常量里的真实路径必须通过。
  for (const ok of [
    '/api/galaxy/user/info',
    '/api/galaxy/v2/creator/note/user/posted?page=0&page_size=20',
    '/cgi-bin/switchacct?action=switch_acct&lang=zh_CN&f=json&ajax=1'
  ]) {
    assert.doesNotThrow(() => assertReadOnlyPath(ok), ok);
  }
  // 绝对地址、协议相对、路径穿越、其它前缀一律拒绝：不能把平台浏览器当通用代理。
  for (const bad of [
    'https://evil.example.com/api/x',
    '//evil.example.com/api/x',
    '/api/../../etc/passwd',
    '/etc/passwd',
    '/api/x\\y',
    '/api/x#frag',
    'api/galaxy/user/info',
    ''
  ]) {
    assert.throws(() => assertReadOnlyPath(bad), PlatformBrowserError, bad);
  }
});

test('生成的取数脚本只做同源 GET，不含写操作与凭据读取', () => {
  const script = buildReadOnlyFetchScript('/api/galaxy/user/info');
  assert.match(script, /method: 'GET'/);
  assert.match(script, /credentials: 'same-origin'/);
  assert.ok(script.includes('"/api/galaxy/user/info"'), '路径必须被 JSON 转义后嵌入');
  for (const forbidden of ['POST', 'PUT', 'PATCH', 'DELETE', 'document.cookie', 'localStorage', 'click(', 'XMLHttpRequest']) {
    assert.ok(!script.includes(forbidden), `脚本不应包含 ${forbidden}`);
  }
  // 路径里的引号必须被转义，不能注入任意代码。
  const injected = buildReadOnlyFetchScript('/api/x?q="+alert(1)+"');
  assert.ok(!injected.includes('"+alert(1)+"'), '路径必须被安全转义');
});

test('响应源把页面返回的 JSON 原文交给适配器，失败时给稳定错误码', async () => {
  // 正常：body 是 JSON 字符串，包装层负责解析。
  const okBody = JSON.stringify({ ok: true, status: 200, body: JSON.stringify({ data: { userId: 'u1' } }) });
  const { calls, session } = fakeSession(() => ({ result: { type: 'string', value: okBody } }));
  const source = createPageResponseSource(session);
  const data = await source.fetchJSON('/api/galaxy/user/info');
  assert.deepEqual(data, { data: { userId: 'u1' } });
  const evaluate = calls.find((c) => c.method === 'Runtime.evaluate');
  assert.equal(evaluate.params.awaitPromise, true);
  assert.equal(evaluate.params.returnByValue, true);

  // 401：映射成 login_required，不当作网络错误。
  const unauthorized = JSON.stringify({ ok: false, status: 401, body: '' });
  const { session: s401 } = fakeSession(() => ({ result: { type: 'string', value: unauthorized } }));
  await assert.rejects(
    () => createPageResponseSource(s401).fetchJSON('/api/galaxy/user/info'),
    (err) => err instanceof PlatformBrowserError && err.code === 'platform_login_required'
  );

  // 500：映射成 network_unavailable。
  const serverError = JSON.stringify({ ok: false, status: 500, body: '' });
  const { session: s500 } = fakeSession(() => ({ result: { type: 'string', value: serverError } }));
  await assert.rejects(
    () => createPageResponseSource(s500).fetchJSON('/api/galaxy/user/info'),
    (err) => err instanceof PlatformBrowserError && err.code === 'platform_network_unavailable'
  );

  // CDP 没回值 / 返回非 JSON：同样给稳定错误码，不能静默返回空。
  const { session: silent } = fakeSession(() => null);
  await assert.rejects(
    () => createPageResponseSource(silent).fetchJSON('/api/galaxy/user/info'),
    (err) => err instanceof PlatformBrowserError && err.code === 'platform_network_unavailable'
  );
});

test('响应包装解析：非 JSON body 与缺字段都返回 null', () => {
  assert.equal(parseRawEnvelope(null), null);
  assert.equal(parseRawEnvelope({}), null);
  // body 不是 JSON：不能当作成功。
  assert.equal(parseRawEnvelope({ result: { value: JSON.stringify({ ok: true, status: 200, body: 'not json' }) } }), null);
  // 缺 ok / body 字段。
  assert.equal(parseRawEnvelope({ result: { value: JSON.stringify({ status: 200, body: '{}' }) } }), null);
  // 正常。
  assert.deepEqual(
    parseRawEnvelope({ result: { value: JSON.stringify({ ok: true, status: 200, body: '{"a":1}' }) } }),
    { ok: true, status: 200, body: { a: 1 } }
  );
});

test('PS-T38：滚动续读先注册监听再滚动，滚到底返回“没有更多”而不是网络错误', async () => {
  // 滚动脚本必须只读：只改 scrollTop，不发请求、不读凭据。
  for (const forbidden of ['fetch(', 'XMLHttpRequest', 'document.cookie', 'localStorage', 'sessionStorage', 'click(', 'POST', 'PUT', 'DELETE']) {
    assert.ok(!SCROLL_LIST_TO_END_SCRIPT.includes(forbidden), `滚动脚本不应包含 ${forbidden}`);
  }
  assert.match(SCROLL_LIST_TO_END_SCRIPT, /scrollTop = target\.scrollHeight/);
  // 只有已现场确认过滚动加载的接口才登记 scroll，其它接口必须交回逐页导航。
  assert.equal(SIGNED_PATH_TRIGGERS['/api/galaxy/v2/creator/note/user/posted'].scroll, true);
  assert.equal(SIGNED_PATH_TRIGGERS['/cgi-bin/switchacct'].scroll, undefined);

  const order = [];
  const responses = [{ success: true, data: { notes: [], page: 2 } }, null, null];
  let index = 0;
  const session = {
    platform: 'xhs',
    profileDir: 'C:\\profiles\\xhs',
    browser: { child: {}, send: () => {}, onMessage: () => {}, failure: () => null, close: async () => {} },
    cdp: {
      request: async (method) => {
        order.push(method);
        return { result: { type: 'object', value: { top: 2018, height: 2018, client: 592 } } };
      },
      collectResponses: async () => {
        order.push('collectResponses');
        return responses[index++];
      }
    }
  };
  const source = createPageResponseSource(session);
  const next = await source.fetchSignedNextPage('/api/galaxy/v2/creator/note/user/posted?page=1&page_size=20');
  assert.deepEqual(next, { success: true, data: { notes: [], page: 2 } });
  assert.deepEqual(order, ['collectResponses', 'Runtime.evaluate'], '监听先于滚动');

  // 滚到底时页面不再发请求：重试一次后按“没有更多”返回 null，不抛网络错误。
  const empty = await source.fetchSignedNextPage('/api/galaxy/v2/creator/note/user/posted?page=2&page_size=20');
  assert.equal(empty, null);

  // 未登记滚动加载的接口不能滚动，交回调用方走逐页导航。
  const before = order.length;
  assert.equal(await source.fetchSignedNextPage('/cgi-bin/switchacct?action=switch_acct'), null);
  assert.equal(order.length, before, '未登记滚动的接口不应触发任何浏览器调用');
});
