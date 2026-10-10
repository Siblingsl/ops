import { DailyPanel } from './ops/Daily'
import HotPanel from './ops/Hot'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight, BookOpenCheck, Brain, CalendarDays, CheckCircle2, Circle, ClipboardCheck, Compass, Cpu, FilePen, HeartPulse, KeyRound, Lightbulb, PenLine, Send, Sparkles, TrendingUp, UploadCloud } from 'lucide-react'
import { useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { confirm } from '@/components/dialog'
import { Button, Card, cn, Empty, Notice, PageHeader, PageLoading, StatusBadge } from '@/components/ui'
import { del, errorMessage, get, post } from '@/lib/api'
import { fmtNum, relTime } from '@/lib/format'
import { useAccounts, useCanWrite, useCurrentAccount, useInvalidate, useMe } from '@/lib/session'
import type { Account, AILimit, HealthItem, NextAction, Work, WorkStatus } from '@/lib/types'
import { usePendingMemories, usePrefetchWork } from '@/lib/v3'

interface Todo { work_id: string; title: string; status: WorkStatus; kind: string; hint: string; at: string }
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
  { kinds: ['metric'], title: '复盘提醒', icon: <TrendingUp className="size-4" />, empty: '发布满一天后提醒你录入数据' },
]

function todoLink(t: Todo, accountId: string) {
  switch (t.kind) {
    case 'check': return `/works/${t.work_id}/check`
    case 'push': return `/works/${t.work_id}/push`
    case 'pack': return `/works/${t.work_id}/pack`
    case 'publish': return `/works/${t.work_id}/${t.status === 'packed' ? 'pack' : 'push'}`
    case 'metric': return `/a/${accountId}/review?work=${t.work_id}`
    default: return `/works/${t.work_id}`
  }
}

