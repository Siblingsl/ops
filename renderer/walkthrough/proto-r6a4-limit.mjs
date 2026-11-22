// 单日推送上限（默认 3）
const BASE='http://127.0.0.1:8387/api/v1';
async function req(method,path,{body,cookie,csrf}={}){
  const h={'Content-Type':'application/json'};
  if(csrf)h['X-CSRF-Token']=csrf;
  if(cookie)h['Cookie']=cookie;
  const res=await fetch(BASE+path,{method,headers:h,body:body!==undefined?JSON.stringify(body):undefined});
  const text=await res.text();let json=null;try{json=text?JSON.parse(text):null}catch{json={_raw:text.slice(0,80)}}
  return {status:res.status,json};
}
const reg=await fetch(BASE+'/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'r6a4'+Math.random().toString(36).slice(2,9),password:'{{SECRET_s2wbnk4v}}'})});
const cookie=reg.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
const me=await (await fetch(BASE+'/auth/me',{headers:{Cookie:cookie}})).json();
const cs=me.csrf_token;
const acc=await req('POST','/accounts',{body:{name:'上限号',platform:'wechat_mp',content_format:'long_article'},cookie,csrf:cs}); const A=acc.json?.id;
await req('PUT',`/accounts/${A}/wechat-credential`,{body:{app_id:'wx_limit',app_secret:'{{SECRET_s2wbnk4v}}'},cookie,csrf:cs});
const wr=await req('POST',`/accounts/${A}/works`,{body:{title:'单日上限走查作品（六字以上）',summary:'摘要',content_format:'long_article'},cookie,csrf:cs}); const W=wr.json?.id;
await req('PATCH',`/works/${W}`,{body:{viewpoint:'上限走查观点'},cookie,csrf:cs});
await req('PATCH',`/works/${W}`,{body:{content_md:'# 上限\n\n第一节事实与验证。\n\n## 第二节\n\n第二节。'},cookie,csrf:cs});
await req('PUT',`/works/${W}/outline`,{body:{items:[{heading:'一',summary:'s1'},{heading:'二',summary:'s2'}],confirm:true},cookie,csrf:cs});
const w=await (await fetch(BASE+`/works/${W}`,{headers:{Cookie:cookie}})).json();
for(const s of (w.sections??[])) await req('PATCH',`/sections/${s.id}`,{body:{content_md:'记录可核对的事实与验证方式，保持谨慎，不夸大，不绝对化。',base_revision:s.revision},cookie,csrf:cs});
await req('POST',`/works/${W}/checks`,{body:{},cookie,csrf:cs});
let run=null;
for(let i=0;i<25;i++){ await new Promise(r=>setTimeout(r,1000)); const c=await req('GET',`/works/${W}/checks/latest`,{cookie,csrf:cs}); run=c.json?.run; if(run&&run.fact_status!=='pending')break; }
const RESM={sensitive:'kept',fact:'verified',similarity:'acknowledged',ad_law:'acknowledged',ai_disclosure:'acknowledged',stale:'verified',rewrite:'acknowledged'};
for(const item of run?.items??[]){ if(item.category!=='format'&&!item.resolution) await req('PATCH',`/check-items/${item.id}`,{body:{resolution:RESM[item.category]??'acknowledged'},cookie,csrf:cs}); }
const done=await req('POST',`/works/${W}/checks/complete`,{body:{},cookie,csrf:cs});
console.log('complete:',done.status,done.json?.error?.message?.slice(0,60)??'ok');
const wNow=await (await fetch(BASE+`/works/${W}`,{headers:{Cookie:cookie}})).json();
// 推 4 次（上限默认 3）
const statuses=[];
for(let i=0;i<4;i++){
  const p=await req('POST',`/works/${W}/wechat/push`,{body:{revision:wNow.revision},cookie,csrf:cs});
  statuses.push(p.status+(p.json?.error?.code?'('+p.json.error.code+')':''));
}
console.log('push x4:',statuses.join(','));
const wNow2=await (await fetch(BASE+`/works/${W}`,{headers:{Cookie:cookie}})).json();
console.log('work status after complete:',wNow2.status);
const l4=statuses[3];
console.log('4th push:',l4.includes('200')?'no-limit(第4次仍成功—检查上限实现)':'blocked-or-confirmed');
process.exit(0);
// 追加状态 dump
