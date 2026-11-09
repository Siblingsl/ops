import { ApiError, rawRequest } from './api'

export interface AgentRunAcceptance {
  run_id: string
  message_id?: string
  events_url: string
  last_event_seq: number
}

export interface AgentRunEnd {
  status: string
  reason?: string
  error_code?: string
}

function eventRequestPath(path: string, afterEventSeq: number) {
  const apiPath = path.startsWith('/api/v1/') ? path.slice('/api/v1'.length) : path
  const [pathname, query = ''] = apiPath.split('?', 2)
  const params = new URLSearchParams(query)
  params.set('after_event_seq', String(afterEventSeq))
  return `${pathname}?${params.toString()}`
}

function waitForActivePage(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const finish = () => {
      if (signal.aborted) {
        cleanup()
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
      } else if (document.visibilityState === 'visible' && navigator.onLine) {
        cleanup()
        resolve()
      }
    }
    const cleanup = () => {
      window.clearInterval(timer)
      window.removeEventListener('online', finish)
      document.removeEventListener('visibilitychange', finish)
      signal.removeEventListener('abort', finish)
    }
    const timer = window.setInterval(finish, 1000)
    window.addEventListener('online', finish)
    document.addEventListener('visibilitychange', finish)
    signal.addEventListener('abort', finish)
    finish()
  })
}

/** Opens the private replay stream, reconnecting from the last delivered event sequence. */
export async function streamAgentEvents(path: string, initialAfter: number, options: {
  signal: AbortSignal
  runID: string
  onEvent: (type: string, event: AgentEventEnvelope) => void
  onConnectionState?: (state: 'live' | 'reconnecting' | 'paused') => void
  onResume: () => Promise<{ after: number; ended?: AgentRunEnd }>
}): Promise<AgentRunEnd> {
  let after = initialAfter
  let failures = 0
  let needsSnapshot = !!options.runID
  while (!options.signal.aborted) {
    if (document.visibilityState !== 'visible' || !navigator.onLine) {
      options.onConnectionState?.('paused')
      await waitForActivePage(options.signal)
      const snapshot = await options.onResume()
      if (snapshot.ended) return snapshot.ended
      after = Math.max(after, snapshot.after)
      needsSnapshot = false
    }
    const connection = new AbortController()
    const abortConnection = () => {
      if (document.visibilityState !== 'visible' || !navigator.onLine) connection.abort()
    }
    document.addEventListener('visibilitychange', abortConnection)
    window.addEventListener('offline', abortConnection)
    try {
      // A recovered view can retain an active run while its cursor already includes run.ended.
      if (needsSnapshot) {
        const snapshot = await options.onResume()
        if (snapshot.ended) return snapshot.ended
        after = Math.max(after, snapshot.after)
        needsSnapshot = false
      }
      const response = await rawRequest('GET', eventRequestPath(path, after), undefined,
        { signal: AbortSignal.any([options.signal, connection.signal]) }, true)
      options.onConnectionState?.('live')
      const reader = response.body?.getReader()
      if (!reader) throw new ApiError(502, 'incomplete_stream', '事件连接没有响应体')
      const decoder = new TextDecoder()
      let buffer = ''
      let completed: AgentRunEnd | undefined
      const handle = (block: string) => {
        if (options.signal.aborted) return
        let id = ''
        let type = 'message'
        let data = ''
        for (const line of block.split('\n')) {
          if (line.startsWith('id:')) id = line.slice(3).trim()
          else if (line.startsWith('event:')) type = line.slice(6).trim()
          else if (line.startsWith('data:')) data += line.slice(5).trimStart()
        }
        if (!data) return
        const envelope = JSON.parse(data) as AgentEventEnvelope
        const seq = envelope.event_seq ?? Number.parseInt(id, 10)
        if (!Number.isFinite(seq) || seq <= after) return
        after = seq
        options.onEvent(type, envelope)
        if (type === 'run.ended' && envelope.run_id === options.runID) completed = (envelope.data ?? {}) as AgentRunEnd
      }
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        buffer = buffer.replaceAll('\r\n', '\n')
        let boundary: number
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          handle(buffer.slice(0, boundary))
          buffer = buffer.slice(boundary + 2)
          if (completed) {
            await reader.cancel()
            return completed
          }
        }
      }
      if (buffer.trim()) handle(buffer)
      if (completed) return completed
      failures++
    } catch (error) {
      if (options.signal.aborted) throw options.signal.reason ?? error
      if (connection.signal.aborted) {
        options.onConnectionState?.('paused')
        await waitForActivePage(options.signal)
        const snapshot = await options.onResume()
        if (snapshot.ended) return snapshot.ended
        after = Math.max(after, snapshot.after)
        continue
      }
      if (error instanceof ApiError && error.status !== 0 && ![502, 503, 504].includes(error.status)) throw error
      failures++
    } finally {
      document.removeEventListener('visibilitychange', abortConnection)
      window.removeEventListener('offline', abortConnection)
    }
    options.onConnectionState?.('reconnecting')
    const baseDelay = failures === 1 ? 0 : Math.min(1000 * 2 ** Math.min(failures - 2, 5), 30_000)
    if (baseDelay > 0) await new Promise<void>((resolve, reject) => {
      const abort = () => {
        window.clearTimeout(timer)
        reject(options.signal.reason ?? new DOMException('Aborted', 'AbortError'))
      }
      const timer = window.setTimeout(() => {
        options.signal.removeEventListener('abort', abort)
        resolve()
      }, baseDelay * (0.8 + Math.random() * 0.4))
      options.signal.addEventListener('abort', abort, { once: true })
    })
  }
  throw options.signal.reason ?? new DOMException('Aborted', 'AbortError')
}

export interface AgentEventEnvelope {
  event_seq: number
  conversation_id: string
  run_id?: string
  type: string
  created_at: string
  data: Record<string, any>
}

