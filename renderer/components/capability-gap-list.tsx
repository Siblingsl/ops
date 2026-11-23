import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Lightbulb } from 'lucide-react'
import { toast } from 'sonner'
import { Badge, Button, Card, CardHeader, Empty } from '@/components/ui'
import { errorMessage, get, patch } from '@/lib/api'
import { relTime } from '@/lib/format'

export interface AgentCapabilityGap {
  id: string
  gap_key: string
  title: string
  detail: string
  request_count: number
  status: 'open' | 'planned' | 'declined'
  created_at: string
  updated_at: string
}

const statusMeta: Record<AgentCapabilityGap['status'], { label: string; tone: 'gamboge' | 'blue' | 'gray' }> = {
  open: { label: '待评估', tone: 'gamboge' },
  planned: { label: '已计划', tone: 'blue' },
  declined: { label: '不处理', tone: 'gray' },
}

// REF41 A3：能力缺口台账只对工作区所有者显示；智能体对话中的记录不生成写入卡片。
export function CapabilityGapList({ owner }: { owner: boolean }) {
  const qc = useQueryClient()
  const query = useQuery({
    queryKey: ['capability-gaps'],
    enabled: owner,
    queryFn: () => get<{ gaps: AgentCapabilityGap[] }>('/agent-capability-gaps'),
  })
  const save = useMutation({
    mutationFn: ({ id, status }: { id: string; status: AgentCapabilityGap['status'] }) =>
      patch<AgentCapabilityGap>(`/agent-capability-gaps/${id}`, { status }),
    onSuccess: (gap) => {
      qc.setQueryData<{ gaps: AgentCapabilityGap[] }>(['capability-gaps'], (old) => old
        ? { gaps: old.gaps.map((item) => item.id === gap.id ? gap : item) }
        : { gaps: [gap] })
      toast.success(`已标记为${statusMeta[gap.status].label}`)
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  if (!owner) return null
  const gaps = query.data?.gaps ?? []
  return (
    <Card data-testid="capability-gaps">
      <CardHeader
        title="能力缺口"
        desc="智能体遇到当前系统做不到的请求时记录在这里；只记录、不产生写入卡片。同一条缺口再次出现会累加次数。"
      />
      {query.isLoading ? <div className="px-5 py-6 text-[13px] text-mist-400">加载中…</div> : query.error ? (
        <div className="px-5 py-6 text-[13px] text-danger">
          加载失败：{errorMessage(query.error)}
          <Button className="ml-2" size="sm" variant="ghost" onClick={() => void query.refetch()}>重试</Button>
        </div>
      ) : gaps.length === 0 ? (
        <Empty icon={<Lightbulb className="size-5" />} title="还没有能力缺口"
          desc="当用户提出系统暂时做不到的需求时，智能体可以在这里记录场景、期望和替代做法。" />
      ) : (
        <div className="divide-y divide-mist-100">
          {gaps.map((gap) => <div key={gap.id} data-testid="capability-gap-row" className="flex items-start gap-4 px-5 py-4">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13.5px] font-medium text-mist-800">{gap.title}</span>
                <Badge tone={statusMeta[gap.status].tone}>{statusMeta[gap.status].label}</Badge>
                <span className="text-[11.5px] text-mist-400">请求 {gap.request_count} 次</span>
                <span className="text-[11.5px] text-mist-400">最近 {relTime(gap.updated_at)}</span>
              </div>
              {gap.detail && <p className="mt-1 whitespace-pre-line text-[12.5px] leading-relaxed text-mist-500">{gap.detail}</p>}
              <div className="mt-1 text-[11px] font-mono text-mist-300">{gap.gap_key}</div>
            </div>
            <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
              {gap.status !== 'planned' && <Button size="sm" variant="outline" disabled={save.isPending}
                onClick={() => save.mutate({ id: gap.id, status: 'planned' })}>标记为已计划</Button>}
              {gap.status !== 'declined' && <Button size="sm" variant="ghost" disabled={save.isPending}
                onClick={() => save.mutate({ id: gap.id, status: 'declined' })}>标记为不处理</Button>}
              {gap.status !== 'open' && <Button size="sm" variant="ghost" disabled={save.isPending}
                onClick={() => save.mutate({ id: gap.id, status: 'open' })}>重新打开</Button>}
            </div>
          </div>)}
        </div>
      )}
    </Card>
  )
}
