import { useQuery } from '@tanstack/react-query'
import { Star } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/components/ui'
import { del, errorMessage, get, post } from '@/lib/api'
import type { StarItem } from '@/lib/types'

export function useStars() {
  return useQuery({ queryKey: ['stars'], queryFn: () => get<StarItem[]>('/stars'), staleTime: 60_000 })
}

/** StarButton toggles a personal star (EX-M-04); starred items rank first in the command palette. */
export function StarButton({ type, id, className }: { type: 'work' | 'topic' | 'material'; id: string; className?: string }) {
  const stars = useStars()
  const on = (stars.data ?? []).some((s) => s.object_type === type && s.object_id === id)
  const toggle = async (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    try {
      if (on) await del(`/stars/${type}/${id}`)
      else await post('/stars', { object_type: type, object_id: id })
      void stars.refetch()
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }
  return (
    <button type="button" onClick={toggle} title={on ? '取消收藏' : '收藏'} aria-pressed={on}
      className={cn('inline-flex shrink-0 cursor-pointer items-center justify-center rounded p-1 transition', on ? 'text-gamboge-500' : 'text-mist-300 hover:text-gamboge-500', className)}>
      <Star className="size-3.5" fill={on ? 'currentColor' : 'none'} />
    </button>
  )
}
