// K2b：目标/委派/浏览器授权/computer 授权（真实路由）
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
r=await req('POST','/agent/conversations',{body:{title:'面板走查B'},rawCookie:o.cookie,csrfHeader:o.csrf});
const C=r.json?.id;

// F-131 目标（真实路径 /goal）
r=await req('POST',`/agent/conversations/${C}/goal`,{body:{text:'完成走查目标：验证目标面板契约',conditions:['以走查记录为准'],budget_runs:10},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-131.1','建目标',r.status===200||r.status===201||r.status===422,`status=${r.status} err=${r.json?.error?.code} msg=${r.json?.error?.message?.slice(0,80)}`);
r=await req('POST',`/agent/conversations/${C}/goal`,{body:{text:'x'.repeat(501),conditions:[],budget_runs:10},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-131.3','目标>500字被拒',r.status===422,`status=${r.status} err=${r.json?.error?.code}`);
r=await req('GET',`/agent/conversations/${C}/goal-runs`,{rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-132.1','goal-runs 读',r.status===200,`status=${r.status}`);

// F-137 浏览器授权
r=await req('GET','/agent/browser/capabilities',{rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-137.1','browser capabilities',r.status===200,`status=${r.status}`);
r=await req('GET','/agent/browser/bindings',{rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-137.2','browser bindings',r.status===200,`status=${r.status}`);

// F-138 computer 授权
r=await req('GET','/agent/computer/capabilities',{rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-138.1','computer capabilities',r.status===200,`status=${r.status}`);
r=await req('GET','/agent/computer-grants',{rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-138.2','computer grants 列表',r.status===200,`status=${r.status}`);

// F-165 今日运营
r=await req('GET','/agent/today-ops',{rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-165.1','today-ops 读',r.status===200,`status=${r.status} keys=${Object.keys(r.json||{}).slice(0,6)}`);

// F-115 上下文预览
r=await req('POST','/agent/context-preview',{body:{text:'预览走查',references:[]},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('F-115.1','上下文预览',r.status===200||r.status===422,`status=${r.status} err=${r.json?.error?.code}`);

// F-109 会话分组
r=await req('POST','/agent/conversation-groups',{body:{name:'走查分组',private:true},rawCookie:o.cookie,csrfHeader:o.csrf});
const G=r.json?.id;
rec('F-109.3','私有分组创建',r.status===200||r.status===201||r.status===422,`status=${r.status} err=${r.json?.error?.code}`);

console.log(`\nSUMMARY ${results.filter(x=>x.ok).length}/${results.length} pass`);
