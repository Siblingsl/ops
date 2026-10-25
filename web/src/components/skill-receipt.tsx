import { useQuery } from '@tanstack/react-query'
import { ApiError, get } from '@/lib/api'
import { skillReasonText, skillScopeLabel } from '@/lib/skills'
import { useMe } from '@/lib/session'
import { Badge, PageState } from './ui'

export default function SkillReceipt({ callId }: { callId: string }) {
  const me = useMe()
  const query = useQuery({
    queryKey: ['skill-receipt', me.data?.user_id, me.data?.workspace.id, callId],
    queryFn: ({ signal }) => get<{ items: { id: string; name: string; scope: string; revision: number; used: boolean; chars: number; reason?: string | null }[]; personal_used_count: number; assembled_chars: number | null; budget: number }>(`/ai-calls/${callId}/skill-context`, { signal }),
    retry: false,
  })
  if (query.error instanceof ApiError && query.error.status === 404) return <p role="status">使用记录已清理</p>
  if (!query.data || query.error) return <PageState loading={query.isPending} error={query.error} onRetry={() => void query.refetch()} />
  const receipt = query.data
  if (!receipt.items.length && !receipt.personal_used_count) return null
  return <div aria-label="技能使用回执" className="space-y-1">
    <p className="font-medium">写作技能 · 本次已使用 {receipt.assembled_chars ?? 0} 字 / {receipt.budget}</p>
    {receipt.items.map(item => <div key={item.id} className="flex flex-wrap gap-1.5">
      <span>{item.name}</span><Badge>{skillScopeLabel(item.scope)}</Badge><span>v{item.revision}</span>
      <span>{item.used ? `${item.chars} 字` : skillReasonText(item.reason) || '未使用'}</span>
    </div>)}
    {receipt.personal_used_count > 0 && <p>其中个人技能 {receipt.personal_used_count} 条；他人的个人技能仅显示匿名数量。</p>}
  </div>
}
