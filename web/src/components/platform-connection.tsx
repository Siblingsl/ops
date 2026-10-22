import { AlertTriangle, BarChart3, Clock, ExternalLink, RefreshCw, ShieldCheck, Wifi, WifiOff } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { del, errorMessage, get, patch, post } from '@/lib/api'
import { fmtTime } from '@/lib/format'
import type { PlatformAccountSnapshot, PlatformAvailability, PlatformConnection, PlatformObservation, PlatformSyncOperation, WorkspaceRole } from '@/lib/types'
import { useMe } from '@/lib/session'
import { DESKTOP_LOCAL_SETTINGS_REQUEST, useSettingsDraft } from '@/lib/desktop-settings'
import { Badge, Button, Card, CardHeader, cn, Field, MoreMenu, platformLabel } from './ui'

// 平台数据连接（D-129 / 20 文档 §14）。页面只展示服务端返回的真实状态：
// 不推断“已同步”，不把未知显示成 0，也不提供任何批量操作入口。

const availabilityLabel: Record<PlatformAvailability, { text: string; tone: 'ink' | 'gamboge' | 'red' }> = {
  ready: { text: '可用', tone: 'ink' },
  verifying: { text: '验证中', tone: 'ink' },
  unknown: { text: '状态未知', tone: 'ink' },
  login_required: { text: '需要重新登录', tone: 'gamboge' },
  challenge_required: { text: '平台要求验证', tone: 'gamboge' },
  restricted: { text: '账号受限', tone: 'red' },
  identity_mismatch: { text: '账号身份不符', tone: 'red' },
  degraded: { text: '网络受限', tone: 'gamboge' },
  unsupported: { text: '浏览器不支持', tone: 'red' },
}

const unitLabel: Record<string, string> = {
  users: '人数',
  times: '次数',
  count: '计数',
  unknown: '口径不明',
}

const qualityLabel: Record<PlatformObservation['quality_state'], string> = {
  valid: '已校验',
  needs_confirmation: '待确认',
  rejected: '已拒绝',
  superseded: '已被替代',
}

/** 在线判定：服务端 presence TTL 90 秒，这里只按 last_seen_at 如实显示，不猜测。 */
export function presenceState(connection: PlatformConnection, now: number): 'online' | 'offline' | 'unknown' {
  if (!connection.last_seen_at) return 'unknown'
  const seen = Date.parse(connection.last_seen_at)
  if (Number.isNaN(seen)) return 'unknown'
  return now - seen <= 90_000 ? 'online' : 'offline'
}

/** 自动采用在正式验收完成前不可开启（D-129）：界面显示开关但禁用并说明原因。 */
export function autoAdoptDisabledReason(): string {
  return '待每平台 10 篇以上逐字段正式验收完成后开放'
}

