// K2e：目标（带 request_id）完整闭环
const BASE='http://127.0.0.1:8387/api/v1';
const results=[];
function rec(id,name,ok,detail){results.push({id,name,ok});console.log(`${ok?'PASS':'FAIL'} ${id} ${name} :: ${detail}`);}
function cookieOf(r){const c=(r.sc??[])[0];return c?c.split(";")[0]:null;}
const uuid=()=>crypto.randomUUID();
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
r=await req('POST','/agent/conversations',{body:{title:'目标走查E'},rawCookie:o.cookie,csrfHeader:o.csrf});
const C=r.json?.id;
r=await req('POST',`/agent/conversations/${C}/goal`,{body:{request_id:uuid(),objective:'完成走查目标验证',criteria:[{text:'以走查记录为准'}],run_budget:10},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-131.1','建目标成功',r.status===200||r.status===201,`status=${r.status} err=${r.json?.error?.code} keys=${Object.keys(r.json||{}).slice(0,8)}`);
const g=r.json?.goal;
r=await req('POST',`/agent/conversations/${C}/goal`,{body:{request_id:uuid(),objective:'第二目标',criteria:[],run_budget:10},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-131.2','第二目标被拒',r.status===409||r.status===422,`status=${r.status} err=${r.json?.error?.code}`);
r=await req('POST',`/agent/conversations/${C}/goal`,{body:{request_id:uuid(),objective:'越界条件',criteria:[{text:'c1'},{text:'c2'},{text:'c3'},{text:'c4'},{text:'c5'},{text:'c6'}],run_budget:10},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-131.4','条件>5被拒',r.status===422,`status=${r.status}`);
if(g?.id){
  r=await req('POST',`/agent/goals/${g.id}/control`,{body:{request_id:uuid(),action:'pause'},rawCookie:o.cookie,csrfHeader:o.csrf});
  rec('F-132.2','目标控制(pause)',r.status===200||r.status===422,`status=${r.status} err=${r.json?.error?.code}`);
}
console.log(`\nSUMMARY ${results.filter(x=>x.ok).length}/${results.length} pass`);
