import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { Badge, Card, CardHeader, Empty, PageLoading, Switch } from '@/components/ui'
import { errorMessage, get, put } from '@/lib/api'
import { useCanWrite, useMe } from '@/lib/session'
import { skillReasonText, skillScopeLabel } from '@/pages/settings/Skills'

// DEV-SK4 / 23 文档第 12.2 节：账号档案「写作技能」分区。
// 公共与我的个人两个可见分区；开关表示有无绑定（不代表定义 active）；
// 调整一项立即保存（单项接口），同区保存中暂禁其他修改；失败恢复服务器值并保留拟修改值。

interface BindingItem {
  binding_id: string
  skill_id: string
  scope: string
  name: string
  priority: number
  created_at: string
  definition_status: string
}

interface SkillPartition {
  base_revision: string
  count: number
  limit: number
  items: BindingItem[]
}

interface SkillBindings {
  account_id: string
  public: SkillPartition
  mine: SkillPartition
}

export default function SkillsTab({ accountId }: { accountId: string }) {
  const canWrite = useCanWrite()
  const me = useMe()
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['skill-bindings', accountId],
    queryFn: () => get<SkillBindings>(`/accounts/${accountId}/skill-bindings`),
  })
  // 上下文预览（任务预算预览 + 智能体可加载目录）。
  const { data: preview } = useQuery({
    queryKey: ['skill-context', accountId],
    queryFn: () => get<{
      context: Record<string, unknown>
      context_status: string
      can_execute: boolean
      budget: number
      assembled_chars: number | null
      items: { id: string; name: string; scope: string; revision: number; selected: boolean; used: boolean; reason: string | null; chars: number }[]
      personal_used_count: number
    }>(`/accounts/${accountId}/skill-context?surface=agent`),
  })
  const [busyKey, setBusyKey] = useState('')
  const [pending, setPending] = useState<Record<string, { enabled?: boolean; priority?: number }>>({})

  if (isLoading || !data) return <PageLoading />
  const mineOnly = me.data?.role === 'viewer'

  const saveBinding = async (audience: 'public' | 'personal', item: BindingItem, enabled: boolean, priority?: number) => {
    const key = audience + item.binding_id
    setBusyKey(key)
    try {
      const body: Record<string, unknown> = { enabled, base_revision: (audience === 'public' ? data!.public : data!.mine).base_revision }
      if (priority !== undefined) body.priority = priority
      await put(`/accounts/${accountId}/skill-bindings/${audience}/${item.skill_id}`, body)
      toast.success(enabled ? '已启用' : '已取消启用')
      setPending((p) => { const n = { ...p }; delete n[key]; return n })
      await refetch()
    } catch (e) {
      // 失败恢复服务器值并保留用户拟修改值（12.2 节）。
      setPending((p) => ({ ...p, [key]: { enabled, priority } }))
      toast.error(errorMessage(e))
    } finally { setBusyKey('') }
  }

  const partition = (audience: 'public' | 'personal') => {
    const part = audience === 'public' ? data!.public : data!.mine
    return (
      <Card key={audience}>
        <CardHeader title={<span className="text-[14px] font-semibold text-ink-800">{audience === 'public' ? '公共技能' : '我的个人技能'}</span>}
          action={<span className="flex items-center gap-2 text-[12px] text-mist-400">{mineOnly && <Badge className="bg-mist-100 text-mist-500">观察者不可修改绑定</Badge>}{part.count} / {part.limit}</span>} />
        {part.items.length === 0 && (
          <Empty title={audience === 'public' ? '还没有为该账号启用公共技能' : '你还没有绑定个人技能'}
            desc="在「设置 → 写作技能」中创建或启用。" />
        )}
        <div className="divide-y divide-mist-100">
          {part.items.map((it) => {
            const key = audience + it.binding_id
            const enabled = pending[key]?.enabled ?? true
            const priority = pending[key]?.priority ?? it.priority
            const disabledDef = it.definition_status !== 'active'
            return (
              <div key={it.binding_id} className="flex items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[13.5px] font-medium text-ink-800">{it.name}</span>
                    <Badge>{skillScopeLabel(it.scope)}</Badge>
                    {disabledDef && <Badge className="bg-mist-100 text-mist-500">已配置，技能已停用</Badge>}
                  </div>
                  <span className="text-[12px] text-mist-400">优先级 {priority}（数值小的先装入）</span>
                </div>
                {canWrite && !mineOnly && (
                  <div className="flex items-center gap-2">
                    <input type="number" min={0} max={999} value={priority} aria-label={`${it.name} 的优先级`}
                      onChange={(e) => setPending((p) => ({ ...p, [key]: { ...p[key], priority: Number(e.target.value) } }))}
                      onBlur={() => { if (priority !== it.priority) void saveBinding(audience, it, true, priority) }}
                      className="h-7 w-16 rounded border border-mist-200 px-1.5 text-[12px] tabular-nums" />
                    <Switch checked={enabled} disabled={busyKey === key}
                      onChange={(v) => void saveBinding(audience, it, v, priority !== it.priority ? priority : undefined)} />
                  </div>
                )}
                {mineOnly && <Badge className="bg-mist-100 text-mist-500">观察者不可修改绑定</Badge>}
              </div>
            )
          })}
        </div>
        {Object.keys(pending).length > 0 && (
          <div className="border-t border-mist-100 px-5 py-2 text-[12px] text-gamboge-700">
            有未保存的修改，保存失败后已恢复服务器值；请重试或放弃修改（刷新页面）。
          </div>
        )}
      </Card>
    )
  }

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader title={<span className="text-[14px] font-semibold text-ink-800">智能体可加载目录</span>}
          action={<span className="text-[12px] text-mist-400">预算 {preview?.budget ?? 3600} 字</span>} />
        <div className="px-5 pb-4 text-[13px]">
          {(!preview || preview.items.length === 0) && (
            <p className="py-2 text-mist-400">当前上下文没有入选技能；启用后按 个人 → 账号 → 工作区 → 内置 顺序装入。</p>
          )}
          {preview?.items.map((it) => (
            <div key={it.id} className="flex flex-wrap items-center gap-2 border-b border-mist-50 py-1.5 last:border-0">
              <span className="font-medium text-ink-700">{it.name}</span>
              <Badge>{skillScopeLabel(it.scope)}</Badge>
              <span className="text-[12px] text-mist-400">v{it.revision}</span>
              <span className="text-[12px] text-mist-400">{it.chars > 0 ? `${it.chars} 字` : skillReasonText(it.reason) || '未加载'}</span>
              {!it.selected && <Badge className="bg-mist-100 text-mist-500">{skillReasonText(it.reason)}</Badge>}
            </div>
          ))}
          {preview && preview.personal_used_count > 0 && (
            <p className="mt-2 text-[12px] text-mist-400">其中个人技能 {preview.personal_used_count} 条（仅本人可见此明细，协作者只见数量）。</p>
          )}
        </div>
      </Card>
      {partition('public')}
      {partition('personal')}
      {mineOnly && <p className="text-[12px] text-mist-400">观察者可以查看绑定配置，但不能修改；个人技能可在「设置 → 写作技能」维护。</p>}
    </div>
  )
}
