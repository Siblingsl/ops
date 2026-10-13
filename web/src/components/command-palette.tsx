import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BarChart3, BookOpen, Building2, CalendarDays, Clock, FileText, GitBranch, Hash, History, Inbox, Keyboard, LayoutDashboard, Lightbulb,
  Maximize2, Plus, Search, Settings2, ShieldCheck, Sparkles, Star, UserCircle2, type LucideIcon,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { errorMessage, get, post } from '@/lib/api'
import { isEnterWithoutComposition } from '@/lib/keyboard'
import { useAccounts, useCanWrite, useCurrentAccount, useMe } from '@/lib/session'
import type { SearchHit, StarItem, Work } from '@/lib/types'
import { fuzzyMatch, recentItems, rememberRecent, workCmd } from '@/lib/v3'
import { Dialog } from './dialog'
import { openQuickCollect } from './quick-collect'
import { cn, Kbd, PlatformMark } from './ui'

type Cmd = {
  id: string
  group: string
  label: string
  hint?: string
  icon: LucideIcon
  keywords?: string
  run: () => void
}

const typeLabel: Record<string, string> = { work: '作品', topic: '选题', material: '素材', style_sample: '风格样本' }

export function openPalette() {
  window.dispatchEvent(new Event('ops:palette'))
}

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
}

export const shortcutList: { keys: string[]; label: string; group: string }[] = [
  { group: '全局', keys: ['Ctrl', 'K'], label: '打开命令面板 / 搜索' },
  { group: '全局', keys: ['Ctrl', 'Shift', 'I'], label: '记一条灵感' },
  { group: '全局', keys: ['Ctrl', 'Shift', 'M'], label: '存为素材（可先选中文字）' },
  { group: '全局', keys: ['?'], label: '查看快捷键' },
  { group: '全局', keys: ['G', 'D'], label: '去工作台' },
  { group: '全局', keys: ['G', 'T'], label: '去选题池' },
  { group: '全局', keys: ['G', 'C'], label: '去内容日历' },
  { group: '全局', keys: ['G', 'W'], label: '去作品' },
  { group: '全局', keys: ['G', 'M'], label: '去素材库' },
  { group: '全局', keys: ['G', 'R'], label: '去复盘' },
  { group: '写作', keys: ['Ctrl', 'Enter'], label: '起草当前段 / 提交指令' },
  { group: '写作', keys: ['Alt', '/'], label: '续写建议（灰字），Tab 采纳，Esc 放弃（可在偏好设置中更换）' },
  { group: '写作', keys: ['Ctrl', 'Shift', 'R'], label: '改写选中文字 / 当前段' },
  { group: '写作', keys: ['Alt', '↑ / ↓'], label: '上一段 / 下一段' },
  { group: '写作', keys: ['Alt', 'N'], label: '跳到下一段空稿' },
  { group: '写作', keys: ['F8'], label: '跳到下一处「待核实」' },
  { group: '写作', keys: ['Ctrl', 'J'], label: '打开 / 收起副驾驶' },
  { group: '写作', keys: ['F11'], label: '专注模式（也可用 Ctrl+Shift+F）' },
  { group: '写作', keys: ['Ctrl', 'S'], label: '立即保存并留一个手动版本' },
  { group: '写作', keys: ['1 / 2 / 3'], label: '在候选卡片里选第几个' },
  { group: '写作', keys: ['Esc'], label: '停止生成 / 放弃候选 / 关闭弹窗' },
]

