import { useEffect, useRef, useState } from 'react'
import { Mic, Square } from 'lucide-react'
import { Button } from '@/components/ui'

// DEV-AI27-07 第二批（W07b）：语音输入条（27 §11.4.1 语音输入模式）。
// 状态：recording → transcribing → reviewable（可编辑终稿）→ 用户点"插入输入框"。
// 临时转写不发送不作为指令（红线：语音不构成确认）。
// 实际录音/ASR 由桌面媒体桥（W16 第二批）执行；本组件管理 UI 状态与转写文本编辑。

export type VoiceBarState = 'idle' | 'recording' | 'transcribing' | 'reviewable'

interface VoiceBarProps {
  state: VoiceBarState
  transcription: string
  elapsed: number // 录音秒数
  onStateChange: (state: VoiceBarState) => void
  onTranscriptionChange: (text: string) => void
  onInsert: (text: string) => void
  onSaveDraft: (text: string) => void
  voiceDictationEnabled: boolean
}

export function VoiceBar({
  state, transcription, elapsed, onStateChange, onTranscriptionChange, onInsert, onSaveDraft, voiceDictationEnabled,
}: VoiceBarProps) {
  const [editable, setEditable] = useState('')
  const editableRef = useRef(editable)
  editableRef.current = editable

  // 转写完成时初始化可编辑文本
  useEffect(() => {
    if (state === 'reviewable') setEditable(transcription)
  }, [state, transcription])

  if (!voiceDictationEnabled) return null

  if (state === 'idle') {
    return <div className="desktop-agent-voice-bar" data-testid="desktop-agent-voice-bar" data-state="idle">
      <Button size="sm" variant="ghost" aria-label="开始语音输入" onClick={() => onStateChange('recording')}>
        <Mic className="size-4" /> 语音输入
      </Button>
    </div>
  }

  if (state === 'recording') {
    const mm = String(Math.floor(elapsed / 60)).padStart(2, '0')
    const ss = String(elapsed % 60).padStart(2, '0')
    return <div className="desktop-agent-voice-bar" data-testid="desktop-agent-voice-bar" data-state="recording">
      <span className="inline-flex items-center gap-2 text-[13px] text-ink-700">
        <span className="inline-block size-2 animate-pulse rounded-full bg-danger" aria-hidden="true" />
        录音中 {mm}:{ss}
      </span>
      <Button size="sm" variant="ghost" aria-label="停止录音" onClick={() => onStateChange('transcribing')}>
        <Square className="size-4" /> 停止
      </Button>
      <span className="text-xs text-mist-500">录音不落盘；转写由语音路由处理。</span>
    </div>
  }

  if (state === 'transcribing') {
    return <div className="desktop-agent-voice-bar" data-testid="desktop-agent-voice-bar" data-state="transcribing">
      <span className="text-[13px] text-mist-500">正在转写…</span>
    </div>
  }

  // reviewable：可编辑终稿
  return <div className="desktop-agent-voice-bar" data-testid="desktop-agent-voice-bar" data-state="reviewable">
    <textarea
      aria-label="语音转写终稿（可编辑）"
      className="w-full rounded-lg border border-mist-200 p-2 text-[13px] text-ink-700"
      rows={2}
      value={editable}
      onChange={(event) => { setEditable(event.target.value); onTranscriptionChange(event.target.value) }}
    />
    <div className="mt-1 flex gap-2">
      <Button size="sm" variant="primary" disabled={!editable.trim()} onClick={() => { onInsert(editable); onStateChange('idle') }}>
        插入输入框
      </Button>
      <Button size="sm" variant="secondary" disabled={!editable.trim()} onClick={() => { onSaveDraft(editable); onStateChange('idle') }}>
        另存草稿
      </Button>
    </div>
  </div>
}
