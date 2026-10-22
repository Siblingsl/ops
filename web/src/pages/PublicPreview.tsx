import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { ApiError, get } from '@/lib/api'
import { CUSTOM_THEME_ID, customTheme, renderWechat, themeById } from '@/lib/render'
import type { CustomTheme } from '@/lib/types'

interface PreviewData {
  platform?: string
  content_format?: string
  body_text?: string
  article_html?: string
  topics?: string[]
  images?: { url: string; alt_text: string; ai_generated: boolean }[]
  title: string
  account_name: string
  theme: string
  custom_theme: CustomTheme | null
  sections: { heading: string; content_md: string }[]
  assets: { id: string; alt_text: string }[]
}

export default function PublicPreview() {
  const { token = '' } = useParams()
  const [data, setData] = useState<PreviewData | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    setData(null)
    setError('')
    get<PreviewData>(`/public-previews/${token}`)
      .then((result) => { if (active) setData(result) })
      .catch((cause) => {
        if (!active) return
        setError(cause instanceof ApiError && (cause.code === 'preview_expired' || cause.code === 'preview_stale')
          ? cause.message
          : '预览链接无效或作品已删除。')
      })
    return () => { active = false }
  }, [token])

  const html = useMemo(() => {
    if (!data || data.platform === 'toutiao') return ''
    const theme = data.theme === CUSTOM_THEME_ID && data.custom_theme
      ? customTheme(data.custom_theme)
      : themeById(data.theme)
    return renderWechat(data.sections, theme, data.assets).replace(
      /\/api\/v1\/assets\/([0-9a-f-]{36})\/file/g,
      `/api/v1/public-previews/${token}/assets/$1`,
    )
  }, [data, token])

  return (
    <main className="min-h-screen bg-white px-4 py-5 text-[#222]">
      {error ? <div className="mx-auto max-w-xl rounded-xl border border-mist-200 p-5 text-center text-sm text-mist-600">{error}</div>
        : !data ? <div className="py-12 text-center text-sm text-mist-500">正在打开手机预览…</div>
          : data.platform === 'toutiao' ? <article className="mx-auto max-w-[760px] break-words" data-testid="toutiao-public-preview">
            <p className="mb-2 text-sm font-semibold text-[#c9161d]">今日头条 · {data.content_format === 'micro_post' ? '微头条' : '文章'}</p>
            <p className="mb-5 text-sm text-[#666]">{data.account_name} · 内容预览，不代表平台已发布</p>
            {data.content_format === 'micro_post'
              ? <div className="whitespace-pre-wrap text-[16px] leading-[1.8]" data-testid="toutiao-preview-body">{data.body_text}</div>
              : <div className="text-[16px] leading-[1.8] [&_h1]:mb-5 [&_h1]:text-2xl [&_h1]:font-bold [&_h2]:my-4 [&_h2]:text-xl [&_h2]:font-bold [&_p]:my-3 [&_img]:max-w-full [&_img]:h-auto [&_a]:text-[#315c62] [&_a]:underline" data-testid="toutiao-preview-body" dangerouslySetInnerHTML={{ __html: data.article_html ?? '' }} />}
            {!!data.topics?.length && <p className="my-5 flex flex-wrap gap-2 text-sm text-[#315c62]">{data.topics.map(topic => <span key={topic}>#{topic.replace(/^#/, '')}</span>)}</p>}
            {data.content_format === 'micro_post' && <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">{data.images?.map(image => <figure key={image.url}><img src={image.url} alt={image.alt_text} className="h-auto max-w-full rounded-lg" />{image.ai_generated && <figcaption className="mt-1 text-xs text-[#666]">AI 生成配图</figcaption>}</figure>)}</div>}
            {data.content_format === 'long_article' && data.images?.some(image => image.ai_generated) && <p className="mt-4 text-xs text-[#666]">配图含 AI 生成内容；实际发布时请核对平台声明。</p>}
          </article> : <article className="mx-auto max-w-[680px]">
            <h1 className="mb-3 text-[24px] font-bold leading-snug">{data.title || '（未填写标题）'}</h1>
            <p className="mb-6 text-sm text-[#576b95]">{data.account_name}</p>
            <div data-testid="wechat-rendered-html" dangerouslySetInnerHTML={{ __html: html }} />
          </article>}
    </main>
  )
}
