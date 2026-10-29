const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');

const rendererRoot = path.resolve(__dirname, '../renderer-src');
const viteEntry = path.join(rendererRoot, 'node_modules', 'vite', 'dist', 'node', 'index.js');
const configFile = path.join(rendererRoot, 'vite.config.ts');

test('desktop Vite sends remote API and WebSocket requests through a pinned system proxy agent', async () => {
  const priorTarget = process.env.OPS_API_TARGET;
  const priorProxy = process.env.OPS_API_PROXY;
  process.env.OPS_API_TARGET = 'https://192.0.2.1';
  process.env.OPS_API_PROXY = 'http://127.0.0.1:7890';

  try {
    const { loadConfigFromFile } = await import(pathToFileURL(viteEntry).href);
    const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, configFile, rendererRoot);
    const apiProxy = loaded.config.server.proxy['/api'];
    try {
      assert.equal(apiProxy.target, 'https://192.0.2.1');
      assert.equal(apiProxy.changeOrigin, true);
      assert.equal(apiProxy.ws, true);
      assert.equal(typeof apiProxy.agent?.createConnection, 'function');
    } finally {
      apiProxy.agent?.destroy();
    }
  } finally {
    if (priorTarget === undefined) delete process.env.OPS_API_TARGET;
    else process.env.OPS_API_TARGET = priorTarget;
    if (priorProxy === undefined) delete process.env.OPS_API_PROXY;
    else process.env.OPS_API_PROXY = priorProxy;
  }
});

test('desktop Vite sends remote HTTP API and WebSocket requests through the system proxy', async () => {
  const priorTarget = process.env.OPS_API_TARGET;
  const priorProxy = process.env.OPS_API_PROXY;
  process.env.OPS_API_TARGET = 'http://ops.88813888.xyz';
  process.env.OPS_API_PROXY = 'http://127.0.0.1:7890';

  try {
    const { loadConfigFromFile } = await import(pathToFileURL(viteEntry).href);
    const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, configFile, rendererRoot);
    const apiProxy = loaded.config.server.proxy['/api'];
    try {
      assert.equal(apiProxy.target, 'http://ops.88813888.xyz');
      assert.equal(apiProxy.changeOrigin, true);
      assert.equal(apiProxy.ws, true);
      assert.equal(apiProxy.agent?.constructor.name, 'HttpProxyAgent');
    } finally {
      apiProxy.agent?.destroy();
    }
  } finally {
    if (priorTarget === undefined) delete process.env.OPS_API_TARGET;
    else process.env.OPS_API_TARGET = priorTarget;
    if (priorProxy === undefined) delete process.env.OPS_API_PROXY;
    else process.env.OPS_API_PROXY = priorProxy;
  }
});
