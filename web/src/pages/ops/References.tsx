import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button, Card, CardHeader, Empty, Field, Input, Notice, Textarea } from '@/components/ui'
import { del, errorMessage, get, post } from '@/lib/api'
import { useInvalidate, useMe } from '@/lib/session'
import type { ReferenceItem } from '@/lib/types'

export function References({ accountId }: { accountId: string }) {
 const {data:me}=useMe();const edit=me?.role!=='viewer';const inv=useInvalidate()
 const q=useQuery({queryKey:['references',accountId],queryFn:()=>get<ReferenceItem[]>(`/accounts/${accountId}/references`),refetchInterval:q=>q.state.data?.some(x=>x.status==='queued')?30000:false})
 const [links,setLinks]=useState('');const [paste,setPaste]=useState<string|null>(null);const [body,setBody]=useState('');const [title,setTitle]=useState('');const [busy,setBusy]=useState(false)
 const run=async(action:()=>Promise<unknown>)=>{setBusy(true);try{await action();await inv(['references',accountId]);setPaste(null);setBody('');toast.success('已保存')}catch(e){toast.error(errorMessage(e))}finally{setBusy(false)}}
 return <Card><CardHeader title="对标参考" desc="只提炼标题、结构与方法；正文保留 7 天，创作只引用提炼结果。"/><div className="space-y-4 p-5">
 <Notice>真实小红书、公众号 robots 禁止读取，请添加单篇原文链接后手动粘贴正文。提炼结果只供内部参考。</Notice>
 {edit&&<><Field label="单篇链接（每行一条，最多 20 条）"><Textarea rows={2} value={links} onChange={e=>setLinks(e.target.value)}/></Field><Button loading={busy} disabled={!links.trim()} onClick={()=>run(async()=>{await post(`/accounts/${accountId}/references`,{links:links.split(/\n/).map(x=>x.trim()).filter(Boolean)});setLinks('')})}>添加参考链接</Button></>}
 {q.isError?<Notice tone="red">{errorMessage(q.error)}</Notice>:!q.data?.length?<Empty title="还没有对标参考"/>:q.data.map(x=><div key={x.id} className="space-y-2 rounded-lg border border-mist-200 p-4"><a className="font-semibold text-ink-600" href={x.url} target="_blank" rel="noreferrer">{x.title||'查看原文链接'}</a><p className="text-sm text-mist-500">{({queued:'排队中',done:'已提炼',failed:'读取失败',blocked:'读取受限'})[x.status]}{x.status==='queued'&&` · 第 ${x.position} 个 · ${x.expected_at?`预计 ${new Date(x.expected_at).toLocaleString('zh-CN')} 前`:'平台未开启或已暂停'}`}</p>{x.error&&<Notice>{x.error}</Notice>}{x.analysis&&<div className="space-y-2 text-sm"><p>标题结构：{x.analysis.title_pattern}</p><p>开头钩子：{x.analysis.hook_type}</p><p>段落结构：{x.analysis.structure.join(' → ')}</p><p>选题角度：{x.analysis.angle}</p><p>标签：{x.analysis.tags.join('、')}</p>{x.analysis.takeaways.map((v,i)=><p key={i}>可借鉴：{v}</p>)}</div>}{edit&&<div className="flex gap-2"><Button size="sm" disabled={busy} onClick={()=>{setPaste(x.id);setTitle(x.title);setBody('')}}>手动粘贴正文</Button><Button size="sm" variant="ghost" disabled={busy} onClick={()=>run(()=>del(`/references/${x.id}`))}>移入回收站</Button></div>}{paste===x.id&&<div className="space-y-3"><Field label="原文标题"><Input value={title} onChange={e=>setTitle(e.target.value)}/></Field><Field label="正文（仅用于方法提炼和相似度自查）"><Textarea rows={6} value={body} onChange={e=>setBody(e.target.value)}/></Field><Button loading={busy} disabled={body.trim().length<20} onClick={()=>run(()=>post(`/references/${x.id}/paste`,{body,title}))}>提炼方法</Button><Button onClick={()=>setPaste(null)}>取消</Button></div>}</div>)}
 </div></Card>
}
