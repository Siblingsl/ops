// R4-A3：PUT 平铺字段 + impact(action 参数) + viewer 公共写正确形态
const BASE='http://127.0.0.1:8387/api/v1';
function cookieOf(r){const c=(r.sc??[])[0];return c?c.split(";")[0]:null;}
async function req(method,path,{body,rawCookie,csrfHeader}={}){
  const h={'Content-Type':'application/json'};
  if(csrfHeader)h['X-CSRF-Token']=csrfHeader; if(rawCookie)h['Cookie']=rawCookie;
  const res=await fetch(BASE+path,{method,headers:h,body:body!==undefined?JSON.stringify(body):undefined});
  const sc=res.headers.getSetCookie?.()??[];
  const text=await res.text();let json=null;try{json=text?JSON.parse(text):null}catch{json={_raw:text.slice(0,160)}}
  return {status:res.status,json,sc};
}
const U=()=>'r4a3'+Math.random().toString(36).slice(2,9);
let r=await req('POST','/auth/register',{body:{username:U(),password:'{{SECRET_s2wbnk4v}}'}});
const o={cookie:cookieOf(r),csrf:null};
r=await req('GET','/auth/me',{rawCookie:o.cookie});o.csrf=r.json?.csrf_token;
const mk={scope:'personal',name:'A3技能',summary:'走查',triggers:'触发',instructions:'按步骤执行走查清单，逐项确认。'+('细节说明。'.repeat(20)),platforms:['wechat_mp'],content_formats:['long_article'],task_types:['outline','title'],task_enabled:true,agent_enabled:true,status:'active'};
r=await req('POST','/skills',{body:mk,rawCookie:o.cookie,csrfHeader:o.csrf});
const SK=r.json?.skill?.id;
r=await req('GET',`/skills/${SK}`,{rawCookie:o.cookie,csrfHeader:o.csrf});
const rev=r.json?.base_revision??1;
// PUT 平铺（skillUpdateInput）：先取 impact_token（CS 防护设计：修改前必须看影响面），
// 再带 base_revision=当前值 提交。
r=await req('GET',`/skills/${SK}/impact?action=update`,{rawCookie:o.cookie,csrfHeader:o.csrf});
const impactToken=r.json?.impact_token;
r=await req('PUT',`/skills/${SK}`,{body:{name:mk.name,summary:'A3改一',triggers:mk.triggers,instructions:mk.instructions,platforms:mk.platforms,content_formats:mk.content_formats,task_types:mk.task_types,task_enabled:true,agent_enabled:true,status:'active',base_revision:rev,impact_token:impactToken},rawCookie:o.cookie,csrfHeader:o.csrf});
console.log('PUT1:',r.status,r.json?.error?.message?.slice(0,60)??'ok');
r=await req('GET',`/skills/${SK}`,{rawCookie:o.cookie,csrfHeader:o.csrf});
const revNow=r.json?.base_revision;
r=await req('PUT',`/skills/${SK}`,{body:{name:mk.name,summary:'A3改二',triggers:mk.triggers,instructions:mk.instructions,platforms:mk.platforms,content_formats:mk.content_formats,task_types:mk.task_types,task_enabled:true,agent_enabled:true,status:'active',base_revision:rev,impact_token:impactToken},rawCookie:o.cookie,csrfHeader:o.csrf});
console.log('PUT2-stale:',r.status,r.json?.error?.code??'',r.json?.error?.message?.slice(0,50)??'');
// impact 带 action
r=await req('GET',`/skills/${SK}/impact?action=update`,{rawCookie:o.cookie,csrfHeader:o.csrf});
console.log('IMPACT:',r.status,'leak:',JSON.stringify(r.json).includes('按步骤执行走查清单'));
// export 往返
r=await req('GET',`/skills/${SK}/export`,{rawCookie:o.cookie,csrfHeader:o.csrf});
const exported=r.json?.content??'';
r=await req('POST','/skills/parse',{body:{content:exported},rawCookie:o.cookie,csrfHeader:o.csrf});
const back=r.json?.fields??r.json;
console.log('EXPORT-ROUNDTRIP:',r.status,'name preserved:',back?.name===mk.name,'instructions preserved:',(back?.instructions??'').includes('按步骤执行走查清单'));
process.exit(0);
