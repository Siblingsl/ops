import { PageHeader } from '@/components/ui'
import { CapabilityList } from '@/pages/agent/CapabilityList'

// FN-06：设置内只读能力清单（不新增一级导航）。
export default function CapabilitiesSettings() {
  return <div className="mx-auto w-full max-w-5xl px-4 py-8">
    <PageHeader title="智能体能力" desc="按业务域列出智能体能做什么、需要什么权限、当前是否可用。能力由工作区设置与你的角色决定；不可用的能力在对话中也不会执行。" />
    <CapabilityList />
  </div>
}
