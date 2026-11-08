'use strict';
// DEV-AI27-10（W10）：OPS Chrome 侧边对话（27 文档 §10.2）。
// 边界：只展示当前连接状态/已选会话/精简输入草稿；输入经 OPS 桌面端原会话受理
// （通过 background 转发到 OPS 桥，真实消息受理仍走原 agent API——无双执行入口）；
// 停止按钮 = 收紧/取消（与主界面停止同语义）；不保存独立会话副本。
// 自动打开受 Chrome 用户手势规则约束：由用户点击扩展图标触发，不由网页脚本唤起。

const els = {
  state: document.getElementById('state'),
  tab: document.getElementById('tab'),
  messages: document.getElementById('messages'),
  input: document.getElementById('input'),
  send: document.getElementById('send'),
  openOps: document.getElementById('open-ops'),
  stop: document.getElementById('stop'),
};

let paired = false;
let currentTab = null;

function render() {
  els.state.textContent = paired ? '已配对（OPS 桌面端已连接）' : '未配对——请先在 OPS 桌面端完成配对';
  els.state.className = paired ? 'ok' : 'bad';
  els.tab.textContent = currentTab ? `${currentTab.title || '无标题'}（${currentTab.origin}）` : '未选中';
  els.send.disabled = !paired;
  els.stop.disabled = !paired;
}

// 当前活动标签信息（用户手势范围；只取元数据，不取正文）。
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs[0];
  if (tab && tab.url && /^https?:/.test(tab.url)) {
    try {
      const u = new URL(tab.url);
      currentTab = { id: tab.id, title: (tab.title || '').slice(0, 80), origin: `${u.protocol}//${u.host}` };
    } catch { currentTab = null; }
  }
  render();
});

chrome.storage.local.get(['paired'], (d) => {
  paired = Boolean(d.paired);
  render();
});

function appendMessage(role, text) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.textContent = text;
  els.messages.appendChild(div);
  els.messages.scrollTop = els.messages.scrollHeight;
}

els.send.addEventListener('click', () => {
  const text = els.input.value.trim();
  if (!text || !paired) return;
  appendMessage('user', text);
  els.input.value = '';
  // 经 background 转发到 OPS 桥（native messaging → OPS 桌面 → 原 agent 会话受理）。
  // 27 §10.2：侧栏不保存独立会话副本；回复在 OPS 主界面展示，侧栏仅提示已受理。
  chrome.runtime.sendMessage({ type: 'sidepanel_input', text, tab: currentTab }, (resp) => {
    const last = chrome.runtime.lastError;
    if (last) {
      appendMessage('assistant', `发送失败：${last.message}`);
      return;
    }
    appendMessage('assistant', resp && resp.accepted
      ? '已受理；请在 OPS 主界面查看回复与操作卡片。'
      : `未受理：${(resp && resp.reason) || '原因未知'}`);
  });
});

els.input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.isComposing) {
    event.preventDefault();
    els.send.click();
  }
});

// 停止任务：与主界面停止同语义（收紧当前 run）。
els.stop.addEventListener('click', () => {
  if (!paired) return;
  chrome.runtime.sendMessage({ type: 'sidepanel_stop' }, (resp) => {
    const last = chrome.runtime.lastError;
    appendMessage('assistant', last ? `停止失败：${last.message}` : '已请求停止当前任务。');
  });
});

// 在 OPS 中打开：聚焦 OPS 桌面（深链）或提示未安装。
els.openOps.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'sidepanel_open_ops' }, () => void chrome.runtime.lastError);
});
