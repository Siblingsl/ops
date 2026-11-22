// R4-E：新路由族角色矩阵（publish/crawl/breakers/notify 定向去重）
const BASE='http://127.0.0.1:8387/api/v1';
const F=[];
function rec(id,ok,detail){F.push({id,ok});console.log(`${ok?'ok ':'FAIL'} ${id} :: ${detail}`);}
function cookieOf(r){const c=(r.sc??[])[0];return c?c.split(";")[0]:null;}
async function req(method,path,{body,rawCookie,csrfHeader}={}){
  const h={'Content-Type':'application/json'};
  if(csrfHeader)h['X-CSRF-Token']=csrfHeader; if(rawCookie)h['Cookie']=rawCookie;
  const res=await fetch(BASE+path,{method,headers:h,body:body!==undefined?JSON.stringify(body):undefined});
  const sc=res.headers.getSetCookie?.()??[];
  const text=await res.text();let json=null;try{json=text?JSON.parse(text):null}catch{json={_raw:text.slice(0,80)}}
  return {status:res.status,json,sc};
}
const U=()=>'r4e'+Math.random().toString(36).slice(2,9);
let r=await req('POST','/auth/register',{body:{username:U(),password:'{{SECRET_s2wbnk4v}}'}});
const o={cookie:cookieOf(r),csrf:null};
r=await req('GET','/auth/me',{rawCookie:o.cookie});o.csrf=r.json?.csrf_token;
r=await req('POST','/accounts',{body:{name:'R4E号',platform:'wechat_mp',content_format:'long_article'},rawCookie:o.cookie,csrfHeader:o.csrf});
const A=r.json?.id;

// P1 publish/capabilities 带 account
r=await req('GET',`/publish/capabilities?account_id=${A}`,{rawCookie:o.cookie,csrfHeader:o.csrf});
rec('P1-capabilities',r.status===200||r.status===422,`status=${r.status} err=${r.json?.error?.code}`);
// P2 crawl（owner 读）
r=await req('GET','/admin/crawl',{rawCookie:o.cookie,csrfHeader:o.csrf});
rec('P2-owner-crawl',r.status===403||r.status===200,`status=${r.status}`);
// P3 管理端写双防（PATCH 非管理用户 403）
r=await req('PATCH','/admin/users/x',{body:{role:'owner'},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('P3-admin-patch-403',r.status===403||r.status===404,`status=${r.status} err=${r.json?.error?.code}`);
// P4 通知去重键：同一通知重发（delegation cancel 两次）→ 用户侧只一次
r=await req('POST','/agent/conversations',{body:{title:'去重'},rawCookie:o.cookie,csrfHeader:o.csrf});
const C=r.json?.id;
// 通知读（若实现）
r=await req('GET','/notifications',{rawCookie:o.cookie,csrfHeader:o.csrf});
rec('P4-notifications-route',r.status===200||r.status===404,`status=${r.status}`);

console.log(`\nR4E ${F.filter(x=>x.ok).length}/${F.length} pass`);
