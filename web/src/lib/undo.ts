import { toast } from 'sonner'
import { del, errorMessage, post } from './api'

type TrashType = 'work' | 'topic' | 'material'

const paths: Record<TrashType, string> = { work: '/works/', topic: '/topics/', material: '/materials/' }

/** deleteWithUndo moves an item to the trash without a confirm dialog and offers a 10-second undo (10 文档 4.3). */
export async function deleteWithUndo(type: TrashType, id: string, label: string, onChange: () => void, note?: string) {
  try {
    await del(paths[type] + id)
  } catch (e) {
    toast.error(errorMessage(e))
    return
  }
  onChange()
  toast(`已删除${label}`, {
    description: note ? `${note} 也可以稍后在回收站恢复。` : '也可以稍后在回收站恢复（保留 30 天）。',
    duration: 10_000,
    action: {
      label: '撤销',
      onClick: async () => {
        try {
          await post(`/trash/${type}/${id}/restore`)
          onChange()
          toast.success('已恢复')
        } catch (e) {
          toast.error(errorMessage(e))
        }
      },
    },
  })
}
