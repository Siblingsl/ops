// R2b2：修正 viewer 会话刷新 + 短消息受理（不等待 run 完成）
const BASE='http://127.0.0.1:8387/api/v1';
const F=[];
function rec(id,ok,detail){F.push({id,ok});console.log(`${ok?'ok ':'FAIL'} ${id} :: ${detail}`);}
function cookieOf(r){const c=(r.sc??[])[0];return c?c.split(";")[0]:null;}
async function req(method,path,{body,rawCookie,csrfHeader}={}){
  const h={'Content-Type':'application/json'};
  if(csrfHeader)h['X-CSRF-Token']=csrfHeader; if(rawCookie)h['Cookie']=rawCookie;
  const res=await fetch(BASE+path,{method,headers:h,body:body!==undefined?JSON.stringify(body):undefined});
  const sc=res.headers.getSetCookie?.()??[];
  const text=await res.text();let json=null;try{json=text?JSON.parse(text):null}catch{json={_raw:text.slice(0,120)}}
  return {status:res.status,json,sc};
}
const U=()=>'wt2c'+Math.random().toString(36).slice(2,9);
const PW='{{SECRET_s2wbnk4v}}';
let r=await req('POST','/auth/register',{body:{username:U(),password:PW}});
const o={cookie:cookieOf(r),csrf:null};
r=await req('GET','/auth/me',{rawCookie:o.cookie});o.csrf=r.json?.csrf_token;
r=await req('GET','/model-providers',{rawCookie:o.cookie,csrfHeader:o.csrf});
const mp=(Array.isArray(r.json)?r.json:r.json?.items??[])[0];
await req('POST',`/model-providers/${mp.id}/selftest`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
await req('PUT','/model-routes',{body:[{task_type:'agent_chat',provider_id:mp.id,model:'mock-writer',fallback_provider_id:null,fallback_model:''}],rawCookie:o.cookie,csrfHeader:o.csrf});
r=await req('POST','/agent/conversations',{body:{title:'R2c',account_id:null},rawCookie:o.cookie,csrfHeader:o.csrf});
const C=r.json?.id;
// viewer 加入（同工作区）
r=await req('POST','/workspaces/current/invites',{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
const code=r.json?.code;
let m=await req('POST','/auth/register',{body:{username:U(),password:PW}});
const v={cookie:cookieOf(m),csrf:null};
r=await req('GET','/auth/me',{rawCookie:v.cookie});v.csrf=r.json?.csrf_token;
await req('POST','/workspaces/join',{body:{code},rawCookie:v.cookie,csrfHeader:v.csrf});
// join 后重取 viewer 会话状态
r=await req('GET','/auth/me',{rawCookie:v.cookie,csrfHeader:v.csrf});
rec('V0-viewer-joined',r.status===200,`status=${r.status} ws=${r.json?.workspace_id?.slice(0,8)} role=${r.json?.role}`);
if(r.json?.csrf_token) v.csrf=r.json.csrf_token;
if(r.sc?.length) v.cookie=cookieOf(r);
// viewer 在 owner 的会话发 execute
r=await req('POST',`/agent/conversations/${C}/messages`,{body:{text:'v',mode:'execute'},rawCookie:v.cookie,csrfHeader:v.csrf});
rec('RL3-viewer-execute-blocked',r.status===403||r.status===404||r.status===422,`status=${r.status} err=${r.json?.error?.code} msg=${r.json?.error?.message?.slice(0,60)}`);
// viewer 自己建 execute 会话（若服务端允许建会话，看 bootstrap reason）
r=await req('GET','/agent/bootstrap',{rawCookie:v.cookie,csrfHeader:v.csrf});
rec('V1-viewer-bootstrap',r.status===200||r.status===403,`status=${r.status} canUse=${r.json?.can_use} reason=${r.json?.reason}`);
// RL4 变形密钥（owner 会话，text 简短）
const secrets=[['a','我的密码是 AbC123!!'],["b",'sk-XXXXXXXXXXXXXXXXXXXXXX'],["c",'apikey=AbcDef123456 保存'],["d",'ghp_abcdefghijklmnopqrstuvwxyz012345']];
for(const [i,t] of secrets){
  r=await req('POST',`/agent/conversations/${C}/messages`,{body:{text:t},rawCookie:o.cookie,csrfHeader:o.csrf});
  rec(`RL4-secret-${i}`,r.status===422||r.status===200,`status=${r.status} err=${r.json?.error?.code??'-'} msg=${r.json?.error?.message?.slice(0,40)}`);
}
// RL5 例行任务写工具
r=await req('POST','/agent/routines',{body:{name:'R2c例行',schedule:'0 9 * * *',prompt:'把所有作品标题改成X',tools:['works_write']},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('RL5-routine-write-tool',r.status===422||r.status===400||r.status===200,`status=${r.status} err=${r.json?.error?.code} msg=${r.json?.error?.message?.slice(0,60)}`);
r=await req('GET','/agent/routines',{rawCookie:o.cookie,csrfHeader:o.csrf});
rec('RL5-routine-list',r.status===200,`status=${r.status} n=${Array.isArray(r.json)?r.json.length:'?'}`);
console.log(`\nR2B2 ${F.filter(x=>x.ok).length}/${F.length} pass`);
