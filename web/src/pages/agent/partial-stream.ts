/**
 * AG-04：运行中离开页面会丢流式输出。
 *
 * 服务端只在整轮结束时才把助手消息落库，中途断流的内容没有可回放的事件，
 * 所以客户端在本地留一份"正在生成"的草稿：断线/切页回来后先显示已生成的部分，
 * 并说明「本轮仍在服务端继续，结果完成后会补上」。
 *
 * 草稿只写 sessionStorage（关闭标签页即失效），不写 localStorage、不写查询缓存，
 * 避免把可能含敏感内容的半成品长期留在磁盘上。
 */

export interface PartialStream {
  conversationId: string
  runId: string
  text: string
  stage: string
  updatedAt: number
}

const PREFIX = 'ops:agent:partial:'
/** 超过这个时长的草稿视为过期：服务端单轮最长 5 分钟，留足余量。 */
export const PARTIAL_TTL_MS = 30 * 60 * 1000
/** 太短的片段没有恢复价值，反而会在气泡里闪一下。 */
export const PARTIAL_MIN_CHARS = 1

function key(conversationId: string) {
  return `${PREFIX}${conversationId}`
}

function storage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

export function savePartial(store: Storage | null, value: PartialStream): void {
  if (!store || !value.conversationId) return
  if (Array.from(value.text).length < PARTIAL_MIN_CHARS) {
    clearPartial(store, value.conversationId)
    return
  }
  try {
    store.setItem(key(value.conversationId), JSON.stringify(value))
  } catch {
    // 隐私模式或配额满时静默降级：恢复能力是增强，不能影响正常发送。
  }
}

export function readPartial(store: Storage | null, conversationId: string, now = Date.now()): PartialStream | null {
  if (!store || !conversationId) return null
  let raw: string | null = null
  try {
    raw = store.getItem(key(conversationId))
  } catch {
    return null
  }
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    clearPartial(store, conversationId)
    return null
  }
  const value = parsed as Partial<PartialStream>
  if (typeof value?.text !== 'string' || typeof value.runId !== 'string' || typeof value.updatedAt !== 'number') {
    clearPartial(store, conversationId)
    return null
  }
  if (Array.from(value.text).length < PARTIAL_MIN_CHARS || now - value.updatedAt > PARTIAL_TTL_MS) {
    clearPartial(store, conversationId)
    return null
  }
  return {
    conversationId,
    runId: value.runId,
    text: value.text,
    stage: typeof value.stage === 'string' ? value.stage : '',
    updatedAt: value.updatedAt,
  }
}

export function clearPartial(store: Storage | null, conversationId: string): void {
  if (!store || !conversationId) return
  try {
    store.removeItem(key(conversationId))
  } catch {
    // 同上：清理失败不影响主流程。
  }
}

/** 供页面直接使用的默认实例。 */
export function browserStore(): Storage | null {
  return storage()
}
