import { useState } from 'react'
import { toast } from 'sonner'
import { Button, Card, CardHeader, PageHeader, Select } from '@/components/ui'
import { errorMessage, rawRequest } from '@/lib/api'
import { useAccounts } from '@/lib/session'

export default function ExportPage() {
  const { data: accounts } = useAccounts()
  const [kind, setKind] = useState('works')
  const [accountId, setAccountId] = useState('')
  const [busy, setBusy] = useState(false)
  const run = async () => {
    setBusy(true)
    try {
      const res = await rawRequest('POST', '/exports', { kind, account_id: accountId || undefined })
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = kind === 'reviews' ? 'reviews.md' : `${kind}.csv`
      a.click()
      URL.revokeObjectURL(url)
      toast.success('已开始下载')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="animate-fade-in">
      <PageHeader title="数据导出" desc="导出作品、素材或复盘结果。若会话需要，会先要求确认登录密码。" />
      <Card className="p-5">
        <CardHeader title="选择范围" />
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <div className="mb-1.5 text-[13px] font-medium text-mist-700">类型</div>
            <Select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="works">作品（CSV）</option>
              <option value="materials">素材（CSV）</option>
              <option value="reviews">复盘（Markdown）</option>
            </Select>
          </div>
          {kind === 'works' && (
            <div>
              <div className="mb-1.5 text-[13px] font-medium text-mist-700">账号（可选）</div>
              <Select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                <option value="">全部账号</option>
                {(accounts ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </Select>
            </div>
          )}
        </div>
        <div className="mt-5 flex justify-end">
          <Button variant="primary" loading={busy} onClick={run}>导出</Button>
        </div>
      </Card>
    </div>
  )
}
