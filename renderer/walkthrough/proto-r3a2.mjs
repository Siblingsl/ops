const BASE='http://127.0.0.1:8387/api/v1';
function cookieOf(r){const c=(r.sc??[])[0];return c?c.split(";")[0]:null;}
async function req(method,path,{body,rawCookie,csrfHeader}={}){
  const h={'Content-Type':'application/json'};
  if(csrfHeader)h['X-CSRF-Token']=csrfHeader; if(rawCookie)h['Cookie']=rawCookie;
  const res=await fetch(BASE+path,{method,headers:h,body:body!==undefined?JSON.stringify(body):undefined});
  const sc=res.headers.getSetCookie?.()??[];
  const text=await res.text();let json=null;try{json=text?JSON.parse(text):null}catch{json={_raw:text.slice(0,100)}}
  return {status:res.status,json,sc};
}
let r=await req('POST','/auth/register',{body:{username:'r3a2'+Math.random().toString(36).slice(2,9),password:'{{SECRET_s2wbnk4v}}'}});
const o={cookie:cookieOf(r),csrf:null};
r=await req('GET','/auth/me',{rawCookie:o.cookie});o.csrf=r.json?.csrf_token;
r=await req('GET','/model-providers',{rawCookie:o.cookie,csrfHeader:o.csrf});
const mp=(Array.isArray(r.json)?r.json:r.json?.items??[])[0];
await req('POST',`/model-providers/${mp.id}/selftest`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
await req('PUT','/model-routes',{body:[{task_type:'agent_chat',provider_id:mp.id,model:'mock-writer',fallback_provider_id:null,fallback_model:''}],rawCookie:o.cookie,csrfHeader:o.csrf});
r=await req('POST','/agent/conversations',{body:{title:'C3replay'},rawCookie:o.cookie,csrfHeader:o.csrf});
const C=r.json?.id;
const rid=crypto.randomUUID();
const m1=await req('POST',`/agent/conversations/${C}/messages`,{body:{text:'重放A',request_id:rid},rawCookie:o.cookie,csrfHeader:o.csrf});
const m2=await req('POST',`/agent/conversations/${C}/messages`,{body:{text:'重放A',request_id:rid},rawCookie:o.cookie,csrfHeader:o.csrf});
// 同 id 不同 payload 应拒绝（不同 hash）
const m3=await req('POST',`/agent/conversations/${C}/messages`,{body:{text:'重放B',request_id:rid},rawCookie:o.cookie,csrfHeader:o.csrf});
const d=await req('GET',`/agent/conversations/${C}`,{rawCookie:o.cookie,csrfHeader:o.csrf});
const msgs=(d.json?.messages??[]).filter(m=>m.role==='user');
console.log(`m1=${m1.status} m2=${m2.status} m2replayed=${m2.json?.replayed??'?'} m3=${m3.status}(${m3.json?.error?.code??'-'}) userMsgs=${msgs.length}`);
console.log(`VERDICT replay: m2 200 且不新增消息=${msgs.length===1}; 变体被拒或按新请求=${m3.status!==200||m3.json?.replayed===false}`);
process.exit(0);
