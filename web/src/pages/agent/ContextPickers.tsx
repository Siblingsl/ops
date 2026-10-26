import { useInfiniteQuery } from '@tanstack/react-query'
import { LoaderCircle, Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Button, Input, Notice, Select } from '@/components/ui'
import { Dialog } from '@/components/dialog'
import { errorMessage, get, post } from '@/lib/api'

export interface AgentContextCandidate {
  id: string
  type: string
  name: string
  summary: string
  scope: string
  account_id: string | null
  work_id?: string | null
  revision: string
  updated_at: string
  url?: string
}

export interface AgentContextSelection extends AgentContextCandidate {
  reference_scope: 'turn' | 'conversation'
}

export interface AgentSkillSelection {
  skill_id: string
  work_id?: string
  name: string
  hint: string
  scope: string
}

interface CandidatePage { items: AgentContextCandidate[]; next_cursor: string | null }
interface SkillOption { id: string; name: string; hint: string; scope: string; revision: number }
interface SkillPage { items: SkillOption[]; next_cursor: string | null; excluded_count: number }
interface PreviewItem extends AgentContextCandidate { status: string; content: string }

const contextTypes = [
  { id: 'work', label: '作品' }, { id: 'material', label: '素材' }, { id: 'topic', label: '选题' },
  { id: 'image', label: '图片' }, { id: 'report', label: '报告' },
]

