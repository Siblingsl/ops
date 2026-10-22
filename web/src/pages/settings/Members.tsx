import { useQuery } from '@tanstack/react-query'
import { Copy, Mail, Plus, UserMinus } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { confirm } from '@/components/dialog'
import { Badge, Button, Card, Empty, Field, Input, Notice, PageHeader, PageLoading, Select } from '@/components/ui'
import { errorMessage, get, patch, post } from '@/lib/api'
import { fmtTime } from '@/lib/format'
import { useInvalidate, useMe } from '@/lib/session'
import type { WorkspaceInvite, WorkspaceMember, WorkspaceRole } from '@/lib/types'
import { useEmbeddedSettings, useSettingsDraft } from '@/lib/desktop-settings'

const ROLE_LABEL: Record<WorkspaceRole, string> = {
  owner: '所有者',
  editor: '编辑者',
  viewer: '观察者',
}

export default function SettingsMembers() {
  const { data: me } = useMe()
  const inv = useInvalidate()
  const isOwner = me?.role === 'owner'
  const embedded = useEmbeddedSettings()
  const members = useQuery({ queryKey: ['members'], queryFn: () => get<WorkspaceMember[]>('/workspaces/current/members') })
  const invites = useQuery({
    queryKey: ['invites'],
    queryFn: () => get<WorkspaceInvite[]>('/workspaces/current/invites'),
    enabled: !!isOwner,
  })
  const [joinCode, setJoinCode] = useState('')
  const [newWsName, setNewWsName] = useState('')
  const [inviteRole, setInviteRole] = useState<'editor' | 'viewer'>('editor')
  const [busy, setBusy] = useState(false)
  const [emailFor, setEmailFor] = useState<Record<string, string>>({})
  const clearDraft = useSettingsDraft(!!(joinCode.trim() || newWsName.trim()) || Object.values(emailFor).some((email) => email.trim()), busy)

  const createWorkspace = async () => {
    const name = newWsName.trim() || '新工作区'
    if (!(await confirm({
      title: `创建「${name}」并切换过去？`,
      desc: '你会成为新工作区的所有者；当前工作区仍保留，可随时切回。',
      confirmText: '创建并切换',
    }))) return
    setBusy(true)
    try {
      await post('/workspaces', { name, switch: true })
      toast.success('已创建并切换')
      clearDraft()
      window.location.assign('/')
    } catch (e) {
      toast.error(errorMessage(e))
      setBusy(false)
    }
  }

  const createInvite = async () => {
    setBusy(true)
    try {
      const created = await post<WorkspaceInvite>('/workspaces/current/invites', { role: inviteRole, max_uses: 10, days: 7 })
      await navigator.clipboard.writeText(created.code).catch(() => undefined)
      toast.success(`邀请码 ${created.code} 已生成（已尝试复制）`)
      inv(['invites'])
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const join = async () => {
    setBusy(true)
    try {
      await post('/workspaces/join', { code: joinCode.trim(), switch: true })
      toast.success('已加入工作区')
      setJoinCode('')
      await inv(['me'], ['accounts'], ['members'])
      clearDraft()
      window.location.assign('/')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const leave = async () => {
    if (!(await confirm({ title: '离开当前工作区？', desc: '离开后需邀请码才能再次加入。', danger: true }))) return
    try {
      const res = await post<{ needs_workspace?: boolean }>('/workspaces/current/leave', {})
      toast.success('已离开')
      if (res.needs_workspace) window.location.assign('/register')
      else {
        await inv(['me'], ['accounts'])
        window.location.assign('/')
      }
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const sendEmail = async (inviteId: string) => {
    const email = (emailFor[inviteId] || '').trim()
    if (!email) {
      toast.error('请填写收件邮箱')
      return
    }
    setBusy(true)
    try {
      const r = await post<{ message: string }>(`/workspaces/current/invites/${inviteId}/send-email`, { email })
      toast.success(r.message || '已发送')
      setEmailFor((m) => ({ ...m, [inviteId]: '' }))
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  if (members.isLoading || !me) return <PageLoading />

  return (
    <div className="max-w-3xl animate-fade-in space-y-6">
      {!embedded && <PageHeader title="成员与邀请" desc={`当前工作区：${me.workspace.name}`} />}

      <div className="grid gap-6 xl:grid-cols-2">
        <Card className="space-y-3 p-5">
          <h2 className="text-sm font-semibold text-mist-800">加入其他工作区</h2>
          <div className="flex flex-wrap gap-2">
            <Input className="h-10 max-w-xs font-mono tracking-wider" placeholder="邀请码" value={joinCode} onChange={(e) => setJoinCode(e.target.value.toUpperCase())} />
            <Button loading={busy} disabled={!joinCode.trim()} onClick={join}>加入并切换</Button>
          </div>
        </Card>

        <Card className="space-y-3 p-5">
          <h2 className="text-sm font-semibold text-mist-800">
            再创建一个工作区
          </h2>
          <div className="flex flex-wrap gap-2">
            <Input className="h-10 max-w-xs" placeholder="工作区名称" value={newWsName} onChange={(e) => setNewWsName(e.target.value)} />
            <Button loading={busy} onClick={() => void createWorkspace()}><Plus className="size-4" /> 创建并切换</Button>
          </div>
        </Card>
      </div>

      <div className={isOwner ? 'grid gap-6 xl:grid-cols-2' : undefined}>
      <Card className="space-y-3 p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-mist-800">成员</h2>
          {me.role !== 'owner' && (
            <Button variant="ghost" size="sm" onClick={leave}><UserMinus className="size-4" /> 离开工作区</Button>
          )}
        </div>
        {(members.data ?? []).length === 0 ? <Empty title="暂无成员" /> : (
          <ul className="divide-y divide-mist-100">
            {(members.data ?? []).map((m) => (
              <li key={m.user_id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div>
                  <div className="font-medium text-mist-900">{m.username}</div>
                  <div className="text-xs text-mist-400">{m.status === 'active' ? '使用中' : '已停用'}</div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {isOwner && m.user_id !== me.user_id ? (
                    <Select
                      className="h-9 w-28"
                      value={m.role}
                      onChange={async (e) => {
                        const role = e.target.value as WorkspaceRole
                        try {
                          await patch(`/workspaces/current/members/${m.user_id}`, { role })
                          toast.success('角色已更新')
                          inv(['members'])
                        } catch (err) {
                          toast.error(errorMessage(err))
                        }
                      }}
                    >
                      <option value="owner">所有者</option>
                      <option value="editor">编辑者</option>
                      <option value="viewer">观察者</option>
                    </Select>
                  ) : (
                    <Badge>{ROLE_LABEL[m.role] || m.role}</Badge>
                  )}
                  {isOwner && m.user_id !== me.user_id && m.status === 'active' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        if (!(await confirm({
                          title: `把所有者转让给 ${m.username}？`,
                          desc: '对方将成为所有者；你变为编辑者，仍可创作但不能改凭证与成员。',
                          danger: true,
                          confirmText: '转让',
                        }))) return
                        try {
                          await post('/workspaces/current/transfer', { user_id: m.user_id })
                          toast.success('已转让所有者')
                          await inv(['me'], ['members'])
                          window.location.reload()
                        } catch (e) {
                          toast.error(errorMessage(e))
                        }
                      }}
                    >
                      转让
                    </Button>
                  )}
                  {isOwner && m.user_id !== me.user_id && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        if (!(await confirm({ title: `移出 ${m.username}？`, desc: '对方将失去对本工作区的访问。', danger: true }))) return
                        try {
                          await patch(`/workspaces/current/members/${m.user_id}`, { remove: true })
                          toast.success('已移出')
                          inv(['members'])
                        } catch (e) {
                          toast.error(errorMessage(e))
                        }
                      }}
                    >
                      移出
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {isOwner && (
        <Card className="space-y-3 p-5">
          <h2 className="text-sm font-semibold text-mist-800">工作区名称</h2>
          <RenameWorkspace name={me.workspace.name} id={me.workspace.id} onDone={() => inv(['me'])} />
        </Card>
      )}
      </div>

      {isOwner ? (
        <Card className="space-y-3 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h2 className="text-sm font-semibold text-mist-800">邀请码</h2>
            <div className="flex flex-nowrap items-center gap-2">
              <Button size="sm" loading={busy} onClick={createInvite}><Plus className="size-4" /> 生成邀请码</Button>
              <Select className="h-9 w-28" value={inviteRole} onChange={(e) => setInviteRole(e.target.value as 'editor' | 'viewer')}>
                <option value="editor">编辑者</option>
                <option value="viewer">观察者</option>
              </Select>
            </div>
          </div>
          <Notice tone="ink">可邀请编辑者或观察者；7 天有效，最多 10 次。也可填写邮箱直接发送（需在「{embedded ? '邀请邮件' : '登录与安全'}」配置 SMTP）。</Notice>
          {(invites.data ?? []).length === 0 ? <Empty title="还没有有效邀请码" desc="生成一个邀请码发给同事，对方注册时填写即可加入这个工作区。"
            action={<Button variant="primary" loading={busy} icon={<Plus className="size-4" />} onClick={createInvite}>生成邀请码</Button>} /> : (
            <ul className="space-y-3">
              {(invites.data ?? []).map((i) => (
                <li key={i.id} className="space-y-2 rounded-xl border border-mist-100 px-3 py-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="font-mono text-lg tracking-widest text-mist-900">{i.code}</div>
                      <div className="text-xs text-mist-400">
                        {ROLE_LABEL[i.role] || i.role} · 已用 {i.used_count}/{i.max_uses} · 到期 {fmtTime(i.expires_at)}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" variant="ghost" onClick={() => { void navigator.clipboard.writeText(i.code); toast.success('已复制') }}>
                        <Copy className="size-4" /> 复制
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={async () => {
                          try {
                            await post(`/workspaces/current/invites/${i.id}/revoke`, {})
                            toast.success('已撤销')
                            inv(['invites'])
                          } catch (e) {
                            toast.error(errorMessage(e))
                          }
                        }}
                      >
                        撤销
                      </Button>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Input
                      className="h-9 max-w-xs"
                      type="email"
                      placeholder="收件邮箱"
                      value={emailFor[i.id] || ''}
                      onChange={(e) => setEmailFor((m) => ({ ...m, [i.id]: e.target.value }))}
                    />
                    <Button size="sm" variant="ghost" loading={busy} onClick={() => sendEmail(i.id)}>
                      <Mail className="size-4" /> 发送邮件
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : (
        <Notice>
          {me.role === 'viewer'
            ? '你是观察者：可浏览，不能修改内容；只有所有者可管理成员与模型/凭证。'
            : '只有工作区所有者可以生成邀请码、管理成员与模型/凭证。'}
        </Notice>
      )}
      {!embedded && <Notice tone="ink">角色差异：所有者管理成员与凭证；编辑者可创作、导出与发布，不能改凭证；观察者只读。</Notice>}

    </div>
  )
}

function RenameWorkspace({ name, id, onDone }: { name: string; id: string; onDone: () => void }) {
  const [v, setV] = useState(name)
  const [busy, setBusy] = useState(false)
  useSettingsDraft(v.trim() !== name, busy)
  return (
    <div className="flex flex-wrap gap-2">
      <Field label="名称" className="min-w-[220px] flex-1">
        <Input value={v} onChange={(e) => setV(e.target.value)} className="h-10" />
      </Field>
      <Button
        className="self-end"
        loading={busy}
        disabled={!v.trim() || v.trim() === name}
        onClick={async () => {
          setBusy(true)
          try {
            await patch(`/workspaces/${id}`, { name: v.trim() })
            toast.success('已更新')
            onDone()
          } catch (e) {
            toast.error(errorMessage(e))
          } finally {
            setBusy(false)
          }
        }}
      >
        保存
      </Button>
    </div>
  )
}
