const assert = require('node:assert/strict');
const test = require('node:test');
const { probeXhsLoginIdentity, probeWechatLoginIdentity } = require('../.build/platform-login-runtime');

const identityBody = JSON.stringify({ data: { userId: 'fixture-account', redId: 'fixture-red-id' } });
const listResponse = { success: true, data: { notes: [{ id: '6f0000000000000000000001' }], page: -1 } };
const wechatIdentityPayload = { biz_list: { list: [{ bizuin: 'fixture-bizuin', username: 'gh_fixture001' }] } };
const wechatListBody = JSON.stringify({ base_resp: { ret: 0 }, publish_page: JSON.stringify({ publish_list: [] }) });
const wechatLoginRequiredBody = JSON.stringify({ base_resp: { ret: 200040 }, publish_page: '' });

function wechatSessionFor(listBody = wechatListBody) {
  const calls = [];
  return {
    calls,
    session: {
      platform: 'wechat_mp', profileDir: 'C:\\profiles\\wechat\\fixture', browser: {},
      cdp: {
        request: async (method, params) => {
          calls.push({ method, params });
          if (method === 'Runtime.evaluate') {
            return { result: { type: 'string', value: JSON.stringify({ ok: true, status: 200, body: listBody }) } };
          }
          return {};
        },
        collectResponses: async (path, timeoutMs) => {
          calls.push({ method: 'collectResponses', path, timeoutMs });
          return {};
        }
      }
    }
  };
}

function sessionFor(list = listResponse) {
  const calls = [];
  return {
    calls,
    session: {
      platform: 'xhs', profileDir: 'C:\\profiles\\xhs\\fixture', browser: {},
      cdp: {
        request: async (method, params) => {
          calls.push({ method, params });
          if (method === 'Runtime.evaluate') {
            return { result: { type: 'string', value: JSON.stringify({ ok: true, status: 200, body: identityBody }) } };
          }
          return {};
        },
        collectResponses: async (path, timeoutMs) => {
          calls.push({ method: 'collectResponses', path, timeoutMs });
          return list;
        }
      }
    }
  };
}

test('重新核验时先匹配原平台身份，再只读验证一页作品列表能力', async () => {
  const { calls, session } = sessionFor();
  const identity = await probeXhsLoginIdentity(session, 'xhs_user_id:fixture-account', 'Chrome/fixture', '2026-10-22T00:00:00.000Z');
  assert.equal(identity.externalAccountKey, 'xhs_user_id:fixture-account');
  assert.equal(identity.capabilities.workList, 'supported');
  assert.equal(calls.filter((call) => call.method === 'collectResponses').length, 1);
  assert.equal(calls.find((call) => call.method === 'collectResponses').path, '/api/galaxy/v2/creator/note/user/posted');
  assert.deepEqual(calls.filter((call) => call.method === 'Page.navigate').map((call) => call.params.url), [
    'about:blank',
    'https://creator.xiaohongshu.com/new/note-manager'
  ]);
});

test('身份与原连接不匹配或列表结构未通过时不提升作品列表能力', async () => {
  const wrongIdentity = sessionFor();
  const mismatch = await probeXhsLoginIdentity(wrongIdentity.session, 'xhs_user_id:another-account', 'Chrome/fixture', '2026-10-22T00:00:00.000Z');
  assert.equal(mismatch.capabilities.workList, 'unknown');
  assert.equal(wrongIdentity.calls.some((call) => call.method === 'collectResponses'), false);

  const malformedList = sessionFor({ success: true, data: {} });
  const unverified = await probeXhsLoginIdentity(malformedList.session, 'xhs_user_id:fixture-account', 'Chrome/fixture', '2026-10-22T00:00:00.000Z');
  assert.equal(unverified.capabilities.workList, 'unknown');
});

test('公众号登录核验实测发表列表可读后才提升目录与指标能力', async () => {
  const { calls, session } = wechatSessionFor();
  const identity = await probeWechatLoginIdentity(session, wechatIdentityPayload, undefined, 'Chrome/fixture', '2026-10-24T00:00:00.000Z');
  assert.equal(identity.externalAccountKey, 'wechat_biz:fixture-bizuin');
  assert.equal(identity.capabilities.publishedList, 'supported');
  assert.equal(identity.capabilities.perArticleMetrics, 'supported');
  assert.equal(identity.capabilities.browserVersion, 'Chrome/fixture');
  const listCall = calls.find((call) => call.method === 'Runtime.evaluate');
  assert.ok(listCall);
  assert.ok(String(listCall.params.expression).includes('/cgi-bin/appmsgpublish'));
});

test('公众号发表列表不可读或结构未通过时能力不得标为 supported', async () => {
  const loginRequired = wechatSessionFor(wechatLoginRequiredBody);
  const blocked = await probeWechatLoginIdentity(loginRequired.session, wechatIdentityPayload, undefined, 'Chrome/fixture', '2026-10-24T00:00:00.000Z');
  assert.equal(blocked.capabilities.publishedList, 'temporarily_unavailable');
  assert.equal(blocked.capabilities.perArticleMetrics, 'temporarily_unavailable');

  const malformed = wechatSessionFor(JSON.stringify({ base_resp: { ret: 0 }, publish_page: '{not-json' }));
  const unverified = await probeWechatLoginIdentity(malformed.session, wechatIdentityPayload, undefined, 'Chrome/fixture', '2026-10-24T00:00:00.000Z');
  assert.equal(unverified.capabilities.publishedList, 'temporarily_unavailable');
});
