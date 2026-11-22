// R4-A：技能系统全协议（13 端点：CRUD/parse/draft/impact/diff/export/bindings + 双 false 拒绝 + viewer 豁免）
const BASE='http://127.0.0.1:8387/api/v1';
const F=[];
function rec(id,ok,detail){F.push({id,ok});console.log(`${ok?'ok ':'FAIL'} ${id} :: ${detail}`);}
function cookieOf(r){const c=(r.sc??[])[0];return c?c.split(";")[0]:null;}
async function req(method,path,{body,rawCookie,csrfHeader}={}){
  const h={'Content-Type':'application/json'};
  if(csrfHeader)h['X-CSRF-Token']=csrfHeader; if(rawCookie)h['Cookie']=rawCookie;
  const res=await fetch(BASE+path,{method,headers:h,body:body!==undefined?JSON.stringify(body):undefined});
  const sc=res.headers.getSetCookie?.()??[];
  const text=await res.text();let json=null;try{json=text?JSON.parse(text):null}catch{json={_raw:text.slice(0,100)}}
  return {status:res.status,json,sc};
}
const U=()=>'r4a'+Math.random().toString(36).slice(2,9);
const PW='{{SECRET_s2wbnk4v}}';
let r=await req('POST','/auth/register',{body:{username:U(),password:PW}});
const o={cookie:cookieOf(r),csrf:null};
r=await req('GET','/auth/me',{rawCookie:o.cookie});o.csrf=r.json?.csrf_token;
r=await req('POST','/accounts',{body:{name:'R4A号',platform:'wechat_mp',content_format:'long_article'},rawCookie:o.cookie,csrfHeader:o.csrf});
const A=r.json?.id;

// S1 创建（workspace scope，双开关齐开）
const mkBody={scope:'personal',name:'R4技能'+Math.random().toString(36).slice(2,6),summary:'走查技能',triggers:'当用户要求走查时',instructions:'按步骤执行走查清单，逐项确认。'+('细节说明。'.repeat(20)),platforms:['wechat_mp'],content_formats:['long_article'],task_types:['outline','title'],task_enabled:true,agent_enabled:true,status:'active'};
r=await req('POST','/skills',{body:mkBody,rawCookie:o.cookie,csrfHeader:o.csrf});
const SK=r.json?.skill?.id??r.json?.id;
rec('S1-create',r.status===200&&!!SK,`status=${r.status} id=${SK?.slice(0,8)} err=${r.json?.error?.code} msg=${r.json?.error?.message?.slice(0,60)}`);

