import { Mic, MicOff } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { cn } from './ui'

type SpeechRec = {
  lang: string
  continuous: boolean
  interimResults: boolean
  start: () => void
  stop: () => void
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null
  onend: (() => void) | null
  onerror: ((e: { error: string }) => void) | null
}

function speechCtor(): (new () => SpeechRec) | null {
  const w = window as unknown as { SpeechRecognition?: new () => SpeechRec; webkitSpeechRecognition?: new () => SpeechRec }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export const voiceSupported = () => !!speechCtor()

/** VoiceButton dictates into a text field with the browser's speech recognition (S3 语音输入). Audio never reaches our server. */
export function VoiceButton({ onText, className, triggerEvent }: { onText: (text: string) => void; className?: string; triggerEvent?: string }) {
  const [on, setOn] = useState(false)
  const rec = useRef<SpeechRec | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  const cb = useRef(onText)
  cb.current = onText
  useEffect(() => () => rec.current?.stop(), [])
  useEffect(() => {
    if (!triggerEvent) return
    const click = () => button.current?.click()
    window.addEventListener(triggerEvent, click)
    return () => window.removeEventListener(triggerEvent, click)
  }, [triggerEvent])
  const Ctor = speechCtor()
  if (!Ctor) return null
  const toggle = () => {
    if (on) {
      rec.current?.stop()
      return
    }
    const r = new Ctor()
    r.lang = 'zh-CN'
    r.continuous = true
    r.interimResults = false
    r.onresult = (e) => {
      let text = ''
      for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) text += e.results[i][0].transcript
      if (text) cb.current(text)
    }
    r.onend = () => setOn(false)
    r.onerror = (e) => {
      setOn(false)
      if (e.error === 'not-allowed') toast.error('浏览器没有麦克风权限')
    }
    rec.current = r
    r.start()
    setOn(true)
  }
  return (
    <button ref={button} type="button" onClick={toggle} title={on ? '停止语音输入' : '语音输入（由浏览器识别）'}
      className={cn('inline-flex size-8 cursor-pointer items-center justify-center rounded-md border transition',
        on ? 'animate-pulse border-xhs/40 bg-xhs/10 text-xhs' : 'border-mist-200 text-mist-500 hover:border-mist-300 hover:text-mist-800', className)}>
      {on ? <MicOff className="size-4" /> : <Mic className="size-4" />}
    </button>
  )
}
