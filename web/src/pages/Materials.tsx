import { useQuery } from '@tanstack/react-query'
import { Library, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { confirm, Dialog } from '@/components/dialog'
import { Badge, Button, Card, cn, Empty, Field, IconButton, Input, PageHeader, PageLoading, Select, Tabs, Textarea } from '@/components/ui'
import { del, errorMessage, get, patch, post } from '@/lib/api'
import { relTime } from '@/lib/format'
import { useCurrentAccount, useInvalidate } from '@/lib/session'
import type { Material, MaterialKind } from '@/lib/types'

export const kindMeta: Record<MaterialKind, { label: string; desc: string; tone: 'ink' | 'blue' | 'gamboge' | 'green' }> = {
  experience: { label: '经历', desc: '亲身经历、故事、见闻', tone: 'ink' },
  opinion: { label: '观点', desc: '你的判断和主张', tone: 'gamboge' },
  case: { label: '案例', desc: '可引用的他人案例', tone: 'blue' },
  data: { label: '数据', desc: '数字、研究结论（请注明来源）', tone: 'green' },
}

function MaterialDialog({ open, onClose, accountId, editing }: { open: boolean; onClose: () => void; accountId: string; editing: Material | null }) {
  const [kind, setKind] = useState<MaterialKind>(editing?.kind ?? 'experience')
  const [content, setContent] = useState(editing?.content ?? '')
  const [source, setSource] = useState(editing?.source ?? '')
  const [tags, setTags] = useState(editing?.tags.join(' ') ?? '')
  const [shared, setShared] = useState(editing ? editing.account_id === null : false)
  const [busy, setBusy] = useState(false)
  const inv = useInvalidate()
  const save = async () => {
    setBusy(true)
    const body = { account_id: shared ? null : accountId, kind, content, source, tags: tags.split(/[\s,，]+/).filter(Boolean) }
    try {
      if (editing) await patch(`/materials/${editing.id}`, body)
      else await post('/materials', body)
      inv(['materials'])
      toast.success(editing ? '已保存' : '已加入素材库')
      onClose()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onClose={onClose} title={editing ? '编辑素材' : '添加素材'} width="max-w-xl"
      footer={<><Button variant="ghost" onClick={onClose}>取消</Button><Button variant="primary" loading={busy} disabled={!content.trim()} onClick={save}>保存</Button></>}>
      <div className="space-y-4">
        <div className="grid grid-cols-4 gap-2">
          {(Object.keys(kindMeta) as MaterialKind[]).map((k) => (
            <button key={k} type="button" onClick={() => setKind(k)}
              className={cn('cursor-pointer rounded-lg border px-2 py-2 text-left transition', kind === k ? 'border-ink-400 bg-ink-50 ring-3 ring-ink-100' : 'border-mist-200 hover:border-mist-300')}>
              <div className="text-[13.5px] font-semibold text-mist-800">{kindMeta[k].label}</div>
              <div className="mt-0.5 text-[11px] leading-snug text-mist-500">{kindMeta[k].desc}</div>
            </button>
          ))}
        </div>
        <Field label="内容" required><Textarea autoFocus rows={5} value={content} onChange={(e) => setContent(e.target.value)} placeholder="写下具体的事实、经历或观点。AI 起草时只会引用你选中的素材。" /></Field>
        <Field label="来源" hint={kind === 'data' ? '数据类素材请写明出处，便于发布前核实' : undefined}><Input value={source} onChange={(e) => setSource(e.target.value)} placeholder="例如：2025 年某某报告第 3 页" /></Field>
        <Field label="标签"><Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="用空格分隔" /></Field>
        <label className="flex items-center gap-2 text-[13px] text-mist-600"><input type="checkbox" className="accent-ink-600" checked={shared} onChange={(e) => setShared(e.target.checked)} />共享素材（所有账号都能引用）</label>
      </div>
    </Dialog>
  )
}

export default function Materials() {
  const acc = useCurrentAccount()
  const [scope, setScope] = useState<'all' | 'account' | 'shared'>('all')
  const [kind, setKind] = useState<'' | MaterialKind>('')
  const [q, setQ] = useState('')
  const [dialog, setDialog] = useState<{ editing: Material | null } | null>(null)
  const inv = useInvalidate()
  const { data, isLoading } = useQuery({
    queryKey: ['materials', acc?.id, scope, q],
    queryFn: () => get<Material[]>(`/materials?account_id=${acc!.id}${scope !== 'all' ? `&scope=${scope}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`),
    enabled: !!acc,
  })
  if (!acc) return <PageLoading />
  const list = (data ?? []).filter((m) => !kind || m.kind === kind)
  const remove = async (m: Material) => {
    if (!(await confirm({ title: '删除这条素材？', desc: '已引用它的作品不受影响。删除后可在回收站恢复（30 天）。', confirmText: '删除', danger: true }))) return
    try {
      await del(`/materials/${m.id}`)
      inv(['materials'])
      toast.success('已移到回收站')
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  return (
    <div className="animate-fade-in">
      <PageHeader title="素材库" desc="AI 只把这里的内容当作事实来源。素材越具体，初稿越像你自己写的。"
        action={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setDialog({ editing: null })}>添加素材</Button>} />
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Tabs value={scope} onChange={setScope} items={[{ value: 'all', label: '全部' }, { value: 'account', label: '本账号' }, { value: 'shared', label: '共享' }]} />
        <Select value={kind} onChange={(e) => setKind(e.target.value as MaterialKind | '')} className="w-32">
          <option value="">全部类型</option>
          {(Object.keys(kindMeta) as MaterialKind[]).map((k) => <option key={k} value={k}>{kindMeta[k].label}</option>)}
        </Select>
        <div className="relative ml-auto w-72">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-mist-400" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索内容、来源、标签" className="pl-9" />
        </div>
      </div>
      {isLoading ? <PageLoading /> : list.length === 0 ? (
        <Card><Empty icon={<Library className="size-5" />} title={q || kind ? '没有符合条件的素材' : '素材库还是空的'}
          desc="把你的经历、观点、案例和数据存进来。写作时在编辑器里选中一段文字也可以直接存入素材库。"
          action={!q && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setDialog({ editing: null })}>添加第一条素材</Button>} /></Card>
      ) : (
        <div className="columns-1 gap-4 md:columns-2 xl:columns-3 2xl:columns-4">
          {list.map((m) => (
            <Card key={m.id} className="group mb-4 break-inside-avoid p-4">
              <div className="mb-2 flex items-center gap-2">
                <Badge tone={kindMeta[m.kind].tone}>{kindMeta[m.kind].label}</Badge>
                {m.account_id === null && <Badge>共享</Badge>}
                <span className="text-xs text-mist-400">{relTime(m.created_at)}</span>
                <div className="ml-auto flex opacity-0 transition group-hover:opacity-100">
                  <IconButton label="编辑" onClick={() => setDialog({ editing: m })}><Pencil className="size-3.5" /></IconButton>
                  <IconButton label="删除" className="hover:text-danger" onClick={() => remove(m)}><Trash2 className="size-3.5" /></IconButton>
                </div>
              </div>
              <p className="whitespace-pre-wrap text-[14px] leading-relaxed text-mist-700">{m.content}</p>
              {(m.source || m.tags.length > 0) && (
                <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-mist-100 pt-2.5 text-xs text-mist-400">
                  {m.source && <span className="mr-1">来源：{m.source}</span>}
                  {m.tags.map((t) => <span key={t} className="rounded bg-mist-100 px-1.5 py-0.5 text-mist-500">{t}</span>)}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
      {dialog && <MaterialDialog open onClose={() => setDialog(null)} accountId={acc.id} editing={dialog.editing} />}
    </div>
  )
}