export function ContextPickerDialog({ open, onClose, accountID, conversationID, selected, onAdd }: {
  open: boolean; onClose: () => void; accountID: string; conversationID?: string
  selected: AgentContextSelection[]; onAdd: (item: AgentContextSelection) => void
}) {
  const [type, setType] = useState('material')
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [referenceScope, setReferenceScope] = useState<'turn' | 'conversation'>('turn')
  const [candidate, setCandidate] = useState<AgentContextCandidate | null>(null)
  const [preview, setPreview] = useState<PreviewItem | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const accountRequired = type !== 'material'
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 250)
    return () => window.clearTimeout(timer)
  }, [search])
  const candidates = useInfiniteQuery({
    queryKey: ['agent-context-candidates', type, accountID, debouncedSearch],
    enabled: open && (!accountRequired || !!accountID),
    initialPageParam: '' as string,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ type, q: debouncedSearch, limit: '20' })
      if (accountID) params.set('account_id', accountID)
      if (pageParam) params.set('cursor', pageParam)
      return get<CandidatePage>(`/agent/context-candidates?${params}`)
    },
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  })
  const items = candidates.data?.pages.flatMap((page) => page.items) ?? []
  const duplicate = candidate && selected.some((item) => item.type === candidate.type && item.id === candidate.id)
  const previewCandidate = async () => {
    if (!candidate || duplicate || previewBusy) return
    setPreviewBusy(true)
    setFailure('')
    setPreview(null)
    try {
      const result = await post<{ items: PreviewItem[] }>('/agent/context-preview', {
        ...(conversationID ? { conversation_id: conversationID } : {}),
        ...(accountID ? { account_id: accountID } : {}),
        context_refs: [{ type: candidate.type, id: candidate.id, revision: candidate.revision, scope: referenceScope }],
        skill_requests: [], attachment_ids: [],
      })
      const item = result.items.find((value) => value.id === candidate.id)
      if (!item || item.status !== 'available') throw new Error('所选资料当前不可用，请重新选择。')
      setPreview(item)
    } catch (error) { setFailure(errorMessage(error)) }
    finally { setPreviewBusy(false) }
  }
  const add = () => {
    if (!candidate || !preview || duplicate) return
    onAdd({ ...candidate, reference_scope: referenceScope })
    setCandidate(null)
    setPreview(null)
    setSearch('')
    onClose()
  }
  return <Dialog open={open} onClose={onClose} title="引用工作区资料" desc="引用会按本对话账号重新鉴权；固定到对话也不会冻结权限。" width="max-w-2xl" footer={<>
    <Button variant="ghost" onClick={onClose}>取消</Button>
    <Button variant="outline" loading={previewBusy} disabled={!candidate || !!duplicate} onClick={() => void previewCandidate()}>预览并校验</Button>
    <Button variant="primary" disabled={!preview || !!duplicate} onClick={add}>添加引用</Button>
  </>}>
    <div className="space-y-3">
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
        <Select aria-label="引用类型" value={type} onChange={(event) => { setType(event.target.value); setCandidate(null); setPreview(null); setFailure('') }}>
          {contextTypes.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </Select>
        <Select aria-label="引用范围" value={referenceScope} onChange={(event) => { setReferenceScope(event.target.value as 'turn' | 'conversation'); setPreview(null) }}>
          <option value="turn">本轮引用</option><option value="conversation">固定到本对话</option>
        </Select>
      </div>
      {accountRequired && !accountID && <Notice tone="gamboge">此类资料需要先选择操作账号。</Notice>}
      <label className="relative block">
        <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-mist-400" />
        <Input aria-label="搜索资料" value={search} onChange={(event) => { setSearch(event.target.value); setCandidate(null); setPreview(null) }} placeholder="搜索名称、摘要或来源" className="pl-9" />
      </label>
      {candidates.isLoading && <p role="status" className="flex items-center gap-2 text-sm text-mist-500"><LoaderCircle className="size-4 animate-spin" />正在读取当前可访问资料…</p>}
      {candidates.isError && <Notice tone="red">{errorMessage(candidates.error)} <button type="button" className="ml-1 underline" onClick={() => void candidates.refetch()}>重试</button></Notice>}
      {!candidates.isLoading && !candidates.isError && <div className="max-h-52 space-y-1 overflow-y-auto rounded-lg border border-mist-200 p-1">
        {items.map((item) => {
          const isSelected = candidate?.id === item.id
          const alreadyAdded = selected.some((ref) => ref.type === item.type && ref.id === item.id)
          return <button key={item.id} type="button" disabled={alreadyAdded} aria-pressed={isSelected} onClick={() => { setCandidate(item); setPreview(null); setFailure('') }} className={`block w-full rounded-md px-3 py-2 text-left disabled:opacity-50 ${isSelected ? 'bg-ink-50 ring-1 ring-ink-300' : 'hover:bg-mist-50'}`}>
            <span className="block truncate text-sm font-medium text-mist-800">{item.name}</span>
            <span className="mt-0.5 block truncate text-xs text-mist-500">{item.summary} · {item.scope === 'workspace' ? '工作区' : '当前账号'} · {item.updated_at ? new Date(item.updated_at).toLocaleString('zh-CN') : '时间未知'}{alreadyAdded ? ' · 已添加' : ''}</span>
          </button>
        })}
        {!items.length && <p className="px-3 py-5 text-center text-sm text-mist-500">没有找到可访问资料。</p>}
        {candidates.hasNextPage && <Button variant="ghost" size="sm" className="w-full" loading={candidates.isFetchingNextPage} onClick={() => void candidates.fetchNextPage()}>加载更多</Button>}
      </div>}
      {candidate && <div className="rounded-lg border border-mist-200 bg-mist-50 p-3">
        <div className="text-xs font-semibold text-mist-600">资料预览</div>
        {preview?.url && <img src={preview.url} alt={preview.name} className="mt-2 max-h-48 max-w-full rounded object-contain" />}
        <p className="mt-2 text-xs text-mist-500">{candidate.name} · {candidate.summary}</p>
        {previewBusy && <p role="status" className="mt-2 flex items-center gap-2 text-xs text-mist-500"><LoaderCircle className="size-3.5 animate-spin" />正在重新鉴权并读取资料…</p>}
        {preview && <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs leading-5 text-mist-700">{preview.content || (preview.type === 'image' ? '图片已授权。发送时将按当前模型看图能力读取。' : '资料可用。')}</pre>}
      </div>}
      {duplicate && <Notice tone="gamboge">这项资料已经在输入台中，不能重复引用。</Notice>}
      {failure && <p role="alert" className="text-sm text-danger">{failure}</p>}
    </div>
  </Dialog>
}

export function SkillPickerDialog({ open, onClose, accountID, selected, workOptions, onAdd }: {
  open: boolean; onClose: () => void; accountID: string; selected: AgentSkillSelection[]
  workOptions: { id: string; name: string }[]; onAdd: (skill: AgentSkillSelection) => void
}) {
  const [workID, setWorkID] = useState('')
  const skills = useInfiniteQuery({
    queryKey: ['agent-effective-skills', accountID, workID],
    enabled: open && !!accountID,
    initialPageParam: '' as string,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ view: 'effective', account_id: accountID, limit: '20' })
      if (workID) params.set('work_id', workID)
      if (pageParam) params.set('cursor', pageParam)
      return get<SkillPage>(`/skills?${params}`)
    },
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  })
  const items = skills.data?.pages.flatMap((page) => page.items) ?? []
  const excluded = skills.data?.pages[0]?.excluded_count ?? 0
  const selectedIDs = useMemo(() => new Set(selected.map((item) => `${item.skill_id}:${item.work_id ?? ''}`)), [selected])
  return <Dialog open={open} onClose={onClose} title="请求使用技能" desc="这里只列当前账号与作品上下文的有效技能；选择不会启用或加载技能。" width="max-w-xl">
    {!accountID ? <Notice tone="gamboge">先选择操作账号，再从它当前的有效技能集中选择。</Notice> : <div className="space-y-3">
      {workOptions.length > 0 && <Select aria-label="技能作品上下文" value={workID} onChange={(event) => setWorkID(event.target.value)}>
        <option value="">账号默认上下文</option>{workOptions.map((work) => <option key={work.id} value={work.id}>{work.name}</option>)}
      </Select>}
      {skills.isLoading && <p role="status" className="flex items-center gap-2 text-sm text-mist-500"><LoaderCircle className="size-4 animate-spin" />正在解析当前有效技能…</p>}
      {skills.isError && <Notice tone="red">{errorMessage(skills.error)} <button type="button" className="ml-1 underline" onClick={() => void skills.refetch()}>重试</button></Notice>}
      {!skills.isLoading && !skills.isError && <div className="max-h-72 space-y-1 overflow-y-auto rounded-lg border border-mist-200 p-1">
        {items.map((item) => {
          const key = `${item.id}:${workID}`
          const alreadyAdded = selectedIDs.has(key)
          return <div key={item.id} className="flex items-start gap-3 rounded-md px-3 py-2 hover:bg-mist-50">
            <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium text-mist-800">{item.name}</div><p className="mt-0.5 text-xs text-mist-500">{item.hint} · {item.scope === 'personal' ? '个人技能' : '共享技能'}</p></div>
            <Button size="sm" variant={alreadyAdded ? 'ghost' : 'outline'} disabled={alreadyAdded || selected.length >= 3} onClick={() => { onAdd({ skill_id: item.id, ...(workID ? { work_id: workID } : {}), name: item.name, hint: item.hint, scope: item.scope }); onClose() }}>{alreadyAdded ? '已请求' : '请求使用'}</Button>
          </div>
        })}
        {!items.length && <p className="px-3 py-5 text-center text-sm text-mist-500">当前上下文没有有效技能。</p>}
        {skills.hasNextPage && <Button variant="ghost" size="sm" className="w-full" loading={skills.isFetchingNextPage} onClick={() => void skills.fetchNextPage()}>加载更多</Button>}
      </div>}
      {excluded > 0 && <Notice tone="gamboge">另有 {excluded} 项技能未进入当前有效集；请求入口不会启用或提升它们。<a className="ml-1 underline" href="/settings/skills">查看技能设置</a></Notice>}
    </div>}
  </Dialog>
}
