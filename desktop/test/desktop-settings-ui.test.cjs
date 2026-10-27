const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const settingsDir = path.join(__dirname, '..', 'public', 'settings');
const settingsHtml = fs.readFileSync(path.join(settingsDir, 'index.html'), 'utf8');
const offlineHtml = fs.readFileSync(path.join(settingsDir, 'offline.html'), 'utf8');
const settingsScript = fs.readFileSync(path.join(settingsDir, 'settings.js'), 'utf8');
const settingsCss = fs.readFileSync(path.join(settingsDir, 'settings.css'), 'utf8');

test('本地设置与离线页保留 Electron 标题栏、主题和减少动效入口', () => {
  for (const html of [settingsHtml, offlineHtml]) {
    assert.match(html, /desktop-window-titlebar/);
    assert.match(html, /ops-desktop:\/\/ui\/menu\/client/);
    assert.match(html, /ops-desktop:\/\/ui\/menu\/edit/);
    assert.match(html, /ops-desktop:\/\/ui\/menu\/view/);
    assert.match(html, /data-desktop-theme-toggle/);
    assert.match(html, /data-desktop-motion-toggle/);
    assert.match(html, /src="\/desktop-theme\.js"/);
    assert.equal((html.match(/href="ops-desktop:\/\/ui\/menu\/(?:client|edit|view)" target="_blank"/g) ?? []).length, 3);
  }
  assert.match(fs.readFileSync(path.join(settingsDir, 'desktop-theme.js'), 'utf8'), /window\.open\(`ops-desktop:\/\/ui\/theme\/\$\{theme\}`/);
  assert.match(fs.readFileSync(path.join(settingsDir, 'desktop-theme.js'), 'utf8'), /prefers-color-scheme: dark/);
  assert.match(fs.readFileSync(path.join(settingsDir, 'desktop-theme.js'), 'utf8'), /__OPS_DESKTOP_THEME__/);
  assert.match(fs.readFileSync(path.join(settingsDir, 'desktop-theme.js'), 'utf8'), /__OPS_DESKTOP_REDUCED_MOTION__/);
  assert.match(fs.readFileSync(path.join(settingsDir, 'desktop-theme.js'), 'utf8'), /ops-desktop:\/\/ui\/motion/);
  assert.doesNotMatch(fs.readFileSync(path.join(settingsDir, 'desktop-theme.js'), 'utf8'), /location\.assign/);
});

test('客户端设置脚本引用的业务控件仍全部存在于页面', () => {
  const expectedIds = [...settingsScript.matchAll(/getElementById\('([^']+)'\)/g)].map((match) => match[1]);
  for (const id of expectedIds) assert.match(settingsHtml, new RegExp(`\\bid="${id}"`), `missing settings control: ${id}`);
});

test('六个客户端本机设置分类都有对应面板，主题与减少动效样式均有双主题覆盖', () => {
  const tabs = [...settingsHtml.matchAll(/data-settings-tab="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(tabs, ['connection', 'models', 'selftest', 'routes', 'account', 'diagnostics']);
  for (const tab of tabs) {
    assert.match(settingsHtml, new RegExp(`aria-controls="panel-${tab}"`), `missing tab panel control: ${tab}`);
    assert.match(settingsHtml, new RegExp(`data-settings-panel="${tab}"`), `missing settings panel: ${tab}`);
  }
  assert.match(settingsScript, /ArrowDown/);
  assert.match(settingsScript, /activateSettingsTab/);
  assert.match(settingsCss, /:root\[data-theme="dark"\]/);
  assert.match(settingsCss, /prefers-reduced-motion/);
  assert.match(settingsCss, /data-reduced-motion="true"/);
});

test('DC12：统一设置中的四个本机嵌入面板各自只启用对应本机内容', () => {
  assert.match(settingsScript, /embeddedPanel === 'ai' \? \['models', 'selftest', 'routes'\]/);
  assert.match(settingsScript, /embeddedPanel === 'account-device' \? \['account'\]/);
  assert.match(settingsScript, /embeddedPanel === 'diagnostics' \? \['diagnostics'\]/);
  assert.match(settingsScript, /embeddedPanel === 'connection' \? \['connection'\]/);
  assert.match(settingsScript, /reportLocalState\(\{ dirty, busy: activeOperations > 0 \|\| externalBusy \}\)/);
  assert.match(settingsScript, /ops-desktop:\/\/ui\/settings\/close/);
  assert.match(settingsCss, /body\.embedded-settings \.settings-content/);
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.ts'), 'utf8').replace(/\r\n/g, '\n');
  for (const panel of ['connection', 'ai', 'account-device', 'diagnostics']) {
    assert.match(main, new RegExp(`/embedded/${panel}`));
  }
});

test('本机设置能区分在线账号状态与本机配置状态，并消除标题默认焦点框', () => {
  assert.match(settingsScript, /state\.localConfigAvailable/);
  assert.match(settingsScript, /本机配置文件无法读取/);
  assert.match(settingsScript, /在线账号和工作区已读取/);
  assert.match(settingsCss, /\.settings-tab-panel > h2:focus\s*\{\s*outline:\s*none;/);
});

test('离线页保留重试、设置和登录入口', () => {
  for (const id of ['settings', 'login', 'retry', 'action-status']) {
    assert.match(offlineHtml, new RegExp(`\\bid="${id}"`));
  }
});

test('D-123/DC12：账号内容类型只在统一的当前账号设置中呈现', () => {
  assert.doesNotMatch(settingsHtml, /account-type-target|account-type-choice|apply-account-type/);
  assert.doesNotMatch(settingsScript, /changeAccountType|getBusinessAccounts/);
  const accountSettings = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'src', 'pages', 'settings', 'Accounts.tsx'), 'utf8');
  assert.match(accountSettings, /默认创作形态|账号类型/);
  assert.match(accountSettings, /同平台内可以更换类型/);
  assert.doesNotMatch(settingsScript, /confirm_type_change/);
});

test('D-123：preload 与主进程为内容类型迁移暴露 IPC，且带信任来源校验', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.ts'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.ts'), 'utf8');
  const client = fs.readFileSync(path.join(__dirname, '..', 'src', 'desktop-client.ts'), 'utf8');
  assert.match(preload, /changeAccountType/);
  assert.match(main, /ipcHandle\('settings:change-account-type'/);
  assert.match(main, /assertTrustedLocalSender\(event\);\n    if \(!desktopClient\) throw new Error\('客户端设置尚未初始化。'\);\n    if \(!value \|\| typeof value !== 'object'\)/);
  assert.match(main, /dialog\.showMessageBox/);
  assert.match(client, /async changeAccountContentFormat/);
  assert.match(client, /async listBusinessAccounts/);
  assert.match(client, /async countBusinessWorks/);
  assert.match(client, /confirm_type_change: true/);
});

test('D-123：客户端类型清单与后端 formatMatrix 一致', () => {
  const matrix = fs.readFileSync(path.join(__dirname, '..', '..', 'server', 'internal', 'app', 'accounts.go'), 'utf8');
  const wechat = matrix.match(/"wechat_mp":\s*\{([^}]*)\}/)[1];
  const xhs = matrix.match(/"xhs":\s*\{([^}]*)\}/)[1];
  for (const value of ['long_article', 'qa_article', 'briefing', 'card_post', 'script', 'comic']) {
    assert.match(wechat, new RegExp(`"${value}"`), `wechat matrix missing ${value}`);
  }
  for (const value of ['image_note', 'list_note', 'card_post', 'script', 'comic']) {
    assert.match(xhs, new RegExp(`"${value}"`), `xhs matrix missing ${value}`);
  }
  const script = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'src', 'components', 'ui.tsx'), 'utf8');
  for (const value of ['long_article', 'qa_article', 'briefing', 'card_post', 'script', 'comic', 'image_note', 'list_note']) {
    assert.match(script, new RegExp(`'${value}'`), `unified settings account-type list missing ${value}`);
  }
});

