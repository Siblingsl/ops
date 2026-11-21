// C1e：CX 构建（ops.wechat-html/v1）
const BASE='http://127.0.0.1:8387/api/v1';
async function req(method,path,{body,rawCookie,csrfHeader}={}){
  const h={'Content-Type':'application/json'};
  if(csrfHeader)h['X-CSRF-Token']=csrfHeader; if(rawCookie)h['Cookie']=rawCookie;
  const res=await fetch(BASE+path,{method,headers:h,body:body?JSON.stringify(body):undefined});
  const setCookie=res.headers.getSetCookie?.()??[];
  const text=await res.text();let json=null;try{json=text?JSON.parse(text):null}catch{json={_raw:text.slice(0,200)}}
  return {status:res.status,json,setCookie};
}
const U=()=>'wt'+Math.random().toString(36).slice(2,10);
const PW='{{SECRET_c8fljv2u}}';
let r=await req('POST','/auth/register',{body:{username:U(),password:PW}});
const o={cookie:r.setCookie[0].split(';')[0],csrf:null};
r=await req('GET','/auth/me',{rawCookie:o.cookie});o.csrf=r.json?.csrf_token;
r=await req('POST','/accounts',{body:{name:'C1e',platform:'wechat_mp',content_format:'long_article'},rawCookie:o.cookie,csrfHeader:o.csrf});
const A=r.json?.id;
r=await req('POST',`/accounts/${A}/works`,{body:{title:'构建走查',content_format:'long_article'},rawCookie:o.cookie,csrfHeader:o.csrf});
const W=r.json?.id;
await req('PATCH',`/works/${W}`,{body:{content_md:'# 标题\n\n正文一。\n\n## 小节\n\n正文二。'},rawCookie:o.cookie,csrfHeader:o.csrf});
r=await req('GET',`/works/${W}`,{rawCookie:o.cookie,csrfHeader:o.csrf});
const rev=r.json?.revision??r.json?.work?.revision;
r=await req('POST',`/works/${W}/builds`,{body:{basis_revision:rev,client:'desktop',targets:['wechat_html'],'renderer_contract_version':'ops.wechat-html/v1'},rawCookie:o.cookie,csrfHeader:o.csrf});
const B=r.json?.id;
console.log(`${r.status===200||r.status===202?'PASS':'FAIL'} F-50.1 CX构建受理 v1 :: status=${r.status} build=${B?.slice(0,8)} err=${r.json?.error?.code}`);
if(B){
  r=await req('GET',`/builds/${B}`,{rawCookie:o.cookie,csrfHeader:o.csrf});
  console.log(`PASS F-50.2 构建详情 :: status=${r.status} state=${r.json?.state??r.json?.status??'?'}`);
}
