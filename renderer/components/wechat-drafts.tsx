import { RefreshCw, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { confirm } from '@/components/dialog'
import { Badge, Button, Card, CardHeader, Empty, Notice } from '@/components/ui'
import { del, errorMessage, get } from '@/lib/api'
import { fmtTime } from '@/lib/format'
import type { Account } from '@/lib/types'

const PAGE_SIZE = 10

interface WechatDraftItem {
  media_id: string
  update_time: number
  updated_at: string
  title: string
}

interface WechatDraftList {
  total_count: number
  offset: number
  count: number
  items: WechatDraftItem[]
}

interface WechatDraftCount {
  total_count: number
}

function draftTime(item: WechatDraftItem): string {
  if (item.updated_at) return fmtTime(item.updated_at)
  return new Date(item.update_time * 1000).toLocaleString('zh-CN')
}

/**
 * 公众号草稿箱巡检（RC-01 / D-221）。
 * 只读列表与计数；删除一次只处理一个 media_id，必须逐张确认。
 * 没有“全部删除”入口，也不因删除作品自动调用 draft/delete。
 */
export function WechatDraftPanel({ account, canDelete }: { account: Account; canDelete: boolean }) {
  const [total, setTotal] = useState<number | null>(null)
  const [items, setItems] = useState<WechatDraftItem[]>([])
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [deleting, setDeleting] = useState('')
  const requestSeq = useRef(0)

  const load = async (nextOffset: number) => {
    const seq = ++requestSeq.current
    setLoading(true)
    setError('')
    try {
      const [count, list] = await Promise.all([
        get<WechatDraftCount>(`/accounts/${account.id}/wechat/drafts/count`),
        get<WechatDraftList>(`/accounts/${account.id}/wechat/drafts?offset=${nextOffset}&count=${PAGE_SIZE}`),
      ])
      if (seq !== requestSeq.current) return
      setTotal(count.total_count)
      setItems(list.items ?? [])
      setOffset(list.offset ?? nextOffset)
    } catch (e) {
      if (seq === requestSeq.current) setError(errorMessage(e))
    } finally {
      if (seq === requestSeq.current) setLoading(false)
    }
  }

  useEffect(() => {
    requestSeq.current++
    if (account.status !== 'active') {
      setLoading(false)
      setTotal(null)
      setItems([])
      setError('')
      return
    }
    setOffset(0)
    void load(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.id, account.status])

  const remove = async (item: WechatDraftItem) => {
    if (!canDelete) return
    if (!(await confirm({
      title: `删除公众号草稿「${item.title || '无标题草稿'}」？`,
      desc: '只删除这一篇草稿，不会发表、不会群发，删除后无法恢复。系统不会自动删除作品关联的其他草稿。',
      confirmText: '确认删除这一篇',
      danger: true,
    }))) return
    setDeleting(item.media_id)
    try {
      await del(`/accounts/${account.id}/wechat/drafts/${encodeURIComponent(item.media_id)}`, { confirm: true })
      toast.success(`已删除草稿「${item.title || '无标题草稿'}」`)
      const nextOffset = items.length === 1 && offset > 0 ? Math.max(0, offset - PAGE_SIZE) : offset
      await load(nextOffset)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setDeleting('')
    }
  }

  const disabled = account.status !== 'active'
  const pageStart = total === null || items.length === 0 ? 0 : offset + 1
  const pageEnd = total === null ? 0 : Math.min(offset + items.length, total)

  return (
    <Card data-testid="wechat-drafts-card">
      <CardHeader
        title="公众号草稿箱"
        desc="只读查看当前草稿；删除只能逐篇确认，不会发表或群发。"
        action={(
          <div className="flex items-center gap-2">
            {total !== null && <Badge tone="blue">共 {total} 篇</Badge>}
            <Button
              size="sm"
              variant="ghost"
              icon={<RefreshCw className="size-3.5" />}
              disabled={loading || disabled}
              onClick={() => void load(offset)}
            >
              {loading ? '读取中…' : '刷新'}
            </Button>
          </div>
        )}
      />
      {disabled ? (
        <div className="p-5">
          <Notice tone="gray">账号已停用，启用后才能读取或删除公众号草稿。</Notice>
        </div>
      ) : error ? (
        <div className="space-y-3 p-5">
          <Notice tone="red">{error}</Notice>
          <Button size="sm" variant="secondary" onClick={() => void load(offset)}>重试读取</Button>
        </div>
      ) : loading && total === null ? (
        <div className="space-y-2 p-5 text-[13px] text-mist-500">正在读取草稿箱…</div>
      ) : total === 0 ? (
        <Empty title="草稿箱为空" desc="当前公众号没有草稿。写入草稿后会出现在这里。" />
      ) : (
        <>
          <div className="divide-y divide-mist-100">
            {items.map((item) => (
              <div key={item.media_id} className="flex items-start gap-3 px-5 py-3" data-testid="wechat-draft-row">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-[13.5px] font-medium text-ink-800">{item.title || '（无标题草稿）'}</span>
                    <span className="text-[11.5px] text-mist-400">#{item.media_id.slice(0, 10)}…</span>
                  </div>
                  <div className="mt-1 text-[12px] text-mist-500">最后修改 {draftTime(item)}</div>
                </div>
                {canDelete ? (
                  <Button
                    size="sm"
                    variant="danger"
                    icon={<Trash2 className="size-3.5" />}
                    disabled={Boolean(deleting) || loading}
                    onClick={() => void remove(item)}
                    data-testid="wechat-draft-delete"
                  >
                    {deleting === item.media_id ? '删除中…' : '删除'}
                  </Button>
                ) : (
                  <span className="text-[12px] text-mist-400">只读</span>
                )}
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-mist-100 px-5 py-3 text-[12px] text-mist-500">
            <span>{total === null ? '—' : `第 ${pageStart}–${pageEnd} 篇 / 共 ${total} 篇`}</span>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" disabled={loading || offset === 0} onClick={() => void load(Math.max(0, offset - PAGE_SIZE))}>上一页</Button>
              <Button size="sm" variant="ghost" disabled={loading || total === null || offset + PAGE_SIZE >= total} onClick={() => void load(offset + PAGE_SIZE)}>下一页</Button>
            </div>
          </div>
          {!canDelete && <p className="px-5 pb-4 text-[12px] text-mist-400">删除仅工作区所有者可操作；其他成员只能查看。</p>}
        </>
      )}
    </Card>
  )
}
