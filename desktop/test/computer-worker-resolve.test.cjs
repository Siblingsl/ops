'use strict';
// DEV-CU P2-4：严格再解析的单测（夹具，不需要真实桌面）+ 一条真实 GUI 旅程。
// 五组夹具：节点消失 / 两个同名按钮 / 窗口 pid 变化 / 树被截断 / 正常唯一。
// 另加：契约版本跨文件一致、旧 AutomationId 分支的版本闸门、value 漂移归 unknown。

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, fork } = require('node:child_process');

const { buildObserveTree } = require('../src/computer-worker/tree.js');
const { allocateTreeRefs } = require('../src/computer-worker/refs.js');
const {
  RESOLVE_KIND, FullPredicate, assertIdentityProof, resolveWindowStrict,
  classifyTree, decideResolution, hasMeaningfulIdentity,
} = require('../src/computer-worker/resolve.js');
const { CONTRACT_VERSION, legacyAutomationIdAllowed } = require('../src/computer-worker/contract.js');

const IDENTITY = { pid: 4242, process_start_time: 't0', hwnd: 777, window_bounds_hash: 'wh' };

function nodes(children) {
  return [
    { parent: -1, role_raw: 'ControlType.Window', name: '无标题 - 记事本', id: 'Win1', value: '', enabled: true, offscreen: false, bounds: { x: 0, y: 0, w: 800, h: 600 }, has_value: false, has_invoke: false, children_count: children.length },
    ...children,
  ];
}

function button(parent, name, id) {
  return { parent, role_raw: 'ControlType.Button', name, id, value: '', enabled: true, offscreen: false, bounds: { x: 1, y: 2, w: 3, h: 4 }, has_value: false, has_invoke: true, children_count: 0 };
}

function textField(value) {
  return { parent: 0, role_raw: 'ControlType.Document', name: '文本编辑器', id: 'Doc1', value, enabled: true, offscreen: false, bounds: { x: 8, y: 60, w: 780, h: 520 }, has_value: true, has_invoke: false, children_count: 0 };
}

/** 走真实管线捕获一次：buildObserveTree → allocateTreeRefs，取第一个 ref 的 RefEntry。 */
function capture(nodeList, identity = IDENTITY, complete = true) {
  const built = buildObserveTree({
    window: '无标题 - 记事本', pid: identity.pid, hwnd: identity.hwnd,
    process_start_time: identity.process_start_time, tree_complete: complete,
    nodes_observed: nodeList.length, nodes: nodeList,
  });
  const { map } = allocateTreeRefs(built.tree, {
    snapshotId: 's0abc', identity, complete,
  });
  const first = map.inner.values().next().value;
  return { tree: built.tree, entry: first, complete: built.complete, map };
}

function resolve(tree, entry, complete = true) {
  const classified = classifyTree(tree, FullPredicate.ofEntry(entry));
  return decideResolution({ ...classified, complete }, entry, 's0abc', entry.ref);
}

test('P2-4 夹具①：节点消失 → stale_ref / saved_ref_absent', () => {
  const captured = capture(nodes([button(0, '设置', 'SettingsButton')]));
  const live = capture(nodes([button(0, '保存', 'SaveButton')])).tree;
  assert.throws(() => resolve(live, captured.entry), (e) => {
    assert.equal(e.code, 'computer_stale_ref');
    assert.equal(e.detail.kind, RESOLVE_KIND.ABSENT);
    assert.equal(e.detail.retryable, false);
    assert.equal(e.detail.complete, true);
    assert.equal(e.detail.snapshot_id, 's0abc');
    assert.equal(e.detail.ref, captured.entry.ref);
    assert.equal(e.detail.role, 'button');
    return true;
  });
});

test('P2-4 夹具②：两个同名按钮 → ambiguous_target / saved_ref_ambiguous', () => {
  const two = nodes([button(0, '设置', 'SettingsButton'), button(0, '设置', 'SettingsButton')]);
  const captured = capture(two);
  // 两个节点身份完全相同（同 role / 同 name / 同 AutomationId）→ 捕获时都判不唯一
  assert.equal(captured.entry.unique_at_capture, false);
  assert.throws(() => resolve(captured.tree, captured.entry), (e) => {
    assert.equal(e.code, 'computer_ambiguous_target');
    assert.equal(e.detail.kind, RESOLVE_KIND.AMBIGUOUS);
    // 上游 resolve_errors.rs:64：双子元素重新观察仍会被拒，重试无意义 → false
    assert.equal(e.detail.retryable, false);
    assert.equal(e.detail.candidate_count, 2);
    assert.equal(e.detail.complete, true);
    return true;
  });
});