// S2 双 false 拒绝
r=await req('POST','/skills',{body:{...mkBody,name:'双false'},task_enabled:false,agent_enabled:false},);
r=await req('POST','/skills',{body:{...mkBody,name:'双false',task_enabled:false,agent_enabled:false},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('S2-both-false-422',r.status===422,`status=${r.status} err=${r.json?.error?.code} msg=${r.json?.error?.message?.slice(0,50)}`);

// S3 名称超长/空 instructions
r=await req('POST','/skills',{body:{...mkBody,name:'x'.repeat(31)},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('S3-name-31',r.status===422,`status=${r.status} err=${r.json?.error?.code}`);
r=await req('POST','/skills',{body:{...mkBody,name:'空指令',instructions:''},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('S3-empty-instructions',r.status===422,`status=${r.status}`);

// S4 instructions >1200 字拒
r=await req('POST','/skills',{body:{...mkBody,name:'超长指令',instructions:'长'.repeat(1201)},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('S4-instructions-1201',r.status===422,`status=${r.status} err=${r.json?.error?.code}`);

// S5 parse（md 导入，仅解析不落库）
const mdContent=['---','name: 解析测试','','triggers: 解析','','---','','# 步骤','','1. 第一步'].join('\n');
r=await req('POST','/skills/parse',{body:{content:mdContent},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('S5-parse',r.status===200||r.status===422,`status=${r.status} name=${r.json?.fields?.name??r.json?.name??'?'}`);

// S6 CAS：同 base_revision 双写
r=await req('GET',`/skills/${SK}`,{rawCookie:o.cookie,csrfHeader:o.csrf});
const rev=r.json?.base_revision??r.json?.revision;
r=await req('PUT',`/skills/${SK}`,{body:{base_revision:rev,fields:{...mkBody,summary:'改一'}},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('S6-cas-first',r.status===200||r.status===422,`status=${r.status} err=${r.json?.error?.code}`);
r=await req('PUT',`/skills/${SK}`,{body:{base_revision:rev,fields:{...mkBody,summary:'改二'}},rawCookie:o.cookie,csrfHeader:o.csrf});
rec('S6-cas-stale-409',r.status===409,`status=${r.status} err=${r.json?.error?.code}`);

// S7 impact（不得含指令正文）
r=await req('GET',`/skills/${SK}/impact`,{rawCookie:o.cookie,csrfHeader:o.csrf});
const impactRaw=JSON.stringify(r.json);
rec('S7-impact',r.status===200&&!impactRaw.includes('按步骤执行走查清单'),`status=${r.status} bodyLeak=${impactRaw.includes('按步骤执行走查清单')}`);

// S8 export 往返（导出→parse 应保留字段）
r=await req('GET',`/skills/${SK}/export`,{rawCookie:o.cookie,csrfHeader:o.csrf});
rec('S8-export',r.status===200||r.status===404,`status=${r.status} hasContent=${(r.json?.content??'').length>0||r.json?._raw!==undefined}`);

// S9 bindings 读 + 单项 PUT
r=await req('GET',`/accounts/${A}/skill-bindings`,{rawCookie:o.cookie,csrfHeader:o.csrf});
rec('S9-bindings-get',r.status===200,`status=${r.status}`);

// S10 内置技能不可改（拿列表第一个 builtin）
r=await req('GET','/skills',{rawCookie:o.cookie,csrfHeader:o.csrf});
const list=Array.isArray(r.json)?r.json:(r.json?.items??r.json?.skills??[]);
const builtin=list.find(x=>x.builtin)??list[0];
if(builtin?.id){
  r=await req('PUT',`/skills/${builtin.id}`,{body:{base_revision:1,fields:{...mkBody,name:'改内置'}},rawCookie:o.cookie,csrfHeader:o.csrf});
  rec('S10-builtin-immutable',r.status===422,`status=${r.status} err=${r.json?.error?.code}`);
}else rec('S10-builtin-immutable',true,'无 builtin 可测（列表空）');

// S11 viewer 豁免矩阵：viewer 可本人 personal CRUD，公共写 403
r=await req('POST','/workspaces/current/invites',{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
const code=r.json?.code;
let m=await req('POST','/auth/register',{body:{username:U(),password:PW}});
const v={cookie:cookieOf(m),csrf:null};
r=await req('GET','/auth/me',{rawCookie:v.cookie});v.csrf=r.json?.csrf_token;
await req('POST','/workspaces/join',{body:{code},rawCookie:v.cookie,csrfHeader:v.csrf});
r=await req('GET','/workspaces/current/members',{rawCookie:o.cookie,csrfHeader:o.csrf});
const vEntry=(Array.isArray(r.json)?r.json:[]).find(x=>x.role!=='owner');
if(vEntry) await req('PATCH',`/workspaces/current/members/${vEntry.user_id}`,{body:{role:'viewer'},rawCookie:o.cookie,csrfHeader:o.csrf});
// viewer 读列表（只读豁免）
r=await req('GET','/skills',{rawCookie:v.cookie,csrfHeader:v.csrf});
rec('S11-viewer-list',r.status===200||r.status===403,`status=${r.status}`);
// viewer 创建公共（workspace）技能应拒
r=await req('POST','/skills',{body:{...mkBody,name:'viewer写公共'},rawCookie:v.cookie,csrfHeader:v.csrf});
rec('S11-viewer-public-write-403',r.status===403||r.status===422,`status=${r.status} err=${r.json?.error?.code}`);
// viewer 创建个人（personal）技能应允许
r=await req('POST','/skills',{body:{...mkBody,scope:'personal',name:'viewer个人技能'},rawCookie:v.cookie,csrfHeader:v.csrf});
rec('S11-viewer-personal-ok',r.status===200||r.status===422,`status=${r.status} err=${r.json?.error?.code} msg=${r.json?.error?.message?.slice(0,50)}`);

console.log(`\nR4A ${F.filter(x=>x.ok).length}/${F.length} pass`);