// 重新认证过期（服务端 reauthWindow 只有 5 分钟）是常态，不是故障：
// 界面必须给出就地入口并说明原因，不能只丢一句“读取失败”。
test('重新认证过期时任务映射页给出就地入口，不显示成读取失败', () => {
  // 入口按钮存在于任务映射页，且默认隐藏（只有真的过期才出现）。
  assert.match(settingsHtml, /id="panel-routes"[\s\S]*id="routes-reauth"[\s\S]*hidden/);
  // 过期时显示说明并露出按钮，而不是走通用失败分支。
  const loadRoutes = settingsScript.match(/async function loadRoutes\(\)[\s\S]*?\n\}/);
  assert.ok(loadRoutes, '缺少 loadRoutes');
  const expiredBranch = loadRoutes[0].match(/if \(isReauthRequired\(error\)\) \{[\s\S]*?\n    \}/);
  assert.ok(expiredBranch, 'loadRoutes 必须有重新认证分支');
  assert.match(expiredBranch[0], /reauthButton\.hidden = false/);
  // 这个变量必须真的指向 routes-reauth，不能指向别的元素。
  assert.match(loadRoutes[0], /getElementById\('routes-reauth'\)/);
  assert.match(expiredBranch[0], /重新认证已过期/);
  // 两条来源都必须识别：服务端 reauth_required 与客户端 ensureDevice 的本地拦截。
  // 只认服务端那一条会把“任务映射”页最常见的报错当成未知故障回显。
  const hints = settingsScript.match(/const REAUTH_HINTS = \[[\s\S]*?\];/);
  assert.ok(hints, '缺少 REAUTH_HINTS');
  assert.match(hints[0], /这是敏感操作，请先输入登录密码确认/);
  assert.match(hints[0], /请先在本窗口完成密码重新认证/);
  assert.match(settingsScript, /REAUTH_HINTS\.some\(/);
  // 不能把“重新认证过期”和真正的读取失败混成同一条文案。
  assert.match(settingsScript, /isReauthRequired/);
  // 过期分支必须在通用失败分支之前返回，不能被后者盖住。
  const expiredAt = loadRoutes[0].indexOf('if (isReauthRequired(error))');
  const genericAt = loadRoutes[0].indexOf("userFacingError(error, '无法读取任务映射");
  assert.ok(expiredAt >= 0 && genericAt > expiredAt, '过期分支必须在通用失败分支之前');
  // 入口按钮要真的能跳到重新认证：切到账号页并聚焦密码框。
  assert.match(settingsScript, /routes-reauth'\)\.addEventListener\('click', \(\) => \{\s*guideToReauth/);
  assert.match(settingsScript, /function guideToReauth[\s\S]*?activateSettingsTab\('account'\)/);
  assert.match(settingsScript, /function guideToReauth[\s\S]*?password\.focus\(\)/);
});

test('重新认证成功后必须刷新依赖认证状态的视图', () => {
  const handler = settingsScript.match(/getElementById\('reauth'\)\.addEventListener\('click',[\s\S]*?\n\}\);/);
  assert.ok(handler, '缺少重新认证处理函数');
  // 原实现只调用 loadInfo()，任务映射与设备列表会停在“需要重新认证”。
  assert.match(handler[0], /loadInfo\(\)/);
  assert.match(handler[0], /loadDevices\(\)/);
  assert.match(handler[0], /loadRoutes\(\)/);
  // 空密码不应发起请求，先提示并聚焦。
  assert.match(handler[0], /if \(!password\.value\)/);
});

