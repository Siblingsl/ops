import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { Dialog } from '@/components/dialog'
import { Badge, Button, Card, CardHeader, Empty, Input, Notice, PageHeader, PageState } from '@/components/ui'
import { api, errorMessage, get } from '@/lib/api'
import { useMe } from '@/lib/session'

// REF41 E1（docs/41 §E1）：飞书出站与 ChatOps 配置页。
// webhook 只在创建时粘贴，保存后不回显明文；事件多选白名单；发送测试消息；
// 绑定管理（chat_id/群私聊/账号/角色）；登录二维码仅 p2p 提示。

interface FeishuBot { id: string; name: string; events: string[]; status: string; created_at: string }
interface FeishuBinding { id: string; bot_id: string; chat_id: string; chat_type: string; account_id: string | null; role: string; active: boolean }

const EVENT_LABELS: Record<string, string> = {
  publish_login_required: '发布掉线（未登录）',
  publish_drift: '定时漂移',
  review_peer: '同龄对比卡',
  job_failed: '任务失败',
  conversion: '转化回传',
}

export default function FeishuSettings() {
  const me = useMe()
  const queryClient = useQueryClient()
  const bots = useQuery({ queryKey: ['feishu-bots', me.data?.workspace.id], queryFn: ({ signal }) => get<{ items: FeishuBot[]; events: string[] }>('/feishu-bots', { signal }) })
  const [creating, setCreating] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const refresh = async () => {
    setCreating(false); setSelected(null)
    await queryClient.invalidateQueries({ queryKey: ['feishu-bots'] })
  }
  const isOwner = me.data?.role === 'owner'
  return (
    <div className="max-w-3xl animate-fade-in">
      <PageHeader title="飞书通知" desc="把发布掉线、定时漂移、同龄对比卡、任务失败与转化回传推送到飞书；群聊里可查状态，不提供发布或确认类操作。"
        action={isOwner && <Button variant="primary" onClick={() => setCreating(true)}>新建机器人</Button>} />
      {!isOwner && <Notice>只有工作区所有者可以配置飞书机器人。</Notice>}
      {(bots.isPending || bots.error) && <PageState loading={bots.isPending} error={bots.error} onRetry={() => void bots.refetch()} />}
      {bots.data?.items.length === 0 && <Empty title="还没有飞书机器人" desc="新建一个机器人并粘贴 webhook 地址，按事件订阅推送。" />}
      <div className="space-y-3">
        {bots.data?.items.map(bot => <Card key={bot.id} data-testid={`feishu-bot-${bot.id}`}>
          <CardHeader title={<span className="flex items-center gap-2">{bot.name}
            {bot.status === 'active' ? <Badge>启用中</Badge> : <Badge>已停用</Badge>}</span>}
            action={<div className="flex items-center gap-1">
              <Button variant="ghost" size="sm" onClick={() => setSelected(bot.id)}>绑定与事件</Button>
              <TestButton botId={bot.id} />
              <DeleteButton botId={bot.id} onDeleted={() => void refresh()} />
            </div>} />
          <div className="px-5 pb-4 text-[13px] text-mist-500">
            订阅事件：{bot.events.map(e => EVENT_LABELS[e] ?? e).join('、') || '（空）'}
          </div>
        </Card>)}
      </div>
      {creating && <BotEditor onClose={() => setCreating(false)} onSaved={() => void refresh()} />}
      {selected && <BindingEditor botId={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}

function BotEditor({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState('')
  const [webhook, setWebhook] = useState('')
  const [secret, setSecret] = useState('')
  const [events, setEvents] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const all = Object.keys(EVENT_LABELS)
  const submit = async () => {
    if (busy) return
    setBusy(true); setFailure('')
    try {
      await api('POST', '/feishu-bots', { name, webhook_url: webhook, webhook_secret: secret, events })
      toast.success('机器人已创建')
      onSaved()
    } catch (e) { setFailure(errorMessage(e)) } finally { setBusy(false) }
  }
  return <Dialog open onClose={onClose} title="新建飞书机器人" ariaLabel="新建飞书机器人" width="max-w-xl" footer={
    <Button variant="primary" loading={busy} disabled={!name.trim() || !webhook.trim() || events.length === 0} onClick={() => void submit()}>创建</Button>
  }>
    <div className="space-y-3 text-sm">
      <label className="block">名称<Input value={name} onChange={e => setName(e.target.value)} placeholder="如：发布告警群机器人" className="mt-1" /></label>
      <label className="block">Webhook 地址（保存后不回显）<Input value={webhook} onChange={e => setWebhook(e.target.value)} placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/…" className="mt-1" /></label>
      <label className="block">签名密钥（可选）<Input value={secret} onChange={e => setSecret(e.target.value)} type="password" className="mt-1" /></label>
      <fieldset className="space-y-1.5"><legend className="text-[13px] font-medium">订阅事件</legend>
        {all.map(e => <label key={e} className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={events.includes(e)} onChange={ev => setEvents(ev.target.checked ? [...events, e] : events.filter(x => x !== e))} />
          {EVENT_LABELS[e]}
        </label>)}
      </fieldset>
      {failure && <Notice tone="gamboge">{failure}</Notice>}
    </div>
  </Dialog>
}

function TestButton({ botId }: { botId: string }) {
  const [busy, setBusy] = useState(false)
  const test = async () => {
    setBusy(true)
    try {
      await api('POST', `/feishu-bots/${botId}/test`, {})
      toast.success('测试消息已发送；请到飞书群查看')
    } catch (e) { toast.error(errorMessage(e)) } finally { setBusy(false) }
  }
  return <Button variant="ghost" size="sm" loading={busy} data-testid={`feishu-test-${botId}`} onClick={() => void test()}>发送测试</Button>
}

function DeleteButton({ botId, onDeleted }: { botId: string; onDeleted: () => void }) {
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const remove = async () => {
    setBusy(true)
    try { await api('DELETE', `/feishu-bots/${botId}`); toast.success('已删除'); onDeleted() } finally { setBusy(false) }
  }
  return <>
    <Button variant="ghost" size="sm" onClick={() => setConfirm(true)}>删除</Button>
    {confirm && <Dialog open onClose={() => setConfirm(false)} title="删除机器人" footer={<>
      <Button variant="ghost" onClick={() => setConfirm(false)}>取消</Button>
      <Button variant="primary" loading={busy} onClick={() => void remove()}>确认删除</Button>
    </>}><p className="text-sm">删除后该机器人的全部绑定与订阅一并移除，此操作不可撤销。</p></Dialog>}
  </>
}

function BindingEditor({ botId, onClose }: { botId: string; onClose: () => void }) {
  const bindings = useQuery({ queryKey: ['feishu-bindings', botId], queryFn: ({ signal }) => get<{ items: FeishuBinding[] }>(`/feishu-bots/${botId}/bindings`, { signal }) })
  const queryClient = useQueryClient()
  const [chatId, setChatId] = useState('')
  const [chatType, setChatType] = useState('group')
  const [busy, setBusy] = useState(false)
  const save = async () => {
    if (!chatId.trim() || busy) return
    setBusy(true)
    try {
      await api('PUT', `/feishu-bots/${botId}/bindings`, { chat_id: chatId.trim(), chat_type: chatType, role: 'member' })
      setChatId('')
      await queryClient.invalidateQueries({ queryKey: ['feishu-bindings', botId] })
    } catch (e) { toast.error(errorMessage(e)) } finally { setBusy(false) }
  }
  return <Dialog open onClose={onClose} title="绑定与事件" ariaLabel="绑定与事件" width="max-w-xl">
    <div className="space-y-3 text-sm">
      <p className="text-mist-500">登录二维码只发私聊（p2p）；群聊只返回聚合状态，不含账号敏感字段。</p>
      {(bindings.isPending || bindings.error) && <PageState loading={bindings.isPending} error={bindings.error} onRetry={() => void bindings.refetch()} />}
      {bindings.data?.items.length === 0 && <Empty title="还没有绑定会话" desc="把群聊或私聊的 chat_id 绑定到机器人后才能收到推送。" />}
      {bindings.data?.items.map(b => <div key={b.id} data-testid={`feishu-binding-${b.id}`} className="flex items-center justify-between rounded border border-mist-200 px-3 py-2 text-[13px]">
        <span>{b.chat_type === 'group' ? '群聊' : '私聊'} · {b.chat_id.slice(0, 12)}…{b.role === 'owner' ? ' · 管理' : ''}{b.active ? '' : ' · 已停用'}</span>
        <Badge>{b.chat_type}</Badge>
      </div>)}
      <div className="flex items-center gap-2">
        <Input value={chatId} onChange={e => setChatId(e.target.value)} placeholder="chat_id（oc_…）" className="flex-1" />
        <select aria-label="会话类型" value={chatType} onChange={e => setChatType(e.target.value)} className="h-8 rounded border border-mist-200 text-[13px]">
          <option value="group">群聊</option><option value="p2p">私聊</option>
        </select>
        <Button loading={busy} disabled={!chatId.trim()} onClick={() => void save()}>保存绑定</Button>
      </div>
    </div>
  </Dialog>
}
