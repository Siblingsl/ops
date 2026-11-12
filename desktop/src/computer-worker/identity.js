'use strict';
// DEV-CU P2-4：身份谓词（§4.4 RefEntry「标识」字段组的判等规则）。
//
// 本文件是 Reference_Projects/agent-desktop 三处 Rust 实现的 JS 移植，纯函数、无 IO：
//   crates/core/src/refs/ref_full_predicate.rs  FullPredicate::compare 的四字段合取
//   crates/core/src/refs/ref_identity.rs        stable_name / stable_value / 空白处理
//   crates/core/src/tree/roles.rs:88            is_mutable_value_role
//
// 与规格 §P2-4 步骤 4 字面清单（role + name + native_id + value + states + path）的差异
// 及依据，全部登记在证据材料 §20.2；一句话概括：
//   - path 不是身份：上游注释原文「the path moves when the siblings are reordered」，
//     且规格自己要求的夹具②（两个同名按钮 → ambiguous）只在 path 不参与判等时可达；
//   - states 不是身份：enabled/visible 是可变运行态，抖动会把唯一匹配打成 timeout；
//   - value 只在「name 缺失且 role 不是 mutable-value」时兜底当身份：上游注释原文
//     「Mutable values and bounds are never identity」。
// 这三个字段仍然保留在 RefEntry 里（§4.4 字段表要求），只是不参与身份判等：
// states 供 P2-6 可操作性门禁，path 供 invokeByPath 落点，value 供 stable_name 判稳。

/** 值会被用户输入改变的角色（上游 tree/roles.rs:88）；这些 role 的 value 不作身份。 */
const MUTABLE_VALUE_ROLES = new Set([
  'combobox', 'checkbox', 'handle', 'incrementor', 'listbox',
  'radiobutton', 'scrollbar', 'slider', 'switch', 'textfield',
]);

function text(value) {
  return String(value === undefined || value === null ? '' : value);
}

/** 空白串视为「没记录」（上游 non_blank）。 */
function nonBlank(value) {
  const s = text(value);
  return s.trim() === '' ? null : s;
}

/** role 的 value 是否可变（可变 → 不能拿 value 当身份）。 */
function isMutableValueRole(role) {
  return MUTABLE_VALUE_ROLES.has(text(role));
}

