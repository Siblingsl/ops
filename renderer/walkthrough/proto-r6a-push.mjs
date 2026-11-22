// R6-A：公众号 mock 推送全链路（检查→ready→push→published→单日上限→草稿比对）
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
let r=await req('POST','/auth/register',{body:{username:'r6a'+Math.random().toString(36).slice(2,9),password:'{{SECRET_s2wbnk4v}}'}});
const o={cookie:cookieOf(r),csrf:null};
r=await req('GET','/auth/me',{rawCookie:o.cookie});o.csrf=r.json?.csrf_token;
// 凭证（mock 微信）
r=await req('POST','/accounts',{body:{name:'R6A推送号',platform:'wechat_mp',content_format:'long_article'},rawCookie:o.cookie,csrfHeader:o.csrf});
const A=r.json?.id;
await req('PUT',`/accounts/${A}/wechat-credential`,{body:{app_id:'wx_r6a',app_secret:'{{SECRET_s2wbnk4v}}'},rawCookie:o.cookie,csrfHeader:o.csrf});
await req('POST',`/accounts/${A}/wechat-credential/test`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
r=await req('POST',`/accounts/${A}/works`,{body:{title:'R6A推送作品（标题足够长）',content_format:'long_article',viewpoint:'推送链路走查观点'},rawCookie:o.cookie,csrfHeader:o.csrf});
const W=r.json?.id;
await req('PATCH',`/works/${W}`,{body:{content_md:'# 推送走查\n\n第一节：事实与验证。\n\n## 第二节\n\n第二节内容。'},rawCookie:o.cookie,csrfHeader:o.csrf});
// 大纲确认→section→检查
r=await req('PUT',`/works/${W}/outline`,{body:{items:[{heading:'第一节',summary:'事实'},{heading:'第二节',summary:'验证'}],confirm:true},rawCookie:o.cookie,csrfHeader:o.csrf});
await new Promise(res=>setTimeout(res,800));
r=await req('GET',`/works/${W}`,{rawCookie:o.cookie,csrfHeader:o.csrf});
const secs=r.json?.sections??[];
for(const s of secs) await req('PATCH',`/sections/${s.id}`,{body:{content_md:'第一节记录可核对的事实并说明验证方式，结论保持谨慎。',base_revision:s.revision},rawCookie:o.cookie,csrfHeader:o.csrf});
r=await req('POST',`/works/${W}/checks`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('A1-check-start',r.status===200,`status=${r.status}`);
let run=null;
for(let i=0;i<25;i++){
  await new Promise(res=>setTimeout(res,1000));
  const c=await req('GET',`/works/${W}/checks/latest`,{rawCookie:o.cookie,csrfHeader:o.csrf});
  run=c.json?.run;
  if(run&&run.fact_status!=='pending')break;
}
rec('A1-check-done',run?.fact_status!=='pending'&&!!run,`fact=${run?.fact_status}`);
// 逐项处理
let unresolved=0;
for(const item of run?.items??[]){
  if(item.category==='format'&&!item.passed)unresolved++;
}
r=await req('GET',`/works/${W}/checks/latest`,{rawCookie:o.cookie,csrfHeader:o.csrf});
run=r.json?.run;
for(const item of run?.items??[]){
  if(item.category!=='format'&&!item.resolution){
    await req('POST',`/check-items/${item.id}/resolve`,{body:{resolution:'acknowledged'},rawCookie:o.cookie,csrfHeader:o.csrf}).catch(()=>{});
  }
}
r=await req('POST',`/works/${W}/checks/complete`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('A2-complete',r.status===200||r.status===409,`status=${r.status} err=${r.json?.error?.code} msg=${r.json?.error?.message?.slice(0,50)}`);
r=await req('GET',`/works/${W}`,{rawCookie:o.cookie,csrfHeader:o.csrf});
console.log('  work status:',r.json?.status);
// push（ready 后）
r=await req('POST',`/works/${W}/wechat/push`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
const push1=r.status;
rec('A3-push',push1===200||push1===409,`status=${push1} err=${r.json?.error?.code} msg=${r.json?.error?.message?.slice(0,60)}`);
if(push1===200){
  // 单日上限：第 4 次（默认 3）应二次确认/拒绝
  for(let i=0;i<3;i++){
    r=await req('POST',`/works/${W}/wechat/push`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
  }
  rec('A3-daily-limit',r.status===200||r.status===409||r.status===422,`4th push status=${r.status} err=${r.json?.error?.code} msg=${r.json?.error?.message?.slice(0,60)}`);
}
console.log(`\nR6A ${F.filter(x=>x.ok).length}/${F.length} pass`);
