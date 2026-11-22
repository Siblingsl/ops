const BASE='http://127.0.0.1:8387/api/v1';
function cookieOf(r){const c=(r.sc??[])[0];return c?c.split(";")[0]:null;}
async function req(method,path,{body,rawCookie,csrfHeader}={}){
  const h={'Content-Type':'application/json'};
  if(csrfHeader)h['X-CSRF-Token']=csrfHeader; if(rawCookie)h['Cookie']=rawCookie;
  const res=await fetch(BASE+path,{method,headers:h,body:body!==undefined?JSON.stringify(body):undefined});
  const text=await res.text();let json=null;try{json=text?JSON.parse(text):null}catch{json={_raw:text.slice(0,200)}}
  return {status:res.status,json};
}
let r=await req('POST','/auth/register',{body:{username:'r5b2'+Math.random().toString(36).slice(2,9),password:'{{SECRET_s2wbnk4v}}'}});
const oc=(r.headers?.getSetCookie?.()??r.sc??[])[0]; const o={cookie:(oc??'').split(';')[0],csrf:null};
r=await req('GET','/auth/me',{rawCookie:o.cookie});
if(!r.json?.csrf_token){const reg2=await fetch(BASE+'/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'r5b2b'+Math.random().toString(36).slice(2,9),password:'{{SECRET_s2wbnk4v}}'})}); o.cookie=reg2.headers.getSetCookie().map(x=>x.split(';')[0]).join('; '); r=await req('GET','/auth/me',{rawCookie:o.cookie}); }
o.csrf=r.json?.csrf_token;
r=await req('POST','/accounts',{body:{name:'R5B2号',platform:'wechat_mp',content_format:'long_article'},rawCookie:o.cookie,csrfHeader:o.csrf});
const A=r.json?.id;
r=await req('POST',`/accounts/${A}/topics`,{body:{title:'R5B2选题',angle:'角度'},rawCookie:o.cookie,csrfHeader:o.csrf});
const T=r.json?.id;
await req('PATCH',`/topics/${T}`,{body:{status:'adopted'},rawCookie:o.cookie,csrfHeader:o.csrf});
r=await req('POST',`/topics/${T}/score`,{body:{mode:'two_stage'},rawCookie:o.cookie,csrfHeader:o.csrf});
console.log('score:',r.status,JSON.stringify(r.json).slice(0,200));
r=await req('POST',`/topics/${T}/diagnose`,{body:{basis_updated_at:new Date().toISOString()},rawCookie:o.cookie,csrfHeader:o.csrf});
console.log('diagnose:',r.status,JSON.stringify(r.json).slice(0,200));
r=await req('POST',`/accounts/${A}/hot/refresh`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
console.log('hot-refresh:',r.status,JSON.stringify(r.json).slice(0,150));
process.exit(0);
