import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Card, CardHeader, Notice, PageHeader, PageState, Switch } from '@/components/ui'
import { errorMessage, get, put } from '@/lib/api'
import { useMe } from '@/lib/session'
import { useSettingsDraft } from '@/lib/desktop-settings'

interface AgentSettings {
  enabled: boolean
  viewer_enabled: boolean
  allow_model_pick: boolean
}

const options: { key: keyof AgentSettings; title: string; desc: string }[] = [
  { key: 'enabled', title: '启用智能体', desc: '允许工作区成员通过对话查询信息、提出操作卡片；写入仍需逐张确认执行。' },
  { key: 'viewer_enabled', title: '允许观察者使用', desc: '观察者只能查询信息，不能执行写入操作。' },
  { key: 'allow_model_pick', title: '允许成员自选模型', desc: '成员可选择已通过工具调用自检的模型；关闭后统一使用默认模型。' },
]

export default function Agent() {
  const { data: me } = useMe()
  const owner = me?.role === 'owner'
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['agent-settings'], queryFn: () => get<AgentSettings>('/agent/settings') })
  const save = useMutation({
    mutationFn: (patch: Partial<AgentSettings>) => put<AgentSettings>('/agent/settings', patch),
    onSuccess: (settings) => {
      qc.setQueryData(['agent-settings'], settings)
      void qc.invalidateQueries({ queryKey: ['agent-bootstrap'] })
      toast.success('智能体设置已保存')
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const settings = q.data
  useSettingsDraft(false, save.isPending)
  return (
    <div className="max-w-3xl animate-fade-in space-y-5">
      <PageHeader title="智能体设置" desc="影响当前工作区的所有成员，仅所有者可修改。" />
      {q.isLoading || !settings ? <PageState loading={q.isLoading} error={q.error ?? q.failureReason} retrying={q.isFetching} onRetry={() => void q.refetch()} emptyTitle="暂无智能体设置" /> : <>
        {!owner && <Notice tone="ink">当前为只读模式，请联系工作区所有者修改设置。</Notice>}
        <Card>
          <CardHeader title="使用权限" desc="对话仅本人可见，关闭智能体不会删除已有对话。" />
          <div className="divide-y divide-mist-100">
            {options.map((option) => <div key={option.key} className="flex items-start justify-between gap-6 px-5 py-3.5">
              <div>
                <div className="text-[13.5px] font-medium text-mist-800">{option.title}</div>
                <p className="mt-0.5 text-[12.5px] leading-relaxed text-mist-500">{option.desc}</p>
              </div>
              <Switch label={option.title} checked={settings[option.key]} disabled={!owner || save.isPending} onChange={(value) => save.mutate({ [option.key]: value })} />
            </div>)}
          </div>
        </Card>
      </>}
    </div>
  )
}
