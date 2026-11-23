import { useQuery } from '@tanstack/react-query'
import { get } from '@/lib/api'
import { Card, PageState } from '@/components/ui'

// FN-06（docs/38 §12）：只读能力清单——按业务域列出“能做什么、需要什么权限、当前是否可用”。
// 数据来自 GET /agent/capabilities（TL-01 只读投影，无 path/method/params）。
// 供设置页（/settings/capabilities）与对话页“能力”Dialog 共用。

type CapabilityTool = { name: string; label: string; kind: string; min_role: string; gates?: string[]; available: boolean }
type CapabilityDomain = { key: string; label: string; description?: string; tools: CapabilityTool[] }
type ExternalCall = { state: string; error_code?: string; duration_ms: number; at: string }
type ExternalTool = {
  tool_name: string
  label: string
  kind: string
  min_role: string
  permission: string
  available: boolean
  connection_id: string
  connection_name: string
  transport: string
  server_name?: string
  server_version?: string
  protocol_version?: string
  catalog_revision?: string
  last_call?: ExternalCall
}
type CapabilityResponse = {
  domains: CapabilityDomain[]
  external_tools?: { enabled: boolean; tools: ExternalTool[] }
}

const kindLabel: Record<string, string> = { R: '读取', G: '生成', W: '写入', H: '人工确认', X: '不可逆' }
const roleLabel: Record<string, string> = { viewer: '观察者', editor: '编辑', owner: '所有者' }
const gateLabel: Record<string, string> = { second_confirm: '二次确认' }
const callStateLabel: Record<string, string> = {
  dispatched: '派发中', succeeded: '成功', failed: '失败', cancelled: '已取消', unknown_outcome: '结果未知',
}
const transportLabel: Record<string, string> = { stdio: '本机进程', http: 'HTTP' }

function callTime(at: string): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return at
  return date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function CapabilityList() {
  const query = useQuery({
    queryKey: ['agent-capabilities'],
    queryFn: () => get<CapabilityResponse>('/agent/capabilities'),
    staleTime: 60_000,
  })

  if (query.isLoading) return <PageState loading onRetry={() => void query.refetch()} />
  if (query.isError) return <PageState loading={false} error onRetry={() => void query.refetch()} emptyTitle="能力目录加载失败，点击重试" />
  const domains = query.data?.domains ?? []
  const external = query.data?.external_tools
  return <div className="space-y-4">
    {domains.map((domain) => <Card key={domain.key} className="p-4">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-mist-800">{domain.label}</h3>
        <span className="text-xs text-mist-500">{domain.description}</span>
      </div>
      <ul className="grid gap-2 sm:grid-cols-2">
        {domain.tools.map((tool) => <li key={tool.name} className={`rounded-lg border p-2.5 text-xs ${tool.available ? 'border-mist-200' : 'border-mist-200 opacity-55'}`}>
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-mist-700">{tool.label}</span>
            <span className={tool.available ? 'text-[color:var(--color-success)]' : 'text-mist-400'}>{tool.available ? '可用' : '不可用'}</span>
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5 text-mist-500">
            <span className="rounded border border-mist-200 bg-mist-50 px-1.5 py-px">{kindLabel[tool.kind] ?? tool.kind}</span>
            <span className="rounded border border-mist-200 bg-mist-50 px-1.5 py-px">需 {roleLabel[tool.min_role] ?? tool.min_role}</span>
            {(tool.gates ?? []).map((gate) => <span key={gate} className="rounded border border-gamboge-200 bg-gamboge-50 px-1.5 py-px text-gamboge-700">{gateLabel[gate] ?? gate}</span>)}
          </div>
        </li>)}
      </ul>
    </Card>)}
    {/* TL-05（38 §14）：plugin_mcp 开启时能力中心单列外部工具；仅投影已启用连接中
        通过目录与参数 schema 校验的工具。来源只展示连接/传输/服务器，权限与最近调用
        来自调用台账（不含入参/结果）。关闭时接口不返回该区。 */}
    {external?.enabled && <Card className="p-4" data-testid="agent-external-tools">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-mist-800">外部工具</h3>
        <span className="text-xs text-mist-500">默认关闭 · 已启用 MCP 连接</span>
      </div>
      <p className="mb-2 text-xs text-mist-500">只展示通过目录与参数 schema 校验的白名单工具；来源不含命令、地址或密钥。</p>
      {external.tools.length === 0
        ? <div className="rounded-lg border border-dashed border-mist-200 p-3 text-xs text-mist-500">还没有已启用的外部工具连接。</div>
        : <ul className="grid gap-2 sm:grid-cols-2">
          {external.tools.map((tool) => <li key={`${tool.connection_id}:${tool.tool_name}`} className={`rounded-lg border p-2.5 text-xs ${tool.available ? 'border-mist-200' : 'border-mist-200 opacity-55'}`} data-testid="agent-external-tool">
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate font-medium text-mist-700">{tool.label}</span>
              <span className={tool.available ? 'text-[color:var(--color-success)]' : 'text-mist-400'}>{tool.available ? '可用' : '不可用'}</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-1.5 text-mist-500">
              <span className="rounded border border-mist-200 bg-mist-50 px-1.5 py-px">外部</span>
              <span className="rounded border border-mist-200 bg-mist-50 px-1.5 py-px">{kindLabel[tool.kind] ?? tool.kind}</span>
              <span className="rounded border border-mist-200 bg-mist-50 px-1.5 py-px">需 {roleLabel[tool.min_role] ?? tool.min_role}</span>
            </div>
            <div className="mt-1.5 space-y-0.5 text-mist-500">
              <p>来源：{tool.connection_name} · {transportLabel[tool.transport] ?? tool.transport}{tool.server_name ? ` · ${tool.server_name}${tool.server_version ? ` v${tool.server_version}` : ''}` : ''}</p>
              <p>权限：{tool.permission}</p>
              <p>{tool.last_call
                ? `最近调用：${callStateLabel[tool.last_call.state] ?? tool.last_call.state} · ${tool.last_call.duration_ms}ms · ${callTime(tool.last_call.at)}${tool.last_call.error_code ? ` · ${tool.last_call.error_code}` : ''}`
                : '最近调用：尚无调用记录'}</p>
            </div>
          </li>)}
        </ul>}
    </Card>}
  </div>
}
