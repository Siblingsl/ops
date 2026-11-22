// R7-C：文案一致性实测（同一作品：create 64 边界 vs PATCH '标题过长' vs format 32）
const BASE='http://127.0.0.1:8387/api/v1';
async function req(method,path,{body,cookie,csrf}={}){
  const h={'Content-Type':'application/json'};
  if(csrf)h['X-CSRF-Token']=csrf;
  if(cookie)h['Cookie']=cookie;
  const res=await fetch(BASE+path,{method,headers:h,body:body!==undefined?JSON.stringify(body):undefined});
  const text=await res.text();let json=null;try{json=text?JSON.parse(text):null}catch{json={_raw:text.slice(0,80)}}
  return {status:res.status,json};
}
const reg=await fetch(BASE+'/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'r7c'+Math.random().toString(36).slice(2,9),password:'{{SECRET_s2wbnk4v}}'})});
const cookie=reg.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
const me=await (await fetch(BASE+'/auth/me',{headers:{Cookie:cookie}})).json();
const cs=me.csrf_token;
const acc=await req('POST','/accounts',{body:{name:'R7C文案号',platform:'wechat_mp',content_format:'long_article'},cookie,csrf:cs}); const A=acc.json?.id;
// 64 字创建 OK；65 字创建被拒（'作品标题最多64字'）
const t64='甲'.repeat(64);
const t65='乙'.repeat(65);
const c64=await req('POST',`/accounts/${A}/works`,{body:{title:t64,content_format:'long_article'},cookie,csrf:cs});
console.log('create 64字:',c64.status,c64.json?.error?.message??'ok');
const c65=await req('POST',`/accounts/${A}/works`,{body:{title:t65,content_format:'long_article'},cookie,csrf:cs});
console.log('create 65字:',c65.status,c65.json?.error?.message??'ok');
// PATCH 65 字 → '标题过长'（文案无数字）
if(c64.json?.id){
  const p65=await req('PATCH',`/works/${c64.json.id}`,{body:{title:t65,base_revision:c64.json.revision},cookie,csrf:cs});
  console.log('PATCH 65字:',p65.status,p65.json?.error?.message??'ok');
}
process.exit(0);
