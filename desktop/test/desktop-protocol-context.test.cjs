'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

function loadProtocolModule() {
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { app: {}, dialog: {}, session: {} };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require('../.build/main/protocol.js');
  } finally {
    Module._load = originalLoad;
  }
}

test('打包态跨源 ops-desktop://business 请求 apiOrigin 受信任，开发态同源亦受信任', () => {
  const { isTrustedBusinessApiRequest } = loadProtocolModule();

  assert.equal(isTrustedBusinessApiRequest({
    requestUrl: 'https://ops-api.88813888.xyz/api/v1/accounts/1/strategy/options',
    apiOrigin: 'https://ops-api.88813888.xyz',
    businessOrigin: 'ops-desktop://business',
    frameUrl: 'ops-desktop://business/ops',
    initiatorOrigin: 'ops-desktop://business',
    sameWebContents: true,
    isMainFrame: true
  }), true);

  assert.equal(isTrustedBusinessApiRequest({
    requestUrl: 'http://localhost:5174/api/v1/ai/status',
    apiOrigin: 'http://localhost:5174',
    businessOrigin: 'http://localhost:5174',
    frameUrl: 'http://localhost:5174/ops',
    initiatorOrigin: 'http://localhost:5174',
    sameWebContents: true,
    isMainFrame: true
  }), true);

  for (const [label, overrides] of [
    ['非主框架', { isMainFrame: false }],
    ['不同 webContents', { sameWebContents: false }],
    ['恶意 HTTPS initiatorOrigin', { initiatorOrigin: 'https://evil.example' }],
    ['伪造 ops-desktop initiatorOrigin', { initiatorOrigin: 'ops-desktop://business.evil' }],
    ['伪造 frameUrl', { frameUrl: 'https://evil.example/ops' }],
    ['非 API 路径', { requestUrl: 'https://ops-api.88813888.xyz/preview/abc' }],
    ['请求错误 API 源', { requestUrl: 'https://other-api.example/api/v1/ai/status' }]
  ]) {
    assert.equal(isTrustedBusinessApiRequest({
      requestUrl: 'https://ops-api.88813888.xyz/api/v1/accounts/1/strategy/options',
      apiOrigin: 'https://ops-api.88813888.xyz',
      businessOrigin: 'ops-desktop://business',
      frameUrl: 'ops-desktop://business/ops',
      initiatorOrigin: 'ops-desktop://business',
      sameWebContents: true,
      isMainFrame: true,
      ...overrides
    }), false, `应拒绝：${label}`);
  }
});

test('navigateBusiness、settings:apply-mode 与离线页布局回归契约', () => {
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.ts'), 'utf8');
  const settingsIpcSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'ipc', 'settings.ts'), 'utf8');
  const offlineHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'settings', 'offline.html'), 'utf8');
  const settingsCss = fs.readFileSync(path.join(__dirname, '..', 'public', 'settings', 'settings.css'), 'utf8');

  const navStart = mainSource.indexOf('async function navigateBusiness(');
  assert.ok(navStart >= 0, 'main.ts 缺少 navigateBusiness');
  const navBody = mainSource.slice(navStart, mainSource.indexOf('\nfunction ', navStart));
  assert.match(navBody, /contents\.on\('will-prevent-unload', allowUnload\)/);
  assert.match(navBody, /contents\.removeListener\('will-prevent-unload', allowUnload\)/);
  assert.match(navBody, /err\?\.errno === -3 \|\| err\?\.code === 'ERR_ABORTED'/);

  const applyStart = settingsIpcSource.indexOf("ipcHandle('settings:apply-mode'");
  assert.ok(applyStart >= 0, 'ipc/settings.ts 缺少 settings:apply-mode');
  const applyBody = settingsIpcSource.slice(applyStart, settingsIpcSource.indexOf("ipcHandle('settings:reauthenticate'", applyStart));
  const clearIdx = applyBody.indexOf('deps.routingRefreshPending.set(false)');
  const navIdx = applyBody.indexOf('deps.navigateBusiness(currentUrl)');
  assert.ok(clearIdx > 0 && navIdx > clearIdx, 'routingRefreshPending 必须在 navigateBusiness 之前清除');

  assert.match(offlineHtml, /<body class="offline-page">/);
  assert.match(settingsCss, /body\.offline-page\s+\.panel\s*\{/);
});
