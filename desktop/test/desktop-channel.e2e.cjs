const assert = require('node:assert/strict');
const { createHash, createPublicKey, randomBytes, randomUUID, verify } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const WebSocket = require('ws');

const desktopRoot = path.resolve(__dirname, '..');
const harnessApp = path.join(__dirname, 'channel-e2e-app');
const desktopBinary = require('electron');
const rawEd25519PublicKeyPrefix = Buffer.from('302a300506032b6570032100', 'hex');

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

function publicKeyObject(publicKey) {
  return createPublicKey({
    key: Buffer.concat([rawEd25519PublicKeyPrefix, Buffer.from(publicKey, 'base64')]),
    format: 'der',
    type: 'spki'
  });
}

test('real Electron authenticates and opens a one-use desktop channel, then heartbeats and disconnects', { timeout: 45_000 }, async (t) => {
  const userId = randomUUID();
  const workspaceId = randomUUID();
  const challenges = new Map();
  const usedTickets = new Set();
  const httpRequests = [];
  const channel = {
    ticket: `channel-ticket-${randomBytes(16).toString('hex')}`,
    connectionId: randomUUID(),
    generation: 3,
    routeRevision: 7,
    cancelRequestId: randomUUID(),
    upgrade: null,
    ready: null,
    heartbeats: 0,
    closeCode: null,
    registeredDevice: null
  };
  let resolveChannelClosed;
  const channelClosed = new Promise((resolve) => { resolveChannelClosed = resolve; });

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    httpRequests.push({ method: request.method, path: url.pathname });
    const body = await readBody(request);

    if (url.pathname === '/api/v1/auth/me' && request.method === 'GET') {
      sendJson(response, 200, {
        csrf_token: 'local-channel-e2e-csrf',
        user_id: userId,
        username: 'desktop-channel-e2e',
        reauth_ok: true,
        workspace: { id: workspaceId, name: 'Local WSS Test', role: 'owner' }
      });
      return;
    }

    if (url.pathname === '/api/v1/desktop/capabilities' && request.method === 'GET') {
      sendJson(response, 200, { protocol_version: 1 });
      return;
    }

    if (url.pathname === '/api/v1/desktop/challenges' && request.method === 'POST') {
      const input = JSON.parse(body.toString('utf8'));
      const challengeId = randomUUID();
      const signaturePayload = randomBytes(48);
      challenges.set(challengeId, {
        challengeId,
        deviceId: input.device_id,
        operation: input.operation,
        method: input.method,
        path: input.path,
        bodyHash: input.body_sha256,
        publicKey: input.public_key ?? channel.registeredDevice?.public_key,
        signaturePayload
      });
      sendJson(response, 200, {
        challenge_id: challengeId,
        signature_payload: signaturePayload.toString('base64')
      });
      return;
    }

    if (url.pathname === '/api/v1/desktop/devices' && request.method === 'POST') {
      const input = JSON.parse(body.toString('utf8'));
      if (!verifyProof(request, body, 'device.register', '/api/v1/desktop/devices', input.id)) {
        sendJson(response, 403, { error: { message: 'invalid device registration proof' } });
        return;
      }
      channel.registeredDevice = input;
      sendJson(response, 200, { ok: true });
      return;
    }

    if (url.pathname === '/api/v1/desktop/models' && request.method === 'GET') {
      if (request.headers['x-ops-desktop-device'] !== channel.registeredDevice?.id) {
        sendJson(response, 403, { error: { message: 'device scope mismatch' } });
        return;
      }
      sendJson(response, 200, { models: [], policy_revision: channel.routeRevision });
      return;
    }

    if (url.pathname === '/api/v1/desktop/routes' && request.method === 'GET') {
      if (request.headers['x-ops-desktop-device'] !== channel.registeredDevice?.id) {
        sendJson(response, 403, { error: { message: 'device scope mismatch' } });
        return;
      }
      sendJson(response, 200, { routes: [], policy_revision: channel.routeRevision });
      return;
    }

    if (url.pathname === '/api/v1/desktop/connections' && request.method === 'POST') {
      const input = JSON.parse(body.toString('utf8'));
      if (!verifyProof(request, body, 'connection.create', '/api/v1/desktop/connections', input.device_id)
        || input.device_id !== channel.registeredDevice?.id || input.route_revision !== channel.routeRevision) {
        sendJson(response, 403, { error: { message: 'invalid connection proof or scope' } });
        return;
      }
      sendJson(response, 200, {
        ticket: channel.ticket,
        connection_id: channel.connectionId,
        generation: channel.generation,
        route_revision: channel.routeRevision
      });
      return;
    }

    sendJson(response, 404, { error: { message: 'not found' } });
  });

  function verifyProof(request, body, operation, expectedPath, deviceId) {
    const challengeId = request.headers['x-ops-desktop-challenge'];
    const challenge = challenges.get(challengeId);
    challenges.delete(challengeId);
    if (!challenge || challenge.operation !== operation || challenge.method !== request.method
      || challenge.path !== expectedPath || challenge.deviceId !== deviceId
      || challenge.bodyHash !== createHash('sha256').update(body).digest('hex')
      || request.headers['x-ops-desktop-device'] !== deviceId || !challenge.publicKey) return false;
    const signature = Buffer.from(request.headers['x-ops-desktop-signature'] ?? '', 'base64');
    return verify(null, challenge.signaturePayload, publicKeyObject(challenge.publicKey), signature);
  }

  const wss = new WebSocket.Server({ noServer: true, perMessageDeflate: false, maxPayload: 64 * 1024 + 20 });
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const token = request.headers.authorization?.replace(/^Bearer /, '');
    const hasDesktopHeader = Object.keys(request.headers).some((name) => name.startsWith('x-ops-desktop-'));
    channel.upgrade = {
      path: url.pathname,
      query: url.search,
      authorization: request.headers.authorization,
      origin: request.headers.origin,
      cookie: request.headers.cookie,
      hasDesktopHeader
    };
    if (url.pathname !== '/api/v1/desktop/channel' || url.search || request.headers.origin
      || request.headers.cookie || hasDesktopHeader || token !== channel.ticket || usedTickets.has(token)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    usedTickets.add(token);
    wss.handleUpgrade(request, socket, head, (connection) => {
      wss.emit('connection', connection, request);
    });
  });
  wss.on('connection', (connection) => {
    connection.send(JSON.stringify({
      type: 'channel.hello',
      route_revision: channel.routeRevision,
      generation: channel.generation,
      protocol_version: 1
    }));
    connection.on('message', (raw, isBinary) => {
      if (isBinary) return connection.close(1002, 'unexpected binary control');
      let message;
      try {
        message = JSON.parse(raw.toString('utf8'));
      } catch {
        return connection.close(1002, 'invalid control');
      }
      if (message.type === 'channel.ready') {
        channel.ready = message;
        connection.send(JSON.stringify({ type: 'channel.ready_ack', generation: channel.generation }));
      } else if (message.type === 'channel.heartbeat') {
        channel.heartbeats++;
        connection.send(JSON.stringify({ type: 'channel.heartbeat_ack' }));
        if (channel.heartbeats === 1) {
          connection.send(JSON.stringify({
            type: 'request.cancel',
            request_id: channel.cancelRequestId,
            reason: 'cancelled'
          }));
        }
      } else {
        connection.close(1002, 'unexpected control');
      }
    });
    connection.on('close', (code) => {
      channel.closeCode = code;
      resolveChannelClosed(code);
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ops-desktop-channel-e2e-'));
  const child = spawn(desktopBinary, [
    `--user-data-dir=${userDataPath}`,
    '--disable-gpu',
    '--no-proxy-server',
    harnessApp
  ], {
    cwd: desktopRoot,
    env: {
      ...process.env,
      OPS_DESKTOP_CHANNEL_TEST_ORIGIN: origin,
      OPS_DESKTOP_CHANNEL_CANCEL_REQUEST_ID: channel.cancelRequestId
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });

  const output = [];
  const stderr = [];
  let stdoutBuffer = '';
  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
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
        output.push(message);
        if (message.type === 'disconnected') resolveDone(message);
        if (message.type === 'failure') rejectDone(new Error(`${message.error}; output=${JSON.stringify(output)}`));
      } catch {
        stderr.push(line);
      }
    }
  });
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString('utf8')));
  child.once('exit', (code, signal) => {
    if (!output.some((message) => message.type === 'disconnected')) {
      rejectDone(new Error(`Electron channel harness exited early (code=${code}, signal=${signal}); stderr=${stderr.join('').slice(-2000)}`));
    }
  });

  t.after(async () => {
    if (child.exitCode === null && child.pid) {
      if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 5000))]);
    }
    for (const connection of wss.clients) connection.terminate();
    await new Promise((resolve) => wss.close(resolve));
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(userDataPath, { recursive: true, force: true });
  });

  const finalMessage = await Promise.race([
    done,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(
        `Electron WSS channel did not finish; output=${JSON.stringify(output)}; requests=${JSON.stringify(httpRequests)}; stderr=${stderr.join('').slice(-2000)}`
      )), 35_000);
      timer.unref();
    })
  ]);

  const connected = output.find((message) => message.type === 'connected');
  assert.ok(connected, `Electron did not report ready: ${JSON.stringify(output)}`);
  assert.equal(connected.state.channelState, 'ready');
  assert.equal(connected.state.deviceRegistered, true);
  assert.equal(connected.routing.requestContext.deviceId, channel.registeredDevice.id);
  assert.equal(connected.routing.requestContext.connectionId, channel.connectionId);
  assert.equal(connected.routing.requestContext.generation, channel.generation);
  assert.equal(connected.routing.requestContext.routeRevision, channel.routeRevision);
  assert.deepEqual(channel.ready, { type: 'channel.ready', configs: [] });
  assert.ok(channel.heartbeats >= 1, 'Electron should send its 15-second heartbeat and accept the acknowledgement');
  assert.ok(output.some((message) => message.type === 'cancel-relayed'
    && message.requestId === channel.cancelRequestId), 'WSS request.cancel should reach the Electron utility process');
  assert.equal(finalMessage.state, 'disconnected');
  await Promise.race([
    channelClosed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('WSS close was not observed')), 2000))
  ]);
  assert.equal(channel.closeCode, 1000);
  assert.deepEqual(channel.upgrade, {
    path: '/api/v1/desktop/channel',
    query: '',
    authorization: `Bearer ${channel.ticket}`,
    origin: undefined,
    cookie: undefined,
    hasDesktopHeader: false
  });
  assert.ok(httpRequests.some((request) => request.path === '/api/v1/desktop/devices'));
  assert.ok(httpRequests.some((request) => request.path === '/api/v1/desktop/connections'));

  const replay = new WebSocket(`${origin.replace(/^http:/, 'ws:')}/api/v1/desktop/channel`, {
    headers: { Authorization: `Bearer ${channel.ticket}` }
  });
  const replayStatus = await new Promise((resolve, reject) => {
    replay.once('open', () => reject(new Error('one-use channel ticket was accepted twice')));
    replay.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode);
    });
    replay.once('error', reject);
  });
  assert.equal(replayStatus, 401);
});
