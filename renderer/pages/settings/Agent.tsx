import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Plus, Power, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { CapabilityGapList } from '@/components/capability-gap-list'
import { Dialog } from '@/components/dialog'
import { Badge, Button, Card, CardHeader, Empty, Field, Input, Notice, PageHeader, PageState, roleReadOnlyHint, Switch, Textarea } from '@/components/ui'
import { del, errorMessage, get, patch, post, put } from '@/lib/api'
import type { AgentRole } from '@/lib/agent'
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

interface RoleForm {
  name: string
  persona: string
  allowlist: string
  max_rounds: string
  max_seconds: string
}

const emptyRoleForm: RoleForm = { name: '', persona: '', allowlist: '', max_rounds: '8', max_seconds: '180' }

function roleFormOf(role: AgentRole | null): RoleForm {
  if (!role) return { ...emptyRoleForm }
  return {
    name: role.name,
    persona: role.persona,
    allowlist: role.tool_allowlist.join('\n'),
    max_rounds: String(role.max_rounds),
    max_seconds: String(role.max_seconds),
  }
}

function AgentRoleManager({ owner }: { owner: boolean }) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState<AgentRole | null | undefined>(undefined)
  const [form, setForm] = useState<RoleForm>(emptyRoleForm)
  const roles = useQuery({ queryKey: ['agent-roles'], queryFn: () => get<{ roles: AgentRole[] }>('/agent-roles') })
  const refresh = () => qc.invalidateQueries({ queryKey: ['agent-roles'] })
  const save = useMutation({
    mutationFn: async () => {
      const body = {
        name: form.name.trim(),
        persona: form.persona,
        tool_allowlist: form.allowlist.split('\n').map((item) => item.trim()).filter(Boolean),
        max_rounds: Number(form.max_rounds),
        max_seconds: Number(form.max_seconds),
      }
      if (editing) return patch<{ role: AgentRole }>(`/agent-roles/${editing.id}`, body)
      return post<{ role: AgentRole }>('/agent-roles', body)
    },
    onSuccess: async () => {
      setEditing(undefined)
      await refresh()
      toast.success('角色已保存')
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const toggle = useMutation({
    mutationFn: (role: AgentRole) => patch<{ role: AgentRole }>(`/agent-roles/${role.id}`, { status: role.status === 'active' ? 'disabled' : 'active' }),
    onSuccess: async () => {
      await refresh()
      toast.success('角色状态已更新')
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const remove = useMutation({
    mutationFn: (role: AgentRole) => del<{ ok: boolean }>(`/agent-roles/${role.id}`),
    onSuccess: async () => {
      await refresh()
      toast.success('角色已删除')
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const openCreate = () => {
    setForm({ ...emptyRoleForm })
    setEditing(null)
  }
  const openEdit = (role: AgentRole) => {
    setForm(roleFormOf(role))
    setEditing(role)
  }
  const canSave = form.name.trim().length > 0 && !save.isPending
  return (
    <Card data-testid="agent-role-manager">
      <CardHeader title="执行角色" desc="角色决定对话可用的工具白名单与单轮预算；内置角色只能停用，不能删除。" action={owner
        ? <Button size="sm" variant="primary" data-testid="agent-role-create" onClick={openCreate}><Plus className="size-3.5" />新建角色</Button>
        : undefined} />
      {roles.isLoading && <PageState loading onRetry={() => void roles.refetch()} />}
      {!roles.isLoading && roles.error && <PageState loading={false} error={roles.error} onRetry={() => void roles.refetch()} />}
      {!roles.isLoading && !roles.error && (roles.data?.roles.length ?? 0) === 0 && <Empty title="还没有角色" desc="内置角色会在工作区创建时自动生成；也可以新建自定义角色。" />}
      <div className="divide-y divide-mist-100">
        {roles.data?.roles.map((role) => <div key={role.id} data-testid={`agent-role-row-${role.id}`} className="px-5 py-3.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13.5px] font-medium text-mist-800">{role.name}</span>
            {role.builtin_key && <Badge tone="blue">内置</Badge>}
            <Badge tone={role.status === 'active' ? 'green' : 'gray'}>{role.status === 'active' ? '生效' : '已停用'}</Badge>
            <span className="text-[12px] text-mist-400">轮数 {role.max_rounds} / 秒数 {role.max_seconds}</span>
            <div className="ml-auto flex items-center gap-1.5">
              <Button size="sm" variant="ghost" data-testid={`agent-role-edit-${role.id}`} disabled={!owner || save.isPending} disabledHint={roleReadOnlyHint.owner} onClick={() => openEdit(role)}><Pencil className="size-3.5" />编辑</Button>
              <Button size="sm" variant="ghost" data-testid={`agent-role-toggle-${role.id}`} disabled={!owner || toggle.isPending} disabledHint={roleReadOnlyHint.owner} onClick={() => toggle.mutate(role)}><Power className="size-3.5" />{role.status === 'active' ? '停用' : '启用'}</Button>
              {!role.builtin_key && <Button size="sm" variant="ghost" data-testid={`agent-role-delete-${role.id}`} disabled={!owner || remove.isPending} disabledHint={roleReadOnlyHint.owner} onClick={() => { if (window.confirm(`删除角色「${role.name}」？`)) remove.mutate(role) }}><Trash2 className="size-3.5" />删除</Button>}
            </div>
          </div>
          {role.persona && <p className="mt-1 text-[12.5px] leading-relaxed text-mist-500">{role.persona}</p>}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {role.tool_allowlist.length === 0 ? <span className="text-[12px] text-mist-400">未授予工具，不能执行任何工具调用</span>
              : role.tool_allowlist.map((tool) => <code key={tool} className="rounded bg-mist-100 px-1.5 py-0.5 text-[11.5px] text-mist-600">{tool}</code>)}
          </div>
        </div>)}
      </div>
      {editing !== undefined && <Dialog open onClose={() => { if (!save.isPending) setEditing(undefined) }} title={editing ? `编辑角色：${editing.name}` : '新建角色'} ariaLabel="角色编辑" width="max-w-xl" footer={<>
        <Button variant="ghost" onClick={() => setEditing(undefined)} disabled={save.isPending}>取消</Button>
        <Button variant="primary" data-testid="agent-role-save" loading={save.isPending} disabled={!canSave} onClick={() => save.mutate()}>保存</Button>
      </>}>
        <div className="space-y-4" data-testid="agent-role-form">
          <Field label="角色名" required hint="1–30 字；同工作区不可重名">
            <Input data-testid="agent-role-name" value={form.name} maxLength={30} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="例如：发布核对员" />
          </Field>
          <Field label="人设" hint="可选，最多 800 字；会进入角色对话的系统提示">
            <Textarea data-testid="agent-role-persona" value={form.persona} maxLength={800} rows={3} onChange={(e) => setForm({ ...form, persona: e.target.value })} placeholder="描述这个角色的关注点与工作方式" />
          </Field>
          <Field label="工具白名单" hint="一行一个；前缀以 __ 结尾（如 topics__），* 结尾也可；留空表示不授予任何工具">
            <Textarea data-testid="agent-role-tools" value={form.allowlist} rows={4} onChange={(e) => setForm({ ...form, allowlist: e.target.value })} placeholder={'topics__\nworks__get\nreview__'} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="最大轮数" hint="1–30；与全局预算取小">
              <Input data-testid="agent-role-rounds" type="number" min={1} max={30} value={form.max_rounds} onChange={(e) => setForm({ ...form, max_rounds: e.target.value })} />
            </Field>
            <Field label="最大秒数" hint="30–900；与全局预算取小">
              <Input data-testid="agent-role-seconds" type="number" min={30} max={900} value={form.max_seconds} onChange={(e) => setForm({ ...form, max_seconds: e.target.value })} />
            </Field>
          </div>
        </div>
      </Dialog>}
    </Card>
  )
}

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
              <Switch label={option.title} checked={settings[option.key]} disabled={!owner || save.isPending} disabledHint={roleReadOnlyHint.owner} onChange={(value) => save.mutate({ [option.key]: value })} />
            </div>)}
          </div>
        </Card>
        <AgentRoleManager owner={owner} />
        <CapabilityGapList owner={owner} />
      </>}
    </div>
  )
}
