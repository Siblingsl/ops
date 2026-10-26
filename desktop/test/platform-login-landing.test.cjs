// 登录落点判定与 URL 稳定等待（会话失效 401 跳转）的回归测试。
//
// 这两段逻辑此前完全没有测试：`desktop/test/*.cjs` 里 grep `waitForStableURL`、
// `redirectReason`、`isLoggedInLanding` 都是零命中。它们的作用是**把"会话失效"
// 从"已登录"里区分出来**——判错的表现是连接显示 availability=ready、
// failure_count=0，用户看不到"需要重新扫码"，也不会有失效通知。
//
// 两个函数都没有导出（`isLoggedInLanding` 在 main.ts 里是模块内私有函数），
// 因此这里用 TypeScript 编译器把源码里的函数原样转译后求值：测的是真实实现，
// 不是文本匹配，也不是复制一份逻辑。

const assert = require('node:assert/strict');
const test = require('node:test');
const { extractFunction, loadFunction, readSource } = require('./support/source-function.cjs');

// sessionWithHrefs 造一个只回 location.href 的假 CDP 会话。
// hrefs 用完之后一直重复最后一个值。
function sessionWithHrefs(hrefs) {
  let index = 0;
  return {
    platform: 'xhs',
    profileDir: 'C:\\profiles\\xhs',
    browser: { child: {}, send: () => {}, onMessage: () => {}, failure: () => null, close: async () => {} },
    cdp: {
      request: async (method, params) => {
        if (method !== 'Runtime.evaluate' || params?.expression !== 'location.href') return null;
        const value = hrefs[Math.min(index, hrefs.length - 1)];
        index += 1;
        return { result: { type: 'string', value } };
      }
    }
  };
}

test('PS-T39：页面加载完成后由 JS 跳登录页时，等待逻辑必须返回跳转后的 URL', async () => {
  const waitForStableURL = loadFunction('src/platform-login.ts', 'waitForStableURL', ['delay']);
  const manager = 'https://creator.xiaohongshu.com/new/note-manager';
  const login = 'https://creator.xiaohongshu.com/login?redirectReason=401';
  // 前两次采样还是后台首页，第三次才跳登录页（小红书实测形态）。
  const session = sessionWithHrefs([manager, manager, login, login, login, login, login, login, login, login]);
  const landed = await waitForStableURL(session, manager, { maxMs: 1_000, pollMs: 20, quietMs: 200 });
  assert.equal(landed, login, '跳转后的 URL 才是真实落点，不能沿用导航目标');
});

test('PS-T39：URL 一直不变时按安静窗口返回，且不会等满上限', async () => {
  const waitForStableURL = loadFunction('src/platform-login.ts', 'waitForStableURL', ['delay']);
  const manager = 'https://creator.xiaohongshu.com/new/note-manager';
  const startedAt = Date.now();
  const landed = await waitForStableURL(sessionWithHrefs([manager]), manager, { maxMs: 2_000, pollMs: 20, quietMs: 100 });
  const elapsed = Date.now() - startedAt;
  assert.equal(landed, manager);
  assert.ok(elapsed < 1_000, `正常页面不该等满上限，实际等了 ${elapsed}ms`);
});

test('PS-T39：读不到 URL 时回退到导航目标，不抛错', async () => {
  const waitForStableURL = loadFunction('src/platform-login.ts', 'waitForStableURL', ['delay']);
  const manager = 'https://creator.xiaohongshu.com/new/note-manager';
  const broken = {
    platform: 'xhs',
    profileDir: 'C:\\profiles\\xhs',
    browser: { child: {}, send: () => {}, onMessage: () => {}, failure: () => null, close: async () => {} },
    cdp: { request: async () => null }
  };
  const landed = await waitForStableURL(broken, manager, { maxMs: 150, pollMs: 20, quietMs: 50 });
  assert.equal(landed, manager);
});

test('PS-T40：落点判定必须把两个平台的登录页判成未登录', () => {
  const isLoggedInLanding = loadFunction('src/main.ts', 'isLoggedInLanding');
  // 小红书：/login 及其子路径都是未登录。
  assert.equal(isLoggedInLanding('xhs', 'https://creator.xiaohongshu.com/new/note-manager'), true);
  assert.equal(isLoggedInLanding('xhs', 'https://creator.xiaohongshu.com/login'), false);
  assert.equal(isLoggedInLanding('xhs', 'https://creator.xiaohongshu.com/login?redirectReason=401'), false);
  assert.equal(isLoggedInLanding('xhs', 'https://creator.xiaohongshu.com/login/xxx'), false);
  // 别的域名即使路径像后台也不算已登录。
  assert.equal(isLoggedInLanding('xhs', 'https://evil.example.com/new/note-manager'), false);
  // 公众号：扫码页与 loginpage 都是未登录。
  assert.equal(isLoggedInLanding('wechat_mp', 'https://mp.weixin.qq.com/'), true);
  assert.equal(isLoggedInLanding('wechat_mp', 'https://mp.weixin.qq.com/cgi-bin/loginpage?t=wxm2-login'), false);
  assert.equal(isLoggedInLanding('wechat_mp', 'https://mp.weixin.qq.com/cgi-bin/home?action=scanlogin'), false);
  assert.equal(isLoggedInLanding('wechat_mp', 'https://evil.example.com/'), false);
  // 解析不了的地址一律按未登录处理（宁可让用户重新扫码，也不能假装在线）。
  assert.equal(isLoggedInLanding('xhs', 'not a url'), false);
  assert.equal(isLoggedInLanding('wechat_mp', ''), false);
});

test('PS-T40：登录落点判定只按域名与路径，不做内容嗅探', () => {
  const source = readSource('src/main.ts');
  const body = extractFunction(source, 'isLoggedInLanding');
  for (const forbidden of ['document.cookie', 'fetch(', 'innerText', 'querySelector', 'localStorage']) {
    assert.ok(!body.includes(forbidden), `落点判定不应包含 ${forbidden}`);
  }
  // 两处调用点（v1 采集与 v2 采集）都必须用它拦住失效会话。
  const calls = source.match(/if \(!isLoggedInLanding\(platform, page\.url\)\)/g) ?? [];
  assert.equal(calls.length, 2, 'v1 与 v2 两条采集路径都要判落点');
});
