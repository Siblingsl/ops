const path = require('node:path');
const { app, BrowserWindow, Menu, dialog, session, webContents } = require('electron');

const origin = process.env.OPS_DESKTOP_ACCOUNT_CLEAR_TEST_ORIGIN;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function waitFor(check, description, timeoutMs = 15_000) {
  const expiresAt = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        const value = await check();
        if (value) return resolve(value);
      } catch {}
      if (Date.now() >= expiresAt) return reject(new Error(`Timed out waiting for ${description}.`));
      setTimeout(poll, 50);
    };
    void poll();
  });
}

function accountDeviceSettingsContents() {
  return webContents.getAllWebContents().find((contents) =>
    contents.getURL().startsWith('ops-desktop://settings/embedded/account-device')
  );
}

dialog.showMessageBox = async (...args) => {
  const options = args.at(-1);
  const response = options.title === '清除此账号本机数据' ? 1 : 0;
  send({ type: 'dialog', title: options.title, response });
  return { response, checkboxChecked: false };
};

require(process.env.OPS_DESKTOP_MAIN_BUILD || path.resolve(__dirname, '..', '..', '.build', 'main.js'));

app.whenReady().then(async () => {
  try {
    const businessWindow = await waitFor(() => BrowserWindow.getAllWindows().find((window) =>
      window.webContents.getURL().startsWith(origin)
    ), 'the business window');
    await waitFor(async () => await businessWindow.webContents.executeJavaScript(
      "localStorage.getItem('ops-account-clear-e2e') === 'present'"
    ), 'the business storage marker');

    const settingsItem = Menu.getApplicationMenu()?.items
      .flatMap((item) => item.submenu?.items ?? [])
      .find((item) => item.label === 'AI 连接设置…');
    if (!settingsItem?.click) throw new Error('Could not find the native AI settings menu item.');
    settingsItem.click();

    const settingsContents = await waitFor(accountDeviceSettingsContents, 'the embedded account and device settings view');
    await waitFor(async () => await settingsContents.executeJavaScript(
      '!document.getElementById("clear-account-data").disabled'
    ), 'the enabled account cleanup control');
    await waitFor(() => {
      const item = Menu.getApplicationMenu()?.getMenuItemById('ops-native-client-status');
      return item?.label.includes('Account Cleanup Test') && item.label.includes('服务器 AI') ? item.label : null;
    }, 'the native workspace and AI mode status');
    const nativeStatus = Menu.getApplicationMenu()?.getMenuItemById('ops-native-client-status')?.label ?? '';
    const businessTitle = businessWindow.getTitle();
    const cookiesBefore = await session.fromPartition('persist:ops-business-development').cookies.get({
      url: origin,
      name: 'ops_session'
    });
    await settingsContents.executeJavaScript(
      'document.getElementById("clear-account-data").click()'
    );
    await waitFor(() => businessWindow.webContents.getURL().endsWith('/login'), 'the login page after cleanup');
    await waitFor(accountDeviceSettingsContents, 'the refreshed embedded account and device settings view');

    const cookiesAfter = await session.fromPartition('persist:ops-business-development').cookies.get({
      url: origin,
      name: 'ops_session'
    });
    const storageAfter = await businessWindow.webContents.executeJavaScript(
      "localStorage.getItem('ops-account-clear-e2e')"
    );
    send({
      type: 'account-cleared',
      cookiesBefore: cookiesBefore.length,
      cookiesAfter: cookiesAfter.length,
      storageAfter,
      businessUrl: businessWindow.webContents.getURL(),
      nativeStatus,
      businessTitle
    });
    app.quit();
  } catch (error) {
    const settingsContents = accountDeviceSettingsContents();
    const clientInfo = settingsContents && !settingsContents.isDestroyed()
      ? await settingsContents.executeJavaScript('window.opsDesktopSettings.getInfo().catch((error) => String(error))').catch(String)
      : null;
    const pageState = settingsContents && !settingsContents.isDestroyed()
      ? await settingsContents.executeJavaScript('({ ready: document.readyState, hasBridge: Boolean(window.opsDesktopSettings), button: document.getElementById("clear-account-data")?.disabled, status: document.getElementById("action-status")?.textContent })').catch(String)
      : null;
    const cookies = await session.fromPartition('persist:ops-business-development').cookies.get({ url: origin }).catch(() => []);
    send({
      type: 'failure',
      error: error instanceof Error ? error.message : String(error),
      windows: BrowserWindow.getAllWindows().map((window) => window.webContents.getURL()),
      clientInfo,
      pageState,
      cookies: cookies.map((cookie) => ({ name: cookie.name, value: cookie.value }))
    });
    app.quit();
  }
});