test('设备列表的重新认证提示写在设备卡片自己的状态行', () => {
  // 原实现写进 policyStatus（工作区策略页的元素），在账号页根本看不到。
  assert.match(settingsHtml, /id="device-list"[\s\S]*id="device-status"/);
  const loadDevices = settingsScript.match(/async function loadDevices\(\)[\s\S]*?\n\}/);
  assert.ok(loadDevices);
  assert.match(loadDevices[0], /getElementById\('device-status'\)/);
  assert.doesNotMatch(loadDevices[0], /policyStatus\.textContent/);
});

test('服务端版本旧导致的 404 与网络故障分开提示', () => {
  assert.match(settingsScript, /function isEndpointMissing[\s\S]*?HTTP 404/);
  const loadDevices = settingsScript.match(/async function loadDevices\(\)[\s\S]*?\n\}/);
  assert.match(loadDevices[0], /isEndpointMissing\(error\)/);
  assert.match(loadDevices[0], /线上服务版本较旧/);
  // 这条提示不能反过来把 404 说成网络问题或让用户重装客户端。
  assert.doesNotMatch(loadDevices[0], /线上服务版本较旧[\s\S]{0,40}重装/);
});

// 本机残留配置目录卡片（§5.4）：只做检查与逐平台清理，不能有批量入口。
test('残留目录卡片：有检查与逐平台清理，没有批量清理入口', () => {
  for (const id of ['platform-orphan-count', 'platform-orphan-check',
    'platform-orphan-clear', 'platform-orphan-clear-wx', 'platform-orphan-status']) {
    assert.match(settingsHtml, new RegExp(`id="${id}"`), `缺少 ${id}`);
  }
  // 两个按钮必须分别对应一个平台，而不是"全部"。
  assert.match(settingsScript, /clearOrphanFor\('xhs'\)/);
  assert.match(settingsScript, /clearOrphanFor\('wechat_mp'\)/);
  // 红线：不得出现"一次性清掉所有平台"的命令或按钮。
  assert.ok(!/clear-orphans-all|clear-all-profiles/.test(settingsScript),
    '不得提供跨平台的批量清理命令');
  assert.ok(!/data-clear-all|id="clear-all"/.test(settingsHtml),
    '不得提供跨平台的批量清理按钮');
  // 读不到时不能显示成 0（否则用户会以为没有残留）。
  assert.match(settingsScript, /暂时读不到/);
  // 被占用删不掉时必须如实说明，不能说"已完成"。
  assert.match(settingsScript, /未能删除/);
});
