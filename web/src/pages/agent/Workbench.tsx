import { Dialog, Drawer } from '@/components/dialog'
import {
  type AgentBootstrap, type AgentConversation, type AgentConversationDetail,
} from '@/lib/agent'
import { ArtifactPanel } from '@/pages/agent/ArtifactPanel'
import { GoalPanel } from '@/pages/agent/GoalPanel'
import { RoutinePanel } from '@/pages/agent/RoutinePanel'
import type { AgentContextSelection } from '@/pages/agent/ContextPickers'

export function AgentWorkbenchPanels({
  goalPanelOpen, setGoalPanelOpen,
  routinePanelOpen, setRoutinePanelOpen,
  artifactsOpen, setArtifactsOpen,
  conversation, detail, bootstrapData,
  goalsEnabled, routinesEnabled, eventResumeEnabled,
  canManageGoals, canManageRoutines,
  busy, compactRun, quoteArtifact,
}: {
  goalPanelOpen: boolean
  setGoalPanelOpen: (open: boolean) => void
  routinePanelOpen: boolean
  setRoutinePanelOpen: (open: boolean) => void
  artifactsOpen: boolean
  setArtifactsOpen: (open: boolean) => void
  conversation: AgentConversation | undefined
  detail: AgentConversationDetail | undefined
  bootstrapData: AgentBootstrap
  goalsEnabled: boolean
  routinesEnabled: boolean
  eventResumeEnabled: boolean
  canManageGoals: boolean
  canManageRoutines: boolean
  busy: boolean
  compactRun: () => Promise<boolean>
  quoteArtifact: (reference: AgentContextSelection, prompt: string) => void
}) {
  return (
    <>
      <Dialog open={goalPanelOpen} onClose={() => setGoalPanelOpen(false)} title="任务目标与上下文整理" desc="目标推进仍受账号权限、运行预算和逐张操作卡片确认约束。" width="max-w-2xl">
        <GoalPanel conversationID={conversation?.id} conversation={conversation} goal={detail?.goal} models={bootstrapData.models} goalsEnabled={goalsEnabled} compactEnabled={eventResumeEnabled} canManage={canManageGoals} busy={busy} onCompact={compactRun} />
      </Dialog>

      {routinesEnabled && <Dialog open={routinePanelOpen} onClose={() => setRoutinePanelOpen(false)} title="受限例行任务" desc="按计划只读查询运营数据，逐次生成私有报告；权限在执行时重新检查。" width="max-w-3xl">
        <RoutinePanel open={routinePanelOpen} canManage={canManageRoutines} models={bootstrapData.models} conversation={conversation} />
      </Dialog>}

      {bootstrapData.features.artifacts === true && <Drawer open={artifactsOpen} onClose={() => setArtifactsOpen(false)} title="本对话产物" width="w-[min(92vw,920px)]">
        <ArtifactPanel conversationID={conversation?.id} onQuote={quoteArtifact} />
        {/* DEV-AI27-11（A11）：Web 端无本机浏览会话，历史浏览器证据不在此展示——如实降级，不伪造内容。 */}
        <div className="mt-4 rounded-lg border border-dashed border-mist-200 bg-mist-50 px-4 py-3 text-xs text-mist-500" data-testid="web-sources-desktop-only">
          浏览器来源证据与批注记录仅在 OPS 桌面端展示（Web 端没有本机浏览会话）。桌面端打开同一对话即可查看可回查的来源列表。
        </div>
      </Drawer>}
    </>
  )
}
