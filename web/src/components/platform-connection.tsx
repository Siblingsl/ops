import { AlertTriangle, Clock, RefreshCw, ShieldCheck, Wifi, WifiOff } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { del, errorMessage, get, patch, post } from '@/lib/api'
import { fmtTime } from '@/lib/format'
import type { PlatformAvailability, PlatformConnection, PlatformObservation } from '@/lib/types'
import { Badge, Button, Card, CardHeader, cn, Field, platformLabel } from './ui'

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

export function PlatformConnectionCard({ accountId, platform, canManage }: {
  accountId: string
  platform: string
  canManage: boolean
}) {
  const [connection, setConnection] = useState<PlatformConnection | null>(null)
  const [observations, setObservations] = useState<PlatformObservation[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [now, setNow] = useState(() => Date.now())

  const load = useCallback(async () => {
    try {
      const res = await get<{ connection: PlatformConnection | null }>(`/accounts/${accountId}/platform-connection`)
      setConnection(res.connection)
      if (res.connection) {
        const obs = await get<{ observations: PlatformObservation[] }>(`/accounts/${accountId}/metrics/observations`)
        setObservations(obs.observations ?? [])
      } else {
        setObservations([])
      }
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setLoading(false)
    }
  }, [accountId])

  useEffect(() => { void load() }, [load])
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

  const requestCollect = async () => {
    setBusy('collect')
    try {
      await post(`/accounts/${accountId}/platform-sync`, {})
      toast.success('已建立一次采集待办；本机客户端在线时会领取')
      await load()
    } catch (e) {
      toast.error(errorMessage(e))
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

  if (!connection) {
    return (
      <Card>
        <CardHeader title="平台数据连接" desc={`读取本机 ${platformLabel[platform as keyof typeof platformLabel] ?? platform} 后台的本人作品数据。需要在本机客户端完成扫码登录。`} />
        <div className="space-y-2 p-5 text-[13px] leading-relaxed text-mist-600">
          <p>尚未连接。连接只能在本机客户端发起：本机打开平台页面、你本人扫码确认身份后，连接才会出现在这里。</p>
          <p className="text-mist-400">服务端不会代你登录，也不会保存平台 Cookie 或密码。</p>
        </div>
      </Card>
    )
  }

  const presence = presenceState(connection, now)
  const availability = availabilityLabel[connection.availability]

  return (
    <Card>
      <CardHeader
        title="平台数据连接"
        desc="只读取本人后台数据；平台会话保存在你自己的电脑上。"
        action={canManage ? (
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} disabled={busy !== ''} onClick={requestCollect}>
              请求一次采集
            </Button>
            <Button size="sm" variant="danger" disabled={busy !== ''} onClick={revoke}>撤销连接</Button>
          </div>
        ) : undefined}
      />
      <div className="grid gap-4 p-5 sm:grid-cols-2">
        <Field label="平台账号" plain>
          <div className="flex flex-wrap items-center gap-2 text-[13.5px] text-mist-700">
            <Badge tone="ink">{connection.external_account_key}</Badge>
            <Badge tone={availability.tone}>{availability.text}</Badge>
            <span className={cn('inline-flex items-center gap-1 text-[12.5px]', presence === 'online' ? 'text-ink-600' : 'text-mist-400')}>
              {presence === 'online' ? <Wifi className="size-3.5" /> : <WifiOff className="size-3.5" />}
              {presence === 'online' ? '客户端在线' : presence === 'offline' ? '客户端离线' : '在线状态未知'}
            </span>
          </div>
        </Field>
        <Field label="数据读取同意" plain>
          <div className="text-[13px] text-mist-600">
            <span className="inline-flex items-center gap-1"><ShieldCheck className="size-3.5" />已同意第 {connection.platform_consent_version} 版说明</span>
            {connection.consented_at && <span className="ml-2 text-mist-400">{fmtTime(connection.consented_at)}</span>}
          </div>
        </Field>
        <Field label="自动采集" hint="关闭后不再领取新任务；已领任务按取消处理">
          <label className="flex items-center gap-2 text-[13.5px] text-mist-700">
            <input
              type="checkbox"
              className="accent-ink-600"
              checked={connection.auto_collect}
              disabled={!canManage || busy !== ''}
              onChange={(e) => void patchConnection({
                auto_collect: e.target.checked,
                authorization_revision: connection.authorization_revision,
              }, '自动采集')}
            />
            {connection.auto_collect ? '已开启' : '已关闭'}
          </label>
        </Field>
        <Field label="自动采用（写入正式指标）" hint={autoAdoptDisabledReason()}>
          <label className="flex items-center gap-2 text-[13.5px] text-mist-400">
            <input type="checkbox" className="accent-ink-600" checked={connection.auto_adopt} disabled readOnly />
            {connection.auto_adopt ? '已开启' : '未开启'}
          </label>
        </Field>
        <Field label="最近验证" plain>
          <div className="text-[13px] text-mist-600">{connection.last_verified_at ? fmtTime(connection.last_verified_at) : '尚未验证'}</div>
        </Field>
        <Field label="下次计划" plain>
          <div className="inline-flex items-center gap-1 text-[13px] text-mist-600">
            <Clock className="size-3.5" />
            {connection.next_due_at ? fmtTime(connection.next_due_at) : '等待下一轮调度'}
          </div>
        </Field>
        {connection.failure_count > 0 && (
          <Field label="连续失败" plain>
            <div className="inline-flex items-center gap-1 text-[13px] text-orange-700">
              <AlertTriangle className="size-3.5" />{connection.failure_count} 次，达到 5 次会暂停自动采集
            </div>
          </Field>
        )}
      </div>

      <div className="border-t border-line/60 px-5 py-4">
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
                {o.quality_state === 'needs_confirmation' && canManage && (
                  <Button size="sm" variant="ghost" disabled={busy === o.id} onClick={() => void confirmOne(o.id)}>
                    确认这一条
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-[12.5px] text-mist-400">
          单位“口径不明”的字段（例如小红书的观看、公众号的阅读）在平台确认是人数还是次数之前只存观测，不计入正式统计。
        </p>
      </div>
    </Card>
  )
}
