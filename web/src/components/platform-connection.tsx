import { ShieldCheck } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { del, errorMessage, get, patch, post, put } from '@/lib/api'
import { fmtTime } from '@/lib/format'
import type { PlatformAvailability, PlatformConnection, PlatformObservation, WorkspaceRole } from '@/lib/types'
import { useMe } from '@/lib/session'
import { Badge, Button, Card, CardHeader, Field, roleReadOnlyHint, Switch } from './ui'

const availabilityLabel: Record<PlatformAvailability, string> = {
  ready: '可用',
  verifying: '验证中',
  unknown: '状态未知',
  login_required: '需要重新登录',
  challenge_required: '平台要求验证',
  restricted: '账号受限',
  identity_mismatch: '账号身份不符',
  degraded: '网络受限',
  unsupported: '浏览器不支持',
}

const qualityLabel: Record<PlatformObservation['quality_state'], string> = {
  valid: '已校验',
  needs_confirmation: '待确认',
  rejected: '已拒绝',
  superseded: '已被替代',
}

const unitLabel: Record<string, string> = { users: '人数', times: '次数', count: '计数', unknown: '口径不明' }

function autoAdoptDisabledReason() {
  return '待每平台 10 篇以上逐字段正式验收完成后开放'
}

export function PlatformConnectionCard({ accountId, platform, canManage, role = 'viewer', adminOverride = false, accountStatus = 'active' }: {
  accountId: string
  platform: string
  canManage: boolean
  role?: WorkspaceRole
  adminOverride?: boolean
  accountStatus?: 'active' | 'disabled'
  actionsTarget?: HTMLElement | null
}) {
  const { data: me } = useMe()
  const policyQuery = useQuery({
    queryKey: ['platform-collection-policy', me?.workspace.id ?? ''],
    queryFn: () => get<{ global_enabled: boolean; policy: { enabled: boolean; allow_member_connections: boolean; authorization_revision: number } }>('/platform-collection/policy'),
    enabled: platform !== 'toutiao' && !!me?.workspace.id,
    staleTime: 60_000,
    retry: false,
  })
  const [connection, setConnection] = useState<PlatformConnection | null>(null)
  const [observations, setObservations] = useState<PlatformObservation[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [loadError, setLoadError] = useState('')
  const [observationError, setObservationError] = useState('')
  const generation = useRef(0)
  const controller = useRef<AbortController | null>(null)

  const load = useCallback(async () => {
    const currentGeneration = ++generation.current
    controller.current?.abort()
    const requestController = new AbortController()
    controller.current = requestController
    setLoading(true)
    setLoadError('')
    setObservationError('')
    setConnection(null)
    setObservations([])
    if (platform === 'toutiao') {
      setLoading(false)
      return
    }
    try {
      const result = await get<{ connection: PlatformConnection | null }>(`/accounts/${accountId}/platform-connection`, { signal: requestController.signal })
      if (currentGeneration !== generation.current) return
      setConnection(result.connection)
      if (!result.connection) return
      try {
        const response = await get<{ observations: PlatformObservation[] }>(`/accounts/${accountId}/metrics/observations`, { signal: requestController.signal })
        if (currentGeneration === generation.current) setObservations(response.observations ?? [])
      } catch (error) {
        if (currentGeneration !== generation.current || requestController.signal.aborted) return
        setObservationError(errorMessage(error))
      }
    } catch (error) {
      if (currentGeneration !== generation.current || requestController.signal.aborted) return
      setLoadError(errorMessage(error))
    } finally {
      if (currentGeneration === generation.current) setLoading(false)
    }
  }, [accountId, platform])

  useEffect(() => {
    void load()
    return () => { generation.current++; controller.current?.abort() }
  }, [load])

  const saveWorkspacePolicy = async (enabled: boolean) => {
    const policy = policyQuery.data?.policy
    if (!policy || busy) return
    setBusy('workspace-policy')
    try {
      await put('/platform-collection/policy', {
        enabled,
        allow_member_connections: policy.allow_member_connections,
        authorization_revision: policy.authorization_revision,
      })
      toast.success(enabled ? '已启用本工作区的平台数据读取' : '已关闭本工作区的平台数据读取')
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      await policyQuery.refetch()
      setBusy('')
    }
  }

  const patchConnection = async (body: Record<string, unknown>, label: string) => {
    if (!connection) return
    setBusy(label)
    try {
      setConnection(await patch<PlatformConnection>(`/accounts/${accountId}/platform-connection`, body))
      toast.success(`${label}已保存`)
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setBusy('')
    }
  }

  const revoke = async () => {
    setBusy('revoke')
    try {
      await del(`/accounts/${accountId}/platform-connection`)
      toast.success('连接已撤销')
      await load()
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setBusy('')
    }
  }

  const confirmOne = async (observationId: string) => {
    setBusy(observationId)
    try {
      await post(`/metrics/observations/${observationId}/confirm`, {})
      toast.success('已确认这一条观测')
      await load()
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setBusy('')
    }
  }

  const canConfirmObservations = !adminOverride && role !== 'viewer'
  const policyReady = !!policyQuery.data?.global_enabled && !!policyQuery.data.policy.enabled
  const policy = !adminOverride && canManage && platform !== 'toutiao' && policyQuery.data && (
    <Field label="工作区平台数据读取" hint="关闭后本工作区不能登录平台账号或发起新的读取" plain>
      <Switch label="启用本工作区平台数据读取" checked={policyQuery.data.policy.enabled} disabled={busy !== ''}
        onChange={(enabled) => void saveWorkspacePolicy(enabled)} />
    </Field>
  )

  if (loading) return <Card className="p-5 text-[13px] text-mist-400">正在读取平台连接…</Card>
  if (loadError) return <Card role="alert" className="space-y-3 p-5">
    <div className="font-semibold text-mist-900">平台连接状态读取失败</div>
    <p className="text-[13px] text-mist-600">{loadError}</p>
    <Button size="sm" variant="secondary" onClick={() => void load()}>重试</Button>
  </Card>

  return <Card>
    <CardHeader title="平台登录与同步" desc="平台登录和本机数据读取需要在 OPS 桌面客户端发起。" action={connection && (canManage || connection.is_holder) ? (
      <Button size="sm" variant="danger" disabled={busy !== ''} onClick={() => void revoke()}>撤销连接</Button>
    ) : undefined} />
    <div className="space-y-4 p-5">
      {platform === 'toutiao' ? <p className="text-[13px] text-mist-600">头条平台登录与数据读取请在 OPS 桌面客户端进行。</p> : !connection ? <div className="space-y-2">
        <p className="text-[13px] text-mist-600">尚未连接。请在 OPS 桌面客户端登录并核对平台身份；登录不会自动同步历史作品。</p>
        <p className="text-[12px] text-mist-500">服务端不会代你登录，也不会保存平台 Cookie 或密码。</p>
        {policy}
        {policyQuery.isLoading && <p className="text-[12px] text-mist-500">正在核实工作区平台连接权限…</p>}
        {policyQuery.isError && <p role="alert" className="text-[12px] text-danger">无法核实工作区平台连接策略，请重试后再登录。</p>}
        {policyQuery.data && !policyReady && <p className="text-[12px] text-mist-500">工作区平台数据连接未启用；仍可使用人工数据回填。</p>}
      </div> : <>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="平台账号" plain>
            <div className="flex flex-wrap items-center gap-2 text-[13px] text-mist-700">
              <Badge tone="ink">{connection.external_account_key}</Badge>
              <Badge tone={connection.availability === 'ready' ? 'ink' : connection.availability === 'restricted' || connection.availability === 'identity_mismatch' ? 'red' : 'gamboge'}>{availabilityLabel[connection.availability]}</Badge>
            </div>
          </Field>
          <Field label="最近验证" plain><div className="text-[13px] text-mist-600">{connection.last_verified_at ? fmtTime(connection.last_verified_at) : '尚未验证'}</div></Field>
          <Field label="数据读取同意" plain>
            <div className="text-[13px] text-mist-600"><span className="inline-flex items-center gap-1"><ShieldCheck className="size-3.5" />已同意第 {connection.platform_consent_version} 版说明</span>{connection.consented_at && <span className="ml-2 text-mist-400">{fmtTime(connection.consented_at)}</span>}</div>
          </Field>
          <Field label="自动采集" hint="关闭后不再领取新任务；已领任务按取消处理">
            <Switch label={connection.auto_collect ? '已开启' : '已关闭'} checked={connection.auto_collect} disabled={!canManage || busy !== '' || accountStatus !== 'active'}
              title={!canManage ? roleReadOnlyHint.writer : accountStatus !== 'active' ? '账号未启用，暂不能自动采集' : undefined}
              onChange={(enabled) => void patchConnection({ auto_collect: enabled, authorization_revision: connection.authorization_revision }, '自动采集')} />
          </Field>
          <Field label="自动采用（写入正式指标）" hint={autoAdoptDisabledReason()}>
            <Switch label={connection.auto_adopt ? '已开启' : '未开启'} checked={connection.auto_adopt} disabled title={autoAdoptDisabledReason()} onChange={() => undefined} />
          </Field>
          {policy}
        </div>
        <div className="border-t border-line/60 pt-4">
          <div className="mb-2 text-[13px] font-semibold text-mist-700">最近观测</div>
          {observations.length === 0 ? <p className="text-[13px] text-mist-400">还没有观测记录。采集到数据后会显示在这里，需要你逐条确认才写入正式指标。</p> : <ul className="space-y-2">
            {observations.slice(0, 8).map((observation) => <li key={observation.id} className="flex flex-wrap items-center gap-2 text-[13px] text-mist-600">
              <Badge tone={observation.quality_state === 'valid' ? 'ink' : observation.quality_state === 'rejected' ? 'red' : 'gamboge'}>{qualityLabel[observation.quality_state]}</Badge>
              <span className="text-mist-500">{observation.external_id ?? '账号级'}</span>
              <span className="text-mist-400">{fmtTime(observation.as_of_at ?? observation.observed_at)}</span>
              <span className="text-mist-400">{Object.entries(observation.values).map(([key, value]) => `${key}=${value.value}（${unitLabel[value.unit] ?? value.unit}）`).join('，')}</span>
              {observation.quality_state === 'needs_confirmation' && canConfirmObservations && <Button size="sm" variant="ghost" disabled={busy === observation.id} onClick={() => void confirmOne(observation.id)}>确认这一条</Button>}
            </li>)}
          </ul>}
          {observationError && <div role="alert" className="mt-2 flex flex-wrap items-center gap-2 text-[12.5px] text-danger"><span>观测记录读取失败：{observationError}</span><Button size="sm" variant="ghost" disabled={busy !== ''} onClick={() => void load()}>重试</Button></div>}
          <p className="mt-3 text-[12.5px] text-mist-400">单位“口径不明”的字段在平台确认是人数还是次数之前只存观测，不计入正式统计。</p>
        </div>
      </>}
    </div>
  </Card>
}
