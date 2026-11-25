const assert = require('node:assert/strict');
const test = require('node:test');

const {
  parseSemver,
  formatSemver,
  compareSemver,
  isTrustedDownloadUrl,
  evaluateReleaseUpdate,
  createDesktopUpdateChecker,
} = require('../.build/update-check.js');
const {
  registerDesktopUpdateIpcHandlers,
  DESKTOP_UI_GET_UPDATE_STATUS_CHANNEL,
  DESKTOP_UI_CHECK_UPDATE_CHANNEL,
  DESKTOP_UI_OPEN_UPDATE_DOWNLOAD_CHANNEL,
} = require('../.build/ipc/update.js');

// OPT-E02（docs/43 §5）：版本比较必须与服务端 Go 侧逐位一致，下载链接双层校验，
// 检查器不盲信服务端 update_available，并且所有失败都收敛成状态而不是抛错。

test('OPT-E02 semver：可选前导 v、三段数字、预发布与 build 元数据', () => {
  const valid = [
    ['0.2.0', '0.2.0'],
    ['v1.2.3', '1.2.3'],
    ['  V0.10.0  ', '0.10.0'],
    ['1.0.0-beta.1', '1.0.0-beta.1'],
    ['1.0.0-rc.1+build.5', '1.0.0-rc.1'],
    ['2.0.0+build.20261125', '2.0.0'],
    ['01.002.0003', '1.2.3'],
    ['1.0.0-alpha.beta-gamma', '1.0.0-alpha.beta-gamma'],
  ];
  for (const [raw, want] of valid) {
    const parsed = parseSemver(raw);
    assert.ok(parsed, `${raw} 应解析成功`);
    assert.equal(formatSemver(parsed), want);
  }
  for (const raw of ['', 'v', 'V ', '1', '1.2', '1.2.3.4', '1.2.x', '1..3', '1.2.3-', '1.2.3-+x',
    '1.2.3+build!', '1.2.3-beta_1', '1.2.3.4-beta', 'abc']) {
    assert.equal(parseSemver(raw), null, `${raw} 必须解析失败`);
  }
});

test('OPT-E02 semver 比较：0.10.0 > 0.2.0、正式版 > 预发布、数字段小于字母段', () => {
  const cases = [
    ['0.10.0', '0.2.0', 1],
    ['0.2.0', '0.10.0', -1],
    ['1.0.0', '1.0.0', 0],
    ['1.0.0', '1.0.0-beta.1', 1],
    ['1.0.0-beta.1', '1.0.0', -1],
    ['1.0.0-beta.2', '1.0.0-beta.1', 1],
    ['1.0.0-beta.10', '1.0.0-beta.2', 1],
    ['1.0.0-beta.1', '1.0.0-beta.alpha', -1],
    ['1.0.0-beta.alpha', '1.0.0-beta.beta', -1],
    ['1.0.0-alpha', '1.0.0-alpha.1', -1],
    ['1.0.0-alpha.1', '1.0.0-alpha', 1],
    ['2.0.0', '1.99.99', 1],
  ];
  for (const [a, b, want] of cases) {
    const left = parseSemver(a);
    const right = parseSemver(b);
    assert.ok(left && right, `${a} / ${b} 版本非法`);
    assert.equal(compareSemver(left, right), want, `compare(${a}, ${b})`);
  }
});

