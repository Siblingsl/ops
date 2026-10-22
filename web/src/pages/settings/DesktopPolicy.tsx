import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button, Card, CardHeader, Notice, PageState, Switch } from '@/components/ui'
import { errorMessage, get, put } from '@/lib/api'
import { useSettingsDraft } from '@/lib/desktop-settings'
import { useMe } from '@/lib/session'

interface DesktopPolicyState {
  global_enabled: boolean
  policy: {
    workspace_id: string
    enabled: boolean
    allow_member_endpoints: boolean
    authorization_revision: number
  }
}

export default function DesktopPolicy() {
  const { data: me } = useMe()
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: ['desktop-policy', me?.workspace.id ?? ''],
    queryFn: () => get<DesktopPolicyState>('/desktop/policy'),
    enabled: !!me?.workspace.id,
  })
  const [draft, setDraft] = useState<{ enabled: boolean; allow_member_endpoints: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (query.data) setDraft({
      enabled: query.data.policy.enabled,
      allow_member_endpoints: query.data.policy.allow_member_endpoints,
    })
  }, [query.data])

  const owner = me?.role === 'owner' && !me.admin_override
  const dirty = !!draft && !!query.data && (
    draft.enabled !== query.data.policy.enabled
    || draft.allow_member_endpoints !== query.data.policy.allow_member_endpoints
  )
  useSettingsDraft(dirty, busy)

  const save = async () => {
    if (!draft) return
    setBusy(true)
    try {
      await put('/desktop/policy', draft)
      await queryClient.invalidateQueries({ queryKey: ['desktop-policy'] })
      toast.success('桌面 AI 策略已保存')
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  if (query.isPending || !query.data || !draft) {
    return <PageState loading={query.isPending} error={query.error} retrying={query.isFetching} onRetry={() => void query.refetch()} />
  }

  return <div className="space-y-5">
    <p className="text-sm text-mist-500">控制当前工作区是否允许使用成员本人设备上的桌面 AI。服务端仍会逐次检查身份、角色与设备授权。</p>
    {me?.admin_override && <Notice tone="ink">系统管理员代入工作区时不能读取或修改桌面 AI 策略。</Notice>}
    {!owner && !me?.admin_override && <Notice tone="ink">当前为只读模式，只有工作区所有者可以修改策略。</Notice>}
    {!query.data.global_enabled && <Notice tone="ink">服务端尚未全局启用桌面 AI；工作区开关当前不会生效。</Notice>}
    <Card>
      <CardHeader title="工作区桌面 AI 策略" desc={`授权版本 ${query.data.policy.authorization_revision}`} />
      <div className="space-y-4 p-5">
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm font-medium text-mist-800">允许此工作区使用桌面 AI</span>
            <Switch label="允许此工作区使用桌面 AI" checked={draft.enabled} disabled={!owner || !query.data.global_enabled || busy} onChange={(enabled) => setDraft({ ...draft, enabled, allow_member_endpoints: enabled && draft.allow_member_endpoints })} />
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm font-medium text-mist-800">允许 editor 使用各自的桌面 AI 端点</span>
            <Switch label="允许 editor 使用各自的桌面 AI 端点" checked={draft.allow_member_endpoints} disabled={!owner || !query.data.global_enabled || !draft.enabled || busy} onChange={(allow_member_endpoints) => setDraft({ ...draft, allow_member_endpoints })} />
          </div>
        <p className="text-xs leading-relaxed text-mist-500">允许成员端点后，业务上下文可能发送到成员本人配置的 AI 服务；回环地址也不代表数据不会离开本机。保存操作按服务端要求重新认证。</p>
        {owner && <Button variant="primary" loading={busy} disabled={!dirty || !query.data.global_enabled} onClick={() => void save()}>保存工作区策略</Button>}
      </div>
    </Card>
  </div>
}
