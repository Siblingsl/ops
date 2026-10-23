const test = require('node:test');
const assert = require('node:assert/strict');
const { channelReconnectDelayMs } = require('../.build/reconnect-policy.js');

test('desktop channel reconnect uses bounded 1/2/4/8 second backoff', () => {
  assert.deepEqual([0, 1, 2, 3].map(channelReconnectDelayMs), [1000, 2000, 4000, 8000]);
  assert.equal(channelReconnectDelayMs(4), null);
  assert.equal(channelReconnectDelayMs(-1), null);
  assert.equal(channelReconnectDelayMs(1.5), null);
});
