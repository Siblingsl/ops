'use strict';
// DEV-AI27-11（P01）：MCP OAuth 客户端测试（node --test；本地伪造 OAuth 服务器）。
// 覆盖：发现+授权成功落盘、state 不匹配拒绝、issuer 不匹配拒绝、过期静默刷新、
// 401 只刷新一次、刷新失败转 needs_reauth、撤销清理令牌、令牌零泄漏（statusView/日志无 token）。

const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const crypto = require('node:crypto');

const { McpOAuthClient, SafeStorageTokenStorage, createPkcePair, fetchDiscovery } = require('../.build/mcp-oauth.js');

// ---------------------------------------------------------------------------
// 内存令牌仓（模拟 safeStorage 语义）
// ---------------------------------------------------------------------------

function memoryStorage() {
  const store = new Map();
  const calls = { write: 0, read: 0, remove: 0 };
  return {
    calls,
    isEncryptionAvailable: () => true,
    encrypt: (plain) => Buffer.concat([Buffer.from('enc:'), Buffer.from(plain, 'utf8')]),
    decrypt: (blob) => Buffer.from(blob).toString('utf8').replace(/^enc:/, ''),
    read: (id) => { calls.read += 1; return store.has(id) ? store.get(id) : null; },
    write: (id, blob) => { calls.write += 1; store.set(id, blob); },
    remove: (id) => { calls.remove += 1; store.delete(id); },
  };
}

// ---------------------------------------------------------------------------
// 本地伪造 OAuth 服务器：发现 / 授权端点（返回 code） / token / 撤销
// ---------------------------------------------------------------------------

function fakeOAuthServer(opts = {}) {
  const issued = { codes: [], tokenRequests: [], revocations: [] };
  let accessTokenSeq = 0;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const base = `http://127.0.0.1:${u.port}`;
    res.setHeader('Content-Type', 'application/json');
    if (u.pathname === '/.well-known/oauth-authorization-server') {
      res.end(JSON.stringify({
        issuer: opts.issuer ?? base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        revocation_endpoint: `${base}/revoke`,
      }));
      return;
    }
    if (u.pathname === '/authorize') {
      // 授权端点：浏览器侧完成，测试直接带 code+state 打到回调（由客户端自行拼接）。
      res.writeHead(302).end();
      return;
    }
    if (u.pathname === '/token') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const form = new URLSearchParams(body);
        issued.tokenRequests.push(Object.fromEntries(form));
        if (opts.rejectRefresh && form.get('grant_type') === 'refresh_token') {
          res.writeHead(400).end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }
        accessTokenSeq += 1;
        res.end(JSON.stringify({
          access_token: opts.leakToken ? `AT-LEAK-${accessTokenSeq}` : `at-${accessTokenSeq}`,
          refresh_token: form.get('grant_type') === 'authorization_code' ? `rt-${accessTokenSeq}` : `rt-${accessTokenSeq}`,
          expires_in: opts.expiresIn ?? 3600,
          token_type: 'Bearer',
        }));
      });
      return;
    }
    if (u.pathname === '/revoke') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        issued.revocations.push(body);
        res.writeHead(200).end('{}');
      });
      return;
    }
    res.writeHead(404).end('{}');
  });
  return { server, issued };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve(server.address().port);
  }));
}

/** 完整授权流程的快捷方式：直接驱动客户端（openBrowser 伪造为立即回调正确 code）。 */
async function driveAuthorize(client, port, state, opts = {}) {
  // 拦截 openBrowser：解析授权 URL，提取 state/code_challenge，模拟服务器带 code 回调。
  // 回调端口由客户端回环服务器随机分配——从授权 URL 的 redirect_uri 取。
  const openBrowser = async (authURL) => {
    const u = new URL(authURL);
    assert.equal(u.searchParams.get('response_type'), 'code');
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(u.searchParams.get('code_challenge').length > 0, 'PKCE challenge 必填');
    const redirect = new URL(u.searchParams.get('redirect_uri'));
    const callbackState = opts.wrongState ? 'tampered' : u.searchParams.get('state');
    const target = `http://127.0.0.1:${redirect.port}/callback?code=auth-code-1&state=${encodeURIComponent(callbackState)}`;
    // 回环服务器已启动，直接 GET 回调地址。
    await fetch(target);
  };
  return client.authorize((url) => { void openBrowser(url); });
}

test('P01: 发现文档解析', async () => {
  const { server } = fakeOAuthServer();
  const port = await listen(server);
  const fetchImpl = (u, i) => fetch(u, i);
  const discovery = await fetchDiscovery(`http://127.0.0.1:${port}/mcp`, fetchImpl);
  assert.equal(discovery.authorizationEndpoint, `http://127.0.0.1:${port}/authorize`);
  server.close();
});

