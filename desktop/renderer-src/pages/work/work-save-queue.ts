export type Flush = () => Promise<void> | void

/** Runs registered saves in order so revision based writes cannot race. */
export async function runFlushers(flushers: Iterable<Flush>): Promise<void> {
  for (const flush of flushers) await flush()
}
