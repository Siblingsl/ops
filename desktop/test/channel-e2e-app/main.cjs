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
