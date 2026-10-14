import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { ApiError, get } from '@/lib/api'
import { CUSTOM_THEME_ID, customTheme, renderWechat, themeById } from '@/lib/render'
import type { CustomTheme } from '@/lib/types'

interface PreviewData {
  title: string
  account_name: string
  theme: string
  custom_theme: CustomTheme | null
  sections: { heading: string; content_md: string }[]
}

export default function PublicPreview() {
  const { token = '' } = useParams()
  const [data, setData] = useState<PreviewData | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    get<PreviewData>(`/public-previews/${token}`)
      .then((result) => { if (active) setData(result) })
      .catch((cause) => {
        if (!active) return
        setError(cause instanceof ApiError && cause.code === 'preview_expired'
          ? '此手机预览链接已过期，请回到排版页重新生成。'
          : '预览链接无效或作品已删除。')
      })
    return () => { active = false }
  }, [token])

  const html = useMemo(() => {
    if (!data) return ''
    const theme = data.theme === CUSTOM_THEME_ID && data.custom_theme
      ? customTheme(data.custom_theme)
      : themeById(data.theme)
    return renderWechat(data.sections, theme).replace(
      /\/api\/v1\/assets\/([0-9a-f-]{36})\/file/g,
      `/api/v1/public-previews/${token}/assets/$1`,
    )
  }, [data, token])

  return (
    <main className="min-h-screen bg-white px-4 py-5 text-[#222]">
      {error ? <div className="mx-auto max-w-xl rounded-xl border border-mist-200 p-5 text-center text-sm text-mist-600">{error}</div>
        : !data ? <div className="py-12 text-center text-sm text-mist-500">正在打开手机预览…</div>
          : <article className="mx-auto max-w-[680px]">
            <h1 className="mb-3 text-[24px] font-bold leading-snug">{data.title || '（未填写标题）'}</h1>
            <p className="mb-6 text-sm text-[#576b95]">{data.account_name}</p>
            <div data-testid="wechat-rendered-html" dangerouslySetInnerHTML={{ __html: html }} />
          </article>}
    </main>
  )
}
