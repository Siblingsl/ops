const origin = document.getElementById('origin');
const connectionState = document.getElementById('connection-state');
const version = document.getElementById('version');
const aiStatus = document.getElementById('ai-status');
const account = document.getElementById('account');
const reauthState = document.getElementById('reauth-state');
const storageState = document.getElementById('storage-state');
const deviceState = document.getElementById('device-state');
const channelState = document.getElementById('channel-state');
const actionStatus = document.getElementById('action-status');
const modelSelect = document.getElementById('model-select');
const modelName = document.getElementById('model-name');
const baseUrl = document.getElementById('base-url');
const proxyMode = document.getElementById('model-proxy-mode');
const proxyUrl = document.getElementById('model-proxy-url');
const proxyUsername = document.getElementById('model-proxy-username');
const proxyPassword = document.getElementById('model-proxy-password');
const proxyAuthState = document.getElementById('proxy-auth-state');
const modelNames = document.getElementById('model-names');
const allowedImageHosts = document.getElementById('allowed-image-hosts');
const apiKey = document.getElementById('api-key');
const keyState = document.getElementById('key-state');
const deleteModelButton = document.getElementById('delete-model');
const modelsById = new Map();
const routeList = document.getElementById('route-list');
const testModel = document.getElementById('test-model');
const settingsTabs = Array.from(document.querySelectorAll('[data-settings-tab]'));
const settingsPanels = Array.from(document.querySelectorAll('[data-settings-panel]'));
const platformBrowserState = document.getElementById('platform-browser-state');
const platformBrowserChecked = document.getElementById('platform-browser-checked');
const platformBrowserStatus = document.getElementById('platform-browser-status');
const platformLoginAccount = document.getElementById('platform-login-account');
const platformLoginStart = document.getElementById('platform-login-start');
const platformLoginStatus = document.getElementById('platform-login-status');
let routeTypes = [];
let serverModels = [];
let desktopModels = [];
let routeRevision = 0;
let routeRows = [];
let currentDeviceId = '';

const embeddedPanel = new URL(location.href).pathname.match(/^\/embedded\/(connection|ai|account-device|diagnostics)$/)?.[1] ?? null;
const activePanelNames = embeddedPanel === 'ai' ? ['models', 'selftest', 'routes']
  : embeddedPanel === 'account-device' ? ['account']
    : embeddedPanel === 'diagnostics' ? ['diagnostics']
      : embeddedPanel === 'connection' ? ['connection'] : [];
let activeOperations = 0;
let panelBaselines = new Map();
let dirty = false;
let externalBusy = false;

function currentPanelValues(name) {
  const panel = document.querySelector(`[data-settings-panel="${name}"]`);
  if (!panel) return new Map();
  return new Map(Array.from(panel.querySelectorAll('input:not(:disabled), select:not(:disabled), textarea:not(:disabled)'))
    .filter((control) => control.type !== 'hidden' && control.id !== 'test-model')
    .map((control, index) => {
      const row = control.closest('[data-task-type]');
      const key = control.id || `${row?.dataset.taskType ?? name}:${index}`;
      const value = control.type === 'checkbox' ? String(control.checked) : control.value;
      return [key, value];
    }));
}

function updateLocalState() {
  if (embeddedPanel) {
    dirty = activePanelNames.some((name) => {
      const baseline = panelBaselines.get(name);
      if (!baseline) return false;
      const current = currentPanelValues(name);
      return current.size !== baseline.size || Array.from(current).some(([key, value]) => baseline.get(key) !== value);
    });
    settingsApi.reportLocalState({ dirty, busy: activeOperations > 0 || externalBusy });
  }
}

function savePanelBaseline(name) {
  panelBaselines.set(name, currentPanelValues(name));
  updateLocalState();
}

const busyMethods = new Set([
  'getInfo', 'getModels', 'getDevices', 'getRoutes', 'platformBrowser', 'platformCommand',
  'startModelTest', 'getModelTest', 'applyMode', 'reauthenticate', 'clearAccountData',
  'saveModel', 'deleteModel', 'connectAI', 'disconnectAI', 'retryBusinessPage', 'openLoginPage',
  'exportDiagnostics', 'revokeDevice'
]);
const desktopSettingsBridge = window.opsDesktopSettings;
const settingsApi = new Proxy({}, {
  get(_target, property) {
    const value = desktopSettingsBridge[property];
    if (typeof value !== 'function') return value;
    const invoke = (...args) => value.apply(desktopSettingsBridge, args);
    if (!busyMethods.has(property)) return invoke;
    return (...args) => {
      activeOperations += 1;
      updateLocalState();
      let result;
      try { result = invoke(...args); }
      catch (error) { activeOperations -= 1; updateLocalState(); throw error; }
      return Promise.resolve(result).finally(() => { activeOperations -= 1; updateLocalState(); });
    };
  }
});

