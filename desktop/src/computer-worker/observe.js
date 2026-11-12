'use strict';
// DEV-CU P2-7：`uia_observe` 命令——观察输出契约（§4.5）+ 入参校验 + 投影/分配顺序。
//
// 为什么单独成文件：index.js 的头注释定死了它只做「通道适配 + 消息协议 + busy 串行化」
// （P2-0 的拆分原则）。本包要落的是「入参校验 → 身份 → 抓树 → 裁剪 → 分配 ref → 输出」
// 六步，塞回 index.js 会让那条边界失效。
//
// 与 readUIA 的区别（不是重复实现）：
//   - readUIA 是 P2-2 的「全窗观察」，抓完立刻在全树上分配 ref；
//   - 本文件按 §P2-7 步骤 2 的顺序，**先裁剪再分配**，所以不能直接复用 readUIA，
//     只能复用它的下层 observeOnce。两者共用同一套 refs.js / tree.js，不另起一套。
//
// 顺序（§P2-7 步骤 2，顺序本身是契约）：
//   isHardForbidden → pid 校验 → 窗口身份 → 抓树 → 裁剪 → 分配 ref → 存 RefStore
//   → qualifyTreeRefs → 输出
// 存 RefStore 在 index.js（它持有 refStore 单例），本文件只把 refmap 以不可枚举属性挂回。

const { isHardForbidden } = require('./policy');
const { observeOnce, windowIdentity } = require('./native');
const { projectWindow } = require('./tree');
const { isRefAble } = require('./refs');
const {
  newSnapshotId, nextRevision, allocateTreeRefs, qualifyTreeRefs,
  assertTreeSize, countRefs, refsAreUnique, resolveRefTarget, WorkerError,
} = require('./refs');
const {
  assertIdentityProof, FullPredicate, classifyTree, decideResolution,
} = require('./resolve');

/** 入参上限（§P2-7 步骤 1「逐项类型与长度校验」）。 */
const OBSERVE_LIMITS = Object.freeze({
  target_summary: 256,
  grant_id: 64,
  root_ref: 128,
  max_depth: 50, // 与 §P2-1 的深度上限一致
  generation: 2 ** 31 - 1,
});

function invalid(message) {
  return new WorkerError('computer_invalid_args', message);
}

/**
 * 入参归一化。抛错口径与既有 `uia_read` / `uia_invoke` 保持一致：
 * pid 不合法 → `pid_invalid`；其余 → `computer_invalid_args`。
 */
