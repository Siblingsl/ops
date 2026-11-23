'use strict';
// B-06.5 / B-12.6 开发期观察工具：真实 Chrome + 测试账号手动走查。
//
// 只用于开发/运营期：
//   * 网络响应先经 `network-redaction` 脱敏再落盘，原始 body 不落盘；
//   * 点击/输入只记录 selector/role/name，password 值置空并标 redacted；
//   * 产物写到临时目录，不进仓库；核对完由使用者删除。
//
// 运行：
//   node desktop/scripts/observe-platform.cjs --out <dir> [--chrome <path>]
// 脚本会打开两个标签（小红书创作中心 / 公众号后台），等待 `stop.flag` 出现后
// 落盘 network.json / steps.json 并关闭浏览器。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PLAYWRIGHT = path.resolve(ROOT, '..', 'renderer', 'node_modules', '@playwright', 'test');
const { chromium } = require(PLAYWRIGHT);
const { NetworkCaptureBudget, Redactor } = require(path.resolve(ROOT, '.build', 'platforms', 'network-redaction.js'));

const DEFAULT_CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const START_URLS = [
  { platform: 'xhs', url: 'https://creator.xiaohongshu.com/new/note-manager' },
  { platform: 'wechat_mp', url: 'https://mp.weixin.qq.com/' }
];

function parseArgs(argv) {
  const out = { out: path.join(os.tmpdir(), `ops-observe-${Date.now()}`), chrome: DEFAULT_CHROME };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out' && argv[i + 1]) out.out = path.resolve(argv[++i]);
    else if (argv[i] === '--chrome' && argv[i + 1]) out.chrome = argv[++i];
  }
  return out;
}

const RECORDER_SOURCE = `(() => {
  if (window.__opsRecorderInstalled) return;
  window.__opsRecorderInstalled = true;
  window.__opsSteps = window.__opsSteps || [];
  const send = (step) => { window.__opsSteps.push(step); };
  // 步骤只保留 origin+pathname：公众号后台 URL 的 token query 不能进演示步骤。
  const pageUrl = () => location.origin + location.pathname;
  const text = (value) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
  const cssEscape = (value) => (window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/["\\\\]/g, '\\\\$&'));
  const unique = (selector) => {
    try { return document.querySelectorAll(selector).length === 1; } catch { return false; }
  };
  const selectorFor = (el) => {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) { const s = '#' + cssEscape(el.id); if (unique(s)) return s; }
    for (const attr of ['data-testid', 'data-test', 'name', 'aria-label']) {
      const value = el.getAttribute(attr);
      if (!value) continue;
      const s = '[' + attr + '="' + String(value).replace(/"/g, '\\\\"') + '"]';
      if (unique(s)) return s;
    }
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body && parts.length < 6) {
      const tag = node.tagName.toLowerCase();
      const siblings = Array.prototype.filter.call(node.parentElement ? node.parentElement.children : [], (n) => n.tagName === node.tagName);
      const index = siblings.length > 1 ? ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')' : '';
      parts.unshift(tag + index);
      node = node.parentElement;
    }
    return parts.length ? parts.join(' > ') : '';
  };
  const accessibleName = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return text(aria);
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const target = document.getElementById(labelledby.split(/\\s+/)[0]);
      if (target) return text(target.textContent);
    }
    return text(el.textContent);
  };
  const actionable = (node) => {
    if (!node || node.nodeType !== 1) return null;
    if (node.matches('button, a[href], summary, [role=button], [role=link], [role=tab], [role=menuitem], input, textarea, select')) return node;
    return null;
  };
  const clickTarget = (path) => {
    const direct = path.map(actionable).find(Boolean);
    if (direct) return direct;
    return path.find((node) => node && node.nodeType === 1 && node !== document.body && text(node.textContent)) || null;
  };
  document.addEventListener('click', (event) => {
    const el = clickTarget(event.composedPath());
    if (!el) return;
    send({
      type: 'click',
      selector: selectorFor(el),
      role: el.getAttribute('role') || el.tagName.toLowerCase(),
      name: accessibleName(el),
      url: pageUrl(),
      ts: Date.now()
    });
  }, true);
  const recordInput = (event) => {
    const el = event.target;
    if (!el || !el.matches || !el.matches('input, textarea, select')) return;
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    send({
      type: 'fill',
      selector: selectorFor(el),
      role: el.getAttribute('role') || el.tagName.toLowerCase(),
      name: accessibleName(el) || el.getAttribute('placeholder') || '',
      value: type === 'password' ? '' : text(el.value),
      redacted: type === 'password',
      url: pageUrl(),
      ts: Date.now()
    });
  };
  document.addEventListener('change', recordInput, true);
})();`;

