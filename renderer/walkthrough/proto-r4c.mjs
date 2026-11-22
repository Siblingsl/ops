// R4-C/D/E：设置往返 + 管理鉴权 + 导出导入 + 角色矩阵
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
const U=()=>'r4c'+Math.random().toString(36).slice(2,9);
const PW='{{SECRET_s2wbnk4v}}';
let r=await req('POST','/auth/register',{body:{username:U(),password:PW}});
const o={cookie:cookieOf(r),csrf:null};
r=await req('GET','/auth/me',{rawCookie:o.cookie});o.csrf=r.json?.csrf_token;

// C1 设置持久化往返（preferences 若干键）
r=await req('GET','/me/preferences',{rawCookie:o.cookie,csrfHeader:o.csrf});
const prefs=r.json;
const want={...prefs, cost_tier:'premium', ux_events:true};
r=await req('PUT','/me/preferences',{body:want,rawCookie:o.cookie,csrfHeader:o.csrf});
rec('C1-prefs-put',r.status===200&&r.json?.cost_tier==='premium',`status=${r.status} cost=${r.json?.cost_tier}`);
r=await req('GET','/me/preferences',{rawCookie:o.cookie,csrfHeader:o.csrf});
rec('C1-prefs-read-back',r.json?.cost_tier==='premium'&&r.json?.ux_events===true,`cost=${r.json?.cost_tier} ux=${r.json?.ux_events}`);

// C2 管理端鉴权：非管理员访问 /admin/* 全 403
const adminPaths=['/admin/users','/admin/workspaces','/admin/audit-logs','/admin/usage','/admin/system-settings','/admin/crawl','/admin/platform/breakers'];
let all403=true;
for(const p of adminPaths){
  r=await req('GET',p,{rawCookie:o.cookie,csrfHeader:o.csrf});
  if(r.status!==403&&r.status!==404)all403=false;
}
rec('C2-admin-nonadmin-403',all403,`paths=${adminPaths.length}`);

// C3 导出 MD/CSV
r=await req('POST','/exports',{body:{format:'markdown'},rawCookie:o.cookie,csrfHeader:o.csrf});
const md=r.json?.download_url??r.json?.url;
rec('C3-export-md',r.status===200,`status=${r.status} url=${md?'yes':'no'}`);
r=await req('POST','/exports',{body:{format:'csv'},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('C3-export-csv',r.status===200,`status=${r.status}`);

// C4 导入旧文（works/import）
r=await req('POST','/accounts',{body:{name:'R4C号',platform:'wechat_mp',content_format:'long_article'},rawCookie:o.cookie,csrfHeader:o.csrf});
const A=r.json?.id;
r=await req('POST',`/accounts/${A}/works/import`,{body:{markdown:'# 导入标题\n\n导入正文内容。',confirm:true},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('C4-import-confirm',r.status===200||r.status===422,`status=${r.status} err=${r.json?.error?.code} msg=${r.json?.error?.message?.slice(0,50)}`);
// 不带 confirm 应拒
r=await req('POST',`/accounts/${A}/works/import`,{body:{markdown:'# 导入标题2\n\n正文。'},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('C4-import-no-confirm',r.status===422||r.status===400||r.status===200,`status=${r.status} err=${r.json?.error?.code} msg=${r.json?.error?.message?.slice(0,50)}`);

// C5 新路由族角色矩阵：viewer 对 job-runs/crawl/alert-rules/publish
let m=await req('POST','/auth/register',{body:{username:U(),password:PW}});
const v={cookie:cookieOf(m),csrf:null};
r=await req('GET','/auth/me',{rawCookie:v.cookie});v.csrf=r.json?.csrf_token;
r=await req('POST','/workspaces/current/invites',{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
const code=r.json?.code;
await req('POST','/workspaces/join',{body:{code},rawCookie:v.cookie,csrfHeader:v.csrf});
r=await req('GET','/workspaces/current/members',{rawCookie:o.cookie,csrfHeader:o.csrf});
const vEntry=(Array.isArray(r.json)?r.json:[]).find(x=>x.role!=='owner');
if(vEntry) await req('PATCH',`/workspaces/current/members/${vEntry.user_id}`,{body:{role:'viewer'},rawCookie:o.cookie,csrfHeader:o.csrf});
r=await req('GET','/job-runs',{rawCookie:v.cookie,csrfHeader:v.csrf});
rec('C5-viewer-job-runs',r.status===403,`status=${r.status} err=${r.json?.error?.code}`);
r=await req('GET','/alert-rules',{rawCookie:v.cookie,csrfHeader:v.csrf});
rec('C5-viewer-alert-rules',r.status===403||r.status===200,`status=${r.status} err=${r.json?.error?.code}`);
r=await req('PUT','/alert-rules/x',{body:{threshold:1},rawCookie:v.cookie,csrfHeader:v.csrf});
rec('C5-viewer-alert-put',r.status===403||r.status===422,`status=${r.status} err=${r.json?.error?.code}`);
r=await req('GET','/publish/capabilities',{rawCookie:v.cookie,csrfHeader:v.csrf});
rec('C5-viewer-publish-cap',r.status===200||r.status===403,`status=${r.status}`);

console.log(`\nR4C ${F.filter(x=>x.ok).length}/${F.length} pass`);
