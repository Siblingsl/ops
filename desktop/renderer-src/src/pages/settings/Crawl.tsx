import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Badge, Button, Card, CardHeader, Empty, Field, Input, Notice, PageHeader, roleReadOnlyHint, Select, Spinner, Textarea } from '@/components/ui'
import { BackToSettings } from '@/components/back-to-settings'
import { errorMessage, get, post, put } from '@/lib/api'
import { useInvalidate, useMe } from '@/lib/session'
import type { CrawlHealth, CrawlRun, CrawlSettings, CrawlSource, HotSourcesResult, Provider } from '@/lib/types'
import { useEmbeddedSettings, useSettingsDraft } from '@/lib/desktop-settings'

type Platform = { platform: string; enabled: boolean; level: string; interval_min: number; daily_max: number; repeat_hours: number; jitter_min: number; today_requests: number; paused_until: string | null; strikes_7d: number }
function PlatformRow({ value, refresh, dev }: { value: Platform; refresh: () => void; dev: boolean }) {
 const [form, setForm] = useState(value)
 const [busy,setBusy]=useState(false)
 const save=async()=>{setBusy(true);try{await put(`/admin/crawl/platforms/${form.platform}`,form);refresh();toast.success('平台参数已保存')}catch(e){toast.error(errorMessage(e))}finally{setBusy(false)}}
 return <div className="space-y-3 p-5 border-b border-mist-100"><strong>{form.platform==='xhs_page'?'小红书':'公众号'}页面读取</strong><Notice>只读取免登录可见的单篇页面；碰到验证码或登录要求会自动停止，不会尝试绕过。真实平台 robots 禁止，保持停用。</Notice><Field label="档位"><Select value={form.level} onChange={e=>{const level=e.target.value;setForm({...form,level,interval_min:level==='standard'?5:10,daily_max:level==='standard'?80:30,repeat_hours:level==='standard'?24:72,jitter_min:level==='standard'?3:5})}}><option value="conservative">保守</option><option value="standard">标准</option></Select></Field><div className="grid gap-3 md:grid-cols-4">{([{key:'interval_min',label:'间隔（分钟）',min:3,max:1440},{key:'daily_max',label:'每日请求',min:1,max:100},{key:'repeat_hours',label:'重复读取（小时）',min:12,max:720},{key:'jitter_min',label:'随机等待（分钟）',min:0,max:5}] as const).map(f=><Field key={f.key} label={f.label}><Input type="number" min={f.min} max={f.max} value={form[f.key]} onChange={e=>setForm({...form,[f.key]:Number(e.target.value)})}/></Field>)}</div><p className="text-sm">今日 {value.today_requests} 次 · 七天内风控 {value.strikes_7d} 次{value.paused_until&&` · 暂停至 ${new Date(value.paused_until).toLocaleString('zh-CN')}`}</p>{dev&&<label className="flex gap-2 text-sm"><input type="checkbox" checked={form.enabled} onChange={e=>setForm({...form,enabled:e.target.checked})}/>启用本地 mock 页面读取（仍遵守限额）</label>}<Button loading={busy} onClick={save}>保存平台参数</Button></div>
}

function SourceRow({ source, onChange, disabled }: { source: CrawlSource; onChange: () => void; disabled: boolean }) {
  const [interval, setInterval] = useState(source.interval_min)
  const [maxItems, setMaxItems] = useState(source.max_items)
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<string>('')
  const sensitive = source.kind === 'xhs_page' || source.kind === 'wechat_page'
  const save = async (enabled: boolean) => {
    setBusy(true)
    try { await put(`/admin/crawl/sources/${encodeURIComponent(source.key)}`, { enabled, interval_min: interval, max_items: maxItems }); onChange(); toast.success('来源已更新') }
    catch (e) { toast.error(errorMessage(e)) } finally { setBusy(false) }
  }
  const test = async () => {
    setBusy(true)
    try { const data = await post<{ items: { title: string; url: string }[] }>(`/admin/crawl/sources/${encodeURIComponent(source.key)}/test`); setPreview(data.items.map((x) => x.title).join('\n')); onChange() }
    catch (e) { toast.error(errorMessage(e)); onChange() } finally { setBusy(false) }
  }
  return <div className="space-y-3 border-b border-mist-100 p-5">
    <div className="flex flex-wrap items-center gap-2"><strong>{source.name}</strong><Badge tone={source.enabled ? 'green' : 'gray'}>{source.enabled ? '开启' : '关闭'}</Badge>{source.robots_allow === false && <Badge tone="red">robots 不允许</Badge>}</div>
    {sensitive ? <Notice>只读取免登录可见的单篇页面；碰到验证码或登录要求会自动停止，不会尝试绕过。当前 robots 禁止读取，保持停用；请使用手动粘贴参考。</Notice> : <div className="flex flex-wrap items-end gap-3">
      <Field label="最短间隔（分钟）"><Input type="number" min={10} value={interval} onChange={(e) => setInterval(Number(e.target.value))} /></Field>
      <Field label="每次条数"><Input type="number" min={1} max={100} value={maxItems} onChange={(e) => setMaxItems(Number(e.target.value))} /></Field>
      <Button loading={busy} disabled={disabled && !source.enabled} onClick={() => save(!source.enabled)}>{source.enabled ? '关闭来源' : '开启来源'}</Button>
      <Button disabled={busy || !source.enabled || disabled} onClick={() => save(source.enabled)}>保存限额</Button>
      <Button disabled={busy || disabled || !source.enabled} onClick={test}>试采一次</Button>
    </div>}
    <p className="text-xs text-mist-500">最近成功：{source.last_ok_at ? new Date(source.last_ok_at).toLocaleString('zh-CN') : '尚无'}{source.paused_until && ` · 暂停至 ${new Date(source.paused_until).toLocaleString('zh-CN')}`}</p>
    {source.error && <Notice tone="red">{source.error}</Notice>}
    {preview && <pre className="whitespace-pre-wrap text-xs text-mist-600">{preview}</pre>}
  </div>
}

