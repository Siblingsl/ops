const assert = require('node:assert/strict');
const test = require('node:test');
const { isAllowedLoginNavigation } = require('../.build/platform-login-policy');

test('公众号扫码只允许已观察到的官方认证路由', () => {
  assert.equal(isAllowedLoginNavigation('https://open.weixin.qq.com/cgi-bin/mpqrconnect?appid=official', 'wechat_mp'), true);
  assert.equal(isAllowedLoginNavigation('https://open.weixin.qq.com/connect/qrconnect?appid=official', 'wechat_mp'), true);
  assert.equal(isAllowedLoginNavigation('https://open.weixin.qq.com/connect/qrconnect/other', 'wechat_mp'), false);
  assert.equal(isAllowedLoginNavigation('https://open.weixin.qq.com/connect/authorize', 'wechat_mp'), false);
  assert.equal(isAllowedLoginNavigation('https://user@open.weixin.qq.com/connect/qrconnect', 'wechat_mp'), false);
  assert.equal(isAllowedLoginNavigation('https://open.weixin.qq.com/connect/qrconnect', 'xhs'), false);
});
