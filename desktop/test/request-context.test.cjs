const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildDesktopRequestHeaders,
  isPotentialAiApiRequest,
  isBusinessApiUrl,
  ManagementRequestRegistry,
  shouldBlockDesktopApiRequest,
  prepareDesktopRouteApplication
} = require('../.build/request-context.js');

const origin = 'https://ops.example.test';

test('management request markers are one-use and bound to the exact API URL and method', () => {
  const registry = new ManagementRequestRegistry(origin);
  const requestUrl = `${origin}/api/v1/desktop/routes`;
  const marker = registry.issue(requestUrl, 'PUT');

  assert.equal(registry.consume(marker, requestUrl, 'POST'), false);
  assert.equal(registry.consume(marker, `${origin}/api/v1/desktop/models`, 'PUT'), false);
  assert.equal(registry.consume(marker, requestUrl, 'PUT'), false);

  const validMarker = registry.issue(requestUrl, 'PUT');
  assert.equal(registry.consume(validMarker, requestUrl, 'PUT'), true);
  assert.equal(registry.consume(validMarker, requestUrl, 'PUT'), false);
  assert.throws(() => registry.issue('https://attacker.example/api/v1/desktop/routes', 'PUT'));
});

test('client headers replace renderer supplied values only for the trusted business API', () => {
  const headers = buildDesktopRequestHeaders({
    requestUrl: `${origin}/api/v1/agent/runs`,
    businessOrigin: origin,
    trustedBusinessMainFrame: true,
    mode: 'desktop',
    requestContext: { deviceId: 'device-1', connectionId: 'connection-1', generation: 4, routeRevision: 8 },
    requestHeaders: {
      'X-OPS-Desktop-Device': 'spoofed',
      'X-OPS-Desktop-Connection': 'spoofed',
      'X-OPS-Desktop-Policy': 'spoofed',
      Accept: 'application/json'
    }
  });

  assert.equal(headers.Accept, 'application/json');
  assert.equal(headers['X-OPS-Desktop-Device'], 'device-1');
  assert.equal(headers['X-OPS-Desktop-Connection'], 'connection-1:4');
  assert.equal(headers['X-OPS-Desktop-Policy'], '8');
});

test('desktop headers are stripped from external, subframe, and server mode requests', () => {
  for (const input of [
    { requestUrl: 'https://attacker.example/api/v1/agent/runs', trustedBusinessMainFrame: true, mode: 'desktop' },
    { requestUrl: `${origin}/api/v1/agent/runs`, trustedBusinessMainFrame: false, mode: 'desktop' },
    { requestUrl: `${origin}/api/v1/agent/runs`, trustedBusinessMainFrame: true, mode: 'server' }
  ]) {
    const headers = buildDesktopRequestHeaders({
      ...input,
      businessOrigin: origin,
      requestContext: { deviceId: 'device-1', connectionId: 'connection-1', generation: 4, routeRevision: 8 },
      requestHeaders: { 'X-OPS-Desktop-Device': 'spoofed', 'x-ops-desktop-policy': 'spoofed', Accept: '*/*' }
    });
    assert.deepEqual(headers, { Accept: '*/*' });
  }
});

test('business API matching requires exact origin and the versioned API path', () => {
  assert.equal(isBusinessApiUrl(`${origin}/api/v1/works`, origin), true);
  assert.equal(isBusinessApiUrl(`${origin}/api/v1evil/works`, origin), false);
  assert.equal(isBusinessApiUrl(`https://ops.example.test.attacker.invalid/api/v1/works`, origin), false);
  assert.equal(isBusinessApiUrl(`${origin}/api/v1/works`, 'https://other.example.test'), false);
});

test('client mode blocks business API calls when their frame or applied context is unconfirmed', () => {
  const base = {
    requestUrl: `${origin}/api/v1/agent/runs`,
    businessOrigin: origin,
    isBusinessWindow: true,
    mode: 'desktop'
  };
  assert.equal(shouldBlockDesktopApiRequest({ ...base, trustedBusinessMainFrame: false, requestContextReady: true }), true);
  assert.equal(shouldBlockDesktopApiRequest({ ...base, trustedBusinessMainFrame: true, requestContextReady: false }), true);
  assert.equal(shouldBlockDesktopApiRequest({ ...base, trustedBusinessMainFrame: true, requestContextReady: true }), false);
  assert.equal(shouldBlockDesktopApiRequest({ ...base, mode: 'server', trustedBusinessMainFrame: false, requestContextReady: false }), false);
});

test('AI route detection includes business, agent, and effective AI status requests only', () => {
  assert.equal(isPotentialAiApiRequest(`${origin}/api/v1/sections/section-1/draft`, origin), true);
  assert.equal(isPotentialAiApiRequest(`${origin}/api/v1/agent/conversations/chat-1/messages`, origin), true);
  assert.equal(isPotentialAiApiRequest(`${origin}/api/v1/ai/status`, origin), true);
  assert.equal(isPotentialAiApiRequest(`${origin}/api/v1/works/work-1/sections`, origin), false);
  assert.equal(isPotentialAiApiRequest('https://other.example/api/v1/ai/status', origin), false);
});

test('AI route detection covers indirect job and memory endpoints', () => {
  for (const path of [
    '/api/v1/accounts/account-1/brief',
    '/api/v1/accounts/account-1/memories/distill',
    '/api/v1/accounts/account-1/retrieve',
    '/api/v1/accounts/account-1/plan/suggest',
    '/api/v1/accounts/account-1/reviews',
    '/api/v1/works/work-1/checks'
  ]) {
    assert.equal(isPotentialAiApiRequest(`${origin}${path}`, origin), true, path);
  }
});

test('a context refresh blocks AI calls without interrupting ordinary business APIs', () => {
  const base = {
    businessOrigin: origin,
    isBusinessWindow: true,
    trustedBusinessMainFrame: true,
    requestContextReady: false,
    mode: 'server',
    forceBlock: true
  };
  assert.equal(shouldBlockDesktopApiRequest({ ...base, requestUrl: `${origin}/api/v1/agent/bootstrap` }), true);
  assert.equal(shouldBlockDesktopApiRequest({ ...base, requestUrl: `${origin}/api/v1/works/work-1` }), false);
});

test('route application uses a draft only when its server revision still matches', () => {
  const server = [{ task_type: 'default', execution_location: 'desktop', provider_id: 'p1', model: 'm1', fallback_provider_id: null, fallback_model: '' }];
  const draft = [{ task_type: 'default', execution_location: 'desktop', provider_id: 'p2', model: 'm2', fallback_provider_id: null, fallback_model: '' }];
  const result = prepareDesktopRouteApplication({
    appliedRoutes: server,
    draftRoutes: draft,
    draftRevision: 3,
    policyRevision: 3
  });
  assert.deepEqual(result.routes, draft);
  assert.equal(result.needsCommit, true);
});

test('route application rejects stale drafts and requires at least one desktop route', () => {
  const serverRoute = [{ task_type: 'default', execution_location: 'server', provider_id: 'p1', model: 'm1', fallback_provider_id: null, fallback_model: '' }];
  assert.throws(() => prepareDesktopRouteApplication({
    appliedRoutes: serverRoute,
    draftRoutes: serverRoute,
    draftRevision: 2,
    policyRevision: 3
  }), /任务映射已变化/);
  assert.throws(() => prepareDesktopRouteApplication({
    appliedRoutes: serverRoute,
    policyRevision: 3
  }), /至少为一个任务配置本机模型/);
});
