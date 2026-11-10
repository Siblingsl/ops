import { useCallback, useEffect, useRef, useState } from 'react'
import { Square, Waves } from 'lucide-react'
import { Button } from '@/components/ui'
import { ApiError, patch, post } from '@/lib/api'

// A2（27 §11.4.5 / V08）：实时语音渲染器。
// 分工：渲染器只做麦克风采集、PCM 编解码与播放；WebSocket 与供应商密钥全在桌面主进程
// （固定 IPC：voice:realtime-*）。红线：实时语音不自动发送——停止后进"可编辑终稿"，
// 由用户插入输入框；不把未确认的转写当指令。

type BridgeEvent = {
  type: string
  state?: string
  dataBase64?: string
  text?: string
  error_code?: string
  message?: string
}

type Phase = 'idle' | 'connecting' | 'live' | 'stopping' | 'reviewable' | 'error'

const UPSTREAM_RATE = 16000
const DOWNSTREAM_RATE = 24000
const CHUNK_SAMPLES = 1600 // 100ms @16k

function int16ToBase64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)
  let binary = ''
  const step = 4096
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + step, bytes.length)))
  }
  return btoa(binary)
}

function base64ToFloat32PCM16(base64: string): Float32Array<ArrayBuffer> {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const view = new DataView(bytes.buffer)
  const count = Math.floor(bytes.length / 2)
  const samples = new Float32Array(new ArrayBuffer(count * 4))
  for (let i = 0; i < count; i++) samples[i] = view.getInt16(i * 2, true) / 32768
  return samples
}

/** 线性插值降采样；块边界不做相位连续（语音场景可接受，代价是多一次插值误差）。 */
function downsample(input: Float32Array, from: number, to: number): Float32Array<ArrayBuffer> {
  const ratio = from / to
  const outLength = Math.floor(input.length / ratio)
  const out = new Float32Array(outLength)
  for (let i = 0; i < outLength; i++) {
    const position = i * ratio
    const index = Math.floor(position)
    const fraction = position - index
    const next = index + 1 < input.length ? input[index + 1] : input[index]
    out[i] = input[index] * (1 - fraction) + next * fraction
  }
  return out
}

