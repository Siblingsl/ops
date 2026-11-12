'use strict';
// DEV-CU P2-6：可操作性门禁与稳定采样（§4.6 / §P2-6）。
//
// 纯逻辑：不读窗口、不发 PowerShell。调用方传入「证据」（节点或 RefEntry 的只读快照）
// 与可选采样器，本文件只回答「这个动作现在能不能落在这个目标上」。
//
// 与上游 `crates/core/src/actionability/` 的对应：
//   requirements.rs     → REQUIREMENTS 表 + requirementsFor
//   gates.rs            → 9 个 gate（固定顺序，见 GATE_ORDER）
//   stability_sampler.rs→ StabilitySampler（17ms / 34ms / 连续 3 次 / 0.5px）
//   report.rs           → buildReport（actionable + checks + blocking + disposition）
//   evaluate.rs         → assertActionable（失败抛 WorkerError，带 detail.report）
//
// OPS 裁剪（§4.6 注 + §1.4）：不做 5 点 hit-test 与物理投递。
//   headed_requirement 恒 pass（策略恒 headless）
//   pointer_delivery   只在「语义投递可用」时给 semantic，其余 not_applicable，恒 pass
//   receives_events    恒 not_applicable —— 这一条是**有意为之**，单测锁住，
//                      防止后续有人把它改成物理 hit-test 而悄悄改变契约。

const { WorkerError } = require('./refs');

/** 稳定采样常量（§4.10 常量总表；上游 stability_sampler.rs:4-6）。 */
const SAMPLE_INTERVAL_MS = 17;
const MIN_SPAN_MS = 34;
const CONSECUTIVE_REQUIRED = 3;
const GEOMETRY_TOLERANCE = 0.5;

/** gate 固定顺序（§4.6）。`需求矩阵` 不是 gate，它是这张表本身。 */
const GATE_ORDER = Object.freeze([
  'headed_requirement',
  'pointer_delivery',
  'visible',
  'stable',
  'enabled',
  'editable',
  'action_supported',
  'policy',
  'receives_events',
]);

/** 五元组：visible / stable / enabled / editable / receives_events。 */
const REQUIREMENT_KEYS = Object.freeze(['visible', 'stable', 'enabled', 'editable', 'receives_events']);

/**
 * 动作 → 五元组，逐项照 §4.6 表录入。
 * 键一律用 worker 口径（snake_case）；`requirementsFor` 也接受表里的 CamelCase 写法。
 */
const REQUIREMENTS = Object.freeze({
  // Click / DoubleClick / RightClick / TripleClick
  click: { visible: true, stable: true, enabled: true, editable: false, receives_events: true },
  double_click: { visible: true, stable: true, enabled: true, editable: false, receives_events: true },
  right_click: { visible: true, stable: true, enabled: true, editable: false, receives_events: true },
  triple_click: { visible: true, stable: true, enabled: true, editable: false, receives_events: true },
  // Hover / Drag
  hover: { visible: true, stable: true, enabled: false, editable: false, receives_events: true },
  drag: { visible: true, stable: true, enabled: false, editable: false, receives_events: true },
  // SetValue / TypeText / Clear
  set_value: { visible: true, stable: false, enabled: true, editable: true, receives_events: false },
  type_text: { visible: true, stable: false, enabled: true, editable: true, receives_events: false },
  clear: { visible: true, stable: false, enabled: true, editable: true, receives_events: false },
  // Select
  select: { visible: true, stable: false, enabled: true, editable: false, receives_events: false },
  // Expand / Collapse / Toggle / Check / Uncheck / Scroll
  expand: { visible: true, stable: true, enabled: true, editable: false, receives_events: false },
  collapse: { visible: true, stable: true, enabled: true, editable: false, receives_events: false },
  toggle: { visible: true, stable: true, enabled: true, editable: false, receives_events: false },
  check: { visible: true, stable: true, enabled: true, editable: false, receives_events: false },
  uncheck: { visible: true, stable: true, enabled: true, editable: false, receives_events: false },
  scroll: { visible: true, stable: true, enabled: true, editable: false, receives_events: false },
  // ScrollTo
  scroll_to: { visible: false, stable: true, enabled: false, editable: false, receives_events: false },
  // SetFocus / PressKey
  set_focus: { visible: false, stable: false, enabled: false, editable: false, receives_events: false },
  press_key: { visible: false, stable: false, enabled: false, editable: false, receives_events: false },
});

/** 需要物理光标才能成立的动作：OPS 恒 headless，直接 policy 拒绝（§1.4）。 */
const CURSOR_REQUIRED_ACTIONS = Object.freeze(['hover', 'drag']);

/** 写类动作（editable gate 的实际判定对象）。 */
const EDITABLE_ACTIONS = Object.freeze(['set_value', 'type_text', 'clear']);