function platformForUrl(url) {
  try {
    const host = new URL(url).hostname;
    if (host.endsWith('xiaohongshu.com')) return 'xhs';
    if (host === 'mp.weixin.qq.com') return 'wechat_mp';
  } catch {
    return null;
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(args.out, { recursive: true });
  if (!fs.existsSync(args.chrome)) throw new Error(`Chrome not found: ${args.chrome}`);
  const profileDir = path.join(os.tmpdir(), 'ops-observe-profile');
  fs.mkdirSync(profileDir, { recursive: true });

  const budget = new NetworkCaptureBudget();
  const redactors = new Map(START_URLS.map((item) => [item.platform, new Redactor()]));
  const network = [];
  const steps = [];
  const pending = [];

  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: args.chrome,
    headless: false,
    viewport: null,
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--start-maximized', '--disable-blink-features=AutomationControlled', '--no-first-run']
  });

  for (const item of START_URLS) {
    const page = await context.newPage();
    await page.addInitScript(RECORDER_SOURCE);
    page.on('response', (response) => {
      const request = response.request();
      const type = request.resourceType();
      if (type !== 'xhr' && type !== 'fetch') return;
      const platform = platformForUrl(response.url());
      if (!platform) return;
      const task = (async () => {
        const headers = await response.allHeaders().catch(() => ({}));
        const raw = await response.text().catch(() => null);
        if (raw === null) return;
        const decision = budget.consider({ bodyBytes: Buffer.byteLength(raw), durationMs: 0 });
        if (!decision.allowed) {
          network.push({ platform, url: redactors.get(platform).redactUrl(response.url()), status: response.status(), method: request.method(), reason: decision.reason });
          return;
        }
        const contentType = headers['content-type'] || headers['Content-Type'] || '';
        const body = redactors.get(platform).redactBody(contentType, raw);
        network.push({
          platform,
          url: redactors.get(platform).redactUrl(response.url()),
          status: response.status(),
          method: request.method(),
          contentType,
          body: body.body,
          reason: body.reason || null
        });
      })().catch(() => undefined);
      pending.push(task);
    });
    await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => undefined);
  }

  const drain = setInterval(async () => {
    for (const page of context.pages()) {
      try {
        const batch = await page.evaluate(() => (window.__opsSteps || []).splice(0));
        if (Array.isArray(batch) && batch.length) {
          steps.push(...batch);
          fs.writeFileSync(path.join(args.out, 'steps-live.json'), JSON.stringify({ steps }, null, 2));
        }
      } catch {
        // 页面正在导航/关闭，下一轮再取。
      }
    }
  }, 2000);

  const stopFile = path.join(args.out, 'stop.flag');
  console.log(JSON.stringify({ ready: true, out: args.out, stopFile, chrome: args.chrome }));
  while (!fs.existsSync(stopFile)) await new Promise((resolve) => setTimeout(resolve, 1000));

  clearInterval(drain);
  for (const page of context.pages()) {
    try {
      const batch = await page.evaluate(() => (window.__opsSteps || []).splice(0));
      if (Array.isArray(batch) && batch.length) steps.push(...batch);
    } catch {}
  }
  await Promise.allSettled(pending);
  fs.writeFileSync(path.join(args.out, 'network.json'), JSON.stringify({ captured: network, budget: budget.state() }, null, 2));
  fs.writeFileSync(path.join(args.out, 'steps.json'), JSON.stringify({ steps }, null, 2));
  await context.close().catch(() => undefined);
  console.log(JSON.stringify({ done: true, out: args.out, network: network.length, steps: steps.length }));
}

module.exports = { RECORDER_SOURCE, platformForUrl };

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exitCode = 1;
  });
}
