'use strict';
// DEV-AI27-02 W02 技术验证：扩展 popup，只读展示配对状态与短码，不做任何授权动作。

function fmtState(hostState, paired) {
  if (hostState === 'connected' && paired) return ['已连接并配对', 'ok'];
  if (hostState === 'connected') return ['已连接，未配对', ''];
  if (hostState && hostState.startsWith('disconnected')) return ['宿主断开', 'bad'];
  if (hostState && hostState.startsWith('connect_failed')) return ['连接失败（宿主未注册？）', 'bad'];
  return [hostState || '未知', ''];
}

function refresh() {
  chrome.storage.local.get(
    ['host_state', 'paired', 'pairing_code', 'pairing_expires_at', 'extension_instance_id', 'last_commands'],
    (d) => {
      const [text, cls] = fmtState(d.host_state, d.paired);
      const pairedEl = document.getElementById('paired');
      pairedEl.textContent = text;
      pairedEl.className = cls;
      document.getElementById('host').textContent = d.host_state === 'connected' ? '已启动' : '未连接';
      const box = document.getElementById('pairing-box');
      const codeEl = document.getElementById('code');
      if (!d.paired && d.pairing_code && d.pairing_expires_at > Date.now()) {
        box.hidden = false;
        codeEl.textContent = String(d.pairing_code);
      } else {
        box.hidden = true;
      }
      const hint = document.getElementById('hint');
      if (!d.paired) {
        hint.textContent = d.pairing_code
          ? '短码 5 分钟内有效；在 OPS 桌面浏览器桥诊断窗点击"确认配对"。'
          : '启动 OPS 桌面（OPS_DESKTOP_BRIDGE_DIAG=1）以开始配对。';
      } else {
        hint.textContent = '配对生效中；会话密钥保存在本扩展本地存储。';
      }
      document.getElementById('instance').textContent = (d.extension_instance_id || '').slice(0, 8);
      const ul = document.getElementById('cmds');
      ul.innerHTML = '';
      for (const c of (d.last_commands || []).slice(-8).reverse()) {
        const li = document.createElement('li');
        li.textContent = `${c.ok ? '✓' : '✗'} ${c.action} · ${c.took}ms`;
        li.className = c.ok ? 'ok' : 'bad';
        ul.appendChild(li);
      }
    },
  );
}

refresh();
setInterval(refresh, 1000);
