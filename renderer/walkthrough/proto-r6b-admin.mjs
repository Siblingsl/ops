// R6-B：管理员代访问（E-34）+ reauth + 密码修改 + C：fork/compact
const BASE='http://127.0.0.1:8387/api/v1';
const F=[];
function rec(id,ok,detail){F.push({id,ok});console.log(`${ok?'ok ':'FAIL'} ${id} :: ${detail}`);}
async function req(method,path,{body,cookie,csrf}={}){
  const h={'Content-Type':'application/json'};
  if(csrf)h['X-CSRF-Token']=csrf;
  if(cookie)h['Cookie']=cookie;
  const res=await fetch(BASE+path,{method,headers:h,body:body!==undefined?JSON.stringify(body):undefined});
  const text=await res.text();let json=null;try{json=text?JSON.parse(text):null}catch{json={_raw:text.slice(0,100)}}
  return {status:res.status,json,headers:{setCookie:res.headers.getSetCookie()}};
}
const reg=await fetch(BASE+'/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'r6b'+Math.random().toString(36).slice(2,9),password:'{{SECRET_s2wbnk4v}}'})});
const cookie=reg.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
const me=await (await fetch(BASE+'/auth/me',{headers:{Cookie:cookie}})).json();
const cs=me.csrf_token;
const uid=me.user_id;

// B1 密码修改（旧密码错→422；对→200）
let r=await req('PUT','/auth/password',{body:{old_password:'wrong-old',new_password:'{{SECRET_hnv2iwlm}}'},cookie,csrf:cs});
rec('B1-password-wrong-old',r.status===422||r.status===400,`status=${r.status} err=${r.json?.error?.code}`);
r=await req('PUT','/auth/password',{body:{old_password:'{{SECRET_s2wbnk4v}}',new_password:'{{SECRET_hnv2iwlm}}'},cookie,csrf:cs});
rec('B1-password-ok',r.status===200,`status=${r.status}`);
// 改密后旧会话失效？
r=await req('GET','/auth/me',{cookie});
rec('B1-old-session-after-password-change',r.status===401,`status=${r.status}`);

// B2 reauth：新登录→reauth 授 5 分钟敏感窗
const reg2=await fetch(BASE+'/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'r6b2'+Math.random().toString(36).slice(2,9),password:'{{SECRET_s2wbnk4v}}'})});
const cookie2=reg2.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
const me2=await (await fetch(BASE+'/auth/me',{headers:{Cookie:cookie2}})).json();
r=await req('POST','/auth/reauth',{body:{password:'{{SECRET_s2wbnk4v}}'},cookie:cookie2,csrf:me2.csrf_token});
rec('B2-reauth-ok',r.status===200,`status=${r.status} keys=${Object.keys(r.json??{}).slice(0,4)}`);
r=await req('POST','/auth/reauth',{body:{password:'wrong'},cookie:cookie2,csrf:me2.csrf_token});
rec('B2-reauth-wrong',r.status===401||r.status===422,`status=${r.status}`);

// B3 管理员代访问（skyeder 登录 → enter workspace → agent 403 E-34）
r=await req('POST','/auth/login',{body:{username:'skyeder',password:'local-e2e-admin-pass-456'}});
const adminCookie=r.headers.setCookie.map(x=>x.split(';')[0]).join('; ');
const adminCsrf=(await (await fetch(BASE+'/auth/me',{headers:{Cookie:adminCookie}})).json()).csrf_token;
rec('B3-admin-login',r.status===200,`status=${r.status}`);
r=await req('POST',`/admin/workspaces/${me.workspace_id}/enter`,{body:{},cookie:adminCookie,csrf:adminCsrf});
rec('B3-admin-enter',r.status===200||r.status===404,`status=${r.status} err=${r.json?.error?.code}`);
// 代访问期间用户智能体不可用（E-34）：以**用户身份**访问 agent 应 403（或代访问标记下受限）
r=await req('POST','/agent/conversations',{body:{title:'代访问测试'},cookie,csrf:cs});
rec('B3-agent-blocked-under-override',r.status===403||r.status===409,`status=${r.status} err=${r.json?.error?.code} msg=${r.json?.error?.message?.slice(0,60)}`);
// admin 退出代访问
r=await req('POST','/admin/workspaces/exit',{body:{},cookie:adminCookie,csrf:adminCsrf});
rec('B3-admin-exit',r.status===200,`status=${r.status}`);

// B4 admin 全站审计与用量
r=await req('GET','/admin/audit-logs',{cookie:adminCookie,csrf:adminCsrf});
rec('B4-admin-audit',r.status===200,`status=${r.status}`);
r=await req('GET','/admin/usage',{cookie:adminCookie,csrf:adminCsrf});
rec('B4-admin-usage',r.status===200,`status=${r.status}`);

console.log(`\nR6B ${F.filter(x=>x.ok).length}/${F.length} pass`);
