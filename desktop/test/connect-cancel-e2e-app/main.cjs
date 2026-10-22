const path = require('node:path');
const { app, session } = require('electron');

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

app.whenReady().then(() => {
  const origin = process.env.OPS_DESKTOP_CONNECT_CANCEL_ORIGIN;
  if (!origin) throw new Error('Missing connection cancellation test origin.');

  const { DesktopClient } = require(path.resolve(__dirname, '..', '..', '.build', 'desktop-client.js'));
  const businessSession = session.fromPartition('persist:ops-desktop-connect-cancel');
  const originalFetch = businessSession.fetch.bind(businessSession);
  const client = new DesktopClient(businessSession, origin);
  let disconnected = false;
  businessSession.fetch = async (input, init) => {
    const response = await originalFetch(input, init);
    if (!disconnected && new URL(input).pathname === '/api/v1/auth/me') {
      disconnected = true;
      client.disconnect();
      send({ type: 'disconnected' });
    }
    return response;
  };
  const connect = client.connect().then(
    () => ({ ok: true }),
    (error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) })
  );
  send({ type: 'attempt-started' });

  connect.then((result) => {
    send({
      type: 'settled',
      ...result,
      channelState: client.channelState,
      socketPresent: Boolean(client.socket),
      workerPresent: Boolean(client.worker),
      routing: client.getRequestRoutingState()
    });
    app.quit();
  });
}).catch((error) => {
  send({ type: 'failure', error: error instanceof Error ? error.message : String(error) });
  app.quit();
});
