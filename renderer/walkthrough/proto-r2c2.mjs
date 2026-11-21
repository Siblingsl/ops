// Q-12 对照矩阵：正样本（应拦）vs 负样本（应放行）
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
const U=()=>'wt2e'+Math.random().toString(36).slice(2,9);
let r=await req('POST','/auth/register',{body:{username:U(),password:'{{SECRET_s2wbnk4v}}'}});
const o={cookie:cookieOf(r),csrf:null};
r=await req('GET','/auth/me',{rawCookie:o.cookie});o.csrf=r.json?.csrf_token;
r=await req('GET','/model-providers',{rawCookie:o.cookie,csrfHeader:o.csrf});
const mp=(Array.isArray(r.json)?r.json:r.json?.items??[])[0];
await req('POST',`/model-providers/${mp.id}/selftest`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
await req('PUT','/model-routes',{body:[{task_type:'agent_chat',provider_id:mp.id,model:'mock-writer',fallback_provider_id:null,fallback_model:''}],rawCookie:o.cookie,csrfHeader:o.csrf});
r=await req('POST','/agent/conversations',{body:{title:'Q12c'},rawCookie:o.cookie,csrfHeader:o.csrf});
const C=r.json?.id;
const cases=[
 ['POS kw-16',      'password: {{SECRET_b3gpql9i}}'],
 ['POS zh-密钥',     '密钥{{SECRET_k8nvjwsc}}'],
 ['POS zh-密码',     '密码 {{SECRET_m2sypcq4}}'],
 ['POS apikey',     'apikey {{SECRET_t5rljvwq}}'],
 ['NEG 明文口令8位',  'password: ab12cd34'],
 ['NEG 16位无关键词', 'secret abc def ghij klmnop'],
 ['NEG sk-19',      'sk-{{SECRET_fi82uy6k}}'],
 ['NEG 密匙',        '密匙ab12cd34ef56gh78'],
 ['NEG kw-gap-21',  'password'+' '.repeat(21)+'{{SECRET_wqk3fzcs}}'],
];
for(const [name,text] of cases){
  const r=await req('POST',`/agent/conversations/${C}/messages`,{body:{text},rawCookie:o.cookie,csrfHeader:o.csrf});
  console.log(`${name}: ${r.status===422?'BLOCKED':r.status===200?'PASSED':'S'+r.status} ${r.json?.error?.message?.slice(0,26)??''}`);
}
process.exit(0);