if (embeddedPanel) {
  document.body.classList.add('embedded-settings');
  document.body.dataset.embeddedPanel = embeddedPanel;
  const content = document.getElementById('settings-content');
  content.inert = true;
  settingsPanels.forEach((panel) => { panel.hidden = !activePanelNames.includes(panel.dataset.settingsPanel); });
  const heading = document.querySelector(`[data-settings-panel="${activePanelNames[0]}"] > h2`);
  if (heading) { heading.tabIndex = -1; }
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !document.getElementById('platform-login-dialog').open) {
      event.preventDefault();
      window.location.href = 'ops-desktop://ui/settings/close';
    }
  }, true);
}

for (const eventName of ['input', 'change', 'click']) {
  document.addEventListener(eventName, () => queueMicrotask(updateLocalState));
}
document.addEventListener('ops-local-settings-busy', (event) => {
  externalBusy = Boolean(event.detail?.busy);
  updateLocalState();
});

function activateSettingsTab(name, moveFocus = false) {
  settingsTabs.forEach((tab) => {
    const active = tab.dataset.settingsTab === name;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    if (active && moveFocus) tab.focus();
  });
  settingsPanels.forEach((panel) => {
    panel.hidden = panel.dataset.settingsPanel !== name;
  });
}

for (const tab of settingsTabs) {
  tab.addEventListener('click', () => activateSettingsTab(tab.dataset.settingsTab));
}

document.querySelector('.settings-nav').addEventListener('keydown', (event) => {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const current = settingsTabs.indexOf(document.activeElement);
  const next = event.key === 'Home' ? 0
    : event.key === 'End' ? settingsTabs.length - 1
      : (current + (event.key === 'ArrowDown' ? 1 : -1) + settingsTabs.length) % settingsTabs.length;
  activateSettingsTab(settingsTabs[next].dataset.settingsTab, true);
});

function setStatus(message) {
  actionStatus.textContent = message;
}

function userFacingError(error, fallback) {
  const message = error instanceof Error ? error.message : fallback;
  return message.replace(/^Error invoking remote method '[^']+': Error: /, '');
}

// 重新认证过期有两条来源，文案不同但用户要做的事一样：
//   1) 服务端 requireReauth 返回 403 reauth_required →「这是敏感操作，请先输入登录密码确认」；
//   2) 客户端 ensureDevice 在本地先拦（还没发请求）→「请先在本窗口完成密码重新认证，再创建本机设备。」
// 两条都必须识别，否则界面会把第 2 种当成未知故障直接回显原始错误。
// （auth.go 的 reauthWindow 只有 5 分钟，打开设置页时通常已经过期，所以这是常态不是故障。）
const REAUTH_HINTS = [
  '这是敏感操作，请先输入登录密码确认',
  '请先在本窗口完成密码重新认证'
];
const REAUTH_HINT = REAUTH_HINTS[0];
const REAUTH_ACTION_TEXT = '去「账号与设备」重新认证';

function isReauthRequired(error) {
  const message = userFacingError(error, '');
  return REAUTH_HINTS.some((hint) => message.includes(hint));
}

// 服务端版本旧时该路由不存在，客户端拿到的是 HTTP 404。
// 这与网络故障的处理方式完全不同：不该让用户去查网络或重装客户端。
function isEndpointMissing(error) {
  return /HTTP 404/.test(userFacingError(error, ''));
}

// guideToReauth 切到账号页并把焦点放到密码框，用户不需要自己找入口。
function guideToReauth(focusTarget) {
  activateSettingsTab('account');
  const password = document.getElementById('password');
  if (password) password.focus();
  if (focusTarget) {
    focusTarget.textContent = `${REAUTH_HINT}。已切到「账号与设备」，请输入当前账号密码。`;
  }
}

function getSelectedModel() {
  return modelsById.get(modelSelect.value);
}

