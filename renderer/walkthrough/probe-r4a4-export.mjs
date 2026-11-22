// R4-A4：export 往返精查（dump 导出内容与 parse 错误）
const BASE='http://127.0.0.1:8387/api/v1';
function cookieOf(r){const c=(r.sc??[])[0];return c?c.split(";")[0]:null;}
async function req(method,path,{body,rawCookie,csrfHeader}={}){
  const h={'Content-Type':'application/json'};
  if(csrfHeader)h['X-CSRF-Token']=csrfHeader; if(rawCookie)h['Cookie']=rawCookie;
  const res=await fetch(BASE+path,{method,headers:h,body:body!==undefined?JSON.stringify(body):undefined});
  const sc=res.headers.getSetCookie?.()??[];
  const text=await res.text();let json=null;try{json=text?JSON.parse(text):null}catch{json={_raw:text.slice(0,200)}}
  return {status:res.status,json,sc,text};
}
let r=await req('POST','/auth/register',{body:{username:'r4a4'+Math.random().toString(36).slice(2,9),password:'{{SECRET_s2wbnk4v}}'}});
const o={cookie:cookieOf(r),csrf:null};
r=await req('GET','/auth/me',{rawCookie:o.cookie});o.csrf=r.json?.csrf_token;
const mk={scope:'personal',name:'导出往返技能',summary:'走查',triggers:'触发词',instructions:'按步骤执行走查清单，逐项确认。'+('细节说明。'.repeat(10)),platforms:['wechat_mp'],content_formats:['long_article'],task_types:['outline'],task_enabled:true,agent_enabled:true,status:'active'};
r=await req('POST','/skills',{body:mk,rawCookie:o.cookie,csrfHeader:o.csrf});
const SK=r.json?.skill?.id;
r=await req('GET',`/skills/${SK}/export`,{rawCookie:o.cookie,csrfHeader:o.csrf});
console.log('EXPORT status:',r.status,'keys:',Object.keys(r.json??{}));
console.log('EXPORT content head:',String(r.json?.content??r.text).slice(0,300));
const content=r.text;
if(content){
  r=await req('POST','/skills/parse',{body:{content},rawCookie:o.cookie,csrfHeader:o.csrf});
  console.log('PARSE status:',r.status,'err:',r.json?.error?.message?.slice(0,120)??'');
  console.log('PARSE name ok:', r.json?.fields?.name===mk.name ?? r.json?.name, '| instructions ok:', String(r.json?.fields?.instructions??r.json?.instructions??'').includes('按步骤执行走查清单'));
}
process.exit(0);
