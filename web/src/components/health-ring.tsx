import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Card, cn } from './ui'
import { get } from '@/lib/api'
import type { HealthItem } from '@/lib/types'

export function HealthRing({ accountId }: { accountId: string }) {
  const { data } = useQuery({ queryKey: ['health', accountId], queryFn: () => get<{ score: number; items: HealthItem[] }>(`/accounts/${accountId}/health`), staleTime: 30_000 })
  if (!data) return null
  const r = 26
  const c = 2 * Math.PI * r
  const lacking = data.items.filter((it) => it.score < it.max)
  return (
    <Card className="mb-5 flex flex-wrap items-center gap-5 p-4">
      <div className="relative size-16 shrink-0">
        <svg viewBox="0 0 64 64" className="size-16 -rotate-90">
          <circle cx="32" cy="32" r={r} fill="none" strokeWidth="6" className="stroke-mist-100" />
          <circle cx="32" cy="32" r={r} fill="none" strokeWidth="6" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - data.score / 100)}
            className={cn('transition-all duration-500', data.score >= 80 ? 'stroke-success' : 'stroke-ink-500')} />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center font-display text-[17px] font-bold tabular-nums text-mist-900">{data.score}</span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-semibold text-mist-800">账号健康度</div>
        <p className="text-[12px] text-mist-500">{lacking.length === 0 ? 'AI 已经掌握了这个账号的全部基础信息。' : 'AI 对这个账号的了解程度，补齐下面几项会让生成更贴合。'}</p>
        {lacking.length > 0 && (
          <ul className="mt-2 flex flex-wrap gap-2">
            {lacking.map((it) => (
              <li key={it.key} className="flex items-center gap-2 rounded-lg border border-mist-200 px-2.5 py-1 text-[12px]" title={it.hint}>
                <span className="text-mist-700">{it.label}</span>
                <span className="tabular-nums text-mist-400">{it.score}/{it.max}</span>
                <Link to={it.link} className="font-medium text-ink-700 hover:underline">去补充</Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  )
}