test('P2-4 夹具③：窗口 pid 变化 → stale_ref / window_identity_changed + reason', () => {
  const captured = capture(nodes([button(0, '设置', 'SettingsButton')]));
  assert.throws(
    () => resolveWindowStrict(captured.entry.window_identity || IDENTITY, { ...IDENTITY, pid: 9999 }),
    (e) => {
      assert.equal(e.code, 'computer_stale_ref');
      assert.equal(e.detail.kind, RESOLVE_KIND.WINDOW);
      // P2-5 起 reason 是封闭枚举（原为字段名 'pid'）
      assert.deepEqual(e.detail.reason, ['window_gone']);
      assert.equal(e.detail.expected_pid, 4242);
      assert.equal(e.detail.actual_pid, 9999);
      return true;
    },
  );
  // 同一 pid 但进程启动时间变了 → PID 被复用
  assert.throws(
    () => resolveWindowStrict(IDENTITY, { ...IDENTITY, process_start_time: 't1' }),
    (e) => {
      assert.deepEqual(e.detail.reason, ['pid_reused']);
      return true;
    },
  );
  // 四个要素一致时不报错
  assert.equal(resolveWindowStrict(IDENTITY, { ...IDENTITY }), true);
  // 当时没采到的字段（空/0）跳过，不误判
  assert.equal(resolveWindowStrict({ pid: 1, hwnd: 0, process_start_time: '' }, { pid: 1, hwnd: 5 }), true);
});

test('P2-4 夹具④：树被截断 → timeout / resolution_identity_unknown', () => {
  const captured = capture(nodes([button(0, '设置', 'SettingsButton')]));
  assert.throws(() => resolve(captured.tree, captured.entry, false), (e) => {
    assert.equal(e.code, 'computer_timeout');
    assert.equal(e.detail.kind, RESOLVE_KIND.UNKNOWN);
    assert.equal(e.detail.retryable, true);
    assert.equal(e.detail.complete, false);
    return true;
  });
});

test('P2-4 夹具⑤：正常唯一 → 返回该节点 path', () => {
  const captured = capture(nodes([button(0, '设置', 'SettingsButton'), textField('')]));
  const match = resolve(captured.tree, captured.entry);
  assert.deepEqual(match.path, [0]);
  assert.equal(match.node.name, '设置');
});

test('P2-4：value 不是身份（上游「mutable values are never identity」）', () => {
  // 新版记事本编辑区：ControlType.Document + name='文本编辑器'，AutomationId 为空
  const doc = (value, name = '文本编辑器') => ({ ...textField(value), id: '', name });
  const captured = capture(nodes([doc('before')]));
  const predicate = FullPredicate.ofEntry(captured.entry);
  assert.equal(predicate.name, '文本编辑器', 'name 与 value 无关 → 稳定名保留');
  assert.equal(predicate.nativeId, null);

  // 编辑区内容变了（用户输入 / 上一次 SetValue）不该让 ref 失效
  const drifted = capture(nodes([doc('after')])).tree;
  const classified = classifyTree(drifted, predicate);
  assert.equal(classified.matches.length, 1, 'value 漂移后仍应唯一命中');
  assert.equal(classified.unknownCount, 0);

  // name 就是 value 的回显（Chromium textarea 常见）→ 稳定名降级为空 → 身份不可证
  const echo = capture(nodes([doc('before', 'before')]));
  const echoPredicate = FullPredicate.ofEntry(echo.entry);
  assert.equal(echoPredicate.name, null);
  assert.equal(echoPredicate.recordsIdentity, false);
  assert.throws(() => resolve(echo.tree, echo.entry), (e) => {
    assert.equal(e.code, 'computer_timeout');
    assert.equal(e.detail.kind, RESOLVE_KIND.UNKNOWN);
    return true;
  });

  // 名称不同 → 明确不是同一元素，且不产生 unknown
  const renamed = capture(nodes([doc('', '别的编辑器')])).tree;
  assert.equal(classifyTree(renamed, predicate).unknownCount, 0);
  assert.equal(classifyTree(renamed, predicate).matches.length, 0);
});

test('P2-4：unique_at_capture 由身份谓词全树复算（无 AutomationId 也能判唯一）', () => {
  // 新版记事本编辑区没有 AutomationId，唯一性只能靠 role + stable name 证明
  const single = capture(nodes([{ ...textField('hi'), id: '' }, button(0, '设置', '')]));
  assert.equal(single.entry.role, 'textfield');
  assert.equal(single.entry.native_id, '');
  assert.equal(single.entry.unique_at_capture, true);

  // 同名同 role 的双子 → 两个都不唯一
  const twins = capture(nodes([button(0, '设置', ''), button(0, '设置', '')]));
  assert.equal(twins.map.get('@e1').unique_at_capture, false);
  assert.equal(twins.map.get('@e2').unique_at_capture, false);

  // 观测被截断时不能声称唯一（上游 CaptureProof 要求整窗完整）
  const truncated = capture(nodes([textField('hi')]), IDENTITY, false);
  assert.equal(truncated.entry.unique_at_capture, false);
});

