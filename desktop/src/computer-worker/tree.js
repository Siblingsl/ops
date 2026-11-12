'use strict';
// DEV-CU P2-1：观察树归一化与裁剪（§4.5 节点契约）。
// 输入是 native.js 的 readUIA 采到的「扁平节点 + parent 下标」（PowerShell 侧用
// RawViewWalker 递归遍历，不是 FindAll 平铺），本文件负责：
//   ① ControlType → role 归一化（18 项白名单，未知 → unknown）
//   ② 扁平 → 嵌套树，并补齐 states / available_actions / bounds_hash
//   ③ projectWindow / projectPartial 两种裁剪投影
//   ④ 兼容视图 controls（四键平铺，供 P1-3 的 preload 白名单继续使用；P3-7 切树后移除）
//
// 口径说明（证据材料 §18）：
// - 规格 §4.4 写「19 项 INTERACTIVE_ROLES」，实际只列出 18 个名称；本文件严格按列出的
//   18 个实现，不自行补第 19 项。其中 colorwell / dockitem / switch 在本机 UIA 没有对应的
//   ControlType，当前版本不可达（不直传上游 role 名），登记为已知缺口。
// - ref_id 在 P2-1 恒为空串：ref 分配属 P2-2（refs.js），本包不越界。

const crypto = require('node:crypto');

/** §4.4 列出的 18 项 role（规格称 19 项，见文件头口径说明）。 */
const INTERACTIVE_ROLES = [
  'button', 'cell', 'checkbox', 'colorwell', 'combobox', 'dockitem', 'incrementor', 'link', 'listbox',
  'menubutton', 'menuitem', 'option', 'radiobutton', 'slider', 'switch', 'tab', 'textfield', 'treeitem',
];

/** UIA ControlType → §4.4 role。未列出的 ControlType 一律 unknown（不直传 ControlType.X）。 */
const ROLE_BY_CONTROL_TYPE = {
  Button: 'button',
  CheckBox: 'checkbox',
  ComboBox: 'combobox',
  DataItem: 'cell',
  // 新版记事本编辑区是 ControlType.Document（不是 Edit）；两者都归 textfield，
  // 否则真实 GUI 旅程里「可编辑节点」会全部落到 unknown。
  Document: 'textfield',
  Edit: 'textfield',
  Hyperlink: 'link',
  List: 'listbox',
  ListItem: 'option',
  Menu: 'menubutton',
  MenuItem: 'menuitem',
  RadioButton: 'radiobutton',
  Slider: 'slider',
  Spinner: 'incrementor',
  SplitButton: 'button',
  Tab: 'tab',
  TabItem: 'tab',
  TreeItem: 'treeitem',
};

/** `ControlType.Button` → `Button`；空值 → ''。 */
function controlTypeName(raw) {
  const s = String(raw || '');
  const i = s.lastIndexOf('.');
  return i >= 0 ? s.slice(i + 1) : s;
}

/** ControlType 原文 → role；未知 → 'unknown'。 */
function roleFor(raw) {
  const name = controlTypeName(raw);
  return ROLE_BY_CONTROL_TYPE[name] || 'unknown';
}

/** 数值化并四舍五入到整数像素（UIA 可能返回 NaN / Infinity / 负数宽高）。 */
function roundRect(rect) {
  const pick = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.round(n);
  };
  const x = pick(rect && rect.x);
  const y = pick(rect && rect.y);
  const w = Math.max(0, pick(rect && rect.w));
  const h = Math.max(0, pick(rect && rect.h));
  return { x, y, w, h };
}

/** bounds 稳定采样用摘要：四项四舍五入后拼接再 hash。 */
function boundsHash(bounds) {
  const b = roundRect(bounds);
  return crypto.createHash('sha256').update(`${b.x},${b.y},${b.w},${b.h}`).digest('hex').slice(0, 16);
}

/** 状态数组：只写能从 UIA 直接读到的两项，不臆测 checked/expanded 等（属 P2-4/P2-5）。 */
function statesOf(raw) {
  const states = [];
  if (raw.enabled === true) states.push('enabled');
  if (raw.offscreen !== true) states.push('visible');
  return states;
}

/** 可用动作：只映射「当前 pattern 可用」的两项，动作全量表属 P3-1（14 项 WORKER_ACTIONS）。 */
function actionsOf(raw) {
  const actions = [];
  if (raw.has_invoke === true) actions.push('Click');
  if (raw.has_value === true) actions.push('SetValue');
  return actions;
}

/**
 * 扁平节点 → §4.5 节点树。
 * raw.nodes 每项：{ parent, role_raw, name, id, value, enabled, offscreen,
 *                  bounds:{x,y,w,h}, has_value, has_invoke, children_count, stale? }
 * parent 为「已产出节点」的下标；-1 表示窗口根。
 */
function normalizeNode(raw) {
  const node = {
    role: roleFor(raw.role_raw),
    name: String(raw.name || ''),
    value: String(raw.value || ''),
    ref_id: '', // P2-2 分配
    available_actions: actionsOf(raw),
    states: statesOf(raw),
    bounds: roundRect(raw.bounds),
    bounds_hash: boundsHash(raw.bounds),
    children: [],
    children_count: Number.isFinite(Number(raw.children_count)) ? Number(raw.children_count) : 0,
  };
  // AutomationId 供 P2-2 的 RefEntry.native_id 使用；不可枚举，避免漏进 §4.5 契约输出。
  Object.defineProperty(node, 'native_id', {
    value: String(raw.id || ''), enumerable: false, configurable: true, writable: true,
  });
  return node;
}

