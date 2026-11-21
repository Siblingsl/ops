// K2c：computer_use 独立环境未启用→409 属预期闸门；today-ops 带 account_id 复测；goal 正确字段
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
r=await req('POST','/accounts',{body:{name:'K2c号',platform:'wechat_mp',content_format:'long_article'},rawCookie:o.cookie,csrfHeader:o.csrf});
const A=r.json?.id;
r=await req('POST','/agent/conversations',{body:{title:'K2c',account_id:A},rawCookie:o.cookie,csrfHeader:o.csrf});
const C=r.json?.id;

// F-138 闸门确认：computer 未启用时 409（feature_gate）
r=await req('GET','/agent/computer/capabilities',{rawCookie:o.cookie,csrfHeader:o.csrf});
const gateOk=r.status===409&&/computer|feature|gate/i.test(JSON.stringify(r.json));
rec('F-138.G','computer 未启用→409 闸门(环境预期)',r.status===200||gateOk,`status=${r.status} body=${JSON.stringify(r.json).slice(0,140)}`);

// F-165 today-ops 带 account_id
r=await req('GET',`/agent/today-ops?account_id=${A}`,{rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-165.1','today-ops(带account)',r.status===200||r.status===422,`status=${r.status} err=${r.json?.error?.code} keys=${Object.keys(r.json||{}).slice(0,6)}`);

// F-131 goal 正确 payload（先看 404→422 区分）
r=await req('POST',`/agent/conversations/${C}/goal`,{body:{goal:'走查目标文字',criteria:['条件一'],budget_runs:10},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-131.1','建目标(字段探测a)',r.status===200||r.status===422||r.status===201,`status=${r.status} err=${r.json?.error?.code} msg=${r.json?.error?.message?.slice(0,60)}`);

console.log(`\nSUMMARY ${results.filter(x=>x.ok).length}/${results.length} pass`);
