import { useQuery } from '@tanstack/react-query'
import { Users } from 'lucide-react'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { Badge, Button, Card, CardHeader, Field, Input, Notice } from '@/components/ui'
import { errorMessage, get, post } from '@/lib/api'
import { fmtNum } from '@/lib/format'
import type { FollowerDay, FollowerList, FollowerPlatformSummary, FollowerSummary } from '@/lib/types'

const yesterday = () => {
  const d = new Date(Date.now() - 86400000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

type FormKey = 'new_follow' | 'cancel_follow' | 'cumulate'
const formFields: { key: FormKey; label: string }[] = [
  { key: 'new_follow', label: '新增关注' }, { key: 'cancel_follow', label: '取消关注' }, { key: 'cumulate', label: '粉丝总数' },
]

const sourceLabel: Record<string, string> = {
  wechat_api: '公众号接口', desktop_live: '桌面实时', manual: '手动录入',
  desktop_backfill: '桌面回填', import: '导入', wechat_browser: '公众号浏览器', xhs_browser: '小红书浏览器',
}
const sourceClass: Record<string, string> = {
  wechat_api: 'bg-[#e8f8ef] text-[#078a46]', desktop_live: 'bg-sky-50 text-sky-700 ring-1 ring-inset ring-sky-100',
  manual: 'bg-mist-100 text-mist-600', desktop_backfill: 'bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-100',
  import: 'bg-violet-50 text-violet-700 ring-1 ring-inset ring-violet-100',
}
const platformLabel: Record<string, string> = { wechat_mp: '公众号', xhs: '小红书', toutiao: '今日头条' }

const showSource = (source: string) => sourceLabel[source] ?? source ?? '—'
const showPlatform = (platform: string) => platformLabel[platform] ?? platform
const showNumber = (value: number | null) => value == null ? '—' : fmtNum(value)
const showCollected = (value?: string) => {
  if (!value) return '采集时间未知'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

/** 30 天折线：缺失日期不连线，不能把缺口画成 0。 */
function Sparkline({ series }: { series: FollowerDay[] }) {
  const known = series.filter((day) => day.cumulate != null)
  if (known.length === 0) return <span className="text-xs text-mist-400">无数据</span>
  const values = known.map((day) => day.cumulate as number)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const paths: string[] = []
  let current = ''
  for (let index = 0; index < series.length; index += 1) {
    const value = series[index].cumulate
    if (value == null) {
      if (current) paths.push(current)
      current = ''
      continue
    }
    const x = series.length <= 1 ? 60 : 4 + (index / (series.length - 1)) * 112
    const y = 4 + (max === min ? 0.5 : 1 - (value - min) / (max - min)) * 28
    current += `${current === '' ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`
  }
  if (current) paths.push(current)
  return (
    <svg viewBox="0 0 120 36" className="h-8 w-[120px]" role="img" aria-label="近 30 天粉丝总数折线">
      {paths.map((path) => <path key={path} d={path} fill="none" className="stroke-mist-500" strokeWidth="1.5" />)}
      {series.length === 1 && <circle cx="60" cy="18" r="2" className="fill-mist-500" />}
    </svg>
  )
}

function platformGaps(p: FollowerPlatformSummary): string[] {
  return p.gaps ?? []
}

/** DEV-DR09 / REF41 I6：账号粉丝变化、来源、跨平台汇总与逐日回填。 */
export function FollowersCard({ accountId, platform, canManage }: { accountId: string; platform: string; canManage: boolean }) {
  const q = useQuery({ queryKey: ['followers', accountId], queryFn: () => get<FollowerList>(`/accounts/${accountId}/followers?days=30`) })
  const summary = useQuery({ queryKey: ['follower-summary', accountId], queryFn: () => get<FollowerSummary>(`/accounts/${accountId}/followers/summary?days=30`) })
  const [open, setOpen] = useState(false)
  const [date, setDate] = useState(yesterday)
  const [vals, setVals] = useState<Record<FormKey, string>>({ new_follow: '', cancel_follow: '', cumulate: '' })
  const [busy, setBusy] = useState(false)
  const [backfill, setBackfill] = useState<{ accountId: string; platform: string; date: string } | null>(null)
  const [backfillTotal, setBackfillTotal] = useState('')
  const [backfillBusy, setBackfillBusy] = useState(false)
  const [importBusy, setImportBusy] = useState(false)
  const importInput = useRef<HTMLInputElement>(null)
  const days = q.data?.days ?? []
  const snap = summary.data
  const refresh = () => { void q.refetch(); void summary.refetch() }
  const save = async () => {
    if (!canManage) return
    const body: Record<string, string | number> = { date }
    for (const f of formFields) if (vals[f.key].trim() !== '') body[f.key] = Number(vals[f.key])
    setBusy(true)
    try {
      await post(`/accounts/${accountId}/followers`, body)
      toast.success(`已记录 ${date} 的粉丝数据`)
      setVals({ new_follow: '', cancel_follow: '', cumulate: '' })
      refresh()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const openBackfill = (p: FollowerPlatformSummary, gap: string) => {
    if (!canManage) return
    setBackfill({ accountId: p.account_id, platform: p.platform, date: gap })
    setBackfillTotal('')
  }
  const saveBackfill = async () => {
    if (!canManage || !backfill || backfillTotal.trim() === '') return
    setBackfillBusy(true)
    try {
      await post(`/accounts/${backfill.accountId}/followers/backfill`, {
        platform: backfill.platform, from: backfill.date, to: backfill.date,
        values: [{ date: backfill.date, count: Number(backfillTotal) }],
      })
      toast.success(`已回填 ${backfill.date} 的粉丝总数`)
      setBackfill(null)
      refresh()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBackfillBusy(false)
    }
  }
  const importCSV = async (file: File | undefined) => {
    if (!canManage || !file) return
    setImportBusy(true)
    try {
      const result = await post<{ imported: number; skipped_dates: string[] }>(`/accounts/${accountId}/followers/import`, {
        csv: await file.text(),
      })
      const skipped = result.skipped_dates?.length ?? 0
      toast.success(skipped
        ? `已导入 ${result.imported} 天；${skipped} 天已有数据，未覆盖`
        : `已导入 ${result.imported} 天粉丝数据`)
      refresh()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setImportBusy(false)
      if (importInput.current) importInput.current.value = ''
    }
  }
  const desc = q.data?.api
    ? '公众号数据同步时一并读取最近 7 天的新增、取消关注和粉丝总数；桌面实时、手动补录和回填按来源优先级合并'
    : '桌面实时、平台后台抄录和逐日回填都会保留来源；同一天按公众号接口/桌面实时、手动、回填的优先级取值'
  const loadError = q.error ?? summary.error
  return (
    <Card data-testid="i6-followers-card">
      <CardHeader title="账号粉丝变化（近 30 天）" desc={`${desc}；当前账号：${showPlatform(platform)}`}
        action={canManage ? (
          <div className="flex items-center gap-2">
            <input ref={importInput} type="file" accept=".csv,text/csv" className="hidden" data-testid="i6-followers-import-input"
              onChange={(e) => void importCSV(e.target.files?.[0])} />
            <Button size="sm" variant="secondary" loading={importBusy} onClick={() => importInput.current?.click()} data-testid="i6-followers-import">
              导入 CSV
            </Button>
            <Button size="sm" variant="secondary" icon={<Users className="size-3.5" />} onClick={() => setOpen((o) => !o)}>{open ? '收起' : '补录一天'}</Button>
          </div>
        ) : undefined} />
      {!canManage && <p data-testid="i6-followers-readonly" className="border-b border-mist-100 px-5 py-3 text-[12px] text-mist-500">当前角色只读：可查看粉丝趋势与来源，补录/回填入口仅所有者或编辑可见。</p>}
      {loadError && (
        <div className="border-b border-mist-100 px-5 py-3">
          <Notice tone="red" data-testid="i6-followers-error">
            粉丝数据加载失败：{errorMessage(loadError)}
            <Button size="sm" variant="ghost" onClick={refresh}>重试</Button>
          </Notice>
        </div>
      )}
      {snap && (
        <div className="grid gap-3 border-b border-mist-100 px-5 py-4 sm:grid-cols-3" data-testid="i6-follower-summary">
          <div data-testid="i6-follower-total">
            <div className="text-xs text-mist-400">合计粉丝（仅有值平台）</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums text-mist-900">{showNumber(snap.total)}</div>
          </div>
          <div>
            <div className="text-xs text-mist-400">覆盖平台</div>
            <div className="mt-1 text-sm tabular-nums text-mist-700"><span data-testid="i6-covered-platforms">{snap.covered_platforms}</span> / {snap.total_platforms}</div>
          </div>
          <div>
            <div className="text-xs text-mist-400">缺失平台（不补 0）</div>
            <div className="mt-1 flex flex-wrap gap-1.5 text-sm text-mist-700">
              {snap.missing_platforms.length === 0 ? '无' : snap.missing_platforms.map((p) => <Badge key={p}>{showPlatform(p)}</Badge>)}
            </div>
          </div>
        </div>
      )}
      {open && canManage && (
        <div className="grid items-end gap-3 border-b border-mist-100 px-5 py-4 sm:grid-cols-[150px_repeat(3,1fr)_auto]">
          <Field label="日期"><Input type="date" value={date} max={yesterday()} onChange={(e) => setDate(e.target.value)} /></Field>
          {formFields.map((f) => (
            <Field key={f.key} label={f.label}>
              <Input type="number" min={0} inputMode="numeric" value={vals[f.key]} placeholder="可留空" onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} />
            </Field>
          ))}
          <Button variant="primary" loading={busy} disabled={formFields.every((f) => vals[f.key].trim() === '')} onClick={save}>保存</Button>
        </div>
      )}
      {backfill && canManage && (
        <div className="flex flex-wrap items-end gap-3 border-b border-amber-100 bg-amber-50/40 px-5 py-4" data-testid="i6-backfill-form">
          <div className="text-[13px] text-mist-700">回填 <span className="font-medium">{showPlatform(backfill.platform)}</span> · {backfill.date} 的粉丝总数</div>
          <Field label="粉丝总数"><Input type="number" min={0} inputMode="numeric" value={backfillTotal} onChange={(e) => setBackfillTotal(e.target.value)} /></Field>
          <Button variant="primary" loading={backfillBusy} disabled={backfillTotal.trim() === ''} onClick={saveBackfill}>写入缺失日</Button>
          <Button variant="ghost" onClick={() => setBackfill(null)}>取消</Button>
        </div>
      )}
      {snap && snap.platforms.length > 0 && (
        <div className="divide-y divide-mist-50 border-b border-mist-100" data-testid="i6-platform-list">
          {snap.platforms.map((p) => (
            <div key={`${p.platform}-${p.account_id}`} className="grid gap-3 px-5 py-4 sm:grid-cols-[150px_1fr_130px] sm:items-center" data-testid="i6-platform-row" data-platform={p.platform}>
              <div>
                <div className="text-[13px] font-medium text-mist-800">{showPlatform(p.platform)}</div>
                <div className="text-xs text-mist-400">{p.account_name}</div>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-lg font-semibold tabular-nums text-mist-900" data-testid="i6-platform-latest">{showNumber(p.latest)}</span>
                <span data-testid="i6-platform-source"><Badge className={sourceClass[p.source] ?? ''}>{p.source ? showSource(p.source) : '未采集'}</Badge></span>
                <span className="text-xs text-mist-400" data-testid="i6-platform-collected">{showCollected(p.collected_at)}</span>
                <Sparkline series={p.series} />
              </div>
              <div>
                {platformGaps(p).length === 0 ? (
                  <div className="text-xs text-mist-400">30 天无缺口</div>
                ) : (
                  <div className="flex flex-wrap gap-1.5" data-testid="i6-platform-gaps">
                    {platformGaps(p).slice(-4).map((gap) => canManage ? (
                      <button key={gap} type="button" data-testid="i6-follower-gap" onClick={() => openBackfill(p, gap)}
                        className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[11.5px] text-amber-800 hover:bg-amber-100">
                        {gap}
                      </button>
                    ) : (
                      <span key={gap} data-testid="i6-follower-gap-readonly" className="rounded border border-amber-100 bg-amber-50/60 px-1.5 py-0.5 text-[11.5px] text-amber-700">{gap}</span>
                    ))}
                    {platformGaps(p).length > 4 && <span className="text-xs text-mist-400">等 {platformGaps(p).length} 天</span>}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {days.length === 0 ? (
        <p className="p-5 text-[13px] text-mist-500">{q.data?.api ? '还没有同步到粉丝数据，点「同步公众号数据」或等每天的自动同步。' : '还没有粉丝数据。'}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[13.5px]" data-testid="i6-followers-days-table">
            <thead>
              <tr className="border-b border-mist-100 text-left text-xs text-mist-400">
                <th className="py-2.5 pl-5 font-medium">日期</th>
                <th className="py-2.5 text-right font-medium">新增关注</th>
                <th className="py-2.5 text-right font-medium">取消关注</th>
                <th className="py-2.5 text-right font-medium">净增</th>
                <th className="py-2.5 text-right font-medium">粉丝总数</th>
                <th className="py-2.5 pr-5 text-right font-medium">来源</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr key={d.date} className="border-b border-mist-50">
                  <td className="py-2.5 pl-5 tabular-nums text-mist-700">{d.date}</td>
                  <td className="py-2.5 text-right tabular-nums text-mist-700">{fmtNum(d.new_follow)}</td>
                  <td className="py-2.5 text-right tabular-nums text-mist-700">{fmtNum(d.cancel_follow)}</td>
                  <td className="py-2.5 text-right tabular-nums text-mist-800">{d.net == null ? '—' : `${d.net > 0 ? '+' : ''}${fmtNum(d.net)}`}</td>
                  <td className="py-2.5 text-right tabular-nums text-mist-700">{fmtNum(d.cumulate)}</td>
                  <td className="py-2.5 pr-5 text-right"><Badge className={sourceClass[d.source] ?? ''}>{showSource(d.source)}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