function normalizeObserveParams(msg) {
  const body = msg && typeof msg === 'object' ? msg : {};
  const pid = Number(body.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new WorkerError('pid_invalid', 'pid 必须是正整数');
  }

  const summaryRaw = body.target_summary;
  if (summaryRaw !== undefined && summaryRaw !== null && typeof summaryRaw !== 'string') {
    throw invalid('target_summary 必须是字符串');
  }
  const targetSummary = String(summaryRaw || '');
  if (targetSummary.length > OBSERVE_LIMITS.target_summary) {
    throw invalid(`target_summary 不能超过 ${OBSERVE_LIMITS.target_summary} 字符`);
  }
  if (isHardForbidden(targetSummary)) {
    throw new WorkerError('hard_forbidden', '该目标属于硬禁区，不允许观察');
  }

  const grantId = String(body.grant_id === undefined || body.grant_id === null ? '' : body.grant_id);
  if (!grantId) throw invalid('grant_id 不能为空');
  if (grantId.length > OBSERVE_LIMITS.grant_id) {
    throw invalid(`grant_id 不能超过 ${OBSERVE_LIMITS.grant_id} 字符`);
  }

  // generation 缺省按 0（与 uia_invoke / RefStore 的既有口径一致）；给了就必须是整数。
  // 类型必须真是 number：新命令按 §P2-7 步骤 1「逐项类型校验」执行，不做字符串隐式转换
  // （`"3"` 这种在旧命令上能过，但那是兼容遗留，不是新契约该继承的行为）。
  let generation = 0;
  if (body.generation !== undefined && body.generation !== null) {
    if (typeof body.generation !== 'number') throw invalid('generation 必须是数字');
    generation = body.generation;
    if (!Number.isInteger(generation) || generation < 0 || generation > OBSERVE_LIMITS.generation) {
      throw invalid('generation 必须是非负整数');
    }
  }

  let maxDepth;
  if (body.max_depth !== undefined && body.max_depth !== null) {
    if (typeof body.max_depth !== 'number') throw invalid('max_depth 必须是数字');
    maxDepth = body.max_depth;
    if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > OBSERVE_LIMITS.max_depth) {
      throw invalid(`max_depth 必须是 0..${OBSERVE_LIMITS.max_depth} 的整数`);
    }
  }

  let rootRef = '';
  if (body.root_ref !== undefined && body.root_ref !== null && body.root_ref !== '') {
    if (typeof body.root_ref !== 'string') throw invalid('root_ref 必须是字符串');
    if (body.root_ref.length > OBSERVE_LIMITS.root_ref) {
      throw invalid(`root_ref 不能超过 ${OBSERVE_LIMITS.root_ref} 字符`);
    }
    resolveRefTarget(body.root_ref); // 形状不合 → computer_invalid_args
    rootRef = body.root_ref;
  }

  for (const key of ['interactive_only', 'compact']) {
    if (body[key] !== undefined && body[key] !== null && typeof body[key] !== 'boolean') {
      throw invalid(`${key} 必须是布尔值`);
    }
  }

  return {
    pid,
    target_summary: targetSummary,
    grant_id: grantId,
    generation,
    max_depth: maxDepth,
    root_ref: rootRef,
    interactive_only: body.interactive_only === true,
    compact: body.compact === true,
  };
}

// ---------------------------------------------------------------------------
// 投影（纯函数）
// ---------------------------------------------------------------------------

/** 节点是否值得留在 interactive_only 结果里（可分配 ref 即视为可交互）。 */
function isInteractiveNode(node) {
  return Boolean(node) && isRefAble(node.role, node.available_actions);
}

/**
 * interactive_only：只留可交互节点及其祖先。
 * 祖先必须保留，否则子节点会失去路径上下文（也就失去了再解析的依据）。
 * 根无论如何都保留——一个完全没有可交互控件的窗口是「空结果」，不是「失败」；
 * 返回 null 会被上层当成立即 stale，那是错误语义。
 *
 * 注意：`native_id` 在归一化树上是**不可枚举**属性（见 tree.js），普通展开会把它丢掉，
 * 那样 ref 的身份谓词就失效了，所以这里显式重新定义一次。
 */
function cloneKept(node, kids) {
  const copy = {
    ...node,
    children: kids,
    children_count: Math.max(Number(node.children_count) || 0, kids.length),
  };
  Object.defineProperty(copy, 'native_id', {
    value: String(node.native_id || ''), enumerable: false, configurable: true, writable: true,
  });
  return copy;
}

function keepInteractive(tree) {
  if (!tree) return tree;
  const walk = (node) => {
    if (!node) return null;
    const kids = (node.children || []).map(walk).filter(Boolean);
    if (kids.length === 0 && !isInteractiveNode(node)) return null;
    return cloneKept(node, kids);
  };
  return walk(tree) || cloneKept(tree, []);
}

function depthOf(tree) {
  if (!tree) return 0;
  let max = 0;
  for (const c of tree.children || []) max = Math.max(max, depthOf(c));
  return max + 1;
}

/**
 * 裁剪：root_ref 子树 → interactive_only → max_depth。
 * 返回 `{ tree, projected, depth_trimmed }`；`projected` 表示结构被改过（用于 identity_unproven）。
 */
function projectTree(tree, params, rootNode) {
  let out = rootNode || tree;
  let projected = Boolean(rootNode);
  if (params.interactive_only) {
    out = keepInteractive(out);
    projected = true;
  }
  let depthTrimmed = false;
  if (params.max_depth !== undefined) {
    depthTrimmed = depthOf(out) > params.max_depth;
    out = projectWindow(out, params.max_depth);
  }
  if (!out) throw new WorkerError('computer_stale_ref', '该 root_ref 在新观察里已不存在，请重新观察');
  return { tree: out, projected, depth_trimmed: depthTrimmed };
}