function SourceHealth() {
  const [days, setDays] = useState<7 | 30>(7)
  const q = useQuery({ queryKey: ['crawl-health'], queryFn: () => get<CrawlHealth>('/admin/crawl/health') })
  return <Card><CardHeader title="来源健康度" desc="按现有记录汇总，不发起采集请求。" action={<Button size="sm" onClick={() => q.refetch()}>刷新统计</Button>} />
    <div className="space-y-3 p-5"><Field label="统计窗口"><Select value={days} onChange={e => setDays(Number(e.target.value) as 7 | 30)}><option value={7}>最近 7 天</option><option value={30}>最近 30 天</option></Select></Field>
      <Notice>采纳按同一推荐项去重，采用后开写不重复计数。转选题按匹配创建时间归入窗口；热点清理后关联统计可能减少{q.data ? `，当前热点保留 ${q.data.retention_days} 天` : ''}。</Notice>
      {q.isError ? <Notice tone="red">{errorMessage(q.error)}</Notice> : q.isPending ? <Spinner /> : !q.data.sources.length ? <Empty title="暂无来源" /> : <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr>{['来源', '采集次数', '成功率', '条目数', '匹配数', '转选题数', '推荐采纳数'].map(x => <th key={x} className="p-2">{x}</th>)}</tr></thead><tbody>{q.data.sources.map(row => {
        const stats = days === 7 ? row.days_7 : row.days_30
        return <tr key={row.key} className="border-t border-mist-100"><td className="p-2">{row.name}<span className="block text-xs text-mist-400">{row.key}</span></td><td>{stats.runs || '暂无数据'}</td><td>{stats.success_rate === null ? '—' : `${(stats.success_rate * 100).toFixed(1)}%`}</td><td>{stats.items}</td><td>{stats.matches}</td><td>{stats.converted}</td><td>{stats.adopted}</td></tr>
      })}</tbody></table></div>}
    </div></Card>
}

