import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { del, errorMessage, uploadFormData } from '@/lib/api'
import type { AgentAttachment, AgentBootstrap } from '@/lib/agent'

export type DraftAttachment = {
  clientID: string
  file: File
  status: 'waiting' | 'uploading' | 'processing' | 'ready' | 'failed'
  progress?: number
  retryable?: boolean
  attachment?: AgentAttachment
  error?: string
}

type AttachmentQueueOptions = {
  canWrite: boolean
  busy: boolean
  runInputsEnabled: boolean
  bootstrapData: AgentBootstrap | undefined
  conversationId: string | undefined
}

export function useAttachmentQueue({ canWrite, busy, runInputsEnabled, bootstrapData, conversationId }: AttachmentQueueOptions) {
  const [files, setFiles] = useState<DraftAttachment[]>([])
  const [restoredAttachments, setRestoredAttachments] = useState<AgentAttachment[]>([])
  const [uploading, setUploading] = useState(false)
  const uploadingRef = useRef(false)
  const uploadGeneration = useRef(0)
  const cancelledUploads = useRef(new Set<string>())
  const uploadControllers = useRef(new Map<string, AbortController>())
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)

  useEffect(() => () => {
    uploadGeneration.current++
    for (const controller of uploadControllers.current.values()) controller.abort()
    uploadControllers.current.clear()
  }, [])

  const uploadFile = async (item: DraftAttachment) => {
    if (uploadingRef.current) return
    if (cancelledUploads.current.delete(item.clientID)) return
    const generation = uploadGeneration.current
    uploadingRef.current = true
    setUploading(true)
    const controller = new AbortController()
    uploadControllers.current.set(item.clientID, controller)
    setFiles((old) => old.map((file) => file.clientID === item.clientID ? { ...file, status: 'uploading', error: undefined } : file))
    try {
      const form = new FormData()
      form.append('file', item.file)
      form.append('request_id', item.clientID)
      if (conversationId) form.append('conversation_id', conversationId)
      const response = await uploadFormData('/agent/attachments', form, (loaded, total, complete) => {
        setFiles((old) => old.map((file) => file.clientID === item.clientID ? { ...file, status: complete ? 'processing' : 'uploading', progress: total ? Math.round(loaded / total * 100) : undefined } : file))
      }, controller.signal)
      const attachment = await response.json() as AgentAttachment
      if (generation !== uploadGeneration.current || cancelledUploads.current.delete(item.clientID)) {
        await del(`/agent/attachments/${attachment.id}`).catch(() => undefined)
        return
      }
      const quarantined = attachment.parse_status === 'quarantined'
      setFiles((old) => old.map((file) => file.clientID === item.clientID ? { ...file, status: quarantined ? 'failed' : 'ready', attachment, retryable: !quarantined, error: quarantined ? '疑似含敏感凭据，已隔离，请移除并重新上传已清理文件' : undefined } : file))
    } catch (error) {
      if (generation === uploadGeneration.current && !cancelledUploads.current.delete(item.clientID)) {
        setFiles((old) => old.map((file) => file.clientID === item.clientID ? { ...file, status: 'failed', error: errorMessage(error), retryable: true } : file))
      }
    } finally {
      uploadingRef.current = false
      uploadControllers.current.delete(item.clientID)
      setUploading(false)
    }
  }

  const retryFile = (item: DraftAttachment) => { void uploadFile(item) }

  const clearDraftAttachments = () => {
    for (const item of files) {
      if (item.status !== 'ready' && item.status !== 'failed') cancelledUploads.current.add(item.clientID)
      uploadControllers.current.get(item.clientID)?.abort()
      if (item.attachment) void del(`/agent/attachments/${item.attachment.id}`).catch(() => undefined)
    }
    setFiles([])
    setRestoredAttachments([])
  }

  const removeFile = async (item: DraftAttachment) => {
    if (item.status !== 'ready' && item.status !== 'failed') cancelledUploads.current.add(item.clientID)
    uploadControllers.current.get(item.clientID)?.abort()
    setFiles((old) => old.filter((file) => file.clientID !== item.clientID))
    if (item.attachment) await del(`/agent/attachments/${item.attachment.id}`).catch(() => undefined)
  }

  const resetDraftAttachments = () => {
    uploadGeneration.current++
    for (const item of files) {
      uploadControllers.current.get(item.clientID)?.abort()
      if (item.attachment) void del(`/agent/attachments/${item.attachment.id}`).catch(() => undefined)
      else cancelledUploads.current.add(item.clientID)
    }
    setFiles([])
    setRestoredAttachments([])
  }

  const addFiles = async (incoming: FileList | File[]) => {
    if (!canWrite || busy && !runInputsEnabled || uploadingRef.current) return
    const filesToAdd = Array.from(incoming)
    if (!filesToAdd.length) return
    const maxFiles = bootstrapData?.limits.attachments_per_message ?? 6
    const available = Math.max(0, maxFiles - files.length - restoredAttachments.length)
    if (filesToAdd.length > available) toast.error(`一条消息最多添加 ${maxFiles} 个附件`)
    const filesToAccept = filesToAdd.slice(0, available)
    const queue = filesToAccept.map((file): DraftAttachment => {
      const image = /^image\/(jpeg|png|webp|gif)$/i.test(file.type)
      const textFile = /\.(txt|md)$/i.test(file.name)
      const documentFile = !!bootstrapData?.features.document_parse && /\.(pdf|docx|csv)$/i.test(file.name)
      const max = image || documentFile ? (bootstrapData?.limits.document_bytes ?? 20 * 1024 * 1024) : (bootstrapData?.limits.text_bytes ?? 1024 * 1024)
      const error = !image && !textFile && !documentFile ? '文件类型暂不支持，请选择允许的图片、文本或文档' : file.size > max ? '文件超过大小限制' : undefined
      return { clientID: crypto.randomUUID(), file, status: error ? 'failed' : 'waiting', error, retryable: !error }
    })
    setFiles((old) => [...old, ...queue])
    for (const item of queue) if (item.status === 'waiting') await uploadFile(item)
  }

  const onDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    if (canWrite && (!busy || runInputsEnabled) && !uploading) {
      dragDepth.current++
      setDragging(true)
    }
  }
  const onDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    dragDepth.current--
    if (dragDepth.current <= 0) {
      dragDepth.current = 0
      setDragging(false)
    }
  }
  const onDragOver = (event: React.DragEvent<HTMLDivElement>) => event.preventDefault()
  const onDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    void addFiles(event.dataTransfer.files)
  }

  const readyFiles = files.filter((file) => file.status === 'ready' && file.attachment)
  const readyAttachmentIDs = [...readyFiles.map((file) => file.attachment!.id), ...restoredAttachments.map((file) => file.id)]
  const failedFiles = files.filter((file) => file.status === 'failed')

  return {
    files, setFiles, restoredAttachments, setRestoredAttachments, uploading, dragging,
    readyFiles, readyAttachmentIDs, failedFiles,
    addFiles, uploadFile, retryFile, clearDraftAttachments, removeFile, resetDraftAttachments,
    dragHandlers: { onDragEnter, onDragLeave, onDragOver, onDrop },
  }
}
