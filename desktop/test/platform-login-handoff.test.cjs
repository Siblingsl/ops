const assert = require('node:assert/strict');
const test = require('node:test');

const { buildPlatformLoginHandoffHtml, HANDOFF_COMPLETE_TITLE } = require('../.build/platform-login-handoff-page.js');
const { probeLoginChallenge, waitForLogin, XHS_IDENTITY_SCRIPT } = require('../.build/platform-login.js');
const { CHALLENGE_PROBE_SCRIPT } = require('../.build/platforms/challenge-detect.js');

function fakeSession(identityForAttempt) {
  return {
    platform: 'xhs',
    profileDir: '',
    browser: null,
    cdp: {
      request: async (_method, params) => {
        if (params.expression === CHALLENGE_PROBE_SCRIPT) {
          return {
            result: {
              value: {
                url: 'https://creator.xiaohongshu.com/new/note-manager',
                title: 'Just a moment',
                text: 'Verify you are human',
                textLength: 20,
                frameUrls: [],
                scriptSrcs: [],
                selectors: [],
                visibleSelectors: ['.cf-turnstile']
              }
            }
          };
        }
        if (params.expression === XHS_IDENTITY_SCRIPT) {
          identityForAttempt();
          return { result: { value: JSON.stringify({ ok: false, status: 401, body: '' }) } };
        }
        return { result: { value: null } };
      }
    }
  };
}

test('B-01.6 原生提示页：点击哨兵、来源展示、输入转义', () => {
  const html = buildPlatformLoginHandoffHtml({
    platform: '小红书',
    vendor: 'cloudflare',
    kind: 'interactive',
    message: '请完成验证码后点击下方按钮',
    origin: 'https://creator.xiaohongshu.com'
  });
  assert.match(html, /id="done"/);
  assert.match(html, new RegExp(HANDOFF_COMPLETE_TITLE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(html, /https:\/\/creator\.xiaohongshu\.com/);
  assert.match(html, /以平台页面真实登录状态为准/);
});

test('B-01.6 原生提示页：消息里的 HTML/引号被转义，不产生页面注入', () => {
  const html = buildPlatformLoginHandoffHtml({
    platform: 'xhs<script>alert(1)</script>',
    vendor: '"><img src=x onerror=alert(2)>',
    kind: 'interactive',
    message: '<script>alert(3)</script>',
    origin: 'https://x.test/?a="b"'
  });
  assert.doesNotMatch(html, /xhs<script>/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<script>alert\(3\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert\(3\)&lt;\/script&gt;/);
});

test('B-01.6 probeLoginChallenge 命中真实探针结构并分类', async () => {
  const session = fakeSession(() => undefined);
  const outcome = await probeLoginChallenge(session);
  assert.equal(outcome.vendor, 'cloudflare');
  assert.equal(outcome.kind, 'interactive');
  assert.equal(outcome.recommendation, 'handoff');
});

test('B-01.6 waitForLogin 命中风控时只弹一次提示，且仍以页面身份为成功判据', async () => {
  let identityCalls = 0;
  const prompts = [];
  const session = fakeSession(() => {
    identityCalls += 1;
  });
  // 前 3 次身份未登录，第 4 次仍未登录；把身份判定改成成功需要替换返回体。
  const originalRequest = session.cdp.request;
  session.cdp.request = async (method, params) => {
    if (params.expression === XHS_IDENTITY_SCRIPT && identityCalls >= 4) {
      identityCalls += 1;
      return {
        result: {
          value: JSON.stringify({
            ok: true,
            status: 200,
            body: JSON.stringify({ data: { user: { user_id: 'u1' } } })
          })
        }
      };
    }
    return originalRequest(method, params);
  };
  const outcome = await waitForLogin(session, {
    pollMs: 1,
    timeoutMs: 2_000,
    onChallenge: (challenge) => prompts.push(`${challenge.vendor}:${challenge.kind}`)
  });
  assert.equal(outcome.loggedIn, true);
  assert.equal(outcome.timedOut, false);
  assert.equal(prompts.length, 1, '同一风控只提示一次');
  assert.deepEqual(prompts, ['cloudflare:interactive']);
});
