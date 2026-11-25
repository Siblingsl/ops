import { useQuery } from '@tanstack/react-query'
import { get } from '@/lib/api'

/** `/desktop/capabilities` 中与本任务相关的只读片段；旧服务端可能完全没有这些字段。 */
export type DesktopCapabilitiesResponse = {
  platform_collection?: {
    enabled?: boolean
    disabled_reason?: string
    disabled_hint?: string
  }
}

export const DEFAULT_PLATFORM_DISABLED_HINT = '服务端未开启 OPS_DESKTOP_PLATFORM_ENABLED=1，本机自动采集与状态心跳已暂停'

/** 仅在服务端明确回报 enabled === false 时给出原因；未加载或字段缺失一律不误报。 */
export function getPlatformCollectionDisabledInfo(caps?: DesktopCapabilitiesResponse | null): { reason: string; hint: string } | null {
  const collection = caps?.platform_collection
  if (!collection || collection.enabled !== false) return null
  return {
    reason: (collection.disabled_reason ?? '').trim() || 'server_disabled',
    hint: (collection.disabled_hint ?? '').trim() || DEFAULT_PLATFORM_DISABLED_HINT,
  }
}

/** 桌面端共享的只读能力查询：账号连接卡与偏好设置共用同一个缓存键。 */
export function useDesktopCapabilities(enabled: boolean) {
  return useQuery({
    queryKey: ['desktop-capabilities'],
    queryFn: () => get<DesktopCapabilitiesResponse>('/desktop/capabilities'),
    enabled,
    staleTime: 60_000,
    retry: false,
  })
}
