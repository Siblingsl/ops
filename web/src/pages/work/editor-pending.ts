import { useMemo, useRef } from 'react'
import type { Section } from '@/lib/types'
import { findPending } from './editor-tools'

export function usePendingSections(sections: Section[]) {
  const cache = useRef(new Map<string, { text: string; marks: ReturnType<typeof findPending> }>())
  return useMemo(() => {
    const next = new Map<string, { text: string; marks: ReturnType<typeof findPending> }>()
    const result = sections.flatMap(s => {
      const prev = cache.current.get(s.id)
      const value = prev?.text === s.content_md ? prev : { text: s.content_md, marks: findPending(s.content_md) }
      next.set(s.id, value)
      return value.marks.map(p => ({ s, p }))
    })
    cache.current = next
    return result
  }, [sections])
}
