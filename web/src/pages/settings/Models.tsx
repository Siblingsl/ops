import { useQuery } from '@tanstack/react-query'
import { Activity, CheckCircle2, CircleAlert, Cpu, MinusCircle, Pencil, Plug, Plus, Trash2, XCircle, Zap } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { confirm, Dialog } from '@/components/dialog'
import { Badge, Button, Card, CardHeader, Empty, Field, IconButton, Input, Notice, PageHeader, PageLoading, Select, Switch } from '@/components/ui'
import { ApiError, del, errorMessage, get, patch, post, put } from '@/lib/api'
import { fmtTime } from '@/lib/format'
import { useInvalidate, useMe } from '@/lib/session'
import type { AILimit, ModelRoute, Provider } from '@/lib/types'

// DEV-U101（12 文档）：供应商能力自检结果。
interface SelfTestProbe { key: string; label: string; ok: boolean; skipped: boolean; latency_ms: number; detail: string }
interface SelfTestResult { model: string; summary: string; ok: boolean; results: SelfTestProbe[] }

function SelfTestDialog({ result, onClose }: { result: SelfTestResult; onClose: () => void }) {
  const icon = (p: SelfTestProbe) => p.skipped
    ? <MinusCircle className="size-4 text-mist-400" />
    : p.ok ? <CheckCircle2 className="size-4 text-ink-600" /> : <XCircle className="size-4 text-danger" />
  return (
    <Dialog open onClose={onClose} title="供应商能力自检" desc={`模型 ${result.model} · ${result.summary}`} width="max-w-xl">
      <div className="divide-y divide-mist-100 rounded-lg border border-mist-100">
        {result.results.map((p) => (
          <div key={p.key} className="flex items-start gap-3 px-4 py-3">
            <div className="mt-0.5">{icon(p)}</div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-[13.5px] font-medium text-mist-800">
                {p.label}
                {p.skipped && <Badge>已跳过</Badge>}
                {!p.skipped && <span className="font-mono text-[11.5px] text-mist-400">{p.latency_ms} ms</span>}
              </div>
              <p className={p.ok || p.skipped ? 'mt-0.5 text-[12.5px] text-mist-500' : 'mt-0.5 text-[12.5px] text-danger'}>{p.detail}</p>
            </div>
          </div>
        ))}
      </div>
      <Notice tone="ink" icon={<CircleAlert className="size-4" />}>
        自检直接调用供应商接口，会产生少量 token 与出图费用；调用不计入用量统计和质量看板。
      </Notice>
    </Dialog>
  )
}