export function ShortcutHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  const groups = [...new Set(shortcutList.map((s) => s.group))]
  return (
    <Dialog open={open} onClose={onClose} title="快捷键" width="max-w-lg">
      <div className="space-y-4">
        {groups.map((g) => (
          <div key={g}>
            <p className="mb-1.5 text-[11px] font-semibold tracking-wider text-mist-400">{g}</p>
            <div className="divide-y divide-mist-100 rounded-lg border border-mist-100">
              {shortcutList.filter((s) => s.group === g).map((s) => (
                <div key={s.label} className="flex items-center justify-between px-3 py-1.5 text-[13px] text-mist-700">
                  {s.label}
                  <span className="flex gap-1">{s.keys.map((k) => <Kbd key={k}>{k}</Kbd>)}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Dialog>
  )
}

/** CommandPalette (EX-M-01, Ctrl+K): navigation, actions, recents, stars and full-text search in one box. Pinyin initials work too. */
export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [help, setHelp] = useState(false)
  const [q, setQ] = useState('')
  const [dq, setDq] = useState('')
  const [idx, setIdx] = useState(0)
  const nav = useNavigate()
  const location = useLocation()
  const qc = useQueryClient()
  const acc = useCurrentAccount()
  const { data: accounts } = useAccounts()
  const { data: me } = useMe()
  const canWrite = useCanWrite()
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let gPending = 0
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((v) => !v)
        return
      }
      if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key === '?') {
        e.preventDefault()
        setHelp(true)
        return
      }
      if (e.key.toLowerCase() === 'g') {
        gPending = Date.now()
        return
      }
      if (gPending && Date.now() - gPending < 1200) {
        gPending = 0
        const base = acc ? `/a/${acc.id}` : ''
        const map: Record<string, string> = { d: base || '/', t: `${base}/topics`, c: `${base}/calendar`, w: `${base}/works`, m: `${base}/materials`, r: `${base}/review` }
        const to = map[e.key.toLowerCase()]
        if (to && base) {
          e.preventDefault()
          nav(to)
        }
      }
    }
    const onOpen = () => setOpen(true)
    const onHelp = () => setHelp(true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('ops:palette', onOpen)
    window.addEventListener('ops:shortcuts', onHelp)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('ops:palette', onOpen)
      window.removeEventListener('ops:shortcuts', onHelp)
    }
  }, [acc, nav])

  useEffect(() => {
    if (!open) {
      setQ('')
      setDq('')
    }
  }, [open])
  useEffect(() => {
    const t = window.setTimeout(() => setDq(q.trim()), 200)
    return () => window.clearTimeout(t)
  }, [q])
  useEffect(() => setIdx(0), [dq, q])

  const stars = useQuery({ queryKey: ['stars'], queryFn: () => get<StarItem[]>('/stars'), enabled: open, staleTime: 30_000 })
  const search = useQuery({
    queryKey: ['search', dq, acc?.id],
    queryFn: () => get<{ items: SearchHit[] }>(`/search?q=${encodeURIComponent(dq)}&limit=12`),
    enabled: open && dq.length >= 1,
    staleTime: 10_000,
  })

  const go = (to: string, label?: string, type = 'page') => {
    setOpen(false)
    if (label) rememberRecent({ type, title: label, link: to })
    nav(to)
  }
  const workId = location.pathname.match(/^\/works\/([0-9a-f-]{36})/)?.[1]
  const work = useQuery({ queryKey: ['work', workId], queryFn: () => get<Work>(`/works/${workId}`), enabled: false }).data
  const onEditor = !!workId && /^\/works\/[^/]+\/?$/.test(location.pathname)
  const inEditor = (fn: () => void) => {
    setOpen(false)
    if (onEditor) return fn()
    nav(`/works/${workId}`)
    window.setTimeout(fn, 500)
  }
  const switchWorkspace = async (id: string) => {
    setOpen(false)
    try {
      await post(`/workspaces/${id}/switch`, {})
      qc.clear()
      nav('/', { replace: true })
      window.location.reload()
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const commands = useMemo<Cmd[]>(() => {
    const base = acc ? `/a/${acc.id}` : ''
    const list: Cmd[] = []
    if (work && workId) {
      const g = '本作品'
      work.sections.forEach((s, i) => list.push({
        id: 'w-sec-' + s.id, group: g, label: `跳到第 ${i + 1} 段${s.heading ? `：${s.heading}` : ''}`, icon: Hash, keywords: `${i + 1} section`,
        run: () => inEditor(() => workCmd({ cmd: 'goto', sectionId: s.id })),
      }))
      list.push(
        { id: 'w-titles', group: g, label: '生成标题', icon: Sparkles, keywords: 'title', run: () => inEditor(() => workCmd({ cmd: 'titles' })) },
        { id: 'w-check', group: g, label: '去检查', icon: ShieldCheck, keywords: 'check 提交检查 发布前检查', run: () => go(`/works/${workId}/check`) },
        { id: 'w-versions', group: g, label: '查看版本历史', icon: History, keywords: 'version history', run: () => { setOpen(false); workCmd({ cmd: 'versions' }) } },
        { id: 'w-focus', group: g, label: '专注模式', hint: 'F11', icon: Maximize2, keywords: 'focus zen', run: () => { setOpen(false); workCmd({ cmd: 'focus' }) } },
      )
      if (work.platform === 'wechat_mp' && !['comic', 'card_post'].includes(work.content_format)) {
        list.push({ id: 'w-preview', group: g, label: '打开排版预览', icon: FileText, keywords: 'layout preview 排版', run: () => go(`/works/${workId}/preview`) })
      }
      list.push(work.platform === 'wechat_mp'
        ? { id: 'w-push', group: g, label: '去写入草稿箱', icon: FileText, keywords: 'draft push 草稿', run: () => go(`/works/${workId}/push`) }
        : { id: 'w-pack', group: g, label: '去生成发布包', icon: FileText, keywords: 'pack 发布包', run: () => go(`/works/${workId}/pack`) })
      if (canWrite) list.push({ id: 'w-derive', group: g, label: '派生到其他账号', icon: GitBranch, keywords: 'derive', run: () => { setOpen(false); workCmd({ cmd: 'derive' }) } })
    }
    if (acc) {
      list.push(
        { id: 'n-dash', group: '页面', label: '工作台', icon: LayoutDashboard, keywords: 'dashboard home', run: () => go(base, '工作台') },
        { id: 'n-topics', group: '页面', label: '选题池', icon: Lightbulb, keywords: 'topics', run: () => go(`${base}/topics`, '选题池') },
        { id: 'n-inbox', group: '页面', label: '灵感收件箱', icon: Inbox, keywords: 'inbox', run: () => go(`${base}/topics?tab=inbox`, '灵感收件箱') },
        { id: 'n-series', group: '页面', label: '系列', icon: Lightbulb, keywords: 'series', run: () => go(`${base}/topics?tab=series`, '系列') },
        { id: 'n-cal', group: '页面', label: '内容日历', icon: CalendarDays, keywords: 'calendar 计划发布日', run: () => go(`${base}/calendar`, '内容日历') },
        { id: 'n-works', group: '页面', label: '作品', icon: FileText, keywords: 'works', run: () => go(`${base}/works`, '作品') },
        { id: 'n-mat', group: '页面', label: '素材库', icon: BookOpen, keywords: 'materials', run: () => go(`${base}/materials`, '素材库') },
        { id: 'n-review', group: '页面', label: '数据复盘', icon: BarChart3, keywords: 'review', run: () => go(`${base}/review`, '数据复盘') },
        { id: 'n-profile', group: '页面', label: '账号档案与 AI 记忆', icon: UserCircle2, keywords: 'profile memory', run: () => go(`${base}/profile`, '账号档案') },
      )
    }
    const settings: [string, string][] = [
      ['/settings/preferences', '偏好设置'], ['/settings/models', '模型配置'], ['/settings/usage', 'AI 用量与成本'], ['/settings/quality', 'AI 质量看板'],
      ['/settings/prompts', '提示词模板'], ['/settings/words', '敏感词库'], ['/settings/members', '成员与邀请'], ['/settings/accounts', '平台账号与凭证'],
      ['/settings/trash', '回收站'], ['/settings/logs', '操作日志'], ['/settings/export', '数据导出'], ['/settings/security', '登录与安全'],
    ]
    if (me?.is_system_admin) settings.push(['/settings/admin', '系统管理'])
    for (const [to, label] of settings) list.push({ id: 's' + to, group: '设置', label, icon: Settings2, run: () => go(to, label) })
    list.push({ id: 'a-search', group: '操作', label: '打开搜索页', icon: Search, keywords: 'search', run: () => go('/search' + (q ? `?q=${encodeURIComponent(q)}` : ''), '搜索') })
    list.push({ id: 'a-keys', group: '操作', label: '查看快捷键', icon: Keyboard, keywords: 'shortcut help', run: () => { setOpen(false); setHelp(true) } })
    if (canWrite) {
      list.push(
        { id: 'a-inbox', group: '操作', label: '记一条灵感', hint: 'Ctrl+Shift+I', icon: Inbox, keywords: 'idea note', run: () => { setOpen(false); openQuickCollect('inbox', q.startsWith('>') ? q.slice(1).trim() : '', 'palette') } },
        { id: 'a-mat', group: '操作', label: '存一条素材', hint: 'Ctrl+Shift+M', icon: BookOpen, run: () => { setOpen(false); openQuickCollect('material') } },
      )
      if (acc) {
        list.push({
          id: 'a-topic', group: '操作', label: '新建选题', icon: Lightbulb, keywords: 'new topic',
          run: () => go(`/a/${acc.id}/topics?new=1${q && !/^[a-z]+$/i.test(q.trim()) ? `&title=${encodeURIComponent(q.trim())}` : ''}`),
        })
        list.push({
          id: 'a-new', group: '操作', label: '新建作品', hint: acc.platform === 'xhs' ? '小红书笔记' : '公众号文章', icon: Plus, keywords: 'new work create 文章 笔记',
          run: async () => {
            setOpen(false)
            try {
              const w = await post<Work>(`/accounts/${acc.id}/works`, { title: '' })
              nav(`/works/${w.id}`)
            } catch (e) {
              toast.error(errorMessage(e))
            }
          },
        })
      }
    }
    for (const a of accounts ?? []) {
      if (a.status !== 'active' || a.id === acc?.id) continue
      list.push({ id: 'acc-' + a.id, group: '操作', label: `切换账号：${a.name}`, icon: UserCircle2, keywords: a.platform, run: () => go(`/a/${a.id}`) })
    }
    for (const w of me?.workspaces ?? []) {
      if (w.id === me?.workspace.id) continue
      list.push({ id: 'ws-' + w.id, group: '操作', label: `切换工作区：${w.name}`, icon: Building2, keywords: 'workspace', run: () => void switchWorkspace(w.id) })
    }
    return list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acc, accounts, canWrite, q, work, workId, me])

  const items = useMemo(() => {
    const out: Cmd[] = []
    const query = q.trim()
    if (!query) {
      for (const r of recentItems().slice(0, 5)) out.push({ id: 'r-' + r.link, group: '最近', label: r.title, hint: typeLabel[r.type], icon: Clock, run: () => go(r.link, r.title, r.type) })
      for (const s of (stars.data ?? []).slice(0, 6)) out.push({ id: 'st-' + s.object_id, group: '收藏', label: s.title, hint: typeLabel[s.object_type], icon: Star, run: () => go(s.link, s.title, s.object_type) })
      const workCmds = commands.filter((c) => c.group === '本作品' && !c.id.startsWith('w-sec-'))
      return [...out, ...workCmds, ...commands.filter((c) => c.group === '操作' || c.group === '页面')]
    }
    const matched = commands.filter((c) => fuzzyMatch(c.label + ' ' + (c.keywords ?? ''), query))
    const order = ['本作品', '操作']
    out.push(...matched.filter((c) => order.includes(c.group)).sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group)))
    const hits = search.data?.items ?? []
    for (const type of ['work', 'topic', 'material', 'style_sample']) {
      for (const h of hits.filter((x) => x.type === type)) {
        out.push({
          id: 'h-' + h.type + h.id, group: typeLabel[type], label: h.title, hint: h.account_name,
          icon: h.type === 'work' ? FileText : h.type === 'topic' ? Lightbulb : BookOpen,
          run: () => go(h.link, h.title, h.type),
        })
      }
    }
    out.push(...matched.filter((c) => !order.includes(c.group)))
    out.push({ id: 'h-more', group: '搜索', label: `在搜索页查看「${query}」的全部结果`, icon: Search, run: () => go(`/search?q=${encodeURIComponent(query)}`) })
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, commands, stars.data, search.data])

  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${idx}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [idx])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIdx((i) => Math.min(items.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIdx((i) => Math.max(0, i - 1))
    } else if (isEnterWithoutComposition(e.nativeEvent)) {
      e.preventDefault()
      items[idx]?.run()
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  let lastGroup = ''
  return (
    <>
      <ShortcutHelp open={help} onClose={() => setHelp(false)} />
      {open && createPortal(
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-mist-900/30 p-4 pt-[12vh] backdrop-blur-[2px]" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
          <div className="w-full max-w-xl animate-fade-in overflow-hidden rounded-2xl bg-white shadow-pop" role="dialog" aria-label="命令面板">
            <div className="flex items-center gap-2.5 border-b border-mist-100 px-4">
              <Search className="size-4 shrink-0 text-mist-400" />
              <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKeyDown}
                placeholder="搜索作品、选题、素材，或输入命令（支持拼音首字母）"
                className="h-12 min-w-0 flex-1 bg-transparent text-[14.5px] text-mist-900 outline-none placeholder:text-mist-400" />
              {acc && <PlatformMark platform={acc.platform} size="sm" />}
              <Kbd>Esc</Kbd>
            </div>
            <div ref={listRef} className="scrollbar-thin max-h-[56vh] overflow-y-auto p-1.5">
              {items.length === 0 && <p className="py-10 text-center text-[13px] text-mist-400">{search.isFetching ? '搜索中…' : '没有匹配的结果'}</p>}
              {items.map((c, i) => {
                const head = c.group !== lastGroup
                lastGroup = c.group
                const Icon = c.icon
                return (
                  <div key={c.id + i}>
                    {head && <div className="px-2.5 pb-1 pt-2 text-[11px] font-semibold tracking-wider text-mist-400">{c.group}</div>}
                    <button type="button" data-idx={i} onMouseEnter={() => setIdx(i)} onClick={() => c.run()}
                      className={cn('flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13.5px] transition',
                        i === idx ? 'bg-ink-50 text-ink-800' : 'text-mist-700')}>
                      <Icon className={cn('size-4 shrink-0', i === idx ? 'text-ink-600' : 'text-mist-400')} />
                      <span className="min-w-0 flex-1 truncate">{c.label}</span>
                      {c.hint && <span className="shrink-0 text-[11.5px] text-mist-400">{c.hint}</span>}
                    </button>
                  </div>
                )
              })}
            </div>
            <div className="flex items-center gap-3 border-t border-mist-100 bg-mist-50/60 px-4 py-2 text-[11.5px] text-mist-400">
              <span><Kbd>↑</Kbd> <Kbd>↓</Kbd> 选择</span>
              <span><Kbd>Enter</Kbd> 打开</span>
              <span className="ml-auto"><Kbd>?</Kbd> 全部快捷键</span>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
