import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Shield } from 'lucide-react'
import { memo, useRef, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { confirm } from '@/components/dialog'
import { Badge, Button, Card, CardHeader, Empty, Field, PageHeader, PageLoading, Select, Switch } from '@/components/ui'
import { errorMessage, get, patch, post, put } from '@/lib/api'
import { fmtNum, fmtTime } from '@/lib/format'
import { useInvalidate, useMe } from '@/lib/session'
import type { AdminUser, AdminWorkspace, AgentWorkbenchFeatureName, SystemSettings } from '@/lib/types'

interface UsageRow { key: string; calls: number; prompt_tokens: number; completion_tokens: number; failed: number }

// D-160：智能体工作台特性逐项开关，标签与桌面端「系统管理」保持一致。
const AGENT_FEATURE_LABELS: { name: AgentWorkbenchFeatureName; label: string; hint: string }[] = [
  { name: 'workbench_ui', label: '工作台 UI', hint: '智能体对话新工作台界面' },
  { name: 'conversation_organize', label: '对话整理', hint: '分组、归档与整理能力' },
  { name: 'context_refs', label: '上下文引用', hint: '作品/素材等引用' },
  { name: 'skill_requests', label: '技能请求', hint: '对话内技能调用' },
  { name: 'artifacts', label: '产物', hint: '对话产物面板' },
  { name: 'run_control', label: '运行控制', hint: '暂停/继续/转向' },
  { name: 'event_resume', label: '事件续跑', hint: '断点续跑与压缩' },
  { name: 'plans', label: '计划', hint: '多步计划卡片' },
  { name: 'goals', label: '目标', hint: '需同时具备事件续跑、运行控制与计划' },
  { name: 'routines', label: '例行任务', hint: '需目标与产物等前置特性' },
  { name: 'document_parse', label: '文档解析', hint: '附件文档解析入口' },
]

interface UsageResp { group_by: string; from: string; to: string; rows: UsageRow[]; total: UsageRow }
interface Log { id: string; action: string; target_type: string; target_id: string; result: string; created_at: string; actor: string | null }
// 适配器版本熔断（20 文档 §12）：恢复必须发布更高 mapping_version 并重新实测。
interface PlatformBreaker {
  id: string
  platform: string
  adapter_version: string
  error_code: string
  mapping_version: number | null
  state: string
  opened_at: string
  resolved_at: string | null
  affected_connections: number
  note: string | null
}

const AdminUserRow = memo(function AdminUserRow({
  user,
  busy,
  currentUserId,
  systemAdminCount,
  onResetPassword,
  onRevokeSessions,
  onPatchUser,
}: {
  user: AdminUser
  busy: boolean
  currentUserId: string | undefined
  systemAdminCount: number
  onResetPassword: (user: AdminUser) => void
  onRevokeSessions: (user: AdminUser) => void
  onPatchUser: (id: string, body: { disabled?: boolean; is_system_admin?: boolean }) => void
}) {
  return (
    <li className="flex flex-wrap items-center gap-3 px-5 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-mist-900">{user.username}</span>
          {user.is_system_admin && <Badge>超级管理员</Badge>}
          {user.disabled_at && <Badge tone="red">已禁用</Badge>}
        </div>
        <div className="mt-0.5 text-xs text-mist-400">
          工作区 {user.workspace_count} · 会话 {user.session_count}
          {user.last_login_at ? ` · 最近登录 ${fmtTime(user.last_login_at)}` : ''}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => onResetPassword(user)}>重置密码</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => onRevokeSessions(user)}>踢会话</Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || user.username === 'skyeder' || (user.is_system_admin && systemAdminCount <= 1)}
          onClick={() => onPatchUser(user.id, { is_system_admin: !user.is_system_admin })}
        >
          {user.username === 'skyeder' ? '永久超管' : user.is_system_admin ? '撤超管' : '授超管'}
        </Button>
        <Button
          size="sm"
          variant={user.disabled_at ? 'secondary' : 'danger'}
          disabled={busy || user.id === currentUserId || user.username === 'skyeder'}
          onClick={() => onPatchUser(user.id, { disabled: !user.disabled_at })}
        >
          {user.disabled_at ? '启用' : '禁用'}
        </Button>
      </div>
    </li>
  )
}, (previous, next) => {
  const before = previous.user
  const after = next.user
  return previous.busy === next.busy
    && previous.currentUserId === next.currentUserId
    && (previous.systemAdminCount === next.systemAdminCount || (!before.is_system_admin && !after.is_system_admin))
    && before.id === after.id
    && before.username === after.username
    && before.is_system_admin === after.is_system_admin
    && before.disabled_at === after.disabled_at
    && before.last_login_at === after.last_login_at
    && before.workspace_count === after.workspace_count
    && before.session_count === after.session_count
})

