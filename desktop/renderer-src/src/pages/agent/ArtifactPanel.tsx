import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, Download, FileText, GitCompare, Image, LoaderCircle, MessageSquareQuote, RotateCcw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { Button, Card, Notice, Select, Textarea } from '@/components/ui'
import type { AgentArtifactDetail, AgentArtifactPage, AgentArtifactSummary, AgentArtifactVersion } from '@/lib/agent'
import { errorMessage, get, post, rawRequest } from '@/lib/api'
import { assetUrl } from '@/lib/api-base'
import type { AgentContextSelection } from '@/pages/agent/ContextPickers'

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function internalURL(value: string | undefined) {
  return value?.startsWith('/') && !value.startsWith('//') ? value : ''
}

function versionText(version: AgentArtifactVersion | null | undefined) {
  const content = record(version?.content)
  return content.format === 'text' && typeof content.text === 'string' ? content.text : ''
}

function ArtifactPreview({ item, version, onQuote }: { item: AgentArtifactDetail; version: AgentArtifactVersion; onQuote: (ref: AgentContextSelection, prompt: string) => void }) {
  const [downloading, setDownloading] = useState<string | null>(null)
  const [visibleRows, setVisibleRows] = useState(50)
  useEffect(() => setVisibleRows(50), [version.id])
  if (!version.available) return <Notice tone="gamboge">来源已不可用，保留的产物记录仍可查看。</Notice>
  const content = record(version.content)
  const data = record(content.data)
  const candidates = Array.isArray(data.titles)
    ? data.titles.map((candidate) => record(candidate).text).filter((title): title is string => typeof title === 'string' && !!title.trim())
    : []
  const summary = typeof data.summary === 'string' ? data.summary : ''
  const text = versionText(version)
  const imageURL = internalURL(version.image_url) ? assetUrl(version.image_url!) : ''
  const openURL = internalURL(version.open_url)
  const table = record(content.table)
  const columns = Array.isArray(table.columns) ? table.columns.filter((cell): cell is string => typeof cell === 'string') : []
  const rows = Array.isArray(table.rows) ? table.rows.filter((row): row is string[] => Array.isArray(row) && row.length === columns.length && row.every((cell) => typeof cell === 'string')) : []
  const canText = !!text || candidates.length > 0 || !!summary
  const formats: ('md' | 'txt' | 'csv' | 'original')[] = imageURL ? ['original'] : canText ? ['md', 'txt', ...(columns.length ? ['csv' as const] : [])] : []
  const save = async (format: 'md' | 'txt' | 'csv' | 'original') => {
    setDownloading(format)
    try {
      const response = await rawRequest('GET', '/agent/artifacts/' + item.artifact.id + '/file?version=' + version.version + '&format=' + format)
      const blob = await response.blob()
      const extension = format === 'original' ? response.headers.get('Content-Type') === 'image/jpeg' ? 'jpg' : 'png' : format
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = 'ops-artifact-v' + version.version + '.' + extension
      document.body.append(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      toast.success('已发起下载')
    } catch (error) { toast.error(errorMessage(error)) }
    finally { setDownloading(null) }
  }
  const copy = async () => {
    try { await navigator.clipboard.writeText(text || candidates.join('\n') || summary); toast.success('已复制产物内容') }
    catch { toast.error('复制失败，请手动选择内容复制') }
  }
  const quoteSelection = async () => {
    const root = document.querySelector<HTMLElement>('[data-testid="artifact-text-content"]')
    const selection = window.getSelection()
    if (!root || !selection || selection.isCollapsed || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return
    const range = selection.getRangeAt(0)
    const before = document.createRange()
    before.selectNodeContents(root)
    before.setEnd(range.startContainer, range.startOffset)
    const toEnd = document.createRange()
    toEnd.selectNodeContents(root)
    toEnd.setEnd(range.endContainer, range.endOffset)
    const quote = range.toString().normalize('NFC')
    const start = Array.from(before.toString().normalize('NFC')).length
    const end = Array.from(toEnd.toString().normalize('NFC')).length
    if (!quote || end <= start || Array.from(quote).length !== end - start) return
    try {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(quote))
      const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
      onQuote({
        id: version.id, type: 'artifact_version', name: `${item.artifact.title} · v${version.version}`,
        summary: '对话产物版本选段', scope: 'turn', account_id: null, revision: version.hash,
        updated_at: version.created_at, reference_scope: 'turn',
        anchor: { start, end, quote_hash: hash, quote },
      }, '请基于引用的产物选段继续分析。')
    } catch {
      // A secure-context crypto API is required so the server can validate this exact selection.
    }
  }

  return <div className="space-y-3">
    <div className="flex flex-wrap items-center gap-2 text-xs text-mist-500">
      <span>v{version.version}</span><span>·</span><span>{version.source_kind === 'g_tool' ? '受控工具结果' : version.source_kind === 'attachment' ? '本人上传图片' : version.source_kind}</span>
      <span>·</span><span>{new Date(version.created_at).toLocaleString('zh-CN')}</span>
    </div>
    {!!formats.length && <div className="flex flex-wrap gap-2">
      {formats.map((format) => <Button key={format} type="button" size="sm" variant="outline" icon={<Download className="size-3.5" />} loading={downloading === format} disabled={downloading !== null} onClick={() => void save(format)}>{{ md: '保存 Markdown', txt: '保存文本', csv: '保存 CSV', original: '保存原图' }[format]}</Button>)}
      {canText && <Button type="button" size="sm" variant="ghost" icon={<Copy className="size-3.5" />} onClick={() => void copy()}>复制内容</Button>}
    </div>}
    {columns.length > 0
      ? <div className="space-y-2"><div className="max-h-96 overflow-auto rounded-lg border border-mist-200"><table className="min-w-full text-left text-xs"><thead className="bg-mist-50"><tr>{columns.map((cell, index) => <th key={index} className="max-w-64 whitespace-pre-wrap break-all border-b border-mist-200 px-3 py-2 font-medium">{cell}</th>)}</tr></thead><tbody>{rows.slice(0, visibleRows).map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column} className="max-w-64 whitespace-pre-wrap break-all border-b border-mist-100 px-3 py-2">{cell}</td>)}</tr>)}</tbody></table></div>
        <p className="text-xs text-mist-500">显示 {Math.min(rows.length, visibleRows)} / {rows.length} 行；CSV 导出对公式样式的单元格加“文本：”前缀，原产物不变。</p>
        {rows.length > visibleRows && <Button size="sm" variant="ghost" onClick={() => setVisibleRows((count) => count + 50)}>显示更多行</Button>}
        <details><summary className="cursor-pointer text-xs text-ink-700">CSV 原文与选段反馈</summary><pre data-testid="artifact-text-content" className="mt-2 max-h-56 select-text overflow-auto whitespace-pre-wrap break-words rounded-lg bg-mist-50 p-3 text-sm">{text}</pre><Button className="mt-2" size="sm" variant="outline" icon={<MessageSquareQuote className="size-3.5" />} onClick={() => void quoteSelection()}>引用选段追问</Button></details>
      </div>
      : text
      ? <div><pre data-testid="artifact-text-content" className="max-h-96 select-text overflow-auto whitespace-pre-wrap break-words rounded-lg bg-mist-50 p-3 text-sm leading-6 text-mist-700">{text}</pre><div className="mt-2 flex justify-end"><Button type="button" size="sm" variant="outline" icon={<MessageSquareQuote className="size-3.5" />} onClick={() => void quoteSelection()}>引用选段追问</Button></div></div>
      : candidates.length > 0
        ? <div><h4 className="mb-2 text-xs font-semibold text-mist-600">标题候选</h4><ol className="space-y-2">{candidates.map((title, index) => <li key={`${index}:${title}`} className="rounded-lg border border-mist-200 bg-white px-3 py-2 text-sm leading-6 text-mist-800">{title}</li>)}</ol></div>
        : summary
          ? <div><h4 className="mb-2 text-xs font-semibold text-mist-600">摘要</h4><p className="whitespace-pre-wrap break-words text-sm leading-6 text-mist-800">{summary}</p></div>
          : imageURL
            ? <img src={imageURL} alt={item.artifact.title} className="max-h-96 max-w-full rounded-lg border border-mist-200 object-contain" />
            : <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-mist-50 p-3 text-xs leading-5 text-mist-700">{JSON.stringify(data, null, 2)}</pre>}
    {imageURL && candidates.length === 0 && !summary && !text && <p className="flex items-center gap-1.5 text-xs text-mist-500"><Image className="size-3.5" />图片附件预览</p>}
    {openURL && <Link to={openURL} target="_blank" rel="noopener noreferrer" className="inline-flex text-sm text-ink-700 underline">打开来源作品</Link>}
    {version.object_revision && <p className="text-xs text-mist-500">来源当前修订：{version.object_revision}</p>}
  </div>
}

