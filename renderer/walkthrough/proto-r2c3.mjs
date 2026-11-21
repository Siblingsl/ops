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
let r=await req('POST','/auth/register',{body:{username:'wt2f'+Math.random().toString(36).slice(2,9),password:'{{SECRET_s2wbnk4v}}'}});
const o={cookie:cookieOf(r),csrf:null};
r=await req('GET','/auth/me',{rawCookie:o.cookie});o.csrf=r.json?.csrf_token;
r=await req('POST','/agent/conversations',{body:{title:'Q12f'},rawCookie:o.cookie,csrfHeader:o.csrf});
const C=r.json?.id;
const cases=[
 ['POS kw+16',   'password: {{SECRET_hz9rcb56}}'],
 ['POS zh密钥+16','密钥：{{SECRET_s3nrqjhd}}'],
 ['POS apikey+18','apikey {{SECRET_o6mkznds}}'],
 ['NEG 15位',    'password: {{SECRET_q4vwjd8c}}'],
 ['NEG 密匙+16',  '密匙{{SECRET_i2tbnlqk}}'],
];
for(const [name,text] of cases){
  const x=await req('POST',`/agent/conversations/${C}/messages`,{body:{text},rawCookie:o.cookie,csrfHeader:o.csrf});
  console.log(`${name}: ${x.status===422?'BLOCKED':'PASSED'} ${x.json?.error?.message?.slice(0,24)??''}`);
}
process.exit(0);
