'use strict';
// B-01：人工接管卡片（注入到 agent 正在使用的 tab；closed shadow root + popover=manual）。
//
// 安全边界：
//   * 卡片只表示「人已完成操作」，不是「平台已登录」的证明；登录成功仍以平台页面真实状态为准。
//   * 只有 event.isTrusted 的点击才算完成；页面 dispatchEvent / element.click() 一律无效。
//   * 宿主元素不设 id；closed shadow root 让页面脚本读不到卡片内部，也无法伪造按钮。
//   * 页面删除/改样式/关 popover 时由 MutationObserver / toggle 事件恢复，重排限流 10 次/秒。
//   * 本脚本不写全局变量、不发网络请求、不改页面其它节点；clear 时整体移除。

(() => {
  const HOST_TAG = 'div';
  const MARKER = 'data-ops-page-status';
  const RETOPS_PER_SECOND = 10;

  // 重复注入：同一页面已有宿主时只请求一次最新状态，不建第二张卡片。
  if (document.querySelector(`[${MARKER}]`)) {
    try {
      chrome.runtime.sendMessage({ type: 'page_status_ready' });
    } catch (error) { /* 扩展上下文失效时忽略 */ }
    return;
  }

  let current = null; // {state, handoffId, message, tabId, origin}
  let host = null;
  let root = null;
  let card = null;
  let completing = null;
  let closed = false;
  let retops = { second: 0, count: 0 };
  let suppressToggleUntil = 0;
  let docObserver = null;
  let hostObserver = null;

  function displayOrigin() {
    const protocol = location.protocol;
    if (protocol === 'file:') return location.href.slice(0, 160);
    if (location.origin && location.origin !== 'null') return location.origin;
    return 'This page';
  }

  function render() {
    if (!root || !card) return;
    const waiting = current && current.state === 'waiting';
    card.style.display = waiting ? 'block' : 'none';
    if (!waiting) {
      card.textContent = '';
      return;
    }
    card.textContent = '';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = '需要你完成一步操作';
    const origin = document.createElement('div');
    origin.className = 'origin';
    origin.textContent = displayOrigin();
    const message = document.createElement('div');
    message.className = 'message';
    message.textContent = (current.message || '请在平台页面完成验证 / 扫码 / 二次确认，然后点击下方按钮。').slice(0, 200);
    const actions = document.createElement('div');
    actions.className = 'actions';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'continue';
    button.textContent = completing ? '已确认，等待页面继续…' : '我已完成';
    button.disabled = Boolean(completing);
    button.addEventListener('click', (event) => {
      if (!event.isTrusted) return;
      const handoffId = current && current.handoffId;
      if (!handoffId || completing === handoffId) return;
      completing = handoffId;
      render();
      try {
        chrome.runtime.sendMessage({
          type: 'handoff_complete',
          handoffId,
          tabId: current.tabId,
          origin: displayOrigin(),
        });
      } catch (error) {
        completing = null;
        render();
      }
    });
    actions.appendChild(button);
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = '卡片只代表你已操作；是否登录成功以平台页面为准。';
    card.append(title, origin, message, actions, hint);
  }

  function ensureHost() {
    if (!host) {
      host = document.createElement(HOST_TAG);
      host.setAttribute(MARKER, '1');
      host.popover = 'manual';
      root = host.attachShadow({ mode: 'closed' });
      root.innerHTML = `
        <style>
          :host {
            all: initial;
            position: fixed;
            top: 16px;
            right: 16px;
            width: 340px;
            height: 148px;
            pointer-events: none;
            z-index: 2147483647;
          }
          .card {
            pointer-events: auto;
            box-sizing: border-box;
            width: 340px;
            min-height: 148px;
            padding: 12px 14px;
            border-radius: 10px;
            border: 1px solid #d7dbe3;
            background: #ffffff;
            box-shadow: 0 8px 24px rgba(15, 23, 42, 0.18);
            color: #111827;
            font: 13px/1.45 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
          }
          .title { font-weight: 600; font-size: 14px; margin-bottom: 4px; }
          .origin { color: #2563eb; font-size: 12px; margin-bottom: 6px; overflow-wrap: anywhere; }
          .message { color: #374151; margin-bottom: 8px; }
          .actions { display: flex; gap: 8px; }
          .continue {
            pointer-events: auto;
            width: 100%;
            height: 32px;
            border: 0;
            border-radius: 8px;
            background: #2563eb;
            color: #ffffff;
            font: 13px/32px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
            cursor: pointer;
          }
          .continue[disabled] { background: #93b4f5; cursor: default; }
          .hint { color: #6b7280; font-size: 11px; margin-top: 6px; }
        </style>
        <div class="card"></div>`;
      card = root.querySelector('.card');
      docObserver = new MutationObserver(() => {
        if (closed) return;
        if (!host.isConnected) raise();
      });
      docObserver.observe(document.documentElement, { childList: true, subtree: true });
      hostObserver = new MutationObserver(() => {
        if (closed) return;
        if (!host.isConnected) raise();
        // 页面给宿主加 display:none / class / style 时恢复：宿主自身只保留 popover。
        if (host.style.display === 'none' || host.hidden) raise();
      });
      hostObserver.observe(host, { attributes: true, attributeFilter: ['style', 'class', 'hidden', 'open'] });
    }
    if (!host.isConnected) {
      (document.documentElement || document.body).appendChild(host);
    }
    return host;
  }

  function raise() {
    if (closed) return;
    const node = ensureHost();
    // 清掉页面给宿主加的属性，只保留 popover 协议属性。
    for (const attribute of Array.from(node.attributes)) {
      if (attribute.name !== 'popover') node.removeAttribute(attribute.name);
    }
    node.setAttribute(MARKER, '1');
    node.style.display = '';
    node.hidden = false;
    if (node.isConnected) node.remove();
    (document.documentElement || document.body).appendChild(node);
    try {
      if (node.matches(':popover-open')) {
        // hide→show 是唯一可靠的置顶方式；期间产生的 toggle(close) 由 suppress 窗口吞掉，
        // 否则 onToggle 会再排一次 raise，形成 microtask 自激循环。
        suppressToggleUntil = performance.now() + 80;
        node.hidePopover();
      }
    } catch (error) { /* 旧浏览器无 popover */ }
    try {
      node.showPopover();
      suppressToggleUntil = 0;
    } catch (error) {
      // popover 不可用时退回 fixed 定位；仍然在 top layer 之外，但不影响点击。
      node.style.position = 'fixed';
      node.style.top = '16px';
      node.style.right = '16px';
    }
  }

  function retop() {
    if (!host || !host.isConnected) {
      raise();
      return;
    }
    const second = Math.floor(performance.now() / 1000);
    if (retops.second !== second) retops = { second, count: 0 };
    if (retops.count >= RETOPS_PER_SECOND) return;
    retops.count += 1;
    try {
      if (host.matches(':popover-open')) host.hidePopover();
    } catch (error) { /* ignore */ }
    raise();
  }

  function cardRect() {
    try {
      return host ? host.getBoundingClientRect() : null;
    } catch (error) {
      return null;
    }
  }

  function covers(node) {
    if (!node || typeof node.matches !== 'function') return false;
    try {
      if (node.matches(':modal')) return true;
    } catch (error) { /* 不是模态 */ }
    const rect = cardRect();
    if (!rect || !node.getBoundingClientRect) return false;
    const other = node.getBoundingClientRect();
    return !(other.right < rect.left || other.left > rect.right || other.bottom < rect.top || other.top > rect.bottom);
  }

  function onToggle(event) {
    if (closed) return;
    if (event.type === 'fullscreenchange') {
      if (document.fullscreenElement) retop();
      return;
    }
    if (event.type === 'toggle' && event.newState === 'close') {
      // 来自 raise 内部 hide→show 的 close 事件可能异步晚到；此时卡片已重新打开，
      // 视为过期事件丢弃，否则会无限重顶。页面主动 hidePopover 时 open=false，正常恢复。
      try {
        if (host && host.matches(':popover-open')) return;
      } catch (error) { /* ignore */ }
      if (performance.now() < suppressToggleUntil) return;
      queueMicrotask(() => {
        if (!closed) raise();
      });
      return;
    }
    if (event.type === 'toggle' && event.newState === 'open' && covers(event.target)) retop();
  }

  function applyState(next) {
    if (closed) return;
    if (!next || next.state === 'clear' || next.state === 'closed') {
      teardown();
      return;
    }
    current = {
      state: String(next.state || ''),
      handoffId: typeof next.handoffId === 'string' ? next.handoffId : '',
      message: typeof next.message === 'string' ? next.message : '',
      tabId: Number(next.tabId) || 0,
      origin: typeof next.origin === 'string' ? next.origin : '',
    };
    completing = null;
    raise();
    render();
  }

  function teardown() {
    closed = true;
    current = null;
    try { docObserver && docObserver.disconnect(); } catch (error) { /* ignore */ }
    try { hostObserver && hostObserver.disconnect(); } catch (error) { /* ignore */ }
    try { host && host.remove(); } catch (error) { /* ignore */ }
    document.removeEventListener('toggle', onToggle, true);
    document.removeEventListener('fullscreenchange', onToggle, true);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== 'ops:page-status') return undefined;
    if (message.op === 'clear' || (message.state && message.state.state === 'clear')) {
      teardown();
      sendResponse({ ok: true });
      return undefined;
    }
    applyState(message.state || message);
    sendResponse({ ok: true });
    return undefined;
  });

  document.addEventListener('toggle', onToggle, true);
  document.addEventListener('fullscreenchange', onToggle, true);
  // 首次注入由后台随后 sendMessage 给状态；万一后台消息早于监听器，这里主动拉一次。
  try {
    chrome.runtime.sendMessage({ type: 'page_status_ready' });
  } catch (error) { /* ignore */ }
})();
