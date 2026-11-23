'use strict';
// B-04 隔离世界与零页面残留：可复算的静态审计。
// 运行：cd desktop && node --test test/isolation.test.cjs

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const EXT = path.resolve(__dirname, '..', 'chrome-extension');
const SRC = path.resolve(__dirname, '..', 'src');

function read(p) {
  return fs.readFileSync(p, 'utf8');
}

function walk(dir, exts, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.build') continue;
      walk(full, exts, out);
    } else if (exts.includes(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

test('B-04.1: 页面动作显式 ISOLATED，且从不请求 MAIN world', () => {
  const bg = read(path.join(EXT, 'background.js'));
  const calls = bg.match(/chrome\.scripting\.executeScript\(\{/g) || [];
  const isolated = bg.match(/world: 'ISOLATED'/g) || [];
  assert.ok(calls.length >= 4, `executeScript 调用点应覆盖 observe/click/type/extract/frame/卡片，实际 ${calls.length}`);
  assert.equal(isolated.length, calls.length, '每个 executeScript 都必须显式 world: ISOLATED');
  assert.doesNotMatch(bg, /world:\s*'MAIN'|world:\s*"MAIN"/, '禁止 MAIN world');
  assert.doesNotMatch(bg, /world:\s*'USER_SCRIPT'|world:\s*'USERSCRIPT'/, '禁止用户脚本世界');
});

test('B-04.2: 页面动作函数不写 DOM；卡片 clear 后整体移除', () => {
  const bg = read(path.join(EXT, 'background.js'));
  assert.doesNotMatch(bg, /createElement|appendChild|insertBefore|removeChild|innerHTML\s*=|outerHTML\s*=/, '登记动作不得新增/移除页面节点');
  assert.doesNotMatch(bg, /\.style\.\w+\s*=/, '登记动作不得改页面样式');
  const card = read(path.join(EXT, 'page-status.js'));
  assert.match(card, /if \(message\.op === 'clear'/, '卡片必须响应 clear');
  assert.match(card, /host \&\& host\.remove\(\)/, '卡片清除必须 remove 宿主');
  assert.match(card, /docObserver \&\& docObserver\.disconnect\(\)/, '清除必须断开观察器');
  assert.doesNotMatch(card, /document\.body\.appendChild|document\.body\.innerHTML/, '卡片不写 body');
});

test('B-04.3: 隔离世界状态不挂页面可读全局；页面状态文件不写 window', () => {
  const bg = read(path.join(EXT, 'background.js'));
  // __ops* 只出现在 executeScript 的 func 里；func 默认/显式都在扩展 isolated world。
  assert.match(bg, /window\.__opsRefMap/, 'isolated world 内的引用表（页面不可见）');
  assert.match(bg, /function observeFn/, 'observe 是包内函数引用，不是字符串脚本');
  const card = read(path.join(EXT, 'page-status.js'));
  assert.doesNotMatch(card, /window\.__|globalThis\.__/, '卡片不得挂全局变量');
  assert.match(card, /\(\(\) => \{/, '卡片必须是闭包 IIFE');
});

test('B-04.4: 不开启页面可感知的 CDP 域', () => {
  const files = [...walk(SRC, ['.ts', '.js']), ...walk(EXT, ['.js'])];
  const hits = [];
  for (const file of files) {
    const text = read(file);
    for (const domain of ['Runtime.enable', 'Console.enable', 'Debugger.enable']) {
      if (text.includes(domain)) hits.push(`${path.relative(path.resolve(__dirname, '..'), file)}:${domain}`);
    }
  }
  assert.deepEqual(hits, [], `禁止开启可感知 CDP 域：${hits.join(', ')}`);
  // 只读 evaluate 允许存在（登录身份/挑战探针），但不能有 enable 配套。
  const login = read(path.join(SRC, 'platform-login.ts'));
  assert.match(login, /Runtime\.evaluate/, '登录链路只允许 Runtime.evaluate 读取页面状态');
});

test('B-04.5: 不伪造 UA / 时区 / webdriver 指纹', () => {
  const files = [...walk(EXT, ['.js']), ...walk(path.join(SRC, 'platforms'), ['.ts']),
    path.join(SRC, 'platform-login.ts'), path.join(SRC, 'platform-login-runtime.ts')];
  const hits = [];
  for (const file of files) {
    const text = read(file);
    for (const pattern of ['userAgent', 'webdriver', 'timeZone', 'timezone', 'navigator.plugins', 'navigator.language']) {
      if (text.includes(pattern)) hits.push(`${path.basename(file)}:${pattern}`);
    }
  }
  assert.deepEqual(hits, [], `不得伪造指纹：${hits.join(', ')}`);
});

test('B-04.6: 隔离说明文档已回填', () => {
  const doc = read(path.resolve(__dirname, '..', '..', 'docs', '41-browse可借鉴实现清单.md'));
  assert.match(doc, /实施记录（B-04，2026-11-17）/, '清单 §4 必须有 B-04 实施记录');
  const plan = read(path.resolve(__dirname, '..', '..', 'docs', '08-开发与测试计划.md'));
  assert.match(plan, /### B-04 隔离世界与零页面残留/, 'docs/08 必须有 B-04 小节');
});
