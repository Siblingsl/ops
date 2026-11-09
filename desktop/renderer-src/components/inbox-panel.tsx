import { useInfiniteQuery } from '@tanstack/react-query'
import { Inbox, Lightbulb, Plus, Sparkles, Wand2 } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Dialog } from '@/components/dialog'
import { Button, Card, Empty, Field, Input, Notice, PageLoading, Select, Tabs, Textarea } from '@/components/ui'
import { openQuickCollect } from '@/components/quick-collect'
import { VoiceButton } from '@/components/voice'
import { del, errorMessage, get, patch, post } from '@/lib/api'
import { relTime } from '@/lib/format'
import { isEnterWithoutComposition } from '@/lib/keyboard'
import { useCanWrite, useInvalidate } from '@/lib/session'
import type { InboxItem, InboxPage, InboxSuggestion, MaterialKind, Work } from '@/lib/types'

function ConvertDialog({ item, accountId, suggestion, work, onLinked, onClose }: { item: InboxItem; accountId: string; suggestion: InboxSuggestion | null; work?: Work; onLinked?: (work: Work) => void; onClose: () => void }) {
  const inv = useInvalidate()
  const nav = useNavigate()
  const [to, setTo] = useState<'topic' | 'material'>(suggestion?.as ?? 'topic')
  const [title, setTitle] = useState(suggestion?.title || item.content.slice(0, 30))
  const [angle, setAngle] = useState(suggestion?.angle ?? '')
  const [audience, setAudience] = useState(suggestion?.audience ?? '')
  const [kind, setKind] = useState<MaterialKind>((suggestion?.kind as MaterialKind) || 'opinion')
  const [content, setContent] = useState(item.content)
  const [tags, setTags] = useState((suggestion?.tags ?? []).join('、'))
  const [busy, setBusy] = useState(false)
  const [linkWork, setLinkWork] = useState(false)
  const [created, setCreated] = useState<string | null>(null)
  const go = async () => {
    setBusy(true)
    let materialID = created
    try {
      if (!materialID) {
        const result = await post<{ id: string }>(`/inbox/${item.id}/convert`, to === 'topic'
          ? { to, account_id: accountId, title, angle, audience }
          : { to, account_id: accountId, kind, content, tags: tags.split(/[、,，]/).map((x) => x.trim()).filter(Boolean) })
        inv(['inbox'], ['topics', accountId], ['materials'])
        if (to === 'material') {
          materialID = result.id
          setCreated(result.id)
          setTo('material')
        }
      }
      if (materialID && linkWork && work) {
        const latest = await get<Work>(`/works/${work.id}`)
        const linked = await patch<Work>(`/works/${work.id}`, { material_ids: [...new Set([...latest.material_ids, materialID])], base_revision: latest.revision })
        onLinked?.(linked)
      }
      toast.success(to === 'topic' ? '已转为选题' : linkWork && work ? '已存入素材库并关联当前作品' : '已存入素材库', {
        // TP-02：整理完成要有出口——直接去刚生成的选题/素材，不用自己再找。
        action: to === 'topic'
          ? { label: '去选题池', onClick: () => { onClose(); nav(`/a/${accountId}/topics?adopted=1`) } }
          : { label: '去素材库', onClick: () => { onClose(); nav(`/a/${accountId}/materials`) } },
      })
      onClose()
    } catch (e) {
      toast.error(errorMessage(e), { description: materialID ? '素材已存入，关联未完成；可重试关联，或取消关联后完成。' : undefined })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open onClose={onClose} title="整理这条灵感" desc="只处理这一条。确认后原灵感会标记为已整理。"
      footer={<><Button variant="ghost" onClick={onClose}>{created ? '关闭' : '取消'}</Button><Button variant="primary" loading={busy} onClick={go}>{created ? linkWork ? '重试关联' : '完成' : to === 'topic' ? '转为选题' : '存为素材'}</Button></>}>
      <div className="space-y-4">
        {created ? <Notice>素材已存入，可重试关联当前作品，或取消关联后完成。</Notice> : <>
        <Tabs value={to} onChange={setTo} items={[{ value: 'topic', label: '转为选题' }, { value: 'material', label: '存为素材' }]} />
        {suggestion?.reason && <Notice tone="ink" icon={<Sparkles className="size-4" />}>AI 建议{suggestion.as === 'topic' ? '作为选题' : '作为素材'}：{suggestion.reason}</Notice>}
        {to === 'topic' ? (
          <>
            <Field label="选题标题"><Input value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
            <Field label="切入角度"><Textarea rows={2} value={angle} onChange={(e) => setAngle(e.target.value)} /></Field>
            <Field label="目标读者"><Input value={audience} onChange={(e) => setAudience(e.target.value)} /></Field>
          </>
        ) : (
          <>
            <Field label="类型">
              <Select value={kind} onChange={(e) => setKind(e.target.value as MaterialKind)}>
                <option value="experience">经历</option><option value="opinion">观点</option><option value="case">案例</option><option value="data">数据</option>
              </Select>
            </Field>
            <Field label="内容"><Textarea rows={4} value={content} onChange={(e) => setContent(e.target.value)} /></Field>
            <Field label="标签" hint="用顿号分隔"><Input value={tags} onChange={(e) => setTags(e.target.value)} /></Field>
          </>
        )}
        </>}
        {work && to === 'material' && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={linkWork} disabled={busy || work.locked} onChange={e => setLinkWork(e.target.checked)} />同时关联到当前作品</label>}
      </div>
    </Dialog>
  )
}

export function InboxPanel({ accountId, work, onLinked }: { accountId: string; work?: Work; onLinked?: (work: Work) => void }) {
  const canWrite = useCanWrite()
  const inv = useInvalidate()
  const inbox = useInfiniteQuery({
    queryKey: ['inbox'],
    queryFn: ({ pageParam }) => get<InboxPage>(`/inbox${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ''}`),
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  })
  const [text, setText] = useState('')
  const [readPage, setReadPage] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [suggestions, setSuggestions] = useState<Record<string, InboxSuggestion>>({})
  const [converting, setConverting] = useState<InboxItem | null>(null)
  const add = async () => {
    if (!text.trim()) return
    try {
      await post('/inbox', { account_id: accountId, content: text.trim(), source: 'quick', read_page: readPage && /https:\/\/(?:[^\s/]+\.)?(?:xiaohongshu\.com|xhslink\.com|mp\.weixin\.qq\.com)\//i.test(text) })
      setText('')
      setReadPage(false)
      if (readPage) inv(['references'])
      inv(['inbox'])
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const triage = async (it: InboxItem) => {
    setBusyId(it.id)
    try {
      const s = await post<InboxSuggestion>(`/inbox/${it.id}/triage`)
      setSuggestions((m) => ({ ...m, [it.id]: s }))
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusyId(null)
    }
  }
  // TP-01：丢掉不再无路可退——软删除 + 10 秒撤销。
  const dismiss = async (it: InboxItem) => {
    await del(`/inbox/${it.id}`).catch((e) => toast.error(errorMessage(e)))
    inv(['inbox'])
    toast(`已丢掉「${it.content.slice(0, 20)}${it.content.length > 20 ? '…' : ''}」`, {
      description: '10 秒内可以撤销；丢掉只是移出收件箱。',
      duration: 10_000,
      action: {
        label: '撤销',
        onClick: async () => {
          try {
            await post(`/inbox/${it.id}/restore`)
            inv(['inbox'])
            toast.success('已恢复这条灵感')
          } catch (e) {
            toast.error(errorMessage(e))
          }
        },
      },
    })
  }
  if (inbox.isLoading) return <PageLoading />
  const list = inbox.data?.pages.flatMap((page) => page.items) ?? []
  const total = inbox.data?.pages[0]?.total ?? 0
  return (
    <div className="inbox-panel space-y-4">
      {canWrite && (
        <Card className="p-3">
          <div className="flex items-start gap-2">
            <Textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="随手记一条灵感，不用想好怎么分类…（Ctrl+Enter 保存）"
              onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && isEnterWithoutComposition(e.nativeEvent)) { e.preventDefault(); void add() } }} />
            <div className="flex flex-col gap-1.5">
              <Button variant="primary" onClick={add} disabled={!text.trim()}>记下</Button>
              <VoiceButton onText={(t) => setText((v) => v + t)} className="self-center" />
            </div>
          </div>
          {/https:\/\/(?:[^\s/]+\.)?(?:xiaohongshu\.com|xhslink\.com|mp\.weixin\.qq\.com)\//i.test(text) && <label className="mt-2 flex items-center gap-2 text-sm text-mist-600"><input type="checkbox" checked={readPage} onChange={(e) => setReadPage(e.target.checked)} />读取页面为对标参考（受 robots 和限额约束，可手动粘贴）</label>}
        </Card>
      )}
      <Notice icon={<Inbox className="size-4" />}>收件箱里的灵感需要你一条一条处理：可以先让 AI 建议归类，再决定转为选题、存为素材，或者丢掉。系统每天也会为新灵感预先生成归类建议，但不会替你转换。</Notice>
      <p className="text-[12px] text-mist-400">当前收件箱共 {total} 条灵感</p>
      {list.length === 0 ? <Card><Empty icon={<Inbox className="size-5" />} title="收件箱是空的" desc="任何页面按 Ctrl+Shift+I 都能快速记一条灵感，手机上可以用右下角按钮。"
        action={canWrite ? <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => openQuickCollect('inbox')}>记一条灵感</Button> : undefined} /></Card> : (
        <div className="inbox-panel-list grid gap-3">
          {list.map((it) => {
            const sug = suggestions[it.id] ?? it.suggestion
            return (
              <Card key={it.id} className="p-4">
                <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-mist-800">{it.content}</p>
                <div className="mt-1.5 text-[11.5px] text-mist-400">{relTime(it.created_at)} · {{ quick: '随手记', share: '分享', palette: '命令面板', mobile: '手机' }[it.source] ?? it.source}</div>
                {sug && (
                  <div className="mt-2 rounded-lg bg-ink-50/60 px-2.5 py-1.5 text-[12.5px] text-ink-800">
                    <Sparkles className="mr-1 inline size-3.5" />建议{sug.as === 'topic' ? `作为选题「${sug.title}」` : '作为素材'}{sug.reason && `：${sug.reason}`}
                  </div>
                )}
                {canWrite && (
                  <div className="mt-3 flex flex-wrap items-center gap-1.5">
                    {!sug && <Button size="sm" variant="ghost" icon={<Wand2 className="size-3.5" />} loading={busyId === it.id} onClick={() => triage(it)}>AI 建议归类</Button>}
                    <Button size="sm" variant="outline" icon={<Lightbulb className="size-3.5" />} onClick={() => setConverting(it)}>整理</Button>
                    <Button size="sm" variant="ghost" className="ml-auto text-mist-400" onClick={() => dismiss(it)}>丢掉</Button>
                  </div>
                )}
              </Card>
            )
          })}
        </div>
      )}
      {inbox.hasNextPage && <div className="text-center"><Button size="sm" variant="ghost" loading={inbox.isFetchingNextPage} onClick={() => { void inbox.fetchNextPage() }}>加载更多</Button></div>}
      {converting && <ConvertDialog item={converting} accountId={accountId} work={work} onLinked={onLinked} suggestion={suggestions[converting.id] ?? converting.suggestion} onClose={() => setConverting(null)} />}
    </div>
  )
}
