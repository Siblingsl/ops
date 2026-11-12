'use strict';
// DEV-CU P2-2：快照 ID 与 ref 分配（§4.4）。
// 边界：本文件只做「进程内的一次观察」——不落盘、不跨授权保留（P2-3 的 RefStore 负责）。
// 明确不改：uia_invoke 仍按 AutomationId 定位（P2-4 才替换为 ref + 身份谓词）。

const crypto = require('node:crypto');

const { INTERACTIVE_ROLES } = require('./tree');
const { FullPredicate, countIdentityMatches } = require('./identity');

/** 快照 ID 校验（§4.4）：`^[A-Za-z0-9_-]{3,64}$`。 */
const SNAPSHOT_ID_RE = /^[A-Za-z0-9_-]{3,64}$/;

/** 该 ref 上限为 u32；达到上限后拒绝再分配。 */
const MAX_REF_INDEX = 0xFFFFFFFF;

/** 不算「primary action」的通用动作：任何节点都会广告，计入会导致 ref 溢出。 */
const UBIQUITOUS_ACTIONS = new Set(['SetFocus', 'RightClick', 'ScrollTo']);

/** ref 序列化上限 1MiB（§4.4 保留策略 / 步骤 7）。 */
const MAX_TREE_BYTES = 1024 * 1024;

let snapshotCounter = 0;
let revisionCounter = 0;

/** 带错误码的内部错误：native.js 直接把它映射成 {ok:false,error:code}。 */
class WorkerError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function validateSnapshotId(id) {
  return typeof id === 'string' && SNAPSHOT_ID_RE.test(id);
}

/** `s` + base36(hash(纳秒, pid, 原子计数))，不足 4 位左补 0（§4.4）。 */
function newSnapshotId() {
  snapshotCounter = (snapshotCounter + 1) % Number.MAX_SAFE_INTEGER;
  const nanos = process.hrtime.bigint();
  const digest = crypto.createHash('sha256')
    .update(`${nanos}:${process.pid}:${snapshotCounter}`)
    .digest();
  let n = 0n;
  for (const b of digest.subarray(0, 8)) n = (n << 8n) | BigInt(b);
  let body = n.toString(36).slice(0, 12);
  if (body.length < 4) body = body.padStart(4, '0');
  return `s${body}`;
}

/** 每次观察 +1（进程内单调）。P2-3 会把归属下沉到 RefStore。 */
function nextRevision() {
  revisionCounter += 1;
  return revisionCounter;
}

/** 进程内 ref 表：`@e1` 起，逐个自增。 */
class RefMap {
  constructor() {
    this.inner = new Map();
    this.counter = 0;
  }

  allocateValidated(entry) {
    if (this.counter >= MAX_REF_INDEX) {
      throw new WorkerError('computer_internal', 'ref 索引已达 u32 上限，请重新观察');
    }
    this.counter += 1;
    const ref = `@e${this.counter}`;
    const record = { ...entry, ref };
    this.inner.set(ref, record);
    return ref;
  }

  get size() { return this.inner.size; }

  get(ref) { return this.inner.get(ref); }
}

/** 本地 ref → 全局 ref：`@<snapshot_id>:e<N>`（§4.4）。 */
function qualifyRefId(snapshotId, localRef) {
  if (!validateSnapshotId(snapshotId)) {
    throw new WorkerError('computer_internal', 'snapshot_id 非法');
  }
  const m = /^@e([0-9]{1,10})$/.exec(String(localRef || ''));
  if (!m) throw new WorkerError('computer_internal', `本地 ref 非法：${localRef}`);
  return `@${snapshotId}:e${m[1]}`;
}

/**
 * 解析全局 ref（步骤 4）。必须 `@` 开头、含 `:e`、snapshot_id 合法、N 为 1..10 位正整数。
 * 失败一律 `computer_invalid_args`，错误信息含期望形状。
 */