function clearModelForm() {
  modelSelect.value = '';
  modelName.value = '';
  baseUrl.value = '';
  proxyMode.value = 'direct';
  proxyUrl.value = '';
  proxyUsername.value = '';
  proxyPassword.value = '';
  proxyAuthState.textContent = '';
  modelNames.value = '';
  allowedImageHosts.value = '';
  apiKey.value = '';
  keyState.textContent = '';
  deleteModelButton.hidden = true;
  syncProxyFields();
}

function syncProxyFields() {
  let loopback = false;
  try {
    const host = new URL(baseUrl.value).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    loopback = host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
  } catch {}
  if (loopback) proxyMode.value = 'direct';
  proxyMode.disabled = loopback;
  const manual = !loopback && proxyMode.value === 'manual';
  proxyUrl.disabled = !manual;
  proxyUsername.disabled = !manual;
  proxyPassword.disabled = !manual;
}

function renderModels(models) {
  modelsById.clear();
  modelSelect.replaceChildren(new Option('新建配置…', ''));
  for (const model of models) {
    modelsById.set(model.providerId, model);
    const option = new Option(
      `${model.name} · ${model.hasKey ? model.keyMask : '无密钥'} · rev ${model.configRevision}`,
      model.providerId
    );
    modelSelect.add(option);
  }
}

async function loadInfo() {
  try {
    const info = await settingsApi.getInfo();
    origin.textContent = info.apiOrigin;
    connectionState.textContent = {
      online: '已打开业务页面',
      offline: '线上服务不可达',
      unknown: '等待连接'
    }[info.connectionState];
    version.textContent = info.appVersion;
    const clientVersion = document.getElementById('about-client-version');
    const serviceVersion = document.getElementById('about-service-version');
    const serviceMode = document.getElementById('about-service-mode');
    const dataSize = document.getElementById('about-data-size');
    if (clientVersion) clientVersion.textContent = info.appVersion;
    if (serviceVersion) serviceVersion.textContent = info.systemInfo?.version ?? '当前无法读取';
    if (serviceMode) serviceMode.textContent = info.systemInfo ? (info.systemInfo.dev ? '本地开发' : '生产') : '当前无法读取';
    if (dataSize) dataSize.textContent = info.systemInfo ? `${(info.systemInfo.dataBytes / 1024 / 1024).toFixed(1)} MB` : '当前无法读取';
    aiStatus.textContent = info.aiStatus;
    const state = info.clientState;
    currentDeviceId = state.localConfigAvailable ? state.deviceId : '';
    document.getElementById('current-mode').textContent = `当前模式：${state.mode === 'desktop' ? '此客户端 AI' : '服务器 AI'}（路由版本 ${state.routeRevision}）${state.localConfigAvailable ? '' : '；本机配置文件无法读取，暂不可更改'}`;
    document.getElementById('mode-select').value = state.mode;
    document.getElementById('mode-select').disabled = !state.localConfigAvailable;
    document.getElementById('apply-mode').disabled = !state.localConfigAvailable;
    account.textContent = state.signedIn
      ? `${state.username} · ${state.workspaceName}`
      : '未登录；请先打开线上业务页登录';
    document.getElementById('clear-account-data').disabled = !state.signedIn || !state.localConfigAvailable;
    reauthState.textContent = state.signedIn
      ? state.reauthRequired ? '需要重新认证' : '已认证'
      : '尚未登录';
    storageState.textContent = state.storageAvailable ? '可用（系统加密）' : '不可用；不会保存密钥';
    deviceState.textContent = state.deviceRegistered === null ? '本机配置文件无法读取' : state.deviceRegistered ? '已注册' : '尚未注册';
    channelState.textContent = state.channelMessage;
    setStatus(state.localConfigAvailable ? '' : '在线账号和工作区已读取；本机配置文件无法读取，模型、设备和模式修改已停用。');
  } catch (error) {
    const unavailable = '暂时无法读取';
    currentDeviceId = '';
    [origin, connectionState, version, aiStatus, account, reauthState, storageState, deviceState, channelState,
      document.getElementById('about-client-version'), document.getElementById('about-service-version'),
      document.getElementById('about-service-mode'), document.getElementById('about-data-size')]
      .forEach((element) => { if (element) element.textContent = unavailable; });
    document.getElementById('mode-select').disabled = true;
    document.getElementById('apply-mode').disabled = true;
    document.getElementById('current-mode').textContent = '当前客户端状态暂时无法读取';
    document.getElementById('clear-account-data').disabled = true;
    setStatus(userFacingError(error, '无法读取客户端信息。请检查主窗口连接后重新打开此设置分类。'));
  }
}

