import { useQuery } from '@tanstack/react-query'
import { Users } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Badge, Button, Card, CardHeader, Field, Input } from '@/components/ui'
import { errorMessage, get, post } from '@/lib/api'
import { fmtNum } from '@/lib/format'
import type { FollowerList } from '@/lib/types'

const yesterday = () => {
  const d = new Date(Date.now() - 86400000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

type FormKey = 'new_follow' | 'cancel_follow' | 'cumulate'
const formFields: { key: FormKey; label: string }[] = [
  { key: 'new_follow', label: '新增关注' }, { key: 'cancel_follow', label: '取消关注' }, { key: 'cumulate', label: '粉丝总数' },
]

/** DEV-DR09：账号级每日粉丝数据。认证公众号随数据同步写入；其他账号逐日手动补录，同一天以接口数据为准。 */
export function FollowersCard({ accountId, wechat }: { accountId: string; wechat: boolean }) {
  const q = useQuery({ queryKey: ['followers', accountId], queryFn: () => get<FollowerList>(`/accounts/${accountId}/followers?days=30`) })
  const [open, setOpen] = useState(false)
  const [date, setDate] = useState(yesterday)
  const [vals, setVals] = useState<Record<FormKey, string>>({ new_follow: '', cancel_follow: '', cumulate: '' })
  const [busy, setBusy] = useState(false)
  const days = q.data?.days ?? []
  const save = async () => {
    const body: Record<string, string | number> = { date }
    for (const f of formFields) if (vals[f.key].trim() !== '') body[f.key] = Number(vals[f.key])
    setBusy(true)
    try {
      await post(`/accounts/${accountId}/followers`, body)
      toast.success(`已记录 ${date} 的粉丝数据`)
      setVals({ new_follow: '', cancel_follow: '', cumulate: '' })
      void q.refetch()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const desc = q.data?.api
    ? '公众号数据同步时一并读取最近 7 天的新增、取消关注和粉丝总数；手动补录的同一天会以接口数据为准'
    : wechat ? '当前公众号没有数据统计接口权限，可以从后台抄录每天的关注数据' : '从平台后台抄录每天的关注数据，用来对照作品发布前后的粉丝变化'
  return (
    <Card>
      <CardHeader title="账号粉丝变化（近 30 天）" desc={desc}
        action={<Button size="sm" variant="secondary" icon={<Users className="size-3.5" />} onClick={() => setOpen((o) => !o)}>{open ? '收起' : '补录一天'}</Button>} />
      {open && (
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
      {days.length === 0 ? (
        <p className="p-5 text-[13px] text-mist-500">{q.data?.api ? '还没有同步到粉丝数据，点「同步公众号数据」或等每天的自动同步。' : '还没有粉丝数据。'}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[13.5px]">
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
                  <td className="py-2.5 pr-5 text-right"><Badge tone={d.source === 'wechat_api' ? 'ink' : undefined}>{d.source === 'wechat_api' ? '公众号接口' : '手动录入'}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