export function PlatformConnectionCard({ accountId, platform, canManage, role = 'viewer', adminOverride = false, accountStatus = 'active', actionsTarget }: {
  accountId: string
  platform: string
  canManage: boolean
  role?: WorkspaceRole
  adminOverride?: boolean
  accountStatus?: 'active' | 'disabled'
  actionsTarget?: HTMLElement | null
}) {
  const desktopPresentation = document.documentElement.dataset.presentation === 'ops-creative-desktop'
  const { data: me } = useMe()
  const policyQuery = useQuery({
    queryKey: ['platform-collection-policy', me?.workspace.id ?? ''],
    queryFn: () => get<{ global_enabled: boolean; account_sync_platforms?: string[]; metrics_refresh_platforms?: string[]; policy: { enabled: boolean; allow_member_connections: boolean } }>('/platform-collection/policy'),
    enabled: desktopPresentation && platform !== 'toutiao' && !!me?.workspace.id,
    staleTime: 60_000,
    retry: false,
  })
  const [connection, setConnection] = useState<PlatformConnection | null>(null)
  const [observations, setObservations] = useState<PlatformObservation[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [connectionError, setConnectionError] = useState('')
  const [observationError, setObservationError] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const generation = useRef(0)
  const controller = useRef<AbortController | null>(null)
  useSettingsDraft(false, busy !== '')

  const operationsQuery = useQuery({
    queryKey: ['platform-sync-operations', accountId],
    queryFn: () => get<{ items: PlatformSyncOperation[] }>(`/accounts/${accountId}/platform-sync-operations?limit=20`),
    enabled: desktopPresentation && !!connection && platform !== 'toutiao',
    staleTime: 5_000,
    refetchInterval: (query) => {
      const items = query.state.data?.items ?? []
      const active = items.some((item) => ['queued', 'running', 'paused', 'waiting_budget', 'waiting_device', 'waiting_login'].includes(item.status))
      if (!active) return false
      return document.visibilityState === 'visible' ? 5_000 : 30_000
    },
  })
  const snapshotQuery = useQuery({
    queryKey: ['platform-account-snapshot', accountId],
    queryFn: () => get<{ snapshot: PlatformAccountSnapshot | null; state: string }>(`/accounts/${accountId}/platform-profile`),
    enabled: desktopPresentation && !!connection && platform !== 'toutiao',
    staleTime: 30_000,
  })

  const load = useCallback(async () => {
    if (platform === 'toutiao') {
      generation.current++
      controller.current?.abort()
      setConnection(null)
      setObservations([])
      setConnectionError('')
      setObservationError('')
      setLoading(false)
      return
    }
    const currentGeneration = ++generation.current
    controller.current?.abort()
    const requestController = new AbortController()
    controller.current = requestController
    setLoading(true)
    setConnectionError('')
    setObservationError('')
    let loadedConnection: PlatformConnection | null = null
    try {
      const res = await get<{ connection: PlatformConnection | null }>(`/accounts/${accountId}/platform-connection`, { signal: requestController.signal })
      if (currentGeneration !== generation.current) return
      loadedConnection = res.connection
      setConnection(loadedConnection)
    } catch (e) {
      if (currentGeneration !== generation.current || requestController.signal.aborted) return
      setConnectionError(errorMessage(e))
      return
    } finally {
      if (currentGeneration === generation.current) setLoading(false)
    }
    if (!loadedConnection) { setObservations([]); return }
    try {
      const obs = await get<{ observations: PlatformObservation[] }>(`/accounts/${accountId}/metrics/observations`, { signal: requestController.signal })
      if (currentGeneration === generation.current) setObservations(obs.observations ?? [])
    } catch (e) {
      if (currentGeneration !== generation.current || requestController.signal.aborted) return
      setObservationError(errorMessage(e))
    }
  }, [accountId, platform])

  useEffect(() => {
    void load()
    return () => { generation.current++; controller.current?.abort() }
  }, [load])
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])

  const patchConnection = async (body: Record<string, unknown>, label: string) => {
    setBusy(label)
    try {
      const updated = await patch<PlatformConnection>(`/accounts/${accountId}/platform-connection`, body)
      setConnection(updated)
      toast.success(`${label}已保存`)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy('')
    }
  }

  const invokeDesktop = async (cmd: string, payload: Record<string, unknown>) => {
    if (!desktopPresentation || !window.opsDesktopSettings?.platformCommand) throw new Error('请在 OPS 桌面客户端执行此操作。')
    const response = await window.opsDesktopSettings.platformCommand({ v: 1, id: crypto.randomUUID(), cmd, payload }) as {
      ok?: boolean
      data?: unknown
      error?: { message?: string }
    }
    if (response.ok !== true) throw new Error(response.error?.message || '本机操作失败，请稍后重试。')
    return response.data
  }

  const requestAccountSync = async (mode: 'incremental' | 'full_reconcile' = 'incremental') => {
    if (!connection) return
    setBusy('account-sync')
    try {
      await invokeDesktop('request-account-sync', {
        accountId,
        mode,
        connectionRevision: connection.authorization_revision,
      })
      toast.success(mode === 'full_reconcile' ? '已建立历史核对操作' : '已建立平台账号同步操作')
      await operationsQuery.refetch()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy('')
    }
  }

  const requestMetricsRefresh = async () => {
    if (!connection) return
    setBusy('metrics-refresh')
    try {
      await invokeDesktop('request-metrics-refresh', {
        accountId,
        connectionRevision: connection.authorization_revision,
      })
      toast.success('已建立作品指标刷新操作')
      await operationsQuery.refetch()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy('')
    }
  }

  const actOnOperation = async (operation: PlatformSyncOperation, action: 'pause' | 'resume' | 'cancel') => {
    setBusy(`operation-${action}`)
    try {
      if (action === 'resume') {
        await invokeDesktop('resume-platform-sync', {
          accountId,
          operationId: operation.id,
          expectedOperationRevision: operation.revision,
        })
      } else {
        await post(`/accounts/${accountId}/platform-sync-operations/${operation.id}/actions`, {
          action,
          expected_operation_revision: operation.revision,
        })
      }
      toast.success(action === 'pause' ? '同步已暂停' : action === 'cancel' ? '同步已取消' : '同步已继续')
      await operationsQuery.refetch()
    } catch (e) {
      toast.error(errorMessage(e))
      await operationsQuery.refetch()
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
    } catch (e) {
      toast.error(errorMessage(e))
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
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy('')
    }
  }

  if (loading) {
    return <Card className="p-5 text-[13px] text-mist-400">正在读取平台连接…</Card>
  }

  if (connectionError) return <Card role="alert" className="space-y-3 p-5">
    <div className="font-semibold text-mist-900">平台连接状态读取失败</div>
    <p className="text-[13px] text-mist-600">{connectionError}</p>
    <Button size="sm" variant="secondary" onClick={() => void load()}>重试</Button>
  </Card>

  const policyReady = !!policyQuery.data?.global_enabled && !!policyQuery.data.policy.enabled
  const canStartConnection = !adminOverride && accountStatus === 'active' && policyReady
    && (role === 'owner' || (role === 'editor' && policyQuery.data?.policy.allow_member_connections))
  const canOpenToutiao = !adminOverride && accountStatus === 'active' && role !== 'viewer'
  const canConfirmObservations = !adminOverride && role !== 'viewer'
  const isToutiao = platform === 'toutiao'
  const openPlatformLogin = () => {
    window.open(`ops-desktop://ui/platform-login/${accountId}/${platform}`, '_blank', 'noopener,noreferrer')
    window.dispatchEvent(new CustomEvent(DESKTOP_LOCAL_SETTINGS_REQUEST, { detail: { panel: 'account-device' } }))
  }

  if (!connection) {
    const loginAction = desktopPresentation && (isToutiao ? canOpenToutiao : canStartConnection) && (
      <Button size="sm" variant="primary" icon={<ExternalLink className="size-3.5" />} onClick={openPlatformLogin}
        aria-label={isToutiao ? '打开头条官方登录页' : '在本机扫码登录'}
        title={isToutiao ? '打开头条官方登录页' : '在本机扫码登录'}
        className={actionsTarget !== undefined ? '!px-2 !text-[12px]' : undefined}>
        {isToutiao ? (actionsTarget !== undefined ? '登录' : '打开头条官方登录页') : (actionsTarget !== undefined ? '登录' : '在本机扫码登录')}
      </Button>
    )
    const syncAction = <Button size="sm" variant="secondary" disabled title="请先登录并核对平台身份" aria-label="同步平台账号"
      className={actionsTarget !== undefined ? '!px-2 !text-[12px]' : undefined}>{actionsTarget !== undefined ? '同步' : '同步平台账号'}</Button>
    const actions = actionsTarget !== undefined
      ? <div className="flex min-w-0 flex-wrap items-center gap-1">{loginAction}{syncAction}</div>
      : <div className="flex flex-wrap items-center gap-2 pt-1">{loginAction}{syncAction}</div>
    return (
      <Card className={desktopPresentation ? 'desktop-platform-connection @container' : undefined}>
        <CardHeader title="平台登录与同步" desc={`${platformLabel[platform as keyof typeof platformLabel] ?? platform} 登录态保存在本机；登录核验与作品同步是两个独立操作。`} className={desktopPresentation ? 'desktop-platform-connection-header flex-wrap py-4' : undefined} />
        <div className={cn('space-y-2 text-[13px] leading-relaxed text-mist-600', desktopPresentation ? 'desktop-platform-disconnected p-4 @[640px]:p-5' : 'p-5')}>
          <p>{isToutiao
            ? '头条稳定身份与数据读取能力尚未验证。登录后不会自动同步作品，作品仍通过发布包手动发布。'
            : '尚未连接。登录平台账号后需要本人核对稳定身份；登录不会自动同步历史作品。'} </p>
          <p className="text-mist-400">服务端不会代你登录，也不会保存平台 Cookie 或密码。</p>
          {actionsTarget === undefined ? actions : actionsTarget ? createPortal(actions, actionsTarget) : null}
          {!desktopPresentation && <p className="text-[12px] text-mist-500">请在 OPS 桌面客户端登录平台账号。</p>}
          <p className="text-[12px] text-mist-500">同步入口会在连接、作品列表能力和服务端验收开关均满足后开放。</p>
          {desktopPresentation && !isToutiao && policyQuery.isError && <p role="alert" className="text-[12px] text-danger">无法核实工作区平台连接策略，请重试后再登录。</p>}
          {desktopPresentation && !isToutiao && policyQuery.isLoading && <p className="text-[12px] text-mist-500">正在核实工作区平台连接权限…</p>}
          {desktopPresentation && !isToutiao && !policyQuery.isLoading && policyQuery.data && role === 'editor' && !policyQuery.data.policy.allow_member_connections && <p className="text-[12px] text-mist-500">工作区尚未允许成员建立本人持有的平台连接，请联系所有者。</p>}
          {desktopPresentation && role === 'viewer' && <p className="text-[12px] text-mist-500">当前角色为只读，平台登录与修改操作需由工作区所有者或授权成员完成。</p>}
          {desktopPresentation && !isToutiao && !policyQuery.isLoading && !policyQuery.isError && !policyReady && <p className="text-[12px] text-mist-500">工作区平台数据连接未启用；你仍可使用人工数据回填。</p>}
          {accountStatus === 'disabled' && <p className="text-[12px] text-gamboge-700">此账号已停用，不能启动平台登录或新的采集。</p>}
        </div>
      </Card>
    )
  }

  const presence = presenceState(connection, now)
  const availability = availabilityLabel[connection.availability]
  const syncReason = (kind: 'account_sync' | 'metrics_refresh'): string | null => {
    if (!desktopPresentation) return '请在 OPS 桌面客户端发起本机平台读取。'
    if (adminOverride) return '系统管理员代入工作区时只能查看，不能发起平台读取。'
    if (role === 'viewer') return '当前角色为只读，不能发起平台读取。'
    if (accountStatus !== 'active') return '此账号已停用，不能发起新的平台读取。'
    if (!connection.is_holder) return '请由平台连接保管人在保存登录态的主设备上发起。'
    if (connection.state !== 'active') return '平台连接已暂停或撤销，请先恢复连接。'
    if (connection.availability !== 'ready') return `平台连接状态为“${availability.text}”，请先重新核对登录。`
    if (presence !== 'online') return '保存该平台登录态的本机客户端当前离线。'
    if (policyQuery.isLoading) return '正在核实工作区平台读取权限…'
    if (policyQuery.isError || !policyQuery.data) return '无法核实服务端能力与工作区策略，请重试状态查询。'
    if (!policyQuery.data.global_enabled || !policyQuery.data.policy.enabled) return '服务端或工作区尚未启用平台数据读取。'
    const enabledPlatforms = kind === 'account_sync' ? policyQuery.data.account_sync_platforms : policyQuery.data.metrics_refresh_platforms
    if (!enabledPlatforms?.includes(platform)) return kind === 'account_sync'
      ? '该平台的账号同步能力尚未通过验收并启用。'
      : '该平台的作品指标刷新能力尚未通过验收并启用。'
    const capability = kind === 'account_sync' ? connection.sync_capabilities?.catalog : connection.sync_capabilities?.metrics
    if (capability !== 'supported') return kind === 'account_sync'
      ? '平台作品列表读取能力尚未核验，暂不能同步账号。'
      : '平台作品指标读取能力尚未核验，暂不能刷新指标。'
    return null
  }
  const accountSyncReason = syncReason('account_sync')
  const metricsRefreshReason = syncReason('metrics_refresh')
  const canOpenPlatform = desktopPresentation && !adminOverride && role !== 'viewer' && accountStatus === 'active' && connection.is_holder
  const operations = operationsQuery.data?.items ?? []
  const activeStatuses = ['queued', 'running', 'paused', 'waiting_budget', 'waiting_device', 'waiting_login']
  const progressOperation = operations.find((item) => activeStatuses.includes(item.status)) ?? operations[0]
  const stageLabel: Record<string, string> = { profile: '账号资料', catalog: '作品列表', content: '作品详情', metrics: '作品指标', complete: '已结束', queued: '排队中' }
  const operationStatusLabel: Record<string, string> = {
    queued: '排队中', running: '进行中', paused: '已暂停', waiting_budget: '等待读取窗口', waiting_device: '等待本机客户端',
    waiting_login: '等待重新登录', succeeded: '已完成', partial: '部分完成', failed: '失败', canceled: '已取消'
  }
  const progressText = (operation: PlatformSyncOperation) => {
    const counters = operation.counters
    const parts = [
      Number.isFinite(counters.discovered) ? `发现 ${counters.discovered} 篇` : '',
      Number.isFinite(counters.content_received) ? `详情完成 ${counters.content_received} 篇` : '',
      Number.isFinite(counters.metrics_observed) ? `统计观测 ${counters.metrics_observed} 篇` : '',
      Number.isFinite(counters.failed) && counters.failed > 0 ? `未完成 ${counters.failed} 项` : '',
    ].filter(Boolean)
    return parts.join(' · ') || '等待本机执行器回报阶段结果'
  }
  const platformAccountField = <Field label="平台账号" plain className={desktopPresentation ? 'desktop-platform-field' : undefined}>
    <div className="flex flex-wrap items-center gap-2 text-[13.5px] text-mist-700">
      <Badge tone="ink">{connection.external_account_key}</Badge>
      <Badge tone={availability.tone}>{availability.text}</Badge>
      <span className={cn('inline-flex items-center gap-1 text-[12.5px]', presence === 'online' ? 'text-ink-600' : 'text-mist-400')}>
        {presence === 'online' ? <Wifi className="size-3.5" /> : <WifiOff className="size-3.5" />}
        {presence === 'online' ? '客户端在线' : presence === 'offline' ? '客户端离线' : '在线状态未知'}
      </span>
    </div>
  </Field>
  const platformProfileField = <Field label="平台资料" plain className={desktopPresentation ? 'desktop-platform-field' : undefined}>
    <div className="text-[13px] text-mist-600">
      {snapshotQuery.data?.snapshot ? <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>{snapshotQuery.data.snapshot.display_name || '平台未提供昵称'}</span>
          {snapshotQuery.data.snapshot.public_account_id && <span className="text-mist-500">公开账号号：{snapshotQuery.data.snapshot.public_account_id}</span>}
          {snapshotQuery.data.snapshot.remote_account_type && <Badge tone="gray">{snapshotQuery.data.snapshot.remote_account_type}</Badge>}
          {snapshotQuery.data.snapshot.verified_type && <Badge tone="ink">{snapshotQuery.data.snapshot.verified_type}</Badge>}
        </div>
        {snapshotQuery.data.snapshot.bio && <p className="max-w-2xl whitespace-pre-wrap break-words text-[12px] text-mist-500">{snapshotQuery.data.snapshot.bio}</p>}
        {Object.keys(snapshotQuery.data.snapshot.safe_fields ?? {}).length > 0 && <p className="break-words text-[12px] text-mist-500">
          {Object.entries(snapshotQuery.data.snapshot.safe_fields ?? {}).map(([key, value]) => `${key}：${value}`).join(' · ')}
        </p>}
        {Object.entries(snapshotQuery.data.snapshot.field_states ?? {}).filter(([, state]) => state !== 'present').length > 0 && <p className="text-[12px] text-mist-500">
          未取得字段：{Object.entries(snapshotQuery.data.snapshot.field_states).filter(([, state]) => state !== 'present').map(([key, state]) => `${key}（${state}）`).join('、')}
        </p>}
        {snapshotQuery.data.snapshot.observed_at && <p className="text-[12px] text-mist-400">资料核对于 {fmtTime(snapshotQuery.data.snapshot.observed_at)}</p>}
      </div> : '尚未同步或平台未提供'}
    </div>
  </Field>
  const consentField = <Field label="数据读取同意" plain className={desktopPresentation ? 'desktop-platform-field' : undefined}>
    <div className="text-[13px] text-mist-600">
      <span className="inline-flex items-center gap-1"><ShieldCheck className="size-3.5" />已同意第 {connection.platform_consent_version} 版说明</span>
      {connection.consented_at && <span className="ml-2 text-mist-400">{fmtTime(connection.consented_at)}</span>}
    </div>
  </Field>
  const autoCollectField = <Field label="自动采集" hint="关闭后不再领取新任务；已领任务按取消处理" className={desktopPresentation ? 'desktop-platform-field' : undefined}>
    <label className="flex items-center gap-2 text-[13.5px] text-mist-700">
      <input
        type="checkbox"
        className="accent-ink-600"
        checked={connection.auto_collect}
        disabled={!canManage || busy !== '' || accountStatus !== 'active'}
        onChange={(e) => void patchConnection({
          auto_collect: e.target.checked,
          authorization_revision: connection.authorization_revision,
        }, '自动采集')}
      />
      {connection.auto_collect ? '已开启' : '已关闭'}
    </label>
  </Field>
  const autoAdoptField = <Field label="自动采用（写入正式指标）" hint={autoAdoptDisabledReason()} className={desktopPresentation ? 'desktop-platform-field' : undefined}>
    <label className="flex items-center gap-2 text-[13.5px] text-mist-400">
      <input type="checkbox" className="accent-ink-600" checked={connection.auto_adopt} disabled readOnly />
      {connection.auto_adopt ? '已开启' : '未开启'}
    </label>
  </Field>
  const lastVerifiedField = <Field label="最近验证" plain className={desktopPresentation ? 'desktop-platform-field' : undefined}>
    <div className="text-[13px] text-mist-600">{connection.last_verified_at ? fmtTime(connection.last_verified_at) : '尚未验证'}</div>
  </Field>
  const nextDueField = <Field label="下次计划" plain className={desktopPresentation ? 'desktop-platform-field' : undefined}>
    <div className="inline-flex items-center gap-1 text-[13px] text-mist-600">
      <Clock className="size-3.5" />
      {connection.next_due_at ? fmtTime(connection.next_due_at) : '等待下一轮调度'}
    </div>
  </Field>
  const failureField = connection.failure_count > 0 && <Field label="连续失败" plain className={desktopPresentation ? 'desktop-platform-field' : undefined}>
    <div className="inline-flex items-center gap-1 text-[13px] text-orange-700">
      <AlertTriangle className="size-3.5" />{connection.failure_count} 次，达到 5 次会暂停自动采集
    </div>
  </Field>
  const loginAction = canOpenPlatform && <Button size="sm" variant="secondary" icon={<ExternalLink className="size-3.5" />} disabled={busy !== ''}
    onClick={openPlatformLogin} aria-label={connection.availability === 'ready' ? '打开平台后台或重新登录' : '重新登录平台账号'}
    title={connection.availability === 'ready' ? '打开平台后台或重新登录' : '重新登录平台账号'}
    className={actionsTarget !== undefined ? '!px-2 text-[12px]' : undefined}>
    {actionsTarget !== undefined ? (connection.availability === 'ready' ? '后台' : '重登') : connection.availability === 'ready' ? '打开平台后台 / 重新登录' : '重新登录平台账号'}
  </Button>
  const syncAction = <Button size="sm" variant="primary" icon={<RefreshCw className="size-3.5" />} disabled={busy !== '' || !!accountSyncReason}
    loading={busy === 'account-sync'} onClick={() => void requestAccountSync()} aria-label="同步平台账号"
    className={actionsTarget !== undefined ? '!px-2 !text-[12px]' : undefined}>
    {actionsTarget !== undefined ? '同步' : '同步平台账号'}
  </Button>
  const refreshAction = <Button size="sm" variant="ghost" icon={actionsTarget !== undefined ? <BarChart3 className="size-3.5" /> : <RefreshCw className="size-3.5" />} disabled={busy !== '' || !!metricsRefreshReason}
    loading={busy === 'metrics-refresh'} onClick={() => void requestMetricsRefresh()} aria-label="刷新作品指标"
    title={metricsRefreshReason ?? '刷新作品指标'} className={actionsTarget !== undefined ? '!px-2 !text-[12px]' : undefined}>
    {actionsTarget !== undefined ? '指标' : '刷新作品指标'}
  </Button>
  const moreAction = <MoreMenu items={[
    { label: '重新核对历史作品', disabled: busy !== '' || !!accountSyncReason, loading: busy === 'account-sync', onClick: () => void requestAccountSync('full_reconcile') }
  ]} className={actionsTarget !== undefined ? 'shrink-0 [&>button]:!px-2 [&>button]:!text-[12px]' : undefined} />
  const actions = actionsTarget !== undefined
    ? <div className="flex min-w-0 flex-wrap items-center gap-1">{loginAction}{syncAction}{refreshAction}{moreAction}</div>
    : <div className={cn('flex flex-wrap items-center gap-2 border-b border-line/60', desktopPresentation ? 'px-4 py-3 @[640px]:px-5 @[640px]:py-4' : 'px-5 py-4')}>
      {loginAction}{syncAction}{moreAction}{refreshAction}
    </div>
  const renderedActions = actionsTarget === undefined ? actions : actionsTarget ? createPortal(actions, actionsTarget) : null

  return (
    <Card className={desktopPresentation ? 'desktop-platform-connection @container' : undefined}>
      <CardHeader
        title="平台登录与同步"
        desc="只读取本人后台数据；平台会话保存在你自己的电脑上。登录核验不会自动同步作品。"
        className={desktopPresentation ? 'desktop-platform-connection-header flex-wrap py-4' : undefined}
        action={(canManage || connection.is_holder) ? (
          <div className="flex gap-2">
            <Button size="sm" variant="danger" disabled={busy !== ''} onClick={revoke}>撤销连接</Button>
          </div>
        ) : undefined}
      />
      {renderedActions}
      {(accountSyncReason || metricsRefreshReason) && <div className={cn('border-b border-line/60 text-[12px] text-mist-600', desktopPresentation ? 'desktop-platform-connection-notices px-5 py-3.5' : 'space-y-1 bg-mist-50/50 px-5 py-3')}>
        {accountSyncReason && <p>账号同步：{accountSyncReason}</p>}
        {metricsRefreshReason && <p>指标刷新：{metricsRefreshReason}</p>}
      </div>}
      {desktopPresentation && progressOperation && <div className="desktop-platform-connection-progress border-b border-line/60 px-5 py-4" aria-live="polite">
        <div className="flex flex-wrap items-center gap-2 text-[13px] font-semibold text-mist-800">
          <span>{progressOperation.kind === 'account_sync' ? '账号同步进度' : '指标刷新进度'}</span>
          <Badge tone={['succeeded', 'partial'].includes(progressOperation.status) ? 'ink' : progressOperation.status === 'failed' ? 'red' : 'gamboge'}>
            {operationStatusLabel[progressOperation.status] ?? progressOperation.status}
          </Badge>
          <span className="font-normal text-mist-500">{stageLabel[progressOperation.stage] ?? progressOperation.stage}</span>
          {progressOperation.next_allowed_at && <span className="font-normal text-mist-500">下次可继续 {fmtTime(progressOperation.next_allowed_at)}</span>}
        </div>
        <p className="mt-1 text-[12.5px] text-mist-600">{progressText(progressOperation)}</p>
        {progressOperation.last_error?.code && <p className="mt-1 text-[12px] text-gamboge-700">最近状态：{progressOperation.last_error.code}</p>}
        <div className="mt-2 flex flex-wrap gap-2">
          {progressOperation.available_actions.includes('pause') && <Button size="sm" variant="ghost" disabled={busy !== ''} onClick={() => void actOnOperation(progressOperation, 'pause')}>暂停</Button>}
          {progressOperation.available_actions.includes('resume') && <Button size="sm" variant="secondary" disabled={busy !== ''} onClick={() => void actOnOperation(progressOperation, 'resume')}>继续同步</Button>}
          {progressOperation.available_actions.includes('cancel') && <Button size="sm" variant="ghost" disabled={busy !== ''} onClick={() => void actOnOperation(progressOperation, 'cancel')}>取消</Button>}
          {operationsQuery.isFetching && <span className="self-center text-[11px] text-mist-400">正在更新项目进度</span>}
        </div>
      </div>}
      {desktopPresentation ? (
        <div className="desktop-platform-details">
          <section className="desktop-platform-information-grid" aria-label="连接信息">
            {platformAccountField}{platformProfileField}{consentField}{lastVerifiedField}
          </section>
          <section className="desktop-platform-collection" aria-label="采集设置">
            <div className="desktop-platform-collection-grid">{autoCollectField}{autoAdoptField}</div>
            <div className={cn('desktop-platform-schedule-grid', connection.failure_count === 0 && 'desktop-platform-schedule-single')}>{nextDueField}{failureField}</div>
          </section>
        </div>
      ) : <div className="grid gap-4 p-5 sm:grid-cols-2">
        {platformAccountField}{platformProfileField}{consentField}{autoCollectField}{autoAdoptField}{lastVerifiedField}{nextDueField}{failureField}
      </div>}

      <div className={cn('border-t border-line/60', desktopPresentation ? 'desktop-platform-observations px-5 py-4' : 'px-5 py-4')}>
        <div className="mb-2 text-[13px] font-semibold text-mist-700">最近观测</div>
        {observations.length === 0 ? (
          <p className="text-[13px] text-mist-400">还没有观测记录。采集到数据后会显示在这里，需要你逐条确认才写入正式指标。</p>
        ) : (
          <ul className="space-y-2">
            {observations.slice(0, 8).map((o) => (
              <li key={o.id} className="flex flex-wrap items-center gap-2 text-[13px] text-mist-600">
                <Badge tone={o.quality_state === 'valid' ? 'ink' : o.quality_state === 'rejected' ? 'red' : 'gamboge'}>
                  {qualityLabel[o.quality_state]}
                </Badge>
                <span className="text-mist-500">{o.external_id ?? '账号级'}</span>
                <span className="text-mist-400">{fmtTime(o.as_of_at ?? o.observed_at)}</span>
                <span className="text-mist-400">
                  {Object.entries(o.values).map(([key, v]) => `${key}=${v.value}（${unitLabel[v.unit] ?? v.unit}）`).join('，')}
                </span>
                {o.quality_state === 'needs_confirmation' && canConfirmObservations && (
                  <Button size="sm" variant="ghost" disabled={busy === o.id} onClick={() => void confirmOne(o.id)}>
                    确认这一条
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {observationError && <div role="alert" className="mt-2 flex flex-wrap items-center gap-2 text-[12.5px] text-danger"><span>观测记录读取失败：{observationError}</span><Button size="sm" variant="ghost" disabled={busy !== ''} onClick={() => void load()}>重试</Button></div>}
        <p className="mt-3 text-[12.5px] text-mist-400">
          单位“口径不明”的字段（例如小红书的观看、公众号的阅读）在平台确认是人数还是次数之前只存观测，不计入正式统计。
        </p>
      </div>
    </Card>
  )
}
