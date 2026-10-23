const path = require('node:path');
const { app, BrowserWindow, dialog } = require('electron');

const origin = process.env.OPS_DESKTOP_QUIT_TEST_ORIGIN;
const responses = JSON.parse(process.env.OPS_DESKTOP_QUIT_TEST_RESPONSES || '[0]');

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

dialog.showMessageBox = async (...args) => {
  const options = args.at(-1);
  if (options.title === '已取消退出') {
    send({ type: 'quit-guard-warning', title: options.title, message: options.message, detail: options.detail });
    return { response: 0, checkboxChecked: false };
  }
  const response = responses.shift() ?? 0;
  send({
    type: 'quit-dialog',
    title: options.title,
    message: options.message,
    detail: options.detail,
    buttons: options.buttons,
    response
  });
  if (response === 0) {
    setTimeout(() => {
      const window = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().startsWith(origin));
      send({ type: 'quit-cancelled', windowOpen: Boolean(window && !window.isDestroyed()) });
      if (responses.length > 0 && window && !window.isDestroyed()) setTimeout(() => window.close(), 100);
    }, 100);
  }
  return { response, checkboxChecked: false };
};

app.on('browser-window-created', (_event, window) => {
  window.webContents.on('did-finish-load', () => {
    if (window.webContents.getURL().startsWith(origin)) setTimeout(() => window.close(), 100);
  });
});

require(path.resolve(__dirname, '..', '..', '.build', 'main.js'));