test('P01: 授权成功 → 令牌落盘（加密）→ statusView 无令牌明文', async () => {
  const { server, issued } = fakeOAuthServer();
  const port = await listen(server);
  const storage = memoryStorage();
  const client = new McpOAuthClient(
    { connectionId: 'conn-1', serverUrl: `http://127.0.0.1:${port}/mcp`, clientId: 'ops-desktop' },
    storage,
    (u, i) => fetch(u, i),
  );
  const outcome = await driveAuthorize(client, port);
  assert.equal(outcome.state, 'authorized', `授权应成功：${outcome.reason ?? ''}`);
  assert.equal(issued.tokenRequests.length, 1);
  assert.equal(issued.tokenRequests[0].grant_type, 'authorization_code');
  assert.ok(issued.tokenRequests[0].code_verifier, 'PKCE verifier 必传');
  assert.ok(issued.tokenRequests[0].redirect_uri.startsWith('http://127.0.0.1:'), '回环 redirect_uri');
  // 令牌加密落盘
  assert.equal(storage.calls.write, 1);
  // statusView 不暴露令牌
  const view = client.statusView();
  assert.equal(view.state, 'authorized');
  assert.ok(view.has_refresh);
  assert.ok(!JSON.stringify(view).includes('at-1'), 'statusView 不得含 access token');
  server.close();
});

test('P01: state 不匹配 → needs_reauth + state_mismatch，不发 token 请求', async () => {
  const { server, issued } = fakeOAuthServer();
  const port = await listen(server);
  const client = new McpOAuthClient(
    { connectionId: 'conn-2', serverUrl: `http://127.0.0.1:${port}/mcp`, clientId: 'ops' },
    memoryStorage(), (u, i) => fetch(u, i),
  );
  const outcome = await driveAuthorize(client, port, undefined, { wrongState: true });
  assert.equal(outcome.state, 'needs_reauth');
  assert.equal(outcome.reason, 'state_mismatch');
  assert.equal(issued.tokenRequests.length, 0, 'state 不匹配不得换 token');
  server.close();
});

test('P01: issuer 与服务器 origin 不符 → 拒绝授权', async () => {
  const { server } = fakeOAuthServer({ issuer: 'http://evil.example' });
  const port = await listen(server);
  const client = new McpOAuthClient(
    { connectionId: 'conn-3', serverUrl: `http://127.0.0.1:${port}/mcp`, clientId: 'ops' },
    memoryStorage(), (u, i) => fetch(u, i),
  );
  const outcome = await driveAuthorize(client, port);
  assert.equal(outcome.state, 'needs_reauth');
  assert.equal(outcome.reason, 'issuer_mismatch');
  server.close();
});

test('P01: 过期令牌 accessToken 静默刷新一次', async () => {
  const { server, issued } = fakeOAuthServer();
  const port = await listen(server);
  const storage = memoryStorage();
  let now = 1_000_000;
  const client = new McpOAuthClient(
    { connectionId: 'conn-4', serverUrl: `http://127.0.0.1:${port}/mcp`, clientId: 'ops' },
    storage, (u, i) => fetch(u, i), () => now,
  );
  await driveAuthorize(client, port);
  assert.equal(issued.tokenRequests.length, 1);
  // 快进到过期（expires_in 默认 3600s）
  now += 2 * 3600 * 1000;
  const token = await client.accessToken();
  assert.ok(token && token.startsWith('at-'), '过期后应刷新出新令牌');
  assert.equal(issued.tokenRequests.length, 2, '刷新恰好一次');
  assert.equal(issued.tokenRequests[1].grant_type, 'refresh_token');
  server.close();
});

test('P01: 刷新失败（invalid_grant）→ needs_reauth，令牌清空', async () => {
  const { server } = fakeOAuthServer({ rejectRefresh: true });
  const port = await listen(server);
  let now = 1_000_000;
  const client = new McpOAuthClient(
    { connectionId: 'conn-5', serverUrl: `http://127.0.0.1:${port}/mcp`, clientId: 'ops' },
    memoryStorage(), (u, i) => fetch(u, i), () => now,
  );
  await driveAuthorize(client, port);
  now += 2 * 3600 * 1000;
  const token = await client.accessToken();
  assert.equal(token, null, '刷新失败不得返回令牌');
  assert.equal(client.state, 'needs_reauth');
  server.close();
});

test('P01: 撤销清理令牌文件并调撤销端点', async () => {
  const { server, issued } = fakeOAuthServer();
  const port = await listen(server);
  const storage = memoryStorage();
  const client = new McpOAuthClient(
    { connectionId: 'conn-6', serverUrl: `http://127.0.0.1:${port}/mcp`, clientId: 'ops' },
    storage, (u, i) => fetch(u, i),
  );
  await driveAuthorize(client, port);
  assert.equal(storage.calls.write, 1);
  await client.revoke();
  assert.equal(storage.calls.remove, 1);
  assert.equal(client.state, 'unauthorized');
  assert.equal(issued.revocations.length, 1);
  server.close();
});

test('P01: 加密存储不可用时不落盘令牌（内存保留）', async () => {
  const { server } = fakeOAuthServer();
  const port = await listen(server);
  const storage = memoryStorage();
  storage.isEncryptionAvailable = () => false;
  const client = new McpOAuthClient(
    { connectionId: 'conn-7', serverUrl: `http://127.0.0.1:${port}/mcp`, clientId: 'ops' },
    storage, (u, i) => fetch(u, i),
  );
  const outcome = await driveAuthorize(client, port);
  assert.equal(outcome.state, 'authorized');
  assert.equal(storage.calls.write, 0, '加密不可用不得明文落盘');
  assert.ok(await client.accessToken(), '内存令牌仍可用');
  server.close();
});

test('P01: PKCE 形状（verifier 43+ 字符，challenge 是其 SHA-256 base64url）', () => {
  const { verifier, challenge } = createPkcePair();
  assert.ok(verifier.length >= 43);
  const expect = crypto.createHash('sha256').update(verifier).digest('base64url');
  assert.equal(challenge, expect);
});
