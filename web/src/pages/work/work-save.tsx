import { createContext, useCallback, useContext, useEffect, useRef } from 'react'

// NW-C4：跨步骤动作（生成大纲、去检查、保存版本）前，先把各步骤的本地缓冲落库。
// 每个字段组件把自己的一次"立即保存"注册进来；协调器只负责等待，不合并请求语义。
export type Flush = () => Promise<void> | void

export interface WorkSaveCoordinator {
  register: (key: string, flush: Flush) => () => void
  flushAll: () => Promise<void>
}

const fallback: WorkSaveCoordinator = { register: () => () => {}, flushAll: async () => {} }

const WorkSaveContext = createContext<WorkSaveCoordinator>(fallback)

export function useSaveCoordinator(): WorkSaveCoordinator {
  const flushers = useRef(new Map<string, Flush>())
  const register = useCallback((key: string, flush: Flush) => {
    flushers.current.set(key, flush)
    return () => {
      if (flushers.current.get(key) === flush) flushers.current.delete(key)
    }
  }, [])
  const flushAll = useCallback(async () => {
    const list = [...flushers.current.values()]
    if (list.length === 0) return
    const results = await Promise.allSettled(list.map(async (flush) => flush()))
    const failed = results.find((r) => r.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  }, [])
  return { register, flushAll }
}

export const WorkSaveProvider = WorkSaveContext.Provider

export function useRegisterFlush(key: string, flush: Flush) {
  const coordinator = useContext(WorkSaveContext)
  useEffect(() => coordinator.register(key, flush), [coordinator, key, flush])
}

export function useFlushAll() {
  return useContext(WorkSaveContext).flushAll
}

// NW-C4：复制/导出发生在 WorkLayout（编辑器的父级），拿不到编辑器的 context。
// 编辑器把自己的 flushAll 登记到模块级注册表，父级按作品 id 调用。
const registry = new Map<string, () => Promise<void>>()

export function registerWorkFlush(workId: string, flush: () => Promise<void>) {
  registry.set(workId, flush)
  return () => {
    if (registry.get(workId) === flush) registry.delete(workId)
  }
}

/** flushWork waits for every registered field buffer of this work to be saved. */
export async function flushWork(workId: string): Promise<void> {
  const flush = registry.get(workId)
  if (flush) await flush()
}