test('OPT-E02 下载链接：仅 https、无凭据、非本机/内网/保留地址', () => {
  for (const raw of [
    'https://downloads.example.com/ops/OPS-Desktop-Setup.exe',
    'https://cdn.example.com:8443/a/b.exe?token=public#sha',
  ]) {
    assert.equal(isTrustedDownloadUrl(raw), true, `${raw} 应可信`);
  }
  for (const raw of [
    '', 'http://downloads.example.com/ops.exe', 'ftp://downloads.example.com/ops.exe',
    'https://user:pass@downloads.example.com/ops.exe',
    'https://localhost/ops.exe', 'https://app.localhost/ops.exe',
    'https://127.0.0.1/ops.exe', 'https://127.1.2.3/ops.exe',
    'https://10.1.2.3/ops.exe', 'https://172.16.0.9/ops.exe',
    'https://192.168.1.10/ops.exe', 'https://169.254.1.1/ops.exe',
    'https://0.0.0.0/ops.exe', 'https://100.64.1.1/ops.exe',
    'https://192.0.2.5/ops.exe', 'https://198.51.100.7/ops.exe', 'https://203.0.113.9/ops.exe',
    'https://[::1]/ops.exe', 'https://[fe80::1]/ops.exe', 'https://[fd00::1]/ops.exe',
    'https://releases/ops.exe', 'https:///ops.exe',
  ]) {
    assert.equal(isTrustedDownloadUrl(raw), false, `${raw} 必须拒绝`);
  }
});

test('OPT-E02 evaluateReleaseUpdate：本地重算版本、过滤链接与 SHA', () => {
  const goodSHA = 'ab'.repeat(32);
  const payload = {
    configured: true,
    latest_version: 'v0.10.0',
    current_version: '0.2.0',
    update_available: false,
    release_notes: '修复若干问题',
    download_url: 'https://downloads.example.com/ops.exe',
    sha256: goodSHA.toUpperCase(),
  };
  assert.deepEqual(evaluateReleaseUpdate('0.2.0', payload), {
    latestVersion: '0.10.0',
    updateAvailable: true,
    releaseNotes: '修复若干问题',
    downloadUrl: 'https://downloads.example.com/ops.exe',
    sha256: goodSHA,
  });

  // 服务端说“有更新”但本地按 semver 算更旧 → 必须为 false。
  assert.equal(evaluateReleaseUpdate('0.2.0', { ...payload, latest_version: '0.1.0', update_available: true })
    .updateAvailable, false);
  // 同版本 → false。
  assert.equal(evaluateReleaseUpdate('0.10.0', payload).updateAvailable, false);
  // 客户端当前版本非法 → 不臆断有更新。
  assert.equal(evaluateReleaseUpdate('not-a-version', payload).updateAvailable, false);

  const unsafe = evaluateReleaseUpdate('0.1.0', {
    ...payload,
    download_url: 'http://127.0.0.1/ops.exe',
    sha256: 'not-a-sha',
  });
  assert.equal(unsafe.downloadUrl, '');
  assert.equal(unsafe.sha256, '');

  const longNotes = evaluateReleaseUpdate('0.1.0', { ...payload, release_notes: '更'.repeat(2100) });
  assert.equal(Array.from(longNotes.releaseNotes).length, 2000);

  for (const raw of [null, undefined, 'x', [], 42]) {
    assert.deepEqual(evaluateReleaseUpdate('0.1.0', raw), {
      latestVersion: '', updateAvailable: false, releaseNotes: '', downloadUrl: '', sha256: '',
    });
  }
});

function fixedResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test('OPT-E02 createDesktopUpdateChecker：请求地址、状态流转与本地结果', async () => {
  const calls = [];
  const statuses = [];
  const checker = createDesktopUpdateChecker({
    currentVersion: () => '0.1.0',
    apiOrigin: () => 'https://api.example.com/',
    onStatus: (status) => statuses.push(status),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return fixedResponse({
        configured: true,
        latest_version: '0.2.0',
        current_version: '0.1.0',
        update_available: true,
        release_notes: '新版说明',
        download_url: 'https://downloads.example.com/ops.exe',
        sha256: 'a'.repeat(64),
      });
    },
  });
  assert.equal(checker.getStatus().status, 'idle');
  assert.equal(checker.getStatus().currentVersion, '0.1.0');

  const result = await checker.checkNow();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.example.com/api/v1/desktop/release?current=0.1.0');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(result.status, 'update-available');
  assert.equal(result.latestVersion, '0.2.0');
  assert.equal(result.updateAvailable, true);
  assert.equal(result.releaseNotes, '新版说明');
  assert.equal(result.downloadUrl, 'https://downloads.example.com/ops.exe');
  assert.equal(result.sha256, 'a'.repeat(64));
  assert.ok(result.checkedAt > 0);
  assert.equal(result.error, '');
  assert.deepEqual(statuses.map((item) => item.status), ['checking', 'update-available']);
  // getStatus 返回只读副本：外部改动不影响内部状态。
  const copy = checker.getStatus();
  copy.status = 'error';
  assert.equal(checker.getStatus().status, 'update-available');
});

