'use strict';
// B-01.3/B-01.4 行为测试：在最小假 DOM 中执行 page-status.js。
// 验证「页面伪造点击不改状态」「真实 isTrusted 点击才上行」「删除宿主后自动恢复」。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function makeDom() {
  const listeners = new Map();
  const doc = {
    fullscreenElement: null,
    addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) || []), fn]); },
    removeEventListener(type, fn) { listeners.set(type, (listeners.get(type) || []).filter((x) => x !== fn)); },
    listeners,
  };
  class Node {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.children = [];
      this.parent = null;
      this.isConnected = false;
      this.style = {};
      this.attributes = new Map();
      this.handlers = new Map();
      this.className = '';
      this.text = '';
      this.hidden = false;
      this.disabled = false;
      this.popover = '';
      this.openPopover = false;
    }
    get textContent() { return this.text; }
    set textContent(v) { this.text = String(v); if (!v) this.children = []; }
    appendChild(child) {
      child.parent = this;
      this.children.push(child);
      const connect = (node) => { node.isConnected = true; node.children.forEach(connect); };
      if (this.isConnected) connect(child);
      return child;
    }
    append(...nodes) { for (const n of nodes) this.appendChild(n); }
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this);
      this.parent = null;
      const disconnect = (node) => { node.isConnected = false; node.children.forEach(disconnect); };
      disconnect(this);
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    removeAttribute(name) { this.attributes.delete(name); }
    addEventListener(type, fn) { this.handlers.set(type, [...(this.handlers.get(type) || []), fn]); }
    matches(selector) {
      if (selector === ':popover-open') return this.openPopover;
      return false;
    }
    getBoundingClientRect() {
      const base = this.rect || { left: 1000, top: 16, width: 340, height: 148 };
      return { ...base, x: base.left, y: base.top, right: base.left + base.width, bottom: base.top + base.height };
    }
    attachShadow({ mode }) {
      this.shadowMode = mode;
      const host = this;
      this.shadowRoot = {
        card: null,
        set innerHTML(value) {
          const card = new Node('div');
          card.className = 'card';
          this.card = card;
        },
        querySelector(selector) { return selector === '.card' ? this.card : null; },
      };
      return this.shadowRoot;
    }
    showPopover() { this.openPopover = true; }
    hidePopover() {
      this.openPopover = false;
      for (const fn of listeners.get('toggle') || []) fn({ type: 'toggle', newState: 'close', target: this });
    }
    querySelector() { return null; }
  }
  const documentElement = new Node('html');
  documentElement.isConnected = true;
  doc.documentElement = documentElement;
  doc.body = documentElement;
  doc.createElement = (tag) => new Node(tag);
  doc.querySelector = (selector) => {
    if (selector !== '[data-ops-page-status]') return null;
    return documentElement.children.find((n) => n.attributes.has('data-ops-page-status')) || null;
  };
  class MutationObserver {
    constructor(cb) { this.cb = cb; this.targets = []; observers.push(this); }
    observe(target) { this.targets.push(target); }
    disconnect() { this.targets = []; }
    fire() { if (this.targets.length) this.cb([], this); }
  }
  const observers = [];
  return { doc, Node, MutationObserver, documentElement, observers };
}

function loadCard() {
  const env = makeDom();
  const sent = [];
  const messageListeners = [];
  const chrome = {
    runtime: {
      sendMessage(message) { sent.push(message); },
      onMessage: { addListener(fn) { messageListeners.push(fn); } },
    },
  };
  const sandbox = {
    document: env.doc,
    chrome,
    location: { protocol: 'https:', origin: 'https://creator.example.com', href: 'https://creator.example.com/publish' },
    performance: { now: () => Date.now() },
    queueMicrotask,
    setTimeout,
    clearTimeout,
    MutationObserver: env.MutationObserver,
    console,
  };
  const code = fs.readFileSync(path.resolve(__dirname, '..', 'chrome-extension', 'page-status.js'), 'utf8');
  vm.runInNewContext(code, sandbox, { filename: 'page-status.js' });
  return { env, sent, messageListeners, sandbox };
}

