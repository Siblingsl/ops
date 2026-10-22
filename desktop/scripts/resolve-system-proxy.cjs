const { app, session } = require('electron');
const { parseSystemProxyResolution } = require('../.build/proxy.js');

const target = process.argv[2];

app.whenReady().then(async () => {
  try {
    const resolution = await session.defaultSession.resolveProxy(target);
    const route = parseSystemProxyResolution(resolution);
    process.stdout.write(`${route?.url ?? 'DIRECT'}\n`, () => app.quit());
  } catch {
    process.stderr.write('无法解析 Windows 系统代理配置。\n', () => app.exit(1));
  }
});
