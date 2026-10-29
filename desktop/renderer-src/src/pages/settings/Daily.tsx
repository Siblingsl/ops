import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button, Card, Field, Input, Notice, PageHeader, roleReadOnlyHint, Select } from '@/components/ui'
import { errorMessage, get, put } from '@/lib/api'
import { useInvalidate, useMe } from '@/lib/session'
import { useSettingsDraft } from '@/lib/desktop-settings'

export default function DailySettings(){
 const {data:me}=useMe();const inv=useInvalidate();const q=useQuery({queryKey:['daily-settings'],queryFn:()=>get<{generate:string;hour:number;primary_count:number;alternate_count:number}>('/daily-settings')});const [form,setForm]=useState(q.data);const [busy,setBusy]=useState(false)
 useEffect(()=>setForm(q.data),[q.data]);const owner=me?.role==='owner'
 useSettingsDraft(owner && !!form && JSON.stringify(form)!==JSON.stringify(q.data),busy)
 return <div className="max-w-2xl animate-fade-in space-y-5"><PageHeader title="每日推荐设置" desc="工作区默认设置，账号可在运营方案中覆盖。"/>{q.isError?<Notice tone="red">{errorMessage(q.error)}</Notice>:form&&<Card><div className="space-y-4 p-5"><Field label="生成方式"><Select disabled={!owner} disabledHint={roleReadOnlyHint.owner} value={form.generate} onChange={e=>setForm({...form,generate:e.target.value})}><option value="off">关闭：只手动生成</option><option value="on_open">打开账号时准备（推荐）</option><option value="background">每天后台准备</option></Select></Field><Field label="后台生成小时（北京时间）"><Input disabled={!owner} disabledHint={roleReadOnlyHint.owner} type="number" min={0} max={23} value={form.hour} onChange={e=>setForm({...form,hour:Number(e.target.value)})}/></Field><Notice>后台只为近 7 天打开过的账号准备；任务受工作区并发数和每日 AI 用量上限约束。</Notice>{(['primary_count','alternate_count'] as const).map(key=><Field key={key} label={key==='primary_count'?'主推数量（0 = 按发布日 1–2 条）':'备选数量（0 = 默认 2 条）'}><Input disabled={!owner} disabledHint={roleReadOnlyHint.owner} type="number" min={0} max={5} value={form[key]} onChange={e=>setForm({...form,[key]:Number(e.target.value)})}/></Field>)}{owner&&<Button loading={busy} onClick={async()=>{setBusy(true);try{await put('/daily-settings',form);await inv(['daily-settings']);toast.success('已保存')}catch(e){toast.error(errorMessage(e))}finally{setBusy(false)}}}>保存默认设置</Button>}{!owner&&<Notice tone="ink">只有工作区所有者可以修改每日推荐默认设置；账号可在运营方案中覆盖。</Notice>}</div></Card>}</div>
}