async function loadModels() {
  try {
    const models = await settingsApi.getModels();
    renderModels(models);
    renderTestModels(models);
  } catch (error) {
    renderModels([]);
    renderTestModels([]);
    setStatus(userFacingError(error, '无法读取本机模型配置。'));
  }
}

function renderTestModels(models) {
  testModel.replaceChildren(new Option('请选择模型', ''));
  for (const model of models) {
    for (const name of model.models) {
      const key = JSON.stringify({ providerId: model.providerId, model: name });
      testModel.add(new Option(`${model.name} · ${name}`, key));
    }
  }
}

// D-129 v0.5：本机平台浏览器探测。只展示品牌与版本；路径、profile 与会话内容都不出现在页面上。
const platformBrowserFailure = {
  platform_browser_unsupported: '没有找到可用的浏览器。请先安装 Google Chrome 或 Microsoft Edge 后重新检测。',
  platform_browser_launch_failed: '找到了浏览器但无法启动。请先手动打开一次该浏览器，确认没有被安全软件或企业策略拦截。'
};

function renderPlatformBrowser(status) {
  if (!status) {
    platformBrowserState.textContent = '尚未检测';
    platformBrowserChecked.textContent = '—';
    return;
  }
  if (status.state === 'ready') {
    platformBrowserState.textContent = `${status.name} ${status.version}`;
    platformBrowserStatus.textContent = '平台采集会在独立配置目录中使用这个浏览器，不使用 Playwright 自带的浏览器内核。';
  } else {
    platformBrowserState.textContent = status.state === 'unsupported' ? '未找到可用浏览器' : '浏览器无法启动';
    platformBrowserStatus.textContent = platformBrowserFailure[status.errorCode] ?? '浏览器检测失败，请稍后重试。';
  }
  platformBrowserChecked.textContent = status.checkedAt ? new Date(status.checkedAt).toLocaleString() : '—';
}

async function loadPlatformBrowser(refresh = false) {
  try {
    renderPlatformBrowser(await settingsApi.platformBrowser(refresh ? { refresh: true } : undefined));
  } catch (error) {
    platformBrowserStatus.textContent = userFacingError(error, '浏览器检测失败。');
  }
}

async function loadDevices() {
  const container = document.getElementById('device-list');
  try {
    const result = await settingsApi.getDevices();
    if (result.devices.length === 0) {
      container.textContent = '尚未注册设备。';
      return;
    }
    const rows = result.devices.map((device) => {
      const row = document.createElement('div');
      row.className = 'device-item';
      const description = document.createElement('span');
      const current = device.id === currentDeviceId ? ' · 本机当前设备' : '';
      const revoked = device.revoked_at ? ' · 已回收' : '';
      description.textContent = `${device.name} · ${device.platform} · ${device.id}${current}${revoked}`;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'secondary small';
      button.textContent = '回收';
      button.disabled = Boolean(device.revoked_at);
      button.addEventListener('click', async () => {
        if (!window.confirm(`回收设备 ${device.name}？此操作会终止该设备的客户端 AI 通道。`)) return;
        setStatus('正在回收设备…');
        try {
          await settingsApi.revokeDevice({
            deviceId: device.id,
            password: document.getElementById('password').value
          });
          document.getElementById('password').value = '';
          await Promise.all([loadDevices(), loadInfo(), loadRoutes()]);
          setStatus('设备已回收。');
        } catch (error) {
          setStatus(userFacingError(error, '设备回收失败。'));
        }
      });
      row.append(description, button);
      return row;
    });
    container.replaceChildren(...rows);
    if (result.reauthRequired) {
      // 认证过期提示写回设备卡片自己的状态行，确保用户在当前页能看到。
      document.getElementById('device-status').textContent = '重新认证已过期（有效期 5 分钟）；回收设备前需要重新输入密码。';
    } else {
      document.getElementById('device-status').textContent = '';
    }
  } catch (error) {
    if (isReauthRequired(error)) {
      container.textContent = '重新认证已过期（有效期 5 分钟），完成认证后即可读取设备列表。';
      return;
    }
    if (isEndpointMissing(error)) {
      // 旧服务器没有 GET /desktop/devices（该路由随客户端新版本一起发布）。
      // 直接说清“服务端版本旧”，不要显示成 HTTP 404 让用户去查网络。
      container.textContent = '当前线上服务版本较旧，暂不提供设备列表。请先升级服务端后刷新。';
      return;
    }
    container.textContent = userFacingError(error, '无法读取本人设备列表。');
  }
}

