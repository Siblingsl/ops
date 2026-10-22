const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, clipboard, dialog, session, shell } = require('electron');

const origin = process.env.OPS_DESKTOP_IO_TEST_ORIGIN;
const downloadDirectory = process.env.OPS_DESKTOP_IO_TEST_DOWNLOAD_DIR;
const downloads = [];
const externalUrls = [];
const externalPrompts = [];

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

app.whenReady().then(() => {
  const businessSession = session.fromPartition('persist:ops-business-development');
  businessSession.on('will-download', (_event, item) => {
    const filename = path.basename(item.getFilename());
    const destination = path.join(downloadDirectory, filename);
    item.setSavePath(destination);
    item.once('done', (_downloadEvent, state) => {
      downloads.push({ filename, destination, state });
    });
  });
});

shell.openExternal = async (url) => {
  externalUrls.push(url);
};

const showMessageBox = dialog.showMessageBox.bind(dialog);
dialog.showMessageBox = async (...args) => {
  const options = args.length === 1 ? args[0] : args[1];
  if (options?.title === '打开外部链接') {
    externalPrompts.push(options.message);
    return { response: 0 };
  }
  return showMessageBox(...args);
};

require(process.env.OPS_DESKTOP_MAIN_BUILD || path.resolve(__dirname, '..', '..', '.build', 'main.js'));

app.whenReady().then(async () => {
  try {
    const businessWindow = await waitFor(() => BrowserWindow.getAllWindows().find((window) =>
      window.webContents.getURL().startsWith(origin)
    ), 'the business window');
    await waitFor(() => !businessWindow.webContents.isLoadingMainFrame(), 'the business page load');
    businessWindow.show();
    businessWindow.focus();
    await waitFor(() => businessWindow.isVisible(), 'the visible business page');
    businessWindow.webContents.debugger.attach('1.3');
    const { root } = await businessWindow.webContents.debugger.sendCommand('DOM.getDocument', { depth: -1 });
    const { nodeId } = await businessWindow.webContents.debugger.sendCommand('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: '#file-input'
    });
    if (!nodeId) throw new Error('Could not locate the business file input.');
    await businessWindow.webContents.debugger.sendCommand('DOM.setFileInputFiles', {
      files: [process.env.OPS_DESKTOP_IO_TEST_UPLOAD_PATH],
      nodeId
    });
    await businessWindow.webContents.executeJavaScript('document.getElementById("upload-file").click()');
    await waitFor(async () => await businessWindow.webContents.executeJavaScript(
      'window.uploadResult === "upload-received"'
    ), 'the business file upload response');

    await businessWindow.webContents.executeJavaScript('document.getElementById("copy").click()', true);
    await waitFor(async () => await businessWindow.webContents.executeJavaScript(
      'window.clipboardResult === "written"'
    ), 'the clipboard write');
    await businessWindow.webContents.executeJavaScript('window.open("https://example.com/popup", "_blank")', true);
    await waitFor(() => externalUrls.includes('https://example.com/popup'), 'the external popup');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const externalLink = await businessWindow.webContents.executeJavaScript(`(() => {
      const rect = document.getElementById('same-window').getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`);
    await businessWindow.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: externalLink.x, y: externalLink.y
    });
    await businessWindow.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: externalLink.x, y: externalLink.y, button: 'left', clickCount: 1
    });
    await businessWindow.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: externalLink.x, y: externalLink.y, button: 'left', clickCount: 1
    });
    await waitFor(() => businessWindow.webContents.executeJavaScript('window.externalClickTrusted === true'), 'the trusted external link click');
    await waitFor(() => externalUrls.includes('https://example.com/same-window'), 'the same-window external navigation');
    await waitFor(() => businessWindow.webContents.getURL() === `${origin}/`, 'the business page to remain open');

    await businessWindow.webContents.executeJavaScript(`(() => {
      const blob = new Blob(['blob-download-e2e'], { type: 'application/zip' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = 'blob-export.zip';
      link.click();
    })()`);
    await waitFor(() => downloads.length === 1 && downloads[0].state === 'completed', 'the Blob download');

    await businessWindow.webContents.executeJavaScript('document.getElementById("attachment").click()');
    await waitFor(() => downloads.length === 2 && downloads.every((download) => download.state === 'completed'), 'the attachment download');

    const downloaded = downloads.map((download) => ({
      filename: download.filename,
      content: fs.readFileSync(download.destination, 'utf8')
    }));
    send({
      type: 'io-complete',
      clipboardText: await clipboard.readText(),
      externalUrls,
      externalPrompts,
      downloaded,
      uploadResponse: await businessWindow.webContents.executeJavaScript('window.uploadResult'),
      businessUrl: businessWindow.webContents.getURL(),
      bridgeType: await businessWindow.webContents.executeJavaScript('typeof window.opsDesktopSettings')
    });
  } catch (error) {
    send({
      type: 'failure',
      error: error instanceof Error ? error.stack : String(error),
      externalPrompts,
      externalUrls,
      downloads,
      windows: BrowserWindow.getAllWindows().map((window) => window.webContents.getURL())
    });
  }
});
