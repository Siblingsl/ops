import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { Dialog } from '@/components/dialog'
import { SkillWebBoundary } from '@/components/skill-web-boundary'
import { Badge, Button, Card, CardHeader, Empty, Input, PageHeader, PageState, Tabs } from '@/components/ui'
import { api, errorMessage, get, rawRequest } from '@/lib/api'
import { emptySkillForm, skillFields, skillScopeLabel, type SkillDefinition, type SkillForm, type SkillImpact, type SkillList } from '@/lib/skills'
import { useAccounts, useMe } from '@/lib/session'
import { isElectronDesktop } from '@/lib/desktop-presentation.js'
import SkillEditor from './SkillEditor'

export default function Skills() {
  return isElectronDesktop(navigator.userAgent) ? <SkillWebBoundary /> : <SkillsLibrary />
}

/**
 * exportSkill 走 rawRequest 取 blob 再触发下载（D-153）。
 * 直接给 <a href download> 在跨源部署时既不会带会话 Cookie，也读不到 Content-Disposition，
 * 因此统一改走带凭据的请求。
 */
async function exportSkill(id: string) {
  try {
    const res = await rawRequest('GET', `/skills/${id}/export`)
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = '写作技能.md'
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 4000)
  } catch (e) {
    toast.error(errorMessage(e))
  }
}