export function ArtifactPanel({ conversationID, compact = false, onQuote }: {
  conversationID?: string; compact?: boolean; onQuote: (ref: AgentContextSelection, prompt: string) => void
}) {
  const qc = useQueryClient()
  const [selectedID, setSelectedID] = useState('')
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null)
  const [comparisonVersion, setComparisonVersion] = useState<number | null>(null)
  const [olderVersions, setOlderVersions] = useState<AgentArtifactVersion[]>([])
  const [olderCursor, setOlderCursor] = useState<string | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [editText, setEditText] = useState('')
  const [editingVersion, setEditingVersion] = useState(false)
  const [savingVersion, setSavingVersion] = useState(false)
  const versionRequest = useRef<{ key: string; id: string } | null>(null)
  useEffect(() => {
    setSelectedID('')
    setSelectedVersion(null)
    setComparisonVersion(null)
    setOlderVersions([])
    setOlderCursor(null)
  }, [conversationID])
  const list = useInfiniteQuery({
    queryKey: ['agent-artifacts', conversationID],
    queryFn: ({ pageParam }) => get<AgentArtifactPage>(`/agent/conversations/${conversationID}/artifacts?limit=30${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`),
    initialPageParam: '' as string,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    enabled: !!conversationID,
  })
  const items: AgentArtifactSummary[] = list.data?.pages.flatMap((page) => page.items) ?? []
  const artifactID = items.some((item) => item.id === selectedID) ? selectedID : items[0]?.id ?? ''
  const detail = useQuery({
    queryKey: ['agent-artifact', artifactID],
    queryFn: () => get<AgentArtifactDetail>(`/agent/artifacts/${artifactID}`),
    enabled: !!artifactID,
  })
  useEffect(() => {
    setSelectedVersion(null)
    setComparisonVersion(null)
    setOlderVersions([])
    setOlderCursor(null)
    setEditText('')
    setEditingVersion(false)
  }, [artifactID])
  const versionDetail = useQuery({
    queryKey: ['agent-artifact-version', artifactID, selectedVersion],
    queryFn: () => get<AgentArtifactDetail>(`/agent/artifacts/${artifactID}?version=${selectedVersion}`),
    enabled: !!artifactID && selectedVersion !== null,
  })
  const compareDetail = useQuery({
    queryKey: ['agent-artifact-version', artifactID, comparisonVersion],
    queryFn: () => get<AgentArtifactDetail>(`/agent/artifacts/${artifactID}?version=${comparisonVersion}`),
    enabled: !!artifactID && comparisonVersion !== null,
  })
  const versions = [...(detail.data?.versions ?? []), ...olderVersions]
  const displayedVersion = selectedVersion === null ? detail.data?.current_version : versionDetail.data?.current_version
  const currentVersion = detail.data?.current_version
  const compareVersion = compareDetail.data?.current_version
  const currentText = versionText(currentVersion)
  const nextVersionCursor = olderVersions.length ? olderCursor : detail.data?.next_cursor ?? null
  useEffect(() => setEditText(currentText), [artifactID, currentVersion?.id])

  const loadOlderVersions = async () => {
    if (!artifactID || !nextVersionCursor || loadingOlder) return
    setLoadingOlder(true)
    try {
      const page = await get<AgentArtifactDetail>(`/agent/artifacts/${artifactID}?limit=20&cursor=${encodeURIComponent(nextVersionCursor)}`)
      setOlderVersions((old) => [...old, ...page.versions.filter((item) => !old.some((existing) => existing.id === item.id))])
      setOlderCursor(page.next_cursor)
    } catch (error) { void qc.invalidateQueries({ queryKey: ['agent-artifact', artifactID] }); throw error }
    finally { setLoadingOlder(false) }
  }

  const saveNewVersion = async () => {
    if (!artifactID || !currentVersion || !editText.trim() || savingVersion) return
    const content = editText.trim()
    const key = JSON.stringify({ artifactID, expected_version: currentVersion.version, content })
    const requestID = versionRequest.current?.key === key ? versionRequest.current.id : crypto.randomUUID()
    versionRequest.current = { key, id: requestID }
    setSavingVersion(true)
    try {
      const saved = await post<{ version: number }>(`/agent/artifacts/${artifactID}/versions`, {
        request_id: requestID, expected_version: currentVersion.version, content,
      })
      versionRequest.current = null
      setSelectedVersion(saved.version)
      setComparisonVersion(null)
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['agent-artifacts'] }),
        qc.invalidateQueries({ queryKey: ['agent-artifact'] }),
      ])
    } catch (error) {
      void qc.invalidateQueries({ queryKey: ['agent-artifact', artifactID] })
      throw error
    } finally { setSavingVersion(false) }
  }

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
      {list.hasNextPage && <Button type="button" size="sm" variant="ghost" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>加载更多产物</Button>}
    </div>
    <Card className="min-w-0 space-y-3 border border-mist-200 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="break-words text-sm font-semibold text-mist-800">{items.find((item) => item.id === artifactID)?.title}</h3><p className="mt-1 text-xs text-mist-500">版本只读；编辑后保存会创建新版本</p></div>
        {!!versions.length && <Select aria-label="选择产物版本" value={String(selectedVersion ?? currentVersion?.version ?? '')} onChange={(event) => { const value = Number(event.target.value); setSelectedVersion(value === currentVersion?.version ? null : value); setComparisonVersion(null) }} className="h-8 w-auto py-1 text-xs">
          {versions.map((item) => <option key={item.id} value={item.version}>版本 v{item.version}{item.version === currentVersion?.version ? '（当前）' : ''}</option>)}
        </Select>}
      </div>
      {detail.isLoading || selectedVersion !== null && versionDetail.isLoading ? <p className="flex items-center gap-2 text-sm text-mist-500" role="status"><LoaderCircle className="size-4 animate-spin" />正在读取版本…</p> : null}
      {(detail.isError || versionDetail.isError) && <div className="space-y-2"><Notice tone="red">{errorMessage(detail.error ?? versionDetail.error)}</Notice><Button size="sm" icon={<RotateCcw className="size-3.5" />} onClick={() => void (selectedVersion === null ? detail.refetch() : versionDetail.refetch())}>重试</Button></div>}
      {displayedVersion && <ArtifactPreview item={detail.data!} version={displayedVersion} onQuote={onQuote} />}
      {nextVersionCursor && <Button type="button" size="sm" variant="ghost" loading={loadingOlder} onClick={() => void loadOlderVersions().catch((error) => toast.error(errorMessage(error)))}>加载更早版本</Button>}
      {versions.length > 1 && <div className="flex flex-wrap items-center gap-2 border-t border-mist-100 pt-3"><GitCompare className="size-4 text-mist-500" /><Select aria-label="对照版本" value={String(comparisonVersion ?? '')} onChange={(event) => setComparisonVersion(event.target.value ? Number(event.target.value) : null)} className="h-8 w-auto py-1 text-xs"><option value="">不对照</option>{versions.filter((item) => item.version !== displayedVersion?.version).map((item) => <option key={item.id} value={item.version}>与 v{item.version} 对照</option>)}</Select></div>}
      {compareVersion && displayedVersion && <div className="grid gap-2 md:grid-cols-2"><section><h4 className="mb-1 text-xs font-semibold text-mist-600">v{displayedVersion.version}</h4><pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-mist-50 p-2 text-xs">{versionText(displayedVersion) || JSON.stringify(record(record(displayedVersion.content).data), null, 2)}</pre></section><section><h4 className="mb-1 text-xs font-semibold text-mist-600">v{compareVersion.version}</h4><pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-mist-50 p-2 text-xs">{versionText(compareVersion) || JSON.stringify(record(record(compareVersion.content).data), null, 2)}</pre></section></div>}
      {currentVersion && versionText(currentVersion) && <div className="border-t border-mist-100 pt-3"><Button type="button" size="sm" variant="ghost" aria-expanded={editingVersion} onClick={() => setEditingVersion((open) => !open)}>{editingVersion ? '收起编辑' : '编辑当前内容并保存为新版本'}</Button>{editingVersion && <div className="mt-2 space-y-2"><Textarea aria-label="编辑产物内容" rows={6} maxLength={20000} value={editText} onChange={(event) => setEditText(event.target.value)} /><div className="flex items-center justify-between gap-2"><span className="text-xs text-mist-400">保存会产生新版本，不会自动写入业务对象。</span><Button type="button" size="sm" loading={savingVersion} disabled={!editText.trim() || editText.trim() === currentText} onClick={() => void saveNewVersion().catch((error) => toast.error(errorMessage(error)))}>保存新版本</Button></div></div>}</div>}
    </Card>
  </div>
}
