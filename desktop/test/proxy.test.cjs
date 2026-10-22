const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const { after, test } = require('node:test');
const {
  createPinnedHttpsProxyAgent,
  normalizeProxyUrl,
  parseSystemProxyResolution
} = require('../.build/proxy.js');

test('system proxy uses only the first resolved route and rejects unsupported schemes', () => {
  assert.deepEqual(parseSystemProxyResolution('PROXY proxy.example:8080; DIRECT'), {
    url: 'http://proxy.example:8080'
  });
  assert.equal(parseSystemProxyResolution('DIRECT; PROXY proxy.example:8080'), null);
  assert.throws(() => parseSystemProxyResolution('SOCKS5 proxy.example:1080; DIRECT'), /不受支持/);
});

test('manual proxy URL rejects embedded credentials, paths, and query strings', () => {
  assert.equal(normalizeProxyUrl('https://proxy.example.com:8443'), 'https://proxy.example.com:8443');
  for (const value of [
    'http://user:pass@proxy.example.com:8080',
    'http://proxy.example.com:8080/path',
    'http://proxy.example.com:8080?x=1'
  ]) {
    assert.throws(() => normalizeProxyUrl(value));
  }
});

test('proxy CONNECT pins the resolved target IP and fails without direct fallback', async (t) => {
  const server = http.createServer();
  let connectTarget = '';
  let proxyAuthorization;
  server.on('connect', (request, socket) => {
    connectTarget = request.url;
    proxyAuthorization = request.headers['proxy-authorization'];
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  const agent = createPinnedHttpsProxyAgent(
    { url: `http://127.0.0.1:${address.port}` },
    'api.example.test',
    443,
    '203.0.113.7'
  );
  try {
    await new Promise((resolve) => {
      const request = https.request('https://api.example.test/v1', { agent });
      request.once('error', (error) => {
        assert.match(error.message, /代理拒绝/);
        resolve();
      });
      request.end();
    });
    assert.equal(connectTarget, '203.0.113.7:443');
    assert.equal(proxyAuthorization, undefined);
  } finally {
    agent.destroy();
  }
});