function SkillsLibrary() {
  const me = useMe()
  const accounts = useAccounts()
  const [params] = useSearchParams()
  const queryClient = useQueryClient()
  const identity = [me.data?.user_id, me.data?.workspace.id]
  const [tab, setTab] = useState('all')
  const [q, setQ] = useState('')
  const [accountFilter, setAccountFilter] = useState('')
  const [creating, setCreating] = useState<SkillForm | null>(() => params.get('new') === 'account' && params.get('account_id')
    ? { ...emptySkillForm(), scope: 'account', account_id: params.get('account_id') } : null)
  const [selected, setSelected] = useState<{ id: string; mode: 'view' | 'edit' | 'copy' } | null>(null)
  const list = useInfiniteQuery({
    queryKey: ['skills', ...identity, tab, q, accountFilter], initialPageParam: '',
    queryFn: ({ pageParam, signal }) => get<SkillList>('/skills?' + new URLSearchParams({
      view: 'library', limit: '12', ...(tab !== 'all' ? { scope: tab } : {}), q,
      ...(tab === 'account' && accountFilter ? { account_id: accountFilter } : {}), ...(pageParam ? { cursor: pageParam } : {}),
    }), { signal }),
    getNextPageParam: page => page.next_cursor ?? undefined,
  })
  const refresh = async () => {
    setCreating(null); setSelected(null)
    for (const key of ['skills', 'skill-bindings', 'skill-context', 'skill-quota', 'skill-definition']) await queryClient.invalidateQueries({ queryKey: [key] })
  }
  const canEdit = (skill: SkillDefinition) => skill.scope !== 'builtin' && (skill.scope === 'personal' || me.data?.role === 'owner' || me.data?.role === 'editor')
  return (
    <div className="animate-fade-in">
      <PageHeader title="写作技能" desc="可复用的创作指令包：按账号启用后进入 AI 生成与智能体。个人技能仅本人可见、跨工作区携带，需在每个账号分别启用。"
        action={<Button variant="primary" onClick={() => setCreating(emptySkillForm())}><Plus className="size-4" />新建技能</Button>} />
      <Card>
        <CardHeader title={<Tabs value={tab} onChange={setTab} items={[
          { value: 'all', label: '全部' }, { value: 'personal', label: '我的技能' }, { value: 'workspace', label: '工作区' },
          { value: 'account', label: '账号' }, { value: 'builtin', label: '内置' },
        ]} />} action={<div className="flex items-center gap-2">
          {tab === 'account' && <select aria-label="账号" value={accountFilter} onChange={e => setAccountFilter(e.target.value)} className="h-8 rounded border border-mist-200 text-[13px]">
            <option value="">选择账号查看专属技能</option>{accounts.data?.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>}
          <div className="relative w-44"><Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-mist-400" />
            <Input value={q} onChange={e => setQ(e.target.value)} placeholder="搜索名称、用途、触发" className="h-8 pl-8 text-[13px]" /></div>
        </div>} />
        {(list.isPending || list.error) && <PageState loading={list.isPending} error={list.error} onRetry={() => void list.refetch()} />}
        <div className="divide-y divide-mist-100">
          {!list.isPending && !list.error && list.data?.pages[0].total === 0 && <Empty title="还没有匹配的技能" desc="新建一条个人技能，或从内置技能另存为副本。" />}
          {list.data?.pages.flatMap(p => p.items).map(skill => (
            <div key={skill.id} className="flex items-start gap-3 px-5 py-3.5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2"><span className="text-[14px] font-medium text-ink-800">{skill.name}</span>
                  <Badge>{skillScopeLabel(skill.scope)}</Badge>{skill.status === 'disabled' && <Badge>已停用</Badge>}
                  {skill.origin === 'imported' && <Badge>导入</Badge>}{skill.origin === 'copied' && <Badge>另存</Badge>}
                  <span className="text-[12px] text-mist-400">v{skill.revision}</span></div>
                <p className="mt-0.5 truncate text-[13px] text-mist-500">{skill.summary}</p>
                <p className="mt-0.5 truncate text-[12px] text-mist-400">触发：{skill.triggers}</p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-1">
                <Button variant="ghost" size="sm" onClick={() => setSelected({ id: skill.id, mode: 'view' })}>查看详情</Button>
                <Button variant="ghost" size="sm" onClick={() => setSelected({ id: skill.id, mode: 'copy' })}>另存副本</Button>
                <button type="button" title="导出 .md" onClick={() => void exportSkill(skill.id)} className="rounded p-1.5 text-mist-400 hover:bg-mist-100"><Download className="size-4" /></button>
                {canEdit(skill) && <button type="button" title="编辑" onClick={() => setSelected({ id: skill.id, mode: 'edit' })} className="rounded p-1.5 text-mist-400 hover:bg-mist-100"><Pencil className="size-4" /></button>}
                {canEdit(skill) && <DeleteSkillButton skill={skill} onDeleted={() => void refresh()} />}
              </div>
            </div>
          ))}
        </div>
        {list.hasNextPage && <div className="border-t border-mist-100 px-5 py-2.5 text-center">
          <Button variant="ghost" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>加载更多（共 {list.data?.pages[0].total} 条）</Button>
        </div>}
      </Card>
      {creating && <SkillEditor key={identity.join(':')} initial={creating} fixedAccount={creating.scope === 'account' && params.get('new') === 'account' ? params.get('account_id') ?? undefined : undefined} onClose={() => setCreating(null)} onSaved={() => void refresh()} />}
      {selected && <SkillDefinitionDialog key={[...identity, selected.id, selected.mode].join(':')} id={selected.id} mode={selected.mode} onClose={() => setSelected(null)} onCopy={() => setSelected({ ...selected, mode: 'copy' })} onSaved={() => void refresh()} />}
    </div>
  )
}

function SkillDefinitionDialog({ id, mode, onClose, onCopy, onSaved }: {
  id: string; mode: 'view' | 'edit' | 'copy'; onClose: () => void; onCopy: () => void; onSaved: () => void
}) {
  const me = useMe()
  const detail = useQuery({ queryKey: ['skill-definition', me.data?.user_id, me.data?.workspace.id, id], queryFn: ({ signal }) => get<SkillDefinition>(`/skills/${id}`, { signal }), staleTime: 0, refetchOnWindowFocus: false })
  if (!detail.data || detail.error || detail.isFetching) return <Dialog open onClose={onClose} title="读取技能"><PageState loading={detail.isFetching} error={detail.error} onRetry={() => void detail.refetch()} /></Dialog>
  const def = detail.data
  if (mode !== 'view') return <SkillEditor def={mode === 'edit' ? def : undefined} copyFrom={mode === 'copy' ? def : undefined}
    initial={{ ...skillFields(def), status: mode === 'edit' ? def.status : 'active', scope: mode === 'edit' ? def.scope : 'personal', account_id: mode === 'edit' ? def.account_id : '' }} onClose={onClose} onSaved={onSaved} />
  return <Dialog open onClose={onClose} title="技能详情" ariaLabel="技能详情" width="max-w-2xl" footer={<Button onClick={onCopy}>另存副本</Button>}>
    <div className="space-y-3 text-sm"><h2 className="font-semibold">{def.name}</h2><p>{skillScopeLabel(def.scope)} · v{def.revision} · {def.status === 'active' ? '启用中' : '已停用'}</p>
      <p>用途：{def.summary}</p><p>触发：{def.triggers}</p><p>平台：{def.platforms.join('、') || '全部'}；形态：{def.content_formats.join('、') || '全部'}；任务：{def.task_types.join('、') || '默认创作集合'}</p>
      <pre className="whitespace-pre-wrap break-words rounded bg-mist-50 p-3 font-sans">{def.instructions}</pre>
      <p>{def.task_enabled ? '生成入口已开启' : '生成入口已关闭'}；{def.agent_enabled ? '智能体入口已开启' : '智能体入口已关闭'}</p>
    </div>
  </Dialog>
}

function DeleteSkillButton({ skill, onDeleted }: { skill: SkillDefinition; onDeleted: () => void }) {
  const [open, setOpen] = useState(false)
  const [impact, setImpact] = useState<SkillImpact | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const load = async () => {
    setOpen(true); setImpact(null); setFailure('')
    try { setImpact(await get(`/skills/${skill.id}/impact?action=delete`)) } catch (e) { setFailure(errorMessage(e)) }
  }
  const remove = async () => {
    if (!impact || busy) return
    setBusy(true)
    try {
      await api('DELETE', `/skills/${skill.id}?` + new URLSearchParams({ confirm: 'true', base_revision: String(impact.base_revision), impact_token: impact.impact_token }))
      toast.success('技能已删除'); setOpen(false); onDeleted()
    } catch (e) { setFailure(errorMessage(e)); setImpact(null) } finally { setBusy(false) }
  }
  return <>
    <button type="button" title="删除" onClick={() => void load()} className="rounded p-1.5 text-mist-400 hover:bg-mist-100 hover:text-red-600"><Trash2 className="size-4" /></button>
    <Dialog open={open} onClose={() => { if (!busy) setOpen(false) }} title="删除技能" ariaLabel="删除技能" footer={<>
      <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>取消</Button><Button variant="primary" loading={busy} disabled={!impact} onClick={() => void remove()}>确认删除</Button>
    </>}>
      {impact ? <p>将删除「{skill.name}」的 {impact.affected_bindings} 条绑定，影响 {impact.accounts.map(a => a.name).join('、') || '无绑定账号'}。已生成的作品不受影响。此操作不可撤销。</p>
        : <PageState loading={!failure} error={failure || undefined} onRetry={() => void load()} />}
    </Dialog>
  </>
}
