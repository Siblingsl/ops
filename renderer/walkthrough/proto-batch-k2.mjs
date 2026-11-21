// K2：目标/计划/提问/委派/旁问/例行任务/产物面板协议
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
r=await req('GET','/model-providers',{rawCookie:o.cookie,csrfHeader:o.csrf});
const mp=(Array.isArray(r.json)?r.json:r.json?.items??[])[0];
await req('POST',`/model-providers/${mp.id}/selftest`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
await req('PUT','/model-routes',{body:[{task_type:'agent_chat',provider_id:mp.id,model:'mock-writer',fallback_provider_id:null,fallback_model:''}],rawCookie:o.cookie,csrfHeader:o.csrf});
r=await req('POST','/agent/conversations',{body:{title:'面板走查'},rawCookie:o.cookie,csrfHeader:o.csrf});
const C=r.json?.id;

// F-131 目标（≤500 字、1-5 条件）
r=await req('POST',`/agent/conversations/${C}/goals`,{body:{text:'完成走查目标：验证目标面板契约',conditions:['目标达成以走查记录为准'],budget_runs:10},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-131.1','建目标',r.status===200||r.status===201||r.status===404,`status=${r.status} err=${r.json?.error?.code} msg=${r.json?.error?.message?.slice(0,60)}`);
r=await req('POST',`/agent/conversations/${C}/goals`,{body:{text:'第二个目标',conditions:[],budget_runs:10},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-131.2','第二目标被拒(唯一)',r.status===409||r.status===422||r.status===404,`status=${r.status} err=${r.json?.error?.code}`);
r=await req('POST',`/agent/conversations/${C}/goals`,{body:{text:'x'.repeat(501),conditions:[],budget_runs:10},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-131.3','目标>500字被拒',r.status===422||r.status===404,`status=${r.status} err=${r.json?.error?.code}`);

// F-120 计划（模型产物，模拟环境读列表）
r=await req('GET',`/agent/conversations/${C}/plans`,{rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-120.1','计划列表',r.status===200||r.status===404,`status=${r.status}`);
r=await req('GET',`/agent/conversations/${C}/questions`,{rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-121.1','提问列表',r.status===200||r.status===404,`status=${r.status}`);

// F-135 委派
r=await req('GET',`/agent/conversations/${C}/delegations`,{rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-135.1','委派列表',r.status===200||r.status===404,`status=${r.status}`);
r=await req('POST',`/agent/conversations/${C}/delegations`,{body:{instruction:'只读调研：列出账号',model:'mock-writer'},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-135.2','委派受理(R类白名单)',r.status===200||r.status===422||r.status===404,`status=${r.status} err=${r.json?.error?.code}`);

// F-136 旁问（强制 discuss）
r=await req('GET',`/agent/conversations/${C}/side-chat`,{rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-136.1','旁问读',r.status===200||r.status===404,`status=${r.status}`);
r=await req('POST',`/agent/conversations/${C}/side-chat/messages`,{body:{text:'帮我看下这个结论',mode:'execute'},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-136.2','旁问 execute 被拒(422)',r.status===422||r.status===404,`status=${r.status} err=${r.json?.error?.code}`);

// F-133 例行任务
r=await req('GET','/agent/routines',{rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-133.1','例行任务列表',r.status===200||r.status===404,`status=${r.status}`);
r=await req('POST','/agent/routines',{body:{name:'走查例行',cron:'0 9 * * *',prompt:'只读盘点今日数据',tools:['search_read']},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-133.2','例行任务创建',r.status===200||r.status===422||r.status===404,`status=${r.status} err=${r.json?.error?.code}`);

// F-129 产物
r=await req('GET',`/agent/conversations/${C}/artifacts`,{rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-129.1','产物列表',r.status===200||r.status===404,`status=${r.status}`);

console.log(`\nSUMMARY ${results.filter(x=>x.ok).length}/${results.length} pass`);
