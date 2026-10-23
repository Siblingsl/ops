import { openCreateWork } from '@/components/create-work-panel'
import { FirstValueGuide } from '@/components/first-value-guide'
import { openQuickCollect } from '@/components/quick-collect'
import { DailyPanel } from './ops/Daily'
import HotPanel from './ops/Hot'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight, BookOpenCheck, Bot, CalendarDays, CheckCircle2, ChevronDown, Circle, ClipboardCheck, Compass, Cpu, FilePen, HeartPulse, KeyRound, Lightbulb, PenLine, Send, Shield, Sparkles, TrendingUp, UploadCloud } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { confirm } from '@/components/dialog'
import { Button, Card, cn, platformFormatLabel, Notice, PageHeader, PageState, StatusBadge, statusMeta } from '@/components/ui'
import { del, errorMessage, get, post } from '@/lib/api'
import { fmtNum, relTime } from '@/lib/format'
import { useAgentBootstrap } from '@/lib/agent'
import { useAccounts, useCanWrite, useCurrentAccount, useInvalidate, useMe } from '@/lib/session'
import { currentAccountSettingsPath } from '@/lib/desktop-settings'
import type { Account, AILimit, ContentFormat, DailyResult, HealthItem, NextAction, WorkStatus } from '@/lib/types'
import { usePrefetchWork, useRecentWorks } from '@/lib/v3'

interface Todo { work_id: string; title: string; status: WorkStatus; kind: string; hint: string; at: string; node?: number; content_format?: ContentFormat }
// DB-04：真实发布/计划日期按星期返回，前端不再按数量顺序点亮圆点。
interface RhythmDay { date: string; published: number; planned: number }
interface Rhythm { week_start?: string; published: number; planned: number; past_avg?: number; days?: RhythmDay[] }
interface Dash {
  account: Account
  counts: Partial<Record<WorkStatus, number>>
  todos: Todo[]
  pending_topics: number
  today_push: number
  daily_limit: number
  tokens_today: number
  ai_limit: AILimit
  setup: { ai: boolean; profile: boolean; samples: boolean; credential: boolean }
}

const groups: { kinds: string[]; title: string; icon: React.ReactNode; empty: string }[] = [
  { kinds: ['publish'], title: '待回填', icon: <UploadCloud className="size-4" />, empty: '没有等待回填的作品' },
  { kinds: ['push', 'pack'], title: '可发布', icon: <Send className="size-4" />, empty: '检查确认后的作品会出现在这里' },
  { kinds: ['write', 'check'], title: '进行中', icon: <FilePen className="size-4" />, empty: '还没有进行中的作品' },
  { kinds: ['metric'], title: '复盘提醒', icon: <TrendingUp className="size-4" />, empty: '发布满 1、3、7 天时提醒你录入数据' },
]

function todoLink(t: Todo, accountId: string, platform: Account['platform']) {
  switch (t.kind) {
    case 'check': return `/works/${t.work_id}/check`
    case 'push': return `/works/${t.work_id}/${platform === 'wechat_mp' ? 'push' : 'pack'}`
    case 'pack': return `/works/${t.work_id}/pack`
    case 'publish': return `/works/${t.work_id}/${platform === 'wechat_mp' && t.status !== 'packed' ? 'push' : 'pack'}`
    case 'metric': return `/a/${accountId}/review?work=${t.work_id}${t.node ? `&node=${t.node}` : ''}`
    default: return `/works/${t.work_id}`
  }
}

// DB-01：按钮文案按 kind 变化，不再一律"继续这篇作品"。
function todoAction(t: Todo, accountId: string, platform: Account['platform']) {
  const to = todoLink(t, accountId, platform)
  switch (t.kind) {
    case 'write': return { to, label: '继续写作', stage: '创作中' }
    case 'check': return { to, label: '去继续检查', stage: '检查中' }
    case 'publish': return { to, label: '去回填链接', stage: '待回填' }
    case 'push':
    case 'pack': return { to, label: '去发布', stage: '可发布' }
    case 'metric': return { to, label: '去录数据', stage: '复盘提醒' }
    default: return { to, label: '打开这篇作品', stage: statusMeta[t.status as WorkStatus]?.label ?? '' }
  }
}

export function useCreateWork(accountId?: string, platform?: Account['platform']) {
  // NW-A4：所有入口只打开同一个创建面板；真正创建收敛到 CreateWorkPanel + 一个 HTTP 契约。
  return async (title = '', contentFormat?: ContentFormat) => {
    if (!accountId) return
    openCreateWork({ accountId, platform, title, format: contentFormat })
  }
}

function Stat({ label, value, sub, icon, to }: { label: string; value: React.ReactNode; sub?: React.ReactNode; icon: React.ReactNode; to?: string }) {
  const body = (
    <Card className={cn('p-4 transition', to && 'hover:border-mist-300 hover:shadow-pop')}>
      <div className="flex items-center justify-between text-mist-400">
        <span className="text-[12.5px] font-medium text-mist-500">{label}</span>
        <span className="[&>svg]:size-4">{icon}</span>
      </div>
      <div className="mt-2 font-display text-[28px] font-bold leading-none tabular-nums text-mist-900">{value}</div>
      {sub && <div className="mt-1.5 text-xs text-mist-500">{sub}</div>}
    </Card>
  )
  return to ? <Link to={to}>{body}</Link> : body
}

// DB-03：把待办分组的 kind 映射到作品列表的状态筛选参数，让"查看全部"落到同一批作品上。
function groupStatus(kinds: string[]) {
  if (kinds.includes('publish') || kinds.includes('push') || kinds.includes('pack')) return 'out'
  if (kinds.includes('check')) return 'checking'
  if (kinds.includes('write')) return 'drafting'
  if (kinds.includes('metric')) return 'published'
  return 'all'
}

