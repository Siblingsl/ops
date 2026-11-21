// Q-12 探针：HC-30 密钥检测的绕过形态对照（协议面实测）
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
const U=()=>'wt2d'+Math.random().toString(36).slice(2,9);
const PW='{{SECRET_s2wbnk4v}}';
let r=await req('POST','/auth/register',{body:{username:U(),password:PW}});
const o={cookie:cookieOf(r),csrf:null};
r=await req("GET","/auth/me",{rawCookie:o.cookie});o.csrf=r.json?.csrf_token;
await req("GET","/model-providers",{rawCookie:o.cookie,csrfHeader:o.csrf}).then(async x=>{const mp=(Array.isArray(x.json)?x.json:x.json?.items??[])[0];await req("POST",`/model-providers/${mp.id}/selftest`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});await req("PUT","/model-routes",{body:[{task_type:"agent_chat",provider_id:mp.id,model:"mock-writer",fallback_provider_id:null,fallback_model:""}],rawCookie:o.cookie,csrfHeader:o.csrf});});
r=await req('GET','/auth/me',{rawCookie:o.cookie});o.csrf=r.json?.csrf_token;
r=await req('POST','/agent/conversations',{body:{title:'Q12'},rawCookie:o.cookie,csrfHeader:o.csrf});
const C=r.json?.id;
// 变体表：期望命中（422）的应被拦；标注实测
const cases=[
 ['kw-gap-21',    'password' + ' '.repeat(21) + 'abcdefghijklmnop'],      // 关键词后>20 字符才出现 16 位串 → 正则不命中
 ['kw-split-16',  'secret abc def ghij klmnop'],                          // 16 位被空格切分 → 不命中
 ['sk-19',        'sk-abcdefghijklmnopqrs'],                              // sk-+19 位 → 不命中
 ['bearer-plain', 'authorization: Bearer 1234567890abcdef'],              // cookie 值规则命中（token 在词表）→ 命中
 ['pass-8',       'password: ab12cd34'],                                  // 8 位值 → 关键词规则需 16 位 → 不命中
 ['zh-mi',        '密匙 ab12cd34ef56gh78'],                               // 「密匙」不在词表 → 不命中
];
for(const [name,text] of cases){
  const r=await req('POST',`/agent/conversations/${C}/messages`,{body:{text},rawCookie:o.cookie,csrfHeader:o.csrf});
  console.log(`${name}: status=${r.status} ${r.status===422?'BLOCKED':'PASSED-THROUGH'} ${r.json?.error?.message?.slice(0,30)??''}`);
}
process.exit(0);