export default function Crawl() {
  const { data: me } = useMe()
  const inv = useInvalidate()
  const query = useQuery({ queryKey: ['crawl-admin'], queryFn: () => get<{ settings: CrawlSettings; sources: CrawlSource[]; platforms: Platform[] }>('/admin/crawl'), enabled: !!me?.is_system_admin })
  const runs = useQuery({ queryKey: ['crawl-runs'], queryFn: () => get<CrawlRun[]>('/admin/crawl/runs'), enabled: !!me?.is_system_admin })
  const [form, setForm] = useState<CrawlSettings | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (query.data) setForm(query.data.settings) }, [query.data])
  if (me && !me.is_system_admin) return <Navigate to="/settings/accounts" replace />
  const refresh = () => { inv(['crawl-admin'], ['crawl-runs'], ['crawl-health'], ['hot-sources']) }
  const save = async () => {
    setBusy(true)
    try { await put('/admin/crawl', form); refresh(); toast.success('采集设置已保存') } catch (e) { toast.error(errorMessage(e)) } finally { setBusy(false) }
  }
  return <div className="animate-fade-in space-y-5"><PageHeader title="热点采集" desc="公开内容内部参考；固定身份、遵守 robots，限速与风控熔断无法关闭。" action={<BackToSettings />} />
    {query.isError ? <Notice tone="red">{errorMessage(query.error)}</Notice> : !form ? <Spinner /> : <>
      <Card><CardHeader title="全站采集参数" /><div className="space-y-4 p-5">
        {form.mode !== 'allow' && <Notice tone="gamboge">部署方未开启采集，当前无法开启来源。</Notice>}
        <Field label="采集强度"><Select value={form.level} onChange={(e) => { const level = e.target.value as CrawlSettings['level']; setForm({ ...form, level, summary_fetch: level === 'standard' && form.summary_fetch, limits: { ...form.limits, interval_min: level === 'standard' ? 20 : 60, max_items: level === 'standard' ? 100 : 50, daily_requests: level === 'standard' ? 1000 : 300 } }) }}><option value="off">关闭：不发出采集请求</option><option value="conservative" disabled={form.mode !== 'allow'}>保守：每来源一小时看一次榜单</option><option value="standard" disabled={form.mode !== 'allow'}>标准：二十分钟看一次，可补少量摘要</option></Select></Field>
        <div className="grid gap-3 md:grid-cols-3">{([{ key: 'interval_min', label: '全站最短间隔（分钟）', min: 10, max: 1440 }, { key: 'max_items', label: '每次最多条数', min: 1, max: 100 }, { key: 'daily_requests', label: '每日请求总上限', min: 1, max: 2000 }, { key: 'fail_limit', label: '连续失败次数', min: 1, max: 3 }, { key: 'pause_hours', label: '失败暂停（小时）', min: 6, max: 168 }] as const).map((f) => <Field key={f.key} label={f.label}><Input type="number" min={f.min} max={f.max} value={form.limits[f.key]} onChange={(e) => setForm({ ...form, limits: { ...form.limits, [f.key]: Number(e.target.value) } })} /></Field>)}<Field label="热点保留（天）"><Input type="number" min={1} max={60} value={form.retention_days} onChange={(e) => setForm({ ...form, retention_days: Number(e.target.value) })} /></Field></div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={form.level !== 'standard'} checked={form.summary_fetch} onChange={(e) => setForm({ ...form, summary_fetch: e.target.checked })} />原文摘要抓取（仅 title/meta，每日最多 20 次）</label>
        <Button variant="primary" loading={busy} onClick={save}>保存参数</Button>
      </div></Card>
      <Card><CardHeader title="小红书 / 公众号页面读取（低频）" />{query.data?.platforms.map(p=><PlatformRow key={`${p.platform}-${p.enabled}-${p.interval_min}-${p.daily_max}`} value={p} refresh={refresh} dev={false} />)}</Card>
      <Card><CardHeader title="来源开关与限额" desc="试采计入每日请求预算，并受来源最短间隔约束。" />{query.data?.sources.map((source) => <SourceRow key={`${source.key}-${source.interval_min}-${source.max_items}`} source={source} onChange={refresh} disabled={form.mode !== 'allow' || query.data.settings.level === 'off'} />)}</Card>
    </>}
    {me?.is_system_admin && <SourceHealth />}
    <Card><CardHeader title="最近采集日志" action={<Button size="sm" onClick={() => runs.refetch()}>刷新</Button>} />{runs.isError ? <Notice tone="red">{errorMessage(runs.error)}</Notice> : !runs.data?.length ? <Empty title="暂无采集记录" /> : <div className="overflow-x-auto p-5"><table className="w-full text-left text-sm"><thead><tr>{['来源', '时间', '请求', 'HTTP', '条数', '错误'].map((x) => <th key={x} className="p-2">{x}</th>)}</tr></thead><tbody>{runs.data.map((r) => <tr key={r.id} className="border-t border-mist-100"><td className="p-2">{r.source_key}</td><td>{new Date(r.started_at).toLocaleString('zh-CN')}</td><td>{r.requests}</td><td>{r.http_status || '—'}</td><td>{r.items}</td><td>{r.error || '成功'}</td></tr>)}</tbody></table></div>}</Card>
  </div>
}