/**
 * 动作 → 需要的 UIA 能力（`available_actions` 里的名字）。
 * 空数组表示「语义 API 直达，不需要元素自报能力」。
 */
const REQUIRED_CAPABILITIES = Object.freeze({
  click: ['Click', 'Invoke'],
  double_click: ['DoubleClick', 'Click', 'Invoke'],
  right_click: ['Click', 'Invoke'],
  triple_click: ['Click', 'Invoke'],
  set_value: ['SetValue'],
  type_text: ['SetValue'],
  clear: ['SetValue'],
  select: ['Select', 'SelectItem'],
  expand: ['ExpandCollapse', 'Expand'],
  collapse: ['ExpandCollapse', 'Collapse'],
  toggle: ['Toggle'],
  check: ['Toggle'],
  uncheck: ['Toggle'],
  scroll: ['Scroll'],
  scroll_to: ['Scroll'],
  set_focus: [],
  press_key: [],
});

/** gate 失败时的错误码（§4.2）。 */
const GATE_ERROR_CODE = Object.freeze({
  visible: 'computer_action_failed',
  stable: 'computer_action_failed',
  enabled: 'computer_action_failed',
  editable: 'computer_action_not_supported',
  action_supported: 'computer_action_not_supported',
  policy: 'computer_policy_denied',
});