function selectModelOptions(select, location, selected) {
  select.replaceChildren(new Option(location === 'disabled' ? '无需模型' : '请选择主模型', ''));
  const providers = location === 'desktop' ? desktopModels : serverModels;
  for (const provider of providers) {
    if (provider.status && provider.status !== 'active') continue;
    for (const model of provider.models) {
      const value = JSON.stringify({ providerId: provider.id ?? provider.providerId, model });
      select.add(new Option(`${provider.name} · ${model}`, value));
    }
  }
  if (selected) select.value = JSON.stringify({ providerId: selected.provider_id, model: selected.model });
  select.disabled = location === 'disabled';
}

function makeRouteRow(type, existing) {
  const wrapper = document.createElement('div');
  wrapper.className = 'route-item';
  wrapper.dataset.taskType = type.task_type;
  const label = document.createElement('strong');
  label.textContent = type.label;
  const location = document.createElement('select');
  for (const [value, text] of [['disabled', '停用'], ['server', '服务器'], ['desktop', '此客户端']]) {
    if (type.task_type === 'embedding' && value === 'desktop') continue;
    location.add(new Option(text, value));
  }
  location.value = existing?.execution_location ?? 'disabled';
  const primary = document.createElement('select');
  const fallback = document.createElement('select');
  const selected = existing ? {
    provider_id: existing.provider_id,
    model: existing.model
  } : null;
  const selectedFallback = existing?.fallback_provider_id ? {
    provider_id: existing.fallback_provider_id,
    model: existing.fallback_model
  } : null;
  selectModelOptions(primary, location.value, selected);
  selectModelOptions(fallback, location.value, selectedFallback);
  fallback.firstChild.textContent = '无备用模型';
  location.addEventListener('change', () => {
    selectModelOptions(primary, location.value, null);
    selectModelOptions(fallback, location.value, null);
    fallback.firstChild.textContent = '无备用模型';
  });
  wrapper.append(label, location, primary, fallback);
  return { wrapper, location, primary, fallback };
}

async function loadRoutes() {
  const routeStatus = document.getElementById('route-status');
  const reauthButton = document.getElementById('routes-reauth');
  if (reauthButton) reauthButton.hidden = true;
  try {
    const result = await settingsApi.getRoutes();
    routeTypes = result.routeTypes;
    serverModels = result.serverModels;
    desktopModels = result.desktopModels.map((model) => ({ ...model, id: model.providerId, status: 'active' }));
    routeRevision = result.desktopRoutes.has_draft
      ? result.desktopRoutes.draft_revision
      : result.desktopRoutes.policy_revision;
    const sourceRoutes = result.desktopRoutes.draft_routes ?? result.desktopRoutes.routes;
    const saved = new Map(sourceRoutes.map((route) => [route.task_type, route]));
    routeRows = routeTypes.map((type) => makeRouteRow(type, saved.get(type.task_type)));
    routeList.replaceChildren(...routeRows.map((row) => row.wrapper));
    routeStatus.textContent = result.desktopRoutes.has_draft
      ? `本机有未应用草稿（基于路由版本 ${routeRevision}；当前线上版本 ${result.desktopRoutes.policy_revision}）。`
      : `当前线上路由版本 ${routeRevision}。`;
  } catch (error) {
    routeRows = [];
    if (isReauthRequired(error)) {
      // 重新认证过期是常态而不是故障：说明原因并给出就地入口，不显示成读取失败。
      routeList.textContent = '重新认证已过期（有效期 5 分钟），完成认证后即可读取任务映射。';
      routeStatus.textContent = '';
      if (reauthButton) reauthButton.hidden = false;
      return;
    }
    routeList.textContent = userFacingError(error, '无法读取任务映射。请先启用工作区策略并完成重新认证。');
  }
}

modelSelect.addEventListener('change', () => {
  const model = getSelectedModel();
  if (!model) {
    clearModelForm();
    return;
  }
  modelName.value = model.name;
  baseUrl.value = model.baseUrl;
  proxyMode.value = model.proxyMode;
  proxyUrl.value = model.proxyUrl;
  proxyUsername.value = '';
  proxyPassword.value = '';
  proxyAuthState.textContent = model.hasProxyAuth ? '凭证已保存；留空保持不变' : '未设置';
  modelNames.value = model.models.join('\n');
  allowedImageHosts.value = model.allowedImageHosts.join('\n');
  apiKey.value = '';
  keyState.textContent = model.hasKey ? `已保存 ${model.keyMask}；留空保持不变` : '未设置';
  deleteModelButton.hidden = false;
  syncProxyFields();
  setStatus('');
});

