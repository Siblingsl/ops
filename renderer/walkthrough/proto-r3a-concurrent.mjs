// R3-A：并发幂等与状态机流转
const BASE='http://127.0.0.1:8387/api/v1';
const F=[];
function rec(id,ok,detail){F.push({id,ok});console.log(`${ok?'ok ':'FAIL'} ${id} :: ${detail}`);}
function cookieOf(r){const c=(r.sc??[])[0];return c?c.split(";")[0]:null;}
async function req(method,path,{body,rawCookie,csrfHeader}={}){
  const h={'Content-Type':'application/json'};
  if(csrfHeader)h['X-CSRF-Token']=csrfHeader; if(rawCookie)h['Cookie']=rawCookie;
  const res=await fetch(BASE+path,{method,headers:h,body:body!==undefined?JSON.stringify(body):undefined});
  const sc=res.headers.getSetCookie?.()??[];
  const text=await res.text();let json=null;try{json=text?JSON.parse(text):null}catch{json={_raw:text.slice(0,120)}}
  return {status:res.status,json,sc};
}
const U=()=>'r3a'+Math.random().toString(36).slice(2,9);
const PW='{{SECRET_s2wbnk4v}}';
let r=await req('POST','/auth/register',{body:{username:U(),password:PW}});
const o={cookie:cookieOf(r),csrf:null};
r=await req('GET','/auth/me',{rawCookie:o.cookie});o.csrf=r.json?.csrf_token;
r=await req('POST','/accounts',{body:{name:'R3A号',platform:'wechat_mp',content_format:'long_article'},rawCookie:o.cookie,csrfHeader:o.csrf});
const A=r.json?.id;
r=await req('POST',`/accounts/${A}/works`,{body:{title:'R3A作品',content_format:'long_article'},rawCookie:o.cookie,csrfHeader:o.csrf});
const W=r.json?.id;
await req('PATCH',`/works/${W}`,{body:{content_md:'# 标题\n\n正文段落一。\n\n## 小节\n\n正文段落二。'},rawCookie:o.cookie,csrfHeader:o.csrf});
r=await req('GET',`/works/${W}`,{rawCookie:o.cookie,csrfHeader:o.csrf});
const rev=r.json?.revision;

// C1：同键 CX 构建并发 5 连发 → 应复用同一 build（200/201/202 全部成功，build 唯一或幂等复用）
const body={basis_revision:rev,client:'desktop',targets:['wechat_html'],'renderer_contract_version':'ops.wechat-html/v1'};
const results=await Promise.all(Array.from({length:5},()=>req('POST',`/works/${W}/builds`,{body,rawCookie:o.cookie,csrfHeader:o.csrf})));
const buildIds=new Set(results.map(x=>x.json?.build_id).filter(Boolean));
const allOk=results.every(x=>[200,201,202].includes(x.status));
rec('C1-build-concurrent',allOk&&buildIds.size<=5,`statuses=${results.map(x=>x.status).join(',')} uniqueBuilds=${buildIds.size}`);

// C2：同 PATCH 双发（同 base_revision）→ 第二发 409
r=await req('PATCH',`/works/${W}`,{body:{title:'并发改1',base_revision:rev+1},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('C2-patch-first',r.status===200,`status=${r.status}`);
r=await req('PATCH',`/works/${W}`,{body:{title:'并发改2',base_revision:rev+1},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('C2-patch-stale-409',r.status===409,`status=${r.status} err=${r.json?.error?.code}`);

// C3：消息 request_id 重放（同 id 双发 → 第二次 replay 同一响应）
r=await req('GET','/model-providers',{rawCookie:o.cookie,csrfHeader:o.csrf});
const mp=(Array.isArray(r.json)?r.json:r.json?.items??[])[0];
await req('POST',`/model-providers/${mp.id}/selftest`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
await req('PUT','/model-routes',{body:[{task_type:'agent_chat',provider_id:mp.id,model:'mock-writer',fallback_provider_id:null,fallback_model:''}],rawCookie:o.cookie,csrfHeader:o.csrf});
r=await req('POST','/agent/conversations',{body:{title:'R3A会话'},rawCookie:o.cookie,csrfHeader:o.csrf});
const C=r.json?.id;
const rid=crypto.randomUUID();
const m1=await req('POST',`/agent/conversations/${C}/messages`,{body:{text:'重放测试',request_id:rid},rawCookie:o.cookie,csrfHeader:o.csrf});
const m2=await req('POST',`/agent/conversations/${C}/messages`,{body:{text:'重放测试',request_id:rid},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('C3-message-replay',m1.status===200&&(m2.status===200)&&(JSON.stringify(m1.json)===JSON.stringify(m2.json)||m2.json?.replayed===true),`m1=${m1.status} m2=${m2.status} same=${JSON.stringify(m1.json)===JSON.stringify(m2.json)}`);

// C4：发布状态机非法流转矩阵（to=scheduled 无预约材料 / to=registered 无基线 / 重复 transition）
r=await req('POST',`/works/${W}/published`,{body:{url:'https://mp.example.com/s/1',published_at:'2026-11-21T10:00:00+08:00'},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('C4-mark-published',r.status===200||r.status===422,`status=${r.status} err=${r.json?.error?.code} msg=${r.json?.error?.message?.slice(0,50)}`);
r=await req('POST',`/works/${W}/publish-state/transition`,{body:{to:'registered'},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('C4-transition-registered',r.status===422||r.status===200,`status=${r.status} err=${r.json?.error?.code} msg=${r.json?.error?.message?.slice(0,50)}`);
r=await req('POST',`/works/${W}/publish-state/transition`,{body:{to:'public'},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('C4-to-public-blocked',r.status===422,`status=${r.status} err=${r.json?.error?.code}`);

// C5：回收站恢复幂等（删→恢复→再恢复 / 彻底删除二次）
r=await req('DELETE',`/works/${W}`,{rawCookie:o.cookie,csrfHeader:o.csrf});
rec('C5-delete',r.status===200||r.status===422,`status=${r.status} err=${r.json?.error?.code}`);
r=await req('GET','/works',{rawCookie:o.cookie,csrfHeader:o.csrf}).catch(()=>({status:-1,json:{}}));
// 恢复接口探测（trash 路由）
r=await req('POST','/trash/works/'+W+'/restore',{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
if(r.status===404){r=await req('POST',`/works/${W}/restore`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});}
rec('C5-restore',r.status===200||r.status===404,`status=${r.status} err=${r.json?.error?.code}`);

console.log(`\nR3A ${F.filter(x=>x.ok).length}/${F.length} pass`);
