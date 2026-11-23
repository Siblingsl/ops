const assert = require('node:assert/strict');
const test = require('node:test');

const {
  TabLifecycle,
  TabIdentityStore,
  DEFAULT_IDLE_MS,
  CLOSE_TIMEOUT_MS,
  classifyDebuggerAttachFailure,
  debuggerRestorePlan,
  groupPlan
} = require('../.build/platforms/tab-lifecycle.js');

function setup(now = 1_000_000) {
  const lifecycle = new TabLifecycle();
  lifecycle.track({ tabId: 1 }, now);
  return lifecycle;
}

test('B-09.1 只跟踪 agent tab；用户借出的 tab 不入表且永不自动关', () => {
  const lc = setup();
  assert.equal(lc.shouldClose(2, 2_000_000).reason, 'not_agent_tab');
  assert.equal(lc.identity(2), null);
  assert.equal(lc.shouldClose(1, 1_000_001).reason, 'not_idle');
});

test('B-09.2 闲置 10 分钟才关；活动/固定/出声/显式命名/guard 任一命中跳过', () => {
  const lc = setup();
  assert.equal(DEFAULT_IDLE_MS, 600000);
  assert.equal(lc.shouldClose(1, 1_599_999).close, false);
  assert.equal(lc.shouldClose(1, 1_600_001).close, true);
  lc.refresh(1, { active: true });
  assert.equal(lc.shouldClose(1, 2_000_000).reason, 'active_tab');
  lc.refresh(1, { active: false, pinned: true });
  assert.equal(lc.shouldClose(1, 2_000_000).reason, 'pinned');
  lc.refresh(1, { pinned: false, audible: true });
  assert.equal(lc.shouldClose(1, 2_000_000).reason, 'audible');
  lc.refresh(1, { audible: false });
  lc.addGuard(1, 'handoff_waiting');
  assert.equal(lc.shouldClose(1, 2_000_000).reason, 'guarded');
  lc.removeGuard(1, 'handoff_waiting');
  assert.equal(lc.shouldClose(1, 2_000_000).close, true);
});

test('B-09.2 扫码等待/录制 guard 在 60 分钟内不关', () => {
  const lc = setup();
  lc.addGuard(1, 'login_waiting');
  assert.equal(lc.shouldClose(1, 1_000_000 + 60 * 60 * 1000).close, false);
  lc.removeGuard(1, 'login_waiting');
  assert.equal(lc.shouldClose(1, 1_000_000 + 60 * 60 * 1000).close, true);
});

test('B-09.2 用户切到 tab（touch）会重置闲置计时', () => {
  const lc = setup();
  lc.touch(1, 1_500_000);
  assert.equal(lc.shouldClose(1, 1_600_000).close, false);
  assert.equal(lc.shouldClose(1, 2_100_001).close, true);
});

test('B-09.3 稳定身份：generation 防旧写覆盖；读超时是“未知”不是“没有”', () => {
  const store = new TabIdentityStore();
  assert.equal(store.set({ tabId: 1, browseId: 'b1', browseAgent: true, generation: 2 }), true);
  assert.equal(store.set({ tabId: 1, browseId: 'old', browseAgent: true, generation: 1 }), false);
  assert.equal(store.get(1).status, 'known');
  assert.equal(store.get(1).identity.browseId, 'b1');
  assert.equal(store.set({ tabId: 1, browseId: 'b2', browseAgent: true, generation: 2 }), true, '同代覆盖允许');
  assert.equal(store.get(1).identity.browseId, 'b2');
  assert.deepEqual(store.get(1, { timedOut: true }), { status: 'unknown' });
  assert.equal(store.get(99).status, 'unknown');
});

test('B-09.3 扩展重载只信任仍在自有 group 的 tab；浏览器重启清空', () => {
  const store = new TabIdentityStore();
  store.set({ tabId: 1, browseId: 'b1', browseAgent: true, generation: 1 });
  assert.equal(store.trustIfInGroup(1, false), null);
  assert.equal(store.trustIfInGroup(1, true).browseId, 'b1');
  store.clearOnStartup();
  assert.equal(store.get(1).status, 'unknown');
  const lc = setup();
  lc.onStartup();
  assert.equal(lc.shouldClose(1, 2_000_000).reason, 'not_agent_tab');
});

test('B-09.4 关闭顺序：最后窗口先开替代 tab，组内先 ungroup 再 remove，失败回滚', () => {
  const lc = setup();
  assert.equal(CLOSE_TIMEOUT_MS, 10_000);
  lc.refresh(1, { inAgentGroup: true });
  const plain = lc.planClose(1, { isLastTabInLastWindow: true });
  assert.deepEqual(plain.steps, ['open_replacement', 'ungroup', 'remove', 'regroup_on_failure']);
  assert.equal(plain.serial, true);
  assert.equal(plain.timeoutMs, 10_000);
  assert.equal(typeof plain.groupId, 'number');
  const noReplacement = lc.planClose(1, { isLastTabInLastWindow: false });
  assert.deepEqual(noReplacement.steps, ['ungroup', 'remove', 'regroup_on_failure']);
});

test('B-09.5 关闭失败按失败处理不阻塞后续；profile 清理已有“无主目录”扫描', () => {
  const lc = setup();
  const plan = lc.planClose(1);
  assert.equal(plan.timeoutMs, 10_000);
  // 策略层只输出计划；调用方超时后继续下一条，不因单个 tab 失败中断队列。
  assert.equal(plan.serial, true);
  assert.equal(lc.planClose(999), null);
});

test('B-09.6 debugger 冲突：只有确认是自己才重附，否则明确失败不重试', () => {
  assert.deepEqual(classifyDebuggerAttachFailure('Already attached', true), { code: 'already_attached_self', action: 'reattach', retryable: true });
  assert.deepEqual(classifyDebuggerAttachFailure('Already attached', false), { code: 'debugger_conflict', action: 'fail_with_user_hint', retryable: false });
  assert.equal(classifyDebuggerAttachFailure('Another debugger is already attached', false).code, 'debugger_conflict');
  assert.equal(classifyDebuggerAttachFailure('ok', false).code, 'attach_ok');
});

test('B-09.6 SW 重启恢复：URL 一致才 detach+attach，不一致不重附', () => {
  assert.deepEqual(debuggerRestorePlan({ storedUrl: 'https://a', currentUrl: 'https://a', attached: true }).steps, ['detach', 'attach']);
  assert.deepEqual(debuggerRestorePlan({ storedUrl: 'https://a', currentUrl: 'https://a', attached: false }).steps, ['attach']);
  assert.deepEqual(debuggerRestorePlan({ storedUrl: 'https://a', currentUrl: 'https://b', attached: true }), { steps: [], reason: 'url_mismatch' });
});

test('B-09.7 标签组：按 session 复用或新建；handoff 展开，完成折叠', () => {
  assert.equal(groupPlan({ sessionId: 's1', collapsed: true }).action, 'create');
  assert.equal(groupPlan({ sessionId: 's1', existingGroupId: 7, collapsed: true }).action, 'reuse');
  assert.equal(groupPlan({ sessionId: 's1', existingGroupId: 7, collapsed: true, handoffActive: true }).collapsed, false);
  assert.equal(groupPlan({ sessionId: 's1', existingGroupId: 7, collapsed: true, handoffActive: false }).collapsed, true);
});