function findButton(node) {
  if (node.className === 'continue') return node;
  for (const child of node.children) {
    const hit = findButton(child);
    if (hit) return hit;
  }
  return null;
}

test('B-01.3: 伪造点击（isTrusted=false）不产生 handoff_complete；真实点击才上行', () => {
  const { env, sent, messageListeners } = loadCard();
  assert.equal(messageListeners.length, 1, '卡片注册了状态消息监听');
  messageListeners[0]({ type: 'ops:page-status', state: { state: 'waiting', handoffId: 'h-1', message: '请扫码', tabId: 3 } }, null, () => {});
  const host = env.doc.querySelector('[data-ops-page-status]');
  assert.ok(host, '收到 waiting 后出现宿主');
  assert.equal(host.shadowMode, 'closed', 'shadow root 必须是 closed');
  assert.equal(host.popover, 'manual', '必须是 popover=manual');
  const button = findButton(host.shadowRoot.card);
  assert.ok(button, '卡片渲染出完成按钮');

  const before = sent.filter((m) => m.type === 'handoff_complete').length;
  button.handlers.get('click')[0]({ isTrusted: false });
  assert.equal(sent.filter((m) => m.type === 'handoff_complete').length, before, '非可信点击不得上行');
  assert.equal(messageListeners.length, 1, '非可信点击后监听仍只有一份');

  button.handlers.get('click')[0]({ isTrusted: true });
  const complete = sent.filter((m) => m.type === 'handoff_complete');
  assert.equal(complete.length, 1, '可信点击必须上行');
  assert.equal(complete[0].tabId, 3);
  assert.equal(complete[0].handoffId, 'h-1');
  assert.equal(complete[0].origin, 'https://creator.example.com');

  // 同 handoffId 重复可信点击幂等：只发一次
  button.handlers.get('click')[0]({ isTrusted: true });
  assert.equal(sent.filter((m) => m.type === 'handoff_complete').length, 1, '同一 handoff 重复点击不重复上行');
});

test('B-01.4: 页面删除宿主后 MutationObserver 恢复；hidePopover 后 microtask 重开', async () => {
  const { env, messageListeners } = loadCard();
  messageListeners[0]({ type: 'ops:page-status', state: { state: 'waiting', handoffId: 'h-2', message: '请验证', tabId: 4 } }, null, () => {});
  let host = env.doc.querySelector('[data-ops-page-status]');
  assert.ok(host && host.isConnected, '卡片初始挂载');
  host.remove();
  assert.equal(host.isConnected, false);
  // 模拟页面删除后浏览器派发 mutation 记录。
  for (const observer of env.observers) observer.fire();
  await new Promise((r) => setTimeout(r, 20));
  host = env.doc.querySelector('[data-ops-page-status]');
  assert.ok(host && host.isConnected, '删除后宿主重新连接');
  host.hidePopover();
  await new Promise((r) => setTimeout(r, 0));
  const reopened = env.doc.querySelector('[data-ops-page-status]');
  assert.ok(reopened && reopened.isConnected, 'hidePopover 后 microtask 重挂');
});

test('B-04.2: clear 后宿主与监听全部移除，页面 DOM 零残留', () => {
  const { env, messageListeners } = loadCard();
  messageListeners[0]({ type: 'ops:page-status', state: { state: 'waiting', handoffId: 'h-3', message: '请验证', tabId: 5 } }, null, () => {});
  assert.ok(env.doc.querySelector('[data-ops-page-status]'), '卡片先挂载');
  messageListeners[0]({ type: 'ops:page-status', op: 'clear' }, null, () => {});
  assert.equal(env.doc.querySelector('[data-ops-page-status]'), null, 'clear 后宿主移除');
  assert.equal(env.documentElement.children.filter((n) => n.attributes.has('data-ops-page-status')).length, 0, 'documentElement 无残留');
  for (const observer of env.observers) assert.equal(observer.targets.length, 0, '观察器已断开');
});
