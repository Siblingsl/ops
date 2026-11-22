// R5-D：章节修订冲突 + 令牌/MCP 管理面 + prompt-templates
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
const U=()=>'r5d'+Math.random().toString(36).slice(2,9);
let r=await req('POST','/auth/register',{body:{username:U(),password:'{{SECRET_s2wbnk4v}}'}});
const o={cookie:cookieOf(r),csrf:null};
r=await req('GET','/auth/me',{rawCookie:o.cookie});o.csrf=r.json?.csrf_token;
r=await req('POST','/accounts',{body:{name:'R5D号',platform:'wechat_mp',content_format:'long_article'},rawCookie:o.cookie,csrfHeader:o.csrf});
const A=r.json?.id;
r=await req('POST',`/accounts/${A}/works`,{body:{title:'R5D章节冲突走查作品',content_format:'long_article'},rawCookie:o.cookie,csrfHeader:o.csrf});
const W=r.json?.id;
await req('PATCH',`/works/${W}`,{body:{content_md:'# R5D\n\n第一节内容，用于章节 CAS 验证。\n\n## 第二节\n\n第二节内容。'},rawCookie:o.cookie,csrfHeader:o.csrf});
r=await req('GET',`/works/${W}`,{rawCookie:o.cookie,csrfHeader:o.csrf});
const sec=r.json?.sections?.[0];
if(!sec){console.log('no sections after content write');process.exit(1);}
// D1 章节双写：同 base_revision 第二次 409
r=await req('PATCH',`/sections/${sec.id}`,{body:{content_md:'版本一内容，用于章节 CAS 验证。',base_revision:sec.revision},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('D1-section-first',r.status===200,`status=${r.status}`);
r=await req('PATCH',`/sections/${sec.id}`,{body:{content_md:'版本二内容。',base_revision:sec.revision},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('D1-section-stale-409',r.status===409,`status=${r.status} err=${r.json?.error?.code}`);
// D2 令牌管理面
r=await req('GET','/conversion-ingest-tokens',{rawCookie:o.cookie,csrfHeader:o.csrf});
rec('D2-tokens-list',r.status===200,`status=${r.status}`);
r=await req('POST','/conversion-ingest-tokens',{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
const TK=r.json?.id;
rec('D2-token-create',r.status===200&&!!TK,`status=${r.status}`);
r=await req('DELETE','/conversion-ingest-tokens/'+TK,{rawCookie:o.cookie,csrfHeader:o.csrf});
rec('D2-token-revoke',r.status===200,`status=${r.status}`);
// D3 MCP tokens
r=await req('GET','/mcp/tokens',{rawCookie:o.cookie,csrfHeader:o.csrf});
rec('D3-mcp-list',r.status===200,`status=${r.status}`);
r=await req('POST','/mcp/tokens',{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
const MT=r.json?.id;
rec('D3-mcp-create',r.status===200||r.status===422,`status=${r.status} err=${r.json?.error?.code}`);
if(MT){r=await req('DELETE','/mcp/tokens/'+MT,{rawCookie:o.cookie,csrfHeader:o.csrf});rec('D3-mcp-revoke',r.status===200,`status=${r.status}`);}
// D4 prompt-templates 读 + 非法写
r=await req('GET','/prompt-templates',{rawCookie:o.cookie,csrfHeader:o.csrf});
rec('D4-templates-get',r.status===200,`status=${r.status}`);
r=await req('PUT','/prompt-templates/unknown_task',{'body':{template:'x'},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('D4-template-put-invalid',r.status===422||r.status===400||r.status===404,`status=${r.status} err=${r.json?.error?.code}`);

console.log(`\nR5D ${F.filter(x=>x.ok).length}/${F.length} pass`);
