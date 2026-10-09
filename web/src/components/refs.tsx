import { BookOpenCheck } from 'lucide-react'
import { type AIRefs, describeRefs } from '@/lib/format'
import { cn } from './ui'

export function RefsNote({ refs, className }: { refs?: AIRefs | null; className?: string }) {
  const text = describeRefs(refs)
  if (!text) return null
  return (
    <p className={cn('flex items-start gap-1.5 text-xs leading-5 text-mist-400', className)}>
      <BookOpenCheck className="mt-0.5 size-3.5 shrink-0" />
      <span>{text}</span>
    </p>
  )
}