export function useCreateWork(accountId?: string) {
  const nav = useNavigate()
  return async (title = '') => {
    if (!accountId) return
    try {
      const w = await post<Work>(`/accounts/${accountId}/works`, { title })
      nav(`/works/${w.id}`)
    } catch (e) {
      toast.error(errorMessage(e))
    }
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

function NextActions({ accountId }: { accountId: string }) {
  const { data: all } = useQuery({ queryKey: ['next-actions', accountId], queryFn: () => get<NextAction[]>(`/accounts/${accountId}/next-actions`), staleTime: 30_000 })
  const data = all?.filter((a) => a.kind !== 'memory')
  if (!data || data.length === 0) return null
  return (
    <Card className="mb-6 overflow-hidden border-ink-100">
      <div className="flex items-center gap-2 border-b border-ink-100 bg-ink-50/50 px-5 py-3">
        <Compass className="size-4 text-ink-600" />
        <h3 className="text-[14px] font-semibold text-mist-900">现在最值得做的</h3>
        <span className="text-xs text-mist-400">按截止日、进度和数据提醒排序</span>
      </div>
      <ul className="divide-y divide-mist-100">
        {data.map((a, i) => (
          <li key={a.kind + i}>
            <Link to={a.link} className="group flex items-center gap-3 px-5 py-3 transition hover:bg-mist-50">
              <span className={cn('flex size-6 shrink-0 items-center justify-center rounded-full text-[12px] font-bold', i === 0 ? 'bg-ink-600 text-white' : 'bg-mist-100 text-mist-500')}>{i + 1}</span>
              <span className="min-w-0 flex-1 text-[13.5px] text-mist-800 group-hover:text-ink-700">{a.text}</span>
              <span className="shrink-0 rounded-full border border-mist-200 px-2.5 py-0.5 text-[12px] text-mist-600 group-hover:border-ink-300 group-hover:text-ink-700">{a.action}</span>
            </Link>
          </li>
        ))}
      </ul>
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

export default function Dashboard() {
  const acc = useCurrentAccount()
  const canWrite = useCanWrite()
  const { data: me } = useMe()
  const { data, isLoading } = useQuery({ queryKey: ['dashboard', acc?.id], queryFn: () => get<Dash>(`/accounts/${acc!.id}/dashboard`), enabled: !!acc })
  const create = useCreateWork(acc?.id)
  const prefetch = usePrefetchWork()
  const pendingMemories = usePendingMemories(acc?.id)
  const health = useQuery({ queryKey: ['health', acc?.id], queryFn: () => get<{ score: number; items: HealthItem[] }>(`/accounts/${acc!.id}/health`), enabled: !!acc, staleTime: 60_000 })
  const firstTodos = (data?.todos ?? []).slice(0, 3).map((t) => t.work_id).join(',')
  useEffect(() => {
    if (firstTodos) for (const id of firstTodos.split(',')) void prefetch.load(id)
  }, [firstTodos]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!acc || isLoading || !data) return <PageLoading />
  const s = data.setup
  const setupItems = [
    { done: s.ai, label: '配置模型', desc: 'AI 功能需要至少一个模型', to: '/settings/models', icon: <Cpu className="size-4" /> },
    ...(health.data
      ? health.data.items.map((it) => ({ done: it.score >= it.max, label: it.label, desc: it.hint || `${it.score}/${it.max}`, to: it.link, icon: <HeartPulse className="size-4" /> }))
      : [
          { done: s.profile, label: '填写定位档案', desc: '定位、读者、语气', to: `/a/${acc.id}/profile`, icon: <BookOpenCheck className="size-4" /> },
          { done: s.samples, label: '补充风格样本', desc: '建议 3 篇以上过往作品', to: `/a/${acc.id}/profile?tab=samples`, icon: <PenLine className="size-4" /> },
        ]),
    ...(acc.platform === 'wechat_mp' ? [{ done: s.credential, label: '连接公众号', desc: 'AppID、AppSecret 和 IP 白名单', to: '/settings/accounts', icon: <KeyRound className="size-4" /> }] : []),
  ]
  const pendingSetup = setupItems.filter((i) => !i.done)
  const inProgress = (data.counts.drafting ?? 0) + (data.counts.checking ?? 0)
  const hour = new Date().getHours()
  const greet = hour < 6 ? '夜深了' : hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好'

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

      {pendingMemories > 0 && (
        <Link to={`/a/${acc.id}/profile?tab=memory`} className="mb-5 block">
          <Notice tone="gamboge" icon={<Brain className="size-4" />} className="transition hover:border-gamboge-300">
            AI 学到了 {pendingMemories} 条新偏好，去确认 →<span className="ml-1 text-[12px] opacity-75">确认前不会影响任何生成</span>
          </Notice>
        </Link>
      )}
      <DemoCard acc={acc} owner={me?.role === 'owner'} />
      <NextActions accountId={acc.id} />
 <div className="mb-6 grid gap-5 xl:grid-cols-2"><DailyPanel key={`daily-${acc.id}`} accountId={acc.id} compact/><HotPanel key={`hot-${acc.id}`} account={acc} compact/></div>

      {pendingSetup.length > 0 && (
        <Card className="mb-6 overflow-hidden">
          <div className="flex items-center justify-between border-b border-mist-100 bg-gamboge-50/50 px-5 py-3">
            <div className="text-[13.5px] font-semibold text-mist-800">还差 {pendingSetup.length} 步，让 AI 更懂这个账号</div>
            <div className="text-xs text-mist-500">{setupItems.length - pendingSetup.length} / {setupItems.length} 已完成</div>
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

      <HealthAndRhythm accountId={acc.id} />

      <div className="grid gap-5 lg:grid-cols-2 2xl:grid-cols-4">
        {groups.map((g) => {
          const items = data.todos.filter((t) => g.kinds.includes(t.kind))
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
                      <Link to={todoLink(t, acc.id)} {...prefetch.hover(t.work_id)} className="group flex items-center gap-3 px-5 py-3 transition hover:bg-mist-50">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13.5px] font-medium text-mist-800 group-hover:text-ink-700">{t.title || '未命名作品'}</div>
                          <div className="mt-0.5 flex items-center gap-2 text-xs text-mist-500"><StatusBadge status={t.status} /> {t.hint} · {relTime(t.at)}</div>
                        </div>
                        <ArrowRight className="size-4 text-mist-300 transition group-hover:translate-x-0.5 group-hover:text-ink-500" />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )
        })}
      </div>
      {data.todos.length === 0 && pendingSetup.length === 0 && (
        <Empty className="mt-6" icon={<PenLine className="size-5" />} title="一切就绪" desc="从选题池挑一个题目，或者直接新建作品开始写。"
          action={<Link to={`/a/${acc.id}/topics`}><Button variant="primary" icon={<Lightbulb className="size-4" />}>去选题池</Button></Link>} />
      )}
    </div>
  )
}