/** 形如 `42` / `42.0` 的文本按数值比较（上游 numeric_text，处理滑块等数值回显）。 */
function numericText(value) {
  const s = text(value).trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** value 与 name 是否「说的是同一件事」：完全相等，或数值相等。 */
function valueMatchesName(value, name) {
  if (value === null || name === null) return false;
  if (value === name) return true;
  const a = numericText(value);
  const b = numericText(name);
  return a !== null && b !== null && a === b;
}

/**
 * 稳定名称（上游 stable_name）：非空 name；但 mutable-value role 的 name 若只是
 * value 的回显（Chromium 的 textarea 常见），则该 name 不稳定，返回 null。
 */
function stableName(role, name, value) {
  const n = nonBlank(name);
  if (!n) return null;
  if (isMutableValueRole(role) && valueMatchesName(nonBlank(value), n)) return null;
  return n;
}

/** 稳定值（上游 stable_value）：mutable-value role 的 value 不作身份，返回 null。 */
function stableValue(role, value) {
  return isMutableValueRole(role) ? null : nonBlank(value);
}

/**
 * 一次身份比对的三态结论（§P2-4 步骤 4：Match / Unknown / NoMatch）。
 * 字符串常量而非枚举对象，便于测试直接断言。
 */
const MATCH = 'match';
const UNKNOWN = 'unknown';
const NOMATCH = 'nomatch';

/** 合取（上游 conjunction）：NoMatch 吸收一切，其次 Unknown，全 Match 才是 Match。 */
function conjunction(left, right) {
  if (left === NOMATCH || right === NOMATCH) return NOMATCH;
  if (left === UNKNOWN || right === UNKNOWN) return UNKNOWN;
  return MATCH;
}

/**
 * 身份谓词：由 RefEntry 反推「该元素记录下来的身份」，再与 live 节点逐字段合取。
 *
 * 记录口径与上游一致：
 *   native_id —— 空白视为未记录（`ref_full_predicate.rs:45`）；
 *   name      —— 走 stableName，回显型 name 自动降级为未记录；
 *   value     —— 只在没有 name 时兜底，且仅限非 mutable-value role；
 *   description —— 当前 OPS 观察树不产出 description，恒未记录（保留字段以便 P3 扩展）。
 */
class FullPredicate {
  static ofEntry(entry) {
    return new FullPredicate(entry);
  }

  constructor(entry) {
    const e = entry || {};
    this.entry = e;
    this.role = text(e.role);
    this.nativeId = nonBlank(e.native_id);
    this.name = stableName(this.role, e.name, e.value);
    this.value = stableValue(this.role, e.value);
    this.description = nonBlank(e.description);
    // 除 role 外是否还记录了任何身份字段。全空 → 该谓词无法证明「是同一个元素」，
    // 对应规格 §P2-4 步骤 7 的 identity_unproven（上游 has_meaningful_identity）。
    this.recordsIdentity = Boolean(this.nativeId || this.name || this.value || this.description);
  }

  /**
   * 与 live 节点比对。live 侧字段在本机 UIA 读取中总是「已读到」（name/value/id
   * 都取到了，AutomationId 集合视为完整），因此 Unknown 只可能来自「谓词没记录任何
   * 身份字段」，不会来自读不到字段——这与上游唯一的差别是 OPS 不做 identity-only 采样。
   */
  compare(node) {
    if (!node) return NOMATCH;
    if (this.role && text(node.role) !== this.role) return NOMATCH;
    if (!this.recordsIdentity) return UNKNOWN;

    let verdict = MATCH;

    if (this.nativeId) {
      const liveNative = nonBlank(node.native_id);
      // live 侧已读全：记录过却被读到空 / 读到别的 id → 明确不是同一个。
      verdict = conjunction(verdict, liveNative === this.nativeId ? MATCH : NOMATCH);
    }

    if (this.name) {
      const liveName = stableName(this.role, node.name, node.value);
      verdict = conjunction(verdict, liveName === this.name ? MATCH : NOMATCH);
    } else if (this.value) {
      // name 缺失时的主身份兜底（上游 stable_text_match 的 expected_value 分支）。
      const liveValue = stableValue(this.role, node.value);
      verdict = conjunction(verdict, liveValue === this.value ? MATCH : NOMATCH);
    }

    if (this.description) {
      const liveDesc = nonBlank(node.description);
      verdict = conjunction(verdict, liveDesc === this.description ? MATCH : NOMATCH);
    }

    return verdict;
  }

  /** 兼容旧调用点（P2-4 早期版本的方法名）。 */
  test(node) {
    return this.compare(node);
  }
}

/** 该 RefEntry 是否有可用于再解析的身份（规格步骤 7 / 上游 has_meaningful_identity）。 */
function hasMeaningfulIdentity(entry) {
  return FullPredicate.ofEntry(entry).recordsIdentity;
}

/** 在树里数「与该谓词判等为 Match」的节点数；供 unique_at_capture 复算。 */
function countIdentityMatches(tree, predicate) {
  let n = 0;
  (function walk(node) {
    if (!node) return;
    if (predicate.compare(node) === MATCH) n += 1;
    for (const c of node.children || []) walk(c);
  })(tree);
  return n;
}

module.exports = {
  MUTABLE_VALUE_ROLES,
  MATCH,
  UNKNOWN,
  NOMATCH,
  nonBlank,
  isMutableValueRole,
  valueMatchesName,
  stableName,
  stableValue,
  conjunction,
  FullPredicate,
  hasMeaningfulIdentity,
  countIdentityMatches,
};
