'use strict';
// DEV-CU P2-3：进程内 RefStore（§4.4 保留策略与授权绑定）。
// 明确不改：不落盘、不写 ~/.agent-desktop/sessions/——授权撤销即失效（C02）。
// 生命周期与 worker 进程一致：进程退出即全部失效（index.js 里有显式 clear）。

const { WorkerError } = require('./refs');

/** 单 grant 最多保留 8 个快照；超出按 createdAt 升序淘汰，但永不淘汰 latest。 */
const DEFAULT_MAX_PER_GRANT = 8;

function staleRef(message) {
  return new WorkerError('computer_stale_ref', message);
}

class RefStore {
  constructor({ maxPerGrant = DEFAULT_MAX_PER_GRANT } = {}) {
    this.maxPerGrant = Number.isFinite(Number(maxPerGrant)) ? Math.max(0, Number(maxPerGrant)) : DEFAULT_MAX_PER_GRANT;
    /** grant_id → Map<snapshot_id, entry> */
    this.buckets = new Map();
    this.seq = 0;
  }

  get total() {
    let n = 0;
    for (const b of this.buckets.values()) n += b.size;
    return n;
  }

  /**
   * 保存一次观察。entry: { refmap, generation, tree, createdAt? }
   * 返回 { size, evicted[] }。evicted 便于上层记录「旧快照已失效」。
   */
  save(grantId, snapshotId, entry = {}) {
    const gid = String(grantId || '');
    const sid = String(snapshotId || '');
    if (!gid) throw new WorkerError('computer_invalid_args', 'grant_id 不能为空');
    if (!sid) throw new WorkerError('computer_invalid_args', 'snapshot_id 不能为空');

    let bucket = this.buckets.get(gid);
    if (!bucket) { bucket = new Map(); this.buckets.set(gid, bucket); }

    this.seq += 1;
    bucket.set(sid, {
      snapshot_id: sid,
      refmap: entry.refmap || null,
      generation: Number(entry.generation) || 0,
      tree: entry.tree || null,
      // P2-4：严格再解析要拿当时的窗口身份做比对（§4.9 四要素）
      identity: entry.identity || null,
      createdAt: Number.isFinite(Number(entry.createdAt)) ? Number(entry.createdAt) : Date.now(),
      seq: this.seq,
    });

    return { size: bucket.size, evicted: this.evict(gid, sid) };
  }

  /** 超出上限时淘汰最旧的「非 latest」条目。maxPerGrant=0 时也会留下 latest。 */
  evict(grantId, latestId) {
    const bucket = this.buckets.get(String(grantId || ''));
    if (!bucket) return [];
    const evicted = [];
    while (bucket.size > this.maxPerGrant) {
      let victim = null;
      for (const [sid, e] of bucket) {
        if (sid === latestId) continue;
        if (!victim
          || e.createdAt < victim.entry.createdAt
          || (e.createdAt === victim.entry.createdAt && e.seq < victim.entry.seq)) {
          victim = { sid, entry: e };
        }
      }
      if (!victim) break; // 只剩 latest，宁可超限也不淘汰它
      bucket.delete(victim.sid);
      evicted.push(victim.sid);
    }
    return evicted;
  }

  /**
   * 取快照。三个维度全匹配才返回：snapshot_id + grant_id + generation。
   * generation 先校验——不一致直接 stale，不进入树比较（步骤 6）。
   */
  load(snapshotId, grantId, generation) {
    const gid = String(grantId || '');
    const sid = String(snapshotId || '');
    const bucket = this.buckets.get(gid);
    if (!bucket) throw staleRef('授权无快照，请重新观察');
    const entry = bucket.get(sid);
    if (!entry) throw staleRef('快照不存在或已被淘汰，请重新观察');
    if (Number(entry.generation) !== Number(generation)) {
      throw staleRef('租约 generation 已变化，请重新观察');
    }
    return entry;
  }

  /** 清空某个 grant 的全部快照（租约撤销 / handoff / 锁屏时由主进程调用）。 */
  invalidate(grantId) {
    const gid = String(grantId || '');
    const bucket = this.buckets.get(gid);
    if (!bucket) return 0;
    const n = bucket.size;
    this.buckets.delete(gid);
    return n;
  }

  /** 进程退出用。 */
  clear() {
    const n = this.total;
    this.buckets.clear();
    return n;
  }

  stats() {
    return { grants: this.buckets.size, snapshots: this.total, maxPerGrant: this.maxPerGrant };
  }
}

module.exports = { RefStore, DEFAULT_MAX_PER_GRANT };
