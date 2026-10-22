const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const desktopRoot = path.resolve(__dirname, '..');
const harnessApp = path.join(__dirname, 'worker-e2e-app');
const desktopBinary = require('electron');
const requestBody = JSON.stringify({
  model: 'mock-model',
  messages: [{ role: 'user', content: 'hello' }],
  stream: false
});
const apiKey = 'loopback-e2e-key';

async function runWorkerScenario(t, scenario, key = apiKey, baseUrl) {
  let capturedRequest;
  let redirectedRequests = 0;
  let resolveUpstreamClosed;
  const upstreamClosed = new Promise((resolve) => { resolveUpstreamClosed = resolve; });
  const heldSockets = new Set();
  const responseBody = scenario.startsWith('credential-echo')
    ? JSON.stringify({ safe: 'this prefix is longer than the complete test credential', echo: apiKey })
    : scenario === 'unauthorized'
      ? JSON.stringify({ error: { message: 'invalid API key' } })
      : JSON.stringify({
        id: 'mock-response',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hello from loopback' }, finish_reason: 'stop' }]
      });

  const server = scenario === 'connect-timeout'
    ? net.createServer((socket) => {
      heldSockets.add(socket);
      socket.once('close', () => heldSockets.delete(socket));
    })
    : http.createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      if (request.url === '/redirect-target') {
        redirectedRequests++;
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(responseBody);
        return;
      }
      capturedRequest = {
        method: request.method,
        path: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8')
      };
      if (scenario === 'redirect') {
        response.writeHead(302, { Location: '/redirect-target', 'Content-Type': 'application/json' });
        response.end('{}');
        return;
      }
      response.writeHead(scenario === 'unauthorized' ? 401 : 200, { 'Content-Type': 'application/json; charset=utf-8' });
      if (scenario === 'cancel') {
        response.flushHeaders();
        response.once('close', () => resolveUpstreamClosed({ ended: response.writableEnded, requestAborted: request.aborted }));
        return;
      }
      if (scenario.startsWith('credential-echo')) {
        const splitAt = responseBody.indexOf(apiKey) + Math.floor(apiKey.length / 2);
        response.write(responseBody.slice(0, splitAt));
        setTimeout(() => response.end(responseBody.slice(splitAt)), 10);
        return;
      }
      const splitAt = Math.floor(responseBody.length / 2);
      response.write(responseBody.slice(0, splitAt));
      setTimeout(() => response.end(responseBody.slice(splitAt)), 10);
    });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  let child;
  let userDataPath;
  t.after(async () => {
    if (child?.exitCode === null && child.pid) {
      if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 5000))]);
    }
    for (const socket of heldSockets) socket.destroy();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    if (userDataPath) await fs.rm(userDataPath, { recursive: true, force: true });
  });

  const address = server.address();
  const origin = `${scenario === 'connect-timeout' ? 'https' : 'http'}://127.0.0.1:${address.port}`;
  userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ops-desktop-worker-e2e-'));
  child = spawn(desktopBinary, [
    `--user-data-dir=${userDataPath}`,
    '--disable-gpu',
    '--no-proxy-server',
    harnessApp
  ], {
    cwd: desktopRoot,
    env: {
      ...process.env,
      OPS_DESKTOP_TEST_ORIGIN: origin,
      ...(baseUrl ? { OPS_DESKTOP_TEST_BASE_URL: baseUrl } : {}),
      OPS_DESKTOP_TEST_BODY: requestBody,
      OPS_DESKTOP_TEST_API_KEY: key,
      OPS_DESKTOP_TEST_SCENARIO: scenario,
      OPS_DESKTOP_TEST_RESPONSE_CREDIT: '262144'
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });

  const outputLines = [];
  const stderr = [];
  let stdoutBuffer = '';
  let resolveResult;
  let rejectResult;
  const resultReady = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString('utf8');
    for (;;) {
      const newline = stdoutBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = stdoutBuffer.slice(0, newline);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      try {
        const message = JSON.parse(line);
        outputLines.push(message);
        if (message.type === 'complete') resolveResult(message);
        if (message.type === 'failure') rejectResult(new Error(`${message.error}; messages=${JSON.stringify(outputLines)}`));
      } catch {
        stderr.push(line);
      }
    }
  });
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString('utf8')));
  child.once('exit', (code, signal) => rejectResult(new Error(
    `Electron utility worker harness exited before completion (code=${code}, signal=${signal})`
  )));

  let timeout;
  const result = await Promise.race([
    resultReady,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(
        `Electron utility worker did not complete (${scenario}); messages=${JSON.stringify(outputLines)}; stderr=${stderr.join('').slice(-2000)}`
      )), scenario === 'connect-timeout' ? 15_000 : 8_000);
      timeout.unref();
    })
  ]).finally(() => clearTimeout(timeout));

  return {
    origin,
    responseBody,
    result,
    capturedRequest,
    redirectedRequests,
    upstreamClosed,
    targetChecks: outputLines.filter((message) => message.type === 'target-check')
  };
}

test('worker rejects IPv4 documentation ranges before asking the main process to connect', { timeout: 30_000 }, async (t) => {
  const { result, capturedRequest, targetChecks } = await runWorkerScenario(
    t,
    'blocked-documentation-address',
    apiKey,
    'https://192.0.2.10/v1'
  );
  assert.equal(result.terminalType, 'request-error');
  assert.equal(result.errorCode, 'offline');
  assert.equal(targetChecks.length, 0);
  assert.equal(capturedRequest, undefined);
});

