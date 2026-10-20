const assert = require('node:assert/strict');
const test = require('node:test');

const {
  assertRedirectAllowed,
  assertSafeLaunchArgs,
  buildLaunchArgs,
  checkBrowserVersion,
  chromeMajorVersion,
  encodeCDPMessage,
  isAllowedPlatformUrl,
  isPrivateHost,
  parseCDPFrame,
  pickExistingChrome,
  standardChromePaths,
  PlatformBrowserError
} = require('../.build/platform-worker.js');

test('启动参数只用固定 profile、pipe 调试与显式沙箱', () => {
  const args = buildLaunchArgs({ profileDir: 'C:\\profiles\\x' });
  assert.ok(args.includes('--user-data-dir=C:\\profiles\\x'));
  assert.ok(args.includes('--remote-debugging-pipe'));
  // 绝不开放调试端口，也不关沙箱或证书校验。
  for (const forbidden of ['--no-sandbox', '--disable-web-security', '--ignore-certificate-errors']) {
    assert.ok(!args.some((a) => a.startsWith(forbidden)), `参数不应包含 ${forbidden}`);
  }
  assert.ok(!args.some((a) => a.startsWith('--remote-debugging-port')));
  assert.doesNotThrow(() => assertSafeLaunchArgs(args));
});

test('危险或多余的调试参数在启动前被拒绝', () => {
  for (const bad of [
    ['--remote-debugging-port=9222'],
    ['--remote-debugging-pipe', '--remote-debugging-port=0'],
    ['--no-sandbox'],
    ['--disable-web-security'],
    ['--ignore-certificate-errors'],
    ['--remote-debugging-pipex']
  ]) {
    assert.throws(() => assertSafeLaunchArgs(bad), PlatformBrowserError, bad.join(' '));
  }
});

test('浏览器发现只认标准 Chrome 路径，缺失时明确报错', async () => {
  const paths = standardChromePaths({ ProgramFiles: 'C:\\PF', 'ProgramFiles(x86)': 'C:\\PF86', LOCALAPPDATA: 'C:\\LA' });
  assert.equal(paths.length, 3);
  assert.ok(paths.every((p) => p.includes('Google') && p.toLowerCase().endsWith('chrome.exe')));
  assert.ok(!paths.some((p) => /edge|chromium/i.test(p)));
  // 文件不存在时不能退回别的浏览器。
  await assert.rejects(
    () => pickExistingChrome([{ executablePath: 'C:\\nope\\chrome.exe', source: 'standard' }]),
    (err) => err instanceof PlatformBrowserError && err.code === 'platform_browser_unsupported'
  );
});

test('版本判定：默认宽范围不拒绝，只有显式给范围才拦', () => {
  assert.equal(chromeMajorVersion('155.0.8059.80'), 155);
  assert.equal(chromeMajorVersion('nonsense'), null);
  assert.equal(checkBrowserVersion('155.0.8059.80').ok, true);
  assert.equal(checkBrowserVersion('120.0.0.1', { min: 150 }).ok, false);
  assert.equal(checkBrowserVersion('200.0.0.1', { max: 160 }).ok, false);
  assert.equal(checkBrowserVersion('155.0.0.1', { min: 150, max: 160 }).ok, true);
  assert.equal(checkBrowserVersion('not-a-version').ok, false);
});

test('只允许官方后台域名，拒绝 file/ftp/私网/带凭据的地址', () => {
  assert.equal(isAllowedPlatformUrl('https://creator.xiaohongshu.com/publish', 'xhs'), true);
  assert.equal(isAllowedPlatformUrl('https://mp.weixin.qq.com/cgi-bin/home', 'wechat_mp'), true);
  assert.equal(isAllowedPlatformUrl('https://evil.example.com/', 'xhs'), false);
  assert.equal(isAllowedPlatformUrl('http://creator.xiaohongshu.com/', 'xhs'), false);
  assert.equal(isAllowedPlatformUrl('file:///C:/secret', 'xhs'), false);
  assert.equal(isAllowedPlatformUrl('ftp://creator.xiaohongshu.com/', 'xhs'), false);
  assert.equal(isAllowedPlatformUrl('https://user:pass@creator.xiaohongshu.com/', 'xhs'), false);
  assert.equal(isAllowedPlatformUrl('https://creator.xiaohongshu.com/', 'toutiao'), false);

  for (const host of ['127.0.0.1', '10.0.0.1', '172.16.5.4', '192.168.1.2', '169.254.169.254',
    'localhost', '100.64.0.1', '::1', 'fd00::1', 'fe80::1']) {
    assert.equal(isPrivateHost(host), true, host);
  }
  for (const host of ['creator.xiaohongshu.com', '8.8.8.8', '1.1.1.1']) {
    assert.equal(isPrivateHost(host), false, host);
  }
});

test('重定向最多 3 次且每一跳仍须在允许表内', () => {
  const ok = ['https://creator.xiaohongshu.com/a', 'https://creator.xiaohongshu.com/b'];
  assert.doesNotThrow(() => assertRedirectAllowed(ok, 'xhs'));
  assert.throws(() => assertRedirectAllowed([...ok, ...ok, 'https://creator.xiaohongshu.com/c'], 'xhs'), /重定向次数/);
  assert.throws(() => assertRedirectAllowed(['https://evil.example.com/'], 'xhs'), /不在允许的官方域名/);
  assert.throws(() => assertRedirectAllowed(['http://127.0.0.1/'], 'xhs'), /不在允许的官方域名/);
});

test('CDP pipe 帧编解码可往返，残缺帧不返回', () => {
  const encoded = encodeCDPMessage({ id: 1, method: 'Page.navigate', params: { url: 'about:blank' } });
  assert.equal(encoded[0], 0);
  const frame = parseCDPFrame(encoded);
  assert.ok(frame);
  assert.deepEqual(frame.message, { id: 1, method: 'Page.navigate', params: { url: 'about:blank' } });
  assert.equal(frame.rest.length, 0);

  // 两个帧连在一起时按序取出。
  const two = Buffer.concat([encodeCDPMessage({ a: 1 }), encodeCDPMessage({ b: 2 })]);
  const first = parseCDPFrame(two);
  assert.deepEqual(first.message, { a: 1 });
  const second = parseCDPFrame(first.rest);
  assert.deepEqual(second.message, { b: 2 });

  // 帧头不完整或长度不足时返回 null，由调用方继续等待。
  assert.equal(parseCDPFrame(Buffer.from([0, 0x31])), null);
  assert.equal(parseCDPFrame(Buffer.from([0])), null);
  assert.equal(parseCDPFrame(Buffer.alloc(0)), null);
});
