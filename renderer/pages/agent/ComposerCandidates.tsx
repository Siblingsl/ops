import { useQuery } from '@tanstack/react-query'
import { LoaderCircle, Search } from 'lucide-react'
import { type KeyboardEvent, useEffect, useMemo, useState } from 'react'
import { get } from '@/lib/api'
import { type AgentCommand, type ComposerTrigger, matchCommands } from '@/lib/agent-ui.js'
import type { AgentContextSelection, AgentSkillSelection } from './ContextPickers'

interface Candidate { id: string; type: string; name: string; summary: string; revision: string; scope: string; account_id: string | null }
interface CandidatePage { items: Candidate[]; next_cursor: string | null }
interface SkillOption { id: string; name: string; hint: string; scope: string }
interface SkillPage { items: SkillOption[]; next_cursor: string | null; excluded_count: number }

const TABS = [
  { id: 'all', label: '全部' }, { id: 'work', label: '作品' }, { id: 'material', label: '素材' },
  { id: 'topic', label: '选题' }, { id: 'image', label: '图片' }, { id: 'report', label: '报告' },
]
const ACCOUNT_REQUIRED = new Set(['work', 'topic', 'image', 'report'])

// IX-01/02/03：一个浮层三个触发器，键盘在浮层内完成选择；不把候选写进消息正文。
export function ComposerCandidates({
  trigger, accountID, contextRefs, skillRequests, onAddContext, onAddSkill, onCommand, onClose,
}: {
  trigger: ComposerTrigger
  accountID: string
  contextRefs: AgentContextSelection[]
  skillRequests: AgentSkillSelection[]
  onAddContext: (item: AgentContextSelection) => boolean
  onAddSkill: (item: AgentSkillSelection) => boolean
  onCommand: (command: AgentCommand) => void
  onClose: () => void
}) {
  const [tab, setTab] = useState('all')
  const [search, setSearch] = useState(trigger.query)
  const [debounced, setDebounced] = useState(trigger.query)
  const [hint, setHint] = useState('')
  const [active, setActive] = useState(0)
  useEffect(() => { setActive(0) }, [debounced, tab, trigger.kind])
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(search.trim()), 250)
    return () => window.clearTimeout(timer)
  }, [search])
  const effectiveTab = tab
  const needsAccount = trigger.kind === 'at' && ACCOUNT_REQUIRED.has(effectiveTab) && !accountID
  const candidates = useQuery({
    queryKey: ['agent-composer-candidates', effectiveTab, accountID, debounced, trigger.kind],
    enabled: trigger.kind === 'at' && !needsAccount,
    queryFn: async () => {
      const types = effectiveTab === 'all' ? ['work', 'material', 'topic', 'image', 'report'] : [effectiveTab]
      const pages = await Promise.all(types.map((type) => {
        if (ACCOUNT_REQUIRED.has(type) && !accountID) return Promise.resolve({ items: [] as Candidate[] })
        const params = new URLSearchParams({ type, q: debounced, limit: effectiveTab === 'all' ? '3' : '10' })
        if (accountID) params.set('account_id', accountID)
        return get<CandidatePage>(`/agent/context-candidates?${params}`).then((page) => ({ items: page.items }))
      }))
      return pages.flatMap((page) => page.items)
    },
    refetchOnWindowFocus: false,
  })
  const skills = useQuery({
    queryKey: ['agent-composer-skills', accountID, debounced, trigger.kind],
    enabled: trigger.kind === 'skill' && !!accountID,
    queryFn: async () => {
      const params = new URLSearchParams({ view: 'effective', account_id: accountID, limit: '10' })
      if (debounced) params.set('q', debounced)
      return get<SkillPage>(`/skills?${params}`)
    },
    refetchOnWindowFocus: false,
  })
  const commands = useMemo(() => matchCommands(debounced), [debounced])
  const items = useMemo(() => {
    if (trigger.kind === 'slash') return commands
    if (trigger.kind === 'skill') return skills.data?.items ?? []
    return candidates.data ?? []
  }, [commands, candidates.data, skills.data?.items, trigger.kind])
  const loading = trigger.kind === 'slash' ? false : trigger.kind === 'skill' ? skills.isLoading : candidates.isLoading
  const failed = trigger.kind === 'slash' ? false : trigger.kind === 'skill' ? skills.isError : candidates.isError
  const accountMissing = trigger.kind === 'skill' && !accountID

  const choose = (index: number, pin = false) => {
    const item = items[index]
    if (!item) return
    if (trigger.kind === 'slash') { onCommand(item as AgentCommand); onClose(); return }
    if (trigger.kind === 'skill') {
      const skill = item as SkillOption
      if (!onAddSkill({ skill_id: skill.id, name: skill.name, hint: skill.hint, scope: skill.scope })) {
        setHint('已选 3 个技能，先移除一个再添加。')
        return
      }
      onClose()
      return
    }
    const candidate = item as Candidate
    if (!onAddContext({ ...candidate, reference_scope: pin ? 'conversation' : 'turn' } as AgentContextSelection)) {
      setHint(contextRefs.length >= 12 ? '本轮引用最多 12 项，先移除一个。' : '这项资料已经在输入台中。')
      return
    }
    onClose()
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive((value) => Math.min(items.length - 1, value + 1)) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((value) => Math.max(0, value - 1)) }
    else if (event.key === 'Enter') { event.preventDefault(); choose(active, event.shiftKey) }
    else if (event.key === 'Tab') { event.preventDefault(); choose(active) }
    else if (event.key === 'Escape') { event.preventDefault(); onClose() }
  }

  return <div className="agent-composer-candidates" role="dialog" aria-label="输入候选" data-trigger={trigger.kind}>
    <div className="agent-composer-candidates-head">
      {
        trigger.kind === 'at'
          ? <div className="agent-composer-tabs" role="tablist" aria-label="引用类型">
            {TABS.map((item) => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id}
              className={tab === item.id ? 'is-active' : ''} onClick={() => { setTab(item.id); setHint('') }}>{item.label}</button>)}
          </div>
          : <span className="agent-composer-candidates-title">{trigger.kind === 'slash' ? '命令' : '请求使用技能'}</span>
      }
      <label className="agent-composer-search">
        <Search aria-hidden="true" />
        <input aria-label="筛选候选" value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={onKeyDown}
          placeholder={trigger.kind === 'skill' ? '搜索技能' : trigger.kind === 'slash' ? '输入命令名' : '搜索名称或摘要'} autoFocus />
      </label>
    </div>
    {needsAccount && <p className="agent-composer-empty">先选择运营账号，才能读取作品、素材和选题。</p>}
    {accountMissing && <p className="agent-composer-empty">先选择运营账号，再从它当前的有效技能集中选择。</p>}
    {loading && <p className="agent-composer-empty" role="status"><LoaderCircle className="size-3.5 animate-spin" />正在读取可访问资料…</p>}
    {failed && <p className="agent-composer-empty" role="alert">读取失败，请稍后重试。</p>}
    {!loading && !failed && !needsAccount && !accountMissing && items.length === 0 && <p className="agent-composer-empty">
      {trigger.kind === 'skill' ? '当前上下文没有有效技能。' : trigger.kind === 'slash' ? '没有匹配的固定命令。' : '没有找到可访问资料。'}
    </p>}
    {!loading && !needsAccount && !accountMissing && <div className="agent-composer-list">
      {items.map((raw, index) => {
        if (trigger.kind === 'slash') {
          const command = raw as AgentCommand
          return <div key={command.name} role="option" aria-selected={index === active}
            className={`agent-composer-row${index === active ? ' is-active' : ''}`}
            onMouseEnter={() => setActive(index)} onClick={() => choose(index)}>
            <div className="agent-composer-row-main"><span className="agent-composer-row-name">{command.label}</span>
              <span className="agent-composer-row-desc">{command.description}{command.shortcut ? ` · ${command.shortcut}` : ''}</span></div>
          </div>
        }
        const item = raw as Candidate & SkillOption
        const already = trigger.kind === 'skill'
          ? skillRequests.some((selected) => selected.skill_id === item.id)
          : contextRefs.some((selected) => selected.type === item.type && selected.id === item.id)
        return <div key={`${item.type || 'skill'}:${item.id}`} role="option" aria-selected={index === active}
          className={`agent-composer-row${index === active ? ' is-active' : ''}${already ? ' is-added' : ''}`}
          onMouseEnter={() => setActive(index)} onClick={(event) => choose(index, event.shiftKey)}>
          <div className="agent-composer-row-main">
            <span className="agent-composer-row-name">{item.name}</span>
            <span className="agent-composer-row-desc">{item.summary || item.hint || (trigger.kind === 'skill' ? (item.scope === 'personal' ? '个人技能' : '共享技能') : '')}</span>
          </div>
          {already ? <span className="agent-composer-row-state">已添加</span>
            : trigger.kind === 'at' ? <div className="agent-composer-row-actions">
              <button type="button" onClick={(event) => { event.stopPropagation(); choose(index, false) }}>本轮</button>
              <button type="button" onClick={(event) => { event.stopPropagation(); choose(index, true) }}>固定</button>
            </div> : <span className="agent-composer-row-state">请求使用</span>}
        </div>
      })}
    </div>}
    {hint && <p className="agent-composer-hint" role="alert">{hint}</p>}
    <p className="agent-composer-foot">{trigger.kind === 'at' ? 'Enter 添加 · Shift+Enter 固定到对话 · Esc 关闭' : 'Enter 执行 · Esc 关闭'}</p>
  </div>
}