test('OPT-E02 createDesktopUpdateChecker：并发检查复用同一个 in-flight Promise', async () => {
  let resolveFetch;
  let fetchCount = 0;
  const checker = createDesktopUpdateChecker({
    currentVersion: () => '0.1.0',
    apiOrigin: () => 'https://api.example.com',
    onStatus: () => {},
    fetchImpl: () => {
      fetchCount += 1;
      if (fetchCount > 1) {
        return Promise.resolve(fixedResponse({ latest_version: '0.2.0', download_url: '', sha256: '' }));
      }
      return new Promise((resolve) => { resolveFetch = resolve; });
    },
  });
  const first = checker.checkNow();
  const second = checker.checkNow();
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(fetchCount, 1);
  resolveFetch(fixedResponse({ latest_version: '0.2.0', download_url: '', sha256: '' }));
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b);
  // 完成后可以再次发起检查。
  const third = checker.checkNow();
  assert.notEqual(third, first);
  assert.equal((await third).status, 'update-available');
});

test('OPT-E02 createDesktopUpdateChecker：HTTP/网络/超时错误都收敛为 status=error', async () => {
  const cases = [
    {
      label: 'HTTP 500',
      fetchImpl: async () => fixedResponse({}, 500),
      wantError: /无法连接更新服务/,
    },
    {
      label: '网络异常',
      fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
      wantError: /无法连接更新服务/,
    },
    {
      label: '超时',
      fetchImpl: async () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      },
      wantError: /检查更新超时/,
    },
    {
      label: 'JSON 解析失败',
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } }),
      wantError: /无法连接更新服务/,
    },
  ];
  for (const item of cases) {
    const checker = createDesktopUpdateChecker({
      currentVersion: () => '0.1.0',
      apiOrigin: () => 'https://api.example.com',
      onStatus: () => {},
      fetchImpl: item.fetchImpl,
    });
    const result = await checker.checkNow();
    assert.equal(result.status, 'error', item.label);
    assert.equal(result.updateAvailable, false, item.label);
    assert.equal(result.latestVersion, '', item.label);
    assert.equal(result.downloadUrl, '', item.label);
    assert.ok(item.wantError.test(result.error), `${item.label} 错误文案：${result.error}`);
    assert.equal(result.currentVersion, '0.1.0');
  }
});

test('OPT-E02 createDesktopUpdateChecker：未配置更新源与启动延迟/dispose', async () => {
  let fetchCount = 0;
  const checker = createDesktopUpdateChecker({
    currentVersion: () => '0.1.0',
    apiOrigin: () => 'https://api.example.com',
    onStatus: () => {},
    startupDelayMs: 10,
    fetchImpl: async () => {
      fetchCount += 1;
      return fixedResponse({ configured: false, latest_version: '', download_url: '', sha256: '' });
    },
  });
  const result = await checker.checkNow();
  assert.equal(result.status, 'unconfigured');
  assert.equal(fetchCount, 1);

  // 启动检查：延迟后静默触发一次。
  const startup = createDesktopUpdateChecker({
    currentVersion: () => '0.1.0',
    apiOrigin: () => 'https://api.example.com',
    onStatus: () => {},
    startupDelayMs: 10,
    fetchImpl: async () => { fetchCount += 1; return fixedResponse({ latest_version: '0.1.0' }); },
  });
  startup.scheduleStartupCheck();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(fetchCount, 2);
  startup.dispose();

  // dispose 必须在延迟到期前取消定时器。
  const disposed = createDesktopUpdateChecker({
    currentVersion: () => '0.1.0',
    apiOrigin: () => 'https://api.example.com',
    onStatus: () => {},
    startupDelayMs: 30,
    fetchImpl: async () => { fetchCount += 1; return fixedResponse({ latest_version: '0.1.0' }); },
  });
  disposed.scheduleStartupCheck();
  disposed.dispose();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(fetchCount, 2);
});

