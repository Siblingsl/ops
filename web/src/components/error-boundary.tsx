import { AlertTriangle } from 'lucide-react'
import React from 'react'
import { post } from '@/lib/api'
import { Button } from './ui'

/** ErrorBoundary keeps one broken page from blanking the whole app (EX-N-03). Unsaved text stays in local drafts. */
export class ErrorBoundary extends React.Component<{ children: React.ReactNode; resetKey?: string; where?: string }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidUpdate(prev: { resetKey?: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null })
  }

  componentDidCatch(error: Error) {
    console.error('页面渲染出错', error)
    void post('/client-errors', { message: `${error.name}: ${error.message}`, path: location.pathname, where: this.props.where ?? 'page' }).catch(() => undefined)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="mx-auto mt-16 max-w-md rounded-2xl border border-orange-200 bg-orange-50/60 p-6 text-center">
        <AlertTriangle className="mx-auto mb-3 size-8 text-orange-500" />
        <p className="font-display text-[17px] font-semibold text-mist-900">这块出了问题，你的内容已保存</p>
        <p className="mt-1.5 text-[13px] leading-relaxed text-mist-600">
          正文会自动保存，未同步的修改也暂存在本机。可以重新加载这个区域，或回到工作台。
        </p>
        <p className="mt-2 break-all font-mono text-[11px] text-mist-400">{this.state.error.message}</p>
        <div className="mt-4 flex justify-center gap-2">
          <Button variant="ghost" onClick={() => location.assign('/')}>回到工作台</Button>
          <Button variant="primary" onClick={() => this.setState({ error: null })}>重新加载此区域</Button>
        </div>
      </div>
    )
  }
}

export function Skeleton({ className = 'h-4 w-full' }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-mist-100 ${className}`} />
}

export function PageSkeleton() {
  return (
    <div className="space-y-4 py-2">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-4 w-80" />
      <div className="grid gap-4 md:grid-cols-3">
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
      </div>
      <Skeleton className="h-64" />
    </div>
  )
}
