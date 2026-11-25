import { useNavigate } from 'react-router-dom'
import { Dialog } from '@/components/dialog'
import { Button, Notice } from '@/components/ui'
import type { HotSourceIssue } from '@/lib/types'

const issueTone: Record<string, string> = {
  rate_or_quota: '搜索额度耗尽或限流',
  blocked: '被目标站拒绝',
  unreachable: '暂时不可达',
}

export function issueLabel(code: string): string {
  return issueTone[code] ?? '采集异常'
}

/**
 * 热点来源异常时的统一降级弹窗：讲清原因，并一键直达可手动粘贴正文的位置。
 * 只读展示，不触发任何采集请求。
 */
export function HotFallbackDialog({
  open,
  onClose,
  issues,
  accountId,
}: {
  open: boolean
  onClose: () => void
  issues: HotSourceIssue[]
  accountId?: string | null
}) {
  const navigate = useNavigate()
  const pasteReference = () => {
    onClose()
    navigate(accountId ? `/a/${accountId}/ops?tab=references&paste=1` : '/ops')
  }
  const goTopics = () => {
    onClose()
    if (accountId) navigate(`/a/${accountId}/topics?hot=1`)
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="热点来源暂时不可用"
      desc="公开来源被限制或搜索额度耗尽时，可以手动粘贴一篇原文，继续提炼选题与写法。"
      width="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            关闭
          </Button>
          {accountId && (
            <Button variant="secondary" onClick={goTopics}>
              去选题池粘贴资讯
            </Button>
          )}
          <Button variant="human" data-testid="hot-fallback-paste-reference-btn" onClick={pasteReference}>
            点击手动粘贴文章全文作为参考
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {issues.length === 0 ? (
          <Notice tone="gamboge">本次请求没有返回可用的热点来源，请稍后重试或直接手动粘贴原文。</Notice>
        ) : (
          issues.map((issue) => (
            <div key={`${issue.key}:${issue.code}:${issue.error}`} className="space-y-1 rounded-lg border border-mist-200 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <strong>{issue.name}</strong>
                <span className="rounded bg-gamboge-50 px-2 py-0.5 text-xs text-gamboge-800">{issueLabel(issue.code)}</span>
              </div>
              <p className="text-mist-600">{issue.reason}</p>
              {issue.error && (
              <p className="break-words text-xs text-mist-500">
                原始错误：{issue.error.length > 200 ? `${issue.error.slice(0, 200)}…` : issue.error}
              </p>
            )}
              {issue.paused_until && (
                <p className="text-xs text-mist-500">暂停至 {new Date(issue.paused_until).toLocaleString('zh-CN')}</p>
              )}
            </div>
          ))
        )}
      </div>
    </Dialog>
  )
}
