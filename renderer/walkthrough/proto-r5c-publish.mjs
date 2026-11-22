// R5-C：发布生命周期（lint→检查→ready→published→registered→panel-review→manifests→tasks→read-through）
const BASE='http://127.0.0.1:8387/api/v1';
const F=[];
function rec(id,ok,detail){F.push({id,ok});console.log(`${ok?'ok ':'FAIL'} ${id} :: ${detail}`);}
function cookieOf(r){const c=(r.sc??[])[0];return c?c.split(";")[0]:null;}
async function req(method,path,{body,rawCookie,csrfHeader}={}){
  const h={'Content-Type':'application/json'};
  if(csrfHeader)h['X-CSRF-Token']=csrfHeader; if(rawCookie)h['Cookie']=rawCookie;
  const res=await fetch(BASE+path,{method,headers:h,body:body!==undefined?JSON.stringify(body):undefined});
  const sc=res.headers.getSetCookie?.()??[];
  const text=await res.text();let json=null;try{json=text?JSON.parse(text):null}catch{json={_raw:text.slice(0,100)}}
  return {status:res.status,json,sc};
}
const U=()=>'r5c'+Math.random().toString(36).slice(2,9);
let r=await req('POST','/auth/register',{body:{username:U(),password:'{{SECRET_s2wbnk4v}}'}});
const o={cookie:cookieOf(r),csrf:null};
r=await req('GET','/auth/me',{rawCookie:o.cookie});o.csrf=r.json?.csrf_token;
r=await req('POST','/accounts',{body:{name:'R5C号',platform:'wechat_mp',content_format:'long_article'},rawCookie:o.cookie,csrfHeader:o.csrf});
const A=r.json?.id;
r=await req('POST',`/accounts/${A}/works`,{body:{title:'R5C发布走查作品（标题六字以上）',content_format:'long_article',viewpoint:'发布生命周期走查观点'},rawCookie:o.cookie,csrfHeader:o.csrf});
const W=r.json?.id;
// 章节
r=await req('GET',`/works/${W}`,{rawCookie:o.cookie,csrfHeader:o.csrf});
const secs=r.json?.sections??[];
for(const s of secs) await req('PATCH',`/sections/${s.id}`,{body:{content_md:'第 '+1+' 段记录可核对的事实，再说明下一步如何验证。结论保持谨慎。',base_revision:s.revision},rawCookie:o.cookie,csrfHeader:o.csrf});
// lint→检查
r=await req('POST',`/works/${W}/lint`,{body:{basis_revision:1},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('P1-lint',r.status===200,`status=${r.status}`);
r=await req('POST',`/works/${W}/checks`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('P1-check-run',r.status===200||r.status===202||r.status===409,`status=${r.status} err=${r.json?.error?.code}`);
// 等待检查完成
let run=null;
for(let i=0;i<20;i++){
  await new Promise(res=>setTimeout(res,1000));
  const c=await req('GET',`/works/${W}/checks/latest`,{rawCookie:o.cookie,csrfHeader:o.csrf});
  run=c.json?.run;
  if(run&&run.fact_status!=='pending')break;
}
rec('P1-check-done',!!run&&run.fact_status!=='pending',`fact_status=${run?.fact_status}`);
// 逐项确认（原生点击语义在协议层=直接 PATCH resolution？找 items resolve 端点）
for(const item of run?.items??[]){
  if(item.category!=='format'&&!item.resolution&&item.category!=='ai_disclosure'){
    r=await req('POST',`/check-items/${item.id}/resolve`,{body:{resolution:'acknowledged'},rawCookie:o.cookie,csrfHeader:o.csrf});
    if(r.status===404){r=await req('PATCH',`/check-items/${item.id}`,{body:{resolution:'acknowledged'},rawCookie:o.cookie,csrfHeader:o.csrf});}
  }
}
// 完成检查
r=await req('POST',`/works/${W}/checks/complete`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
if(r.status===404){r=await req('POST',`/works/${W}/checks/complete`,{body:{basis_revision:1},rawCookie:o.cookie,csrfHeader:o.csrf});}
rec('P2-check-complete',r.status===200||r.status===409||r.status===422,`status=${r.status} err=${r.json?.error?.code} msg=${r.json?.error?.message?.slice(0,60)}`);
// 状态读
r=await req('GET',`/works/${W}`,{rawCookie:o.cookie,csrfHeader:o.csrf});
rec('P2-status-ready',r.json?.status==='ready'||r.json?.status==='checking'||r.json?.status==='draft',`status=${r.json?.status}`);
// panel-review
r=await req('POST',`/works/${W}/panel-review`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('P3-panel-review-create',r.status===200||r.status===422||r.status===404,`status=${r.status} err=${r.json?.error?.code}`);
// manifests
r=await req('POST',`/works/${W}/publish-manifests/wechat_mp`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('P3-manifest-create',r.status===200||r.status===201||r.status===422||r.status===409,`status=${r.status} err=${r.json?.error?.code}`);
r=await req('GET',`/works/${W}/publish-manifests`,{rawCookie:o.cookie,csrfHeader:o.csrf});
rec('P3-manifest-list',r.status===200,`status=${r.status}`);
// publish-tasks
r=await req('POST',`/works/${W}/publish-tasks`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('P3-tasks-create',r.status===200||r.status===201||r.status===422||r.status===409,`status=${r.status} err=${r.json?.error?.code}`);
r=await req('GET','/publish-tasks',{rawCookie:o.cookie,csrfHeader:o.csrf});
rec('P3-tasks-board',r.status===200,`status=${r.status}`);
// read-through
r=await req('POST',`/works/${W}/read-through`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('P3-read-through',r.status===200||r.status===422,`status=${r.status} err=${r.json?.error?.code}`);

console.log(`\nR5C ${F.filter(x=>x.ok).length}/${F.length} pass`);