// DEV-A106（13 文档）：今日智能简报——AI 解读昨日数据与今日重点，每账号每天一条。
function BriefCard({ accountId }: { accountId: string }) {
  const [collapsed, setCollapsed] = useState(false)
  const q = useQuery({
    queryKey: ['brief', accountId],
    queryFn: () => get<{ brief: { items: string[] } | null; preparing?: boolean }>(`/accounts/${accountId}/brief`),
  })
  const items = q.data?.brief?.items ?? []
  if (!items.length) return null
  return (
    <Card className="p-5">
      <div className="flex items-center gap-2">
        <Sparkles className="size-4 text-ink-600" />
        <h3 className="text-[14px] font-semibold text-mist-900">今日智能简报</h3>
        <span className="text-[11.5px] text-mist-400">AI 解读，数字来自已录入的数据</span>
        <button type="button" aria-expanded={!collapsed} aria-controls="dashboard-brief-content" className="ml-auto cursor-pointer text-[12px] text-mist-400 hover:text-mist-600" onClick={() => setCollapsed(!collapsed)}>
          {collapsed ? '展开' : '收起'}
        </button>
      </div>
      <div id="dashboard-brief-content" aria-hidden={collapsed} className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out ${collapsed ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100'}`}>
        <div className="min-h-0 overflow-hidden">
          <ul className="mt-2 space-y-1 text-[13px] text-mist-600">
          {items.map((it, i) => (
            <li key={i} className="flex gap-1.5"><span className="text-ink-500">·</span><span>{it}</span></li>
          ))}
          </ul>
        </div>
      </div>
      <Link to={`/a/${accountId}/ops`} className="mt-2 inline-block text-[12px] text-ink-600 hover:underline">去运营页处理今日推荐 →</Link>
    </Card>
  )
}

// DEV-UX02（D-052 第 2 条）：首屏只有一条按规则排好序的主线，每一项直接打开对应的下一步；不调用模型，不批量处理。
// DB-05：右栏摘要与主线列表共用同一个数据源和排序，避免两套「今天做什么」。
function useMainLine(accountId: string, hideSetup: boolean) {
  const { data: all, isLoading } = useQuery({ queryKey: ['next-actions', accountId, 'main'], queryFn: () => get<NextAction[]>(`/accounts/${accountId}/next-actions?limit=8`), staleTime: 30_000 })
  return { items: (all ?? []).filter((a) => !(hideSetup && a.kind === 'setup')), isLoading }
}

function MainLine({ accountId, hideSetup, panelID }: { accountId: string; hideSetup: boolean; panelID?: string }) {
  const { items: data, isLoading } = useMainLine(accountId, hideSetup)
  if (isLoading) return null
  const [first, ...rest] = data
  return (
    <Card id={panelID} className="mb-6 overflow-hidden border-ink-100">
      <div className="flex items-center gap-2 border-b border-ink-100 bg-ink-50/50 px-5 py-3">
        <Compass className="size-4 text-ink-600" />
        <h3 className="text-[14px] font-semibold text-mist-900">今天的主线</h3>
        <span className="text-xs text-mist-400">按"卡住发布 → 有时效 → 进行中 → 新任务"排好了，从第 1 项做起</span>
      </div>
      {!first ? (
        <div className="flex flex-wrap items-center gap-3 px-5 py-5">
          <CheckCircle2 className="size-5 text-success" />
          <span className="flex-1 text-[13.5px] text-mist-700">主线上的事都处理完了。可以从选题池挑一个题目，或者点右上角新建作品。</span>
          <Link to={`/a/${accountId}/topics`}><Button size="sm" icon={<Lightbulb className="size-3.5" />}>去选题池</Button></Link>
        </div>
      ) : (
        <>
          <Link to={first.link} className="group flex items-center gap-4 px-5 py-4 transition hover:bg-ink-50/40">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-ink-600 text-[13px] font-bold text-white">1</span>
            <span className="min-w-0 flex-1 text-[14.5px] font-medium text-mist-900 group-hover:text-ink-800">{first.text}</span>
            <span className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg bg-ink-600 px-3.5 text-[13px] font-medium text-white group-hover:bg-ink-700">{first.action}<ArrowRight className="size-3.5" /></span>
          </Link>
          {rest.length > 0 && (
            <ul className="divide-y divide-mist-100 border-t border-mist-100">
              {rest.map((a, i) => (
                <li key={a.kind + (a.work_id ?? '') + i}>
                  <Link to={a.link} className="group flex items-center gap-3 px-5 py-2.5 transition hover:bg-mist-50">
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-mist-100 text-[12px] font-bold text-mist-500">{i + 2}</span>
                    <span className="min-w-0 flex-1 text-[13.5px] text-mist-700 group-hover:text-ink-700">{a.text}</span>
                    <span className="shrink-0 rounded-full border border-mist-200 px-2.5 py-0.5 text-[12px] text-mist-600 group-hover:border-ink-300 group-hover:text-ink-700">{a.action}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  )
}

function HealthAndRhythm({ accountId }: { accountId: string }) {
  const health = useQuery({ queryKey: ['health', accountId], queryFn: () => get<{ score: number; items: HealthItem[] }>(`/accounts/${accountId}/health`), staleTime: 60_000 })
  const rhythm = useQuery({ queryKey: ['rhythm', accountId], queryFn: () => get<{ week_start: string; published: number; planned: number; past_avg: number }>(`/accounts/${accountId}/rhythm`), staleTime: 60_000 })
  return (
    <div className="mb-8 grid gap-4 lg:grid-cols-3">
      <Card className="p-5 lg:col-span-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <HeartPulse className="size-4 text-ink-600" />
            <h3 className="text-[14px] font-semibold text-mist-900">AI 对这个账号的了解程度</h3>
          </div>
          {health.data && <span className="font-display text-[22px] font-bold tabular-nums text-mist-900">{health.data.score}<span className="text-sm text-mist-400"> / 100</span></span>}
        </div>
        <div className="mt-3 grid gap-x-6 gap-y-2.5 sm:grid-cols-2">
          {(health.data?.items ?? []).map((it) => (
            <Link key={it.key} to={it.link} className="group block">
              <div className="flex items-center justify-between text-[12.5px]">
                <span className="text-mist-700 group-hover:text-ink-700">{it.label}</span>
                <span className="tabular-nums text-mist-400">{it.score}/{it.max}</span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-mist-100">
                <div className={cn('h-full rounded-full', it.score >= it.max ? 'bg-success' : 'bg-ink-500')} style={{ width: `${Math.round((it.score / it.max) * 100)}%` }} />
              </div>
              {it.hint && <p className="mt-0.5 text-[11.5px] text-mist-400">{it.hint}</p>}
            </Link>
          ))}
        </div>
      </Card>
      <Card className="p-5">
        <div className="flex items-center gap-2">
          <CalendarDays className="size-4 text-ink-600" />
          <h3 className="text-[14px] font-semibold text-mist-900">本周节奏</h3>
        </div>
        {rhythm.data && (
          <>
            <div className="mt-3 flex items-end gap-6">
              <div><div className="font-display text-[28px] font-bold tabular-nums text-mist-900">{rhythm.data.published}</div><div className="text-xs text-mist-500">本周已发布</div></div>
              <div><div className="font-display text-[28px] font-bold tabular-nums text-mist-500">{rhythm.data.planned}</div><div className="text-xs text-mist-500">本周计划</div></div>
            </div>
            <p className="mt-3 text-[12.5px] leading-relaxed text-mist-500">
              过去 4 周平均每周 {rhythm.data.past_avg.toFixed(1)} 篇。
              {rhythm.data.published < rhythm.data.past_avg ? '本周略慢于平时，可以去日历排一下计划发布日。' : '节奏不错，保持住。'}
            </p>
            <Link to={`/a/${accountId}/calendar`} className="mt-2 inline-flex items-center gap-1 text-[12.5px] text-ink-700 hover:underline">打开内容日历 <ArrowRight className="size-3.5" /></Link>
          </>
        )}
      </Card>
    </div>
  )
}

function DemoCard({ acc, owner }: { acc: Account; owner: boolean }) {
  const inv = useInvalidate()
  const nav = useNavigate()
  const { data: accounts } = useAccounts()
  const hasDemo = (accounts ?? []).some((a) => a.is_demo)
  if (!owner) return null
  if (acc.is_demo) {
    return (
      <Notice tone="gamboge" className="mb-6">
        这是示例账号，里面的档案、素材和作品都是演示数据，可以随便试。试完后
        <button type="button" className="mx-1 cursor-pointer font-medium underline" onClick={async () => {
          if (!(await confirm({ title: '清除示例数据？', desc: '会删除示例账号及其全部内容，你自己的账号不受影响。', confirmText: '清除', danger: true }))) return
          try {
            await del('/demo')
            await inv(['accounts'])
            toast.success('示例数据已清除')
            nav('/')
          } catch (e) {
            toast.error(errorMessage(e))
          }
        }}>一键清除示例数据</button>
      </Notice>
    )
  }
  if (hasDemo) return null
  return (
    <button type="button" className="mb-6 flex w-full cursor-pointer items-center gap-3 rounded-xl border border-dashed border-mist-300 px-5 py-3 text-left text-[13px] text-mist-600 transition hover:border-ink-300 hover:bg-ink-50/40"
      onClick={async () => {
        try {
          const r = await post<{ account_id: string }>('/demo')
          await inv(['accounts'])
          toast.success('已导入示例账号')
          nav(`/a/${r.account_id}`)
        } catch (e) {
          toast.error(errorMessage(e))
        }
      }}>
      <Sparkles className="size-4 text-gamboge-500" />
      <span className="flex-1">想先看看完整流程？导入一个示例账号（含档案、风格样本、素材和一篇进行中的作品），随时可一键清除。</span>
      <ArrowRight className="size-4 text-mist-400" />
    </button>
  )
}

function DesktopDashboard({
  account, data, canWrite, guideVisible, owner, create, setup, setupItems, pendingSetup, hideSetup,
}: {
  account: Account
  data: Dash
  canWrite: boolean
  guideVisible: boolean
  owner: boolean
  create: () => void
  setup: Dash['setup']
  setupItems: { done: boolean; label: string; desc: string; to: string; icon: React.ReactNode }[]
  pendingSetup: { done: boolean; label: string; desc: string; to: string; icon: React.ReactNode }[]
  hideSetup: boolean
}) {
  const agent = useAgentBootstrap()
  const recent = useRecentWorks(3)
  const extrasRef = useRef<HTMLDetailsElement>(null)
  const { items: mainLine } = useMainLine(account.id, hideSetup)
  const rhythm = useQuery({ queryKey: ['rhythm', account.id], queryFn: () => get<Rhythm>(`/accounts/${account.id}/rhythm`), staleTime: 60_000 })
  const activeWork = data.todos.find((todo) => todo.kind === 'write' || todo.kind === 'check') ?? data.todos[0]
  const checking = data.todos.find((todo) => todo.kind === 'check')
  // 待回填单独拎出来：它藏在「今天的安排」前 3 条里容易被挤掉，而复盘数据全靠它。
  const pendingPublish = data.todos.filter((todo) => todo.kind === 'publish')
  const inProgress = (data.counts.drafting ?? 0) + (data.counts.checking ?? 0)
  const totalWorks = Object.values(data.counts).reduce((sum, count) => sum + (count ?? 0), 0)
  const canOpenAgent = !!agent.data && (agent.data.can_use || agent.data.reason === 'no_model' || agent.data.reason === 'not_tested')
  const today = new Date()
  const weekday = '日一二三四五六'[today.getDay()]
  const dateLabel = `${today.getMonth() + 1} 月 ${today.getDate()} 日，星期${weekday}`
  const publishedThisWeek = rhythm.data?.published ?? 0
  const plannedThisWeek = rhythm.data?.planned ?? 0
  const weeklyTarget = Math.max(publishedThisWeek, plannedThisWeek)
  // DB-04：把接口返回的真实日期映射成周一到周日；缺失时退化为文字说明。
  const weekLabels = ['一', '二', '三', '四', '五', '六', '日']
  const weekDays = (rhythm.data?.days ?? []).map((day, index) => ({ ...day, label: weekLabels[index] ?? '·' }))
  const openExtra = (target: string) => {
    if (!extrasRef.current) return
    extrasRef.current.open = true
    requestAnimationFrame(() => document.getElementById(target)?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }

  return (
    <div className="desktop-dashboard creative-page animate-fade-in" data-testid="desktop-dashboard">
      <div className="creative-welcome">
        <div><h1>今天，给灵感一点空间。</h1><p>{account.name} · 从一个小想法，到一篇有温度的内容。</p></div>
        <div className="actions"><span className="date-pill"><CalendarDays aria-hidden="true" /> {dateLabel}</span>{canWrite && <button type="button" className="button primary" onClick={create}><PenLine aria-hidden="true" />新建作品</button>}</div>
      </div>

      <div className="creative-main-grid">
        <div className="creative-left">
          <article className="creation-feature">
            <div className="feature-copy">
              <div className="feature-kicker"><FilePen aria-hidden="true" /> 你的创作进行时 <span className="tag blue">{activeWork ? statusMeta[activeWork.status].label : '开始创作'}</span></div>
              <h2 title={activeWork?.title}>{activeWork?.title || '从一个小想法，开始新的创作'}</h2>
              <p>{activeWork?.hint || '写下你最想表达的观点，再逐步整理大纲、打磨每一段内容。'}</p>
              <div className="feature-footer">
                {activeWork ? (() => {
                  const action = todoAction(activeWork, account.id, account.platform)
                  return <Link className="button primary" to={action.to}>{action.label} <ArrowRight aria-hidden="true" /></Link>
                })()
                  : canWrite ? <button type="button" className="button primary" onClick={create}>新建第一篇作品 <ArrowRight aria-hidden="true" /></button>
                    : <Link className="button human" to={`/a/${account.id}/works`}>浏览作品 <ArrowRight aria-hidden="true" /></Link>}
                <small>{activeWork ? `${todoAction(activeWork, account.id, account.platform).stage} · ${activeWork.hint} · ${relTime(activeWork.at)}` : `${inProgress} 篇进行中的作品`}</small>
              </div>
            </div>
            <div className="creative-illustration"><svg viewBox="0 0 270 240" fill="none" aria-hidden="true" focusable="false">
              <circle cx="135" cy="124" r="93" fill="#DED1F4" />
              <circle cx="135" cy="124" r="73" stroke="#CDBCE8" strokeWidth="1" strokeDasharray="3 7" />
              <g className="paper-object back"><g transform="rotate(-16 105 125)"><rect x="48" y="47" width="108" height="151" rx="12" fill="#BEABD8" /><rect x="42" y="42" width="108" height="151" rx="12" fill="#FFF9F0" /><rect x="58" y="60" width="40" height="7" rx="3.5" fill="#EDBC9A" /><rect x="58" y="83" width="73" height="4" rx="2" fill="#E2D8CB" /><rect x="58" y="95" width="60" height="4" rx="2" fill="#E2D8CB" /><rect x="58" y="107" width="67" height="4" rx="2" fill="#E2D8CB" /><rect x="58" y="142" width="73" height="26" rx="6" fill="#F6E8D9" /></g></g>
              <g className="paper-object front"><g transform="rotate(11 166 142)"><rect x="113" y="75" width="111" height="141" rx="13" fill="#B7A0D8" /><rect x="107" y="69" width="111" height="141" rx="13" fill="#FFFFFF" /><rect x="123" y="84" width="79" height="61" rx="8" fill="#E1EEE7" /><path d="M160 97c15-14 30 2 10 16 22 1 22 22 1 20 2 21-19 21-20 1-17 13-31-3-12-17-22-2-20-22 1-20-2-20 20-22 20 0Z" fill="#A9C6B3" /><circle cx="157" cy="116" r="9" fill="#F7FAEE" /><rect x="123" y="160" width="63" height="5" rx="2.5" fill="#9580B4" /><rect x="123" y="173" width="78" height="4" rx="2" fill="#E3DDED" /><rect x="123" y="184" width="50" height="4" rx="2" fill="#E3DDED" /></g></g>
              <g className="spark-object"><path d="m204 21 5.8 17.2L227 44l-17.2 5.8L204 67l-5.8-17.2L181 44l17.2-5.8L204 21Z" fill="#8E70BD" /><circle cx="234" cy="91" r="5" fill="#F5E7CC" /><path d="m35 164 4.2 10.8L50 179l-10.8 4.2L35 194l-4.2-10.8L20 179l10.8-4.2L35 164Z" fill="#AC90D0" /></g>
              <path d="m56 209 30 6 M57 214l17 3" stroke="#B5A1CF" strokeWidth="2" strokeLinecap="round" />
            </svg></div>
          </article>

          <div className="journey-row" aria-label="创作阶段入口">
            <Link className="journey-card lilac" to={`/a/${account.id}/topics`}><span className="journey-icon"><Lightbulb aria-hidden="true" /></span><span className="journey-value">{data.pending_topics}<small>个</small></span><strong>让想法长成选题</strong><span className="arrow"><ArrowRight aria-hidden="true" /></span></Link>
            <Link className="journey-card peach" to={`/a/${account.id}/works`}><span className="journey-icon"><FilePen aria-hidden="true" /></span><span className="journey-value">{inProgress}<small>篇</small></span><strong>正在慢慢写好的内容</strong><span className="arrow"><ArrowRight aria-hidden="true" /></span></Link>
            <Link className="journey-card mint" to={checking ? todoLink(checking, account.id, account.platform) : `/a/${account.id}/works?status=checking`}><span className="journey-icon"><Shield aria-hidden="true" /></span><span className="journey-value">{data.counts.checking ?? 0}<small>篇</small></span><strong>发布前，再看一遍</strong><span className="arrow"><ArrowRight aria-hidden="true" /></span></Link>
          </div>

          {pendingPublish.length > 0 && (
            <section className="creative-section" aria-labelledby="pending-publish-title" data-testid="pending-publish">
              <div className="section-heading">
                <h2 id="pending-publish-title">待回填 · {pendingPublish.length} 篇</h2>
                <Link className="text-button" to={`/a/${account.id}/works`}>全部作品 <ArrowRight aria-hidden="true" /></Link>
              </div>
              <p className="mb-3 text-[12.5px] text-mist-500">已经生成发布包或写入草稿箱。在平台发布后回来标记「已发布」，这篇才会进入复盘；不标记就永远缺数据。</p>
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {pendingPublish.slice(0, 3).map((todo) => (
                  <Link key={todo.work_id} to={todoLink(todo, account.id, account.platform)}
                    className="flex items-center gap-3 rounded-xl border border-mist-200 bg-white px-4 py-3 transition hover:border-ink-300 hover:bg-mist-50">
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-gamboge-50 text-gamboge-600"><UploadCloud className="size-4" /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] font-medium text-mist-800">{todo.title || '未命名作品'}</span>
                      <span className="mt-0.5 block text-[11.5px] text-mist-500">{todo.status === 'packed' ? '已生成发布包' : '已写入草稿箱'} · {relTime(todo.at)}</span>
                    </span>
                    <ArrowRight className="size-4 shrink-0 text-mist-300" aria-hidden="true" />
                  </Link>
                ))}
              </div>
              {pendingPublish.length > 3 && <p className="mt-2 text-[12px] text-mist-500">还有 {pendingPublish.length - 3} 篇，<Link className="font-medium text-ink-700 underline" to={`/a/${account.id}/works?status=out`}>查看全部待回填</Link></p>}
            </section>
          )}

          <section className="creative-section" aria-labelledby="desktop-recent-title">
            <div className="section-heading"><h2 id="desktop-recent-title">最近打开</h2><Link className="text-button" to={`/a/${account.id}/works`}>全部作品 <ArrowRight aria-hidden="true" /></Link></div>
            {recent.length ? <div className="recent-tiles">{recent.map((item, index) => <Link key={item.link} to={item.link} className="recent-tile"><div className="tile-art" aria-hidden="true">{index === 0 ? <span className="mini-document"><i /><i /><i /><i /></span> : index === 1 ? <span className="mini-flower" /> : <span className="mini-lines"><i /><i /><i /></span>}</div><span className="tag blue">最近打开</span><h3 title={item.title}>{item.title || '未命名作品'}</h3><div className="tile-bottom"><span>{relTime(new Date(item.at).toISOString())}</span><span><FilePen aria-hidden="true" /> 打开作品</span></div></Link>)}</div> : <div className="desktop-recent-empty">最近打开的作品会显示在这里。 <Link to={`/a/${account.id}/works`}>查看作品列表</Link></div>}
          </section>

          <div className="inspiration-strip">
            <article className="inspiration-note"><span className="note-icon"><BookOpenCheck aria-hidden="true" /></span><div className="note-copy"><strong>灵感先放这里</strong><p>散步时的想法、看到的一句话，先收好，之后再逐条整理。</p><button className="text-button" type="button" onClick={() => openQuickCollect('inbox')}>记下一条灵感 ＋</button><Link className="text-button" to={`/a/${account.id}/topics?tab=inbox`}>查看收件箱</Link></div></article>
            <article className="inspiration-note"><span className="note-icon"><Sparkles aria-hidden="true" /></span><div className="note-copy"><strong>今天的内容参考</strong><p>从一个真实生活场景开始，读者更容易读到你自己的声音。</p><button className="text-button" type="button" onClick={() => openExtra('desktop-daily-recommendations')}>查看每日推荐 <ArrowRight aria-hidden="true" /></button></div></article>
          </div>
        </div>
        <aside className="creative-right" aria-label="今日安排与创作入口">
          <section className="today-panel" aria-labelledby="today-panel-title">
            <div className="section-heading"><h2 id="today-panel-title">今天的主线</h2><span className="day-date">{mainLine.length} 件小事</span></div>
            {/* DB-05：工作台只保留一套带序号的待办。右栏只做摘要（第 1 项 + 剩余数量），
                完整列表统一由 MainLine 呈现，避免两套「今天做什么」排序和截断都不同。 */}
            {mainLine.length ? <Link className="creative-todo" to={mainLine[0].link}>
              <span className="todo-indicator" /><span><strong>1. {mainLine[0].text}</strong><small>{mainLine[0].action}{mainLine.length > 1 ? ` · 还有 ${mainLine.length - 1} 项` : ''}</small></span>
            </Link> : <div className="creative-todo"><span className="todo-indicator" /><span><strong>今天，从一个小想法开始</strong><small>去选题池挑一个想继续的方向</small></span></div>}
            {mainLine.length > 1 && <button type="button" className="text-button" onClick={() => openExtra('desktop-main-line')}>查看全部 {mainLine.length} 项 <ArrowRight aria-hidden="true" /></button>}
            <div className="week-progress"><div className="meta"><strong>本周节奏</strong><span>{publishedThisWeek} / {weeklyTarget} 篇已完成</span></div>
              {/* DB-04：按真实 published_at / planned_date 点亮对应星期；没有日期数据时退化成「本周 N 篇」，不假装进度。 */}
              {weekDays.length ? <div className="week-dots" data-testid="week-dots">{weekDays.map((day) => <span key={day.date} title={`${day.date}：发布 ${day.published} 篇，计划 ${day.planned} 篇`}
                className={day.published > 0 ? 'done' : day.planned > 0 ? 'planned' : ''}><i>{day.published > 0 ? '✓' : ''}</i>{day.label}</span>)}</div>
                : <p className="text-xs text-mist-500">本周 {publishedThisWeek} 篇已发布{plannedThisWeek > 0 ? `，${plannedThisWeek} 篇待发布` : ''}。</p>}</div>
          </section>
          <section className="assistant-invite"><span className="assistant-icon"><Bot aria-hidden="true" /></span><span className="spark-decoration" aria-hidden="true">✦</span><h3>一个想法，也可以聊聊</h3><p>让 AI 帮你梳理方向、查找素材。<br />每一次写入，仍然由你决定。</p><Link className="text-button" to={canOpenAgent ? '/agent' : '/settings/agent'}>{canOpenAgent ? '打开 AI 对话' : '配置 AI 对话'} <ArrowRight aria-hidden="true" /></Link></section>
          <div className="creative-usage"><span>今日 AI 用量 <strong>{fmtNum(data.tokens_today)}</strong></span><Link className="text-button" to="/settings/usage">查看用量 <ArrowRight aria-hidden="true" /></Link></div>
        </aside>
      </div>
        <div className="creative-footer"><span>共 {totalWorks} 篇作品 · 本周已发布 {publishedThisWeek} 篇</span><div className="actions"><button type="button" className="text-button" onClick={() => openExtra('desktop-account-health')}><HeartPulse aria-hidden="true" />账号健康度</button><Link className="text-button" to={`/a/${account.id}/calendar`}><CalendarDays aria-hidden="true" />内容日历</Link><Link className="text-button" to={`/a/${account.id}/profile`}><BookOpenCheck aria-hidden="true" />风格与记忆</Link></div></div>

      <details ref={extrasRef} className="desktop-home-extras" data-testid="desktop-home-extras">
        <summary>更多工作台信息 <ChevronDown aria-hidden="true" /></summary>
        <div className="desktop-home-extra-content">
          <div className="desktop-home-extra-actions"><Link to={`/a/${account.id}/topics?suggest=1`}><Button icon={<Sparkles className="size-4" />}>AI 选题建议</Button></Link><Button variant="primary" icon={<PenLine className="size-4" />} onClick={create}>新建作品</Button></div>
          <MainLine accountId={account.id} hideSetup={hideSetup} panelID="desktop-main-line" />
          <div id="desktop-daily-recommendations"><DailyPanel key={`daily-${account.id}`} accountId={account.id} compact /></div>
          <BriefCard accountId={account.id} />
          <div className="desktop-dashboard-panels"><HotPanel key={`hot-${account.id}`} account={account} compact /></div>
          <div className="desktop-stats-grid">
            <Stat label="进行中的作品" value={inProgress} sub={`共 ${totalWorks} 篇作品`} icon={<FilePen />} to={`/a/${account.id}/works`} />
            <Stat label="待定选题" value={data.pending_topics} sub="去选题池挑一个" icon={<Lightbulb />} to={`/a/${account.id}/topics`} />
            {account.platform === 'wechat_mp' ? <Stat label="今日写入草稿" value={<>{data.today_push}<span className="text-lg text-mist-400"> / {data.daily_limit}</span></>} sub="超出上限需要二次确认" icon={<Send />} /> : <Stat label="已发布" value={data.counts.published ?? 0} sub="回填后计入" icon={<ClipboardCheck />} />}
            <Stat label="今日 AI 用量" value={fmtNum(data.tokens_today)} sub={data.ai_limit.enabled ? `上限 ${fmtNum(data.ai_limit.daily_tokens)} token` : '未设置每日上限'} icon={<Cpu />} to="/settings/usage" />
          </div>
          <section className="desktop-all-todos" aria-labelledby="desktop-all-todos-title"><h2 id="desktop-all-todos-title">全部作品待办</h2><div className="mb-8 grid gap-4 lg:grid-cols-2 2xl:grid-cols-4">{groups.map((group) => {
            const items = data.todos.filter((todo) => group.kinds.includes(todo.kind))
            const mixedFormat = new Set(items.map((todo) => todo.content_format).filter(Boolean)).size > 1
            return <Card key={group.title} className="flex flex-col"><div className="flex items-center gap-2 border-b border-mist-100 px-5 py-3.5"><span className="text-mist-400">{group.icon}</span><h3 className="text-[14.5px] font-semibold text-mist-900">{group.title}</h3><span className="text-xs tabular-nums text-mist-400">{items.length}</span></div>{items.length === 0 ? <p className="px-5 py-8 text-center text-[13px] text-mist-400">{group.empty}</p> : <ul className="divide-y divide-mist-100">{items.slice(0, 6).map((todo) => <li key={todo.work_id + todo.kind}><Link to={todoLink(todo, account.id, account.platform)} className="group flex items-center gap-3 px-5 py-3 transition hover:bg-mist-50"><div className="min-w-0 flex-1"><div className="truncate text-[13.5px] font-medium text-mist-800 group-hover:text-ink-700">{todo.title || '未命名作品'}</div><div className="mt-0.5 flex items-center gap-2 text-xs text-mist-500"><StatusBadge status={todo.status} />{(mixedFormat || account.platform === 'toutiao') && todo.content_format && <span className="rounded bg-mist-100 px-1 py-px text-[10.5px]">{platformFormatLabel(account.platform, todo.content_format)}</span>} {todo.hint} · {relTime(todo.at)}</div></div><ArrowRight className="size-4 text-mist-300 transition group-hover:translate-x-0.5 group-hover:text-ink-500" /></Link></li>)}</ul>}
              {/* DB-03：每列只显示 6 条，剩下的必须给"查看全部（N）"而不是静默截断。 */}
              {items.length > 6 && (
                <Link to={`/a/${account.id}/works?status=${groupStatus(group.kinds)}`} className="mt-auto block border-t border-mist-100 px-5 py-3 text-center text-[12.5px] font-medium text-ink-700 transition hover:bg-mist-50">
                  查看全部（{items.length}）
                </Link>
              )}
            </Card>
          })}</div></section>
          <div id="desktop-account-health"><HealthAndRhythm accountId={account.id} /></div>
          {pendingSetup.length > 0 && <Card className="mb-6 overflow-hidden"><div className="flex items-center justify-between border-b border-mist-100 bg-gamboge-50/50 px-5 py-3"><div className="text-[13.5px] font-semibold text-mist-800">进阶提升 · 还有 {pendingSetup.length} 项可补充</div><div className="text-xs text-mist-500">{setupItems.length - pendingSetup.length} / {setupItems.length} 已完成 · 不阻塞首条推荐</div></div><div className="grid divide-mist-100 sm:grid-cols-2 lg:grid-cols-4 lg:divide-x">{setupItems.map((item) => <Link key={item.label} to={item.to} className={cn('group flex items-start gap-3 px-5 py-4 transition hover:bg-mist-50', item.done && 'opacity-55')}>{item.done ? <CheckCircle2 className="mt-0.5 size-4 text-success" /> : <Circle className="mt-0.5 size-4 text-gamboge-400" />}<div><div className="text-[13.5px] font-medium text-mist-800 group-hover:text-ink-700">{item.label}</div><div className="text-xs text-mist-500">{item.desc}</div></div></Link>)}</div></Card>}
          {canWrite && guideVisible && <details className="desktop-first-value-disclosure" data-testid="desktop-first-value-disclosure"><summary><span className="desktop-first-value-icon"><Lightbulb aria-hidden="true" /></span><span className="desktop-first-value-copy"><strong>首次创作路径</strong><small>查看从第一篇作品到第一条推荐的 5 步准备</small></span><ChevronDown aria-hidden="true" /></summary><FirstValueGuide key={account.id} accountId={account.id} modelReady={setup.ai} profileReady={setup.profile} hasWork={totalWorks > 0} /></details>}
          <DemoCard acc={account} owner={owner} />
        </div>
      </details>
    </div>
  )
}

export default function Dashboard() {
  const acc = useCurrentAccount()
  const canWrite = useCanWrite()
  const { data: me } = useMe()
  const { data, isLoading, error, failureReason, isFetching, refetch } = useQuery({ queryKey: ['dashboard', acc?.id], queryFn: () => get<Dash>(`/accounts/${acc!.id}/dashboard`), enabled: !!acc })
  const create = useCreateWork(acc?.id, acc?.platform)
  const prefetch = usePrefetchWork()
  const daily = useQuery({ queryKey: ['daily', acc?.id, 'preview'], queryFn: () => get<DailyResult>(`/accounts/${acc!.id}/daily?prepare=false`), enabled: !!acc })
  const health = useQuery({ queryKey: ['health', acc?.id], queryFn: () => get<{ score: number; items: HealthItem[] }>(`/accounts/${acc!.id}/health`), enabled: !!acc, staleTime: 60_000 })
  const firstTodos = (data?.todos ?? []).slice(0, 3).map((t) => t.work_id).join(',')
  useEffect(() => {
    if (firstTodos) for (const id of firstTodos.split(',')) void prefetch.load(id)
  }, [firstTodos]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!acc || isLoading || !data) return <PageState loading={!acc || isLoading} error={error ?? failureReason} retrying={isFetching} onRetry={() => void refetch()} emptyTitle="暂无工作台数据" />
  const s = data.setup
  const setupItems = [
    { done: s.ai, label: '配置模型', desc: 'AI 功能需要至少一个模型', to: '/settings/models', icon: <Cpu className="size-4" /> },
    ...(health.data
      ? health.data.items.map((it) => ({ done: it.score >= it.max, label: it.label, desc: it.hint || `${it.score}/${it.max}`, to: it.link, icon: <HeartPulse className="size-4" /> }))
      : [
          { done: s.profile, label: '填写定位档案', desc: '定位、读者、语气', to: `/a/${acc.id}/profile`, icon: <BookOpenCheck className="size-4" /> },
          { done: s.samples, label: '补充风格样本', desc: '建议 3 篇以上过往作品', to: `/a/${acc.id}/profile?tab=samples`, icon: <PenLine className="size-4" /> },
        ]),
    ...(acc.platform === 'wechat_mp' ? [{ done: s.credential, label: '连接公众号', desc: 'AppID、AppSecret 和 IP 白名单', to: currentAccountSettingsPath(acc.id), icon: <KeyRound className="size-4" /> }] : []),
  ]
  const pendingSetup = setupItems.filter((i) => !i.done)
  const guideVisible = canWrite && !!daily.data && !daily.data.recommendation
  const inProgress = (data.counts.drafting ?? 0) + (data.counts.checking ?? 0)
  const hour = new Date().getHours()
  const greet = hour < 6 ? '夜深了' : hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好'

  if (document.documentElement.dataset.presentation === 'ops-creative-desktop') {
    return <DesktopDashboard account={acc} data={data} canWrite={canWrite} guideVisible={guideVisible} owner={me?.role === 'owner'} create={() => create()} setup={s} setupItems={setupItems} pendingSetup={pendingSetup} hideSetup={guideVisible} />
  }

  return (
    <div className="animate-fade-in">
      <PageHeader
        eyebrow={new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })}
        title={`${greet}，今天写点什么？`}
        desc={`当前账号：${acc.name}`}
        action={canWrite ? <>
          <Link to={`/a/${acc.id}/topics?suggest=1`}><Button icon={<Sparkles className="size-4" />}>AI 选题建议</Button></Link>
          <Button variant="primary" icon={<PenLine className="size-4" />} onClick={() => create()}>新建作品</Button>
        </> : undefined}
      />

      <DemoCard acc={acc} owner={me?.role === 'owner'} />
      {canWrite && <FirstValueGuide key={acc.id} accountId={acc.id} modelReady={s.ai} profileReady={s.profile} hasWork={!!data?.counts && Object.values(data.counts).some((n) => (n ?? 0) > 0)} />}
      <MainLine accountId={acc.id} hideSetup={guideVisible} />
      <BriefCard accountId={acc.id} />
      <div className="mb-6 grid gap-5 xl:grid-cols-2"><DailyPanel key={`daily-${acc.id}`} accountId={acc.id} compact /><HotPanel key={`hot-${acc.id}`} account={acc} compact /></div>

      <div className="mb-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="进行中的作品" value={inProgress} sub={`共 ${Object.values(data.counts).reduce((a, b) => a + (b ?? 0), 0)} 篇作品`} icon={<FilePen />} to={`/a/${acc.id}/works`} />
        <Stat label="待定选题" value={data.pending_topics} sub="去选题池挑一个" icon={<Lightbulb />} to={`/a/${acc.id}/topics`} />
        {acc.platform === 'wechat_mp' ? (
          <Stat label="今日写入草稿" value={<>{data.today_push}<span className="text-lg text-mist-400"> / {data.daily_limit}</span></>} sub="超出上限需要二次确认" icon={<Send />} />
        ) : (
          <Stat label="已发布" value={data.counts.published ?? 0} sub="回填后计入" icon={<ClipboardCheck />} />
        )}
        <Stat label="今日 AI 用量" value={fmtNum(data.tokens_today)} sub={data.ai_limit.enabled ? `上限 ${fmtNum(data.ai_limit.daily_tokens)} token` : '未设置每日上限'} icon={<Cpu />} to="/settings/usage" />
      </div>

      <h2 className="mb-3 text-[13px] font-semibold text-mist-500">全部作品待办</h2>
      <div className="mb-8 grid gap-5 lg:grid-cols-2 2xl:grid-cols-4">
        {groups.map((g) => {
          const items = data.todos.filter((t) => g.kinds.includes(t.kind))
          const mixedFormat = new Set(items.map((t) => t.content_format).filter(Boolean)).size > 1
          return (
            <Card key={g.title} className="flex flex-col">
              <div className="flex items-center gap-2 border-b border-mist-100 px-5 py-3.5">
                <span className={cn('text-mist-400', g.title === '待回填' && items.length > 0 && 'text-gamboge-500')}>{g.icon}</span>
                <h3 className="text-[14.5px] font-semibold text-mist-900">{g.title}</h3>
                <span className="text-xs tabular-nums text-mist-400">{items.length}</span>
              </div>
              {items.length === 0 ? (
                <p className="px-5 py-8 text-center text-[13px] text-mist-400">{g.empty}</p>
              ) : (
                <ul className="divide-y divide-mist-100">
                  {items.slice(0, 6).map((t) => (
                    <li key={t.work_id + t.kind}>
                      <Link to={todoLink(t, acc.id, acc.platform)} {...prefetch.hover(t.work_id)} className="group flex items-center gap-3 px-5 py-3 transition hover:bg-mist-50">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13.5px] font-medium text-mist-800 group-hover:text-ink-700">{t.title || '未命名作品'}</div>
                          <div className="mt-0.5 flex items-center gap-2 text-xs text-mist-500"><StatusBadge status={t.status} />{(mixedFormat || acc.platform === 'toutiao') && t.content_format && <span className="rounded bg-mist-100 px-1 py-px text-[10.5px]">{platformFormatLabel(acc.platform, t.content_format)}</span>} {t.hint} · {relTime(t.at)}</div>
                        </div>
                        <ArrowRight className="size-4 text-mist-300 transition group-hover:translate-x-0.5 group-hover:text-ink-500" />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              {/* DB-03：网页版同样只在列内显示 6 条，剩下的给"查看全部（N）"。 */}
              {items.length > 6 && (
                <Link to={`/a/${acc.id}/works?status=${groupStatus(g.kinds)}`} className="mt-auto block border-t border-mist-100 px-5 py-3 text-center text-[12.5px] font-medium text-ink-700 transition hover:bg-mist-50">
                  查看全部（{items.length}）
                </Link>
              )}
            </Card>
          )
        })}
      </div>

      <HealthAndRhythm accountId={acc.id} />

      {pendingSetup.length > 0 && (
        <Card className="mb-6 overflow-hidden">
          <div className="flex items-center justify-between border-b border-mist-100 bg-gamboge-50/50 px-5 py-3">
            <div className="text-[13.5px] font-semibold text-mist-800">进阶提升 · 还有 {pendingSetup.length} 项可补充</div>
            <div className="text-xs text-mist-500">{setupItems.length - pendingSetup.length} / {setupItems.length} 已完成 · 不阻塞首条推荐</div>
          </div>
          <div className="grid divide-mist-100 sm:grid-cols-2 lg:grid-cols-4 lg:divide-x">
            {setupItems.map((i) => (
              <Link key={i.label} to={i.to} className={cn('group flex items-start gap-3 px-5 py-4 transition hover:bg-mist-50', i.done && 'opacity-55')}>
                {i.done ? <CheckCircle2 className="mt-0.5 size-4 text-success" /> : <Circle className="mt-0.5 size-4 text-gamboge-400" />}
                <div>
                  <div className="text-[13.5px] font-medium text-mist-800 group-hover:text-ink-700">{i.label}</div>
                  <div className="text-xs text-mist-500">{i.desc}</div>
                </div>
              </Link>
            ))}
          </div>
        </Card>
      )}
    </div>
  )
}