function resolveRefTarget(ref) {
  const expected = 'expected @<snapshot_id>:e<N>';
  if (typeof ref !== 'string' || !ref.startsWith('@')) {
    throw new WorkerError('computer_invalid_args', `ref 必须以 @ 开头；${expected}`);
  }
  const i = ref.lastIndexOf(':e');
  if (i <= 1) throw new WorkerError('computer_invalid_args', `ref 缺少 <snapshot_id>:e<N>；${expected}`);
  const snapshotId = ref.slice(1, i);
  const indexRaw = ref.slice(i + 2);
  if (!validateSnapshotId(snapshotId)) {
    throw new WorkerError('computer_invalid_args', `snapshot_id 非法；${expected}`);
  }
  if (!/^[0-9]{1,10}$/.test(indexRaw)) {
    throw new WorkerError('computer_invalid_args', `ref 序号必须是 1..10 位数字；${expected}`);
  }
  const index = Number(indexRaw);
  if (!Number.isSafeInteger(index) || index <= 0) {
    throw new WorkerError('computer_invalid_args', `ref 序号必须为正整数；${expected}`);
  }
  return { snapshotId, index };
}

/** 是否值得分配 ref：命中 role 白名单，或带非 ubiquitous 的 primary action（步骤 5）。 */
function isRefAble(role, availableActions) {
  if (INTERACTIVE_ROLES.includes(role)) return true;
  if (!Array.isArray(availableActions)) return false;
  return availableActions.some((a) => !UBIQUITOUS_ACTIONS.has(a));
}

/** 递归改写 ref_id（步骤 3）。 */
function qualifyTreeRefs(tree, snapshotId) {
  if (!tree) return tree;
  if (tree.ref_id) tree.ref_id = qualifyRefId(snapshotId, tree.ref_id);
  for (const c of tree.children || []) qualifyTreeRefs(c, snapshotId);
  return tree;
}

/** 统计树中已分配 ref 的节点数（用于 ref_count 复算）。 */
function countRefs(tree) {
  if (!tree) return 0;
  let n = tree.ref_id ? 1 : 0;
  for (const c of tree.children || []) n += countRefs(c);
  return n;
}

/** 树中所有 ref 是否两两不同（ref_count 可复算的前提）。 */
function refsAreUnique(tree) {
  const seen = new Set();
  let ok = true;
  (function walk(node) {
    if (!ok || !node) return;
    if (node.ref_id) {
      if (seen.has(node.ref_id)) { ok = false; return; }
      seen.add(node.ref_id);
    }
    for (const c of node.children || []) walk(c);
  })(tree);
  return ok;
}

function hash16(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex').slice(0, 16);
}

/**
 * compact 模式：折叠「无 ref 且只有一个子节点」的透明 wrapper（步骤 6）。
 * 只折叠 role=unknown 的节点——有明确 role 的容器保留，避免丢语义。
 */
function compactTree(tree) {
  if (!tree) return tree;
  const kids = (tree.children || []).map(compactTree);
  const only = kids.length === 1 ? kids[0] : null;
  if (only && tree.role === 'unknown' && !tree.ref_id) return only;
  tree.children = kids;
  return tree;
}

/**
 * 递归分配 ref（步骤 6）。
 * ctx: { snapshotId, identity, grantId?, generation?, compact?, complete?, pathIsAbsolute? }
 * 返回 RefMap；节点的 ref_id 先写本地 `@eN`，由调用方再 qualify。
 *
 * `pathIsAbsolute` 默认 true。P2-7 的 uia_observe 允许按 root_ref / interactive_only /
 * compact 做结构投影，这时下标链只相对返回树的根，必须标 false，否则下游会把它当成
 * 整窗绝对路径去用（上游同名字段就是这个含义）。
 *
 * `unique_at_capture` 不在分配时按「兄弟间 AutomationId 是否唯一」判定（P2-2 早期口径），
 * 而是在整棵树分配完成后、用**同一个身份谓词**全树复算（P2-4 对齐上游 CaptureProof
 * `proves_node`：完整整窗观察 + 恰好一个节点匹配 + 该节点就是本节点）。原因：无
 * AutomationId 的元素（如新版记事本编辑区）只能靠 role+stable_name 证明唯一，按兄弟
 * 判 id 会把它一律标成不唯一，等于永久禁止按 ref 操作。
 */
