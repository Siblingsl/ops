// R6CD2：comment-patch 状态机 + 更正模式完整前置
const BASE='http://127.0.0.1:8387/api/v1';
async function req(method,path,{body,cookie,csrf}={}){
  const h={'Content-Type':'application/json'};
  if(csrf)h['X-CSRF-Token']=csrf;
  if(cookie)h['Cookie']=cookie;
  const res=await fetch(BASE+path,{method,headers:h,body:body!==undefined?JSON.stringify(body):undefined});
  const text=await res.text();let json=null;try{json=text?JSON.parse(text):null}catch{json={_raw:text.slice(0,100)}}
  return {status:res.status,json};
}
const reg=await fetch(BASE+'/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'r6cd2'+Math.random().toString(36).slice(2,9),password:'{{SECRET_s2wbnk4v}}'})});
const cookie=reg.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
const me=await (await fetch(BASE+'/auth/me',{headers:{Cookie:cookie}})).json();
const cs=me.csrf_token;
const acc=await req('POST','/accounts',{body:{name:'CD2号',platform:'wechat_mp',content_format:'long_article'},cookie,csrf:cs}); const A=acc.json?.id;
// 评论状态机
const cm=await req('POST','/comments',{body:{account_id:A,platform:'wechat_mp',author:'作者',content:'走查评论',article_title:'文章'},cookie,csrf:cs});
console.log('comment-create:',cm.status,'state=',cm.json?.state??cm.json?.status??'?');
const CM=cm.json?.id;
if(CM){
  // 先 patch 到 processing 再 archived（状态机探测）
  for(const st of ['processing','archived']){
    const p=await req('PATCH',`/comment-inbox/${CM}`,{body:{state:st},cookie,csrf:cs});
    console.log(`patch state=${st}:`,p.status,p.json?.error?.code??'');
  }
}
// 更正模式：完整前置（work ready）
const wr=await req('POST',`/accounts/${A}/works`,{body:{title:'CD2更正作品（六字以上）',summary:'摘要',content_format:'long_article'},cookie,csrf:cs}); const W=wr.json?.id;
await req('PATCH',`/works/${W}`,{body:{viewpoint:'更正观点'},cookie,csrf:cs});
await req('PATCH',`/works/${W}`,{body:{content_md:'# 更正\n\n第一节事实与验证。\n\n## 第二节\n\n第二节。'},cookie,csrf:cs});
await req('PUT',`/works/${W}/outline`,{body:{items:[{heading:'一',summary:'s1'},{heading:'二',summary:'s2'}],confirm:true},cookie,csrf:cs});
let w=await (await fetch(BASE+`/works/${W}`,{headers:{Cookie:cookie}})).json();
for(const s of (w.sections??[])) await req('PATCH',`/sections/${s.id}`,{body:{content_md:'记录可核对的事实与验证方式，保持谨慎，不夸大，不绝对化。',base_revision:s.revision},cookie,csrf:cs});
await req('POST',`/works/${W}/checks`,{body:{},cookie,csrf:cs});
let run=null;
for(let i=0;i<20;i++){ await new Promise(r=>setTimeout(r,1000)); const c=await req('GET',`/works/${W}/checks/latest`,{cookie,csrf:cs}); run=c.json?.run; if(run&&run.fact_status!=='pending')break; }
const RESM={sensitive:'kept',fact:'verified',similarity:'acknowledged',ad_law:'acknowledged',ai_disclosure:'acknowledged',stale:'verified',rewrite:'acknowledged'};
for(const item of run?.items??[]){ if(item.category!=='format'&&!item.resolution) await req('PATCH',`/check-items/${item.id}`,{body:{resolution:RESM[item.category]??'acknowledged'},cookie,csrf:cs}); }
const done=await req('POST',`/works/${W}/checks/complete`,{body:{},cookie,csrf:cs});
console.log('complete:',done.status,done.json?.error?.message?.slice(0,50)??'ok');
w=await (await fetch(BASE+`/works/${W}`,{headers:{Cookie:cookie}})).json();
console.log('status:',w.status);
const pub=await req('POST',`/works/${W}/published`,{body:{url:'https://mp.example.com/cd2',published_at:new Date().toISOString(),revision:w.revision},cookie,csrf:cs});
console.log('mark-published:',pub.status,pub.json?.error?.code??'');
if(pub.status===200){
  const corr=await req('POST',`/works/${W}/published`,{body:{mode:'correction',base_publish_revision:1,url:'https://mp.example.com/cd2b',reason:'修正错别字'},cookie,csrf:cs});
  console.log('correction:',corr.status,corr.json?.error?.code??'');
}
process.exit(0);
