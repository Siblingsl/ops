// 发布循环与采集循环共用同一个平台 profile，必须互斥。
// 锁必须能在发布页面/网络调用挂起时被超时释放；不能用“函数返回后 finally”
// 作为唯一复位路径，否则一个挂起的 await 就会让采集永远拿不到锁。

export const PUBLISH_LOOP_LOCK_MAX_AGE_MS = 8 * 60_000;

export class PublishLoopLock {
  private owner: number | null = null;
  private startedAt = 0;
  private sequence = 0;

  constructor(
    private readonly maxAgeMs: number = PUBLISH_LOOP_LOCK_MAX_AGE_MS,
    private readonly now: () => number = Date.now
  ) {}

  /** 获取锁；已有持有者时返回 null，不排队、不抢占。 */
  acquire(): number | null {
    if (this.owner !== null) return null;
    const token = ++this.sequence;
    this.owner = token;
    this.startedAt = this.now();
    return token;
  }

  isHeld(): boolean {
    return this.owner !== null;
  }

  owns(token: number): boolean {
    return this.owner === token;
  }

  /** 只按时间判断；是否强制释放由调用方决定，避免误杀正常的长发布任务。 */
  isExpired(): boolean {
    return this.owner !== null && this.now() - this.startedAt >= this.maxAgeMs;
  }

  /** 释放自己的锁；过期后旧 tick 的 token 不能清掉新 tick 的锁。 */
  release(token: number): boolean {
    if (this.owner !== token) return false;
    this.owner = null;
    this.startedAt = 0;
    return true;
  }

  /** 返回被强制释放的旧 token；调用方用它关闭旧页面会话。 */
  forceRelease(): number | null {
    const token = this.owner;
    this.owner = null;
    this.startedAt = 0;
    return token;
  }
}