// ---------------------------------------------------------------------------
// 组装（纯函数）
// ---------------------------------------------------------------------------

/**
 * 把「已裁剪的树」分配 ref 并组装 §4.5 输出。
 * ctx: { snapshotId, revision, identity, complete, compact }
 *
 * `provenComplete` 决定 `unique_at_capture`：只有「整窗读全 + 没有任何结构投影」时，
 * 才敢声称某个 ref 在捕获时唯一。否则一律 false——对应 §4.5「identity_unproven:true 时
 * 禁止对无 token 的 ref 做严格再解析」。
 */
function allocateAndBuild(projectedTree, ctx) {
  const { snapshotId, revision, identity, provenComplete, projected, compact } = ctx;
  let allocated;
  try {
    allocated = allocateTreeRefs(projectedTree, {
      snapshotId,
      revision,
      identity,
      compact: compact === true,
      complete: provenComplete === true,
      // 结构被投影过 → 路径是相对返回树根的下标链，不再代表整窗绝对路径
      pathIsAbsolute: !projected,
    });
    qualifyTreeRefs(allocated.tree, snapshotId);
    assertTreeSize(allocated.tree);
  } catch (e) {
    if (e instanceof WorkerError) throw e;
    throw new WorkerError('computer_internal', String((e && e.message) || e));
  }
  if (countRefs(allocated.tree) !== allocated.count || !refsAreUnique(allocated.tree)) {
    throw new WorkerError('computer_internal', 'ref 分配自检失败');
  }
  const refCount = countRefs(allocated.tree);
  return { tree: allocated.tree, refmap: allocated.map, ref_count: refCount };
}

/**
 * 组装最终响应。字段集严格照 §4.5 / §P2-7 步骤 3：
 *   必有 snapshot_id / revision / ref_count / complete / tree；
 *   截断时补 truncated:true；
 *   identity_unproven:true 只在无法证明身份时出现。
 * 刻意**不带**窗口标题明文（§4.5：preload 侧仍禁止完整窗口标题；本层就不往外递）。
 */
