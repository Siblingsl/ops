import { Pencil, Plus, Power, Search, Trash2, Users } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { AccountCreateForm, credTone, CredentialPanel } from '@/components/account-forms'
import { confirm, Dialog } from '@/components/dialog'
import { Badge, Button, Card, CardHeader, cn, Empty, Field, formatLabel, Input, PageHeader, PageLoading, PlatformMark, platformLabel, Select } from '@/components/ui'
import { ApiError, del, errorMessage, patch, post } from '@/lib/api'
import { useAccounts, useInvalidate, useMe } from '@/lib/session'
import type { Account, ContentFormat } from '@/lib/types'

const formats: Record<string, ContentFormat[]> = { wechat_mp: ['long_article', 'comic'], xhs: ['image_note', 'comic'] }

type Filter = 'all' | 'active' | 'disabled'

function AccountDetail({ account, onStatusChange, canManage }: {
  account: Account
  onStatusChange: (kind: 'disabled' | 'enabled' | 'deleted') => void
  canManage: boolean
}) {
  const inv = useInvalidate()
  const [name, setName] = useState(account.name)
  const [limit, setLimit] = useState(String(account.daily_push_limit))
  useEffect(() => { setName(account.name); setLimit(String(account.daily_push_limit)) }, [account])

  const save = async (body: Record<string, unknown>) => {
    try {
      await patch(`/accounts/${account.id}`, body)
      inv(['accounts'])
      toast.success('已保存')
    } catch (e) {
      if (e instanceof ApiError && e.code === 'confirm_required') {
        if (await confirm({ title: '修改内容形态？', desc: e.message, confirmText: '确认修改' })) return save({ ...body, confirm: true })
        inv(['accounts'])
      } else toast.error(errorMessage(e))
    }
  }

  const toggle = async () => {
    const disabling = account.status === 'active'
    if (disabling) {
      if (!(await confirm({
        title: `停用「${account.name}」？`,
        desc: '停用后不会出现在账号列表中，也不能写入草稿。作品、档案和素材会保留，可随时重新启用。若要永久清除请用「删除」。',
        confirmText: '停用',
        danger: true,
      }))) return
    }
    try {
      await post(`/accounts/${account.id}/${disabling ? 'disable' : 'enable'}`)
      inv(['accounts'])
      toast.success(disabling ? '已停用' : '已重新启用')
      onStatusChange(disabling ? 'disabled' : 'enabled')
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const remove = async () => {
    if (!(await confirm({
      title: `删除「${account.name}」？`,
      desc: '将永久删除该平台账号及其作品、选题、档案、凭证等，无法恢复。工作区共享素材会保留并解除与该账号的关联。',
      confirmText: '确认删除',
      danger: true,
    }))) return
    try {
      await del(`/accounts/${account.id}?confirm=true`)
      inv(['accounts'])
      toast.success('账号已删除')
      onStatusChange('deleted')
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="基本信息"
          desc={!canManage ? '编辑者可查看账号，修改由所有者操作。' : account.status === 'disabled' ? '该账号已停用，启用后可继续使用。' : undefined}
          action={canManage ? (
            <div className="flex gap-2">
              {account.status === 'disabled' ? (
                <Button size="sm" variant="primary" icon={<Power className="size-3.5" />} onClick={toggle}>重新启用</Button>
              ) : (
                <Button size="sm" variant="ghost" icon={<Power className="size-3.5" />} onClick={toggle}>停用</Button>
              )}
              <Button size="sm" variant="danger" icon={<Trash2 className="size-3.5" />} onClick={remove}>删除</Button>
            </div>
          ) : undefined}
        />
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <Field label="账号名称">
            <Input value={name} disabled={!canManage} onChange={(e) => setName(e.target.value)} onBlur={() => canManage && name.trim() && name !== account.name && save({ name })} />
          </Field>
          <Field label="内容形态" hint="已有作品保持原流程">
            <Select value={account.content_format} onChange={(e) => save({ content_format: e.target.value })} disabled={!canManage || account.status === 'disabled'}>
              {formats[account.platform].map((f) => (
                <option key={f} value={f}>{formatLabel[f]}</option>
              ))}
            </Select>
          </Field>
          {account.platform === 'wechat_mp' && (
            <Field label="每日写入草稿上限" hint="1–20 次，不能关闭。超过后仍可写入，但每次都需要二次确认。">
              <Input
                type="number" min={1} max={20} value={limit}
                disabled={!canManage || account.status === 'disabled'}
                onChange={(e) => setLimit(e.target.value)}
                onBlur={() => canManage && Number(limit) !== account.daily_push_limit && save({ daily_push_limit: Number(limit) })}
              />
            </Field>
          )}
          <Field label="平台">
            <div className="flex h-9 items-center gap-2 text-[13.5px] text-mist-700">
              <PlatformMark platform={account.platform} size="sm" />
              {platformLabel[account.platform]}
            </div>
          </Field>
        </div>
      </Card>
      {account.platform === 'wechat_mp' ? (
        canManage ? (
          <Card>
            <CardHeader title="公众号开发者凭证" desc="在公众号后台「设置与开发 → 基本配置」中获取 AppID 和 AppSecret。" />
            <div className="p-5"><CredentialPanel key={account.id} account={account} onChanged={() => inv(['accounts'])} /></div>
          </Card>
        ) : (
          <Card className="p-5 text-[13px] text-mist-600">公众号凭证仅所有者可查看与修改。</Card>
        )
      ) : (
        <Card className="p-5 text-[13px] leading-relaxed text-mist-600">
          小红书没有面向个人创作者的发布接口。本系统不登录小红书、不保存小红书账号密码，作品通过「发布包」由你手动发布。
        </Card>
      )}
    </div>
  )
}

export default function SettingsAccounts() {
  const { data: me } = useMe()
  const nav = useNavigate()
  const canManage = me?.role === 'owner'
  const { data, isLoading } = useAccounts()
  const [params, setParams] = useSearchParams()
  const [selected, setSelected] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const inv = useInvalidate()
  const creating = params.get('new') === '1'
  const focusSearch = params.get('q') === '1'
  const createPlatform = params.get('platform') === 'xhs' ? 'xhs' : params.get('platform') === 'wechat_mp' ? 'wechat_mp' : undefined
  const list = data ?? []

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return list.filter((a) => {
      if (filter === 'active' && a.status !== 'active') return false
      if (filter === 'disabled' && a.status !== 'disabled') return false
      if (!needle) return true
      return a.name.toLowerCase().includes(needle) || platformLabel[a.platform].includes(needle)
    })
  }, [list, q, filter])

  useEffect(() => {
    const id = params.get('id')
    if (id && list.some((a) => a.id === id)) setSelected(id)
  }, [params, list])

  useEffect(() => {
    if (focusSearch) {
      const el = document.querySelector<HTMLInputElement>('[data-account-search]')
      el?.focus()
      el?.select()
    }
  }, [focusSearch])

  useEffect(() => {
    if (!selected && filtered.length) setSelected(filtered[0].id)
  }, [filtered, selected])

  useEffect(() => {
    if (selected && !filtered.some((a) => a.id === selected)) {
      setSelected(filtered[0]?.id ?? null)
    }
  }, [filtered, selected])

  if (isLoading) return <PageLoading />
  const current = list.find((a) => a.id === selected)

  const filters: { id: Filter; label: string }[] = [
    { id: 'all', label: `全部 ${list.length}` },
    { id: 'active', label: `使用中 ${list.filter((a) => a.status === 'active').length}` },
    { id: 'disabled', label: `已停用 ${list.filter((a) => a.status === 'disabled').length}` },
  ]

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="平台账号与凭证"
        desc="增删改查都在这里：添加、搜索筛选、编辑资料与凭证；暂不用可停用（可恢复），确定不要再点删除（不可恢复）。"
        action={canManage ? <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setParams({ new: '1' })}>添加账号</Button> : undefined}
      />

      {list.length === 0 ? (
        <Card className="overflow-hidden">
          <Empty
            icon={<Users className="size-5" />}
            title="还没有平台账号"
            desc={canManage ? '先添加公众号或小红书账号。凭证、定位档案、风格样本和模型可在添加后随时配置。' : '请联系工作区所有者添加平台账号。'}
            action={canManage ? <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setParams({ new: '1' })}>添加账号</Button> : undefined}
          />
          <ol className="space-y-2 border-t border-mist-100 bg-mist-50/60 px-6 py-4 text-[13px] text-mist-600">
            <li><span className="font-medium text-mist-800">1. 添加账号</span> — 本页</li>
            <li><span className="font-medium text-mist-800">2. 公众号凭证</span> — 添加公众号后在本页下方填写（小红书可跳过）</li>
            <li><span className="font-medium text-mist-800">3. 定位档案 / 风格样本</span> — 左侧「账号档案」</li>
            <li><span className="font-medium text-mist-800">4. 模型</span> — 头像菜单 → 模型配置</li>
          </ol>
        </Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
          <Card className="flex h-fit flex-col overflow-hidden">
            <div className="space-y-3 border-b border-mist-100 p-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-mist-400" />
                <Input data-account-search className="h-9 pl-8" placeholder="搜索账号名称或平台" value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
              <div className="flex flex-wrap gap-1">
                {filters.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setFilter(f.id)}
                    className={cn(
                      'cursor-pointer rounded-full px-2.5 py-1 text-[12px] transition',
                      filter === f.id ? 'bg-ink-600 text-white' : 'bg-mist-100 text-mist-600 hover:bg-mist-200',
                    )}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="max-h-[min(60vh,520px)] overflow-y-auto p-1.5">
              {filtered.length === 0 ? (
                <p className="px-3 py-8 text-center text-[13px] text-mist-400">没有符合条件的账号</p>
              ) : (
                filtered.map((a) => {
                  const t = credTone(a.credential)
                  return (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => setSelected(a.id)}
                      className={cn(
                        'flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-left transition',
                        selected === a.id ? 'bg-ink-50' : 'hover:bg-mist-50',
                        a.status === 'disabled' && 'opacity-60',
                      )}
                    >
                      <PlatformMark platform={a.platform} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-[13.5px] font-medium text-mist-900">{a.name}</span>
                          {selected === a.id && <Pencil className="size-3 shrink-0 text-ink-500" />}
                        </div>
                        <div className="text-[11.5px] text-mist-500">{platformLabel[a.platform]} · {formatLabel[a.content_format]}</div>
                      </div>
                      {a.status === 'disabled' ? <Badge>已停用</Badge> : a.platform === 'wechat_mp' && <Badge tone={t.tone}>{t.label}</Badge>}
                    </button>
                  )
                })
              )}
            </div>
            {canManage && (
              <div className="border-t border-mist-100 p-2">
                <Button className="w-full" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setParams({ new: '1' })}>
                  添加账号
                </Button>
              </div>
            )}
          </Card>
          {current ? (
            <AccountDetail
              account={current}
              canManage={!!canManage}
              onStatusChange={(kind) => {
                if (kind === 'deleted') {
                  setSelected(null)
                  setFilter('all')
                  return
                }
                if (kind === 'disabled') {
                  setFilter('disabled')
                  setSelected(current.id)
                }
              }}
            />
          ) : (
            <Card className="flex items-center justify-center p-10 text-[13px] text-mist-400">选择左侧账号进行编辑</Card>
          )}
        </div>
      )}

      <Dialog open={creating && !!canManage} onClose={() => setParams({})} title="添加平台账号" width="max-w-lg">
        <AccountCreateForm
          key={createPlatform ?? 'any'}
          defaultPlatform={createPlatform}
          onCreated={(a) => {
            inv(['accounts'])
            setFilter('all')
            setSelected(a.id)
            setParams({})
            toast.success(a.platform === 'wechat_mp' ? '账号已添加，先建档；连接公众号可稍后回到这里完成' : '账号已添加，先来建档')
            nav(`/a/${a.id}/profile?wizard=1`)
          }}
        />
      </Dialog>
    </div>
  )
}
