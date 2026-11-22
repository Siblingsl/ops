// R6-B2：E-34（代访问期间 admin 侧智能体不可用）
const BASE='http://127.0.0.1:8387/api/v1';
async function req(method,path,{body,cookie,csrf}={}){
  const h={'Content-Type':'application/json'};
  if(csrf)h['X-CSRF-Token']=csrf;
  if(cookie)h['Cookie']=cookie;
  const res=await fetch(BASE+path,{method,headers:h,body:body!==undefined?JSON.stringify(body):undefined});
  const text=await res.text();let json=null;try{json=text?JSON.parse(text):null}catch{json={_raw:text.slice(0,100)}}
  return {status:res.status,json};
}
const reg=await fetch(BASE+'/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'r6b2t'+Math.random().toString(36).slice(2,9),password:'{{SECRET_s2wbnk4v}}'})});
const cookie=reg.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
const me=await (await fetch(BASE+'/auth/me',{headers:{Cookie:cookie}})).json();
const cs=me.csrf_token;
const c1=await req('POST','/agent/conversations',{body:{title:'用户正常会话'},cookie,csrf:cs});
console.log('user conv:',c1.status);
const ar=await fetch(BASE+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'skyeder',password:'local-e2e-admin-pass-456'})});
const acookie=ar.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
const acs=(await (await fetch(BASE+'/auth/me',{headers:{Cookie:acookie}})).json()).csrf_token;
const ac=await req('POST','/agent/conversations',{body:{title:'admin直接'},cookie:acookie,csrf:acs});
console.log('admin direct conv:',ac.status,ac.json?.error?.code??'');
await req('POST',`/admin/workspaces/${me.workspace.id}/enter`,{body:{},cookie:acookie,csrf:acs});
const ao=await req('POST','/agent/conversations',{body:{title:'代访问期间'},cookie:acookie,csrf:acs});
console.log('admin-under-override conv:',ao.status,ao.json?.error?.code??'',ao.json?.error?.message?.slice(0,60)??'');
const r1=await req('GET',`/agent/conversations/${c1.json?.id}`,{cookie:acookie,csrf:acs});
console.log('admin-read-user-conv under override:',r1.status,r1.json?.error?.code??'');
await req('POST','/admin/workspaces/exit',{body:{},cookie:acookie,csrf:acs});
process.exit(0);
