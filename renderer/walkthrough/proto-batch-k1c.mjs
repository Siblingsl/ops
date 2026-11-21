// K1c-2：模型清单读（容错 cookie）
const BASE='http://127.0.0.1:8387/api/v1';
async function req(method,path,{body,rawCookie,csrfHeader}={}){
  const h={'Content-Type':'application/json'};
  if(csrfHeader)h['X-CSRF-Token']=csrfHeader; if(rawCookie)h['Cookie']=rawCookie;
  const res=await fetch(BASE+path,{method,headers:h,body:body?JSON.stringify(body):undefined});
  const sc=res.headers.getSetCookie?.()??[];
  const text=await res.text();let json=null;try{json=text?JSON.parse(text):null}catch{json={_raw:text.slice(0,300)}}
  return {status:res.status,json,sc};
}
const U=()=>'wt'+Math.random().toString(36).slice(2,10);
const PW='{{SECRET_a9wqbc4k}}';
let r=await req('POST','/auth/register',{body:{username:U(),password:PW}});
const c0=r.sc.find(s=>/session/i.test(s))??r.sc[0];
const o={cookie:c0?c0.split(';')[0]:null,csrf:null};
r=await req('GET','/auth/me',{rawCookie:o.cookie});o.csrf=r.json?.csrf_token;
console.log('auth/me:',r.status,!!o.csrf);
r=await req('GET','/agent/models',{rawCookie:o.cookie,csrfHeader:o.csrf});
console.log(`agent/models: status=${r.status} body=${JSON.stringify(r.json).slice(0,400)}`);
r=await req('GET','/model-routes',{rawCookie:o.cookie,csrfHeader:o.csrf});
console.log(`model-routes: status=${r.status} body=${JSON.stringify(r.json).slice(0,300)}`);
r=await req('GET','/ai-providers',{rawCookie:o.cookie,csrfHeader:o.csrf});
console.log(`ai-providers: status=${r.status} body=${JSON.stringify(r.json).slice(0,300)}`);
