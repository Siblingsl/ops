import { GitBranch, Images } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { Dialog } from '@/components/dialog'
import { Button, Notice, platformFormatLabel, platformLabel } from '@/components/ui'
import type { Work } from '@/lib/types'

// FR-CX-16：编排入口只解释「同稿产物 vs 跨平台派生」两种动作，每次只开一项。
// 不得提供一次创建多稿/多产物的入口。桌面独立实现，不 import web/。

export function FormOrchestrationDialog({
  open, onClose, work, onDerive,
}: {
  open: boolean
  onClose: () => void
  work: Work
  onDerive: () => void
}) {
  const nav = useNavigate()
  const cardsOk = work.platform === 'xhs' && work.content_format === 'image_note'
  const openCards = () => {
    onClose()
    const base = `/works/${work.id}`
    if (location.pathname !== base) nav(base)
    requestAnimationFrame(() => {
      document.getElementById('visual-plan')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }
  const openDerive = () => {
    onClose()
    onDerive()
  }
  return (
    <Dialog open={open} onClose={onClose} title="一稿多形态"
      desc="先分清两种动作：同作品导出产物不会新建稿；跨平台派生才会创建另一篇独立作品。每次只选一项。"
      footer={<Button variant="ghost" onClick={onClose}>关闭</Button>}>
      <div className="space-y-3" data-testid="form-orchestration">
        <Notice>
          当前作品：{platformLabel[work.platform]} · {platformFormatLabel(work.platform, work.content_format)}。
          选错账号不会自动改账号类型；漫画/卡片仍走专用编辑器。
        </Notice>
        <button type="button" data-testid="form-orch-cards" disabled={!cardsOk} onClick={openCards}
          className="flex w-full cursor-pointer items-start gap-3 rounded-xl border border-mist-200 p-3 text-left transition hover:border-ink-300 hover:bg-ink-50/40 disabled:cursor-not-allowed disabled:opacity-55">
          <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl bg-ink-50 text-ink-700"><Images className="size-4" /></span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-mist-900">本作品组图产物</span>
            <span className="mt-1 block text-[12px] leading-relaxed text-mist-500">
              走 xhs_cards 构建（options.cards）；不新建作品、不改 content_format。
              {cardsOk ? '将滚动到编辑器内的组图计划与交付入口。' : '仅小红书图文笔记可用；当前作品不适用。'}
            </span>
          </span>
        </button>
        <button type="button" data-testid="form-orch-derive" onClick={openDerive}
          className="flex w-full cursor-pointer items-start gap-3 rounded-xl border border-mist-200 p-3 text-left transition hover:border-ink-300 hover:bg-ink-50/40">
          <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl bg-ink-50 text-ink-700"><GitBranch className="size-4" /></span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-mist-900">跨平台派生独立稿</span>
            <span className="mt-1 block text-[12px] leading-relaxed text-mist-500">
              调用现有派生：每次只创建一篇目标平台作品，源稿正文与修订不变；同平台互转不可用。
            </span>
          </span>
        </button>
        <p className="text-[11px] leading-relaxed text-mist-500">不会一次生成多种形态；需要另一种产物或另一篇派生时，请再次打开本入口逐项选择。</p>
      </div>
    </Dialog>
  )
}
