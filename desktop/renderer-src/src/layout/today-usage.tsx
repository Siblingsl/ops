import { useQuery } from '@tanstack/react-query'
import { Gauge } from 'lucide-react'
import { useMemo } from 'react'
import { useCurrentAccount } from '@/lib/session'
import { useLocation, useNavigate } from 'react-router-dom'
import { get } from '@/lib/api'
import { fmtNum } from '@/lib/format'
import { settingsEntryFor } from '@/lib/settings-registry'
import type { AIStatus } from '@/lib/v3'

export function TodayUsage({ enabled }: { enabled: boolean }) {
  const navigate = useNavigate()
  const q = useQuery({ queryKey: ['ai-status'], queryFn: () => get<AIStatus>('/ai/status'), enabled, staleTime: 60_000 })
  return (
    <button
      type="button"
      onClick={() => navigate('/settings/usage')}
      className="hidden h-9 cursor-pointer items-center gap-1.5 rounded-full border border-mist-200 bg-white px-3 text-[12.5px] text-mist-600 transition hover:border-mist-300 hover:text-mist-800 xl:inline-flex"
      title="查看 AI 用量"
    >
      <Gauge className="size-3.5 text-ink-600" />
      {q.data ? <>今日 {fmtNum(q.data.tokens_today)} token</> : 'AI 用量'}
    </button>
  )
}

// GL-02：设置页标题同样来自 settings-registry，桌面专属项也能显示正确名称。
export function useChromeMeta() {
  const loc = useLocation()
  const acc = useCurrentAccount()
  return useMemo(() => {
    const path = loc.pathname
    if (path.startsWith('/settings/')) {
      const hit = settingsEntryFor(path)
      return { crumb: '设置', title: hit?.label ?? '设置' }
    }
    if (path.startsWith('/agent')) return { crumb: acc?.name ?? '工作区', title: 'AI 对话' }
    if (path.startsWith('/works/')) return { crumb: acc?.name ?? '作品', title: '创作中' }
    if (path.startsWith('/search')) return { crumb: '工作区', title: '搜索' }
    if (path.startsWith('/images')) return { crumb: '工作区', title: '图片库' }
    if (!acc) return { crumb: '运助', title: '选择账号' }
    const map: { test: RegExp; title: string }[] = [
      { test: /\/topics$/, title: '选题池' },
      { test: /\/ops$/, title: '账号运营' },
      { test: /\/calendar$/, title: '内容日历' },
      { test: /\/works$/, title: '作品' },
      { test: /\/materials$/, title: '素材库' },
      { test: /\/review$/, title: '数据复盘' },
      { test: /\/profile$/, title: '账号档案' },
      { test: /\/a\/[^/]+$/, title: '工作台' },
    ]
    return { crumb: acc.name, title: map.find((m) => m.test.test(path))?.title ?? '工作台' }
  }, [loc.pathname, acc])
}
