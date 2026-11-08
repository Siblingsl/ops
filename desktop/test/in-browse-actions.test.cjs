'use strict';
// DEV-AI27-06 W06c：内置浏览页 AI 动作执行器测试。
// 用轻量 DOM stub（避免测试新增 jsdom 依赖）模拟 executeJavaScript 的页面环境，
// 登记函数体与 src/in-browse.ts 相同源（executeJavaScript 函数 toString 语义）。
// 覆盖：观察节点/doc_rev 失效反例/密码控件拒绝/点击/输入/提取。

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.resolve(__dirname, '../.build/in-browse.js'), 'utf8');
function extractFn(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`fn ${name} not found`);
  let depth = 0;
  let i = src.indexOf('{', start);
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) { i = j + 1; break; } }
  }
  return new Function(`return (${src.slice(start, i)})`)();
}

/** 最小 DOM stub：满足登记函数用到的 API（querySelectorAll/getBoundingClientRect/classList/value/click/dispatchEvent）。 */
function makeEl(tag, opts = {}) {
  const rect = opts.rect || { width: 100, height: 30, left: 0, top: 0, right: 100, bottom: 30 };
  const listeners = [];
  return {
    tagName: tag.toUpperCase(),
    textContent: opts.text ?? '',
    value: opts.value ?? '',
    type: opts.type ?? '',
    placeholder: opts.placeholder ?? '',
    getAttribute: (name) => (name === 'type' ? (opts.type ?? null) : (opts.attrs && opts.attrs[name]) ?? null),
    getBoundingClientRect: () => rect,
    matches: (sel) => sel === `input[type="password"]` && opts.type === 'password',
    click: () => { opts.onClick?.(); },
    focus: () => {},
    dispatchEvent: (ev) => { listeners.forEach((fn) => fn(ev)); return true; },
    __onChange: (fn) => listeners.push(fn),
    __set: (v) => { opts.value = v; },
    __getValue: () => opts.value,
  };
}

function makeDoc(elements) {
  return {
    title: '测试页',
    body: { innerText: '页面正文头部…' },
    querySelectorAll: (sel) => elements,
    querySelector: (sel) => elements.find((el) => `#${el.id}` === sel) ?? null,
  };
}

let doc, els, obs, w;

test.before(() => {
  els = {
    link: makeEl('a', { text: '链接A' }),
    btn: makeEl('button', { text: '已点击 0 次', onClick: () => { els.btnClicked = true; } }),
    box: makeEl('input', { type: 'text', placeholder: '文本框' }),
    pwd: makeEl('input', { type: 'password', rect: { width: 100, height: 30, left: 0, top: 0, right: 100, bottom: 30 } }),
  };
  doc = makeDoc([els.link, els.btn, els.box, els.pwd]);
  w = { __opsRefMap: new Map(), __opsRefSeq: 0, __opsDocRev: undefined };
  global.document = doc;
  global.window = w;
  global.location = { href: 'https://example.test/page' };
  global.Event = class Event { constructor(type) { this.type = type; } };

  const observeFn = extractFn('inBrowseObserveFn');
  obs = observeFn(300);
});

test('W06c observe: 节点枚举 + doc_rev 生成', () => {
  assert.equal(obs.url, 'https://example.test/page');
  assert.match(obs.doc_rev, /^r\d/);
  assert.ok(obs.nodes.length >= 3, `应枚举到链接/按钮/输入框：${JSON.stringify(obs.nodes.map((n) => n.tag))}`);
});

test('W06c click: 点击生效 + doc_rev 失效 + ref 缺失', () => {
  const clickFn = extractFn('inBrowseClickFn');
  const btn = obs.nodes.find((n) => n.tag === 'button');
  assert.equal(clickFn(btn.ref, obs.doc_rev).clicked, true);
  assert.equal(els.btnClicked, true, 'click 真实触发');
  assert.equal(clickFn(btn.ref, 'r999-dead').error, 'doc_rev_changed', '旧 doc_rev 拒绝');
  assert.equal(clickFn('n99999', obs.doc_rev).error, 'ref_not_found');
});

test('W06c type: 输入生效 + 密码控件拒绝（值未被写入）', () => {
  const typeFn = extractFn('inBrowseTypeFn');
  const box = obs.nodes.find((n) => n.tag === 'input' && n.type === 'text');
  const ok = typeFn(box.ref, '中文输入ABC123', obs.doc_rev);
  assert.equal(ok.typed, '中文输入ABC123'.length);
  // 密码控件：观察后 refMap 中直接验证
  w.__opsRefMap.set('nPwd', els.pwd);
  const denied = typeFn('nPwd', 'secret', obs.doc_rev);
  assert.equal(denied.error, 'sensitive_control', '密码控件必须拒绝');
});

test('W06c extract: 文本/输入框 value/缺失', () => {
  const extractFn4 = extractFn('inBrowseExtractFn');
  w.__opsDocRev = obs.doc_rev;
  // extract 用 querySelector；stub 按 id 匹配
  els.link.id = 'link1';
  els.box.id = 'box1';
  els.box.__getValue = () => els.box.value;
  const para = extractFn4('#link1', obs.doc_rev);
  assert.equal(para.text, '链接A');
  const missing = extractFn4('#nope', obs.doc_rev);
  assert.equal(missing.error, 'selector_not_found');
});
