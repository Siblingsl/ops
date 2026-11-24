import { useEffect, useRef, useState } from 'react'
import { Activity, AtSign, Bot, Cpu, Library, ListChecks, MessageSquarePlus, Paperclip, Plug, Plus, Sparkles, Users } from 'lucide-react'
import { IconButton } from '@/components/ui'

// DEV-AI27-07（W07）：统一添加菜单（27 §5.5/§5.10）。
// D-224（OPT-S02）：冻结能力不再以灰色禁用占位常驻；对应后端开关显式为 true 时才出现入口，
// 默认关闭时整个入口不渲染，也不伪造可用状态（红线：UI 不得伪造状态）。

export type AddMenuAction =
  | 'attachment'
  | 'context_refs'
  | 'side_chat'
  | 'operations_directory'
  | 'today_ops'
  | 'skill'
  | 'goal'
  | 'routine'
  | 'plugins'
  | 'subagents'
  | 'computer'
  | 'capabilities'
  | 'workflow_templates'

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
  operationsDirectoryEnabled,
  todayOpsEnabled,
  sideChatEnabled,
  pluginsEnabled,
  subagentsEnabled,
  workflowTemplatesEnabled,
}: {
  disabled: boolean
  onAction: (action: AddMenuAction) => void
  attachmentsAtLimit: boolean
  computerEnabled?: boolean
  operationsDirectoryEnabled?: boolean
  todayOpsEnabled?: boolean
  sideChatEnabled?: boolean
  pluginsEnabled?: boolean
  subagentsEnabled?: boolean
  workflowTemplatesEnabled?: boolean
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
    ...(sideChatEnabled ? [{ id: 'side_chat' as const, label: '旁问', hint: '独立只读会话，继承当前上下文', icon: MessageSquarePlus }] : []),
    ...(operationsDirectoryEnabled ? [{ id: 'operations_directory' as const, label: '运营目录', hint: '作品 / 选题 / 素材 / 图片 / 日历', icon: Library }] : []),
    ...(todayOpsEnabled ? [{ id: 'today_ops' as const, label: '今日运营', hint: '六块只读运营摘要', icon: Activity }] : []),
    { id: 'skill', label: '请求技能（$）', hint: '已确认的技能', icon: Sparkles },
    // REF41 A7：工作流模板（启动只建计划，逐步确认执行）。
    ...(workflowTemplatesEnabled ? [{ id: 'workflow_templates' as const, label: '工作流模板', hint: '内置三模板；启动只建计划', icon: ListChecks }] : []),
    { id: 'goal', label: '任务目标与整理', hint: '长任务与预算', icon: Bot },
    // D-224（OPT-S02）：冻结能力仅在对应后端开关显式为 true 时展示；默认关闭时不出入口，不渲染灰色禁用占位。
    ...(pluginsEnabled ? [{ id: 'plugins' as const, label: '插件与工具', hint: '外部 MCP 连接与工具', icon: Plug }] : []),
    ...(subagentsEnabled ? [{ id: 'subagents' as const, label: '并行协作', hint: '本次任务允许拆成 2 个只读子任务', icon: Users }] : []),
    ...(computerEnabled ? [{ id: 'computer' as const, label: '应用选择', hint: '选择本机窗口', icon: Cpu }] : []),
    // FN-06：只读能力清单入口（38 卡片：输入台 + 菜单“能力”；只读，不新增一级导航）。
    { id: 'capabilities', label: '能力', hint: '这个智能体能做什么', icon: ListChecks },
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
