const BASE='http://127.0.0.1:8387/api/v1';
async function raw(method,path,{body,cookie,csrf}={}){
  const h={'Content-Type':'application/json'};
  if(csrf)h['X-CSRF-Token']=csrf;
  if(cookie)h['Cookie']=cookie;
  const res=await fetch(BASE+path,{method,headers:h,body:body!==undefined?JSON.stringify(body):undefined});
  const t=await res.text();let j=null;try{j=t?JSON.parse(t):null}catch{j={_raw:t.slice(0,80)}}
  return {status:res.status,json:j,setC:res.headers.getSetCookie?.()??[]};
}
let r=await raw('POST','/auth/register',{body:{username:'r5b3'+Math.random().toString(36).slice(2,9),password:'{{SECRET_s2wbnk4v}}'}});
const cookie=r.setC.map(x=>x.split(';')[0]).join('; ');
console.log('register:',r.status,'cookieLen:',cookie.length);
const me=await (await fetch(BASE+'/auth/me',{headers:{Cookie:cookie}})).json();
console.log('me:',me.username,'ws:',me.workspace_id?.slice(0,8),'csrf:',!!me.csrf_token);
const acc=await raw('POST','/accounts',{body:{name:'B3号',platform:'wechat_mp',content_format:'long_article'},cookie,csrf:me.csrf_token}); const A=acc.json.id;
const tp=await raw('POST',`/accounts/${A}/topics`,{body:{title:'B3选题走查小标题',angle:'角度'},cookie,csrf:me.csrf_token}); const T=tp.json?.topic?.id??tp.json?.id;
console.log('topic-created:',tp.status,'T:',T?.slice(0,8),'acc:',A?.slice(0,8));
const pat=await raw('PATCH',`/topics/${T}`,{body:{status:'adopted'},cookie,csrf:me.csrf_token});
console.log('PATCH:',pat.status,JSON.stringify(pat.json).slice(0,80));
const sc=await raw('POST',`/topics/${T}/score`,{body:{mode:'two_stage'},cookie,csrf:me.csrf_token});
console.log('score:',sc.status,JSON.stringify(sc.json).slice(0,180));
const dg=await raw('POST',`/topics/${T}/diagnose`,{body:{basis_updated_at:pat.json.topic.updated_at},cookie,csrf:me.csrf_token});
console.log('diagnose:',dg.status,JSON.stringify(dg.json).slice(0,180));
process.exit(0);
