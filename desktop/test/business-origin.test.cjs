const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DEFAULT_DEVELOPMENT_ORIGIN,
  PRODUCTION_API_ORIGIN,
  PRODUCTION_BUSINESS_UI_ORIGIN,
  PRODUCTION_SERVICE_NAMESPACE,
  isBusinessOriginUrl,
  resolveApiOrigin,
  resolveBusinessOrigin,
  resolveServiceNamespace
} = require('../.build/business-origin.js');

test('unpackaged client defaults to the local frontend with no environment configuration', () => {
  assert.equal(resolveBusinessOrigin(false), 'http://localhost:5174');
  assert.equal(DEFAULT_DEVELOPMENT_ORIGIN, 'http://localhost:5174');
});

test('packaged client stays on production even if a development URL is present', () => {
  assert.equal(resolveBusinessOrigin(true, 'http://localhost:5174'), PRODUCTION_BUSINESS_UI_ORIGIN);
  assert.equal(resolveApiOrigin(true, PRODUCTION_BUSINESS_UI_ORIGIN), 'https://ops-api.88813888.xyz');
  assert.equal(PRODUCTION_API_ORIGIN, 'https://ops-api.88813888.xyz');
  assert.equal(PRODUCTION_SERVICE_NAMESPACE, 'https://ops.88813888.xyz');
  assert.equal(resolveServiceNamespace(true, PRODUCTION_BUSINESS_UI_ORIGIN), PRODUCTION_SERVICE_NAMESPACE);
});

test('unpackaged client keeps an explicitly configured loopback origin', () => {
  assert.equal(resolveBusinessOrigin(false, 'http://localhost:5179/path'), 'http://localhost:5179');
  assert.equal(resolveApiOrigin(false, 'http://localhost:5179'), 'http://localhost:5179');
  assert.equal(resolveServiceNamespace(false, 'http://localhost:5179'), 'http://localhost:5179');
});

test('unpackaged client rejects invalid or non-loopback development URLs', () => {
  assert.throws(() => resolveBusinessOrigin(false, 'not a URL'), /有效的本地开发 URL/);
  assert.throws(() => resolveBusinessOrigin(false, 'https://example.com'), /只允许 localhost/);
});

test('business URL validation accepts the configured custom scheme and rejects lookalikes', () => {
  assert.equal(isBusinessOriginUrl('ops-desktop://business/', 'ops-desktop://business'), true);
  assert.equal(isBusinessOriginUrl('ops-desktop://business/login', 'ops-desktop://business'), true);
  assert.equal(isBusinessOriginUrl('ops-desktop-preview://business/login', 'ops-desktop://business'), false);
  assert.equal(isBusinessOriginUrl('ops-desktop://business.attacker/login', 'ops-desktop://business'), false);
  assert.equal(isBusinessOriginUrl('ops-desktop://user@business/login', 'ops-desktop://business'), false);
});

test('business URL validation keeps development HTTP origins exact', () => {
  assert.equal(isBusinessOriginUrl('http://localhost:5174/login', 'http://localhost:5174'), true);
  assert.equal(isBusinessOriginUrl('http://localhost:5175/login', 'http://localhost:5174'), false);
});
