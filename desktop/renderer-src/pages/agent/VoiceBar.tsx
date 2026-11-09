import { useCallback, useEffect, useRef, useState } from 'react'
import { Mic, Square } from 'lucide-react'
import { Button } from '@/components/ui'
import { ApiError, post } from '@/lib/api'

// DEV-AI27-16 第二批（W16c）：语音输入完整链路（27 §11.4.1 dictation 模式）。
// MediaRecorder 录音（内存 Blob，不落盘，27 §11.4.3）→ 停止 → turns 上传音频
// → 服务端调用已配置的 asr 路由 → reviewable 终稿 → 用户编辑后插入输入框。
// 红线：临时转写不发送不作为指令；语音不构成确认；ASR 失败不伪装成「空转写」。

export type VoiceBarState = 'idle' | 'recording' | 'transcribing' | 'reviewable' | 'error'

interface VoiceTurnResponse {
  turn: {
    id: string
    state: string
    transcription: string
    asr_provider?: string
    asr_model?: string
    asr_seconds?: number
    asr_error_code?: string
  }
  replayed?: boolean
}

/** 录音 Blob → 纯 base64（去掉 data URL 前缀）。音频只在此进程内存中短暂存在。 */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const raw = String(reader.result ?? '')
      const comma = raw.indexOf(',')
      resolve(comma >= 0 ? raw.slice(comma + 1) : raw)
    }
    reader.onerror = () => reject(reader.error ?? new Error('读取录音失败'))
    reader.readAsDataURL(blob)
  })
}

interface VoiceBarProps {
  conversationId: string
  voiceDictationEnabled: boolean
  onInsert: (text: string) => void
}

export function VoiceBar({ conversationId, voiceDictationEnabled, onInsert }: VoiceBarProps) {
  const [state, setState] = useState<VoiceBarState>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [editable, setEditable] = useState('')
  const [error, setError] = useState('')
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const sessionIdRef = useRef<string | null>(null)

  const cleanupTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [])

  useEffect(() => () => {
    cleanupTimer()
    if (recorderRef.current && recorderRef.current.state === 'recording') {
      try { recorderRef.current.stop() } catch { /* 已停止 */ }
    }
  }, [cleanupTimer])

  const submitTranscription = useCallback(async (blob: Blob) => {
    setState('transcribing')
    try {
      // 创建会话；409（已有活动会话）时不自动结束他人会话，直接报错让用户决策。
      if (!sessionIdRef.current) {
        const session = await post<{ id: string }>(
          `/agent/conversations/${conversationId}/voice-sessions`, { mode: 'dictation' })
        sessionIdRef.current = session.id
      }
      // 27 §11.4.3：单次语音输入 ≤5 分钟 / 20MiB。
      if (blob.size > 20 * 1024 * 1024) throw new Error('录音超过 20MiB 上限')
      // 音频经 turns 上传，由服务端调用已配置的 asr 路由转写；音频不落盘。
      const audioBase64 = await blobToBase64(blob)
      const ext = blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mp4') ? 'm4a' : 'webm'
      const result = await post<VoiceTurnResponse>(
        `/agent/voice-sessions/${sessionIdRef.current}/turns`,
        {
          purpose: 'transcribe', transcription: '', request_id: crypto.randomUUID(),
          audio_base64: audioBase64, audio_filename: `voice.${ext}`,
        },
      )
      const turn = result.turn
      if (turn.state === 'reviewable') {
        setEditable(turn.transcription)
        setState('reviewable')
        if (!turn.transcription) {
          setError('服务未返回转写文本；可在下方直接输入终稿。')
        }
      } else {
        throw new Error(`转写状态异常：${turn.state}`)
      }
    } catch (err) {
      // 能力缺失 / 上游失败：准确报错并允许手输终稿，不伪造转写结果。
      if (err instanceof ApiError && (err.code === 'voice_capability_unsupported' || err.code === 'voice_provider_unavailable')) {
        setEditable('')
        setState('reviewable')
        setError(err.code === 'voice_capability_unsupported'
          ? '未配置 ASR 供应商路由；可在模型配置里为「ASR 语音转写」指定供应商，或直接输入终稿。'
          : 'ASR 供应商调用失败；可直接输入终稿，或检查密钥与网络后重试。')
        return
      }
      setError('转写失败：' + (err instanceof Error ? err.message : String(err)))
      setState('error')
    }
  }, [conversationId])

  const startRecording = useCallback(async () => {
    setError('')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      chunksRef.current = []
      const recorder = new MediaRecorder(stream)
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data)
      }
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop())
        void submitTranscription(new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' }))
      }
      recorderRef.current = recorder
      recorder.start()
      setState('recording')
      setElapsed(0)
      timerRef.current = setInterval(() => setElapsed((v) => v + 1), 1000)
    } catch (err) {
      setError(err instanceof Error && err.name === 'NotAllowedError'
        ? '麦克风权限被拒绝；请在系统设置中允许后重试。'
        : '录音启动失败：' + (err instanceof Error ? err.message : String(err)))
      setState('error')
    }
  }, [submitTranscription])

  const stopRecording = useCallback(() => {
    cleanupTimer()
    if (recorderRef.current && recorderRef.current.state === 'recording') {
      recorderRef.current.stop()
    }
  }, [cleanupTimer])

  const reset = useCallback(() => {
    setState('idle')
    setEditable('')
    setError('')
    sessionIdRef.current = null
  }, [])

  if (!voiceDictationEnabled) return null

  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0')
  const ss = String(elapsed % 60).padStart(2, '0')

  return <div className="desktop-agent-voice-bar" data-testid="desktop-agent-voice-bar" data-state={state}>
    {state === 'idle' && <Button size="sm" variant="ghost" aria-label="开始语音输入" onClick={() => void startRecording()}>
      <Mic className="size-4" /> 语音输入
    </Button>}
    {state === 'recording' && <>
      <span className="inline-flex items-center gap-2 text-[13px] text-ink-700">
        <span className="inline-block size-2 animate-pulse rounded-full bg-danger" aria-hidden="true" />
        录音中 {mm}:{ss}
      </span>
      <Button size="sm" variant="ghost" aria-label="停止录音" onClick={stopRecording}>
        <Square className="size-4" /> 停止
      </Button>
      <span className="text-xs text-mist-500">录音不落盘；音频仅用于转写。</span>
    </>}
    {state === 'transcribing' && <span className="text-[13px] text-mist-500">正在转写…</span>}
    {state === 'reviewable' && <>
      <textarea
        aria-label="语音转写终稿（可编辑）"
        data-testid="voice-transcription"
        className="w-full rounded-lg border border-mist-200 p-2 text-[13px] text-ink-700"
        rows={2}
        value={editable}
        onChange={(event) => setEditable(event.target.value)}
      />
      <div className="mt-1 flex gap-2">
        <Button size="sm" variant="primary" disabled={!editable.trim()} onClick={() => { onInsert(editable); reset() }}>
          插入输入框
        </Button>
        <Button size="sm" variant="ghost" onClick={reset}>放弃</Button>
      </div>
    </>}
    {state === 'error' && <>
      <span className="text-[12px] text-danger" role="alert">{error}</span>
      <Button size="sm" variant="ghost" onClick={reset}>重试</Button>
    </>}
  </div>
}