document.getElementById('clear-form').addEventListener('click', () => {
  clearModelForm();
  setStatus('');
});

baseUrl.addEventListener('input', syncProxyFields);
proxyMode.addEventListener('change', syncProxyFields);

deleteModelButton.addEventListener('click', async () => {
  const selected = getSelectedModel();
  if (!selected) return;
  setStatus('正在停用并移除模型配置…');
  try {
    const models = await settingsApi.deleteModel({
      providerId: selected.providerId,
      configRevision: selected.configRevision
    });
    if (!models) {
      setStatus('已取消。');
      return;
    }
    clearModelForm();
    renderModels(models);
    renderTestModels(models);
    await Promise.all([loadInfo(), loadRoutes()]);
    setStatus('模型配置已停用并从本机移除；任务映射已刷新。');
  } catch (error) {
    setStatus(userFacingError(error, '模型配置移除失败。'));
  }
});

document.getElementById('refresh-models').addEventListener('click', async () => {
  setStatus('正在刷新本机模型配置…');
  await loadModels();
  await loadInfo();
  setStatus('本机配置已刷新。');
});

document.getElementById('model-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const selected = getSelectedModel();
  const models = modelNames.value.split(/[\n,，]/).map((item) => item.trim()).filter(Boolean);
  setStatus('正在验证并保存配置…');
  try {
    const saved = await settingsApi.saveModel({
      ...(selected ? { providerId: selected.providerId, configRevision: selected.configRevision } : {}),
      name: modelName.value,
      baseUrl: baseUrl.value,
      proxyMode: proxyMode.value,
      proxyUrl: proxyUrl.value,
      proxyUsername: proxyUsername.value,
      proxyPassword: proxyPassword.value,
      models,
      apiKey: apiKey.value,
      allowedImageHosts: allowedImageHosts.value.split(/[\s,，]+/).map((item) => item.trim()).filter(Boolean)
    });
    apiKey.value = '';
    proxyUsername.value = '';
    proxyPassword.value = '';
    renderModels(saved);
    renderTestModels(saved);
    const latest = saved.find((model) => model.providerId === (selected?.providerId ?? saved.at(-1)?.providerId));
    if (latest) modelSelect.value = latest.providerId;
    await loadInfo();
    setStatus('配置已保存。密钥未返回页面。');
    savePanelBaseline('models');
  } catch (error) {
    setStatus(userFacingError(error, '配置保存失败。'));
  }
});

document.getElementById('reauth').addEventListener('click', async () => {
  const password = document.getElementById('password');
  if (!password.value) {
    setStatus('请输入当前账号密码后再重新认证。');
    password.focus();
    return;
  }
  setStatus('正在重新认证…');
  try {
    await settingsApi.reauthenticate(password.value);
    password.value = '';
    // 认证成功后必须重新拉取依赖认证状态的视图：原实现只刷新 loadInfo()，
    // 导致「任务映射」和「设备列表」仍停在“需要重新认证”，用户会以为认证没生效。
    await Promise.all([loadInfo(), loadDevices(), loadRoutes()]);
    savePanelBaseline('account');
    setStatus('账号已重新认证，有效期 5 分钟。');
  } catch (error) {
    setStatus(userFacingError(error, '重新认证失败。'));
  }
});

document.getElementById('routes-reauth').addEventListener('click', () => {
  guideToReauth(document.getElementById('route-status'));
});

document.getElementById('clear-account-data').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  setStatus('正在清除此账号的本机数据…');
  try {
    const cleared = await settingsApi.clearAccountData();
    if (cleared) window.location.reload();
    else {
      await loadInfo();
      setStatus('已取消清理。');
    }
  } catch (error) {
    await loadInfo();
    setStatus(userFacingError(error, '本机数据清理失败。'));
  } finally {
    button.disabled = false;
  }
});

document.getElementById('connect-ai').addEventListener('click', async () => {
  setStatus('正在建立设备通道…');
  try {
    await settingsApi.connectAI();
    await loadInfo();
    setStatus('WSS 通道已连接；尚未发起模型自检或启用业务路由。');
  } catch (error) {
    await loadInfo();
    setStatus(userFacingError(error, '通道连接失败。'));
  }
});

