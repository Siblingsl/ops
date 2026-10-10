import { useQuery } from '@tanstack/react-query'
import { RotateCcw, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { confirm } from '@/components/dialog'
import { Badge, Button, Card, cn, Empty, PageHeader, PageLoading, Tabs } from '@/components/ui'
import { del, errorMessage, get, post } from '@/lib/api'
import { fmtTime } from '@/lib/format'
import { useInvalidate } from '@/lib/session'

interface Item { type: 'work' | 'topic' | 'material' | 'style_sample' | 'character_card'; id: string; title: string; account_name: string | null; deleted_at: string; days_left: number }

const typeLabel: Record<Item['type'], string> = { work: '作品', topic: '选题', material: '素材', style_sample: '风格样本', character_card: '角色卡' }

export default function Trash() {
  const { data, isLoading, refetch } = useQuery({ queryKey: ['trash'], queryFn: () => get<Item[]>('/trash') })
  const [tab, setTab] = useState<'all' | Item['type']>('all')
  const inv = useInvalidate()
  if (isLoading) return <PageLoading />
  const all = data ?? []
  const list = all.filter((i) => tab === 'all' || i.type === tab)
  const restore = async (i: Item) => {
    try {
      await post(`/trash/${i.type}/${i.id}/restore`)
      toast.success(`已恢复${typeLabel[i.type]}`)
      refetch()
      inv(['works'], ['topics'], ['materials'], ['samples'], ['characters'])
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const purge = async (i: Item) => {
    if (!(await confirm({ title: '彻底删除？', desc: `「${i.title}」将被永久删除${i.type === 'work' ? '，包括图片文件和版本历史' : ''}，无法恢复。`, confirmText: '彻底删除', danger: true }))) return
    try {
      await del(`/trash/${i.type}/${i.id}?confirm=true`)
      refetch()
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const count = (t: Item['type']) => all.filter((i) => i.type === t).length
  return (
    <div className="animate-fade-in">
      <PageHeader title="回收站" desc="删除的内容保留 30 天，到期后自动彻底删除。" />
      <Tabs value={tab} onChange={setTab} className="mb-5" items={[
        { value: 'all', label: '全部', count: all.length },
        { value: 'work', label: '作品', count: count('work') },
        { value: 'topic', label: '选题', count: count('topic') },
        { value: 'material', label: '素材', count: count('material') },
        { value: 'style_sample', label: '风格样本', count: count('style_sample') },
        { value: 'character_card', label: '角色卡', count: count('character_card') },
      ]} />
      <Card>
        {list.length === 0 ? <Empty icon={<Trash2 className="size-5" />} title="回收站是空的" /> : (
          <ul className="divide-y divide-mist-100">
            {list.map((i) => (
              <li key={i.type + i.id} className="flex items-center gap-4 px-5 py-3">
                <Badge>{typeLabel[i.type]}</Badge>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] text-mist-800">{i.title}</div>
                  <div className="text-xs text-mist-400">{i.account_name ?? '共享'} · 删除于 {fmtTime(i.deleted_at)}</div>
                </div>
                <span className={cn('text-xs tabular-nums', i.days_left <= 3 ? 'font-medium text-danger' : 'text-mist-400')}>{i.days_left} 天后清除</span>
                <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} onClick={() => restore(i)}>恢复</Button>
                <Button size="sm" variant="ghost" className="text-danger hover:bg-orange-50" onClick={() => purge(i)}>彻底删除</Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}