test('P2-4：身份不可证的 ref 在读树前被拒（规格步骤 7）', () => {
  // 无 AutomationId + 捕获时不唯一 → 不许按身份再解析
  const twins = capture(nodes([button(0, '确定', ''), button(0, '确定', '')]));
  assert.equal(hasMeaningfulIdentity(twins.entry), true, 'name 仍是有效身份');
  assert.throws(() => assertIdentityProof(twins.entry, 's0abc', '@s0abc:e1'), (e) => {
    assert.equal(e.code, 'computer_ambiguous_target');
    assert.equal(e.detail.kind, RESOLVE_KIND.NOT_UNIQUE);
    assert.equal(e.detail.retryable, false);
    assert.equal(e.detail.snapshot_id, 's0abc');
    assert.equal(e.detail.ref, '@s0abc:e1');
    return true;
  });

  // 除 role 外没有任何身份字段 → identity_unproven
  const bare = {
    role: 'unknown', name: '', value: '', native_id: '', description: '',
    unique_at_capture: true,
  };
  assert.equal(hasMeaningfulIdentity(bare), false);
  assert.throws(() => assertIdentityProof(bare, 's0abc', '@s0abc:e2'), (e) => {
    assert.equal(e.code, 'computer_stale_ref');
    assert.equal(e.detail.kind, RESOLVE_KIND.UNPROVEN);
    assert.equal(e.detail.retryable, false);
    return true;
  });

  // 有 AutomationId 的 ref 不受唯一性闸门影响（id 本身就是证据）
  const byId = capture(nodes([button(0, '设置', 'SettingsButton'), button(0, '设置', 'SettingsButton')]));
  assert.equal(assertIdentityProof(byId.entry, 's0abc', byId.entry.ref), true);
});

test('P2-4：契约版本与 TS / Go 常量一致，旧分支按版本关闭', () => {
  const ts = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'ipc', 'computer-contract.ts'), 'utf8');
  const go = fs.readFileSync(path.resolve(__dirname, '..', '..', 'server', 'internal', 'app', 'computer_contract.go'), 'utf8');
  const tsVersion = /CONTRACT_VERSION\s*=\s*'([^']+)'/.exec(ts)[1];
  const goVersion = /ContractVersion\s*=\s*"([^"]+)"/.exec(go)[1];
  assert.equal(CONTRACT_VERSION, tsVersion);
  assert.equal(CONTRACT_VERSION, goVersion);
  assert.equal(legacyAutomationIdAllowed('ops-computer/1'), true);
  assert.equal(legacyAutomationIdAllowed('ops-computer/2'), false);
});