function SearchSourceForm({refresh,disabled}:{refresh:()=>void;disabled:boolean}) {
 const providers=useQuery({queryKey:['providers'],queryFn:()=>get<Provider[]>('/model-providers')})
 const [provider,setProvider]=useState('');const [model,setModel]=useState('');const [query,setQuery]=useState('');const [busy,setBusy]=useState(false)
 const embedded=useEmbeddedSettings()
 useSettingsDraft(!disabled && !!(provider || model || query.trim()),busy)
 const current=providers.data?.find(p=>p.id===provider)
 return <div className="space-y-3 pt-4 border-t border-mist-100"><h3 className="font-semibold">联网搜索来源（默认关闭）</h3><Notice>复用支持百炼 DashScope / 方舟 Responses 原生联网搜索的供应商；只有返回搜索来源标题与链接时才入库，不使用模型回答代替新闻。配置后再勾选来源开启；受全站采集预算和工作区 AI 用量上限约束。</Notice><Field label="模型供应商"><Select disabled={disabled} disabledHint={roleReadOnlyHint.owner} value={provider} onChange={e=>{setProvider(e.target.value);setModel('')}}><option value="">选择已配置的供应商</option>{providers.data?.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field><Field label="模型（如 qwen-plus，或已开通搜索的豆包模型）"><Select disabled={disabled} disabledHint={roleReadOnlyHint.owner} value={model} onChange={e=>setModel(e.target.value)}><option value="">选择模型</option>{current?.models.map(m=><option key={m} value={m}>{m}</option>)}</Select></Field><Field label="搜索关键词"><Input disabled={disabled} disabledHint={roleReadOnlyHint.owner} maxLength={200} value={query} onChange={e=>setQuery(e.target.value)} /></Field><Button loading={busy} disabled={disabled||!provider||!model||!query.trim()} disabledHint={disabled ? roleReadOnlyHint.owner : '请先选择供应商、模型并填写关键词'} onClick={async()=>{setBusy(true);try{await post('/hot-sources/search',{provider_id:provider,model,query});if(embedded){setProvider('');setModel('');setQuery('')}refresh();toast.success('已配置，请勾选联网搜索来源后保存')}catch(e){toast.error(errorMessage(e))}finally{setBusy(false)}}}>保存搜索配置</Button></div>
}

export function HotSources() {
  const { data: me } = useMe()
  const owner = me?.role === 'owner'
  const inv = useInvalidate()
  const query = useQuery({ queryKey: ['hot-sources'], queryFn: () => get<HotSourcesResult>('/hot-sources') })
  const [selected, setSelected] = useState<string[]>([])
  const [rss, setRSS] = useState<{ key: string; name: string; url: string }[]>([])
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (query.data) { setSelected(query.data.selected); setRSS(query.data.sources.filter((s) => s.workspace_id && s.kind === 'rss').map((s) => ({ key: s.key, name: s.name, url: s.config.url ?? '' }))) } }, [query.data])
  const storedRSS = query.data?.sources.filter((source) => source.workspace_id && source.kind === 'rss').map((source) => ({ key: source.key, name: source.name, url: source.config.url ?? '' })) ?? []
  useSettingsDraft(owner && !!query.data && (JSON.stringify([...selected].sort()) !== JSON.stringify([...query.data.selected].sort()) || JSON.stringify(rss) !== JSON.stringify(storedRSS)), busy)
  const save = async () => {
    setBusy(true)
    try { await put('/hot-sources', { sources: selected, rss }); await inv(['hot-sources']); toast.success('热点来源已保存') } catch (e) { toast.error(errorMessage(e)) } finally { setBusy(false) }
  }
  return <div className="max-w-3xl animate-fade-in space-y-5"><PageHeader title="工作区热点来源" desc="只使用全站已启用的来源和本工作区的 RSS。" />
    {query.isError ? <Notice tone="red">{errorMessage(query.error)}</Notice> : query.isPending ? <Spinner /> : <Card><div className="space-y-4 p-5">
      {!query.data.enabled && <Notice>热点采集未开启；来源配置会保存，当前不发出采集请求。</Notice>}
      {query.data.sources.map((s) => <label key={s.key} className="flex items-center gap-2 text-sm"><input type="checkbox" title={!owner ? roleReadOnlyHint.owner : busy ? '正在保存…' : undefined} disabled={!owner || busy} checked={selected.includes(s.key)} onChange={(e) => setSelected((v) => e.target.checked ? [...v, s.key] : v.filter((key) => key !== s.key))} />{s.name}</label>)}
      {!query.data.sources.length && <Notice>暂无可选全站来源，可添加行业 RSS。</Notice>}
      <h3 className="font-semibold">自定义 RSS</h3>
      {rss.map((r, i) => <div key={i} className="space-y-2 rounded-lg border border-mist-200 p-3"><Field label="名称"><Input disabled={!owner || busy} disabledHint={!owner ? roleReadOnlyHint.owner : '正在保存…'} value={r.name} onChange={(e) => setRSS((v) => v.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} /></Field><Field label="订阅地址"><Textarea rows={1} disabled={!owner || busy} disabledHint={!owner ? roleReadOnlyHint.owner : '正在保存…'} value={r.url} onChange={(e) => setRSS((v) => v.map((x, j) => j === i ? { ...x, url: e.target.value } : x))} /></Field></div>)}
      <SearchSourceForm disabled={!owner} refresh={()=>inv(['hot-sources'])}/>
 {owner && <div className="flex gap-2"><Button disabled={busy || rss.length >= 10} onClick={() => setRSS((r) => [...r, { key: '', name: '', url: '' }])}>添加 RSS</Button><Button variant="primary" loading={busy} onClick={save}>保存来源</Button></div>}
    </div></Card>}
  </div>
}
