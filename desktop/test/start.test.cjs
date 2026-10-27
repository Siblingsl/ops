const assert = require('node:assert/strict');
const net = require('node:net');
const { test } = require('node:test');
const { defaultApiTarget, findAvailableVitePort } = require('../scripts/start.cjs');

test('desktop debug launcher defaults to the available remote HTTP API', () => {
  assert.equal(defaultApiTarget, 'https://ops-api.88813888.xyz');
});

test('desktop launcher chooses a fresh Vite port when 5174 is already occupied', async (t) => {
  const occupied = net.createServer();
  const ownsDefaultPort = await new Promise((resolve) => {
    occupied.once('error', () => resolve(false));
    occupied.listen(5174, 'localhost', () => resolve(true));
  });
  if (ownsDefaultPort) t.after(() => new Promise((resolve) => occupied.close(resolve)));

  const port = await findAvailableVitePort();
  assert.ok(port >= 5174 && port < 5200);
  if (ownsDefaultPort) assert.notEqual(port, 5174);

  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(port, 'localhost', resolve);
  });
  await new Promise((resolve) => probe.close(resolve));
});
