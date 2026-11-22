// 格式项明细
const BASE='http://127.0.0.1:8387/api/v1';
async function req(method,path,{body,cookie,csrf}={}){
  const h={'Content-Type':'application/json'};
  if(csrf)h['X-CSRF-Token']=csrf;
  if(cookie)h['Cookie']=cookie;
  const res=await fetch(BASE+path,{method,headers:h,body:body!==undefined?JSON.stringify(body):undefined});
  const text=await res.text();let json=null;try{json=text?JSON.parse(text):null}catch{json={_raw:text.slice(0,80)}}
  return {status:res.status,json};
}
const timeout=(ms)=>new Promise(r=>setTimeout(r,ms));
const reg=await fetch(BASE+'/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'r6a5'+Math.random().toString(36).slice(2,9),password:'{{SECRET_s2wbnk4v}}'})});
const cookie=reg.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
const me=await (await fetch(BASE+'/auth/me',{headers:{Cookie:cookie}})).json();
const cs=me.csrf_token;
const acc=await req('POST','/accounts',{body:{name:'格式明细号',platform:'wechat_mp',content_format:'long_article'},cookie,csrf:cs}); const A=acc.json?.id;
await req('PUT',`/accounts/${A}/wechat-credential`,{body:{app_id:'wx_fmt',app_secret:'{{SECRET_s2wbnk4v}}'},cookie,csrf:cs});
const wr=await req('POST',`/accounts/${A}/works`,{body:{title:'格式明细走查作品（六字以上）',summary:'这是摘要',content_format:'long_article'},cookie,csrf:cs}); const W=wr.json?.id;
await req('PATCH',`/works/${W}`,{body:{viewpoint:'格式明细观点',wechat_fields:{author:'走查作者'}},cookie,csrf:cs});
await req('PATCH',`/works/${W}`,{body:{content_md:'# 格式\n\n第一节事实与验证。\n\n## 第二节\n\n第二节。'},cookie,csrf:cs});
await req('PUT',`/works/${W}/outline`,{body:{items:[{heading:'一',summary:'s1'},{heading:'二',summary:'s2'}],confirm:true},cookie,csrf:cs});
const w=await (await fetch(BASE+`/works/${W}`,{headers:{Cookie:cookie}})).json();
for(const s of (w.sections??[])) await req('PATCH',`/sections/${s.id}`,{body:{content_md:'记录可核对的事实与验证方式，保持谨慎，不夸大，不绝对化。',base_revision:s.revision},cookie,csrf:cs});
const pngC=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64');
const cf2=new FormData(); cf2.append('file',new File([pngC],'c.png',{type:'image/png'}));
const cj2=await (await fetch(BASE+`/works/${W}/assets`,{method:'POST',headers:{'X-CSRF-Token':cs,Cookie:cookie},body:cf2})).json();
const wPre=await (await fetch(BASE+`/works/${W}`,{headers:{Cookie:cookie}})).json();
const cpatch=await req('PATCH',`/works/${W}`,{body:{cover_asset_id:cj2.id,cover_crops:{'2.35_1':{x1:0,y1:0,x2:1,y2:0.425},'1_1':{x1:0,y1:0,x2:1,y2:1}},base_revision:wPre.revision},cookie,csrf:cs});
console.log('COVER-PATCH:',cpatch.status,JSON.stringify(cpatch.json?.error??{}).slice(0,80));
await req('POST',`/works/${W}/checks`,{body:{},cookie,csrf:cs});
let run=null;
for(let i=0;i<25;i++){ await new Promise(r=>setTimeout(r,1000)); const c=await req('GET',`/works/${W}/checks/latest`,{cookie,csrf:cs}); run=c.json?.run; if(run&&run.fact_status!=='pending')break; }
const fmtFail=(run?.items??[]).filter(i=>i.category==='format'&&!i.passed);
for(const f of fmtFail) console.log('FORMAT-FAIL:',f.message.slice(0,60),'|',String(f.detail??'').slice(0,60));
// 继续：resolve 非 format 项 → complete → push
const RESM={sensitive:'kept',fact:'verified',similarity:'acknowledged',ad_law:'acknowledged',ai_disclosure:'acknowledged',stale:'verified',rewrite:'acknowledged'};
for(const item of run?.items??[]){ if(item.category!=='format'&&!item.resolution) await req('PATCH',`/check-items/${item.id}`,{body:{resolution:RESM[item.category]??'acknowledged'},cookie,csrf:cs}); }
const wNow=await (await fetch(BASE+`/works/${W}`,{headers:{Cookie:cookie}})).json();
const done=await req('POST',`/works/${W}/checks/complete`,{body:{},cookie,csrf:cs});
console.log('complete:',done.status,done.json?.error?.message?.slice(0,50)??'ok');
const wNow2=await (await fetch(BASE+`/works/${W}`,{headers:{Cookie:cookie}})).json();
console.log('status:',wNow2.status);
const p1=await req('POST',`/works/${W}/wechat/push`,{body:{revision:wNow2.revision},cookie,csrf:cs});
console.log('push1:',p1.status,p1.json?.error?.message?.slice(0,50)??'SSE-ok');
if(p1.status===200){
  const ps=[];
  for(let i=0;i<3;i++){ const p=await req('POST',`/works/${W}/wechat/push`,{body:{revision:wNow2.revision},cookie,csrf:cs}); ps.push(p.status); }
  console.log('push2-4:',ps.join(','));
}
process.exit(0);
