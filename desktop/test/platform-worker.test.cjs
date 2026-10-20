const assert = require('node:assert/strict');
const test = require('node:test');

const {
  assertRedirectAllowed,
  assertSafeLaunchArgs,
  buildLaunchArgs,
  CDP_MAX_MESSAGE_BYTES,
  checkBrowserVersion,
  chromeMajorVersion,
  createCDPClient,
  discoverPlatformBrowser,
  encodeCDPMessage,
  findPlatformBrowser,
  isAllowedPlatformUrl,
  isPrivateHost,
  parseCDPFrame,
  parseBrowserProduct,
  parseRegistryAppPath,
  pickExistingBrowser,
  playwrightBrowsersDir,
  playwrightChromiumCandidates,
  probePlatformBrowser,
  registryAppPathKeys,
  standardBrowserPaths,
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

test('浏览器发现按固定优先级列出各品牌的正式安装路径', () => {
  const env = { ProgramFiles: 'C:\\PF', 'ProgramFiles(x86)': 'C:\\PF86', LOCALAPPDATA: 'C:\\LA' };
  const chrome = standardBrowserPaths(env, 'chrome');
  assert.ok(chrome.every((p) => p.includes('Google') && p.toLowerCase().endsWith('chrome.exe')));
  const edge = standardBrowserPaths(env, 'edge');
  assert.ok(edge.length > 0 && edge.every((p) => p.toLowerCase().endsWith('msedge.exe')));
  // 64 位系统上 Edge 默认在 Program Files (x86)，必须包含这一处。
  assert.ok(edge.some((p) => p.startsWith('C:\\PF86')));
  const brave = standardBrowserPaths(env, 'brave');
  assert.ok(brave.every((p) => p.toLowerCase().endsWith('brave.exe')));
  const vivaldi = standardBrowserPaths(env, 'vivaldi');
  assert.ok(vivaldi.every((p) => p.toLowerCase().endsWith('vivaldi.exe')));
  const opera = standardBrowserPaths(env, 'opera');
  assert.ok(opera.every((p) => p.toLowerCase().endsWith('opera.exe')));
  const chromium = standardBrowserPaths(env, 'chromium');
  assert.ok(chromium.every((p) => p.includes('Chromium')));
  // Playwright 只能靠目录扫描，不能按固定路径猜。
  assert.deepEqual(standardBrowserPaths(env, 'playwright'), []);
});

test('注册表 App Paths 键与解析只认可执行文件路径', () => {
  assert.ok(registryAppPathKeys('chrome').some((k) => k.endsWith('chrome.exe')));
  assert.ok(registryAppPathKeys('edge').every((k) => k.endsWith('msedge.exe')));
  // 不登记 App Paths 的品牌不猜键名。
  assert.deepEqual(registryAppPathKeys('chromium'), []);
  assert.deepEqual(registryAppPathKeys('playwright'), []);

  const stdout = [
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
    '    (Default)    REG_SZ    C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    '    Path    REG_SZ    C:\\Program Files\\Google\\Chrome\\Application'
  ].join('\r\n');
  assert.equal(parseRegistryAppPath(stdout), 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  // 引号包裹的路径要还原。
  assert.equal(
    parseRegistryAppPath('    (Default)    REG_SZ    "C:\\Program Files\\Edge\\msedge.exe"'),
    'C:\\Program Files\\Edge\\msedge.exe'
  );
  assert.equal(parseRegistryAppPath('错误: 系统找不到指定的注册表项或值。'), null);
});

test('Playwright 兜底只扫描本机已下载的 Chromium，按构建号从新到旧', () => {
  assert.equal(
    playwrightBrowsersDir({ LOCALAPPDATA: 'C:\\LA' }, 'win32'),
    'C:\\LA\\ms-playwright'
  );
  assert.equal(
    playwrightBrowsersDir({ LOCALAPPDATA: 'C:\\LA', PLAYWRIGHT_BROWSERS_PATH: 'D:\\pw' }, 'win32'),
    'D:\\pw'
  );
  // PLAYWRIGHT_BROWSERS_PATH=0 表示装在包内，不当作缓存目录。
  assert.equal(
    playwrightBrowsersDir({ LOCALAPPDATA: 'C:\\LA', PLAYWRIGHT_BROWSERS_PATH: '0' }, 'win32'),
    'C:\\LA\\ms-playwright'
  );

  const candidates = playwrightChromiumCandidates('C:\\LA\\ms-playwright', [
    'chromium-1169', 'chromium-1248', 'chromium-1200', 'chromium_headless_shell-1248',
    'firefox-1497', 'webkit-2227', '.links'
  ]);
  // 只认 chromium-<构建号>，headless shell 与其它内核一律跳过。
  assert.ok(candidates.every((c) => c.family === 'playwright' && c.source === 'playwright'));
  assert.ok(candidates.every((c) => c.executablePath.includes('chromium-')));
  // 第一个候选来自最新构建，且优先 64 位布局。
  assert.match(candidates[0].executablePath, /chromium-1248[\\/]chrome-win64[\\/]chrome\.exe$/);
  const builds = [...new Set(candidates.map((c) => /chromium-(\d+)/.exec(c.executablePath)[1]))];
  assert.deepEqual(builds, ['1248', '1200', '1169']);
});

test('浏览器发现按品牌优先级返回，且同一可执行文件不重复', async () => {
  const files = new Set([
    'C:\\PF86\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\PF\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\LA\\ms-playwright\\chromium-1248\\chrome-win64\\chrome.exe'
  ]);
  const runtime = {
    env: { ProgramFiles: 'C:\\PF', 'ProgramFiles(x86)': 'C:\\PF86', LOCALAPPDATA: 'C:\\LA' },
    platform: 'win32',
    isFile: async (file) => files.has(file),
    // 注册表把 Chrome 指向标准路径，不应产生重复条目。
    queryRegistry: async (key) => (key.includes('chrome.exe') ? 'C:\\PF\\Google\\Chrome\\Application\\chrome.exe' : null),
    readdir: async (dir) => (dir.endsWith('ms-playwright')
      ? ['chromium-1248', 'chromium-1169', 'firefox-1497']
      : [])
  };
  const found = await discoverPlatformBrowser(runtime);
  assert.equal(found[0].family, 'chrome');
  assert.equal(found[0].source, 'registry');
  assert.equal(found[1].family, 'edge');
  assert.equal(found[2].family, 'playwright');
  const paths = found.map((c) => c.executablePath.toLowerCase());
  assert.equal(new Set(paths).size, paths.length, '同一可执行文件不能出现两次');

  const best = await findPlatformBrowser(runtime);
  assert.equal(best.family, 'chrome');
});

test('一个浏览器都没有时明确报不支持，不退化成静默失败', async () => {
  const empty = { env: {}, platform: 'win32', isFile: async () => false, queryRegistry: async () => null, readdir: async () => [] };
  await assert.rejects(
    () => findPlatformBrowser(empty),
    (err) => err instanceof PlatformBrowserError && err.code === 'platform_browser_unsupported'
  );
  await assert.rejects(
    () => pickExistingBrowser([{ executablePath: 'C:\\nope\\chrome.exe', source: 'standard', family: 'chrome' }]),
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

test('CDP pipe 帧是 JSON + NUL 分隔，残缺帧不返回', () => {
  const encoded = encodeCDPMessage({ id: 1, method: 'Page.navigate', params: { url: 'about:blank' } });
  // 真实 Chromium 的 pipe 传输是 NUL 结尾，没有长度前缀（2026-10-20 实测 Chrome 155）。
  assert.equal(encoded[encoded.length - 1], 0);
  assert.equal(encoded[0], 0x7b, '帧必须以 { 开头，不能带长度前缀');
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

  // 没有分隔符、或只有分隔符时返回 null，由调用方继续等待。
  assert.equal(parseCDPFrame(Buffer.from('{"a":1}')), null);
  assert.equal(parseCDPFrame(Buffer.from([0])), null);
  assert.equal(parseCDPFrame(Buffer.alloc(0)), null);
  // 连续的 NUL 跳过空消息，接着取出真正的那条。
  const padded = parseCDPFrame(Buffer.concat([Buffer.from([0, 0]), encodeCDPMessage({ c: 3 })]));
  assert.deepEqual(padded.message, { c: 3 });
  // 半个 JSON 不能当错误帧丢掉，要继续等下一块。
  assert.equal(parseCDPFrame(Buffer.from('{"a":1')), null);
  // 超大消息必须拒绝，不能无限累积缓冲。
  const huge = Buffer.concat([Buffer.alloc(CDP_MAX_MESSAGE_BYTES + 10, 0x20)]);
  assert.throws(() => parseCDPFrame(huge), PlatformBrowserError);
});

// 用假进程模拟 pipe：只覆盖请求/响应配对、超时与失败转换，不启动真实浏览器。
function fakeBrowserProcess() {
  const listeners = [];
  let failure = null;
  const sent = [];
  return {
    sent,
    child: { exitCode: null },
    send: (message) => {
      sent.push(message);
      // 立即按同一 id 回一个结果，模拟正常握手。
      setTimeout(() => {
        for (const listener of listeners) listener({ id: message.id, result: { product: 'Chrome/155.0.8059.85' } });
      }, 0);
    },
    onMessage: (listener) => { listeners.push(listener); },
    failure: () => failure,
    close: async () => undefined,
    fail: (error) => { failure = error; }
  };
}

test('CDP 客户端按 id 配对响应，超时与进程失败都给出稳定错误码', async () => {
  const process = fakeBrowserProcess();
  const client = createCDPClient(process, 100);
  const result = await client.request('Browser.getVersion');
  assert.deepEqual(result, { product: 'Chrome/155.0.8059.85' });
  assert.equal(process.sent.length, 1);
  assert.equal(process.sent[0].method, 'Browser.getVersion');
  await client.close();

  // 不回响应时必须超时，不能永久挂起。
  const silent = { ...fakeBrowserProcess(), send: () => undefined };
  const silentClient = createCDPClient(silent, 20);
  await assert.rejects(
    () => silentClient.request('Browser.getVersion'),
    (err) => err instanceof PlatformBrowserError && err.code === 'platform_browser_launch_failed'
  );

  // 进程已经失败时不再发请求，直接报“起不来”。
  const broken = fakeBrowserProcess();
  broken.fail(new PlatformBrowserError('platform_browser_launch_failed', '无法启动本机浏览器'));
  const brokenClient = createCDPClient(broken, 20);
  await assert.rejects(
    () => brokenClient.request('Browser.getVersion'),
    (err) => err instanceof PlatformBrowserError && err.code === 'platform_browser_launch_failed'
  );
});

test('浏览器自报产品串解析：Chrome 与 Edge 两种实测形态都要认', () => {
  assert.deepEqual(parseBrowserProduct('Chrome/155.0.8059.85'), { brand: 'Chrome', version: '155.0.8059.85' });
  // Edge 报的是 Edg/，2026-10-20 实测。
  assert.deepEqual(parseBrowserProduct('Edg/155.0.4283.62'), { brand: 'Edg', version: '155.0.4283.62' });
  assert.deepEqual(parseBrowserProduct('Chromium/156.0.8078.4'), { brand: 'Chromium', version: '156.0.8078.4' });
  assert.deepEqual(parseBrowserProduct('HeadlessChrome/140.0.0.0'), { brand: 'HeadlessChrome', version: '140.0.0.0' });
  // 认不出的形态不能猜一个版本出来。
  assert.equal(parseBrowserProduct('NotABrowser'), null);
  assert.equal(parseBrowserProduct(''), null);
  assert.equal(parseBrowserProduct('Chrome/'), null);
});

test('探测把浏览器自报版本转成品牌与主版本，识别不了时报不支持', async () => {
  const candidate = { executablePath: 'C:\\PF\\Google\\Chrome\\Application\\chrome.exe', source: 'standard', family: 'chrome' };
  // spawnImpl 用一个立即返回固定帧的假子进程替代真实浏览器。
  const fakeSpawn = () => {
    const { PassThrough } = require('node:stream');
    const out = new PassThrough();
    const handlers = {};
    const child = {
      stdio: [null, null, new PassThrough(), new PassThrough(), out],
      exitCode: null,
      on: (event, handler) => { handlers[event] = handler; return child; },
      once: (event, handler) => { handlers[event] = handler; return child; },
      kill: () => { child.exitCode = 0; if (handlers.exit) handlers.exit(0); }
    };
    setTimeout(() => out.write(encodeCDPMessage({ id: 1, result: { product: 'Chrome/155.0.8059.85' } })), 0);
    return child;
  };
  const probe = await probePlatformBrowser(
    { candidate, profileDir: 'C:\\profiles\\probe' },
    { spawnImpl: fakeSpawn, env: {} }
  );
  assert.deepEqual(probe, { family: 'chrome', name: 'Google Chrome', version: '155.0.8059.85', major: 155 });

  // 自报串无法解析时不能当作可用浏览器。
  const badSpawn = () => {
    const { PassThrough } = require('node:stream');
    const out = new PassThrough();
    const handlers = {};
    const child = {
      stdio: [null, null, new PassThrough(), new PassThrough(), out],
      exitCode: null,
      on: (event, handler) => { handlers[event] = handler; return child; },
      once: (event, handler) => { handlers[event] = handler; return child; },
      kill: () => { child.exitCode = 0; if (handlers.exit) handlers.exit(0); }
    };
    setTimeout(() => out.write(encodeCDPMessage({ id: 1, result: { product: 'NotABrowser' } })), 0);
    return child;
  };
  await assert.rejects(
    () => probePlatformBrowser({ candidate, profileDir: 'C:\\profiles\\probe' }, { spawnImpl: badSpawn, env: {} }),
    (err) => err instanceof PlatformBrowserError && err.code === 'platform_browser_unsupported'
  );
});

test('启动失败与“浏览器不支持”是两个不同的错误码', async () => {
  const candidate = { executablePath: 'C:\\PF\\Google\\Chrome\\Application\\chrome.exe', source: 'standard', family: 'chrome' };
  // 子进程启动后立即退出且没有回任何帧：这是“起不来”，不是“没装”。
  const exitingSpawn = () => {
    const { PassThrough } = require('node:stream');
    const handlers = {};
    const child = {
      stdio: [null, null, new PassThrough(), new PassThrough(), new PassThrough()],
      exitCode: null,
      on: (event, handler) => { handlers[event] = handler; return child; },
      once: (event, handler) => { handlers[event] = handler; return child; },
      kill: () => undefined
    };
    setTimeout(() => { child.exitCode = 1; if (handlers.exit) handlers.exit(1); }, 0);
    return child;
  };
  await assert.rejects(
    () => probePlatformBrowser({ candidate, profileDir: 'C:\\profiles\\probe', timeoutMs: 100 }, { spawnImpl: exitingSpawn, env: {} }),
    (err) => err instanceof PlatformBrowserError && err.code === 'platform_browser_launch_failed'
  );
});
