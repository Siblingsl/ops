const assert = require('node:assert/strict');
const test = require('node:test');

const {
  PLATFORM_REGISTER_PURPOSE,
  PlatformCollectionUnsupportedError,
  parsePlatformCollectionCapability,
  resolvePlatformEndpoint
} = require('../.build/platform-capability.js');

const capability = {
  protocol_version: 1,
  enabled: true,
  platforms: ['wechat_mp', 'xhs'],
  purpose: PLATFORM_REGISTER_PURPOSE,
  operations: ['platform.device.register', 'platform.presence'],
  limits: { challenge_per_minute: 60, request_bytes: 65536 }
};

test('旧服务器没有 platform_collection 时明确不支持，而不是调用未知端点', () => {
  for (const payload of [{}, { protocol_version: 1, limits: {} }, null, undefined]) {
    assert.throws(
      () => parsePlatformCollectionCapability(payload, 1),
      (err) => err instanceof PlatformCollectionUnsupportedError
    );
  }
});

test('协议版本不一致时要求升级客户端', () => {
  assert.throws(
    () => parsePlatformCollectionCapability({ platform_collection: { ...capability, protocol_version: 2 } }, 1),
    /协议不兼容/
  );
  assert.throws(
    () => parsePlatformCollectionCapability({ platform_collection: { ...capability, protocol_version: '1' } }, 1),
    /协议版本无效/
  );
});

test('能力段结构不完整时拒绝，不降级成空清单', () => {
  for (const broken of [
    { ...capability, operations: 'platform.presence' },
    { ...capability, operations: [1] },
    { ...capability, platforms: ['xhs', 2] },
    { ...capability, purpose: 'desktop_ai' }
  ]) {
    assert.throws(
      () => parsePlatformCollectionCapability({ platform_collection: broken }, 1),
      (err) => err instanceof PlatformCollectionUnsupportedError
    );
  }
});

test('解析结果为本地固定字段，非数字限额被丢弃', () => {
  const parsed = parsePlatformCollectionCapability({ platform_collection: capability }, 1);
  assert.deepEqual(parsed.operations, ['platform.device.register', 'platform.presence']);
  assert.deepEqual(parsed.limits, { challenge_per_minute: 60, request_bytes: 65536 });
  const noisy = parsePlatformCollectionCapability(
    { platform_collection: { ...capability, limits: { challenge_per_minute: 'sixty', extra: 5 } } },
    1
  );
  assert.deepEqual(noisy.limits, { extra: 5 });
});

test('只发起客户端内置且服务端公布过的操作', () => {
  const parsed = parsePlatformCollectionCapability({ platform_collection: capability }, 1);
  assert.deepEqual(resolvePlatformEndpoint(parsed, 'platform.device.register'), {
    method: 'POST',
    path: '/api/v1/desktop/platform/devices'
  });
  // 服务端公布但客户端未内置：拒绝，避免服务端扩大客户端可发起的请求范围。
  assert.throws(
    () => resolvePlatformEndpoint({ ...parsed, operations: [...parsed.operations, 'platform.admin.reset'] },
      'platform.admin.reset'),
    /本客户端不支持平台操作/
  );
  // 客户端内置但服务端未公布：拒绝。
  assert.throws(() => resolvePlatformEndpoint(parsed, 'platform.run.claim'), /线上服务未开放平台操作/);
  // 路径穿越或任意 URL 不在可选集合内。
  assert.throws(() => resolvePlatformEndpoint(parsed, '../devices'), /本客户端不支持平台操作/);
});
