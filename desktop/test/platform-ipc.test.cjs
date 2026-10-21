const assert = require('node:assert/strict');
const test = require('node:test');

const {
  PLATFORM_IPC_COMMANDS,
  PLATFORM_IPC_MAX_BYTES,
  PLATFORM_IPC_TIMEOUT_MS,
  PLATFORM_IPC_VERSION,
  PlatformIPCErrorException,
  PlatformIPCSingleFlight,
  parseEnvelope,
  toIPCError,
  validatePayloadShape,
  withTimeout
} = require('../.build/platform-ipc.js');

const accountId = '33333333-3333-4333-8333-333333333333';

test('信封校验：版本、标识、命令白名单任一不符都拒绝', () => {
  const good = { v: PLATFORM_IPC_VERSION, id: 'req_1', cmd: 'read-status' };
  assert.equal(parseEnvelope(good).cmd, 'read-status');

  const cases = [
    [null, 'ipc_invalid'],
    ['string', 'ipc_invalid'],
    [{ ...good, v: 2 }, 'ipc_version_mismatch'],
    [{ ...good, v: undefined }, 'ipc_version_mismatch'],
    [{ ...good, id: '' }, 'ipc_invalid'],
    [{ ...good, id: 'has space' }, 'ipc_invalid'],
    [{ ...good, id: 'x'.repeat(65) }, 'ipc_invalid'],
    [{ ...good, cmd: 'open-anything' }, 'ipc_unknown_command'],
    [{ ...good, cmd: 'eval-script' }, 'ipc_unknown_command']
  ];
  for (const [input, code] of cases) {
    assert.throws(() => parseEnvelope(input), (err) => err instanceof PlatformIPCErrorException && err.code === code,
      JSON.stringify(input));
  }
});

test('信封体积超过 64 KiB 直接拒绝', () => {
  const big = { v: PLATFORM_IPC_VERSION, id: 'req_big', cmd: 'read-status', payload: { pad: 'x'.repeat(PLATFORM_IPC_MAX_BYTES) } };
  assert.throws(() => parseEnvelope(big), (err) => err.code === 'ipc_too_large');
});

test('命令白名单是固定集合，不随页面输入扩展', () => {
  assert.deepEqual([...PLATFORM_IPC_COMMANDS].sort(), [
    'clear-account-data', 'open-login', 'pause', 'read-status', 'request-collect'
  ]);
});

test('参数形状逐命令校验，拒绝额外字段', () => {
  // open-login 现在必须同时带 accountId 与 platform：平台决定 profile 命名空间与允许的登录页。
  assert.doesNotThrow(() => validatePayloadShape('open-login', { accountId, platform: 'xhs' }));
  assert.doesNotThrow(() => validatePayloadShape('open-login', { accountId, platform: 'wechat_mp' }));
  assert.throws(() => validatePayloadShape('open-login', { accountId, platform: 'xhs', script: 'x' }), /登录参数无效/);
  assert.throws(() => validatePayloadShape('open-login', { accountId, platform: 'xhs', url: 'https://evil.example.com' }), /登录参数无效/);
  assert.throws(() => validatePayloadShape('open-login', { accountId: '../../etc', platform: 'xhs' }), /登录参数无效/);
  assert.throws(() => validatePayloadShape('open-login', {}), /登录参数无效/);
  // 缺平台或平台不在首版支持范围内都拒绝，不能默认成小红书。
  assert.throws(() => validatePayloadShape('open-login', { accountId }), /登录参数无效/);
  assert.throws(() => validatePayloadShape('open-login', { accountId, platform: 'toutiao' }), (err) => err.code === 'platform_not_supported');
  assert.throws(() => validatePayloadShape('open-login', { accountId, platform: 'xhs\n' }), (err) => err.code === 'platform_not_supported');
  assert.doesNotThrow(() => validatePayloadShape('read-status', undefined));
  assert.throws(() => validatePayloadShape('read-status', 'all'), /状态查询参数无效/);
  assert.doesNotThrow(() => validatePayloadShape('request-collect', { accountId }));
  assert.throws(() => validatePayloadShape('request-collect', { accountId: 1 }), /采集参数无效/);
  assert.doesNotThrow(() => validatePayloadShape('clear-account-data', { accountId }));
});

test('同一命令单飞：并发第二次直接 ipc_busy', () => {
  const single = new PlatformIPCSingleFlight();
  single.begin('read-status');
  assert.equal(single.isBusy('read-status'), true);
  assert.throws(() => single.begin('read-status'), (err) => err.code === 'ipc_busy');
  // 其它命令不受影响。
  assert.doesNotThrow(() => single.begin('pause'));
  single.end('read-status');
  assert.equal(single.isBusy('read-status'), false);
  assert.doesNotThrow(() => single.begin('read-status'));
});

test('超时给出稳定错误码，正常完成的命令不超时', async () => {
  assert.equal(await withTimeout(Promise.resolve('ok'), 50), 'ok');
  await assert.rejects(() => withTimeout(new Promise(() => {}), 20), (err) => err.code === 'ipc_timeout');
  assert.equal(PLATFORM_IPC_TIMEOUT_MS, 5000);
});

test('错误结构只含稳定错误码与安全文案，不泄露路径或堆栈', () => {
  const known = toIPCError(new PlatformIPCErrorException('platform_profile_busy', '该会话正在被使用'));
  assert.deepEqual(known, { code: 'platform_profile_busy', message: '该会话正在被使用' });

  const withCode = toIPCError(Object.assign(new Error('boom at C:\\secret\\path'), { code: 'platform_login_required' }));
  assert.equal(withCode.code, 'platform_login_required');
  assert.ok(!withCode.message.includes('secret'));

  const unknown = toIPCError(new Error('failed at C:\\secret\\path'));
  assert.deepEqual(unknown, { code: 'ipc_failed', message: '本机操作失败，请稍后重试' });

  const arbitraryCode = toIPCError(Object.assign(new Error('x'), { code: 'EACCES' }));
  assert.equal(arbitraryCode.code, 'ipc_failed');
});
