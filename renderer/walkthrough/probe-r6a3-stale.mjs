const BASE='http://127.0.0.1:8387/api/v1';
const CS='o.' + 'csrf';
async function req(method,path,{body,cookie,csrf}={}){
  const h={'Content-Type':'application/json'};
  if(csrf)h['X-CSRF-Token']=csrf;
  if(cookie)h['Cookie']=cookie;
  const res=await fetch(BASE+path,{method,headers:h,body:body!==undefined?JSON.stringify(body):undefined});
  const text=await res.text();let json=null;try{json=text?JSON.parse(text):null}catch{json={_raw:text.slice(0,80)}}
  return {status:res.status,json};
}
const reg=await fetch(BASE+'/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'r6a3b'+Math.random().toString(36).slice(2,9),password:'{{SECRET_s2wbnk4v}}'})});
const cookie=reg.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
const me=await (await fetch(BASE+'/auth/me',{headers:{Cookie:cookie}})).json();
const cs=me.csrf_token;
const acc=await req('POST','/accounts',{body:{name:'stale号',platform:'wechat_mp',content_format:'long_article'},cookie,csrf:cs}); const A=acc.json?.id;
await req('PUT',`/accounts/${A}/wechat-credential`,{body:{app_id:'wx_r6a3',app_secret:'{{SECRET_s2wbnk4v}}'},cookie,csrf:cs}); await req('POST',`/accounts/${A}/wechat-credential/test`,{body:{},cookie,csrf:cs});
const wr=await req('POST',`/accounts/${A}/works`,{body:{title:'stale判定走查作品（六字以上）',summary:'摘要内容',content_format:'long_article'},cookie,csrf:cs}); const W=wr.json?.id;
await req('PATCH',`/works/${W}`,{body:{viewpoint:'stale 观点'},cookie,csrf:cs});
await req('PATCH',`/works/${W}`,{body:{content_md:'# stale\n\n第一节事实与验证。\n\n## 第二节\n\n第二节。'},cookie,csrf:cs});
await req('PUT',`/works/${W}/outline`,{body:{items:[{heading:'一',summary:'s1'},{heading:'二',summary:'s2'}],confirm:true},cookie,csrf:cs});
let w, w2;
w=await (await fetch(BASE+`/works/${W}`,{headers:{Cookie:cookie}})).json();
for(const s of (w.sections??[])) await req('PATCH',`/sections/${s.id}`,{body:{content_md:'记录可核对的事实与验证方式，保持谨慎，不夸大，不绝对化。',base_revision:s.revision},cookie,csrf:cs});
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64');
const cf=new FormData(); cf.append('file',new File([png],'c.png',{type:'image/png'}));
const cj=await (await fetch(BASE+`/works/${W}/assets`,{method:'POST',headers:{'X-CSRF-Token':cs,Cookie:cookie},body:cf})).json();
w2=await (await fetch(BASE+`/works/${W}`,{headers:{Cookie:cookie}})).json();
await req('PATCH',`/works/${W}`,{body:{cover_asset_id:cj.id,cover_crops:{'2.35_1':{x1:0,y1:0,x2:1,y2:0.425},'1_1':{x1:0,y1:0,x2:1,y2:1}},base_revision:w2.revision},cookie,csrf:cs});
await req('POST',`/works/${W}/checks`,{body:{},cookie,csrf:cs});
let run=null;
for(let i=0;i<25;i++){ await new Promise(r=>setTimeout(r,1000)); const c=await req('GET',`/works/${W}/checks/latest`,{cookie,csrf:cs}); run=c.json?.run; if(run&&run.fact_status!=='pending')break; }
const RESM={sensitive:'kept',fact:'verified',similarity:'acknowledged',ad_law:'acknowledged',ai_disclosure:'acknowledged',stale:'verified',rewrite:'acknowledged'};
for(const item of run?.items??[]){ if(item.category!=='format'&&!item.resolution) await req('PATCH',`/check-items/${item.id}`,{body:{resolution:RESM[item.category]??'acknowledged'},cookie,csrf:cs}); }
const done=await req('POST',`/works/${W}/checks/complete`,{body:{},cookie,csrf:cs});
console.log('rev-at-complete:', w2.revision);
console.log('complete:',done.status,done.json?.error?.message?.slice(0,40)??'ok');
w2=await (await fetch(BASE+`/works/${W}`,{headers:{Cookie:cookie}})).json();
const wNow=await (await fetch(BASE+`/works/${W}`,{headers:{Cookie:cookie}})).json();
console.log('work.revision now:',wNow.revision,'status:',wNow.status,'run.revision:',run?.revision);
const pu=await req('POST',`/works/${W}/wechat/push`,{body:{revision:wNow.revision},cookie,csrf:cs});
console.log('push:',pu.status,pu.json?.error?.message?.slice(0,50)??JSON.stringify(pu.json).slice(0,120));
process.exit(0);
