// R4-B：事件恢复协议（SSE cursor/410/seq 去重）+ 导出/导入链路
const BASE='http://127.0.0.1:8387/api/v1';
function cookieOf(r){const c=(r.sc??[])[0];return c?c.split(";")[0]:null;}
async function req(method,path,{body,rawCookie,csrfHeader}={}){
  const h={'Content-Type':'application/json'};
  if(csrfHeader)h['X-CSRF-Token']=csrfHeader; if(rawCookie)h['Cookie']=rawCookie;
  const res=await fetch(BASE+path,{method,headers:h,body:body!==undefined?JSON.stringify(body):undefined});
  const sc=res.headers.getSetCookie?.()??[];
  const text=await res.text();let json=null;try{json=text?JSON.parse(text):null}catch{json={_raw:text.slice(0,120)}}
  return {status:res.status,json,sc,text};
}
let r=await req('POST','/auth/register',{body:{username:'r4b'+Math.random().toString(36).slice(2,9),password:'{{SECRET_s2wbnk4v}}'}});
const o={cookie:cookieOf(r),csrf:null};
r=await req('GET','/auth/me',{rawCookie:o.cookie});o.csrf=r.json?.csrf_token;
r=await req('GET','/model-providers',{rawCookie:o.cookie,csrfHeader:o.csrf});
const mp=(Array.isArray(r.json)?r.json:r.json?.items??[])[0];
await req('POST',`/model-providers/${mp.id}/selftest`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
await req('PUT','/model-routes',{body:[{task_type:'agent_chat',provider_id:mp.id,model:'mock-writer',fallback_provider_id:null,fallback_model:''}],rawCookie:o.cookie,csrfHeader:o.csrf});
r=await req('POST','/agent/conversations',{body:{title:'事件恢复'},rawCookie:o.cookie,csrfHeader:o.csrf});
const C=r.json?.id;
// E1：SSE 事件流带 cursor
r=await req('POST',`/agent/conversations/${C}/messages`,{body:{text:'跑一次'},rawCookie:o.cookie,csrfHeader:o.csrf});
const run=r.json?.run?.id;
// 读 SSE 前几行拿 last seq
let lastSeq=null, eventCount=0;
const sse=await fetch(`${BASE}/agent/conversations/${C}/events`,{headers:{Cookie:o.cookie,Accept:'text/event-stream'}});
const reader=sse.body.getReader();const dec=new TextDecoder();let buf='';
const t0=Date.now();
while(Date.now()-t0<3000){const {done,value}=await reader.read();if(done)break;buf+=dec.decode(value);
  const matches=[...buf.matchAll(/id:\s*(\d+)/g)];if(matches.length)lastSeq=Number(matches.at(-1)[1]);
  eventCount=(buf.match(/event:/g)||[]).length;
  if(eventCount>30)break;}
try{await reader.cancel()}catch{}
console.log(`E1 SSE: events=${eventCount} lastSeq=${lastSeq}`);
// E2：带 cursor（after=lastSeq）→ 不重复旧事件
const sse2=await fetch(`${BASE}/agent/conversations/${C}/events?after=${lastSeq??0}`,{headers:{Cookie:o.cookie,Accept:'text/event-stream'}});
const reader2=sse2.body.getReader();let buf2='';const t2=Date.now();
while(Date.now()-t2<1500){const {done,value}=await reader2.read();if(done)break;buf2+=dec.decode(value);}
try{await reader2.cancel()}catch{}
const seqs2=[...buf2.matchAll(/id:\s*(\d+)/g)].map(m=>Number(m[1]));
console.log(`E2 after=${lastSeq}: newEvents=${seqs2.length} minSeq=${seqs2[0]??'-'} noReplay=${seqs2.every(s=>s>(lastSeq??0))}`);
// E3：非法 cursor（负数/超大）
r=await req(`GET`, `/agent/conversations/${C}/events?after=-5`,{rawCookie:o.cookie});
console.log(`E3 after=-5: ${r.status}`);
r=await req(`GET`, `/agent/conversations/${C}/events?after=999999999`,{rawCookie:o.cookie});
console.log(`E3 after=999999999: ${r.status} ${r.json?.error?.code??''}`);
// E4：他人会话 SSE 404
let m=await req('POST','/auth/register',{body:{username:'r4bx'+Math.random().toString(36).slice(2,9),password:'{{SECRET_s2wbnk4v}}'}});
const o2={cookie:cookieOf(m),csrf:null};
r=await req('GET','/auth/me',{rawCookie:o2.cookie});
const sse3=await fetch(`${BASE}/agent/conversations/${C}/events`,{headers:{Cookie:o2.cookie}});
console.log(`E4 other-user SSE: ${sse3.status}`);
// E5：导出/导入
r=await req('POST','/exports',{body:{format:'markdown'},rawCookie:o.cookie,csrfHeader:o.csrf});
console.log(`E5 export-md: ${r.status} keys=${Object.keys(r.json??{}).slice(0,4)}`);
process.exit(0);
