import { useInfiniteQuery } from '@tanstack/react-query'
import { ScrollText } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Button, Card, Empty, PageHeader, PageLoading, Select } from '@/components/ui'
import { BackToSettings } from '@/components/back-to-settings'
import { get } from '@/lib/api'
import { fmtTime } from '@/lib/format'

interface Log { id: string; action: string; target_type: string; target_id: string; result: string; detail: unknown; created_at: string; actor: string | null }

const actionLabels: Record<string, string> = {
  setup: '首次设置', login: '登录', login_failed: '登录失败', logout: '退出登录', reauth: '敏感操作验证密码',
  password_change: '修改密码', password_reset: '重置密码',
  account_create: '添加账号', account_update: '修改账号', account_disabled: '停用账号', account_active: '启用账号',
  credential_update: '保存公众号凭证', wechat_credential_test: '检测公众号凭证',
  work_create: '新建作品', outline_confirm: '确认大纲', work_derive: '派生作品',
  wechat_push: '写入公众号草稿', xhs_pack: '生成发布包', mark_published: '回填已发布',
  check_resolve: '确认检查项', check_complete: '完成检查', review_adopt: '采纳复盘建议',
  model_provider_create: '添加模型供应商', model_provider_update: '修改模型供应商', model_provider_delete: '删除模型供应商', model_routes_update: '修改任务路由',
  settings_update: '修改设置', trash_restore: '从回收站恢复', trash_purge: '彻底删除', trash_expire: '回收站到期清理',
  agent_settings_update: '修改智能体设置',
  work_update: '修改作品', work_unlock: '解锁已发布作品', work_delete: '删除作品',
}

const filters = [
  { value: '', label: '全部操作' },
  { value: 'login', label: '登录' },
  { value: 'wechat_', label: '公众号' },
  { value: 'check_', label: '发布前检查' },
  { value: 'model_', label: '模型配置' },
  { value: 'account_', label: '账号' },
  { value: 'trash_', label: '回收站' },
]

/** 日志对象可点开（ST-09）：只对确实存在的业务对象给出跳转，其余保持纯文本。 */
const targetLinks: Record<string, (id: string) => string | null> = {
  work: (id) => `/works/${id}`,
  platform_account: (id) => `/settings/accounts?id=${encodeURIComponent(id)}`,
  topic: () => '/topics',
  account_memory: () => '/a',
}

export default function Logs() {
  const [action, setAction] = useState('')
  const q = useInfiniteQuery({
    queryKey: ['logs', action],
    queryFn: ({ pageParam }) => get<Log[]>(`/audit-logs?limit=50${action ? `&action=${action}` : ''}${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ''}`),
    initialPageParam: '',
    getNextPageParam: (last) => (last.length === 50 ? last[last.length - 1].created_at : undefined),
  })
  if (q.isLoading) return <PageLoading />
  const list = q.data?.pages.flat() ?? []
  return (
    <div className="animate-fade-in">
      <PageHeader title="操作日志" desc="登录、凭证、推送、检查确认等关键操作都会记录。日志中不包含密钥和正文。"
        action={<><BackToSettings /><Select value={action} onChange={(e) => setAction(e.target.value)} className="w-40">{filters.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}</Select></>} />
      <Card>
        {list.length === 0 ? <Empty icon={<ScrollText className="size-5" />} title="没有日志" /> : (
          <ul className="divide-y divide-mist-100">
            {list.map((l) => (
              <li key={l.id} className="flex items-start gap-4 px-5 py-3">
                <span className="w-32 shrink-0 pt-0.5 text-xs tabular-nums text-mist-400">{fmtTime(l.created_at, true)}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[13.5px] font-medium text-mist-800">{actionLabels[l.action] ?? l.action}</span>
                    {l.detail != null && typeof l.detail === 'object' && 'via_agent' in l.detail && l.detail.via_agent === true && <Badge tone="ink">来自智能体</Badge>}
                    {l.result !== 'ok' && <Badge tone="red">{l.result === 'failed' ? '失败' : l.result}</Badge>}
                  </div>
                  {l.detail != null && JSON.stringify(l.detail) !== '{}' && JSON.stringify(l.detail) !== 'null' && (
                    <div className="mt-0.5 truncate font-mono text-[11.5px] text-mist-400">{JSON.stringify(l.detail)}</div>
                  )}
                  {l.target_id && targetLinks[l.target_type]?.(l.target_id) && (
                    <Link to={targetLinks[l.target_type]!(l.target_id)!} className="mt-1 inline-block text-[11.5px] text-ink-600 hover:underline">查看对象 ↗</Link>
                  )}
                </div>
                <span className="shrink-0 text-xs text-mist-400">{l.actor ?? '系统'}</span>
              </li>
            ))}
          </ul>
        )}
        {q.hasNextPage && <div className="border-t border-mist-100 p-3 text-center"><Button size="sm" variant="ghost" loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>加载更多</Button></div>}
      </Card>
    </div>
  )
}
