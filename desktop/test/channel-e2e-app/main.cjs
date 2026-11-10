const path = require('node:path');
const { app, session } = require('electron');

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

app.whenReady().then(async () => {
  const origin = process.env.OPS_DESKTOP_CHANNEL_TEST_ORIGIN;
  if (!origin) throw new Error('Missing channel test origin.');

  const { DesktopClient } = require(path.resolve(__dirname, '..', '..', '.build', 'desktop-client.js'));
  const businessSession = session.fromPartition('persist:ops-desktop-channel-e2e');
  const sessionToken = process.env.OPS_DESKTOP_CHANNEL_TEST_SESSION;
  if (sessionToken) {
    await businessSession.cookies.set({
      url: origin,
      name: 'ops_session',
      value: sessionToken,
      httpOnly: true,
      secure: new URL(origin).protocol === 'https:',
      sameSite: 'lax'
    });
  }
  const client = new DesktopClient(businessSession, origin);
  const localModelBaseUrl = process.env.OPS_DESKTOP_CHANNEL_TEST_LOCAL_MODEL_URL;
  let coldStartModel;
  if (localModelBaseUrl) {
    [coldStartModel] = await client.saveModel({
      name: 'Cold start integration',
      baseUrl: localModelBaseUrl,
      models: ['cold-start-test'],
      apiKey: 'local-test-key'
    });
  }
  await client.connect();
  if (coldStartModel) {
    const modelTest = await client.startModelTest(coldStartModel.providerId, 'cold-start-test');
    let modelTestResult;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      modelTestResult = await client.getModelTest(modelTest.test_id);
      if (modelTestResult.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (modelTestResult?.status !== 'completed') {
      throw new Error(`Local model text/JSON self-test did not complete: ${JSON.stringify(modelTestResult)}; channel=${JSON.stringify(await client.getPublicState())}`);
    }

    const routeState = await client.listDesktopRoutes();
    const routes = routeState.routes.filter((route) => route.task_type !== 'default');
    routes.push({
      task_type: 'default',
      execution_location: 'desktop',
      provider_id: coldStartModel.providerId,
      model: 'cold-start-test',
      fallback_provider_id: null,
      fallback_model: ''
    });
    await client.saveDesktopRoutes(routes, routeState.policy_revision);
    await client.applyMode('desktop');
  }
  const cancelRequestId = process.env.OPS_DESKTOP_CHANNEL_CANCEL_REQUEST_ID;
  if (cancelRequestId) {
    if (!client.worker) throw new Error('Missing WSS cancellation test worker.');
    client.pending.set(cancelRequestId, { id: cancelRequestId, parentRequestId: null });
    const worker = client.worker;
    const postMessage = worker.postMessage.bind(worker);
    worker.postMessage = (message) => {
      if (message?.type === 'request-cancel' && message.requestId === cancelRequestId) {
        send({ type: 'cancel-relayed', requestId: cancelRequestId });
      }
      return postMessage(message);
    };
  }
  send({
    type: 'connected',
    state: await client.getPublicState(),
    routing: client.getRequestRoutingState(),
    ...(coldStartModel ? { coldStartProviderId: coldStartModel.providerId } : {})
  });

  if (!sessionToken) {
    setTimeout(() => {
      client.disconnect();
      send({ type: 'disconnected', state: client.channelState });
      setTimeout(() => app.quit(), 300);
    }, 17_000);
    return;
  }

  const testRequestId = '00000000-0000-4000-8000-000000000001';
  client.pending.set(testRequestId, { id: testRequestId, parentRequestId: null });
  let cancelObserved = false;
  if (!client.worker || !client.socket) throw new Error('Missing live worker or WSS connection for reconnect test.');
  const worker = client.worker;
  const postMessage = worker.postMessage.bind(worker);
  worker.postMessage = (message) => {
    if (message?.type === 'request-cancel' && message.requestId === testRequestId) cancelObserved = true;
    return postMessage(message);
  };
  const initialSocket = client.socket;
  // DT-07（2026-11-11）：本用例验证「服务器断开后客户端不自动重连、等待手动重连」
  // 语义（Go 侧断言 generation 不得自动递增，desktop_channel_test.go:322）。客户端
  // 自带 1/2/4/8s 自动重连策略（reconnect-policy），断开后 1s 即自动重连会让本场景
  // 失真——夹具在此挂起自动重连，使断开后的状态与手动 connect() 与设计一致。
  // suppressReconnect 语义与 disconnect() 相同（reconnectSuppressed=true），但不做
  // teardown：保留 pending 清理与 cancel 观测的真实路径。
  client.suppressReconnectForTest();
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Test server did not close the initial WSS connection.')), 50_000);
    initialSocket.once('close', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  await new Promise((resolve) => setTimeout(resolve, 3000));
  if (client.socket !== null || client.channelState !== 'error' || client.pending.size !== 0 || !cancelObserved) {
    throw new Error(`Disconnected channel did not cancel and clear pending work: state=${client.channelState}; pending=${client.pending.size}; cancel=${cancelObserved}`);
  }
  send({
    type: 'connection-lost',
    channelState: client.channelState,
    pendingCount: client.pending.size,
    cancelObserved
  });

  await client.connect();
  send({
    type: 'reconnected',
    state: await client.getPublicState(),
    routing: client.getRequestRoutingState(),
    generation: client.generation,
    pendingCount: client.pending.size
  });

  setTimeout(() => {
    client.disconnect();
    send({ type: 'disconnected', state: client.channelState });
    setTimeout(() => app.quit(), 300);
  }, 300);
}).catch((error) => {
  send({ type: 'failure', error: error instanceof Error ? error.message : String(error) });
  app.quit();
});
