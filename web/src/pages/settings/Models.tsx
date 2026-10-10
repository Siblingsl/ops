import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, Cpu, Pencil, Plug, Plus, Trash2, XCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { confirm, Dialog } from '@/components/dialog'
import { Badge, Button, Card, CardHeader, Empty, Field, IconButton, Input, Notice, PageHeader, PageLoading, Select, Switch } from '@/components/ui'
import { ApiError, del, errorMessage, get, patch, post, put } from '@/lib/api'
import { fmtTime } from '@/lib/format'
import { useInvalidate, useMe } from '@/lib/session'
import type { AILimit, ModelRoute, Provider } from '@/lib/types'

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
      inv(['providers'], ['routes'])
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

function RoutesCard({ providers }: { providers: Provider[] }) {
  const { data } = useQuery({ queryKey: ['routes'], queryFn: () => get<ModelRoute[]>('/model-routes') })
  const [routes, setRoutes] = useState<ModelRoute[]>([])
  const [busy, setBusy] = useState(false)
  useEffect(() => setRoutes(data ?? []), [data])
  const set = (i: number, p: Partial<ModelRoute>) => setRoutes(routes.map((r, j) => (j === i ? { ...r, ...p } : r)))
  const save = async () => {
    setBusy(true)
    try {
      setRoutes(await put<ModelRoute[]>('/model-routes', routes.map((r) => ({
        task_type: r.task_type, provider_id: r.provider_id || null, model: r.model,
        fallback_provider_id: r.fallback_provider_id || null, fallback_model: r.fallback_model ?? '',
      }))))
      toast.success('任务路由已保存')
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
    </Card>
  )
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

export default function Models() {
  const { data: me } = useMe()
  const isOwner = me?.role === 'owner'
  const { data, isLoading, refetch } = useQuery({ queryKey: ['providers'], queryFn: () => get<Provider[]>('/model-providers') })
  const [dialog, setDialog] = useState<{ editing: Provider | null } | null>(null)
  const [testing, setTesting] = useState<string | null>(null)
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
        action={isOwner ? <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setDialog({ editing: null })}>添加供应商</Button> : undefined} />
      {!isOwner && <Notice tone="ink">你是编辑者，可查看模型配置，但不能修改密钥或路由。</Notice>}
      {list.length === 0 ? (
        <Card><Empty icon={<Cpu className="size-5" />} title="还没有配置模型" desc="没有模型时 AI 按钮不可用，写作、检查和推送不受影响。"
          action={isOwner ? <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setDialog({ editing: null })}>添加第一个供应商</Button> : undefined} /></Card>
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
              <div className="mt-3 flex flex-wrap gap-1.5">{p.models.map((m) => <span key={m} className="rounded bg-mist-100 px-1.5 py-0.5 font-mono text-[11.5px] text-mist-600">{m}</span>)}</div>
              <div className="mt-3 flex items-center gap-2 border-t border-mist-100 pt-3 text-xs">
                <span className="font-mono text-mist-400">{p.key_mask}</span>
                {p.price_per_1k_prompt != null && <span className="text-mist-400">¥{p.price_per_1k_prompt} / 千 token</span>}
                {p.last_test_at && (p.last_test_ok ? <span className="flex items-center gap-1 text-ink-600"><CheckCircle2 className="size-3.5" />{fmtTime(p.last_test_at)} 测试通过</span>
                  : <span className="flex items-center gap-1 text-danger" title={p.last_test_result}><XCircle className="size-3.5" />测试失败</span>)}
                {isOwner && (
                  <div className="ml-auto flex items-center gap-2">
                    <Switch checked={p.status === 'active'} onChange={() => toggle(p)} label="启用" />
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
      {isOwner && <LimitCard />}
      {isOwner && dialog && <ProviderDialog editing={dialog.editing} onClose={() => setDialog(null)} />}
    </div>
  )
}