function trustedWindowAndEvent() {
  const frame = { url: 'ops-desktop://business/index.html' };
  const sender = {
    mainFrame: frame,
    getURL: () => 'ops-desktop://business/index.html',
  };
  const host = { isDestroyed: () => false, webContents: sender };
  return {
    host,
    event: { sender, senderFrame: frame },
    untrustedEvent: { sender: { mainFrame: { url: 'https://evil.example.com/' }, getURL: () => 'https://evil.example.com/' }, senderFrame: { url: 'https://evil.example.com/' } },
  };
}

test('OPT-E02 IPC：业务窗口守卫、无参打开只用已校验链接', async () => {
  const handlers = new Map();
  const { host, event, untrustedEvent } = trustedWindowAndEvent();
  const opened = [];
  const baseStatus = {
    status: 'update-available',
    currentVersion: '0.1.0',
    latestVersion: '0.2.0',
    updateAvailable: true,
    releaseNotes: '',
    downloadUrl: 'https://downloads.example.com/ops.exe',
    sha256: '',
    checkedAt: 1,
    error: '',
  };
  const checker = {
    getStatus: () => ({ ...baseStatus }),
    checkNow: async () => ({ ...baseStatus }),
    scheduleStartupCheck: () => {},
    dispose: () => {},
  };
  registerDesktopUpdateIpcHandlers({
    ipcHandle: (channel, handler) => handlers.set(channel, handler),
    businessWindow: () => host,
    isBusinessUrl: (url) => url.startsWith('ops-desktop://business'),
    checker,
    openExternal: (url) => { opened.push(url); },
  });
  assert.equal(handlers.size, 3);

  const get = await handlers.get(DESKTOP_UI_GET_UPDATE_STATUS_CHANNEL)(event);
  assert.deepEqual(get, { ok: true, status: baseStatus });
  const check = await handlers.get(DESKTOP_UI_CHECK_UPDATE_CHANNEL)(event);
  assert.equal(check.ok, true);
  assert.equal(check.status.latestVersion, '0.2.0');

  // 渲染器传入任意 URL 一律忽略，只打开 checker 里已校验的地址。
  await handlers.get(DESKTOP_UI_OPEN_UPDATE_DOWNLOAD_CHANNEL)(event, 'https://evil.example.com/malware.exe');
  assert.deepEqual(opened, ['https://downloads.example.com/ops.exe']);

  // checker 内的链接被篡改成内网地址时拒绝打开。
  checker.getStatus = () => ({ ...baseStatus, downloadUrl: 'https://127.0.0.1/ops.exe' });
  const rejected = await handlers.get(DESKTOP_UI_OPEN_UPDATE_DOWNLOAD_CHANNEL)(event);
  assert.deepEqual(rejected, {
    ok: false,
    code: 'download_unavailable',
    message: '当前没有可用的下载链接，请联系管理员获取最新安装包。',
  });
  assert.equal(opened.length, 1);

  for (const channel of [DESKTOP_UI_GET_UPDATE_STATUS_CHANNEL, DESKTOP_UI_CHECK_UPDATE_CHANNEL, DESKTOP_UI_OPEN_UPDATE_DOWNLOAD_CHANNEL]) {
    const result = await handlers.get(channel)(untrustedEvent);
    if (channel === DESKTOP_UI_CHECK_UPDATE_CHANNEL) assert.equal(result.ok, false);
    else assert.equal(result.ok, false);
    assert.equal(result.code, 'not_business_window');
  }
});
