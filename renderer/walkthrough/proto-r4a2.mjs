// R4-A2：personal 技能 PUT/impact 精测（打印完整错误）
const BASE='http://127.0.0.1:8387/api/v1';
function cookieOf(r){const c=(r.sc??[])[0];return c?c.split(";")[0]:null;}
async function req(method,path,{body,rawCookie,csrfHeader}={}){
  const h={'Content-Type':'application/json'};
  if(csrfHeader)h['X-CSRF-Token']=csrfHeader; if(rawCookie)h['Cookie']=rawCookie;
  const res=await fetch(BASE+path,{method,headers:h,body:body!==undefined?JSON.stringify(body):undefined});
  const sc=res.headers.getSetCookie?.()??[];
  const text=await res.text();let json=null;try{json=text?JSON.parse(text):null}catch{json={_raw:text.slice(0,200)}}
  return {status:res.status,json,sc};
}
const U=()=>'r4a2'+Math.random().toString(36).slice(2,9);
let r=await req('POST','/auth/register',{body:{username:U(),password:'{{SECRET_s2wbnk4v}}'}});
const o={cookie:cookieOf(r),csrf:null};
r=await req('GET','/auth/me',{rawCookie:o.cookie});o.csrf=r.json?.csrf_token;
const mkBody={scope:'personal',name:'A2技能',summary:'走查',triggers:'触发',instructions:'按步骤执行走查清单，逐项确认。'+('细节说明。'.repeat(20)),platforms:['wechat_mp'],content_formats:['long_article'],task_types:['outline','title'],task_enabled:true,agent_enabled:true,status:'active'};
r=await req('POST','/skills',{body:mkBody,rawCookie:o.cookie,csrfHeader:o.csrf});
const SK=r.json?.skill?.id;
console.log('created:',r.status,SK?.slice(0,8));
r=await req('GET',`/skills/${SK}`,{rawCookie:o.cookie,csrfHeader:o.csrf});
console.log('GET:',r.status,JSON.stringify(r.json).slice(0,220));
const rev=r.json?.skill?.base_revision??r.json?.base_revision;
console.log('rev=',rev);
r=await req('PUT',`/skills/${SK}`,{body:{base_revision:rev,fields:{...mkBody,summary:'改一'}},rawCookie:o.cookie,csrfHeader:o.csrf});
console.log('PUT1:',r.status,JSON.stringify(r.json?.error??{}).slice(0,180));
r=await req('GET',`/skills/${SK}`,{rawCookie:o.cookie,csrfHeader:o.csrf});
const rev2=r.json?.skill?.base_revision??r.json?.base_revision;
r=await req('PUT',`/skills/${SK}`,{body:{base_revision:rev,fields:{...mkBody,summary:'改二'}},rawCookie:o.cookie,csrfHeader:o.csrf});
console.log('PUT2-stale:',r.status,r.json?.error?.code??'');
r=await req('GET',`/skills/${SK}/impact`,{rawCookie:o.cookie,csrfHeader:o.csrf});
console.log('IMPACT:',r.status,JSON.stringify(r.json?.error??{}).slice(0,120), 'leak:',JSON.stringify(r.json).includes('按步骤执行走查清单'));
process.exit(0);
