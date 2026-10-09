import { Plus, Power, Users } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { AccountCreateForm, credTone, CredentialPanel } from '@/components/account-forms'
import { confirm, Dialog } from '@/components/dialog'
import { Badge, Button, Card, CardHeader, cn, Empty, Field, formatLabel, Input, PageHeader, PageLoading, PlatformMark, platformLabel, Select } from '@/components/ui'
import { ApiError, errorMessage, patch, post } from '@/lib/api'
import { useAccounts, useInvalidate } from '@/lib/session'
import type { Account, ContentFormat } from '@/lib/types'

const formats: Record<string, ContentFormat[]> = { wechat_mp: ['long_article', 'comic'], xhs: ['image_note', 'comic'] }

function AccountDetail({ account }: { account: Account }) {
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
    if (disabling && !(await confirm({ title: `停用「${account.name}」？`, desc: '停用后不会出现在账号切换中，也不能写入草稿。作品和数据会保留，可以随时重新启用。', confirmText: '停用', danger: true }))) return
    try {
      await post(`/accounts/${account.id}/${disabling ? 'disable' : 'enable'}`)
      inv(['accounts'])
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader title="基本信息" action={<Button size="sm" variant={account.status === 'active' ? 'ghost' : 'primary'} icon={<Power className="size-3.5" />} onClick={toggle}>{account.status === 'active' ? '停用账号' : '重新启用'}</Button>} />
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <Field label="账号名称"><Input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== account.name && save({ name })} /></Field>
          <Field label="内容形态" hint="已有作品保持原流程">
            <Select value={account.content_format} onChange={(e) => save({ content_format: e.target.value })}>
              {formats[account.platform].map((f) => <option key={f} value={f}>{formatLabel[f]}{f === 'comic' ? '（后续版本）' : ''}</option>)}
            </Select>
          </Field>
          {account.platform === 'wechat_mp' && (
            <Field label="每日写入草稿上限" hint="1–20 次，不能关闭。超过后仍可写入，但每次都需要二次确认。">
              <Input type="number" min={1} max={20} value={limit} onChange={(e) => setLimit(e.target.value)}
                onBlur={() => Number(limit) !== account.daily_push_limit && save({ daily_push_limit: Number(limit) })} />
            </Field>
          )}
        </div>
      </Card>
      {account.platform === 'wechat_mp' ? (
        <Card>
          <CardHeader title="公众号开发者凭证" desc="在公众号后台「设置与开发 → 基本配置」中获取 AppID 和 AppSecret。" />
          <div className="p-5"><CredentialPanel key={account.id} account={account} onChanged={() => inv(['accounts'])} /></div>
        </Card>
      ) : (
        <Card className="p-5 text-[13px] leading-relaxed text-mist-600">
          小红书没有面向个人创作者的发布接口。本系统不登录小红书、不保存小红书账号密码，作品通过「发布包」由你手动发布。
        </Card>
      )}
    </div>
  )
}

export default function SettingsAccounts() {
  const { data, isLoading } = useAccounts()
  const [params, setParams] = useSearchParams()
  const [selected, setSelected] = useState<string | null>(null)
  const inv = useInvalidate()
  const creating = params.get('new') === '1'
  const list = data ?? []
  useEffect(() => {
    if (!selected && list.length) setSelected(list[0].id)
  }, [list, selected])
  if (isLoading) return <PageLoading />
  const current = list.find((a) => a.id === selected)
  return (
    <div className="animate-fade-in">
      <PageHeader title="平台账号与凭证" desc="管理公众号和小红书账号。每个账号有独立的档案、素材和作品。"
        action={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setParams({ new: '1' })}>添加账号</Button>} />
      {list.length === 0 ? (
        <Card><Empty icon={<Users className="size-5" />} title="还没有平台账号" action={<Button variant="primary" onClick={() => setParams({ new: '1' })}>添加账号</Button>} /></Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
          <Card className="h-fit p-1.5">
            {list.map((a) => {
              const t = credTone(a.credential)
              return (
                <button key={a.id} onClick={() => setSelected(a.id)}
                  className={cn('flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-left transition', selected === a.id ? 'bg-ink-50' : 'hover:bg-mist-50', a.status === 'disabled' && 'opacity-55')}>
                  <PlatformMark platform={a.platform} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px] font-medium text-mist-900">{a.name}</div>
                    <div className="text-[11.5px] text-mist-500">{platformLabel[a.platform]} · {formatLabel[a.content_format]}</div>
                  </div>
                  {a.status === 'disabled' ? <Badge>已停用</Badge> : a.platform === 'wechat_mp' && <Badge tone={t.tone}>{t.label}</Badge>}
                </button>
              )
            })}
          </Card>
          {current && <AccountDetail account={current} />}
        </div>
      )}
      <Dialog open={creating} onClose={() => setParams({})} title="添加平台账号" width="max-w-lg">
        <AccountCreateForm onCreated={(a) => { inv(['accounts']); setSelected(a.id); setParams({}); toast.success('账号已添加') }} />
      </Dialog>
    </div>
  )
}