/**
 * 构建观察树。返回：
 *   tree            §4.5 节点树（单根 = 目标窗口）
 *   complete        原始观测是否完整（未触 200 节点 / 深度 50 / 单层 10000 上限）
 *   nodes_observed  实际观测到的节点数（裁剪前）
 *   controls        兼容视图：四键平铺（P3-7 前 preload 只认这个）
 *   window_identity {pid, process_start_time, hwnd, target_handle, window_bounds_hash}
 */
function buildObserveTree(raw) {
  const nodes = Array.isArray(raw && raw.nodes) ? raw.nodes : [];
  const built = [];
  const builtRaw = [];
  const childIdx = new Set();

  for (let i = 0; i < nodes.length; i++) {
    const item = nodes[i];
    if (!item || item.stale === true) { built.push(null); builtRaw.push(null); continue; }
    const parentIdx = Number(item.parent);
    const parent = Number.isInteger(parentIdx) && parentIdx >= 0 ? built[parentIdx] : null;
    if (parentIdx >= 0 && !parent) { built.push(null); builtRaw.push(null); continue; } // 父节点被丢弃 → 整支丢弃，避免断链
    const node = normalizeNode(item);
    if (parent) { parent.children.push(node); childIdx.add(i); }
    built.push(node);
    builtRaw.push(item);
  }

  const roots = built.filter((n, i) => n && !childIdx.has(i));
  const tree = roots.length === 1 ? roots[0] : { role: 'unknown', name: '', value: '', ref_id: '',
    available_actions: [], states: [], bounds: { x: 0, y: 0, w: 0, h: 0 }, bounds_hash: boundsHash({}),
    children: roots, children_count: roots.length };

  // 兼容视图：直接从原始节点取 id/type/name/value（不按 role 反推 type），
  // 并按 preload 白名单上限裁剪（200/60/500/4000），保证过渡期仍能被旧解析器接受。
  const controls = [];
  for (let i = 0; i < built.length; i++) {
    const item = builtRaw[i];
    if (!item) continue;
    const type = clip(controlTypeOf(item), 60);
    if (!type) continue; // 与 P1-1 一致：取不到 ControlType 的条目不产出
    controls.push({
      id: clip(item.id, 200),
      type,
      name: clip(item.name, 500),
      value: clip(item.value, 4000),
    });
  }

  return {
    tree,
    complete: raw && raw.tree_complete === true,
    nodes_observed: Number.isFinite(Number(raw && raw.nodes_observed)) ? Number(raw.nodes_observed) : nodes.length,
    controls,
    window_identity: {
      pid: Number(raw && raw.pid) || 0,
      process_start_time: String((raw && raw.process_start_time) || ''),
      hwnd: Number(raw && raw.hwnd) || 0,
      target_handle: Number(raw && raw.hwnd) || 0, // P3-7 前两者同源；pinned scope 区分留待后续
      window_bounds_hash: boundsHash(tree.bounds),
    },
  };
}

/** ControlType 原文（`ControlType.Button` 形态）；缺失则返回空串。 */
function controlTypeOf(item) {
  const raw = String((item && item.role_raw) || '');
  if (!raw) return '';
  return raw.startsWith('ControlType.') ? raw : `ControlType.${raw}`;
}

function clip(s, n) {
  const v = String(s === undefined || s === null ? '' : s);
  return v.length > n ? v.slice(0, n) : v;
}

/** 深拷贝（只走 §4.5 字段，避免把内部字段带出去）。 */
function cloneNode(node) {
  const copy = {
    role: node.role,
    name: node.name,
    value: node.value,
    ref_id: node.ref_id,
    available_actions: node.available_actions.slice(),
    states: node.states.slice(),
    bounds: { ...node.bounds },
    bounds_hash: node.bounds_hash,
    children: node.children.map(cloneNode),
    children_count: node.children_count,
  };
  Object.defineProperty(copy, 'native_id', {
    value: String(node.native_id || ''), enumerable: false, configurable: true, writable: true,
  });
  return copy;
}

/**
 * 按最大深度裁剪（§P2-1 步骤 6）。裁掉的层级不再出现在 children 里，
 * 但该层节点的 children_count 保留真实值，便于上层知道「下面还有东西」。
 * nodes_observed 属于观测统计，不随裁剪变化（由调用方原样返回）。
 */
function projectWindow(tree, maxDepth) {
  const limit = Number.isFinite(Number(maxDepth)) ? Math.max(0, Number(maxDepth)) : 50;
  const walk = (node, depth) => {
    const copy = cloneNode(node);
    if (depth >= limit) {
      copy.children = [];
      return copy;
    }
    copy.children = node.children.map((c) => walk(c, depth + 1));
    return copy;
  };
  return walk(tree, 0);
}

/** 局部观察用：不按深度裁剪，保留已观测到的全部层级。 */
function projectPartial(tree) {
  return cloneNode(tree);
}

module.exports = {
  INTERACTIVE_ROLES,
  ROLE_BY_CONTROL_TYPE,
  controlTypeName,
  roleFor,
  roundRect,
  boundsHash,
  buildObserveTree,
  projectWindow,
  projectPartial,
};
