const assert = require('node:assert/strict');
const test = require('node:test');
const { DEFAULT_DEVELOPMENT_ORIGIN, PRODUCTION_ORIGIN, resolveBusinessOrigin } = require('../.build/business-origin.js');

test('unpackaged client defaults to the local frontend with no environment configuration', () => {
  assert.equal(resolveBusinessOrigin(false), 'http://localhost:5174');
  assert.equal(DEFAULT_DEVELOPMENT_ORIGIN, 'http://localhost:5174');
});

test('packaged client stays on production even if a development URL is present', () => {
  assert.equal(resolveBusinessOrigin(true, 'http://localhost:5174'), PRODUCTION_ORIGIN);
});

test('unpackaged client keeps an explicitly configured loopback origin', () => {
  assert.equal(resolveBusinessOrigin(false, 'http://localhost:5179/path'), 'http://localhost:5179');
});

test('unpackaged client rejects invalid or non-loopback development URLs', () => {
  assert.throws(() => resolveBusinessOrigin(false, 'not a URL'), /有效的本地开发 URL/);
  assert.throws(() => resolveBusinessOrigin(false, 'https://example.com'), /只允许 localhost/);
});
