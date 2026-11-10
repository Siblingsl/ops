import { useEffect, useRef, useState } from 'react'
import { AtSign, Bot, Bot as GoalIcon, CalendarClock, CircleDashed, Cpu, Paperclip, Plug, Plus, Sparkles, Users } from 'lucide-react'
import { IconButton } from '@/components/ui'

// DEV-AI27-07（W07）：统一添加菜单（27 §5.5/§5.10）。
// 只有一个添加入口；记忆/插件/并行/应用选择等未交付能力在此如实显示"未开放"并禁用，
// 不在输入台平铺常驻，也不伪造可用状态（红线：UI 不得伪造状态；语音按钮在 W16 前不展示）。

export type AddMenuAction =
  | 'attachment'
  | 'context_refs'
  | 'skill'
  | 'goal'
  | 'routine'
  | 'computer'

interface AddMenuItem {
  id: AddMenuAction | string
  label: string
  hint?: string
  disabled?: boolean
  icon: typeof Paperclip
}

export function AddMenu({
  disabled,
  onAction,
  attachmentsAtLimit,
  computerEnabled,
}: {
  disabled: boolean
  onAction: (action: AddMenuAction) => void
  attachmentsAtLimit: boolean
  computerEnabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const items: AddMenuItem[] = [
    { id: 'attachment', label: '上传附件', hint: '图片 / 文档资料', disabled: attachmentsAtLimit, icon: Paperclip },
    { id: 'context_refs', label: '引用资料（@）', hint: '作品 / 素材 / 选题', icon: AtSign },
    { id: 'skill', label: '请求技能（$）', hint: '已确认的技能', icon: Sparkles },
    { id: 'goal', label: '任务目标与整理', hint: '长任务与预算', icon: Bot },
    { id: 'routine', label: '例行任务', hint: '受限只读定时', icon: CalendarClock },
    // 以下能力按 27 文档 §11 分包交付；入口先如实占位，不显示为可用。
    { id: 'browser', label: 'Google Chrome 标签', hint: '未开放', disabled: true, icon: CircleDashed },
    { id: 'memory', label: '记忆', hint: '未开放', disabled: true, icon: GoalIcon },
    { id: 'plugins', label: '插件与工具', hint: '未开放', disabled: true, icon: Plug },
    { id: 'subagents', label: '并行协作', hint: '未开放', disabled: true, icon: Users },
    { id: 'computer', label: '应用选择', hint: computerEnabled ? '选择本机窗口' : '未开放', disabled: !computerEnabled, icon: Cpu },
  ]

  return <div className="desktop-agent-add-menu" ref={menuRef}>
    <IconButton
      label="添加"
      disabled={disabled}
      aria-haspopup="menu"
      aria-expanded={open}
      data-testid={ADD_MENU_TRIGGER_TESTID}
      onClick={() => setOpen((value) => !value)}
    ><Plus className="size-4" /></IconButton>
    {open && <div className="desktop-agent-add-menu-list" role="menu" aria-label="添加上下文与能力" data-testid={ADD_MENU_LIST_TESTID}>
      {items.map((item) => {
        const Icon = item.icon
        return <button
          key={item.id}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          onClick={() => { setOpen(false); if (!item.disabled) onAction(item.id as AddMenuAction) }}
        >
          <span className="desktop-agent-add-menu-icon"><Icon className="size-4" /></span>
          <span className="desktop-agent-add-menu-text">
            <span>{item.label}</span>
            {item.hint && <small>{item.hint}</small>}
          </span>
        </button>
      })}
    </div>}
  </div>
}

// 供测试与键盘路径复用：菜单按钮的稳定 testid。
export const ADD_MENU_TRIGGER_TESTID = 'desktop-agent-add-menu-trigger'
export const ADD_MENU_LIST_TESTID = 'desktop-agent-add-menu-list'
