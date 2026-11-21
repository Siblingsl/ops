// g7 case-1 协议级复刻：同一消息文本 → run → actions 是否产出
const BASE='http://127.0.0.1:8387/api/v1';
function cookieOf(r){const c=(r.sc??[])[0];return c?c.split(";")[0]:null;}
async function req(method,path,{body,rawCookie,csrfHeader}={}){
  const h={'Content-Type':'application/json'};
  if(csrfHeader)h['X-CSRF-Token']=csrfHeader; if(rawCookie)h['Cookie']=rawCookie;
  const res=await fetch(BASE+path,{method,headers:h,body:body!==undefined?JSON.stringify(body):undefined});
  const sc=res.headers.getSetCookie?.()??[];
  const text=await res.text();let json=null;try{json=text?JSON.parse(text):null}catch{json={}}
  return {status:res.status,json,sc};
}
let r=await req('POST','/auth/register',{body:{username:'g7c1'+Math.random().toString(36).slice(2,9),password:'{{SECRET_s2wbnk4v}}'}});
const o={cookie:cookieOf(r),csrf:null};
r=await req('GET','/auth/me',{rawCookie:o.cookie});o.csrf=r.json?.csrf_token;
r=await req('POST','/accounts',{body:{name:'浏览器验收号',platform:'wechat_mp',content_format:'long_article'},rawCookie:o.cookie,csrfHeader:o.csrf});
const A=r.json?.id;
r=await req('GET','/model-providers',{rawCookie:o.cookie,csrfHeader:o.csrf});
const mp=(Array.isArray(r.json)?r.json:r.json?.items??[])[0];
await req('POST',`/model-providers/${mp.id}/selftest`,{body:{},rawCookie:o.cookie,csrfHeader:o.csrf});
await req('PUT','/model-routes',{body:[{task_type:'agent_chat',provider_id:mp.id,model:'mock-agent-tested',fallback_provider_id:null,fallback_model:''}],rawCookie:o.cookie,csrfHeader:o.csrf});
const content=`原生 Electron 逐张执行 ${Date.now()}`;
const text=`请添加素材：${content}\n#tool load_tool_domain {"domain":"materials"}\n#tool materials__create ${JSON.stringify({ account_id: A, kind: 'opinion', content })}`;
r=await req('POST','/agent/conversations',{body:{title:'g7c1'},rawCookie:o.cookie,csrfHeader:o.csrf});
const C=r.json?.id;
r=await req('POST',`/agent/conversations/${C}/messages`,{body:{text},rawCookie:o.cookie,csrfHeader:o.csrf});
const run=r.json?.run?.id;
console.log('msg:',r.status,'run:',run,r.json?.error?.message?.slice(0,60));
for(let i=0;i<30;i++){
  await new Promise(res=>setTimeout(res,1000));
  const c=await req('GET',`/agent/conversations/${C}`,{rawCookie:o.cookie,csrfHeader:o.csrf});
  const ar=c.json?.active_run;
  if(ar==null){
    console.log('actions:',JSON.stringify((c.json?.actions??[]).map(a=>({id:a.id?.slice(0,8),status:a.status,kind:a.kind}))));
    console.log('tool_calls:',JSON.stringify((c.json?.messages??[]).at(-1)?.tool_calls?.map(t=>t.name)?.slice(0,6)??[]));
    break;
  }
}
process.exit(0);
