import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { FileText, Image, LoaderCircle, RotateCcw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button, Card, Notice } from '@/components/ui'
import type { AgentArtifactDetail, AgentArtifactPage, AgentArtifactSummary } from '@/lib/agent'
import { errorMessage, get } from '@/lib/api'

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function internalURL(value: string | undefined) {
  return value?.startsWith('/') && !value.startsWith('//') ? value : ''
}

function ArtifactPreview({ item }: { item: AgentArtifactDetail }) {
  const version = item.current_version
  if (!version) return <p className="text-sm text-mist-500">这个产物还没有可预览的版本。</p>
  if (!version.available) return <Notice tone="gamboge">来源已不可用，保留的产物记录仍可查看。</Notice>
  const content = record(version.content)
  const data = record(content.data)
  const candidates = Array.isArray(data.titles)
    ? data.titles.map((candidate) => record(candidate).text).filter((title): title is string => typeof title === 'string' && !!title.trim())
    : []
  const summary = typeof data.summary === 'string' ? data.summary : ''
  const imageURL = internalURL(version.image_url)
  const openURL = internalURL(version.open_url)

  return <div className="space-y-3">
    <div className="flex flex-wrap items-center gap-2 text-xs text-mist-500">
      <span>v{version.version}</span><span>·</span><span>{version.source_kind === 'g_tool' ? '受控工具结果' : version.source_kind === 'attachment' ? '本人上传图片' : version.source_kind}</span>
      <span>·</span><span>{new Date(version.created_at).toLocaleString('zh-CN')}</span>
    </div>
    {candidates.length > 0
      ? <div><h4 className="mb-2 text-xs font-semibold text-mist-600">标题候选</h4><ol className="space-y-2">{candidates.map((title, index) => <li key={`${index}:${title}`} className="rounded-lg border border-mist-200 bg-white px-3 py-2 text-sm leading-6 text-mist-800">{title}</li>)}</ol></div>
      : summary
        ? <div><h4 className="mb-2 text-xs font-semibold text-mist-600">摘要</h4><p className="whitespace-pre-wrap break-words text-sm leading-6 text-mist-800">{summary}</p></div>
        : imageURL
          ? <img src={imageURL} alt={item.artifact.title} className="max-h-96 max-w-full rounded-lg border border-mist-200 object-contain" />
          : <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-mist-50 p-3 text-xs leading-5 text-mist-700">{JSON.stringify(data, null, 2)}</pre>}
    {imageURL && candidates.length === 0 && !summary && <p className="flex items-center gap-1.5 text-xs text-mist-500"><Image className="size-3.5" />图片附件预览</p>}
    {openURL && <Link to={openURL} target="_blank" rel="noopener noreferrer" className="inline-flex text-sm text-ink-700 underline">打开来源作品</Link>}
    {version.object_revision && <p className="text-xs text-mist-500">来源当前修订：{version.object_revision}</p>}
  </div>
}

export function ArtifactPanel({ conversationID, updatedAt, compact = false }: { conversationID?: string; updatedAt?: string; compact?: boolean }) {
  const [selectedID, setSelectedID] = useState('')
  useEffect(() => setSelectedID(''), [conversationID])
  const list = useInfiniteQuery({
    queryKey: ['agent-artifacts', conversationID, updatedAt],
    queryFn: ({ pageParam }) => get<AgentArtifactPage>(`/agent/conversations/${conversationID}/artifacts?limit=30${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`),
    initialPageParam: '' as string,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    enabled: !!conversationID,
  })
  const items: AgentArtifactSummary[] = list.data?.pages.flatMap((page) => page.items) ?? []
  const artifactID = items.some((item) => item.id === selectedID) ? selectedID : items[0]?.id ?? ''
  const detail = useQuery({
    queryKey: ['agent-artifact', artifactID, updatedAt],
    queryFn: () => get<AgentArtifactDetail>(`/agent/artifacts/${artifactID}`),
    enabled: !!artifactID,
  })

  if (!conversationID) return <p className="text-sm text-mist-500">新建对话后，产物会显示在这里。</p>
  if (list.isLoading) return <p className="flex items-center gap-2 text-sm text-mist-500" role="status"><LoaderCircle className="size-4 animate-spin" />正在加载本对话产物…</p>
  if (list.isError) return <div className="space-y-2"><Notice tone="red">{errorMessage(list.error)}</Notice><Button size="sm" icon={<RotateCcw className="size-3.5" />} onClick={() => void list.refetch()}>重试</Button></div>
  if (!items.length) return <div className="rounded-lg border border-dashed border-mist-300 px-4 py-8 text-center"><FileText className="mx-auto size-5 text-mist-400" /><p className="mt-2 text-sm text-mist-600">本对话还没有可预览的产物</p><p className="mt-1 text-xs text-mist-400">受控工具结果和已发送图片会出现在这里。</p></div>

  return <div className={compact ? 'grid grid-cols-1 gap-4' : 'grid gap-4 xl:grid-cols-[minmax(150px,0.7fr)_minmax(0,1.3fr)]'}>
    <div className="space-y-2">
      <ul className="space-y-1" aria-label="本对话产物列表">{items.map((item) => <li key={item.id}>
        <button type="button" aria-current={artifactID === item.id ? 'true' : undefined} onClick={() => setSelectedID(item.id)} className={`w-full rounded-lg border px-3 py-2 text-left text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink-500 ${artifactID === item.id ? 'border-ink-300 bg-ink-50 text-ink-800' : 'border-mist-200 bg-white text-mist-700 hover:bg-mist-50'}`}>
          <span className="block font-medium">{item.title}</span><span className="mt-1 block text-xs text-mist-500">v{item.current_version} · {item.source_kind === 'g_tool' ? '工具生成' : item.source_kind === 'attachment' ? '上传图片' : item.source_kind || item.kind}</span>
        </button>
      </li>)}</ul>
      {list.hasNextPage && <Button type="button" size="sm" variant="ghost" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>加载更多</Button>}
    </div>
    <Card className="min-w-0 space-y-3 border border-mist-200 p-4">
      <div><h3 className="break-words text-sm font-semibold text-mist-800">{items.find((item) => item.id === artifactID)?.title}</h3><p className="mt-1 text-xs text-mist-500">只读预览 · 打开来源仍会按原业务权限检查</p></div>
      {detail.isLoading && <p className="flex items-center gap-2 text-sm text-mist-500" role="status"><LoaderCircle className="size-4 animate-spin" />正在读取版本…</p>}
      {detail.isError && <div className="space-y-2"><Notice tone="red">{errorMessage(detail.error)}</Notice><Button size="sm" icon={<RotateCcw className="size-3.5" />} onClick={() => void detail.refetch()}>重试</Button></div>}
      {detail.data && <ArtifactPreview item={detail.data} />}
    </Card>
  </div>
}
