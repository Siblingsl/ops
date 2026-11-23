import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { Badge, Button, Card, CardHeader, Empty, Notice, PageHeader, PageState } from '@/components/ui'
import { api, errorMessage, get } from '@/lib/api'
import { useMe } from '@/lib/session'

// REF41 F4（docs/41 §F4）：采集诊断页。失败 Top 10（平台/字段/次数/最近错误）、
// 配方草稿列表（draft/verified/active）与人工 verify/activate。
// 配方只作人工参考，不自动修改桌面适配器。

interface Diag { platform: string; field: string; count: number; last_seen: string; last_error: string }
interface Recipe { id: string; platform: string; field: string; recipe: { selector_candidates?: string[]; regex_candidates?: string[]; notes?: string }; status: string; verified_at: string | null }

function statusBadge(status: string) {
  if (status === 'draft') return <Badge>草稿</Badge>
  if (status === 'verified') return <Badge>已验证</Badge>
  if (status === 'active') return <Badge>已启用</Badge>
  return <Badge>已停用</Badge>
}

export default function ParserDiagnostics() {
  const me = useMe()
  const queryClient = useQueryClient()
  const diag = useQuery({ queryKey: ['parser-diagnostics', me.data?.workspace.id], queryFn: ({ signal }) => get<{ top_fields: Diag[]; recipes: Recipe[] }>('/parser-events/diagnostics', { signal }) })
  const [busyId, setBusyId] = useState('')
  const act = async (id: string, action: 'verify' | 'activate') => {
    setBusyId(id + action)
    try {
      await api('POST', `/parser-recipes/${id}/${action}`, action === 'verify' ? { notes: '人工确认' } : {})
      toast.success(action === 'verify' ? '已标记验证通过' : '已启用（仅作参考，不会自动改适配器）')
      await queryClient.invalidateQueries({ queryKey: ['parser-diagnostics'] })
    } catch (e) { toast.error(errorMessage(e)) } finally { setBusyId('') }
  }
  return (
    <div className="max-w-3xl animate-fade-in">
      <PageHeader title="采集诊断" desc="桌面采集失败样本统计与配方建议。配方由规则模板生成，必须人工验证后才可启用；启用也不会自动修改桌面采集适配器。" />
      {(diag.isPending || diag.error) && <PageState loading={diag.isPending} error={diag.error} onRetry={() => void diag.refetch()} />}
      <Card data-testid="parser-top-fields">
        <CardHeader title="失败 Top 字段（近 7 天）" />
        <div className="divide-y divide-mist-100">
          {diag.data?.top_fields.length === 0 && <Empty title="近 7 天没有失败样本" desc="桌面采集失败时会自动上报结构化样本。" />}
          {diag.data?.top_fields.map(d => <div key={d.platform + d.field} className="flex items-start gap-3 px-5 py-3 text-[13px]">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2"><span className="font-medium text-ink-800">{d.platform} · {d.field || '（未指定字段）'}</span><Badge>{d.count} 次</Badge></div>
              <p className="mt-0.5 text-mist-500">最近 {new Date(d.last_seen).toLocaleString()} · {d.last_error}</p>
            </div>
          </div>)}
        </div>
      </Card>
      <Card data-testid="parser-recipes" className="mt-4">
        <CardHeader title="配方建议" />
        <div className="space-y-3 px-5 pb-4 text-[13px]">
          {diag.data?.recipes.length === 0 && <Empty title="还没有配方建议" desc="同一平台字段 7 天失败 ≥3 次会自动生成草稿。" />}
          {diag.data?.recipes.map(r => <div key={r.id} data-testid={`parser-recipe-${r.id}`} className="rounded border border-mist-200 p-3">
            <div className="flex items-center gap-2"><span className="font-medium">{r.platform} · {r.field}</span>{statusBadge(r.status)}</div>
            <p className="mt-1 text-mist-500">{r.recipe.notes}</p>
            {(r.recipe.selector_candidates?.length ?? 0) > 0 && <ul className="mt-1 list-disc pl-5 text-mist-500">
              {r.recipe.selector_candidates!.map(s => <li key={s}>{s}</li>)}
            </ul>}
            <Notice>配方仅作人工参考；启用前需在测试账号跑通一次。</Notice>
            {r.status === 'draft' && <Button size="sm" variant="ghost" loading={busyId === r.id + 'verify'} data-testid={`parser-verify-${r.id}`} onClick={() => void act(r.id, 'verify')}>标记验证通过</Button>}
            {r.status === 'verified' && <Button size="sm" variant="ghost" loading={busyId === r.id + 'activate'} data-testid={`parser-activate-${r.id}`} onClick={() => void act(r.id, 'activate')}>启用</Button>}
          </div>)}
        </div>
      </Card>
    </div>
  )
}