test('worker allows routable addresses outside the IANA 192.0.0.0/24 special-purpose range through target validation', { timeout: 30_000 }, async (t) => {
  const { result, capturedRequest, targetChecks } = await runWorkerScenario(
    t,
    'routable-192-address',
    apiKey,
    'https://192.0.4.10/v1'
  );
  assert.equal(result.terminalType, 'request-error');
  assert.equal(result.errorCode, 'offline');
  assert.equal(targetChecks.length, 1);
  assert.equal(targetChecks[0].targetUrl, 'https://192.0.4.10/v1/chat/completions');
  assert.equal(capturedRequest, undefined);
});

test('worker rejects the IPv6 documentation prefix but permits addresses beyond its /20 boundary to target validation', { timeout: 45_000 }, async (t) => {
  const blocked = await runWorkerScenario(t, 'blocked-ipv6-documentation-address', apiKey, 'https://[3fff::10]/v1');
  assert.equal(blocked.result.errorCode, 'offline');
  assert.equal(blocked.targetChecks.length, 0);
  assert.equal(blocked.capturedRequest, undefined);

  const routable = await runWorkerScenario(t, 'routable-ipv6-address', apiKey, 'https://[3fff:1000::10]/v1');
  assert.equal(routable.result.errorCode, 'offline');
  assert.equal(routable.targetChecks.length, 1);
  assert.equal(routable.targetChecks[0].targetUrl, 'https://[3fff:1000::10]/v1/chat/completions');
  assert.equal(routable.capturedRequest, undefined);
});

test('real Electron utility process calls a loopback OpenAI-compatible API and streams the response', { timeout: 30_000 }, async (t) => {
  const { origin, responseBody, result, capturedRequest } = await runWorkerScenario(t, 'stream');
  assert.equal(result.targetUrl, `${origin}/v1/chat/completions`);
  assert.equal(result.status, 200);
  assert.equal(result.terminalType, 'response-end');
  assert.ok(result.responseChunks >= 2, 'loopback response should arrive in separate chunks');
  assert.equal(Buffer.from(result.responseBase64, 'base64').toString('utf8'), responseBody);
  assert.equal(capturedRequest.method, 'POST');
  assert.equal(capturedRequest.path, '/v1/chat/completions');
  assert.equal(capturedRequest.headers.authorization, `Bearer ${apiKey}`);
  assert.equal(capturedRequest.headers.cookie, undefined);
  assert.equal(capturedRequest.body, requestBody);
});

test('loopback API may omit authentication without sending an empty Bearer header', { timeout: 30_000 }, async (t) => {
  const { capturedRequest, result } = await runWorkerScenario(t, 'stream', '');
  assert.equal(result.terminalType, 'response-end');
  assert.equal(capturedRequest.headers.authorization, undefined);
});

test('loopback API 401 is returned to the Go caller without redirect or credential fallback', { timeout: 30_000 }, async (t) => {
  const { responseBody, result, capturedRequest, redirectedRequests } = await runWorkerScenario(t, 'unauthorized');
  assert.equal(result.status, 401);
  assert.equal(result.terminalType, 'response-end');
  assert.equal(Buffer.from(result.responseBase64, 'base64').toString('utf8'), responseBody);
  assert.equal(capturedRequest.headers.authorization, `Bearer ${apiKey}`);
  assert.equal(redirectedRequests, 0);
});

test('worker rejects upstream redirects without following them', { timeout: 30_000 }, async (t) => {
  const { origin, result, redirectedRequests } = await runWorkerScenario(t, 'redirect');
  assert.equal(result.targetUrl, `${origin}/v1/chat/completions`);
  assert.equal(result.terminalType, 'request-error');
  assert.equal(result.errorCode, 'redirect');
  assert.equal(redirectedRequests, 0);
});

test('worker blocks a known credential echoed across response chunks', { timeout: 30_000 }, async (t) => {
  const { result } = await runWorkerScenario(t, 'credential-echo');
  const safeResponse = Buffer.from(result.responseBase64, 'base64').toString('utf8');
  assert.equal(result.status, 200);
  assert.equal(result.terminalType, 'response-error');
  assert.equal(result.errorCode, 'credential_echo');
  assert.ok(result.responseChunks > 0, 'safe prefix may be forwarded before the credential is detected');
  assert.ok(!safeResponse.includes(apiKey), 'credential must not appear in any response chunk sent to the Go caller');
});

test('worker drains a queued safe prefix before reporting a credential echo', { timeout: 30_000 }, async (t) => {
  const { responseBody, result } = await runWorkerScenario(t, 'credential-echo-backpressure');
  const safeResponse = Buffer.from(result.responseBase64, 'base64').toString('utf8');
  assert.equal(result.terminalType, 'response-error');
  assert.equal(result.errorCode, 'credential_echo');
  assert.equal(safeResponse, responseBody.slice(0, responseBody.indexOf(apiKey)));
  assert.ok(!safeResponse.includes(apiKey), 'credential must not appear in any response chunk sent to the Go caller');
});

test('worker cancellation aborts an in-flight loopback request', { timeout: 30_000 }, async (t) => {
  const { result, upstreamClosed } = await runWorkerScenario(t, 'cancel');
  assert.equal(result.terminalType, 'cancel-sent');
  const closed = await Promise.race([
    upstreamClosed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('cancelled upstream request remained open')), 2000))
  ]);
  assert.equal(closed.ended, false);
});

test('worker bounds a stalled HTTPS handshake to ten seconds', { timeout: 30_000 }, async (t) => {
  const { result } = await runWorkerScenario(t, 'connect-timeout');
  assert.equal(result.terminalType, 'request-error');
  assert.equal(result.errorCode, 'timeout');
});
