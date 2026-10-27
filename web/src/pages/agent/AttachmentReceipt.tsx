import type { AgentAttachment } from '@/lib/agent'

export function AttachmentReceipt({ attachment, sent = false }: { attachment: AgentAttachment; sent?: boolean }) {
  if (attachment.kind !== 'document') return null
  if (attachment.parse_status === 'quarantined') return <p className="mt-1 text-xs text-danger" role="alert">疑似含敏感凭据，已隔离；请移除并重新上传已清理的文件。</p>
  const extent = attachment.row_count !== undefined ? attachment.row_count.toLocaleString() + ' 行'
    : attachment.page_count !== undefined ? attachment.page_count + ' 页' + (attachment.page_basis === 'docx_saved_pagination' ? '（保存分页）' : '') : ''
  const loaded = attachment.loaded_chars !== undefined ? '已装入请求 ' + attachment.loaded_chars.toLocaleString() + ' 字'
    : sent ? '尚无装入请求回执' : '准备 ' + (attachment.injected_chars?.toLocaleString() ?? '—') + ' 字，尚未装入请求'
  return <div data-testid="attachment-receipt" className="mt-1 max-w-80 space-y-0.5 text-xs opacity-80">
    <p>{extent} · 提取 {attachment.extracted_chars?.toLocaleString() ?? '—'} 字 · {loaded}</p>
    {attachment.truncated_from !== undefined && <p>第 {attachment.truncated_from.toLocaleString()}～{attachment.truncated_to?.toLocaleString()} 字未装入；仅装入截断前的片段。</p>}
    {attachment.page_basis === 'docx_saved_pagination' && <p>页数来自文件保存的分页信息，未重新排版。</p>}
    {attachment.mime === 'application/pdf' && <p>仅提取正文；不读取外链和嵌入内容，未启用 OCR。</p>}
  </div>
}
