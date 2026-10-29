import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Printer } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'
import { Button, PageLoading, platformFormatLabel, platformLabel } from '@/components/ui'
import { get } from '@/lib/api'

interface ReportItem { category: string; passed: boolean; message: string; matched_text: string; resolution: string; resolved_at: string | null; resolved_by: string }
interface Report {
  work: { id: string; title: string; account: string; status: string }
  run: { id: string; revision: number; platform: string; content_format: string; at: string }
  items: ReportItem[]
  reviewer: string
  reviewed_at: string | null
  generated_at: string
  generated_by: string
}

const catLabel: Record<string, string> = {
  format: '格式', sensitive: '敏感词', ad_law: '广告法用语', fact: '待核实事实', ai_disclosure: 'AI 声明', similarity: '同质化', stale: '数据过期',
}
const resLabel: Record<string, string> = { modified: '已修改', kept: '已知悉，保留', verified: '已核实', acknowledged: '已知悉' }
const fmt = (s: string | null) => (s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '—')

/** CheckReport (S3 检查报告): a printable record of the latest pre-publish check, for archiving or sharing with a reviewer. */
export default function CheckReport() {
  const { workId } = useParams()
  const { data, isLoading, error } = useQuery({ queryKey: ['check-report', workId], queryFn: () => get<Report>(`/works/${workId}/checks/report`) })
  if (isLoading) return <PageLoading />
  if (error || !data) return <div className="p-10 text-center text-mist-500">{(error as Error)?.message ?? '无法生成报告'}</div>
  const failed = data.items.filter((i) => !i.passed)
  return (
    <div className="min-h-full bg-mist-100 py-8 print:bg-white print:py-0">
      <div className="mx-auto mb-4 flex max-w-[800px] items-center justify-between px-4 print:hidden">
        <Link to={`/works/${data.work.id}/check`} className="inline-flex items-center gap-1 text-[13px] text-mist-600 hover:text-ink-700"><ArrowLeft className="size-4" />返回检查页</Link>
        <Button variant="primary" icon={<Printer className="size-4" />} onClick={() => window.print()}>打印 / 另存为 PDF</Button>
      </div>
      <article className="mx-auto max-w-[800px] bg-white px-10 py-10 shadow-card print:max-w-none print:px-0 print:shadow-none">
        <header className="border-b-2 border-mist-900 pb-4">
          <p className="text-[12px] tracking-widest text-mist-500">发布前检查报告</p>
          <h1 className="mt-1 font-display text-[24px] font-bold text-mist-900">{data.work.title || '未命名作品'}</h1>
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-[12.5px] text-mist-600">
            <div><dt className="inline text-mist-400">账号：</dt><dd className="inline">{data.work.account}</dd></div>
            <div><dt className="inline text-mist-400">目标平台：</dt><dd className="inline">{platformLabel[data.run.platform as keyof typeof platformLabel] ?? data.run.platform} · {platformFormatLabel(data.run.platform as keyof typeof platformLabel, data.run.content_format)}</dd></div>
            <div><dt className="inline text-mist-400">检查时间：</dt><dd className="inline">{fmt(data.run.at)}</dd></div>
            <div><dt className="inline text-mist-400">内容版本：</dt><dd className="inline">第 {data.run.revision} 版</dd></div>
            <div><dt className="inline text-mist-400">审阅人：</dt><dd className="inline">{data.reviewer ? `${data.reviewer}（${fmt(data.reviewed_at)}）` : '未设置审阅'}</dd></div>
            <div><dt className="inline text-mist-400">报告生成：</dt><dd className="inline">{data.generated_by} · {fmt(data.generated_at)}</dd></div>
          </dl>
        </header>
        <section className="mt-6">
          <h2 className="mb-2 text-[15px] font-semibold text-mist-900">需要处理的项（{failed.length}）</h2>
          {failed.length === 0 ? <p className="text-[13px] text-mist-500">没有未通过的检查项。</p> : (
            <table className="w-full border-collapse text-[12.5px]">
              <thead><tr className="border-b border-mist-300 text-left text-mist-500"><th className="py-1.5 pr-3 font-medium">类别</th><th className="py-1.5 pr-3 font-medium">问题</th><th className="py-1.5 pr-3 font-medium">处理</th><th className="py-1.5 font-medium">确认人</th></tr></thead>
              <tbody>
                {failed.map((i, k) => (
                  <tr key={k} className="border-b border-mist-100 align-top">
                    <td className="py-2 pr-3 text-mist-600">{catLabel[i.category] ?? i.category}</td>
                    <td className="py-2 pr-3 text-mist-800">{i.message}{i.matched_text && <div className="mt-0.5 text-mist-500">命中：「{i.matched_text}」</div>}</td>
                    <td className="py-2 pr-3">{i.resolution ? resLabel[i.resolution] ?? i.resolution : <span className="text-danger">未处理</span>}</td>
                    <td className="py-2 text-mist-600">{i.resolved_by ? `${i.resolved_by}\n${fmt(i.resolved_at)}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        <section className="mt-6">
          <h2 className="mb-2 text-[15px] font-semibold text-mist-900">已通过的项（{data.items.length - failed.length}）</h2>
          <ul className="grid grid-cols-2 gap-x-6 gap-y-0.5 text-[12.5px] text-mist-600">
            {data.items.filter((i) => i.passed).map((i, k) => <li key={k}>✓ {catLabel[i.category] ?? i.category}：{i.message}</li>)}
          </ul>
        </section>
        <footer className="mt-10 border-t border-mist-200 pt-3 text-[11px] leading-relaxed text-mist-400">
          本报告仅记录本平台内的检查与人工确认过程，不代表平台审核结论。发布由作者本人在对应平台后台完成。
        </footer>
      </article>
    </div>
  )
}