document.getElementById('disconnect-ai').addEventListener('click', async () => {
  await settingsApi.disconnectAI();
  await loadInfo();
  setStatus('客户端 AI 通道已断开。');
});

document.getElementById('refresh-devices').addEventListener('click', () => void loadDevices());

// ---------- 本机残留配置目录（§5.4） ----------
//
// 只做"检查 + 由用户点按钮清理单个平台"，不提供"全部清理"。
// 清理范围仅限服务端已不认识的连接目录，主进程会再次核对，界面不下判断。

const platformOrphanCount = document.getElementById('platform-orphan-count');
const platformOrphanStatus = document.getElementById('platform-orphan-status');
const platformOrphanCheck = document.getElementById('platform-orphan-check');
const platformOrphanClear = document.getElementById('platform-orphan-clear');
const platformOrphanClearWx = document.getElementById('platform-orphan-clear-wx');

const PLATFORM_LABELS = { xhs: '小红书', wechat_mp: '公众号' };

// renderOrphanCount 把 read-status 的结果画到卡片上；null 表示读不到，不冒充 0。
function renderOrphanCount(orphans) {
  if (!orphans) {
    platformOrphanCount.textContent = '暂时读不到（需要连接到服务器）';
    platformOrphanClear.disabled = true;
    platformOrphanClearWx.disabled = true;
    return;
  }
  const xhs = Number(orphans.xhs) || 0;
  const wx = Number(orphans.wechat_mp) || 0;
  const total = Number(orphans.total) || 0;
  platformOrphanCount.textContent = total === 0
    ? '没有残留目录'
    : `小红书 ${xhs} 个、公众号 ${wx} 个`;
  // 数量为 0 时按钮禁用，避免点了什么都没发生。
  platformOrphanClear.disabled = xhs === 0;
  platformOrphanClearWx.disabled = wx === 0;
}

async function refreshOrphanCount() {
  try {
    const result = await settingsApi.platformCommand({
      v: 1, id: `orphan_${Date.now()}`, cmd: 'read-status'
    });
    if (result && result.ok === false) {
      platformOrphanStatus.textContent = userFacingError(result, '读取失败。');
      return;
    }
    renderOrphanCount(result?.data?.orphanProfiles ?? null);
  } catch (error) {
    platformOrphanStatus.textContent = userFacingError(error, '读取失败。');
  }
}

async function clearOrphanFor(platform) {
  const label = PLATFORM_LABELS[platform] ?? platform;
  const button = platform === 'xhs' ? platformOrphanClear : platformOrphanClearWx;
  button.disabled = true;
  platformOrphanStatus.textContent = `正在清理${label}的残留目录…`;
  try {
    const result = await settingsApi.platformCommand({
      v: 1,
      id: `orphan_clear_${Date.now()}`,
      cmd: 'clear-orphan-profiles',
      payload: { platform }
    });
    if (result && result.ok === false) {
      platformOrphanStatus.textContent = userFacingError(result, '清理失败。');
      return;
    }
    const data = result?.data ?? {};
    const found = Number(data.found) || 0;
    const removed = Number(data.removed) || 0;
    const skipped = Number(data.skipped) || 0;
    if (found === 0) {
      platformOrphanStatus.textContent = `没有需要清理的${label}残留目录。`;
    } else if (skipped > 0) {
      // 浏览器占用时删不掉，如实说明，不说"已完成"。
      platformOrphanStatus.textContent = `清理了 ${removed} 个${label}目录，${skipped} 个被占用未能删除，请关闭对应浏览器窗口后重试。`;
    } else {
      platformOrphanStatus.textContent = `已清理 ${removed} 个${label}残留目录。`;
    }
    await refreshOrphanCount();
  } catch (error) {
    platformOrphanStatus.textContent = userFacingError(error, '清理失败。');
  } finally {
    button.disabled = false;
  }
}

platformOrphanCheck.addEventListener('click', async () => {
  platformOrphanCheck.disabled = true;
  platformOrphanStatus.textContent = '正在检查…';
  try {
    await refreshOrphanCount();
    platformOrphanStatus.textContent = '';
  } finally {
    platformOrphanCheck.disabled = false;
  }
});
platformOrphanClear.addEventListener('click', () => clearOrphanFor('xhs'));
platformOrphanClearWx.addEventListener('click', () => clearOrphanFor('wechat_mp'));

document.getElementById('refresh-routes').addEventListener('click', () => void loadRoutes());