test('P2-4 真实旅程：用 ref 写入记事本并读回（需 OPS_UIA_MANUAL=1）', { timeout: 180_000 }, async (t) => {
  if (process.platform !== 'win32') { t.skip('需要 Windows'); return; }
  if (process.env.OPS_UIA_MANUAL !== '1') { t.skip('需真实桌面：设 OPS_UIA_MANUAL=1'); return; }

  const entryPath = path.resolve(__dirname, '..', 'src', 'computer-worker', 'index.js');
  const child = fork(entryPath, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const call = (cmd, extra = {}, timeoutMs = 25_000) => new Promise((resolve, reject) => {
    const id = 'p' + Math.random().toString(36).slice(2, 8);
    const timer = setTimeout(() => { child.off('message', onMsg); reject(new Error('timeout')); }, timeoutMs);
    const onMsg = (m) => { if (m && m.id === id) { clearTimeout(timer); child.off('message', onMsg); resolve(m); } };
    child.on('message', onMsg);
    child.send({ id, cmd, ...extra });
  });
  const t0 = Date.now();
  // 默认**不自动开窗**（会打断使用者）。只有显式 OPS_UIA_SPAWN=1 才开一个自带临时文件的记事本：
  // 新版记事本会恢复上次会话，直接 spawn 可能落到「用户上次编辑的文件」上，用 ref 写入就会
  // 覆盖别人的内容；自带文件名 + 种子内容既能确定性选窗，也只碰自己的文档。
  // 未开 OPS_UIA_SPAWN 时复用已经开着的记事本，没有就 skip。
  const allowSpawn = process.env.OPS_UIA_SPAWN === '1';
  const seed = `P24-SEED-${process.pid}-${Date.now()}`;
  const scratch = allowSpawn
    ? path.join(os.tmpdir(), `ops-p24-${process.pid}-${Date.now()}.txt`)
    : '';
  const scratchName = scratch ? path.basename(scratch) : '';
  if (scratch) fs.writeFileSync(scratch, seed, 'utf8');
  // 收尾用：记录目标窗口 pid，以及它是不是只有我们这一个标签
  let ours = { pid: 0, isSoleTab: false };

  try {
    if (scratch) spawn('notepad', [scratch], { stdio: 'ignore' });
    // 按截止时间轮询，而不是固定次数：全量并行跑时 PowerShell 枚举会间歇失败/超时，
    // 失败的那次不消耗结论，继续等。
    const deadline = Date.now() + 90_000;
    let pid = 0;
    let lastError = '';
    while (!pid && Date.now() < deadline) {
      let list;
      try { list = await call('list_windows', {}, 20_000); } catch (e) { lastError = String(e && e.message); continue; }
      if (!list || list.ok !== true) { lastError = String((list && list.error) || 'enum_failed'); continue; }
      // 自带文件时按唯一文件名选窗（单进程多标签时 pid 可能复用既有进程）；
      // 否则复用任意已开的记事本窗口。
      const hit = (list.windows || []).find((w) => /notepad/i.test(w.process)
        && (!scratchName || String(w.title || '').includes(scratchName)));
      if (hit) { pid = hit.pid; break; }
      if (!scratchName) { t.skip('未找到记事本窗口（默认不自动开窗；需要真实旅程时设 OPS_UIA_SPAWN=1）'); return; }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!pid) { t.skip(`未枚举到记事本窗口（${lastError || 'timeout'}）`); return; }

    const read = await call('uia_read', { pid, grant_id: 'g-resolve', generation: 1 });
    assert.equal(read.ok, true, `读树应成功：${JSON.stringify(read)}`);

    // 自带文件时只认「值里带我们的种子串」的编辑区：多标签时它才是本次打开的文档；
    // 复用别人窗口时退回「第一个 textfield」（当前活动标签的文档）。
    let ref = '';
    (function walk(n) {
      if (!ref && n.role === 'textfield' && (!scratch || String(n.value || '').includes(seed))) ref = n.ref_id;
      for (const c of n.children) walk(c);
    })(read.tree);
    assert.ok(ref, `观察树里应有可写入的 textfield（seed=${seed || '无'}）`);

    // 标签数：新版记事本把多标签都放在同一窗口里，>1 说明混着别的（多半是恢复出来的）文档，
    // 收尾时就不能整窗关闭。
    let tabCount = 0;
    (function walk(n) {
      if (n.role === 'tab' && String(n.name || '').trim()) tabCount += 1;
      for (const c of n.children) walk(c);
    })(read.tree);
    ours = { pid, isSoleTab: tabCount <= 1 };

    const marker = 'P24-REF-INPUT';
    const invoked = await call('uia_invoke', {
      pid, ref, grant_id: 'g-resolve', generation: 1, value: marker,
      target_summary: read.window,
    });
    assert.equal(invoked.ok, true, `按 ref 写入应成功：${JSON.stringify(invoked)}`);
    assert.equal(invoked.action, 'setvalue');

    const after = await call('uia_read', { pid, grant_id: 'g-resolve', generation: 1 });
    const values = [];
    (function walk(n) { if (n.value) values.push(n.value); for (const c of n.children) walk(c); })(after.tree);
    assert.ok(values.some((v) => v.includes(marker)),
      `读回值应包含写入内容：${JSON.stringify(values.slice(0, 5))}`);

    try { await call('uia_invalidate', { grant_id: 'g-resolve' }); } catch { /* 忽略清理失败 */ }
    console.log(`P24_REAL_OK elapsed_ms=${Date.now() - t0} pid=${pid} ref_count=${read.ref_count}`
      + ` snapshot=${read.snapshot_id} ref=${ref} action=${invoked.action}`
      + ` resolved_path=${JSON.stringify(invoked.resolved_path)}`);
  } finally {
    child.kill();
    if (scratch) {
      try { fs.unlinkSync(scratch); } catch { /* 临时文件可能已被记事本占用，忽略 */ }
      // 收尾：只在「这个记事本窗口里只有一个标签、且标签就是我们的临时文件」时关掉它，
      // 避免把使用者自己打开的记事本（或恢复出来的文档）一并关掉。
      try {
        if (ours.isSoleTab) process.kill(ours.pid, 'SIGTERM');
      } catch { /* 关不掉就留着，不影响结论 */ }
    }
  }
});
