import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { SkillWebBoundary } from '@/components/skill-web-boundary'
import { toast } from 'sonner'
import { Badge, Button, Card, CardHeader, Empty, Field, Notice, PageState, Select, Switch, platformFormats } from '@/components/ui'
import { errorMessage, get, getPage, put } from '@/lib/api'
import { skillFormats, skillReasonText, skillScopeLabel, skillTasks, type SkillList } from '@/lib/skills'
import { useAccounts, useCanWrite, useMe } from '@/lib/session'
import { isElectronDesktop } from '@/lib/desktop-presentation.js'

interface BindingItem { binding_id: string; skill_id: string; scope: string; name: string; priority: number; definition_status: string }
interface Partition { base_revision: string; count: number; limit: number; items: BindingItem[] }
interface Bindings { account_id: string; public: Partition; mine: Partition }
interface Preview {
  context_status: string; can_execute: boolean; budget: number; assembled_chars: number | null; personal_used_count: number
  items: { id: string; name: string; scope: string; revision: number; selected: boolean; used: boolean; reason: string | null; chars: number }[]
}

export default function SkillsTab({ accountId }: { accountId: string }) {
  return isElectronDesktop(navigator.userAgent) ? <SkillWebBoundary accountId={accountId} /> : <AccountSkills accountId={accountId} />
}

