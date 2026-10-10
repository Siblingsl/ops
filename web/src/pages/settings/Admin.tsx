import { useQuery } from '@tanstack/react-query'
import { Shield } from 'lucide-react'
import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { confirm } from '@/components/dialog'
import { Badge, Button, Card, CardHeader, Empty, Field, PageHeader, PageLoading, Select, Switch } from '@/components/ui'
import { errorMessage, get, patch, post, put } from '@/lib/api'
import { fmtNum, fmtTime } from '@/lib/format'
import { useInvalidate, useMe } from '@/lib/session'
import type { AdminUser, AdminWorkspace, SystemSettings } from '@/lib/types'

interface UsageRow { key: string; calls: number; prompt_tokens: number; completion_tokens: number; failed: number }
interface UsageResp { group_by: string; from: string; to: string; rows: UsageRow[]; total: UsageRow }
interface Log { id: string; action: string; target_type: string; target_id: string; result: string; created_at: string; actor: string | null }

export default function SettingsAdmin() {
  const { data: me, isLoading: meLoading } = useMe()
  const inv = useInvalidate()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [usageGroup, setUsageGroup] = useState('day')

  const users = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => get<AdminUser[]>('/admin/users'),
    enabled: !!me?.is_system_admin,
  })
  const workspaces = useQuery({
    queryKey: ['admin-workspaces'],
    queryFn: () => get<AdminWorkspace[]>('/admin/workspaces'),
    enabled: !!me?.is_system_admin,
  })
  const settings = useQuery({
    queryKey: ['admin-settings'],
    queryFn: () => get<SystemSettings>('/admin/system-settings'),
    enabled: !!me?.is_system_admin,
  })
  const usage = useQuery({
    queryKey: ['admin-usage', usageGroup],
    queryFn: () => get<UsageResp>(`/admin/usage?group_by=${usageGroup}`),
    enabled: !!me?.is_system_admin,
  })
  const logs = useQuery({
    queryKey: ['admin-logs'],
    queryFn: () => get<Log[]>('/admin/audit-logs?limit=40'),
    enabled: !!me?.is_system_admin,
  })

  if (meLoading) return <PageLoading />
  if (!me?.is_system_admin) return <Navigate to="/settings/accounts" replace />

  const patchUser = async (id: string, body: { disabled?: boolean; is_system_admin?: boolean }) => {
    setBusy(true)
    try {
      await patch(`/admin/users/${id}`, body)
      toast.success('已更新')
      await inv(['admin-users'])
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const resetPassword = async (u: AdminUser) => {
    if (!(await confirm({
      title: `重置 ${u.username} 的密码？`,
      desc: '将生成临时密码并踢出其全部会话。请立即抄写临时密码发给对方。',
      danger: true,
      confirmText: '重置',
    }))) return
    setBusy(true)
    try {
      const res = await post<{ temporary_password: string }>(`/admin/users/${u.id}/reset-password`, {})
      await navigator.clipboard.writeText(res.temporary_password).catch(() => undefined)
      toast.success(`临时密码：${res.temporary_password}（已尝试复制）`)
      await inv(['admin-users'])
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const revokeSessions = async (u: AdminUser) => {
    if (!(await confirm({ title: `踢出 ${u.username} 的全部会话？`, confirmText: '踢出' }))) return
    setBusy(true)
    try {
      await post(`/admin/users/${u.id}/revoke-sessions`, {})
      toast.success('已踢出会话')
      await inv(['admin-users'])
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const enterWorkspace = async (ws: AdminWorkspace) => {
    if (!(await confirm({
      title: `进入「${ws.name}」？`,
      desc: '将以超级管理员身份获得该工作区所有者权限，不会改动成员列表。',
      confirmText: '进入',
    }))) return
    setBusy(true)
    try {
      await post(`/admin/workspaces/${ws.id}/enter`, {})
      toast.success('已进入工作区')
      await inv(['me'], ['accounts'], ['members'])
      navigate('/')
      window.location.assign('/')
    } catch (e) {
      toast.error(errorMessage(e))
      setBusy(false)
    }
  }

  const saveSettings = async (patchBody: Partial<SystemSettings>) => {
    setBusy(true)
    try {
      await put('/admin/system-settings', patchBody)
      toast.success('已保存')
      await inv(['admin-settings'])
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="animate-fade-in space-y-8">
      <PageHeader
        title="系统管理"
        desc="全站超级管理员：管控用户与工作区、查看跨租户审计与用量、开关注册与维护模式。"
      />

      <Card>
        <CardHeader title="全局开关" />
        <div className="space-y-4 px-5 pb-5">
          {!settings.data ? <PageLoading /> : (
            <>
              <Field label="开放注册">
                <div className="flex items-center justify-between gap-4">
                  <p className="text-[13px] text-mist-500">关闭后新用户无法自助注册（空库首次 setup 不受影响）。</p>
                  <Switch
                    checked={settings.data.registration_open}
                    disabled={busy}
                    onChange={(v) => saveSettings({ registration_open: v })}
                  />
                </div>
              </Field>
              <Field label="维护模式">
                <div className="flex items-center justify-between gap-4">
                  <p className="text-[13px] text-mist-500">开启后普通用户无法使用业务功能；超级管理员仍可登录并关闭维护。</p>
                  <Switch
                    checked={settings.data.maintenance_mode}
                    disabled={busy}
                    onChange={(v) => saveSettings({ maintenance_mode: v })}
                  />
                </div>
              </Field>
            </>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader title="用户" desc={`共 ${users.data?.length ?? 0} 人`} />
        {!users.data ? <PageLoading /> : users.data.length === 0 ? <Empty icon={<Shield className="size-5" />} title="暂无用户" /> : (
          <ul className="divide-y divide-mist-100">
            {users.data.map((u) => (
              <li key={u.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-mist-900">{u.username}</span>
                    {u.is_system_admin && <Badge>超级管理员</Badge>}
                    {u.disabled_at && <Badge tone="red">已禁用</Badge>}
                  </div>
                  <div className="mt-0.5 text-xs text-mist-400">
                    工作区 {u.workspace_count} · 会话 {u.session_count}
                    {u.last_login_at ? ` · 最近登录 ${fmtTime(u.last_login_at)}` : ''}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => resetPassword(u)}>重置密码</Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => revokeSessions(u)}>踢会话</Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy
                      || u.username === 'skyeder'
                      || (u.is_system_admin && (users.data?.filter((x) => x.is_system_admin).length ?? 0) <= 1)}
                    onClick={() => patchUser(u.id, { is_system_admin: !u.is_system_admin })}
                  >
                    {u.username === 'skyeder' ? '永久超管' : u.is_system_admin ? '撤超管' : '授超管'}
                  </Button>
                  <Button
                    size="sm"
                    variant={u.disabled_at ? 'secondary' : 'danger'}
                    disabled={busy || u.id === me.user_id || u.username === 'skyeder'}
                    onClick={() => patchUser(u.id, { disabled: !u.disabled_at })}
                  >
                    {u.disabled_at ? '启用' : '禁用'}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader title="工作区" desc={`共 ${workspaces.data?.length ?? 0} 个`} />
        {!workspaces.data ? <PageLoading /> : workspaces.data.length === 0 ? <Empty title="暂无工作区" /> : (
          <ul className="divide-y divide-mist-100">
            {workspaces.data.map((ws) => (
              <li key={ws.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-mist-900">{ws.name}</div>
                  <div className="mt-0.5 text-xs text-mist-400">
                    创建者 {ws.created_by ?? '—'} · 成员 {ws.member_count} · 平台账号 {ws.account_count} · {fmtTime(ws.created_at)}
                  </div>
                </div>
                <Button size="sm" disabled={busy} onClick={() => enterWorkspace(ws)}>进入并管理</Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          title="全站 AI 用量"
          action={(
            <Select value={usageGroup} onChange={(e) => setUsageGroup(e.target.value)} className="w-36">
              <option value="day">按天</option>
              <option value="task">按任务</option>
              <option value="model">按模型</option>
              <option value="workspace">按工作区</option>
              <option value="account">按账号</option>
            </Select>
          )}
        />
        {!usage.data ? <PageLoading /> : (
          <div className="px-5 pb-5">
            <div className="mb-3 text-sm text-mist-500">
              合计调用 {fmtNum(usage.data.total.calls)} · token {fmtNum(usage.data.total.prompt_tokens + usage.data.total.completion_tokens)}
            </div>
            {usage.data.rows.length === 0 ? <Empty title="暂无用量" /> : (
              <table className="w-full text-[13.5px]">
                <thead>
                  <tr className="border-b border-mist-100 text-left text-xs text-mist-400">
                    <th className="py-2 font-medium">分组</th>
                    <th className="py-2 text-right font-medium">调用</th>
                    <th className="py-2 text-right font-medium">输入</th>
                    <th className="py-2 pr-0 text-right font-medium">输出</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.data.rows.map((r) => (
                    <tr key={r.key} className="border-b border-mist-50">
                      <td className="py-2 text-mist-800">{r.key}</td>
                      <td className="py-2 text-right tabular-nums">{r.calls}</td>
                      <td className="py-2 text-right tabular-nums text-mist-600">{fmtNum(r.prompt_tokens)}</td>
                      <td className="py-2 text-right tabular-nums text-mist-600">{fmtNum(r.completion_tokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title="全站操作日志" />
        {!logs.data ? <PageLoading /> : logs.data.length === 0 ? <Empty title="暂无日志" /> : (
          <ul className="divide-y divide-mist-100">
            {logs.data.map((l) => (
              <li key={l.id} className="flex items-start gap-4 px-5 py-3 text-[13px]">
                <span className="w-36 shrink-0 text-xs tabular-nums text-mist-400">{fmtTime(l.created_at, true)}</span>
                <span className="min-w-0 flex-1 font-medium text-mist-800">{l.action}</span>
                <span className="shrink-0 text-xs text-mist-400">{l.actor ?? '系统'}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}
