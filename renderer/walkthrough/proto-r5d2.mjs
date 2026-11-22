// R5-D2：大纲确认→章节 CAS（完整路径）
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
let r=await req('POST','/auth/register',{body:{username:'r5d2'+Math.random().toString(36).slice(2,9),password:'{{SECRET_s2wbnk4v}}'}});
const o={cookie:cookieOf(r),csrf:null};
r=await req('GET','/auth/me',{rawCookie:o.cookie});o.csrf=r.json?.csrf_token;
r=await req('POST','/accounts',{body:{name:'R5D2号',platform:'wechat_mp',content_format:'long_article'},rawCookie:o.cookie,csrfHeader:o.csrf});
const A=r.json?.id;
r=await req('POST',`/accounts/${A}/works`,{body:{title:'R5D2大纲作品',content_format:'long_article',viewpoint:'大纲 CAS 走查观点'},rawCookie:o.cookie,csrfHeader:o.csrf});
const W=r.json?.id;
await req('PATCH',`/works/${W}`,{body:{viewpoint:'大纲 CAS 走查观点'},rawCookie:o.cookie,csrfHeader:o.csrf});
// 大纲生成（human_step）→ 从 human step 响应拿大纲项；或直接 PUT outline+confirm
r=await req('PUT',`/works/${W}/outline`,{body:{items:[{heading:'第一节',summary:'内容一'},{heading:'第二节',summary:'内容二'}],confirm:true},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('D-outline-confirm',r.status===200,`status=${r.status} err=${r.json?.error?.code} msg=${r.json?.error?.message?.slice(0,60)}`);
r=await req('GET',`/works/${W}`,{rawCookie:o.cookie,csrfHeader:o.csrf});
const sec=r.json?.sections?.[0];
rec('D-sections-created',!!sec,`n=${r.json?.sections?.length}`);
if(sec){
  r=await req('PATCH',`/sections/${sec.id}`,{body:{content_md:'版本一内容，用于章节 CAS 验证。',base_revision:sec.revision},rawCookie:o.cookie,csrfHeader:o.csrf});
  rec('D-cas-first',r.status===200,`status=${r.status}`);
  r=await req('PATCH',`/sections/${sec.id}`,{body:{content_md:'版本二内容。',base_revision:sec.revision},rawCookie:o.cookie,csrfHeader:o.csrf});
  rec('D-cas-stale-409',r.status===409,`status=${r.status} err=${r.json?.error?.code}`);
}
// 令牌与模板
r=await req('GET','/conversion-ingest-tokens',{rawCookie:o.cookie,csrfHeader:o.csrf});
rec('D-tokens-list',r.status===200,`status=${r.status}`);
r=await req('POST','/conversion-ingest-tokens',{body:{name:'R5D令牌'},rawCookie:o.cookie,csrfHeader:o.csrf});
const TK=r.json?.id;
rec('D-token-create-revoke',r.status===200&&!!TK,`status=${r.status}`);
if(TK){r=await req('DELETE','/conversion-ingest-tokens/'+TK,{rawCookie:o.cookie,csrfHeader:o.csrf});rec('D-token-revoke',r.status===200,`status=${r.status}`);}
r=await req('GET','/mcp/tokens',{rawCookie:o.cookie,csrfHeader:o.csrf});
rec('D-mcp-list',r.status===200,`status=${r.status}`);
r=await req('GET','/prompt-templates',{rawCookie:o.cookie,csrfHeader:o.csrf});
rec('D-templates-get',r.status===200,`status=${r.status}`);

console.log(`\nR5D2 ${F.filter(x=>x.ok).length}/${F.length} pass`);