document.getElementById('save-routes').addEventListener('click', async () => {
  try {
    const routes = routeRows.map(({ wrapper, location, primary, fallback }) => {
      const taskType = wrapper.dataset.taskType;
      if (location.value === 'disabled') {
        return {
          task_type: taskType,
          execution_location: 'disabled',
          provider_id: null,
          model: '',
          fallback_provider_id: null,
          fallback_model: ''
        };
      }
      if (!primary.value) throw new Error(`请为“${wrapper.firstChild.textContent}”选择主模型。`);
      const main = JSON.parse(primary.value);
      const backup = fallback.value ? JSON.parse(fallback.value) : null;
      return {
        task_type: taskType,
        execution_location: location.value,
        provider_id: main.providerId,
        model: main.model,
        fallback_provider_id: backup?.providerId ?? null,
        fallback_model: backup?.model ?? ''
      };
    });
    setStatus('正在保存本机映射草稿…');
    const saved = await settingsApi.saveRoutes({ routes, expectedRevision: routeRevision });
    routeRevision = saved.policy_revision;
    await loadRoutes();
    savePanelBaseline('routes');
    setStatus(`本机映射草稿已保存（基于路由版本 ${routeRevision}）；确认应用模式时才会提交线上映射。`);
  } catch (error) {
    setStatus(userFacingError(error, '任务映射保存失败。'));
  }
});

document.getElementById('apply-mode').addEventListener('click', async () => {
  const mode = document.getElementById('mode-select').value;
  setStatus('正在校验并应用执行模式…');
  try {
    const applied = await settingsApi.applyMode(mode);
    if (applied) { setStatus('模式已应用，业务页面正在重新加载。'); savePanelBaseline('connection'); }
    else setStatus('已取消。');
    await loadInfo();
  } catch (error) {
    setStatus(userFacingError(error, '执行模式应用失败。'));
  }
});

document.getElementById('start-model-test').addEventListener('click', async () => {
  if (!testModel.value) {
    setStatus('请先选择本机模型。');
    return;
  }
  if (!window.confirm('能力自检会实际调用该模型，可能产生费用。继续吗？')) return;
  const selected = JSON.parse(testModel.value);
  const output = document.getElementById('test-result');
  output.textContent = '正在连接并启动自检…';
  try {
    await settingsApi.connectAI();
    const started = await settingsApi.startModelTest(selected);
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const result = await settingsApi.getModelTest(started.test_id);
      output.textContent = `${result.status} · ${result.stage}\n${result.summary ?? ''}`;
      if (result.status !== 'running') {
        if (Array.isArray(result.results)) output.textContent += `\n${JSON.stringify(result.results, null, 2)}`;
        await loadRoutes();
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } catch (error) {
    output.textContent = userFacingError(error, '模型能力自检失败。');
  }
});

document.getElementById('retry').addEventListener('click', async () => {
  setStatus('正在重新连接线上服务…');
  await settingsApi.retryBusinessPage();
});

document.getElementById('export-diagnostics').addEventListener('click', async () => {
  setStatus('正在准备脱敏诊断文件…');
  try {
    const saved = await settingsApi.exportDiagnostics();
    setStatus(saved ? '诊断文件已保存。' : '已取消导出。');
  } catch (error) {
    setStatus(userFacingError(error, '诊断文件导出失败。'));
  }
});

document.getElementById('login').addEventListener('click', async () => {
  setStatus('正在打开登录页面…');
  await settingsApi.openLoginPage();
});

document.getElementById('detect-platform-browser').addEventListener('click', async () => {
  platformBrowserStatus.textContent = '正在启动浏览器做一次握手检测…';
  await loadPlatformBrowser(true);
});

syncProxyFields();
if (!embeddedPanel) activateSettingsTab('connection');
const initialLoads = embeddedPanel === 'connection' ? [loadInfo()]
  : embeddedPanel === 'ai' ? [loadModels(), loadRoutes()]
    : embeddedPanel === 'account-device' ? [loadInfo(), loadDevices(), loadPlatformBrowser()]
      : embeddedPanel === 'diagnostics' ? [loadInfo()]
        : [loadInfo(), loadModels(), loadRoutes(), loadDevices(), loadPlatformBrowser()];
void Promise.all(initialLoads).finally(() => {
  if (!embeddedPanel) return;
  activePanelNames.forEach(savePanelBaseline);
  document.getElementById('settings-content').inert = false;
  document.querySelector(`[data-settings-panel="${activePanelNames[0]}"] > h2`)?.focus();
  updateLocalState();
});
