import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Button, Card, Field, Input, Notice, PageState, Switch } from '@/components/ui'
import { errorMessage, get, put } from '@/lib/api'
import { useSettingsDraft } from '@/lib/desktop-settings'
import { fmtBytes, fmtNum } from '@/lib/format'
import { useMe, useSystemInfo } from '@/lib/session'
import type { AILimit } from '@/lib/types'

export function BudgetSettings() {
  const { data: me } = useMe()
  const owner = me?.role === 'owner'
  const navigate = useNavigate()
  const qc = useQueryClient()
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
  const usage = useQuery({ queryKey: ['settings-usage-summary', today], queryFn: () => get<{ today_tokens: number; total: { cost: number | null; calls: number }; limit: AILimit }>(`/usage?group_by=day&from=${today}&to=${today}`) })
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => get<{ ai_limit: AILimit }>('/settings'), enabled: owner })
  const [limit, setLimit] = useState<AILimit | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (settings.data) setLimit(settings.data.ai_limit) }, [settings.data])
  useSettingsDraft(!!limit && JSON.stringify(limit) !== JSON.stringify(settings.data?.ai_limit), busy)
  const save = async () => {
    if (!limit) return
    setBusy(true)
    try {
      await put('/settings', { ai_limit: limit })
      await Promise.all([qc.invalidateQueries({ queryKey: ['settings'] }), qc.invalidateQueries({ queryKey: ['usage'] }), usage.refetch()])
      toast.success('每日上限已保存')
    } catch (error) { toast.error(errorMessage(error)) } finally { setBusy(false) }
  }
  return <div className="space-y-5">
    <p className="text-sm text-mist-500">查看工作区今日消耗并设置每日上限。完整分组统计在独立报表中查看。</p>
    {usage.isPending || !usage.data ? <PageState loading={usage.isPending} error={usage.error} retrying={usage.isFetching} onRetry={() => void usage.refetch()} /> : <Card className="grid gap-5 p-5 sm:grid-cols-3">
      <div><div className="text-xs text-mist-500">今日 token</div><strong className="mt-2 block text-2xl tabular-nums text-mist-900">{fmtNum(usage.data.today_tokens)}</strong></div>
      <div><div className="text-xs text-mist-500">今日调用</div><strong className="mt-2 block text-2xl tabular-nums text-mist-900">{fmtNum(usage.data.total.calls)}</strong></div>
      <div><div className="text-xs text-mist-500">今日估算费用</div><strong className="mt-2 block text-2xl tabular-nums text-mist-900">{usage.data.total.cost == null ? '—' : `¥${usage.data.total.cost.toFixed(3)}`}</strong></div>
    </Card>}
    {owner ? settings.isPending || !limit ? <PageState loading={settings.isPending} error={settings.error} retrying={settings.isFetching} onRetry={() => void settings.refetch()} /> : <Card className="space-y-4 p-5">
      <div className="flex items-center justify-between gap-5"><div><h2 className="font-semibold text-mist-900">每日 token 上限</h2><p className="mt-1 text-sm text-mist-500">达到上限后，当天 AI 暂停；手动编辑、规则检查与发布操作仍可使用。</p></div><Switch label="启用每日 token 上限" checked={limit.enabled} disabled={busy} onChange={(enabled) => setLimit({ ...limit, enabled })} /></div>
      {limit.enabled && <Field label="每日上限（token）"><Input type="number" min={1000} step={1000} value={limit.daily_tokens} disabled={busy} onChange={(event) => setLimit({ ...limit, daily_tokens: Number(event.target.value) })} /></Field>}
      <Button variant="primary" loading={busy} disabled={limit.enabled && (!Number.isInteger(limit.daily_tokens) || limit.daily_tokens < 1000)} onClick={() => void save()}>保存每日上限</Button>
    </Card> : <Notice>每日上限仅所有者可修改。当前{usage.data?.limit.enabled ? `上限为 ${fmtNum(usage.data.limit.daily_tokens)} token` : '未启用上限'}。</Notice>}
    <Button onClick={() => navigate('/settings/usage')}>在主窗口打开完整用量报表 ↗</Button>
  </div>
}

export function AboutSettings() {
  const query = useSystemInfo()
  return <div className="space-y-5"><p className="text-sm text-mist-500">OPS 灵感空间</p>{query.isPending || !query.data ? <PageState loading={query.isPending} error={query.error} retrying={query.isFetching} onRetry={() => void query.refetch()} /> : <Card className="space-y-4 p-5"><div className="flex justify-between gap-4"><span className="text-mist-500">服务版本</span><span>{query.data.version}</span></div><div className="flex justify-between gap-4"><span className="text-mist-500">服务运行模式</span><span>{query.data.dev ? '本地开发（模拟接口）' : '生产'}</span></div><div className="flex justify-between gap-4"><span className="text-mist-500">服务数据占用</span><span>{fmtBytes(query.data.data_bytes)}</span></div></Card>}<Notice>以上信息来自当前连接的服务。客户端安装版本可在本机设置的“连接与模式”中查看。</Notice></div>
}
