const BASE='http://127.0.0.1:8387/api/v1';
function cookieOf(r){const c=(r.sc??[])[0];return c?c.split(";")[0]:null;}
async function req(method,path,{body,rawCookie,csrfHeader}={}){
  const h={'Content-Type':'application/json'};
  if(csrfHeader)h['X-CSRF-Token']=csrfHeader; if(rawCookie)h['Cookie']=rawCookie;
  const res=await fetch(BASE+path,{method,headers:h,body:body!==undefined?JSON.stringify(body):undefined});
  const sc=res.headers.getSetCookie?.()??[];
  const text=await res.text();let json=null;try{json=text?JSON.parse(text):null}catch{json={}}
  return {status:res.status,json,sc};
}
let r=await req('POST','/auth/register',{body:{username:'wt2g'+Math.random().toString(36).slice(2,9),password:'{{SECRET_s2wbnk4v}}'}});
const o={cookie:cookieOf(r),csrf:null};
r=await req('GET','/auth/me',{rawCookie:o.cookie});o.csrf=r.json?.csrf_token;
r=await req('GET','/model-providers',{rawCookie:o.cookie,csrfHeader:o.csrf});
const mp=(Array.isArray(r.json)?r.json:r.json?.items??[])[0];
await req('POST',`/model-providers/${mp.id}/selftest`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
await req('PUT','/model-routes',{body:[{task_type:'agent_chat',provider_id:mp.id,model:'mock-writer',fallback_provider_id:null,fallback_model:''}],rawCookie:o.cookie,csrfHeader:o.csrf});
r=await req('POST','/agent/conversations',{body:{title:'Q12g'},rawCookie:o.cookie,csrfHeader:o.csrf});
const C=r.json?.id;
const cases=[
 ['POS kw+16',    'password: {{SECRET_hz9rcb56}}'],
 ['POS zh密钥+16', '密钥：{{SECRET_s3nrqjhd}}'],
 ['POS apikey+18', 'apikey {{SECRET_o6mkznds}}'],
 ['NEG 15位',     'password: {{SECRET_q4vwjd8c}}'],
 ['NEG 密匙+16',   '密匙{{SECRET_i2tbnlqk}}'],
 ['NEG kw-gap-21', 'password'+' '.repeat(21)+'{{SECRET_wqk3fzcs}}'],
 ['NEG sk-19',    'sk-{{SECRET_fi82uy6k}}'],
 ['NEG 无关',      '今天天气不错，适合写稿'],
];
const got=[];
for(const [name,text] of cases){
  const x=await req('POST',`/agent/conversations/${C}/messages`,{body:{text},rawCookie:o.cookie,csrfHeader:o.csrf});
  got.push([name,x.status===422]);
  console.log(`${name}: ${x.status===422?'BLOCKED':'PASSED'} ${x.json?.error?.message?.slice(0,26)??''}`);
}
const blocked=new Map(got);
const allPosBlocked=['POS kw+16','POS zh密钥+16','POS apikey+18'].every(k=>blocked.get(k));
const allNegPassed=['NEG 15位','NEG 密匙+16','NEG kw-gap-21','NEG sk-19','NEG 无关'].every(k=>!blocked.get(k));
console.log(`VERDICT: posBlocked=${allPosBlocked} negPassed=${allNegPassed}`);
process.exit(0);
