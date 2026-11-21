// K1g：供应商自检(selftest) → agent 消息闭环
const BASE='http://127.0.0.1:8387/api/v1';
const results=[];
function rec(id,name,ok,detail){results.push({id,name,ok});console.log(`${ok?'PASS':'FAIL'} ${id} ${name} :: ${detail}`);}
function cookieOf(r){const c=(r.sc??[])[0];return c?c.split(";")[0]:null;}
async function req(method,path,{body,rawCookie,csrfHeader}={}){
  const h={'Content-Type':'application/json'};
  if(csrfHeader)h['X-CSRF-Token']=csrfHeader; if(rawCookie)h['Cookie']=rawCookie;
  const res=await fetch(BASE+path,{method,headers:h,body:body?JSON.stringify(body):undefined});
  const sc=res.headers.getSetCookie?.()??[];
  const text=await res.text();let json=null;try{json=text?JSON.parse(text):null}catch{json={_raw:text.slice(0,200)}}
  return {status:res.status,json,sc};
}
const U=()=>'wt'+Math.random().toString(36).slice(2,10);
const PW='{{SECRET_e7blpn2y}}';
let r=await req('POST','/auth/register',{body:{username:U(),password:PW}});
const o={cookie:cookieOf(r),csrf:null};
r=await req('GET','/auth/me',{rawCookie:o.cookie});o.csrf=r.json?.csrf_token;
r=await req('GET','/model-providers',{rawCookie:o.cookie,csrfHeader:o.csrf});
const provs=Array.isArray(r.json)?r.json:(r.json?.items??[]);
const mp=provs[0];
// selftest：标记 tools_ok
r=await req('POST',`/model-providers/${mp.id}/selftest`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-104.5','供应商自检(selftest)',r.status===200,`status=${r.status} body=${JSON.stringify(r.json).slice(0,150)}`);
r=await req('PUT','/model-routes',{body:[{task_type:'agent_chat',provider_id:mp.id,model:'mock-writer',fallback_provider_id:null,fallback_model:''}],rawCookie:o.cookie,csrfHeader:o.csrf});
rec('K1.0','设 agent_chat 路由',r.status===200,`status=${r.status}`);
r=await req('POST','/agent/conversations',{body:{title:'消息闭环G'},rawCookie:o.cookie,csrfHeader:o.csrf});
const C=r.json?.id;
r=await req('POST',`/agent/conversations/${C}/messages`,{body:{text:'列出当前工作区账号'},rawCookie:o.cookie,csrfHeader:o.csrf});
const run=r.json?.run?.id??r.json?.run_id;
rec('K1.2','发消息受理→run',r.status===200||r.status===202,`status=${r.status} run=${(run??'').slice(0,8)} err=${r.json?.error?.code}`);
if(run){
  const res=await fetch(`${BASE}/agent/runs/${run}/events`,{headers:{Cookie:o.cookie}});
  const reader=res.body.getReader();let acc='';const dec=new TextDecoder();const t0=Date.now();
  while(Date.now()-t0<4000){const {done,value}=await reader.read();if(done)break;acc+=dec.decode(value);if(acc.length>1500)break;}
  await reader.cancel().catch(()=>{});
  rec('K1.3','事件流(SSE)有输出',acc.length>0,`bytes=${acc.length}`);
  r=await req('POST',`/agent/runs/${run}/cancel`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
  rec('K1.4','运行停止',r.status===200||r.status===409,`status=${r.status} err=${r.json?.error?.code}`);
}
console.log(`\nSUMMARY ${results.filter(x=>x.ok).length}/${results.length} pass`);
