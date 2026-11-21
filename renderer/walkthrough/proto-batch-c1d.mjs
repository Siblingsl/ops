// C1d：CX 构建（正确契约版本 ops.wechat-html/v0）
const BASE='http://127.0.0.1:8387/api/v1';
const results=[];
function rec(id,name,ok,detail){results.push({id,name,ok});console.log(`${ok?'PASS':'FAIL'} ${id} ${name} :: ${detail}`);}
function cookieOf(r){const c=r.setCookie[0];return c?c.split(';')[0]:null;}
async function req(method,path,{body,rawCookie,csrfHeader}={}){
  const h={'Content-Type':'application/json'};
  if(csrfHeader)h['X-CSRF-Token']=csrfHeader; if(rawCookie)h['Cookie']=rawCookie;
  const res=await fetch(BASE+path,{method,headers:h,body:body?JSON.stringify(body):undefined});
  const setCookie=res.headers.getSetCookie?.()??[];
  const text=await res.text();let json=null;try{json=text?JSON.parse(text):null}catch{json={_raw:text.slice(0,200)}}
  return {status:res.status,json,setCookie};
}
const U=()=>'wt'+Math.random().toString(36).slice(2,10);
const PW='{{SECRET_t7yqwn4v}}';
let r=await req('POST','/auth/register',{body:{username:U(),password:PW}});
const o={cookie:cookieOf(r),csrf:null};
r=await req('GET','/auth/me',{rawCookie:o.cookie});o.csrf=r.json?.csrf_token;
r=await req('POST','/accounts',{body:{name:'C1d号',platform:'wechat_mp',content_format:'long_article'},rawCookie:o.cookie,csrfHeader:o.csrf});
const A=r.json?.id;
r=await req('POST',`/accounts/${A}/works`,{body:{title:'构建契约走查',content_format:'long_article'},rawCookie:o.cookie,csrfHeader:o.csrf});
const W=r.json?.id;
await req('PATCH',`/works/${W}`,{body:{content_md:'# 标题\n\n正文段落一。\n\n## 小节\n\n正文段落二。'},rawCookie:o.cookie,csrfHeader:o.csrf});
r=await req('GET',`/works/${W}`,{rawCookie:o.cookie,csrfHeader:o.csrf});
const rev=r.json?.revision??r.json?.work?.revision;
r=await req('POST',`/works/${W}/builds`,{body:{basis_revision:rev,client:'desktop',targets:['wechat_html'],'renderer_contract_version':'ops.wechat-html/v0'},rawCookie:o.cookie,csrfHeader:o.csrf});
const B=r.json?.id;
rec('F-50.1','CX 构建受理(ops.wechat-html/v0)',r.status===200||r.status===202,`status=${r.status} build=${B?.slice(0,8)} err=${r.json?.error?.code}`);
if(B){
  r=await req('GET',`/builds/${B}`,{rawCookie:o.cookie,csrfHeader:o.csrf});
  rec('F-50.2','构建详情',r.status===200,`status=${r.status} state=${r.json?.state??r.json?.status??'?'}`);
  r=await req('GET',`/builds/${B}/manifest.json`,{rawCookie:o.cookie,csrfHeader:o.csrf});
  rec('F-50.3','manifest 读',r.status===200||r.status===404,`status=${r.status}`);
}
console.log(`\nSUMMARY ${results.filter(x=>x.ok).length}/${results.length} pass`);
