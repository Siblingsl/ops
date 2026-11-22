// R4-D2：导入旧文（正确字段）
const BASE='http://127.0.0.1:8387/api/v1';
function cookieOf(r){const c=(r.sc??[])[0];return c?c.split(";")[0]:null;}
async function req(method,path,{body,rawCookie,csrfHeader}={}){
  const h={'Content-Type':'application/json'};
  if(csrfHeader)h['X-CSRF-Token']=csrfHeader; if(rawCookie)h['Cookie']=rawCookie;
  const res=await fetch(BASE+path,{method,headers:h,body:body!==undefined?JSON.stringify(body):undefined});
  const sc=res.headers.getSetCookie?.()??[];
  const text=await res.text();let json=null;try{json=text?JSON.parse(text):null}catch{json={_raw:text.slice(0,80)}}
  return {status:res.status,json,sc};
}
let r=await req('POST','/auth/register',{body:{username:'r4d2'+Math.random().toString(36).slice(2,9),password:'{{SECRET_s2wbnk4v}}'}});
const o={cookie:cookieOf(r),csrf:null};
r=await req('GET','/auth/me',{rawCookie:o.cookie});o.csrf=r.json?.csrf_token;
r=await req('POST','/accounts',{body:{name:'导入号',platform:'wechat_mp',content_format:'long_article'},rawCookie:o.cookie,csrfHeader:o.csrf});
const A=r.json?.id;
r=await req('POST',`/accounts/${A}/works/import`,{body:{title:'导入标题',confirm_published:true,sections:[{heading:'第一节',content_md:'导入正文内容，来自旧文。'}],published_date:'2026-10-01'},rawCookie:o.cookie,csrfHeader:o.csrf});
console.log('import-with-confirm:',r.status,r.json?.id?'work created':'',r.json?.error?.message?.slice(0,50)??'');
process.exit(0);
