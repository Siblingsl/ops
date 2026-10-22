const path = require('node:path');
const assert = require('node:assert/strict');
const { app } = require('electron');

function makeClient(session = {}) {
  const { DesktopClient } = require(path.resolve(__dirname, '..', '..', '.build', 'desktop-client.js'));
  const client = new DesktopClient(session, 'https://scope-lifecycle.invalid');
  client.connectedUserId = 'user-before';
  client.connectedWorkspaceId = 'workspace-before';
  client.requestRouting = {
    mode: 'desktop',
    requestContext: { deviceId: 'device-before', connectionId: 'connection-before', generation: 1 }
  };
  return client;
}

function assertDisconnectedToServer(client, mode) {
  assert.equal(mode, 'server');
  assert.equal(client.channelState, 'disconnected');
  assert.equal(client.connectedUserId, null);
  assert.equal(client.connectedWorkspaceId, null);
  assert.deepEqual(client.getRequestRoutingState(), { mode: 'server', requestContext: {} });
}

app.whenReady().then(async () => {
  try {
    for (const [auth, label] of [
      [{ user_id: 'user-after', workspace: { id: 'workspace-before' } }, 'user'],
      [{ user_id: 'user-before', workspace: { id: 'workspace-after' } }, 'workspace']
    ]) {
      const client = makeClient();
      client.getAuthInfo = async () => auth;
      client.getWorkspace = async () => ({ account: { workspaces: {} }, workspace: { models: [], appliedMode: 'server' }, accountKey: '' });
      const mode = await client.restoreAppliedMode();
      assertDisconnectedToServer(client, mode);
      process.stdout.write(`${JSON.stringify({ type: 'scope-reset', scope: label })}\n`);
    }

    const logoutClient = makeClient({ cookies: { get: async () => [] } });
    logoutClient.getAuthInfo = async () => { throw new Error('session expired'); };
    const logoutMode = await logoutClient.restoreAppliedMode();
    assertDisconnectedToServer(logoutClient, logoutMode);
    process.stdout.write(`${JSON.stringify({ type: 'scope-reset', scope: 'logout' })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ type: 'failure', error: error instanceof Error ? error.stack : String(error) })}\n`);
    app.exit(1);
    return;
  }
  app.quit();
});
