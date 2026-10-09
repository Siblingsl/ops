import { useQuery } from '@tanstack/react-query'
import { Copy, Plus, UserMinus } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { confirm } from '@/components/dialog'
import { Badge, Button, Card, Empty, Field, Input, Notice, PageHeader, PageLoading } from '@/components/ui'
import { errorMessage, get, patch, post } from '@/lib/api'
import { fmtTime } from '@/lib/format'
import { useInvalidate, useMe } from '@/lib/session'
import type { WorkspaceInvite, WorkspaceMember } from '@/lib/types'

export default function SettingsMembers() {
  const { data: me } = useMe()
  const inv = useInvalidate()
  const isOwner = me?.role === 'owner'
  const members = useQuery({ queryKey: ['members'], queryFn: () => get<WorkspaceMember[]>('/workspaces/current/members') })
  const invites = useQuery({
    queryKey: ['invites'],
    queryFn: () => get<WorkspaceInvite[]>('/workspaces/current/invites'),
    enabled: !!isOwner,
  })
  const [joinCode, setJoinCode] = useState('')
  const [busy, setBusy] = useState(false)

  const createInvite = async () => {
    setBusy(true)
    try {
      const created = await post<WorkspaceInvite>('/workspaces/current/invites', { role: 'editor', max_uses: 10, days: 7 })
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

  if (members.isLoading || !me) return <PageLoading />

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <PageHeader title="成员与邀请" desc={`当前工作区：${me.workspace.name}`} />

      <Card className="space-y-3 p-5">
        <h2 className="text-sm font-semibold text-mist-800">加入其他工作区</h2>
        <div className="flex flex-wrap gap-2">
          <Input className="h-10 max-w-xs font-mono tracking-wider" placeholder="邀请码" value={joinCode} onChange={(e) => setJoinCode(e.target.value.toUpperCase())} />
          <Button loading={busy} disabled={!joinCode.trim()} onClick={join}>加入并切换</Button>
        </div>
      </Card>

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
              <li key={m.user_id} className="flex items-center justify-between gap-3 py-3">
                <div>
                  <div className="font-medium text-mist-900">{m.username}</div>
                  <div className="text-xs text-mist-400">{m.status === 'active' ? '使用中' : '已停用'}</div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge>{m.role === 'owner' ? '所有者' : '编辑者'}</Badge>
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

      {isOwner ? (
        <Card className="space-y-3 p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-mist-800">邀请码</h2>
            <Button size="sm" loading={busy} onClick={createInvite}><Plus className="size-4" /> 生成邀请码</Button>
          </div>
          <Notice tone="ink">默认角色为编辑者，7 天有效，最多 10 次。把邀请码发给对方即可。</Notice>
          {(invites.data ?? []).length === 0 ? <Empty title="还没有有效邀请码" /> : (
            <ul className="space-y-2">
              {(invites.data ?? []).map((i) => (
                <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-mist-100 px-3 py-2.5">
                  <div>
                    <div className="font-mono text-lg tracking-widest text-mist-900">{i.code}</div>
                    <div className="text-xs text-mist-400">
                      {i.role === 'owner' ? '所有者' : '编辑者'} · 已用 {i.used_count}/{i.max_uses} · 到期 {fmtTime(i.expires_at)}
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
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : (
        <Notice>只有工作区所有者可以生成邀请码、管理成员与模型/凭证。</Notice>
      )}

      {isOwner && (
        <Card className="space-y-3 p-5">
          <h2 className="text-sm font-semibold text-mist-800">工作区名称</h2>
          <RenameWorkspace name={me.workspace.name} id={me.workspace.id} onDone={() => inv(['me'])} />
        </Card>
      )}
    </div>
  )
}

function RenameWorkspace({ name, id, onDone }: { name: string; id: string; onDone: () => void }) {
  const [v, setV] = useState(name)
  const [busy, setBusy] = useState(false)
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