const AdminWorkspaceRow = memo(function AdminWorkspaceRow({
  workspace,
  busy,
  onEnter,
}: {
  workspace: AdminWorkspace
  busy: boolean
  onEnter: (workspace: AdminWorkspace) => void
}) {
  return (
    <li className="flex flex-wrap items-center gap-3 px-5 py-3">
      <div className="min-w-0 flex-1">
        <div className="font-medium text-mist-900">{workspace.name}</div>
        <div className="mt-0.5 text-xs text-mist-400">
          创建者 {workspace.created_by ?? '—'} · 成员 {workspace.member_count} · 平台账号 {workspace.account_count} · {fmtTime(workspace.created_at)}
        </div>
      </div>
      <Button size="sm" disabled={busy} onClick={() => onEnter(workspace)}>进入并管理</Button>
    </li>
  )
}, (previous, next) => previous.busy === next.busy && previous.workspace === next.workspace)

export default function SettingsAdmin() {
  const { data: me, isLoading: meLoading } = useMe()
  const inv = useInvalidate()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [busyUserId, setBusyUserId] = useState<string | null>(null)
  const userActionBusy = useRef(false)
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
  const breakers = useQuery({
    queryKey: ['admin-breakers'],
    queryFn: () => get<{ breakers: PlatformBreaker[] }>('/admin/platform/breakers'),
    enabled: !!me?.is_system_admin,
  })
  const systemAdminCount = users.data?.filter((user) => user.is_system_admin).length ?? 0
  const updateUserCache = (id: string, update: Partial<AdminUser>) => {
    queryClient.setQueryData<AdminUser[]>(['admin-users'], (current) =>
      current?.map((user) => user.id === id ? { ...user, ...update } : user))
  }

  if (meLoading) return <PageLoading />
  if (!me?.is_system_admin) return <Navigate to="/settings/accounts" replace />

  // resolveBreaker 恢复一次熔断。要求输入新的 mapping_version，
  // 因为"只翻状态不换映射"等于让同一个坏适配器继续写数（§12）。
  const resolveBreaker = async (b: PlatformBreaker) => {
    const suggested = String((b.mapping_version ?? 1) + 1)
    const input = window.prompt(
      `恢复 ${b.platform} 适配器 ${b.adapter_version} 的熔断。\n` +
      `必须已发布更高的 mapping_version 并重新实测。\n\n新 mapping_version（当前 ${b.mapping_version ?? '未知'}）：`,
      suggested
    )
    if (input === null) return
    const mappingVersion = Number(input)
    if (!Number.isInteger(mappingVersion) || mappingVersion <= 0) {
      toast.error('mapping_version 必须是正整数')
      return
    }
    if (!(await confirm({
      title: '确认恢复熔断？',
      desc: `将解除 ${b.platform} / ${b.adapter_version} 的熔断。被本次熔断停掉的自动采集不会自动重开，需用户重新确认。`,
      confirmText: '恢复',
    }))) return
    setBusy(true)
    try {
      await post(`/admin/platform/breakers/${b.id}/resolve`, {
        mapping_version: mappingVersion,
        note: `管理页恢复：mapping_version ${b.mapping_version ?? '?'} → ${mappingVersion}`,
      })
      toast.success('熔断已恢复')
      await inv(['admin-breakers'])
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const patchUser = async (id: string, body: { disabled?: boolean; is_system_admin?: boolean }) => {
    if (userActionBusy.current) {
      toast.error('另一项用户操作正在处理，请稍后重试')
      return
    }
    userActionBusy.current = true
    setBusyUserId(id)
    try {
      await patch(`/admin/users/${id}`, body)
      const update: Partial<AdminUser> = {}
      if (body.disabled !== undefined) {
        update.disabled_at = body.disabled ? new Date().toISOString() : null
        if (body.disabled) update.session_count = 0
      }
      if (body.is_system_admin !== undefined) update.is_system_admin = body.is_system_admin
      updateUserCache(id, update)
      toast.success('已更新')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      userActionBusy.current = false
      setBusyUserId(null)
    }
  }

  const resetPassword = async (u: AdminUser) => {
    if (!(await confirm({
      title: `重置 ${u.username} 的密码？`,
      desc: '将生成临时密码并踢出其全部会话。请立即抄写临时密码发给对方。',
      danger: true,
      confirmText: '重置',
    }))) return
    if (userActionBusy.current) {
      toast.error('另一项用户操作正在处理，请稍后重试')
      return
    }
    userActionBusy.current = true
    setBusyUserId(u.id)
    try {
      const res = await post<{ temporary_password: string }>(`/admin/users/${u.id}/reset-password`, {})
      await navigator.clipboard.writeText(res.temporary_password).catch(() => undefined)
      updateUserCache(u.id, { session_count: 0 })
      toast.success(`临时密码：${res.temporary_password}（已尝试复制）`)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      userActionBusy.current = false
      setBusyUserId(null)
    }
  }

  const revokeSessions = async (u: AdminUser) => {
    if (!(await confirm({ title: `踢出 ${u.username} 的全部会话？`, confirmText: '踢出' }))) return
    if (userActionBusy.current) {
      toast.error('另一项用户操作正在处理，请稍后重试')
      return
    }
    userActionBusy.current = true
    setBusyUserId(u.id)
    try {
      await post(`/admin/users/${u.id}/revoke-sessions`, {})
      updateUserCache(u.id, { session_count: 0 })
      toast.success('已踢出会话')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      userActionBusy.current = false
      setBusyUserId(null)
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

  const savePlatformFeature = async (feature: 'account_sync' | 'metrics_refresh', platform: 'xhs' | 'wechat_mp', enabled: boolean) => {
    setBusy(true)
    try {
      await put('/admin/system-settings', { platform_feature: { feature, platform, enabled } })
      toast.success('已保存')
      await inv(['admin-settings'])
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const saveAgentFeature = async (name: AgentWorkbenchFeatureName, enabled: boolean) => {
    setBusy(true)
    try {
      await put('/admin/system-settings', { agent_feature: { name, enabled } })
      toast.success('已保存')
      await inv(['admin-settings'], ['agent-bootstrap'])
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
                    label="开放注册"
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
                    label="维护模式"
                    checked={settings.data.maintenance_mode}
                    disabled={busy}
                    onChange={(v) => saveSettings({ maintenance_mode: v })}
                  />
                </div>
              </Field>
              <Field label="平台数据采集总开关">
                <div className="flex items-center justify-between gap-4">
                  <p className="text-[13px] text-mist-500">
                    关闭后立即停止领取新任务并拒绝提交，已领任务按取消处理；与部署配置 <code>OPS_DESKTOP_PLATFORM_ENABLED</code> 任一关闭即停。
                  </p>
                  <Switch
                    label="平台数据采集总开关"
                    checked={!settings.data.platform_kill_switch}
                    disabled={busy}
                    onChange={(v) => saveSettings({ platform_kill_switch: !v })}
                  />
                </div>
              </Field>
            </>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader title="桌面能力" desc="默认关闭。日常由超管开启；部署环境变量显式为 0/false 时紧急全关且不可在此顶开。" />
        <div className="space-y-4 px-5 pb-5">
          {!settings.data ? <PageLoading /> : (
            <>
              <Field label="桌面本机 AI">
                <div className="flex items-center justify-between gap-4">
                  <p className="text-[13px] text-mist-500">
                    {settings.data.desktop_ai_env_blocked ? '部署已紧急关闭桌面 AI。' : '允许工作区在策略开启后使用本机桌面 AI 通道。'}
                  </p>
                  <Switch
                    label="桌面本机 AI"
                    checked={!!settings.data.desktop_ai_enabled && !settings.data.desktop_ai_env_blocked}
                    disabled={busy || !!settings.data.desktop_ai_env_blocked}
                    onChange={(v) => saveSettings({ desktop_ai_enabled: v })}
                  />
                </div>
              </Field>
              <Field label="平台自动采用">
                <div className="flex items-center justify-between gap-4">
                  <p className="text-[13px] text-mist-500">
                    {settings.data.desktop_platform_auto_adopt_env_blocked
                      ? '部署已紧急关闭自动采用。'
                      : '允许连接在验收后开启「自动采用写入正式指标」（仍需连接级开关）。'}
                  </p>
                  <Switch
                    label="平台自动采用"
                    checked={!!settings.data.desktop_platform_auto_adopt && !settings.data.desktop_platform_auto_adopt_env_blocked}
                    disabled={busy || !!settings.data.desktop_platform_auto_adopt_env_blocked}
                    onChange={(v) => saveSettings({ desktop_platform_auto_adopt: v })}
                  />
                </div>
              </Field>
            </>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="智能体工作台特性"
          desc={settings.data?.agent_features_env_blocked
            ? '部署已将 OPS_AGENT_WORKBENCH_FEATURES 设为紧急全关，下列开关只读。'
            : '逐项开启；目标/例行任务仍受服务端依赖降级约束。不提供一键全开。'}
        />
        <div className="space-y-3 px-5 pb-5">
          {!settings.data ? <PageLoading /> : AGENT_FEATURE_LABELS.map((item) => (
            <Field key={item.name} label={item.label} hint={item.hint}>
              <div className="flex justify-end">
                <Switch
                  label={`${item.label} 开关`}
                  checked={!!settings.data.agent_features?.[item.name] && !settings.data.agent_features_env_blocked}
                  disabled={busy || !!settings.data.agent_features_env_blocked}
                  onChange={(v) => void saveAgentFeature(item.name, v)}
                />
              </div>
            </Field>
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="平台同步能力"
          desc="按平台逐项开启「账号同步」与「指标刷新」。关闭总开关、部署配置任一未开或平台未通过真实账号验收前，保持默认关闭；开关不代替验收。"
        />
        <div className="space-y-4 px-5 pb-5">
          {!settings.data ? <PageLoading /> : (
            <>
              {(['account_sync', 'metrics_refresh'] as const).map((feature) => (
                <Field key={feature} label={feature === 'account_sync' ? '账号同步（同步平台作品与资料）' : '指标刷新（刷新已同步作品的数据）'}>
                  <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
                    {(['xhs', 'wechat_mp'] as const).map((platform) => (
                      <label key={platform} className="flex items-center gap-2 text-[13px] text-mist-700">
                        <Switch
                          label={`${feature === 'account_sync' ? '账号同步' : '指标刷新'}：${platform === 'xhs' ? '小红书' : '微信公众号'}`}
                          checked={settings.data.platform_features[feature][platform]}
                          disabled={busy}
                          onChange={(v) => savePlatformFeature(feature, platform, v)}
                        />
                        {platform === 'xhs' ? '小红书' : '微信公众号'}
                      </label>
                    ))}
                  </div>
                </Field>
              ))}
            </>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader title="用户" desc={`共 ${users.data?.length ?? 0} 人`} />
        {!users.data ? <PageLoading /> : users.data.length === 0 ? <Empty icon={<Shield className="size-5" />} title="暂无用户" /> : (
          <ul className="divide-y divide-mist-100">
            {users.data.map((user) => (
              <AdminUserRow
                key={user.id}
                user={user}
                busy={busy || busyUserId === user.id}
                currentUserId={me.user_id}
                systemAdminCount={systemAdminCount}
                onResetPassword={resetPassword}
                onRevokeSessions={revokeSessions}
                onPatchUser={patchUser}
              />
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader title="工作区" desc={`共 ${workspaces.data?.length ?? 0} 个`} />
        {!workspaces.data ? <PageLoading /> : workspaces.data.length === 0 ? <Empty title="暂无工作区" /> : (
          <ul className="divide-y divide-mist-100">
            {workspaces.data.map((workspace) => (
              <AdminWorkspaceRow key={workspace.id} workspace={workspace} busy={busy} onEnter={enterWorkspace} />
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          title="平台采集适配器熔断"
          desc="页面结构变化时按平台+适配器版本全局熔断，熔断期间不派发任务。恢复必须已发布更高 mapping_version 并重新实测。"
        />
        {!breakers.data ? <PageLoading /> : breakers.data.breakers.length === 0 ? (
          <Empty title="没有熔断记录" desc="所有适配器版本均正常工作。" />
        ) : (
          <ul className="divide-y divide-mist-100">
            {breakers.data.breakers.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-mist-900">{b.platform}</span>
                    <span className="text-xs text-mist-500">适配器 {b.adapter_version}</span>
                    <Badge tone={b.state === 'open' ? 'red' : 'green'}>
                      {b.state === 'open' ? '熔断中' : '已恢复'}
                    </Badge>
                  </div>
                  <div className="mt-0.5 text-xs text-mist-400">
                    触发 {b.error_code} · 映射版本 {b.mapping_version ?? '—'} · 影响 {b.affected_connections} 个连接 · {fmtTime(b.opened_at)}
                    {b.resolved_at ? ` · 恢复于 ${fmtTime(b.resolved_at)}` : ''}
                  </div>
                  {b.note ? <div className="mt-0.5 text-xs text-mist-400">{b.note}</div> : null}
                </div>
                {b.state === 'open'
                  ? <Button size="sm" disabled={busy} onClick={() => resolveBreaker(b)}>恢复</Button>
                  : null}
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
