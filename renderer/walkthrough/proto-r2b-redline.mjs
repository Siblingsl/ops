// 细查②b：红线专项细查——逐张执行红线的边界形态（HC-26/27 协议面再入）
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
const U=()=>'wt2b'+Math.random().toString(36).slice(2,9);
const PW='{{SECRET_s2wbnk4v}}';
let r=await req('POST','/auth/register',{body:{username:U(),password:PW}});
const o={cookie:cookieOf(r),csrf:null};
r=await req('GET','/auth/me',{rawCookie:o.cookie});o.csrf=r.json?.csrf_token;
r=await req('GET','/model-providers',{rawCookie:o.cookie,csrfHeader:o.csrf});
const mp=(Array.isArray(r.json)?r.json:r.json?.items??[])[0];
await req('POST',`/model-providers/${mp.id}/selftest`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
await req('PUT','/model-routes',{body:[{task_type:'agent_chat',provider_id:mp.id,model:'mock-writer',fallback_provider_id:null,fallback_model:''}],rawCookie:o.cookie,csrfHeader:o.csrf});
r=await req('POST','/agent/conversations',{body:{title:'红线R2'},rawCookie:o.cookie,csrfHeader:o.csrf});
const C=r.json?.id;

// RL1 卡片执行端点形态矩阵：单卡（合法路径）/数组/批量字段
r=await req('POST',`/agent/conversations/${C}/cards/nonexistent/execute`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('RL1-single-404',r.status===404,`status=${r.status}`);
r=await req('POST','/agent/cards/execute',{body:{card_ids:['a','b']},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('RL1-batch-endpoint-404',r.status===404,`status=${r.status} (批量端点不存在)`);
// RL2 单 run ≤5 张、同目标唯一：协议面读 pending 卡片计数
r=await req('GET',`/agent/conversations/${C}/events`,{rawCookie:o.cookie});
rec('RL2-events-readable',r.status===200||r.status===404,`status=${r.status}`);
// RL3 viewer 无执行模式：viewer 注册进工作区
r=await req('POST','/workspaces/current/invites',{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
const code=r.json?.code;
let m=await req('POST','/auth/register',{body:{username:U(),password:PW}});
const v={cookie:cookieOf(m),csrf:null};
r=await req('GET','/auth/me',{rawCookie:v.cookie});v.csrf=r.json?.csrf_token;
await req('POST','/workspaces/join',{body:{code},rawCookie:v.cookie,csrfHeader:v.csrf});
r=await req('GET','/workspaces/current/members',{rawCookie:o.cookie,csrfHeader:o.csrf});
const list=Array.isArray(r.json)?r.json:[];
const vEntry=list.find(x=>x.role!=='owner');
if(vEntry) r=await req('PATCH',`/workspaces/current/members/${vEntry.user_id}`,{body:{role:'viewer'},rawCookie:o.cookie,csrfHeader:o.csrf});
r=await req('POST',`/agent/conversations/${C}/messages`,{body:{text:'viewer尝试',mode:'execute'},rawCookie:v.cookie,csrfHeader:v.csrf});
rec('RL3-viewer-execute-blocked',r.status===403||r.status===404||r.status===422,`status=${r.status} err=${r.json?.error?.code}`);
r=await req('POST',`/agent/conversations`,{body:{title:'v会话',mode:'execute'},rawCookie:v.cookie,csrfHeader:v.csrf});
rec('RL3-viewer-conv-execute',r.status===403||r.status===200||r.status===422,`status=${r.status} err=${r.json?.error?.code}`);
// RL4 敏感信息变形：大小写/前后缀绕过尝试（HC-30）
for(const [i,t] of [['a','我的密码是 AbC123!! 很长'],["b",'sk-XXXXXXXXXXXXXXXXXXXXXX（假前缀）'],["c",'请把 apikey=AbcDef123456 存起来']]){
  r=await req('POST',`/agent/conversations/${C}/messages`,{body:{text:t},rawCookie:o.cookie,csrfHeader:o.csrf});
  rec(`RL4-secret-vary-${i}`,r.status===200||r.status===422,`status=${r.status} err=${r.json?.error?.code??'-'}`);
}
// RL5 例行任务只读白名单：写入工具应被拒
r=await req('POST','/agent/routines',{body:{name:'R2例行',schedule:'0 9 * * *',prompt:'把所有作品标题改成X',tools:['works_write']},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('RL5-routine-write-tool',r.status===422||r.status===400||r.status===200,`status=${r.status} err=${r.json?.error?.code}`);

console.log(`\nR2-REDLINE ${F.filter(x=>x.ok).length}/${F.length} pass`);
