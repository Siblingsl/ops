import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Archive, Check, ClipboardCopy, Plus, Wand2 } from 'lucide-react'
import { useState } from 'react'
import { Badge, Button, Card, Field, Input, Notice, Select, Textarea } from '@/components/ui'
import { ApiError, del, errorMessage, get, patch, post } from '@/lib/api'
import { useCanWrite } from '@/lib/session'
import { copyText } from '@/lib/format'
import type { Account } from '@/lib/types'

// DEV-CX13-E / FR-CX-22：评论处理台账。
// 逐条录入与操作：POST 只收单条；复制/已发由客户端显式回执；无任何发送路径。
// 正文本地解析提示（空行分隔 ≤50 条）只做录入辅助，预览不写库。

type ReplyStatus = 'none' | 'drafted' | 'copied' | 'sent_manual'

interface InboxComment {
  id: string
  author_alias: string
  content: string
  category: string | null
  reply_draft: string
  reply_status: ReplyStatus
  revision: number
  reply_revision: number
  captured_at: string
}

const categoryLabel: Record<string, string> = {
  question: '提问', objection: '异议', praise: '好评', negative: '负面', spam: '垃圾',
}
const statusLabel: Record<ReplyStatus, string> = {
  none: '未处理', drafted: '已拟稿', copied: '已复制', sent_manual: '已人工回复',
}

function apiErrorText(reason: unknown) {
  if (reason instanceof ApiError && reason.code === 'version_conflict') return '内容已被其他窗口修改，请刷新后重试。'
  return errorMessage(reason)
}

function CommentCard({ comment, canWrite, onChange }: { comment: InboxComment; canWrite: boolean; onChange: () => void }) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  const call = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
      onChange()
    } catch (reason) {
      setError(apiErrorText(reason))
    } finally {
      setBusy(false)
    }
  }

  const suggest = () => call(() => post(`/comment-inbox/${comment.id}/reply-suggest`, { base_revision: comment.revision }))
  const markCopied = () => call(() => post(`/comment-inbox/${comment.id}/copy-reply`, { base_revision: comment.revision }))
  const markSent = () => call(() => post(`/comment-inbox/${comment.id}/confirm-sent`, { base_revision: comment.revision }))
  const copyToClipboard = async () => {
    // copied 必须剪贴板真正成功：先写剪贴板（含 execCommand 降级），成功后才调回执接口。
    try {
      await copyText(comment.reply_draft)
    } catch {
      setError('剪贴板写入失败，状态不前进；请手动复制后再点。')
      return
    }
    setCopied(true)
    await markCopied()
  }
  const convert = async () => {
    await call(async () => {
      const preview = await get<{ summary: string }>(`/comment-inbox/${comment.id}/topic-preview`)
      const title = window.prompt('转为选题的标题（预览摘要：' + preview.summary.slice(0, 40) + '…）')
      if (!title) throw new Error('已取消')
      await post(`/comment-inbox/${comment.id}/convert-topic`, { title, idempotency_key: comment.id })
    })
  }
  const remove = () => {
    if (!window.confirm('删除这条评论？正文与草稿将被清除，不可恢复。')) return
    void call(() => del(`/comment-inbox/${comment.id}`))
  }

  return (
    <Card className="p-3" data-testid="inbox-comment-item">
      <div className="flex flex-wrap items-center gap-2">
        {comment.category && <Badge tone="gray">{categoryLabel[comment.category] ?? comment.category}</Badge>}
        <Badge tone={comment.reply_status === 'sent_manual' ? 'ink' : 'gamboge'}>{statusLabel[comment.reply_status]}</Badge>
        <span className="text-[11px] text-mist-400">{comment.author_alias || '（未具名）'} · {comment.captured_at.slice(0, 10)}</span>
        <Button size="sm" variant="ghost" className="ml-auto" icon={<Archive className="size-3.5" />} disabled={!canWrite || busy} aria-label="删除评论" onClick={remove} />
      </div>
      <p className="mt-1.5 whitespace-pre-wrap text-[12.5px] leading-relaxed text-mist-800">{comment.content}</p>
      {comment.reply_draft && <div className="mt-2 rounded-md bg-ink-50/50 p-2 text-[12px]" data-testid="comment-reply-draft">
        <p className="font-medium text-ink-800">回复草稿（v{comment.reply_revision}）</p>
        <p className="mt-0.5 leading-relaxed text-mist-700">{comment.reply_draft}</p>
      </div>}
      {error && <div className="mt-2"><Notice tone="red">{error}</Notice></div>}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {canWrite && <Button size="sm" variant="ghost" icon={<Wand2 className="size-3" />} loading={busy} onClick={() => void suggest()}>AI 分类拟稿</Button>}
        {comment.reply_status !== 'none' && canWrite && (
          <Button size="sm" variant="ghost" icon={<ClipboardCopy className="size-3" />} disabled={busy} onClick={() => void copyToClipboard()}>
            {copied ? '已复制' : '复制草稿'}
          </Button>
        )}
        {comment.reply_status === 'copied' && canWrite && (
          <Button size="sm" variant="ghost" icon={<Check className="size-3" />} disabled={busy} onClick={() => void markSent()}>确认已人工发送</Button>
        )}
        {canWrite && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void convert()}>转为选题</Button>}
      </div>
    </Card>
  )
}

