// K1b：智能体消息（text 字段）+ HC-30 密钥 + 模式校验
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
const PW='{{SECRET_m2kqnvzr}}';
let r=await req('POST','/auth/register',{body:{username:U(),password:PW}});
const o={cookie:cookieOf(r),csrf:null};
r=await req('GET','/auth/me',{rawCookie:o.cookie});o.csrf=r.json?.csrf_token;
r=await req('POST','/agent/conversations',{body:{title:'红线走查b'},rawCookie:o.cookie,csrfHeader:o.csrf});
const C=r.json?.id;
rec('K1.1','新建会话',r.status===200&&!!C,`conv=${C?.slice(0,8)}`);

// 正常消息（text）
r=await req('POST',`/agent/conversations/${C}/messages`,{body:{text:'列出当前工作区账号'},rawCookie:o.cookie,csrfHeader:o.csrf});
const run=r.json?.run?.id??r.json?.run_id;
rec('K1.2','发消息受理(text)',r.status===200||r.status===202,`status=${r.status} run=${(run||'')?.slice(0,8)} err=${r.json?.error?.code} keys=${Object.keys(r.json||{}).slice(0,8)}`);

// HC-30 密钥拒发
r=await req('POST',`/agent/conversations/${C}/messages`,{body:{text:'请保存这个密码 sk-abcdefgh1234567890XYZ'},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-M13.10','疑似密钥拒发(HC-30)',r.status===422&&/密钥|密码/.test(r.json?.error?.message??''),`status=${r.status} msg=${r.json?.error?.message?.slice(0,60)}`);

// 非法模式
r=await req('POST',`/agent/conversations/${C}/messages`,{body:{text:'hi',mode:'bogus_mode'},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-119.1','非法模式被拒',r.status===422,`status=${r.status} err=${r.json?.error?.code}`);

// 8000 字超限
r=await req('POST',`/agent/conversations/${C}/messages`,{body:{text:'x'.repeat(8001)},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-112.1','消息>8000字被拒',r.status===422,`status=${r.status} err=${r.json?.error?.code}`);

// 会话组织：置顶/改名
r=await req('GET','/agent/conversations',{rawCookie:o.cookie,csrfHeader:o.csrf});
const convs=r.json?.items??r.json?.conversations??(Array.isArray(r.json)?r.json:[]);
rec('F-109.1','会话列表',r.status===200&&convs.length>=1,`n=${convs.length??'?'}`);
if(C){
  r=await req('PATCH',`/agent/conversations/${C}`,{body:{title:'改名成功',pinned:true},rawCookie:o.cookie,csrfHeader:o.csrf});
  rec('F-109.2','置顶+改名',r.status===200,`status=${r.status} err=${r.json?.error?.code}`);
}

console.log(`\nSUMMARY ${results.filter(x=>x.ok).length}/${results.length} pass`);