function allocateTreeRefs(tree, ctx = {}) {
  const identity = ctx.identity || {};
  const map = new RefMap();
  const grantId = String(ctx.grantId || '');
  const generation = Number(ctx.generation || 0);
  const revision = Number(ctx.revision || 0);
  const root = ctx.compact ? compactTree(tree) : tree;
  // P2-5：优先用采集阶段对 MainWindowTitle 算出的 32 位摘要；夹具（无标题）回退到旧算法。
  const windowTitleHash = String(identity.title_hash || '') || hash16(root ? root.name : '');
  // 未显式传 complete 的调用方（夹具/单测）按「读全了」处理；生产路径 readUIA 一定显式传。
  const captureComplete = (ctx.complete === undefined ? true : ctx.complete === true);
  const pathIsAbsolute = ctx.pathIsAbsolute === undefined ? true : ctx.pathIsAbsolute !== false;

  const walk = (node, path) => {
    if (!node) return;
    const nativeId = String(node.native_id || '');
    if (isRefAble(node.role, node.available_actions)) {
      node.ref_id = map.allocateValidated({
        role: node.role,
        name: node.name,
        value: node.value,
        description: '',
        native_id: nativeId,
        unique_at_capture: false, // 分配完成后按身份谓词全树复算
        pid: Number(identity.pid) || 0,
        process_start_time: String(identity.process_start_time || ''),
        process_instance: '',
        target_handle: String(identity.target_handle || ''),
        hwnd: Number(identity.hwnd) || 0,
        window_title_hash: windowTitleHash,
        window_bounds_hash: String(identity.window_bounds_hash || ''),
        surface: '',
        bounds: { ...node.bounds },
        bounds_hash: node.bounds_hash,
        bounds_space: 'screen',
        states: node.states.slice(),
        available_actions: node.available_actions.slice(),
        root_ref: '', // 分配完成后统一回填根 ref
        path: path.slice(),
        path_is_absolute: pathIsAbsolute,
        grant_id: grantId,
        generation,
        snapshot_id: ctx.snapshotId || '',
        revision,
      });
    }
    const kids = node.children || [];
    for (let i = 0; i < kids.length; i++) walk(kids[i], path.concat(i), kids);
  };

  walk(root, [], root ? [root] : []);

  // root_ref 指本次观察的根节点 ref（根不可分配时为空串，不借用子节点）。
  // unique_at_capture 用身份谓词全树复算：恰好一个节点匹配、且本次观察完整。
  const rootRef = (root && root.ref_id) || '';
  for (const entry of map.inner.values()) {
    entry.root_ref = rootRef;
    entry.unique_at_capture = captureComplete
      && countIdentityMatches(root, FullPredicate.ofEntry(entry)) === 1;
  }

  return { map, tree: root, count: map.size };
}

/** 步骤 7：序列化字节数超 1MiB 直接报错，提示用 --root / 减小深度。 */
function assertTreeSize(tree) {
  const bytes = Buffer.byteLength(JSON.stringify(tree), 'utf8');
  if (bytes > MAX_TREE_BYTES) {
    throw new WorkerError('computer_internal', `观察树序列化 ${bytes} 字节，超过 1MiB；请用 --root 或减小 max_depth`);
  }
  return bytes;
}

module.exports = {
  SNAPSHOT_ID_RE,
  MAX_REF_INDEX,
  MAX_TREE_BYTES,
  UBIQUITOUS_ACTIONS,
  WorkerError,
  validateSnapshotId,
  newSnapshotId,
  nextRevision,
  RefMap,
  qualifyRefId,
  resolveRefTarget,
  isRefAble,
  qualifyTreeRefs,
  countRefs,
  refsAreUnique,
  compactTree,
  allocateTreeRefs,
  assertTreeSize,
};
