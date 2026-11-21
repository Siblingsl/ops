const BASE='http://127.0.0.1:8387/api/v1';
function cookieOf(r){const c=(r.sc??[])[0];return c?c.split(";")[0]:null;}
async function req(method,path,{body,rawCookie,csrfHeader}={}){
  const h={'Content-Type':'application/json'};
  if(csrfHeader)h['X-CSRF-Token']=csrfHeader; if(rawCookie)h['Cookie']=rawCookie;
  const res=await fetch(BASE+path,{method,headers:h,body:body!==undefined?JSON.stringify(body):undefined});
  const sc=res.headers.getSetCookie?.()??[];
  const text=await res.text();let json=null;try{json=text?JSON.parse(text):null}catch{json={}}
  return {status:res.status,json,sc};
}
let r=await req('POST','/auth/register',{body:{username:'r3b3'+Math.random().toString(36).slice(2,9),password:'{{SECRET_s2wbnk4v}}'}});
const o={cookie:cookieOf(r),csrf:null};
r=await req('GET','/auth/me',{rawCookie:o.cookie});o.csrf=r.json?.csrf_token;
r=await req('GET','/model-providers',{rawCookie:o.cookie,csrfHeader:o.csrf});
const mp=(Array.isArray(r.json)?r.json:r.json?.items??[])[0];
await req('POST',`/model-providers/${mp.id}/selftest`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
await req('PUT','/model-routes',{body:[{task_type:'agent_chat',provider_id:mp.id,model:'mock-writer',fallback_provider_id:null,fallback_model:''}],rawCookie:o.cookie,csrfHeader:o.csrf});
r=await req('POST','/agent/conversations',{body:{title:'cookie测试'},rawCookie:o.cookie,csrfHeader:o.csrf});
const C=r.json?.id;
const texts=[
 ['cookie-token-短值',  'token: {{SECRET_ab4cdetf}}'],
 ['authorization-bearer','authorization: Bearer {{SECRET_ijk4lmn9}}'],
 ['sessionid-短值',     'sessionid={{SECRET_op6qrstx}}'],
 ['set-cookie-短值',    'set-cookie: sid={{SECRET_uv3wxyz1}}'],
];
for(const [name,text] of texts){
  const x=await req('POST',`/agent/conversations/${C}/messages`,{body:{text},rawCookie:o.cookie,csrfHeader:o.csrf});
  console.log(`${name}: ${x.status===422?'BLOCKED':'PASSED'} ${x.json?.error?.message?.slice(0,30)??''}`);
}
process.exit(0);
