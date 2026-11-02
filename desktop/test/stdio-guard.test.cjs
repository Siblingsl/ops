const assert = require('node:assert/strict');
const { test } = require('node:test');
const { isBrokenPipeError, safeConsoleError } = require('../.build/stdio-guard.js');

test('isBrokenPipeError recognizes EPIPE and EIO only', () => {
  assert.equal(isBrokenPipeError(Object.assign(new Error('pipe'), { code: 'EPIPE' })), true);
  assert.equal(isBrokenPipeError(Object.assign(new Error('io'), { code: 'EIO' })), true);
  assert.equal(isBrokenPipeError(Object.assign(new Error('other'), { code: 'ECONNRESET' })), false);
  assert.equal(isBrokenPipeError(new Error('plain')), false);
  assert.equal(isBrokenPipeError(null), false);
});

test('safeConsoleError swallows broken-pipe throws from console.error', () => {
  const original = console.error;
  console.error = () => {
    const err = new Error('broken pipe');
    err.code = 'EPIPE';
    throw err;
  };
  try {
    assert.doesNotThrow(() => safeConsoleError('should not escape'));
  } finally {
    console.error = original;
  }
});

test('safeConsoleError rethrows non-pipe console failures', () => {
  const original = console.error;
  console.error = () => {
    throw new Error('boom');
  };
  try {
    assert.throws(() => safeConsoleError('explode'), /boom/);
  } finally {
    console.error = original;
  }
});
