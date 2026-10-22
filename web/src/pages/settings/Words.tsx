import { useQuery } from '@tanstack/react-query'
import { Plus, Search, X } from 'lucide-react'
import { useState } from 'react'
import { useEmbeddedSettings, useSettingsDraft } from '@/lib/desktop-settings'
import { toast } from 'sonner'
import { Badge, Button, Card, CardHeader, Field, Input, Notice, PageHeader, PageLoading, Tabs, Textarea } from '@/components/ui'
import { del, errorMessage, get, post } from '@/lib/api'
import { useCanWrite } from '@/lib/session'

interface Word { id: string; word: string; category: string; source: 'base' | 'custom'; created_at: string }

export default function Words() {
  const { data, isLoading, refetch } = useQuery({ queryKey: ['words'], queryFn: () => get<Word[]>('/sensitive-words') })
  const [tab, setTab] = useState<'custom' | 'base'>('custom')
  const [text, setText] = useState('')
  const [category, setCategory] = useState('')
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const embedded = useEmbeddedSettings()
  const canWrite = useCanWrite()
  useSettingsDraft(!!(text.trim() || category.trim()), busy)
  if (isLoading) return <PageLoading />
  const list = (data ?? []).filter((w) => w.source === tab && (!q || w.word.includes(q)))
  const add = async () => {
    setBusy(true)
    try {
      const r = await post<{ added: number; skipped: number }>('/sensitive-words', { words: text.split(/[\n,，、\s]+/).filter(Boolean), category })
      toast.success(`已添加 ${r.added} 个${r.skipped ? `，${r.skipped} 个已存在` : ''}`)
      setText('')
      if (embedded) setCategory('')
      refetch()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const remove = async (w: Word) => {
    await del(`/sensitive-words/${w.id}`).catch((e) => toast.error(errorMessage(e)))
    refetch()
  }
  return (
    <div className="animate-fade-in">
      <PageHeader title="敏感词库" desc="发布前检查会逐条标出命中的词，由你决定修改还是保留。账号专属的禁用词在「账号档案」中维护。" />
      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <Card>
          <CardHeader title={<Tabs value={tab} onChange={setTab} className="[&>button]:shrink-0 [&>button]:whitespace-nowrap" items={[
            { value: 'custom', label: '自定义词库', count: (data ?? []).filter((w) => w.source === 'custom').length },
            { value: 'base', label: '通用词库（只读）', count: (data ?? []).filter((w) => w.source === 'base').length },
          ]} />} action={
            <div className="relative w-40">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-mist-400" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索" className="h-8 pl-8 text-[13px]" />
            </div>
          } />
          <div className="flex flex-wrap gap-2 p-5">
            {list.length === 0 && <p className="py-6 text-[13px] text-mist-400">{tab === 'custom' ? '还没有自定义敏感词。' : '没有匹配的词。'}</p>}
            {list.map((w) => (
              <span key={w.id} className="inline-flex items-center gap-1 rounded-md border border-mist-200 bg-white py-1 pl-2.5 pr-1 text-[13px] text-mist-700">
                {w.word}
                {w.category && <Badge className="ml-1">{w.category}</Badge>}
                {w.source === 'custom' ? (
                  canWrite
                    ? <button onClick={() => remove(w)} className="cursor-pointer rounded p-0.5 text-mist-400 hover:bg-mist-100 hover:text-danger" aria-label="删除"><X className="size-3" /></button>
                    : <span className="w-1" />
                ) : <span className="w-1" />}
              </span>
            ))}
          </div>
        </Card>
        <Card className="h-fit p-5">
          <h3 className="mb-4 text-[15px] font-semibold text-mist-900">添加自定义词</h3>
          {canWrite ? <div className="space-y-4">
            <Field label="敏感词" hint="一行一个，或用逗号分隔"><Textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} /></Field>
            <Field label="分类（可选）"><Input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="例如：医疗、金融" /></Field>
            <Button variant="primary" className="w-full" loading={busy} disabled={!text.trim()} onClick={add} icon={<Plus className="size-4" />}>添加</Button>
          </div> : <Notice>你是观察者，只能查看；敏感词由所有者或编辑者维护。</Notice>}
        </Card>
      </div>
    </div>
  )
}