function AccountSkills({ accountId }: { accountId: string }) {
  const me = useMe()
  const accounts = useAccounts()
  const queryClient = useQueryClient()
  const identity = [me.data?.user_id, me.data?.workspace.id, accountId]
  const bindings = useQuery({ queryKey: ['skill-bindings', ...identity], queryFn: ({ signal }) => get<Bindings>(`/accounts/${accountId}/skill-bindings`, { signal }) })
  const [task, setTask] = useState('title')
  const [workId, setWorkId] = useState('')
  const [format, setFormat] = useState('')
  const account = accounts.data?.find(a => a.id === accountId)
  const works = useInfiniteQuery({
    queryKey: ['skill-preview-works', ...identity], initialPageParam: '',
    queryFn: ({ pageParam, signal }) => getPage<{ id: string; title: string; content_format: string }>(`/accounts/${accountId}/works?limit=50${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`, { signal }),
    getNextPageParam: page => page.meta.hasMore ? page.meta.nextCursor ?? undefined : undefined,
  })
  const previewQuery = (surface: string) => '/accounts/' + accountId + '/skill-context?' + new URLSearchParams({
    surface, ...(surface === 'task' ? { task_type: task } : {}), ...(workId ? { work_id: workId } : format ? { target_format: format } : {}),
  })
  const taskPreview = useQuery({ queryKey: ['skill-context', ...identity, 'task', task, workId, format], queryFn: ({ signal }) => get<Preview>(previewQuery('task'), { signal }) })
  const agentPreview = useQuery({ queryKey: ['skill-context', ...identity, 'agent', workId, format], queryFn: ({ signal }) => get<Preview>(previewQuery('agent'), { signal }) })
  const refresh = async () => {
    await Promise.all([bindings.refetch(), queryClient.invalidateQueries({ queryKey: ['skill-context'] })])
  }
  if (!bindings.data || bindings.error) return <PageState loading={bindings.isPending} error={bindings.error} onRetry={() => void bindings.refetch()} />
  const rows = works.data?.pages.flatMap(p => p.items) ?? []
  const preview = (surface: 'task' | 'agent') => {
    const query = surface === 'task' ? taskPreview : agentPreview
    const data = query.data
    return <Card>
      <CardHeader title={surface === 'task' ? '任务预算预览' : '智能体可加载目录'} action={<span className="text-xs text-mist-400">预算 {data?.budget ?? 3600} 字</span>} />
      <div className="space-y-2 px-5 pb-4 text-sm">
        {(query.isPending || query.error) ? <PageState loading={query.isPending} error={query.error} onRetry={() => void query.refetch()} /> : <>
          {data?.context_status === 'account_disabled' ? <Notice tone="gamboge">账号已停用；配置可维护，生成和加载已暂停。</Notice>
            : data?.context_status === 'task_unsupported' ? <Notice>当前任务不支持技能。</Notice> : <>
              <p className="text-xs text-mist-500">{surface === 'task' ? `预览装配 ${data?.assembled_chars ?? 0} 字；此处是任务预算预览。` : '入选目录不代表模型已经加载；本次已使用以历史调用回执为准。'}</p>
              {data?.items.length === 0 && <p className="text-mist-400">当前上下文没有入选技能，请检查绑定和适用条件。</p>}
              {data?.items.map(item => <div key={item.id} className="flex flex-wrap gap-2 border-b border-mist-100 py-1.5">
                <span>{item.name}</span><Badge>{skillScopeLabel(item.scope)}</Badge><span>v{item.revision}</span>
                <span>{surface === 'task' && item.used ? `预览可装入 ${item.chars} 字` : skillReasonText(item.reason) || '未入选'}</span>
              </div>)}
            </>}
        </>}
      </div>
    </Card>
  }
  return <div className="space-y-5">
    <Card className="space-y-3 p-5"><p className="text-sm text-mist-500">个人 → 账号 → 工作区 → 内置；优先级只调整同层顺序。已配置、当前入选和实际使用分别展示。</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="预览任务"><Select aria-label="预览任务" value={task} onChange={e => setTask(e.target.value)}>{skillTasks.map(t => <option key={t} value={t}>{t}</option>)}</Select></Field>
        <Field label="预览作品"><Select aria-label="预览作品" value={workId} onChange={e => { setWorkId(e.target.value); setFormat('') }}><option value="">账号默认形态</option>{rows.map(w => <option key={w.id} value={w.id}>{w.title}</option>)}</Select></Field>
        <Field label="目标形态"><Select aria-label="目标形态" value={workId ? rows.find(w => w.id === workId)?.content_format ?? '' : format} disabled={!!workId} onChange={e => setFormat(e.target.value)}>
          <option value="">账号默认形态</option>{skillFormats.filter(f => !account || platformFormats[account.platform].some(value => value === f.value)).map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
        </Select></Field>
      </div>
      {works.error && <Notice tone="gamboge">作品列表读取失败。<Button onClick={() => void works.refetch()}>重试作品列表</Button></Notice>}
      {works.hasNextPage && <Button loading={works.isFetchingNextPage} onClick={() => void works.fetchNextPage()}>加载更多作品</Button>}
    </Card>
    {preview('task')}{preview('agent')}
    <BindingPartition key={identity.join(':') + ':public'} accountId={accountId} audience="public" part={bindings.data.public} onSaved={refresh} />
    <BindingPartition key={identity.join(':') + ':personal'} accountId={accountId} audience="personal" part={bindings.data.mine} onSaved={refresh} />
  </div>
}

function BindingPartition({ accountId, audience, part, onSaved }: { accountId: string; audience: 'public' | 'personal'; part: Partition; onSaved: () => Promise<void> }) {
  const me = useMe()
  const canWrite = useCanWrite()
  const [choice, setChoice] = useState('')
  const [busy, setBusy] = useState(false)
  const locked = useRef(false)
  const [drafts, setDrafts] = useState<Record<string, number>>({})
  const [failed, setFailed] = useState<Record<string, { enabled: boolean; priority?: number }>>({})
  const [failure, setFailure] = useState('')
  const personal = audience === 'personal'
  const candidates = useInfiniteQuery({
    queryKey: ['skill-candidates', me.data?.user_id, me.data?.workspace.id, accountId, audience], initialPageParam: '',
    queryFn: ({ pageParam, signal }) => get<SkillList>('/skills?' + new URLSearchParams({ view: 'library', account_id: accountId, ...(personal ? { scope: 'personal' } : {}), ...(pageParam ? { cursor: pageParam } : {}) }), { signal }),
    getNextPageParam: page => page.next_cursor ?? undefined,
  })
  const available = candidates.data?.pages.flatMap(p => p.items).filter(s => (personal ? s.scope === 'personal' : s.scope !== 'personal') && !part.items.some(item => item.skill_id === s.id)) ?? []
  const save = async (skillId: string, enabled: boolean, priority?: number) => {
    if (locked.current || !canWrite) return
    locked.current = true; setBusy(true); setFailure('')
    try {
      await put(`/accounts/${accountId}/skill-bindings/${audience}/${skillId}`, { enabled, base_revision: part.base_revision, ...(enabled && priority !== undefined ? { priority } : {}) })
      setFailed(prev => { const next = { ...prev }; delete next[skillId]; return next })
      setChoice(''); await onSaved(); toast.success(enabled ? '已启用；后续任务重新判定适用性' : '已取消启用')
    } catch (e) {
      setFailure(errorMessage(e)); setFailed(prev => ({ ...prev, [skillId]: { enabled, priority } }))
      await onSaved()
    } finally {
      setDrafts(prev => { const next = { ...prev }; delete next[skillId]; return next })
      locked.current = false; setBusy(false)
    }
  }
  return <Card role="region" aria-label={personal ? '我的个人技能' : '公共技能'}>
    <CardHeader title={personal ? '我的个人技能' : '公共技能'}
      action={<span className="text-xs text-mist-400">{!canWrite && <Badge>观察者不可修改绑定</Badge>} {part.count} / {part.limit}</span>} />
    {part.items.length === 0 && <Empty title={personal ? '你还没有绑定个人技能' : '还没有为该账号启用公共技能'} desc="从下方选择一条技能，单项启用后由各任务判断适用性。" />}
    <div className="divide-y divide-mist-100">{part.items.map(item => <div key={item.skill_id} data-testid={`skill-binding-${item.skill_id}`} className="flex items-center gap-3 px-5 py-3">
      <div className="min-w-0 flex-1"><span className="text-sm font-medium">{item.name}</span> <Badge>{skillScopeLabel(item.scope)}</Badge>
        {item.definition_status !== 'active' && <Badge>已配置，技能已停用</Badge>}<p className="text-xs text-mist-400">优先级 {item.priority}（数值小的先装入）</p></div>
      {canWrite && <><input type="number" min={0} max={999} value={drafts[item.skill_id] ?? item.priority} disabled={busy} aria-label={`${item.name} 的优先级`}
        onChange={e => setDrafts(prev => ({ ...prev, [item.skill_id]: Number(e.target.value) }))}
        onBlur={() => { const value = drafts[item.skill_id]; if (value !== undefined && value !== item.priority) void save(item.skill_id, true, value) }} className="h-7 w-16 rounded border border-mist-200 px-1.5 text-xs" />
        <Switch checked disabled={busy} onChange={value => void save(item.skill_id, value)} /></>}
    </div>)}</div>
    {canWrite && <div className="space-y-2 border-t border-mist-100 p-5">
      <div className="flex gap-2"><Select aria-label={personal ? '选择个人技能' : '选择公共技能'} value={choice} disabled={busy || part.count >= part.limit || !!candidates.error} onChange={e => setChoice(e.target.value)}>
        <option value="">选择一条{personal ? '个人' : '公共'}技能…</option>{available.map(s => <option key={s.id} value={s.id}>{s.name}（{skillScopeLabel(s.scope)}{s.status === 'disabled' ? '，已停用' : ''}）</option>)}
      </Select><Button disabled={busy || !choice || part.count >= part.limit} onClick={() => void save(choice, true)}>启用所选{personal ? '个人' : '公共'}技能</Button></div>
      {candidates.error && <Notice tone="gamboge">候选技能读取失败。<Button onClick={() => void candidates.refetch()}>重试候选技能</Button></Notice>}
      {candidates.hasNextPage && <Button disabled={busy} loading={candidates.isFetchingNextPage} onClick={() => void candidates.fetchNextPage()}>加载更多{personal ? '个人' : '公共'}候选</Button>}
      {part.count >= part.limit && <Notice tone="gamboge">绑定额度已满，请先单项取消已有绑定。</Notice>}
      <div className="flex gap-3 text-xs"><Link to="/settings/skills" className="underline">管理技能库</Link>{!personal && <Link to={`/settings/skills?new=account&account_id=${accountId}`} className="underline">新增账号技能</Link>}</div>
    </div>}
    {failure && <Notice tone="gamboge">{failure}；服务器值已重新读取，拟修改值保留供重试。</Notice>}
    {Object.entries(failed).map(([id, intent]) => <div key={id} className="flex items-center gap-2 px-5 pb-3 text-xs">
      <span>拟修改：{intent.enabled ? '启用' : '取消启用'}{intent.priority !== undefined ? `，优先级 ${intent.priority}` : ''}</span>
      <Button disabled={busy} onClick={() => void save(id, intent.enabled, intent.priority)}>重试这一项</Button><Button disabled={busy} variant="ghost" onClick={() => setFailed(prev => { const next = { ...prev }; delete next[id]; return next })}>放弃修改</Button>
    </div>)}
  </Card>
}
