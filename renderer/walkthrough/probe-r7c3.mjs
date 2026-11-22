// 空标题行为
const BASE='http://127.0.0.1:8387/api/v1';
async function req(method,path,{body,cookie,csrf}={}){
  const h={'Content-Type':'application/json'};
  if(csrf)h['X-CSRF-Token']=csrf;
  if(cookie)h['Cookie']=cookie;
  const res=await fetch(BASE+path,{method,headers:h,body:body!==undefined?JSON.stringify(body):undefined});
  const text=await res.text();let json=null;try{json=text?JSON.parse(text):null}catch{json={_raw:text.slice(0,80)}}
  return {status:res.status,json};
}
const reg=await fetch(BASE+'/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'r7c3'+Math.random().toString(36).slice(2,9),password:'{{SECRET_s2wbnk4v}}'})});
const cookie=reg.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
const me=await (await fetch(BASE+'/auth/me',{headers:{Cookie:cookie}})).json();
const cs=me.csrf_token;
const acc=await req('POST','/accounts',{body:{name:'空标题号',platform:'wechat_mp',content_format:'long_article'},cookie,csrf:cs}); const A=acc.json?.id;
const r1=await req('POST',`/accounts/${A}/works`,{body:{content_format:'long_article'},cookie,csrf:cs});
console.log('no-title:',r1.status,'title=',JSON.stringify(r1.json?.title));
const r2=await req('POST',`/accounts/${A}/works`,{body:{title:'   ',content_format:'long_article'},cookie,csrf:cs});
console.log('blank-title:',r2.status,'title=',JSON.stringify(r2.json?.title));
// 检查层面对空标题的反应
const W=r1.json?.id;
await req('PATCH',`/works/${W}`,{body:{viewpoint:'空标题检查',content_md:'# 空标题\n\n第一节事实。\n\n## 第二节\n\n第二节。'},cookie,csrf:cs});
await req('PUT',`/works/${W}/outline`,{body:{items:[{heading:'一',summary:'s1'}],confirm:true},cookie,csrf:cs});
const w=await (await fetch(BASE+`/works/${W}`,{headers:{Cookie:cookie}})).json();
for(const s of (w.sections??[])) await req('PATCH',`/sections/${s.id}`,{body:{content_md:'记录可核对的事实与验证方式，保持谨慎。',base_revision:s.revision},cookie,csrf:cs});
await req('POST',`/works/${W}/checks`,{body:{},cookie,csrf:cs});
let run=null;
for(let i=0;i<20;i++){ await new Promise(r=>setTimeout(r,1000)); const c=await req('GET',`/works/${W}/checks/latest`,{cookie,csrf:cs}); run=c.json?.run; if(run&&run.fact_status!=='pending')break; }
const tf=(run?.items??[]).find(i=>i.field==='title');
console.log('check title item: passed=',tf?.passed,'msg=',tf?.message?.slice(0,30));
process.exit(0);
