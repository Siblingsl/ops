import { createContext, useCallback, useContext, useEffect, useRef } from 'react'
import { runFlushers } from './work-save-queue'

// NW-C4：跨步骤动作前按顺序保存每个字段，避免同一作品的 revision 更新互相冲突。
export type Flush = () => Promise<void> | void

export interface WorkSaveCoordinator {
  register: (key: string, flush: Flush) => () => void
  flushAll: () => Promise<void>
}

const fallback: WorkSaveCoordinator = { register: () => () => {}, flushAll: async () => {} }

const WorkSaveContext = createContext<WorkSaveCoordinator>(fallback)

export function useSaveCoordinator(): WorkSaveCoordinator {
  const flushers = useRef(new Map<string, Flush>())
  const inFlight = useRef<Promise<void> | null>(null)
  const register = useCallback((key: string, flush: Flush) => {
    flushers.current.set(key, flush)
    return () => {
      if (flushers.current.get(key) === flush) flushers.current.delete(key)
    }
  }, [])
  const flushAll = useCallback(async () => {
    while (inFlight.current) await inFlight.current
    const run = runFlushers([...flushers.current.values()])
    inFlight.current = run
    try {
      await run
    } finally {
      if (inFlight.current === run) inFlight.current = null
    }
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

// NW-C4：复制/导出及离开作品前，父级按作品 id 等待所有已登记的缓冲保存。
const registry = new Map<string, Set<() => Promise<void>>>()
const workFlushInFlight = new Map<string, Promise<void>>()

export function registerWorkFlush(workId: string, flush: () => Promise<void>) {
  let flushers = registry.get(workId)
  if (!flushers) {
    flushers = new Set()
    registry.set(workId, flushers)
  }
  flushers.add(flush)
  return () => {
    flushers?.delete(flush)
    if (flushers?.size === 0) registry.delete(workId)
  }
}

/** flushWork waits for every registered field buffer of this work to be saved. */
export async function flushWork(workId: string): Promise<void> {
  while (workFlushInFlight.has(workId)) await workFlushInFlight.get(workId)
  const run = runFlushers([...(registry.get(workId) ?? [])])
  workFlushInFlight.set(workId, run)
  try {
    await run
  } finally {
    if (workFlushInFlight.get(workId) === run) workFlushInFlight.delete(workId)
  }
}