function buildResponse(fields) {
  const out = {
    ok: true,
    snapshot_id: fields.snapshot_id,
    revision: fields.revision,
    ref_count: fields.ref_count,
    complete: fields.complete === true,
    nodes_observed: fields.nodes_observed,
    tree: fields.tree,
  };
  if (fields.truncated === true) out.truncated = true;
  if (fields.identity_unproven === true) out.identity_unproven = true;
  // 内部用途，不可枚举：不进 postMessage / JSON，也不进契约校验。
  Object.defineProperty(out, 'refmap', {
    value: fields.refmap, enumerable: false, configurable: true, writable: true,
  });
  Object.defineProperty(out, 'window_identity', {
    value: fields.identity, enumerable: false, configurable: true, writable: true,
  });
  return out;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function fail(e) {
  if (e instanceof WorkerError) return { ok: false, error: e.code, message: e.message, detail: e.detail };
  return { ok: false, error: 'computer_internal', message: String((e && e.message) || e) };
}

/**
 * native.js 的错误是「诊断文本」（`uia_failed: Command failed: ...`），不是 §4.2 错误码。
 * 直接把它当 code 回传，会让上游收到一个不在封闭集合里的码——P4-10 的 Go/TS parity
 * 会立刻炸。这里统一收敛，原文只留在 message 里。
 */
function treeErrorCode(raw) {
  const text = String(raw || '');
  if (/^uia_failed/.test(text)) return 'computer_app_unresponsive';
  if (/^uia_parse_failed$/.test(text)) return 'computer_internal';
  return 'computer_internal';
}

/**
 * 执行一次 `uia_observe`。`refStore` 只用于 root_ref 取旧快照（存由 index.js 做）。
 * 返回 §4.5 响应，或 `{ok:false, error, message, detail}`。
 *
 * 声明成 async：入参校验失败时也要给出 Promise，否则调用方 `.then` 会炸
 * （index.js 的通道适配就是按 Promise 接的）。
 */
async function observe(msg, { refStore } = {}) {
  let params;
  try {
    params = normalizeObserveParams(msg);
  } catch (e) {
    return fail(e);
  }
  const { pid } = params;

  // 步骤 3：窗口身份（先于抓树，窗口不在了就不必花一次整树读取）
  return windowIdentity(pid)
    .then((ident) => {
      if (!ident || ident.ok !== true) {
        throw new WorkerError('computer_target_changed', '目标窗口身份采样失败：窗口可能已关闭或尚未就绪');
      }
      // 步骤 4：抓树
      return observeOnce(pid).then((obs) => ({ ident, obs }));
    })
    .then(({ ident, obs }) => {
      if (!obs || obs.ok !== true) {
        const raw = (obs && obs.error) || '';
        throw new WorkerError(
          treeErrorCode(raw),
          raw ? `读取目标窗口 UIA 树失败：${raw}` : '读取目标窗口 UIA 树失败',
        );
      }
      // 身份以「抓树时那一次」为准：两次 PowerShell 之间窗口可能变过。
      const identity = {
        ...(obs.window_identity || {}),
        pid: ident.pid || pid,
        process_start_time: ident.process_start_time || (obs.window_identity || {}).process_start_time || '',
        target_handle: ident.target_handle || (obs.window_identity || {}).target_handle || '',
        hwnd: ident.hwnd || (obs.window_identity || {}).hwnd || 0,
        window_bounds_hash: (obs.window_identity || {}).window_bounds_hash || ident.window_bounds_hash || '',
      };
      Object.defineProperty(identity, 'title_hash', {
        value: ident.title_hash || '', enumerable: false, configurable: true, writable: true,
      });

      // 步骤 5a：root_ref → 在新树里按身份谓词唯一再解析，取到子树根
      let rootNode = null;
      if (params.root_ref) {
        const target = resolveRefTarget(params.root_ref);
        if (!refStore) throw new WorkerError('computer_stale_ref', '没有可用的快照存储，无法按 root_ref 观察');
        const snapshot = refStore.load(target.snapshotId, params.grant_id, params.generation);
        const entry = snapshot.refmap && snapshot.refmap.get(`@e${target.index}`);
        if (!entry) throw new WorkerError('computer_stale_ref', '该 root_ref 不属于这个快照，请重新观察');
        assertIdentityProof(entry, target.snapshotId, params.root_ref);
        const classified = classifyTree(obs.tree, FullPredicate.ofEntry(entry));
        const match = decideResolution(
          { ...classified, complete: obs.complete }, entry, target.snapshotId, params.root_ref,
        );
        rootNode = match.node;
      }

      // 步骤 5b：裁剪
      const trimmed = projectTree(obs.tree, params, rootNode);

      // 步骤 6：分配 ref（先裁剪后分配，是 §P2-7 的顺序）
      const snapshotId = newSnapshotId();
      const revision = nextRevision();
      const provenComplete = obs.complete === true && !trimmed.projected && !params.compact;
      const built = allocateAndBuild(trimmed.tree, {
        snapshotId,
        revision,
        identity,
        provenComplete,
        compact: params.compact,
        projected: trimmed.projected,
      });

      return buildResponse({
        snapshot_id: snapshotId,
        revision,
        ref_count: built.ref_count,
        complete: obs.complete === true,
        nodes_observed: obs.nodes_observed,
        truncated: obs.complete !== true || trimmed.projected || trimmed.depth_trimmed,
        identity_unproven: !provenComplete,
        tree: built.tree,
        refmap: built.refmap,
        identity,
      });
    })
    .catch(fail);
}

module.exports = {
  OBSERVE_LIMITS,
  normalizeObserveParams,
  isInteractiveNode,
  keepInteractive,
  projectTree,
  allocateAndBuild,
  buildResponse,
  observe,
};