/** CamelCase / 空格 / 连字符 → snake_case，便于同时接受 §4.6 表写法与 worker 写法。 */
function normalizeAction(action) {
  return String(action || '')
    .trim()
    .replace(/[\s-]+/g, '_')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

/** 需求矩阵查询；未知动作返回 null（由 action_supported 判 not_supported）。 */
function requirementsFor(action) {
  const key = normalizeAction(action);
  const req = REQUIREMENTS[key];
  return req ? { action: key, ...req } : null;
}

/** 逐项 |a-b| ≤ 0.5（上游 geometry_matches）。 */
function geometryMatches(left, right, tolerance = GEOMETRY_TOLERANCE) {
  const pairs = [
    [left && left.x, right && right.x],
    [left && left.y, right && right.y],
    [left && left.w, right && right.w],
    [left && left.h, right && right.h],
  ];
  return pairs.every(([a, b]) => {
    const x = Number(a);
    const y = Number(b);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    return Math.abs(x - y) <= tolerance;
  });
}

function boundsUsable(bounds) {
  if (!bounds) return false;
  const w = Number(bounds.w);
  const h = Number(bounds.h);
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0;
}

/**
 * 稳定采样器（上游 stability_sampler.rs）。
 * observe(bounds, elapsedMs)：几何与上一次一致 → 连续计数 +1；否则从 1 重新计时。
 * 通过条件：连续 ≥3 次 **且** 稳定跨度 ≥34ms。读不到 bounds 时清零。
 */
class StabilitySampler {
  constructor() {
    this.previous = null;
    this.consecutive = 0;
    this.stableSince = 0;
  }

  observe(bounds, elapsedMs) {
    const elapsed = Number.isFinite(Number(elapsedMs)) ? Number(elapsedMs) : 0;
    if (!bounds || !Number.isFinite(Number(bounds.x)) || !Number.isFinite(Number(bounds.y))) {
      this.previous = null;
      this.consecutive = 0;
      this.stableSince = elapsed;
      return false;
    }
    if (this.previous && geometryMatches(this.previous, bounds)) {
      this.consecutive += 1;
    } else {
      this.consecutive = 1;
      this.stableSince = elapsed;
    }
    this.previous = { ...bounds };
    return this.consecutive >= CONSECUTIVE_REQUIRED
      && (elapsed - this.stableSince) >= MIN_SPAN_MS;
  }

  get samples() {
    return this.consecutive;
  }

  stableSpan(elapsedMs) {
    const elapsed = Number.isFinite(Number(elapsedMs)) ? Number(elapsedMs) : 0;
    return Math.max(0, elapsed - this.stableSince);
  }
}

function check(name, status, reason, code) {
  const item = { check: name, status, reason: reason || '' };
  if (code) item.code = code;
  return item;
}

const pass = (name, reason) => check(name, 'pass', reason);
const fail = (name, reason) => check(name, 'fail', reason, GATE_ERROR_CODE[name] || 'computer_action_failed');
const unknown = (name, reason) => check(name, 'unknown', reason, GATE_ERROR_CODE[name] || 'computer_action_failed');

function has(list, value) {
  return Array.isArray(list) && list.indexOf(value) >= 0;
}

/**
 * visible gate（§P2-6 步骤 3）：
 *   hidden / offscreen 为真 → fail；states 里带 canonical hidden/offscreen → fail；
 *   bounds 缺失但 visible_without_bounds 为真 → pass；其余缺失 → unknown；
 *   bounds 宽高 ≤0 → fail；否则 pass。
 */
function visibleGate(node) {
  const n = node || {};
  if (n.hidden === true) return fail('visible', 'hidden 为 true');
  if (n.offscreen === true) return fail('visible', 'offscreen 为 true');
  if (has(n.states, 'hidden')) return fail('visible', 'states 含 hidden');
  if (has(n.states, 'offscreen')) return fail('visible', 'states 含 offscreen');
  const bounds = n.bounds;
  if (!bounds) {
    if (n.visible_without_bounds === true) return pass('visible', 'visible_without_bounds');
    return unknown('visible', 'bounds 不可用');
  }
  if (!boundsUsable(bounds)) return fail('visible', 'bounds 宽高为 0');
  if (!has(n.states, 'visible')) return unknown('visible', 'states 未声明 visible');
  return pass('visible');
}

/** enabled gate（步骤 4）：显式 enabled → 三态；否则看 states 的 enabled / disabled。 */
function enabledGate(node) {
  const n = node || {};
  if (n.enabled === true) return pass('enabled');
  if (n.enabled === false) return fail('enabled', 'enabled 为 false');
  if (has(n.states, 'disabled')) return fail('enabled', 'states 含 disabled');
  if (has(n.states, 'enabled')) return pass('enabled');
  return unknown('enabled', 'enabled 状态不可用');
}

/** editable gate（步骤 5）：只对写类动作生效。 */
function editableGate(node, action) {
  const key = normalizeAction(action);
  if (EDITABLE_ACTIONS.indexOf(key) < 0) return pass('editable', '本动作不要求可编辑');
  const n = node || {};
  if (n.role === 'textfield' || n.role === 'combobox') return pass('editable');
  if (has(n.available_actions, 'SetValue')) return pass('editable', '元素自报 SetValue');
  return fail('editable', `role ${String(n.role || 'unknown')} 不可编辑`);
}

/** action_supported gate（步骤 6）：动作在枚举内，且目标自报所需能力（或不需要能力）。 */
function actionSupportedGate(node, action, requirements) {
  const key = normalizeAction(action);
  if (!requirements) return fail('action_supported', `动作 ${key || '(空)'} 不在枚举内`);
  const need = REQUIRED_CAPABILITIES[key] || [];
  if (need.length === 0) return pass('action_supported', '语义 API 直达');
  const available = (node && node.available_actions) || [];
  for (const cap of need) {
    if (has(available, cap)) return pass('action_supported', cap);
  }
  return fail('action_supported', `缺少能力：${need.join(' / ')}`);
}

/**
 * policy gate（步骤 9）：OPS 策略恒 headless。
 * 需要物理光标的动作、或调用方显式要求 allow_cursor_move / allow_focus_steal，
 * 一律 computer_policy_denied —— 不静默降级成物理投递。
 */
function policyGate(action, policy) {
  const key = normalizeAction(action);
  const p = policy || {};
  if (p.allow_cursor_move === true || p.allow_focus_steal === true || p.headed === true) {
    return fail('policy', '策略要求物理键鼠/抢焦点，OPS 恒 headless');
  }
  if (CURSOR_REQUIRED_ACTIONS.indexOf(key) >= 0) {
    return fail('policy', `动作 ${key} 需要物理光标`);
  }
  return pass('policy', 'headless');
}

/** 指针投递方式：不做物理投递，要么语义、要么不适用（恒 pass）。 */
function pointerDeliveryFor(requirements, node) {
  if (!requirements || requirements.receives_events !== true) return 'not_applicable';
  const available = (node && node.available_actions) || [];
  // 有语义能力才算语义投递；没有能力时 action_supported 会失败，这里不下结论。
  return available.length > 0 ? 'semantic' : 'not_applicable';
}

/**
 * 评估一个动作（不执行）。返回 report：
 *   {action, actionable, requirements, checks[9], pointer_delivery,
 *    blocking[], failure_reasons, disposition?}
 * `stability` 可传 `{bounds, elapsed_ms, stable}`（由 StabilitySampler 采到的结果）；
 * 不传时 stable gate 视为 unknown（要求调用方先采样）。
 */
function evaluateActionability({ action, node, policy, stability } = {}) {
  const requirements = requirementsFor(action);
  const pointerDelivery = pointerDeliveryFor(requirements, node);
  const checks = [];

  checks.push(pass('headed_requirement', 'headless'));

  if (pointerDelivery === 'semantic') {
    checks.push(pass('pointer_delivery', 'semantic'));
  } else {
    checks.push(pass('pointer_delivery', 'not_applicable'));
  }

  // 需求矩阵未要求 → pass，并注明 not_required，避免误读成「已证明」。
  if (requirements && requirements.visible) checks.push(visibleGate(node));
  else checks.push(pass('visible', 'not_required'));

  if (requirements && requirements.stable) {
    if (stability && stability.stable === true) checks.push(pass('stable', 'sampled'));
    else if (stability && stability.stable === false) checks.push(unknown('stable', '采样未收敛'));
    else checks.push(unknown('stable', '需要稳定采样'));
  } else {
    checks.push(pass('stable', 'not_required'));
  }

  if (requirements && requirements.enabled) checks.push(enabledGate(node));
  else checks.push(pass('enabled', 'not_required'));

  checks.push(editableGate(node, action));
  checks.push(actionSupportedGate(node, action, requirements));
  checks.push(policyGate(action, policy));

  // OPS 裁剪：不做 5 点 hit-test，恒 not_applicable；不阻塞（见文件头）。
  checks.push(check('receives_events', 'not_applicable', 'OPS 不做物理投递与 hit-test'));

  const blocking = checks
    .filter((c) => c.status === 'fail' || c.status === 'unknown')
    .map((c) => c.check);
  const actionable = blocking.length === 0;
  const report = {
    action: normalizeAction(action),
    actionable,
    requirements: requirements ? { ...requirements } : null,
    checks,
    pointer_delivery: pointerDelivery,
    blocking,
    failure_reasons: checks
      .filter((c) => c.status === 'fail' || c.status === 'unknown')
      .map((c) => `${c.check} (${c.reason || c.status})`)
      .join(', '),
  };
  if (!actionable) {
    // §4.3：门禁失败 → not_delivered + safe（不自动重试，交用户决定）。
    report.disposition = { delivery: 'not_delivered', retry: 'safe' };
    report.error_code = firstErrorCode(checks);
  }
  return report;
}

/** 永久拒绝（fail）优先于暂时性 unknown，与上游 report.terminal_code 一致。 */
function firstErrorCode(checks) {
  const fails = checks.filter((c) => c.status === 'fail' && c.code);
  if (fails.length > 0) return fails[0].code;
  const unknowns = checks.filter((c) => c.status === 'unknown' && c.code);
  return unknowns.length > 0 ? unknowns[0].code : 'computer_action_failed';
}

/** 失败时抛 WorkerError，detail 带完整 report（§P2-6 步骤 8）。 */
function assertActionable(input) {
  const report = evaluateActionability(input);
  if (report.actionable) return report;
  const err = new WorkerError(report.error_code, `目标不可操作：${report.failure_reasons}`);
  err.detail = { report, disposition: report.disposition };
  throw err;
}

/** 唯一阻塞项是不是 stable（决定要不要进采样循环，§4.6 末句）。 */
function onlyBlockingCheckIsStability(report) {
  const blocking = (report && report.blocking) || [];
  return blocking.length === 1 && blocking[0] === 'stable';
}

/**
 * 采样到稳定或 deadline（§P2-6 步骤 7）。依赖注入，便于用假时钟测 deadline。
 * read() 返回 bounds 或 null；now() 毫秒；sleep(ms) 可 await。
 * 返回 {ok, samples, span_ms, bounds} 或 {ok:false, reason:'deadline_exceeded'|'no_bounds'}。
 */
async function sampleUntilStable({
  read, deadlineAt, now = () => Date.now(), sleep, sampler = new StabilitySampler(),
} = {}) {
  if (typeof read !== 'function') throw new WorkerError('computer_invalid_args', 'read 必须是函数');
  const waiter = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const started = now();
  for (;;) {
    let bounds = null;
    try {
      bounds = await read();
    } catch {
      bounds = null;
    }
    const elapsed = now() - started;
    if (sampler.observe(bounds, elapsed)) {
      return { ok: true, samples: sampler.samples, span_ms: sampler.stableSpan(elapsed), bounds: sampler.previous };
    }
    if (now() >= deadlineAt) {
      return {
        ok: false,
        reason: sampler.previous ? 'deadline_exceeded' : 'no_bounds',
        samples: sampler.samples,
        span_ms: sampler.stableSpan(now() - started),
      };
    }
    await waiter(SAMPLE_INTERVAL_MS);
  }
}

module.exports = {
  SAMPLE_INTERVAL_MS,
  MIN_SPAN_MS,
  CONSECUTIVE_REQUIRED,
  GEOMETRY_TOLERANCE,
  GATE_ORDER,
  REQUIREMENT_KEYS,
  REQUIREMENTS,
  CURSOR_REQUIRED_ACTIONS,
  EDITABLE_ACTIONS,
  REQUIRED_CAPABILITIES,
  GATE_ERROR_CODE,
  normalizeAction,
  requirementsFor,
  geometryMatches,
  boundsUsable,
  StabilitySampler,
  evaluateActionability,
  assertActionable,
  onlyBlockingCheckIsStability,
  sampleUntilStable,
};
