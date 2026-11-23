'use strict';
// BR-09：后台操作不抢焦点——静态边界守卫 + 真实 E2E 的行为断言在
// renderer/e2e/agent-br09-background-tab.spec.ts。这里锁住“只有用户查看操作能切前台”
// 的唯一入口，防止后续把 active:true 误加回 Agent 的 navigate/observe 路径。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const background = fs.readFileSync(path.join(root, 'desktop/chrome-extension/background.js'), 'utf8');
const serverCommands = fs.readFileSync(path.join(root, 'server/internal/app/agent_browser_commands.go'), 'utf8');
const bridgeSource = fs.readFileSync(path.join(root, 'desktop/src/browser-bridge.ts'), 'utf8');

function functionBody(source, name) {
  const start = source.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `缺少函数 ${name}`);
  const next = source.indexOf('\nasync function ', start + 1);
  const fallback = source.indexOf('\nconst ', start + 1);
  const end = next >= 0 ? next : fallback;
  return source.slice(start, end > start ? end : undefined);
}

test('BR-09：Agent navigate 不带 active:true / bringToFront，只有 activate_tab 切前台', () => {
  const navigate = functionBody(background, 'actionNavigate');
  assert.doesNotMatch(navigate, /active\s*:\s*true/);
  assert.doesNotMatch(navigate, /bringToFront/);
  assert.match(navigate, /active:\s*false/, '后台导航必须显式 active:false');
  const activate = functionBody(background, 'actionActivateTab');
  assert.match(activate, /chrome\.tabs\.update\(tabId,\s*\{\s*active:\s*true\s*\}\)/);
  assert.match(background, /activate_tab:\s*actionActivateTab/);
});

test('BR-09：后台截图如实失败，不通过切换标签伪造可截', () => {
  const screenshot = functionBody(background, 'actionScreenshot');
  assert.match(screenshot, /chrome\.tabs\.query\(\{\s*active:\s*true/);
  assert.match(screenshot, /tab_not_foreground/);
  assert.doesNotMatch(screenshot, /chrome\.tabs\.update\(/);
});

test('BR-09：服务端 Agent 动作白名单不登记 activate_tab', () => {
	const block = serverCommands.slice(
		serverCommands.indexOf('var browserCommandActions'),
		serverCommands.indexOf('}', serverCommands.indexOf('var browserCommandActions')),
	);
	assert.doesNotMatch(block, /activate_tab/);
	assert.match(background, /服务端 Agent 动作白名单（browserCommandActions）不含 activate_tab/);
	// 桥侧白名单必须登记该本机用户动作，否则“查看操作”会静默不动。
	const allowed = bridgeSource.match(/export const ALLOWED_ACTIONS = new Set\(\[([^\]]+)\]\)/);
	assert.ok(allowed, 'ALLOWED_ACTIONS 必须存在');
	assert.match(allowed[1], /'activate_tab'/);
});

// Q-22（docs/41）：首装时 storage 无 extension_instance_id，loadStateOnce 生成 ID 写入
// storage 后返回的是写入前快照——若返回值不并入生成的 ID，hello 信封缺该字段，
// W04 首次连接向导 confirm 报“实例标识必须是 UUID”，首装用户被迫重启 Chrome。
test('Q-22：loadState 首装分支把生成的实例 ID 并入返回值', () => {
	const loadState = functionBody(background, 'loadStateOnce');
	assert.match(loadState, /instanceId = crypto\.randomUUID\(\)/, '生成实例 ID 分支存在');
	assert.match(
		loadState,
		/return\s*\{\s*\.\.\.d,\s*extension_instance_id:\s*instanceId\s*\}/,
		'返回值必须并入生成的实例 ID（写入前快照缺该字段）',
	);
	// 调用方直接取返回值赋给 sw，不再允许从原始快照二次读取。
	assert.match(
		background,
		/sw\.extensionInstanceId = d\.extension_instance_id;/,
		'startup 路径从 loadState 返回值取实例 ID',
	);
});

// Q-22 续（2026-11-23 真实 Chrome 复跑）：onInstalled 与主入口并发调用 loadState，
// 旧实现会各生成一个 UUID（桥快照 A、storage B）。loadState 必须对并发调用单飞。
test('Q-22：loadState 并发调用单飞，避免生成两个实例 ID', () => {
	assert.match(background, /let loadStateInFlight = null;/, '存在 in-flight 去重变量');
	assert.match(
		background,
		/if\s*\(\s*!loadStateInFlight\s*\)\s*\{\s*loadStateInFlight = loadStateOnce\(\)\.finally/,
		'只在无飞行中请求时才启动 loadStateOnce，并在 settle 后复位',
	);
	assert.match(background, /return loadStateInFlight;/, '并发调用共享同一 Promise');
});
