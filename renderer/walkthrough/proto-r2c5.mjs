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
let r=await req('POST','/auth/register',{body:{username:'wt2h'+Math.random().toString(36).slice(2,9),password:'{{SECRET_s2wbnk4v}}'}});
const o={cookie:cookieOf(r),csrf:null};
r=await req('GET','/auth/me',{rawCookie:o.cookie});o.csrf=r.json?.csrf_token;
r=await req('GET','/model-providers',{rawCookie:o.cookie,csrfHeader:o.csrf});
const mp=(Array.isArray(r.json)?r.json:r.json?.items??[])[0];
await req('POST',`/model-providers/${mp.id}/selftest`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
await req('PUT','/model-routes',{body:[{task_type:'agent_chat',provider_id:mp.id,model:'mock-writer',fallback_provider_id:null,fallback_model:''}],rawCookie:o.cookie,csrfHeader:o.csrf});
r=await req('POST','/agent/conversations',{body:{title:'Q12h'},rawCookie:o.cookie,csrfHeader:o.csrf});
const C=r.json?.id;
const v16a='AbCdEf123456GhIj';
const v16b='ZxQwVk9MnB3TgY2P';
const v15='AbCdEf123456GhI';
const cases=[
 ['POS kw+16',     `password: ${v16a}`, true],
 ['POS zh密钥+16',  `密钥：${v16b}`, true],
 ['NEG 15位',      `password: ${v15}`, false],
 ['NEG kw-gap-21', 'password'+' '.repeat(21)+v16a, false],
 ['NEG 密匙+16',    `密匙${v16b}`, false],
 ['NEG sk-19',     'sk-AbCdEf123456GhIjKl', false],
 ['NEG 无关',       '今天天气不错，适合写稿', false],
];
let pass=0;
for(const [name,text,expectBlock] of cases){
  const x=await req('POST',`/agent/conversations/${C}/messages`,{body:{text},rawCookie:o.cookie,csrfHeader:o.csrf});
  const blocked=x.status===422;
  const ok=blocked===expectBlock;
  if(ok)pass++;
  console.log(`${ok?'ok ':'FAIL'} ${name}: ${blocked?'BLOCKED':'PASSED'} (期望${expectBlock?'拦':'放'}) ${x.json?.error?.message?.slice(0,30)??''}`);
}
console.log(`SECRET-MATRIX ${pass}/${cases.length}`);
process.exit(0);
