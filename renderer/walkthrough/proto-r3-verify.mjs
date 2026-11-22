// R3 修复复验：Q-16（附件 quarantined）、Q-11（重复键 422）、Q-12（变体拦截）
const BASE='http://127.0.0.1:8387/api/v1';
function cookieOf(r){const c=(r.sc??[])[0];return c?c.split(";")[0]:null;}
async function req(method,path,{body,rawCookie,csrfHeader}={}){
  const h={'Content-Type':'application/json'};
  if(csrfHeader)h['X-CSRF-Token']=csrfHeader; if(rawCookie)h['Cookie']=rawCookie;
  const res=await fetch(BASE+path,{method,headers:h,body:body!==undefined?JSON.stringify(body):undefined});
  const sc=res.headers.getSetCookie?.()??[];
  const text=await res.text();let json=null;try{json=text?JSON.parse(text):null}catch{json={_raw:text.slice(0,80)}}
  return {status:res.status,json,sc};
}
async function up(csrf,cookie,bytes,name,type){
  const form=new FormData();
  form.append('file',new File([new Uint8Array(bytes)],name,{type}));
  const res=await fetch(BASE+'/agent/attachments',{method:'POST',headers:{'X-CSRF-Token':csrf,Cookie:cookie},body:form});
  const t=await res.text();let j=null;try{j=t?JSON.parse(t):null}catch{j={}}
  return {status:res.status,json:j};
}
let r=await req('POST','/auth/register',{body:{username:'rv'+Math.random().toString(36).slice(2,9),password:'{{SECRET_s2wbnk4v}}'}});
const o={cookie:cookieOf(r),csrf:null};
r=await req('GET','/auth/me',{rawCookie:o.cookie});o.csrf=r.json?.csrf_token;
r=await req('POST','/agent/conversations',{body:{title:'R3复验'},rawCookie:o.cookie,csrfHeader:o.csrf});
const C=r.json?.id;
// Q-16 附件：token:短值 → 应 quarantined（不再 ready）
const form=new FormData();
form.append('file',new File(['token: {{SECRET_ab4cdetf}}'],'s.txt',{type:'text/plain'}));
const sr=await fetch(BASE+'/agent/attachments',{method:'POST',headers:{'X-CSRF-Token':o.csrf,Cookie:o.cookie},body:form});
const st=await sr.text();let sj=null;try{sj=st?JSON.parse(st):null}catch{sj={}}
console.log(`Q16-att: ${sr.status} state=${sj?.parse_status??sj?.attachment?.parse_status??'?'} ${sr.status===200&&sj?.parse_status==='quarantined'?'FIXED':'CHECK'}`);
// Q-11 重复键
{
  const res=await fetch(BASE+'/agent/conversations',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':o.csrf,Cookie:o.cookie},body:'{"title":"a","title":"b"}'});
  console.log(`Q11-dup-key: ${res.status} ${res.status===422||res.status===400?'FIXED':'STILL-200?'}`);
}
{
  const res=await fetch(BASE+'/agent/conversations',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':o.csrf,Cookie:o.cookie},body:'{"title":"ok"}'});
  console.log(`Q11-normal-still-200: ${res.status}`);
}
// Q-12 变体（密匙+16位字面量）
r=await req('GET','/model-providers',{rawCookie:o.cookie,csrfHeader:o.csrf});
const mp=(Array.isArray(r.json)?r.json:r.json?.items??[])[0];
await req('POST',`/model-providers/${mp.id}/selftest`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
await req('PUT','/model-routes',{body:[{task_type:'agent_chat',provider_id:mp.id,model:'mock-writer',fallback_provider_id:null,fallback_model:''}],rawCookie:o.cookie,csrfHeader:o.csrf});
r=await req('POST',`/agent/conversations/${C}/messages`,{body:{text:'密匙abcdef0123456789'},rawCookie:o.cookie,csrfHeader:o.csrf});
console.log(`Q12-密匙16位: ${r.status===422?'BLOCKED-FIXED':'PASSED?'}`);
r=await req('POST',`/agent/conversations/${C}/messages`,{body:{text:'今天天气不错'},rawCookie:o.cookie,csrfHeader:o.csrf});
console.log(`Q12-normal: ${r.status===200?'STILL-OK':'REGRESSED '+r.status}`);
process.exit(0);
