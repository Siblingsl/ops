export interface SectionSnapshot {
  heading: string
  content_md: string
  applied?: { kind: string; ai_call_id?: string | null; source_revisions?: Record<string, number> }
}

export function createSectionSaveQueue(send: (snapshot: SectionSnapshot) => Promise<boolean>) {
  type Batch = { snapshot: SectionSnapshot; waiters: ((saved: boolean) => void)[] }
  let pending: Batch | null = null
  let running: Promise<boolean> | null = null
  const rejectPending = () => {
    if (pending) for (const resolve of pending.waiters) resolve(false)
    pending = null
  }

  const drain = async () => {
    let saved = true
    while (pending) {
      const batch = pending
      pending = null
      try { saved = await send(batch.snapshot) } catch { saved = false }
      for (const resolve of batch.waiters) resolve(saved)
      if (!saved) {
        rejectPending()
        break
      }
    }
    return saved
  }
  const start = () => {
    if (running) return
    running = Promise.resolve().then(drain).finally(() => {
      running = null
      if (pending) start()
    })
  }

  return {
    enqueue(snapshot: SectionSnapshot): Promise<boolean> {
      const result = new Promise<boolean>((resolve) => {
        if (pending) {
          pending.snapshot = { ...pending.snapshot, ...snapshot }
          pending.waiters.push(resolve)
        } else pending = { snapshot, waiters: [resolve] }
      })
      start()
      return result
    },
    async flush() {
      while (running) if (!(await running)) return false
      return true
    },
    get busy() { return running !== null || pending !== null },
  }
}
