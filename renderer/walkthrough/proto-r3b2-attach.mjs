// R3-B2：agent 附件限额精测（正确路由 /agent/attachments）
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
async function up(csrf,cookie,bytes,name,type){
  const form=new FormData();
  form.append('file',new File([new Uint8Array(bytes)],name,{type}));
  const res=await fetch(BASE+'/agent/attachments',{method:'POST',headers:{'X-CSRF-Token':csrf,Cookie:cookie},body:form});
  const t=await res.text();let j=null;try{j=t?JSON.parse(t):null}catch{j={}}
  return {status:res.status,json:j};
}
let r=await req('POST','/auth/register',{body:{username:'r3b2'+Math.random().toString(36).slice(2,9),password:'{{SECRET_s2wbnk4v}}'}});
const o={cookie:cookieOf(r),csrf:null};
r=await req('GET','/auth/me',{rawCookie:o.cookie});o.csrf=r.json?.csrf_token;
r=await req('GET','/model-providers',{rawCookie:o.cookie,csrfHeader:o.csrf});
const mp=(Array.isArray(r.json)?r.json:r.json?.items??[])[0];
await req('POST',`/model-providers/${mp.id}/selftest`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
await req('PUT','/model-routes',{body:[{task_type:'agent_chat',provider_id:mp.id,model:'mock-writer',fallback_provider_id:null,fallback_model:''}],rawCookie:o.cookie,csrfHeader:o.csrf});
r=await req('POST','/agent/conversations',{body:{title:'R3B2'},rawCookie:o.cookie,csrfHeader:o.csrf});
const C=r.json?.id;
// 6MB 文本 → 422（1MB 上限）
const big=await up(o.csrf,o.cookie,6*1024*1024,'big.txt','text/plain');
console.log(`6MB-txt: ${big.status} ${big.json?.error?.code??''}`);
// 恶意扩展名 .exe
const exe=await up(o.csrf,o.cookie,100,'a.exe','application/octet-stream');
console.log(`exe: ${exe.status} ${exe.json?.error?.code??''}`);
// 7 个附件（每消息 ≤6）
const ids=[];
for(let i=0;i<7;i++){
  const a=await up(o.csrf,o.cookie,20,`a${i}.txt`,'text/plain');
  if(a.status===200&&a.json?.id)ids.push(a.json.id);
}
r=await req('POST',`/agent/conversations/${C}/messages`,{body:{text:'七附件',attachment_ids:ids},rawCookie:o.cookie,csrfHeader:o.csrf});
console.log(`7-atts: ${r.status} ${r.json?.error?.code??''} ids=${ids.length}`);
// 秘密文本附件（quarantined）
const form=new FormData();
form.append('file',new File(['token: {{SECRET_ab4cdetf}}'],'s.txt',{type:'text/plain'}));
const sr=await fetch(BASE+'/agent/attachments',{method:'POST',headers:{'X-CSRF-Token':o.csrf,Cookie:o.cookie},body:form});
const st=await sr.text();let sj=null;try{sj=st?JSON.parse(st):null}catch{sj={}}
console.log(`secret-att: ${sr.status} state=${sj?.parse_status??sj?.attachment?.parse_status??'?'} ${JSON.stringify(sj).slice(0,80)}`);
process.exit(0);
