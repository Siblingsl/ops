const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');

const desktopRoot = path.resolve(__dirname, '..');
const projectRoot = path.resolve(desktopRoot, '..');
const webRoot = path.join(projectRoot, 'web');
const viteCli = path.join(webRoot, 'node_modules', 'vite', 'bin', 'vite.js');
const forgeStartCli = path.join(desktopRoot, 'node_modules', '@electron-forge', 'cli', 'dist', 'electron-forge-start.js');
let localOrigin = 'http://localhost:5174';
const defaultApiTarget = 'http://ops.88813888.xyz';
const proxyResolver = path.join(desktopRoot, 'scripts', 'resolve-system-proxy.cjs');
let viteProcess = null;
let forgeProcess = null;
let stopping = false;
let viteStartupError = null;

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function resolveSystemApiProxy(target) {
  const resolverEnv = { ...process.env };
  delete resolverEnv.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [proxyResolver, target], {
    cwd: desktopRoot,
    env: resolverEnv,
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true
  });
  if (result.error || result.status !== 0) {
    throw new Error('无法读取 Windows 系统代理，桌面客户端未启动。');
  }

  const route = result.stdout.trim();
  if (route === 'DIRECT') return '';
  try {
    const proxy = new URL(route);
    if (!['http:', 'https:'].includes(proxy.protocol) || !proxy.hostname || proxy.username || proxy.password
      || (proxy.pathname !== '/' && proxy.pathname !== '') || proxy.search || proxy.hash) {
      throw new Error('invalid proxy');
    }
    return `${proxy.protocol}//${proxy.host}`;
  } catch {
    throw new Error('Windows 系统代理返回了客户端不支持的代理地址，桌面客户端未启动。');
  }
}

async function isProjectViteReady() {
  try {
    const response = await fetch(localOrigin, { signal: AbortSignal.timeout(1000) });
    return response.ok && (await response.text()).includes('/src/main.tsx');
  } catch {
    return false;
  }
}

async function findAvailableVitePort() {
  for (let port = 5174; port < 5200; port += 1) {
    const available = await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen(port, 'localhost', () => server.close(() => resolve(true)));
    });
    if (available) return port;
  }
  throw new Error('没有可用的 Electron 前端端口（5174–5199）。');
}

async function waitForVite() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await isProjectViteReady()) return;
    if (viteStartupError || viteProcess?.exitCode !== null) throw new Error('新版前端启动失败，请检查上方 Vite 输出。');
    await wait(250);
  }
  throw new Error('等待新版前端超时，请检查端口 5174 和 Vite 输出。');
}

function stop() {
  if (stopping) return;
  stopping = true;
  if (viteProcess && viteProcess.exitCode === null) viteProcess.kill();
  if (forgeProcess && forgeProcess.exitCode === null) forgeProcess.kill();
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

async function main() {
  if (!process.env.OPS_DESKTOP_DEV_URL) {
    if (!fs.existsSync(viteCli)) throw new Error('未找到 web/node_modules/vite，请先按项目说明安装前端依赖。');

    const port = await findAvailableVitePort();
    localOrigin = `http://localhost:${port}`;
    const apiTarget = process.env.OPS_API_TARGET || defaultApiTarget;
    const apiHost = new URL(apiTarget).hostname.toLowerCase();
    const localApi = ['localhost', '127.0.0.1', '[::1]'].includes(apiHost);
    const apiProxy = process.env.OPS_API_PROXY || (localApi ? '' : resolveSystemApiProxy(apiTarget));
    viteProcess = spawn(process.execPath, [viteCli, '--host', 'localhost', '--port', String(port), '--strictPort'], {
      cwd: webRoot,
      env: { ...process.env, BROWSER: 'none', OPS_API_TARGET: apiTarget, OPS_API_PROXY: apiProxy },
      stdio: 'inherit',
      windowsHide: true
    });
    viteProcess.on('error', (error) => {
      viteStartupError = error;
      console.error(`无法启动 Vite：${error.message}`);
    });
    await waitForVite();
    process.env.OPS_DESKTOP_DEV_URL = localOrigin;
  }

  if (!fs.existsSync(forgeStartCli)) throw new Error('未找到 Electron Forge，请先按项目说明安装桌面端依赖。');
  forgeProcess = spawn(process.execPath, [forgeStartCli], {
    cwd: desktopRoot,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true
  });
  forgeProcess.on('error', (error) => console.error(`无法启动 Electron：${error.message}`));
  forgeProcess.on('exit', (code) => {
    stop();
    process.exitCode = code ?? 0;
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    stop();
    process.exitCode = 1;
  });
}

module.exports = { defaultApiTarget, findAvailableVitePort };