export default function CommentInboxTab({ account }: { account: Account }) {
  const qc = useQueryClient()
  const canWrite = useCanWrite()
  const [filter, setFilter] = useState('')
  const [content, setContent] = useState('')
  const [alias, setAlias] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const page = useQuery({
    queryKey: ['comment-inbox', account.id, filter],
    queryFn: () => get<{ items: InboxComment[]; next_cursor: number }>(`/accounts/${account.id}/comments${filter ? `?category=${filter}` : ''}`),
  })
  const drafts = content.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean)

  const create = async () => {
    if (!canWrite || busy || !content.trim()) return
    setBusy(true)
    setError('')
    try {
      // 一次只入库一条（多条本地提示逐条点）；这里取第一段，其余保留在输入框。
      const first = drafts[0]
      await post('/comments', { account_id: account.id, author_alias: alias.trim(), content: first })
      const rest = drafts.slice(1).join('\n\n')
      setContent(rest)
      await qc.invalidateQueries({ queryKey: ['comment-inbox', account.id] })
    } catch (reason) {
      setError(apiErrorText(reason))
    } finally {
      setBusy(false)
    }
  }

  const patchCategory = async (comment: InboxComment, category: string) => {
    try {
      await patch(`/comment-inbox/${comment.id}`, { base_revision: comment.revision, category })
      await qc.invalidateQueries({ queryKey: ['comment-inbox', account.id] })
    } catch (reason) {
      setError(apiErrorText(reason))
    }
  }

  return (
    <div className="space-y-4" data-testid="comment-inbox-tab">
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[15px] font-bold text-mist-900">评论处理台账</h2>
          <Badge tone="gray">逐条录入 · 无自动发送</Badge>
          <div className="ml-auto flex items-center gap-2">
            <span className="text-[11px] text-mist-500">分类过滤</span>
            <Select aria-label="评论分类过滤" className="h-8 w-24 text-[12px]" value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="">全部</option>
              {Object.entries(categoryLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </Select>
          </div>
        </div>
        <p className="mt-1 text-[12px] leading-relaxed text-mist-500">
          手动粘贴读者评论并逐条入库；默认不保存真实昵称，只保存你自己填写的别名。回复草稿复制后由你在平台手动发送，这里不提供任何发送功能。
        </p>
        {error && <div className="mt-2"><Notice tone="red">{error}</Notice></div>}
        {canWrite && <div className="mt-3 space-y-2">
          <Field label={`评论正文（空行分隔多条，共 ${drafts.length} 条待入库；每条 1..5000 字）`}>
            <Textarea rows={4} value={content} maxLength={5000} aria-label="评论正文" onChange={(e) => setContent(e.target.value)}
              placeholder={'粘贴读者评论，多条用空行分隔。\n若含手机号等个人信息，请先手动删除再入库。'} />
          </Field>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="作者别名（可选，最多 100 字）"><Input value={alias} maxLength={100} onChange={(e) => setAlias(e.target.value)} /></Field>
            <Button size="sm" variant="primary" className="mb-0.5" icon={<Plus className="size-3.5" />} loading={busy}
              disabled={!canWrite || busy || !content.trim()} onClick={() => void create()}>
              入库第一条{drafts.length > 1 ? `（剩 ${drafts.length - 1} 条）` : ''}
            </Button>
          </div>
          {drafts.length > 50 && <Notice tone="gamboge">一次最多处理 50 条，请分批粘贴。</Notice>}
        </div>}
        <div className="mt-3 space-y-2" data-testid="comment-inbox-list">
          {page.data?.items.map((comment) => (
            <div key={comment.id}>
              <CommentCard comment={comment} canWrite={canWrite} onChange={() => void qc.invalidateQueries({ queryKey: ['comment-inbox', account.id] })} />
              {canWrite && <div className="mt-1 flex gap-1.5">
                {Object.entries(categoryLabel).map(([value, label]) => (
                  <Button key={value} size="sm" variant={comment.category === value ? 'secondary' : 'ghost'}
                    disabled={busy} onClick={() => void patchCategory(comment, value)}>{label}</Button>
                ))}
              </div>}
            </div>
          ))}
          {page.data && page.data.items.length === 0 && <p className="text-[12px] text-mist-400">还没有评论。粘贴后逐条入库。</p>}
        </div>
      </Card>
    </div>
  )
}
