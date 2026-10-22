// D-131：本地设置页只发送固定动作；不接收平台凭据、脚本、网址或本机路径。
(() => {
  window.opsLoginFlowUI = true;
  const el = (name) => document.getElementById(`login-flow-${name}`);
  const dialog = document.getElementById('platform-login-dialog');
  const labels = { xhs: '小红书', wechat_mp: '公众号后台', toutiao: '头条号' };
  const errors = {
    platform_login_required: '尚未读到当前账号，请在官方窗口完成登录后再核对。',
    platform_identity_mismatch: '无法确认当前平台主体。公众号有多个账号时，请先在官方后台确认当前账号；OPS 不按列表顺序猜测。',
    platform_browser_unsupported: '未找到需要的可信 Chrome／Edge。请通过官方渠道安装稳定版，再重新检测。',
    platform_browser_mismatch: '此连接已固定到原浏览器，请使用原浏览器继续；不能直接更换品牌。',
    platform_connection_conflict: '已有连接属于其他设备、用户或平台账号，请先在业务页面处理原连接。',
    platform_connection_unconfirmed: '尚未查到原请求的确定结果。请稍后恢复查询，不要重复创建连接。',
    platform_risk_paused: '原连接已暂停或要求验证。请按连接原有恢复流程处理，重新登录不会解除暂停。',
    platform_profile_busy: '登录或数据读取正在进行，请先完成当前操作。',
    platform_login_context_changed: 'OPS 用户、工作区或设备已变化，本次登录已结束。',
    platform_capability_denied: '当前客户端或服务端尚未具备已验证的身份能力，请继续人工回填。',
    platform_cleanup_pending: '专用窗口尚未完全退出，请先关闭该窗口再重试。',
    profile_meta_mismatch: '会话归属与当前账号不一致，不能复用。请先检查原连接。',
    profile_meta_invalid: '会话归属信息不完整，不能覆盖已有目录。',
    platform_network_unavailable: '网络或服务暂不可用，请检查连接后恢复查询。'
  };
  let target = null;
  let operationId = null;
  let state = 'ready';
  let revision = 0;
  let polling = false;
  let actionBusy = false;
  let openingRequestedTarget = false;
  let lastView = null;
  const terminal = new Set(['connected', 'cancelled', 'expired', 'failed']);
  function reportBusy() {
    const busy = openingRequestedTarget || actionBusy || polling || !!operationId && !terminal.has(state);
    window.dispatchEvent(new CustomEvent('ops-local-settings-busy', { detail: { busy } }));
  }
  async function command(cmd, payload) {
    const result = await window.opsDesktopSettings.platformCommand({ v: 1, id: `login_${crypto.randomUUID()}`, cmd, payload });
    if (!result?.ok) throw Object.assign(new Error('登录操作失败'), { code: result?.error?.code });
    return result.data;
  }
  function messageFor(error) { return errors[error?.code] ?? '本机操作未能完成，请检查网络或重新检测浏览器。'; }
  function render(view) {
    lastView = view;
    state = view.stage;
    const identity = ['review', 'mismatch', 'saving', 'recovering', 'connected'].includes(state);
    const progress = ['opening', 'probing', 'saving'].includes(state);
    el('browser-field').hidden = state !== 'ready';
    el('identity').hidden = !identity;
    el('result').hidden = state !== 'connected';
    el('target').textContent = `目标 OPS 账号：${target.name} · ${labels[target.platform]}`;
    el('account-name').textContent = target.name;
    el('display-name').textContent = view.displayName ?? '待核对';
    el('external-key').textContent = view.externalAccountKey ?? '待核对';
    el('expected-key').textContent = view.expectedKey ?? '';
    el('expected-row').hidden = !view.expectedKey;
    el('switches').textContent = `自动读取${view.autoCollect ? '沿原连接设置' : '关闭'}；自动采用${view.autoAdopt ? '沿原连接设置' : '关闭'}`;
    el('icon').textContent = state === 'connected' ? '✓' : state === 'mismatch' ? '!' : '↗';
    const copy = {
      ready: ['选择专用登录浏览器', '登录将在独立浏览器窗口完成。OPS 不使用你日常浏览器的登录状态。', '打开专用登录窗口'],
      opening: ['正在打开专用窗口', '正在验证浏览器和会话归属，请稍候。', '正在打开…'],
      waiting: ['请在官方窗口完成登录', '完成扫码、手机确认或官方安全验证后，回到这里核对账号。', '我已完成登录，核对账号'],
      probing: ['正在核对当前账号', '只核对本次登录身份，请稍候。', '正在核对…'],
      review: ['确认连接此账号', '请核对平台账号与目标 OPS 账号是否对应。确认后才向服务端建立或验证连接。', '确认连接此账号'],
      mismatch: ['当前账号与原连接不符', '请回到原专用窗口切换账号。原连接和作品绑定不会被覆盖。', '不能连接此账号'],
      saving: ['正在确认 OPS 连接', '等待服务端验证回执；关闭操作不会撤销已提交的服务端事务。', '正在确认…'],
      recovering: ['连接结果尚未确认', '先查询原请求结果，恢复验证；不会重复创建连接。', '恢复查询原连接'],
      connected: ['平台连接已验证', '专用会话已保留，后续读取复用同一浏览器。数据权限与自动开关单独管理。', '完成'],
      cancelled: ['本次登录已结束', '未完成的探测已停止。已提交的服务端连接可在业务页面检查。', '关闭'],
      expired: ['本次等待已超时', '已停止核对并关闭本次专用窗口；不会自动刷新二维码或重新登录。', '关闭'],
      unsupported: ['官方窗口已打开，OPS 身份能力待验证', target.platform === 'toutiao' ? '可在官方头条号页面完成本人登录。头条稳定身份与服务端接入条件尚未核实，目前不能确认 OPS 连接或开启读取，请继续人工回填。' : '服务端暂未声明此平台身份能力，完成官方登录也不会自动建立 OPS 连接。', '结束本次操作'],
      failed: ['未能打开本次登录', errors[view.errorCode] ?? '请检查浏览器和网络后重试。', '关闭']
    }[state];
    el('heading').textContent = copy[0];
    el('message').textContent = view.errorCode && !terminal.has(state) ? (errors[view.errorCode] ?? copy[1]) : copy[1];
    el('primary').textContent = copy[2];
    el('primary').disabled = progress || state === 'mismatch' || view.cleanupPending === true || (state === 'ready' && !el('browser').value);
    el('secondary').hidden = !['waiting', 'review', 'mismatch', 'recovering', 'unsupported'].includes(state);
    el('secondary').textContent = ['review', 'mismatch'].includes(state) ? '返回官方页切换账号' : '显示登录窗口';
    el('cancel').textContent = terminal.has(state) ? '关闭' : '取消登录';
    el('deadline').textContent = view.cleanupPending ? '专用窗口仍在退出中，请等待或手动关闭该专用窗口。' : view.deadlineAt && !terminal.has(state) ? `本次操作截止：${new Date(view.deadlineAt).toLocaleTimeString()}（二维码有效期以官方页面为准）` : '';
    dialog.querySelectorAll('.login-flow-steps li').forEach((item, index) => {
      const step = state === 'connected' ? 2 : identity ? 1 : 0;
      item.classList.toggle('active', index === step);
      if (index === step) item.setAttribute('aria-current', 'step'); else item.removeAttribute('aria-current');
    });
    reportBusy();
  }
  async function prepare() {
    if (dialog.open) return;
    if (!target) return;
    const { accountId, platform } = target;
    operationId = null; actionBusy = true;
    const ticket = ++revision;
    el('title').textContent = `连接${labels[platform]}`;
    el('browser').replaceChildren(new Option('正在检测可信浏览器…', ''));
    el('browser').disabled = true;
    el('browser-note').textContent = '';
    render({ stage: 'ready' });
    dialog.showModal();
    reportBusy();
    try {
      const result = await command('login-browsers', { accountId, platform });
      if (ticket !== revision || !dialog.open) return;
      el('browser').replaceChildren();
      for (const browser of result.candidates) {
        const option = new Option(`${browser.name}${result.fixedFamily === browser.family ? '（此连接已固定）' : ''}`, browser.family);
        option.disabled = !!result.fixedFamily && result.fixedFamily !== browser.family;
        el('browser').append(option);
      }
      if (result.fixedFamily) el('browser').value = result.fixedFamily;
      el('browser').disabled = !!result.fixedFamily || !result.candidates.length;
      el('browser-note').textContent = result.fixedFamily ? '继续使用原连接浏览器；不会跨品牌搬运会话。' : '已校验发行方签名。首次选定后，此账号会话固定使用该浏览器。';
      render({ stage: 'ready' });
      if (!el('browser').value) el('message').textContent = errors.platform_browser_unsupported;
    } catch (error) { if (ticket === revision) el('message').textContent = messageFor(error); }
    finally { if (ticket === revision) { actionBusy = false; reportBusy(); } }
  }
  async function perform(action) {
    if (actionBusy && action !== 'cancel') return;
    const ticket = ++revision;
    actionBusy = true;
    try {
      const view = await command('login-action', { operationId, action });
      if (ticket === revision && dialog.open) render(view);
    } catch (error) { if (ticket === revision) el('message').textContent = messageFor(error); }
    finally { if (ticket === revision) { actionBusy = false; reportBusy(); } }
  }
  async function dismiss() {
    if (operationId && !terminal.has(state)) { await perform('cancel'); if (!terminal.has(state)) return; }
    if (lastView?.cleanupPending) return;
    ++revision; operationId = null; actionBusy = false;
    dialog.close();
    reportBusy();
    if (state === 'connected') {
      platformLoginStatus.textContent = '平台连接已验证；数据权限与自动开关请在对应业务账号中管理。';
      void Promise.all([loadDevices(), loadInfo()]);
    }
  }
  platformLoginStart.addEventListener('click', () => { void prepare(); });
  async function openRequestedTarget(requested) {
    if (openingRequestedTarget || !requested || !/^[0-9a-f-]{36}$/i.test(requested.accountId)
      || !['xhs', 'wechat_mp', 'toutiao'].includes(requested.platform)) return;
    if (dialog.open) {
      dialog.focus();
      if (target?.accountId === requested.accountId && target?.platform === requested.platform) {
        if (operationId && !terminal.has(state)) void perform('show');
      } else {
        el('message').textContent = '已有其他账号的登录操作正在进行，请先完成或取消后再切换目标。';
      }
      return;
    }
    openingRequestedTarget = true;
    reportBusy();
    activateSettingsTab('account');
    try {
      const accounts = await window.opsDesktopSettings.getBusinessAccounts();
      const account = accounts.find((item) => item.id === requested.accountId && item.platform === requested.platform && item.status === 'active');
      if (!account) {
        platformLoginStatus.textContent = '目标账号已删除、停用或不属于当前工作区，无法开始本机登录。';
        return;
      }
      target = { accountId: account.id, platform: account.platform, name: account.name };
      await prepare();
    } catch (error) {
      platformLoginStatus.textContent = messageFor(error);
    } finally { openingRequestedTarget = false; reportBusy(); }
  }
  window.opsDesktopSettings.onPlatformLoginTarget((requested) => { void openRequestedTarget(requested); });
  void window.opsDesktopSettings.takePlatformLoginTarget()
    .then((requested) => { if (requested) void openRequestedTarget(requested); })
    .catch(() => undefined);
  el('primary').addEventListener('click', async () => {
    if (state === 'ready') {
      const ticket = ++revision;
      operationId = crypto.randomUUID();
      actionBusy = true;
      render({ stage: 'opening' });
      try {
        const view = await command('open-login', { accountId: target.accountId, platform: target.platform, browserFamily: el('browser').value, operationId });
        if (ticket === revision && dialog.open) render(view);
      } catch (error) { if (ticket === revision) { render({ stage: 'failed', errorCode: error.code }); el('message').textContent = messageFor(error); } }
      finally { if (ticket === revision) { actionBusy = false; reportBusy(); } }
    } else if (state === 'waiting') await perform('probe');
    else if (state === 'review') await perform('confirm');
    else if (state === 'recovering') await perform('recover');
    else await dismiss();
  });
  el('secondary').addEventListener('click', () => { void perform(['review', 'mismatch'].includes(state) ? 'back' : 'show'); });
  el('cancel').addEventListener('click', () => { void dismiss(); });
  el('close').addEventListener('click', () => { void dismiss(); });
  el('browser').addEventListener('change', () => render({ stage: 'ready' }));
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); void dismiss(); });
  setInterval(async () => {
    if (!dialog.open || !operationId || terminal.has(state) || polling || actionBusy) return;
    polling = true;
    reportBusy();
    const ticket = revision;
    try {
      const view = await command('login-action', { operationId, action: 'status' });
      if (ticket === revision && dialog.open) render(view);
    } catch (error) { if (ticket === revision) el('message').textContent = messageFor(error); }
    finally { polling = false; reportBusy(); }
  }, 2000);
})();
