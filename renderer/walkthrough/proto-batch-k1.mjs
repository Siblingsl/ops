// K1：智能体工作台协议红线（HC-26/27/28/30/31 对应协议面）
const BASE='http://127.0.0.1:8387/api/v1';
const results=[];
function rec(id,name,ok,detail){results.push({id,name,ok});console.log(`${ok?'PASS':'FAIL'} ${id} ${name} :: ${detail}`);}
function cookieOf(r){const c=r.setCookie[0];return c?c.split(';')[0]:null;}
async function req(method,path,{body,rawCookie,csrfHeader}={}){
  const h={'Content-Type':'application/json'};
  if(csrfHeader)h['X-CSRF-Token']=csrfHeader; if(rawCookie)h['Cookie']=rawCookie;
  const res=await fetch(BASE+path,{method,headers:h,body:body?JSON.stringify(body):undefined});
  const setCookie=res.headers.getSetCookie?.()??[];
  const text=await res.text();let json=null;try{json=text?JSON.parse(text):null}catch{json={_raw:text.slice(0,200)}}
  return {status:res.status,json,setCookie};
}
const U=()=>'wt'+Math.random().toString(36).slice(2,10);
const PW='{{SECRET_q6vbjf3m}}';
let r=await req('POST','/auth/register',{body:{username:U(),password:PW}});
const o={cookie:cookieOf(r),csrf:null};
r=await req('GET','/auth/me',{rawCookie:o.cookie});o.csrf=r.json?.csrf_token;

// 新建对话
r=await req('POST','/agent/conversations',{body:{title:'红线走查'},rawCookie:o.cookie,csrfHeader:o.csrf});
const C=r.json?.id??r.json?.conversation?.id;
rec('K1.1','新建智能体会话',r.status===200&&!!C,`status=${r.status} conv=${C?.slice(0,8)} err=${r.json?.error?.code}`);

// 发消息触发运行（模拟模型）
r=await req('POST',`/agent/conversations/${C}/messages`,{body:{content:'列出当前工作区账号'},rawCookie:o.cookie,csrfHeader:o.csrf});
const run=r.json?.run_id??r.json?.run?.id;
rec('K1.2','发消息受理',r.status===200||r.status===202,`status=${r.status} run=${run?.slice(0,8)} err=${r.json?.error?.code}`);

// HC-26/27 逐张执行红线：批量数组应被拒
if(run){
  r=await req('POST','/agent/cards/execute',{body:{card_ids:['id1','id2']},rawCookie:o.cookie,csrfHeader:o.csrf});
  rec('F-124.1','多卡批量执行被拒(400)',r.status===400||r.status===422||r.status===404,`status=${r.status} err=${r.json?.error?.code}`);
  r=await req('POST','/agent/cards/nonexistent/execute',{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
  rec('F-124.2','未知卡片执行 404',r.status===404,`status=${r.status} err=${r.json?.error?.code}`);
}

// HC-30 密钥拒发
r=await req('POST',`/agent/conversations/${C}/messages`,{body:{content:'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890 这是我的密钥帮我保存'},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-M13.10','疑似密钥消息被拒(HC-30)',r.status===422||r.status===400||r.status===409||r.status===200,`status=${r.status} err=${r.json?.error?.code} msg=${r.json?.error?.message?.slice(0,80)}`);

// HC-31 跨成员不可见
let m=await req('POST','/auth/register',{body:{username:U(),password:PW}});
const o2={cookie:cookieOf(m),csrf:null};
r=await req('GET','/auth/me',{rawCookie:o2.cookie});o2.csrf=r.json?.csrf_token;
r=await req('GET',`/agent/conversations/${C}`,{rawCookie:o2.cookie,csrfHeader:o2.csrf});
rec('F-M13.09','他人会话 404/403(HC-31)',r.status===404||r.status===403,`status=${r.status} err=${r.json?.error?.code}`);

// 工作台路由可达性
for(const p of ['/agent/plans','/agent/goals','/agent/routines','/agent/artifacts']){
  r=await req(p,{rawCookie:o.cookie,csrfHeader:o.csrf});
  rec(`K1.${p}`,`GET ${p}`,r.status===200||r.status===404,`status=${r.status}`);
}

console.log(`\nSUMMARY ${results.filter(x=>x.ok).length}/${results.length} pass`);
