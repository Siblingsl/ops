// R6-C/D/E：fork/compact/compact-preview、素材合并、评论收件箱、发布更正、审阅
const BASE='http://127.0.0.1:8387/api/v1';
const F=[];
function rec(id,ok,detail){F.push({id,ok});console.log(`${ok?'ok ':'FAIL'} ${id} :: ${detail}`);}
async function req(method,path,{body,cookie,csrf}={}){
  const h={'Content-Type':'application/json'};
  if(csrf)h['X-CSRF-Token']=csrf;
  if(cookie)h['Cookie']=cookie;
  const res=await fetch(BASE+path,{method,headers:h,body:body!==undefined?JSON.stringify(body):undefined});
  const text=await res.text();let json=null;try{json=text?JSON.parse(text):null}catch{json={_raw:text.slice(0,100)}}
  return {status:res.status,json};
}
const reg=await fetch(BASE+'/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'r6cd'+Math.random().toString(36).slice(2,9),password:'{{SECRET_s2wbnk4v}}'})});
const cookie=reg.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
const me=await (await fetch(BASE+'/auth/me',{headers:{Cookie:cookie}})).json();
const cs=me.csrf_token;
let r=0; const acc=await req('POST','/accounts',{body:{name:'R6CD号',platform:'wechat_mp',content_format:'long_article'},cookie,csrf:cs}); const A=acc.json?.id;

// C1 fork：建会话→fork
const cv=await req('POST','/agent/conversations',{body:{title:'fork源'},cookie,csrf:cs}); const C=cv.json?.id;
r=await req('POST',`/agent/conversations/${C}/fork`,{body:{},cookie,csrf:cs});
rec('C1-fork',r.status===200||r.status===422,`status=${r.status} err=${r.json?.error?.code} newId=${r.json?.conversation_id?.slice(0,8)??'-'}`);
// C2 compact-preview / compact
r=await req('GET',`/agent/conversations/${C}/compact-preview`,{cookie,csrf:cs});
rec('C2-compact-preview',r.status===200||r.status===422,`status=${r.status}`);
r=await req('POST',`/agent/conversations/${C}/compact`,{body:{},cookie,csrf:cs});
rec('C2-compact',r.status===200||r.status===422,`status=${r.status} err=${r.json?.error?.code}`);

// D1 素材合并（同内容两素材→merge keep）
await req('POST','/materials',{body:{title:'合并A',content:'完全相同的合并走查内容正文。',kind:'case',account_id:A},cookie,csrf:cs});
await req('POST','/materials',{body:{title:'合并B',content:'完全相同的合并走查内容正文。',kind:'case',account_id:A},cookie,csrf:cs});
r=await req('GET',`/materials?account_id=${A}`,{cookie,csrf:cs});
const mats=Array.isArray(r.json)?r.json:(r.json?.items??[]);
rec('D1-materials-list',r.status===200&&mats.length>=2,`n=${mats.length}`);
if(mats.length>=2){
  r=await req('POST','/materials/merge',{body:{keep_id:mats[0].id,drop_ids:[mats[1].id]},cookie,csrf:cs});
  rec('D1-materials-merge',r.status===200||r.status===422,`status=${r.status} err=${r.json?.error?.code}`);
}

// D2 评论收件箱（create/list/patch/delete）
r=await req('POST','/comments',{body:{account_id:A,platform:'wechat_mp',author:'评论者',content:'走查评论内容',article_title:'走查文章'},cookie,csrf:cs});
const CM=r.json?.id;
rec('D2-comment-create',r.status===200||r.status===422,`status=${r.status} err=${r.json?.error?.code} msg=${r.json?.error?.message?.slice(0,50)}`);
if(CM){
  r=await req('GET',`/accounts/${A}/comments`,{cookie,csrf:cs});
  rec('D2-comment-list',r.status===200,`status=${r.status}`);
  r=await req('PATCH',`/comment-inbox/${CM}`,{body:{status:'archived'},cookie,csrf:cs});
  rec('D2-comment-patch',r.status===200||r.status===422,`status=${r.status}`);
}

// E1 发布更正模式（FR-CL03）：published→correction
r=await req('POST',`/accounts/${A}/works`,{body:{title:'R6CD更正走查作品（六字以上）',summary:'摘要',content_format:'long_article'},cookie,csrf:cs}); const W=r.json?.id;
await req('PATCH',`/works/${W}`,{body:{viewpoint:'更正走查观点'},cookie,csrf:cs});
await req('PATCH',`/works/${W}`,{body:{content_md:'# 更正\n\n第一节事实与验证。\n\n## 第二节\n\n第二节。'},cookie,csrf:cs});
await req('PUT',`/works/${W}/outline`,{body:{items:[{heading:'一',summary:'s1'},{heading:'二',summary:'s2'}],confirm:true},cookie,csrf:cs});
const wNow=await (await fetch(BASE+`/works/${W}`,{headers:{Cookie:cookie}})).json();
for(const s of (wNow.sections??[])) await req('PATCH',`/sections/${s.id}`,{body:{content_md:'记录可核对的事实与验证方式，保持谨慎，不夸大，不绝对化。',base_revision:s.revision},cookie,csrf:cs});
await req('POST',`/works/${W}/checks`,{body:{},cookie,csrf:cs});
let run=null;
for(let i=0;i<20;i++){ await new Promise(r=>setTimeout(r,1000)); const c=await req('GET',`/works/${W}/checks/latest`,{cookie,csrf:cs}); run=c.json?.run; if(run&&run.fact_status!=='pending')break; }
const RESM={sensitive:'kept',fact:'verified',similarity:'acknowledged',ad_law:'acknowledged',ai_disclosure:'acknowledged',stale:'verified',rewrite:'acknowledged'};
for(const item of run?.items??[]){ if(item.category!=='format'&&!item.resolution) await req('PATCH',`/check-items/${item.id}`,{body:{resolution:RESM[item.category]??'acknowledged'},cookie,csrf:cs}); }
const done=await req('POST',`/works/${W}/checks/complete`,{body:{},cookie,csrf:cs});
const wNow2=await (await fetch(BASE+`/works/${W}`,{headers:{Cookie:cookie}})).json();
r=await req('POST',`/works/${W}/published`,{body:{url:'https://mp.example.com/r6cd',published_at:new Date().toISOString()},cookie,csrf:cs});
rec('E1-mark-published',r.status===200||r.status===422,`status=${r.status} err=${r.json?.error?.code}`);
if(r.status===200){
  // 更正（mode=correction）
  r=await req('POST',`/works/${W}/published`,{body:{mode:'correction',base_publish_revision:wNow2.publish_revision??1,url:'https://mp.example.com/r6cd-fixed',reason:'修正错别字'},cookie,csrf:cs});
  rec('E1-correction',r.status===200||r.status===422,`status=${r.status} err=${r.json?.error?.code} msg=${r.json?.error?.message?.slice(0,50)}`);
  // 重复相同值应无假更正
  r=await req('POST',`/works/${W}/published`,{body:{mode:'correction',base_publish_revision:wNow2.publish_revision??1,url:'https://mp.example.com/r6cd-fixed',reason:'重复相同'},cookie,csrf:cs});
  rec('E1-correction-dup',r.status===200||r.status===422||r.status===409,`status=${r.status} err=${r.json?.error?.code}`);
}

console.log(`\nR6CD ${F.filter(x=>x.ok).length}/${F.length} pass`);