export function RealtimeVoiceBar({ conversationId, enabled, onInsert }: {
  conversationId: string
  enabled: boolean
  onInsert: (text: string) => void
}) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState('')
  const [assistantText, setAssistantText] = useState('')
  const [userText, setUserText] = useState('')
  const [editable, setEditable] = useState('')
  const [elapsed, setElapsed] = useState(0)

  const sessionRef = useRef<string | null>(null)
  const phaseRef = useRef<Phase>('idle')
  const streamRef = useRef<MediaStream | null>(null)
  const captureCtxRef = useRef<AudioContext | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const playbackRef = useRef<{ ctx: AudioContext; nextTime: number; sources: Set<AudioBufferSourceNode> } | null>(null)
  const pendingRef = useRef<Float32Array>(new Float32Array(0))
  const startedAtRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const userTextRef = useRef('')

  const setPhaseBoth = useCallback((next: Phase) => {
    phaseRef.current = next
    setPhase(next)
  }, [])

  const teardownAudio = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
    processorRef.current?.disconnect()
    processorRef.current = null
    sourceRef.current?.disconnect()
    sourceRef.current = null
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    if (captureCtxRef.current && captureCtxRef.current.state !== 'closed') void captureCtxRef.current.close()
    captureCtxRef.current = null
    pendingRef.current = new Float32Array(0)
    const playback = playbackRef.current
    if (playback) {
      playback.sources.forEach((source) => { try { source.stop() } catch { /* 已结束 */ } })
      playback.sources.clear()
      if (playback.ctx.state !== 'closed') void playback.ctx.close()
      playbackRef.current = null
    }
  }, [])

  const releaseBridge = useCallback(async (endSession: boolean) => {
    try { await window.opsDesktopUI?.invokeInBrowse('voice:realtime-stop') } catch { /* 已断开 */ }
    if (endSession && sessionRef.current) {
      const id = sessionRef.current
      sessionRef.current = null
      try { await patch(`/agent/voice-sessions/${id}`, { state: 'ended' }) } catch { /* 会话可能已结束 */ }
    }
  }, [])

  useEffect(() => () => {
    teardownAudio()
    void window.opsDesktopUI?.invokeInBrowse('voice:realtime-stop')
    // 离开页面时尽力结束会话，避免下次 start 撞上 409（失败也不阻塞卸载）。
    if (sessionRef.current) {
      const id = sessionRef.current
      sessionRef.current = null
      void patch(`/agent/voice-sessions/${id}`, { state: 'ended' }).catch(() => {})
    }
  }, [teardownAudio])

  useEffect(() => {
    if (!enabled || !window.opsDesktopUI) return
    return window.opsDesktopUI.onRealtimeEvent((event: BridgeEvent) => {
      switch (event.type) {
        case 'state':
          if (event.state === 'ready' && phaseRef.current === 'connecting') setPhaseBoth('live')
          if (event.state === 'reconnecting') setError('连接中断，正在重连…')
          if (event.state === 'error') {
            setError(event.message || '实时语音连接失败')
            setPhaseBoth('error')
          }
          break
        case 'audio_delta':
          if (event.dataBase64) playDownstream(event.dataBase64)
          break
        case 'transcript_delta':
          if (event.text) setAssistantText((old) => old + event.text)
          break
        case 'input_transcript':
          if (event.text) { userTextRef.current = event.text; setUserText(event.text) }
          break
        case 'error':
          setError(event.message || event.error_code || '实时语音出错')
          break
        default:
          break
      }
    })
  }, [enabled, setPhaseBoth])

  function playDownstream(base64: string) {
    const playback = playbackRef.current
    if (!playback) return
    const samples = base64ToFloat32PCM16(base64)
    if (samples.length === 0) return
    const buffer = playback.ctx.createBuffer(1, samples.length, DOWNSTREAM_RATE)
    buffer.copyToChannel(samples, 0)
    const source = playback.ctx.createBufferSource()
    source.buffer = buffer
    source.connect(playback.ctx.destination)
    const at = Math.max(playback.ctx.currentTime + 0.05, playback.nextTime)
    source.start(at)
    playback.nextTime = at + buffer.duration
    playback.sources.add(source)
    source.onended = () => playback.sources.delete(source)
  }

  const stopAndReview = useCallback(async () => {
    if (phaseRef.current !== 'live' && phaseRef.current !== 'connecting') return
    setPhaseBoth('stopping')
    teardownAudio()
    await releaseBridge(true)
    const transcript = userTextRef.current.trim()
    setEditable(transcript)
    setPhaseBoth('reviewable')
    if (!transcript) setError('本次没有拿到用户侧转写；可直接输入终稿。')
  }, [releaseBridge, setPhaseBoth, teardownAudio])

  const start = useCallback(async () => {
    setError('')
    setAssistantText('')
    setUserText('')
    userTextRef.current = ''
    setEditable('')
    setPhaseBoth('connecting')
    try {
      const session = await post<{ id: string }>(`/agent/conversations/${conversationId}/voice-sessions`, { mode: 'realtime' })
      sessionRef.current = session.id
      const token = await post<{ token: string; proxy_url?: string; model: string; provider: string; proxy_endpoint: string }>(
        `/agent/voice-sessions/${session.id}/realtime-token`, {})
      const result = await window.opsDesktopUI?.invokeInBrowse('voice:realtime-start', {
        session_id: session.id, token: token.token,
        proxy_url: token.proxy_url, proxy_endpoint: token.proxy_endpoint,
        model: token.model, provider: token.provider,
      }) as { ok?: boolean; error_code?: string; message?: string } | undefined
      if (result && result.ok === false) throw new Error(result.message || result.error_code || '实时语音桥启动失败')

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      streamRef.current = stream
      const captureCtx = new AudioContext()
      captureCtxRef.current = captureCtx
      const playbackCtx = new AudioContext()
      void captureCtx.resume()
      void playbackCtx.resume()
      playbackRef.current = { ctx: playbackCtx, nextTime: 0, sources: new Set() }
      const source = captureCtx.createMediaStreamSource(stream)
      sourceRef.current = source
      const processor = captureCtx.createScriptProcessor(4096, 1, 1)
      processorRef.current = processor
      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0)
        const reduced = downsample(input, captureCtx.sampleRate, UPSTREAM_RATE)
        const merged = new Float32Array(pendingRef.current.length + reduced.length)
        merged.set(pendingRef.current, 0)
        merged.set(reduced, pendingRef.current.length)
        let offset = 0
        while (merged.length - offset >= CHUNK_SAMPLES) {
          const chunk = merged.subarray(offset, offset + CHUNK_SAMPLES)
          const pcm = new Int16Array(chunk.length)
          for (let i = 0; i < chunk.length; i++) {
            const value = Math.max(-1, Math.min(1, chunk[i]))
            pcm[i] = value < 0 ? value * 0x8000 : value * 0x7fff
          }
          void window.opsDesktopUI?.invokeInBrowse('voice:realtime-append', { dataBase64: int16ToBase64(pcm) })
          offset += CHUNK_SAMPLES
        }
        pendingRef.current = merged.slice(offset)
      }
      source.connect(processor)
      processor.connect(captureCtx.destination)
      startedAtRef.current = Date.now()
      setElapsed(0)
      timerRef.current = setInterval(() => setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000)), 1000)
    } catch (err) {
      teardownAudio()
      await releaseBridge(true)
      const message = err instanceof ApiError && err.code === 'voice_capability_unsupported'
        ? '未配置 realtime 供应商路由；请在模型配置里为「realtime」指定支持实时音频的供应商。'
        : err instanceof Error ? err.message : String(err)
      setError(message)
      setPhaseBoth('error')
    }
  }, [conversationId, releaseBridge, setPhaseBoth, teardownAudio])

  const interrupt = useCallback(async () => {
    const playback = playbackRef.current
    playback?.sources.forEach((source) => { try { source.stop() } catch { /* 已结束 */ } })
    playback?.sources.clear()
    if (playback) playback.nextTime = 0
    try { await window.opsDesktopUI?.invokeInBrowse('voice:realtime-interrupt') } catch { /* 无活动响应 */ }
  }, [])

  const reset = useCallback(() => {
    teardownAudio()
    setError('')
    setAssistantText('')
    setUserText('')
    setEditable('')
    setElapsed(0)
    setPhaseBoth('idle')
  }, [setPhaseBoth, teardownAudio])

  if (!enabled || !window.opsDesktopUI) return null

  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0')
  const ss = String(elapsed % 60).padStart(2, '0')

  return <div className="desktop-agent-voice-bar" data-testid="realtime-voice-bar" data-state={phase}>
    {phase === 'idle' && <Button size="sm" variant="ghost" aria-label="开始实时语音" onClick={() => void start()}>
      <Waves className="size-4" /> 实时语音
    </Button>}
    {(phase === 'connecting' || phase === 'live') && <>
      <span className="inline-flex items-center gap-2 text-[13px] text-ink-700">
        <span className="inline-block size-2 animate-pulse rounded-full bg-danger" aria-hidden="true" />
        {phase === 'connecting' ? '连接中…' : `实时对话 ${mm}:${ss}`}
      </span>
      {phase === 'live' && <Button size="sm" variant="ghost" aria-label="打断当前回复" onClick={() => void interrupt()}>打断</Button>}
      <Button size="sm" variant="ghost" aria-label="结束实时语音" onClick={() => void stopAndReview()}>
        <Square className="size-4" /> 结束
      </Button>
      <span className="text-xs text-mist-500">音频不落盘；停止后转为可编辑终稿，不自动发送。</span>
    </>}
    {(phase === 'connecting' || phase === 'live' || phase === 'reviewable') && (assistantText || userText) && <div className="mt-1 w-full rounded-lg border border-mist-200 bg-white p-2 text-[12px] leading-5">
      {userText && <p className="text-ink-700"><span className="text-mist-500">你说：</span>{userText}</p>}
      {assistantText && <p className="text-mist-600"><span className="text-mist-400">助手：</span>{assistantText.slice(-400)}</p>}
    </div>}
    {phase === 'stopping' && <span className="text-[13px] text-mist-500">正在结束实时会话…</span>}
    {phase === 'reviewable' && <>
      <textarea
        aria-label="实时语音终稿（可编辑）"
        data-testid="realtime-transcription"
        className="mt-1 w-full rounded-lg border border-mist-200 p-2 text-[13px] text-ink-700"
        rows={2}
        value={editable}
        onChange={(event) => setEditable(event.target.value)}
      />
      <div className="mt-1 flex gap-2">
        <Button size="sm" variant="primary" disabled={!editable.trim()} onClick={() => { onInsert(editable); reset() }}>插入输入框</Button>
        <Button size="sm" variant="ghost" onClick={reset}>放弃</Button>
      </div>
      {error && <span className="mt-1 block text-[12px] text-danger" role="alert">{error}</span>}
    </>}
    {phase === 'error' && <>
      <span className="text-[12px] text-danger" role="alert">{error}</span>
      <Button size="sm" variant="ghost" onClick={reset}>重试</Button>
    </>}
  </div>
}
