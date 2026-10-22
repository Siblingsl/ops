const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const lifecyclePath = path.join(__dirname, '..', '.build', 'power-lifecycle.js');
const registerDesktopPowerHandlers = fs.existsSync(lifecyclePath)
  ? require(lifecyclePath).registerDesktopPowerHandlers
  : undefined;

test('system suspend disconnects desktop AI and resume refreshes status without reconnecting', () => {
  assert.equal(typeof registerDesktopPowerHandlers, 'function', 'system power events must control desktop AI lifecycle');

  const powerMonitor = new EventEmitter();
  const events = [];
  registerDesktopPowerHandlers(
    powerMonitor,
    () => events.push('disconnect'),
    () => events.push('refresh-status')
  );

  powerMonitor.emit('resume');
  assert.deepEqual(events, ['refresh-status']);

  powerMonitor.emit('suspend');
  assert.deepEqual(events, ['refresh-status', 'disconnect']);
});