function ProviderDialog({ editing, onClose }: { editing: Provider | null; onClose: () => void }) {
  const [name, setName] = useState(editing?.name ?? '')
  const [base, setBase] = useState(editing?.base_url ?? '')
  const [key, setKey] = useState('')
  const [models, setModels] = useState(editing?.models.join(', ') ?? '')
  const [pp, setPp] = useState(editing?.price_per_1k_prompt?.toString() ?? '')
  const [pc, setPc] = useState(editing?.price_per_1k_completion?.toString() ?? '')
  const [busy, setBusy] = useState(false)
  const inv = useInvalidate()
  const price = (v: string) => (v.trim() === '' ? -1 : Number(v))
  const save = async () => {
    setBusy(true)
    const list = models.split(/[,，\s]+/).filter(Boolean)
    try {
      if (editing) {
        const body: Record<string, unknown> = { name, models: list, price_per_1k_prompt: price(pp), price_per_1k_completion: price(pc) }
        if (base !== editing.base_url) body.base_url = base
        if (key.trim()) body.api_key = key
        await patch(`/model-providers/${editing.id}`, body)
      } else {
        const p = await post<Provider>('/model-providers', {
          name, base_url: base, api_key: key, models: list,
          price_per_1k_prompt: pp.trim() ? Number(pp) : null, price_per_1k_completion: pc.trim() ? Number(pc) : null,
        })
        const t = await post<{ ok: boolean; result: string }>(`/model-providers/${p.id}/test`)
        t.ok ? toast.success(t.result) : toast.error(t.result)
      }
      inv(['providers'], ['routes'], ['ai-status'])
      onClose()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open onClose={onClose} title={editing ? '编辑模型供应商' : '添加模型供应商'} desc="支持 OpenAI 兼容接口。修改接口地址或密钥需要再次输入登录密码。" width="max-w-lg"
      footer={<><Button variant="ghost" onClick={onClose}>取消</Button><Button variant="primary" loading={busy} onClick={save}
        disabled={!name.trim() || !base.trim() || !models.trim() || (!editing && !key.trim())}>{editing ? '保存' : '保存并测试'}</Button></>}>
      <div className="space-y-4">
        <Field label="名称"><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：DeepSeek" /></Field>
        <Field label="接口地址" hint="以 /v1 结尾的 OpenAI 兼容地址"><Input value={base} onChange={(e) => setBase(e.target.value)} placeholder="https://api.example.com/v1" className="font-mono text-[13px]" /></Field>
        <Field label="API 密钥" hint={editing ? `已保存：${editing.key_mask}。留空则不修改。` : '加密保存，页面只显示脱敏值'}>
          <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="new-password" className="font-mono text-[13px]" />
        </Field>
        <Field label="可用模型" hint="逗号分隔，第一个用于连通测试"><Input value={models} onChange={(e) => setModels(e.target.value)} placeholder="deepseek-chat, deepseek-reasoner" className="font-mono text-[13px]" /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="输入单价（元 / 千 token）" hint="选填，用于估算费用"><Input type="number" min={0} step={0.0001} value={pp} onChange={(e) => setPp(e.target.value)} /></Field>
          <Field label="输出单价（元 / 千 token）" hint="不填则按输入单价"><Input type="number" min={0} step={0.0001} value={pc} onChange={(e) => setPc(e.target.value)} /></Field>
        </div>
        <Notice tone="gamboge">请只使用服务条款明确「API 数据不用于训练」的供应商。</Notice>
      </div>
    </Dialog>
  )
}

// DEV-UX01（D-052 第 1 条）：只收录满足"API 数据不用于训练"准入条件的供应商；模型名只是建议，以控制台为准。
type QuickRole = 'default' | 'tier_economy' | 'tier_quality' | 'metric_screenshot'
const quickRoles: { key: QuickRole; label: string; hint: string }[] = [
  { key: 'default', label: '主力模型', hint: '必填。没有单独指定的任务都用它' },
  { key: 'tier_economy', label: '经济档模型', hint: '选填。偏好里切到经济档时所有任务改用它，适合便宜快速的模型' },
  { key: 'tier_quality', label: '质量档模型', hint: '选填。偏好里切到质量档时所有任务改用它' },
  { key: 'metric_screenshot', label: '图片识别模型', hint: '选填。数据截图识别必须用支持图片输入的模型' },
]
const templates: { id: string; name: string; base: string; models: Partial<Record<QuickRole, string>>; note: string }[] = [
  {
    id: 'bailian', name: '阿里云百炼', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: { default: 'qwen-plus', tier_economy: 'qwen-turbo', tier_quality: 'qwen-max', metric_screenshot: 'qwen-vl-plus' },
    note: '使用按量付费 API。模型名是建议值，以百炼控制台"模型广场"为准。',
  },
  {
    id: 'ark', name: '火山方舟', base: 'https://ark.cn-beijing.volces.com/api/v3', models: {},
    note: '模型处填写方舟控制台里的模型名或推理接入点 ID（ep- 开头）。不要签署数据授权协议。',
  },
  { id: 'custom', name: '其他 OpenAI 兼容接口', base: '', models: {}, note: '接口地址以 /v1 结尾。请确认服务条款写明 API 数据不用于训练。' },
]

function QuickSetupDialog({ onClose }: { onClose: () => void }) {
  const [tpl, setTpl] = useState(templates[0])
  const [name, setName] = useState(templates[0].name)
  const [base, setBase] = useState(templates[0].base)
  const [key, setKey] = useState('')
  const [roles, setRoles] = useState<Record<QuickRole, string>>({ default: '', tier_economy: '', tier_quality: '', metric_screenshot: '', ...templates[0].models })
  const [busy, setBusy] = useState(false)
  const inv = useInvalidate()
  const choose = (id: string) => {
    const t = templates.find((x) => x.id === id) ?? templates[0]
    setTpl(t)
    setName(t.name)
    setBase(t.base)
    setRoles({ default: '', tier_economy: '', tier_quality: '', metric_screenshot: '', ...t.models })
  }
  const save = async () => {
    const assign = Object.fromEntries(quickRoles.map((r) => [r.key, roles[r.key].trim()]).filter(([, m]) => m))
    const models = [...new Set(Object.values(assign))]
    setBusy(true)
    try {
      const p = await post<Provider & { assigned: QuickRole[]; kept: QuickRole[] }>('/model-providers', { name, base_url: base, api_key: key, models, assign })
      const label = (k: QuickRole) => quickRoles.find((r) => r.key === k)?.label ?? k
      const t = await post<{ ok: boolean; result: string }>(`/model-providers/${p.id}/test`)
      const parts = [p.assigned.length ? `已设置：${p.assigned.map(label).join('、')}` : '', p.kept.length ? `保留原有：${p.kept.map(label).join('、')}` : ''].filter(Boolean)
      t.ok ? toast.success(t.result, { description: parts.join('；') }) : toast.error(t.result, { description: parts.join('；') })
      inv(['providers'], ['routes'], ['ai-status'], ['dashboard'], ['next-actions'])
      onClose()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open onClose={onClose} title="快速配置模型" desc="选一个供应商、填一次密钥，按用途填模型名。只会写入还空着的任务路由，已有的配置不会被覆盖。" width="max-w-lg"
      footer={<><Button variant="ghost" onClick={onClose}>取消</Button>
        <Button variant="primary" loading={busy} onClick={save} disabled={!name.trim() || !base.trim() || !key.trim() || !roles.default.trim()}>保存并测试</Button></>}>
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-2">
          {templates.map((t) => (
            <button key={t.id} type="button" onClick={() => choose(t.id)}
              className={`cursor-pointer rounded-lg border px-3 py-2 text-left text-[13px] transition ${tpl.id === t.id ? 'border-ink-400 bg-ink-50 font-medium text-ink-800' : 'border-mist-200 text-mist-600 hover:border-mist-300'}`}>{t.name}</button>
          ))}
        </div>
        <p className="text-[12.5px] text-mist-500">{tpl.note}</p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="名称"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="API 密钥"><Input type="password" autoFocus value={key} onChange={(e) => setKey(e.target.value)} autoComplete="new-password" className="font-mono text-[13px]" /></Field>
        </div>
        <Field label="接口地址"><Input value={base} onChange={(e) => setBase(e.target.value)} placeholder="https://api.example.com/v1" className="font-mono text-[13px]" /></Field>
        {quickRoles.map((r) => (
          <Field key={r.key} label={r.label} hint={r.hint}>
            <Input value={roles[r.key]} onChange={(e) => setRoles({ ...roles, [r.key]: e.target.value })} placeholder={r.key === 'default' ? '模型名' : '可留空'} className="font-mono text-[13px]" />
          </Field>
        ))}
        <Notice tone="gamboge">请只使用服务条款明确「API 数据不用于训练」的供应商。保存后会用主力模型做一次连通测试，产生少量 token 费用。</Notice>
      </div>
    </Dialog>
  )
}

const keyRoutes = ['default', 'tier_economy', 'tier_quality', 'metric_screenshot', 'image_gen']

function RoutesCard({ providers }: { providers: Provider[] }) {
  const { data } = useQuery({ queryKey: ['routes'], queryFn: () => get<ModelRoute[]>('/model-routes') })
  const [routes, setRoutes] = useState<ModelRoute[]>([])
  const [busy, setBusy] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const inv = useInvalidate()
  useEffect(() => setRoutes(data ?? []), [data])
  const custom = routes.filter((r) => !keyRoutes.includes(r.task_type) && r.provider_id).length
  const set = (i: number, p: Partial<ModelRoute>) => setRoutes(routes.map((r, j) => (j === i ? { ...r, ...p } : r)))
  const save = async () => {
    setBusy(true)
    try {
      setRoutes(await put<ModelRoute[]>('/model-routes', routes.map((r) => ({
        task_type: r.task_type, provider_id: r.provider_id || null, model: r.model,
        fallback_provider_id: r.fallback_provider_id || null, fallback_model: r.fallback_model ?? '',
      }))))
      toast.success('任务路由已保存')
      inv(['ai-status'])
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const active = providers.filter((p) => p.status === 'active')
  return (
    <Card>
      <CardHeader title="任务路由" desc="每类任务可以指定不同模型和备用模型。主模型网络错误、限流或超时时自动改用备用模型。未指定的任务使用「默认模型」；经济档 / 质量档在个人偏好中切换。"
        action={<Button size="sm" variant="primary" loading={busy} onClick={save}>保存路由</Button>} />
      <div className="hidden grid-cols-[160px_1fr_1fr_1fr_1fr] gap-3 border-b border-mist-100 px-5 py-2 text-[12px] text-mist-400 lg:grid">
        <span>任务</span><span>供应商</span><span>模型</span><span>备用供应商</span><span>备用模型</span>
      </div>
      <div className="divide-y divide-mist-100">
        {routes.map((r, i) => {
          if (!showAll && !keyRoutes.includes(r.task_type)) return null
          const prov = providers.find((p) => p.id === r.provider_id)
          const fb = providers.find((p) => p.id === r.fallback_provider_id)
          return (
            <div key={r.task_type} className="grid grid-cols-2 items-center gap-3 px-5 py-2.5 lg:grid-cols-[160px_1fr_1fr_1fr_1fr]">
              <div className="text-[13.5px] font-medium text-mist-800">{r.label}{r.task_type === 'default' && <Badge tone="ink" className="ml-1.5">必填</Badge>}</div>
              <Select value={r.provider_id ?? ''} onChange={(e) => {
                const p = providers.find((x) => x.id === e.target.value)
                set(i, { provider_id: e.target.value || null, model: p?.models[0] ?? '' })
              }}>
                <option value="">{r.task_type === 'default' ? '未配置' : '使用默认模型'}</option>
                {active.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
              <Select value={r.model} disabled={!prov} onChange={(e) => set(i, { model: e.target.value })}>
                {!prov && <option value="">—</option>}
                {prov?.models.map((m) => <option key={m} value={m}>{m}</option>)}
              </Select>
              <Select value={r.fallback_provider_id ?? ''} disabled={!prov} onChange={(e) => {
                const p = providers.find((x) => x.id === e.target.value)
                set(i, { fallback_provider_id: e.target.value || null, fallback_model: p?.models[0] ?? '' })
              }}>
                <option value="">不设备用</option>
                {active.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
              <Select value={r.fallback_model ?? ''} disabled={!fb} onChange={(e) => set(i, { fallback_model: e.target.value })}>
                {!fb && <option value="">—</option>}
                {fb?.models.map((m) => <option key={m} value={m}>{m}</option>)}
              </Select>
            </div>
          )
        })}
      </div>
      <button type="button" onClick={() => setShowAll((v) => !v)}
        className="w-full cursor-pointer border-t border-mist-100 px-5 py-2.5 text-left text-[12.5px] text-mist-500 hover:bg-mist-50 hover:text-ink-700">
        {showAll ? '收起其他任务' : `其他 ${routes.length - keyRoutes.length} 类任务默认跟随主力模型，需要时再单独指定${custom ? `（已单独指定 ${custom} 类）` : ''} →`}
      </button>
    </Card>
  )
}

function SamplingCard() {
  const { data, refetch } = useQuery({ queryKey: ['settings'], queryFn: () => get<{ ai_sampling: { temperature: number | null } }>('/settings') })
  const [fixed, setFixed] = useState(false)
  const [value, setValue] = useState('0.7')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!data) return
    setFixed(data.ai_sampling.temperature !== null)
    setValue(String(data.ai_sampling.temperature ?? 0.7))
  }, [data])
  if (!data) return null
  const save = async () => {
    setBusy(true)
    try {
      await put('/settings', { ai_sampling: { temperature: fixed ? Number(value) : null } })
      await refetch()
      toast.success('采样温度已保存')
    } catch (e) { toast.error(errorMessage(e)) } finally { setBusy(false) }
  }
  return <Card className="space-y-4 p-5">
    <div className="flex items-start gap-4">
      <div className="flex-1"><div className="text-[15px] font-semibold text-mist-900">采样温度</div>
        <p className="mt-0.5 text-[13px] text-mist-500">默认按任务设置：标题和选题更发散，事实核查更稳定。部分模型会忽略此参数，以供应商支持为准。</p>
      </div>
      <Switch checked={fixed} onChange={setFixed} label="统一温度" />
    </div>
    {fixed && <Field label="统一温度值"><Input type="number" min={0} max={2} step={0.1} value={value} onChange={e => setValue(e.target.value)} /></Field>}
    <Button size="sm" loading={busy} onClick={save} disabled={fixed && (value.trim() === '' || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 2)}>保存采样温度</Button>
  </Card>
}

function LimitCard() {
  const { data } = useQuery({ queryKey: ['settings'], queryFn: () => get<{ ai_limit: AILimit }>('/settings') })
  const [limit, setLimit] = useState<AILimit | null>(null)
  useEffect(() => setLimit(data?.ai_limit ?? null), [data])
  if (!limit) return null
  const save = async (l: AILimit) => {
    setLimit(l)
    try {
      await put('/settings', { ai_limit: l })
      toast.success('已保存')
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  return (
    <Card className="p-5">
      <div className="flex items-start gap-4">
        <div className="flex-1">
          <div className="text-[15px] font-semibold text-mist-900">每日 token 上限</div>
          <p className="mt-0.5 text-[13px] text-mist-500">达到上限后，当天的 AI 功能暂停，写作、检查和推送不受影响。</p>
        </div>
        <Switch checked={limit.enabled} onChange={(v) => save({ ...limit, enabled: v })} label="启用上限" />
      </div>
      {limit.enabled && (
        <div className="mt-4 flex items-center gap-2">
          <Input type="number" min={1000} step={10000} value={limit.daily_tokens} className="w-48"
            onChange={(e) => setLimit({ ...limit, daily_tokens: Number(e.target.value) })} onBlur={() => save(limit)} />
          <span className="text-[13px] text-mist-500">token / 天</span>
        </div>
      )}
    </Card>
  )
}

// DEV-DR08（14 文档 4.6 第 2 条）：默认关闭；打开后每周一用经济档模型生成一次复盘草稿。
function WeeklyDraftCard() {
  const { data, refetch } = useQuery({ queryKey: ['settings'], queryFn: () => get<{ review_weekly_draft?: 'on' | 'off' }>('/settings') })
  if (!data) return null
  const on = data.review_weekly_draft === 'on'
  const save = async (v: boolean) => {
    try {
      await put('/settings', { review_weekly_draft: v ? 'on' : 'off' })
      toast.success(v ? '已开启每周复盘草稿' : '已关闭每周复盘草稿')
      refetch()
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  return (
    <Card className="p-5">
      <div className="flex items-start gap-4">
        <div className="flex-1">
          <div className="text-[15px] font-semibold text-mist-900">每周复盘草稿</div>
          <p className="mt-0.5 text-[13px] text-mist-500">
            每周一在后台用经济档模型，按近 30 天作品的第 7 天数据为每个账号生成一份复盘草稿，并发通知。草稿里的建议仍要逐条采纳；第 7 天数据少于 3 篇时不生成，只提醒先补数据。会消耗 AI 用量。
          </p>
        </div>
        <Switch checked={on} onChange={save} label="每周复盘草稿" />
      </div>
    </Card>
  )
}

export default function Models() {
  const { data: me } = useMe()
  const isOwner = me?.role === 'owner'
  const { data, isLoading, refetch } = useQuery({ queryKey: ['providers'], queryFn: () => get<Provider[]>('/model-providers'), refetchInterval: 5000 })
  const [dialog, setDialog] = useState<{ editing: Provider | null } | null>(null)
  const [quick, setQuick] = useState(false)
  const [testing, setTesting] = useState<string | null>(null)
  const [selfTesting, setSelfTesting] = useState<string | null>(null)
  const [selfTest, setSelfTest] = useState<{ providerName: string; result: SelfTestResult } | null>(null)
  const inv = useInvalidate()
  if (isLoading) return <PageLoading />
  const list = data ?? []
  const test = async (p: Provider) => {
    setTesting(p.id)
    try {
      const r = await post<{ ok: boolean; result: string }>(`/model-providers/${p.id}/test`)
      r.ok ? toast.success(r.result) : toast.error(r.result)
      refetch()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setTesting(null)
    }
  }
  const runSelfTest = async (p: Provider) => {
    setSelfTesting(p.id)
    try {
      const r = await post<SelfTestResult>(`/model-providers/${p.id}/selftest`, {})
      setSelfTest({ providerName: p.name, result: r })
      refetch()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setSelfTesting(null)
    }
  }
  const remove = async (p: Provider, confirmed = false): Promise<void> => {
    if (!confirmed && !(await confirm({ title: `删除「${p.name}」？`, desc: '密钥会一并删除。', confirmText: '删除', danger: true }))) return
    try {
      await del(`/model-providers/${p.id}`, { confirm: confirmed })
      inv(['providers'], ['routes'])
    } catch (e) {
      if (e instanceof ApiError && e.code === 'confirm_required') {
        if (await confirm({ title: '仍要删除？', desc: e.message, confirmText: '删除', danger: true })) return remove(p, true)
      } else toast.error(errorMessage(e))
    }
  }
  const toggle = async (p: Provider) => {
    await patch(`/model-providers/${p.id}`, { status: p.status === 'active' ? 'disabled' : 'active' }).catch((e) => toast.error(errorMessage(e)))
    refetch()
  }
  return (
    <div className="animate-fade-in space-y-6">
      <PageHeader title="模型配置" desc="接入工作区自己的大模型 API。密钥加密保存，仅所有者可修改。"
        action={isOwner ? <>
          <Button icon={<Plus className="size-4" />} onClick={() => setDialog({ editing: null })}>手动添加</Button>
          <Button variant="primary" icon={<Zap className="size-4" />} onClick={() => setQuick(true)}>快速配置</Button>
        </> : undefined} />
      {!isOwner && <Notice tone="ink">你是编辑者，可查看模型配置，但不能修改密钥或路由。</Notice>}
      {list.length === 0 ? (
        <Card><Empty icon={<Cpu className="size-5" />} title="还没有配置模型" desc="没有模型时 AI 按钮不可用，写作、检查和推送不受影响。快速配置只需选供应商、填一次密钥，按用途填模型名。"
          action={isOwner ? <Button variant="primary" icon={<Zap className="size-4" />} onClick={() => setQuick(true)}>快速配置</Button> : undefined} /></Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {list.map((p) => (
            <Card key={p.id} className="group p-5">
              <div className="flex items-start gap-3">
                <div className="flex size-9 items-center justify-center rounded-lg bg-ink-50 text-ink-600"><Cpu className="size-4.5" /></div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[15px] font-semibold text-mist-900">{p.name}</span>
                    {p.status === 'disabled' && <Badge>已停用</Badge>}
                    {p.status === 'active' && p.circuit_state === 'closed' && <Badge>未熔断</Badge>}
                    {p.status === 'active' && p.circuit_state === 'half_open' && <Badge tone="gamboge">等待恢复探测</Badge>}
                  </div>
                  <div className="truncate font-mono text-xs text-mist-500">{p.base_url}</div>
                </div>
                {isOwner && (
                  <div className="flex opacity-0 transition group-hover:opacity-100">
                    <IconButton label="编辑" onClick={() => setDialog({ editing: p })}><Pencil className="size-3.5" /></IconButton>
                    <IconButton label="删除" className="hover:text-danger" onClick={() => remove(p)}><Trash2 className="size-3.5" /></IconButton>
                  </div>
                )}
              </div>
              {p.status === 'active' && p.circuit_state === 'open' && <p className="mt-2 text-xs text-danger">供应商暂不可用，约 {p.retry_after_seconds} 秒后恢复</p>}
              <div className="mt-3 flex flex-wrap gap-1.5">{p.models.map((m) => <span key={m} className="rounded bg-mist-100 px-1.5 py-0.5 font-mono text-[11.5px] text-mist-600">{m}</span>)}</div>
              <div className="mt-3 flex items-center gap-2 border-t border-mist-100 pt-3 text-xs">
                <span className="font-mono text-mist-400">{p.key_mask}</span>
                {p.price_per_1k_prompt != null && <span className="text-mist-400">¥{p.price_per_1k_prompt} / 千 token</span>}
                {p.last_test_at && (p.last_test_ok ? <span className="flex items-center gap-1 text-ink-600"><CheckCircle2 className="size-3.5" />{fmtTime(p.last_test_at)} 测试通过</span>
                  : <span className="flex items-center gap-1 text-danger" title={p.last_test_result}><XCircle className="size-3.5" />测试失败</span>)}
                {isOwner && (
                  <div className="ml-auto flex items-center gap-2">
                    <Switch checked={p.status === 'active'} onChange={() => toggle(p)} label="启用" />
                    <Button size="sm" variant="ghost" icon={<Activity className="size-3.5" />} loading={selfTesting === p.id}
                      onClick={() => runSelfTest(p)} title="一次探测对话、JSON、流式、出图与联网搜索能力">自检</Button>
                    <Button size="sm" variant="ghost" icon={<Plug className="size-3.5" />} loading={testing === p.id} onClick={() => test(p)}>测试</Button>
                  </div>
                )}
              </div>
              {p.last_test_ok === false && <p className="mt-2 rounded bg-orange-50 px-2 py-1.5 text-xs text-orange-800">{p.last_test_result}</p>}
            </Card>
          ))}
        </div>
      )}
      {isOwner && list.length > 0 && <RoutesCard providers={list} />}
      {isOwner && <SamplingCard />}
      {isOwner && <LimitCard />}
      {isOwner && <WeeklyDraftCard />}
      {isOwner && dialog && <ProviderDialog editing={dialog.editing} onClose={() => setDialog(null)} />}
      {isOwner && quick && <QuickSetupDialog onClose={() => setQuick(false)} />}
      {isOwner && selfTest && (
        <SelfTestDialog result={selfTest.result} onClose={() => setSelfTest(null)} />
      )}
    </div>
  )
}
