const path = require('node:path');
const { app } = require('electron');

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

app.whenReady().then(() => {
  send({ type: 'harness-ready' });
  const origin = process.env.OPS_DESKTOP_TEST_ORIGIN;
  const body = process.env.OPS_DESKTOP_TEST_BODY;
  const baseUrl = process.env.OPS_DESKTOP_TEST_BASE_URL ?? `${origin}/v1`;
  const apiKey = process.env.OPS_DESKTOP_TEST_API_KEY ?? '';
  const scenario = process.env.OPS_DESKTOP_TEST_SCENARIO ?? 'stream';
  const responseCredit = Number(process.env.OPS_DESKTOP_TEST_RESPONSE_CREDIT);
  if (!origin || !body || responseCredit !== 262144) {
    send({ type: 'failure', error: 'Invalid worker harness configuration.' });
    app.quit();
    return;
  }

  const { DesktopClient } = require(path.resolve(__dirname, '..', '..', '.build', 'desktop-client.js'));
  const client = new DesktopClient({}, origin);
  let targetUrl = '';
  let status = 0;
  let responseChunks = 0;
  let finished = false;
  const response = [];

  client.handleWorkerMessage = (message) => {
    if (message.type === 'worker-ready') {
      send({ type: 'worker-ready' });
      const now = Date.now();
      const bodyBytes = Buffer.from(body, 'utf8');
      client.worker.postMessage({
        type: 'request-open',
        requestId: 'c5b2a0a4-7a0e-4c3a-a07b-22ded555c189',
        baseUrl,
        apiKey,
        model: 'mock-model',
        operation: 'chat_completions',
        bodyLength: bodyBytes.length,
        deadlineMs: 15_000,
        deadlineAt: now + 15_000,
        providerId: 'e2e-provider',
        configRevision: 1,
        generation: 1,
        purpose: 'self_test'
      });
      client.worker.postMessage({
        type: 'request-data',
        requestId: 'c5b2a0a4-7a0e-4c3a-a07b-22ded555c189',
        data: new Uint8Array(bodyBytes)
      });
      client.worker.postMessage({ type: 'request-end', requestId: 'c5b2a0a4-7a0e-4c3a-a07b-22ded555c189' });
      return;
    }
    if (message.type === 'target-check') {
      targetUrl = message.targetUrl;
      send({ type: 'target-check', targetUrl });
      const target = new URL(targetUrl);
      client.worker.postMessage({
        type: 'target-check-result',
        requestId: message.requestId,
        allowed: target.origin === origin && target.pathname === '/v1/chat/completions'
      });
      return;
    }
    if (message.type === 'response-headers') {
      status = message.status;
      send({ type: 'response-headers', status });
      if (scenario === 'cancel') {
        finished = true;
        client.worker.postMessage({ type: 'request-cancel', requestId: message.requestId });
        send({ type: 'complete', terminalType: 'cancel-sent', targetUrl, status, responseChunks, responseBase64: '' });
        client.worker.postMessage({ type: 'shutdown' });
        return;
      }
      if (scenario === 'credential-echo-backpressure') {
        setTimeout(() => client.worker.postMessage({
          type: 'response-credit',
          requestId: message.requestId,
          count: responseCredit
        }), 100);
        return;
      }
      client.worker.postMessage({
        type: 'response-credit',
        requestId: message.requestId,
        count: responseCredit
      });
      return;
    }
    if (message.type === 'response-data') {
      responseChunks++;
      response.push(Buffer.from(message.data));
      return;
    }
    if (message.type === 'response-end') {
      finished = true;
      send({
        type: 'complete',
        terminalType: message.type,
        targetUrl,
        status,
        responseChunks,
        responseBase64: Buffer.concat(response).toString('base64')
      });
      client.worker.postMessage({ type: 'shutdown' });
      return;
    }
    if (message.type === 'request-error' || message.type === 'response-error') {
      finished = true;
      send({
        type: 'complete',
        terminalType: message.type,
        errorCode: message.code,
        targetUrl,
        status,
        responseChunks,
        responseBase64: Buffer.concat(response).toString('base64')
      });
      client.worker.postMessage({ type: 'shutdown' });
    }
  };
  client.startWorker();
  const worker = client.worker;
  worker.once('exit', (code) => {
    if (!finished) send({ type: 'failure', error: `worker exited before completion (${code})` });
    app.quit();
  });
}).catch((error) => {
  send({ type: 'failure', error: error instanceof Error ? error.message : String(error) });
  app.quit();
});
