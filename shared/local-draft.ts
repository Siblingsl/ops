// 段落本地优先暂存（EX-N-04）：先写 IndexedDB，保存成功后清除；不可用时退回 localStorage。

export interface LocalDraft { content: string; heading?: string; revision: number; at: number }

const DB = 'ops-local'
const STORE = 'section-drafts'
const legacyKey = (id: string) => `ops.unsaved.${id}`

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDB(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null)
    try {
      const req = indexedDB.open(DB, 1)
      req.onupgradeneeded = () => req.result.createObjectStore(STORE)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbPromise
}

function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  return openDB().then((db) => new Promise<T | undefined>((resolve) => {
    if (!db) return resolve(undefined)
    try {
      const req = run(db.transaction(STORE, mode).objectStore(STORE))
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(undefined)
    } catch {
      resolve(undefined)
    }
  }))
}

export async function readDraft(sectionId: string): Promise<LocalDraft | null> {
  const legacy = localStorage.getItem(legacyKey(sectionId))
  if (legacy) {
    try {
      const d = { at: Date.now(), ...(JSON.parse(legacy) as Omit<LocalDraft, 'at'>) }
      // 迁移到 IndexedDB 后删掉 localStorage 副本；IDB 不可用时保留副本，下次还能读到。
      const db = await openDB()
      if (db) {
        await tx('readwrite', (s) => s.put(d, sectionId))
        localStorage.removeItem(legacyKey(sectionId))
      }
      return d
    } catch {
      localStorage.removeItem(legacyKey(sectionId))
    }
  }
  const db = await openDB()
  if (!db) return null
  return (await tx<LocalDraft>('readonly', (s) => s.get(sectionId))) ?? null
}

export async function writeDraft(sectionId: string, d: LocalDraft): Promise<void> {
  // 先同步写一份到 localStorage：切页/关窗口时 IndexedDB 事务可能来不及提交，
  // 而 localStorage 是同步 API，卸载过程中也会写完。大段正文跳过，避免占满 5MB 配额。
  try {
    if (d.content.length < 200_000) localStorage.setItem(legacyKey(sectionId), JSON.stringify(d))
  } catch {
    // 配额满或被禁用时忽略，IndexedDB 仍会尝试写入。
  }
  const db = await openDB()
  if (!db) return
  await tx('readwrite', (s) => s.put(d, sectionId))
}

export async function clearDraft(sectionId: string): Promise<void> {
  localStorage.removeItem(legacyKey(sectionId))
  await tx('readwrite', (s) => s.delete(sectionId))
}

let chain: Promise<unknown> = Promise.resolve()

/** enqueueSync runs offline retries one after another, in the order the edits were queued. */
export function enqueueSync(run: () => Promise<unknown>): Promise<unknown> {
  chain = chain.then(run, run).catch(() => undefined)
  return chain
}
