// R7-A：数值/阈值合理性——推送上限语义（达到上限→409 可带 confirm_over_limit 继续，非硬禁）
const BASE='http://127.0.0.1:8387/api/v1';
const F=[];
function rec(id,ok,detail){F.push({id,ok});console.log(`${ok?'ok ':'FAIL'} ${id} :: ${detail}`);}
async function req(method,path,{body,cookie,csrf}={}){
  const h={'Content-Type':'application/json'};
  if(csrf)h['X-CSRF-Token']=csrf;
  if(cookie)h['Cookie']=cookie;
  const res=await fetch(BASE+path,{method,headers:h,body:body!==undefined?JSON.stringify(body):undefined});
  const text=await res.text();let json=null;try{json=text?JSON.parse(text):null}catch{json={_raw:text.slice(0,80)}}
  return {status:res.status,json};
}
async function up(W,csrf,cookie,bytes=100,name='c.png'){
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64');
  const form=new FormData(); form.append('file',new File([png],name,{type:'image/png'}));
  const res=await fetch(BASE+`/works/${W}/assets`,{method:'POST',headers:{'X-CSRF-Token':csrf,Cookie:cookie},body:form});
  const t=await res.text();let j=null;try{j=t?JSON.parse(t):null}catch{j={}}
  return j?.id;
}
const reg=await fetch(BASE+'/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'r7a'+Math.random().toString(36).slice(2,9),password:'{{SECRET_s2wbnk4v}}'})});
const cookie=reg.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
const me=await (await fetch(BASE+'/auth/me',{headers:{Cookie:cookie}})).json();
const cs=me.csrf_token;
const acc=await req('POST','/accounts',{body:{name:'R7A上限号',platform:'wechat_mp',content_format:'long_article',daily_push_limit:2},cookie,csrf:cs}); const A=acc.json?.id;
await req('PUT',`/accounts/${A}/wechat-credential`,{body:{app_id:'wx_r7a',app_secret:'{{SECRET_s2wbnk4v}}'},cookie,csrf:cs});
const wr=await req('POST',`/accounts/${A}/works`,{body:{title:'R7A上限语义作品（六字以上）',summary:'摘要内容',content_format:'long_article'},cookie,csrf:cs}); const W=wr.json?.id;
await req('PATCH',`/works/${W}`,{body:{viewpoint:'上限语义走查',wechat_fields:{author:'走查作者'}},cookie,csrf:cs});
await req('PATCH',`/works/${W}`,{body:{content_md:'# 上限\n\n第一节事实与验证。\n\n## 第二节\n\n第二节。'},cookie,csrf:cs});
await req('PUT',`/works/${W}/outline`,{body:{items:[{heading:'一',summary:'s1'},{heading:'二',summary:'s2'}],confirm:true},cookie,csrf:cs});
const png=await up(W,cs,cookie);
let w=await (await fetch(BASE+`/works/${W}`,{headers:{Cookie:cookie}})).json();
await req('PATCH',`/works/${W}`,{body:{cover_asset_id:png,cover_crops:{'2.35_1':{x1:0,y1:0,x2:1,y2:0.425},'1_1':{x1:0,y1:0,x2:1,y2:1}},base_revision:w.revision},cookie,csrf:cs});
w=await (await fetch(BASE+`/works/${W}`,{headers:{Cookie:cookie}})).json();
for(const s of (w.sections??[])) await req('PATCH',`/sections/${s.id}`,{body:{content_md:'记录可核对的事实与验证方式，保持谨慎，不夸大，不绝对化。',base_revision:s.revision},cookie,csrf:cs});
await req('POST',`/works/${W}/checks`,{body:{},cookie,csrf:cs});
let run=null;
for(let i=0;i<25;i++){ await new Promise(r=>setTimeout(r,1000)); const c=await req('GET',`/works/${W}/checks/latest`,{cookie,csrf:cs}); run=c.json?.run; if(run&&run.fact_status!=='pending')break; }
const RESM={sensitive:'kept',fact:'verified',similarity:'acknowledged',ad_law:'acknowledged',ai_disclosure:'acknowledged',stale:'verified',rewrite:'acknowledged'};
for(const item of run?.items??[]){ if(item.category!=='format'&&!item.resolution) await req('PATCH',`/check-items/${item.id}`,{body:{resolution:RESM[item.category]??'acknowledged'},cookie,csrf:cs}); }
await req('POST',`/works/${W}/checks/complete`,{body:{},cookie,csrf:cs});
w=await (await fetch(BASE+`/works/${W}`,{headers:{Cookie:cookie}})).json();
// 上限=2：push1(200) push2(200) push3(409 push_limit_reached) push3+confirm(200)
const p1=await req('POST',`/works/${W}/wechat/push`,{body:{revision:w.revision},cookie,csrf:cs});
const p2=await req('POST',`/works/${W}/wechat/push`,{body:{revision:w.revision},cookie,csrf:cs});
const p3=await req('POST',`/works/${W}/wechat/push`,{body:{revision:w.revision},cookie,csrf:cs});
rec('L1-limit-3rd-409',p3.status===409&&p3.json?.error?.code==='push_limit_reached',`p1=${p1.status} p2=${p2.status} p3=${p3.status}(${p3.json?.error?.code})`);
const p3c=await req('POST',`/works/${W}/wechat/push`,{body:{revision:w.revision,confirm_over_limit:true},cookie,csrf:cs});
rec('L1-confirm-continue',p3c.status===200,`confirm push=${p3c.status}`);
// L2 daily_push_limit 边界：0 与负数（CHECK >=1 应拒）
const bad1=await req('POST','/accounts',{body:{name:'limit0',platform:'wechat_mp',content_format:'long_article',daily_push_limit:0},cookie,csrf:cs});
rec('L2-limit-0-rejected',bad1.status===422||bad1.status===400,`status=${bad1.status}`);
// L3 标题 32/33 字语义
const t32=await req('POST',`/accounts/${A}/works`,{body:{title:'一二三四五六七八九十'.repeat(3).slice(0,32),content_format:'long_article'},cookie,csrf:cs});
rec('L3-title-32-ok',t32.status===200,`32字 status=${t32.status}`);
// 标题 33 字在 check 层面是 format fail（创建可过，检查报）
process.exit(0);
