// T3 补：GET /trash 正确路径 + 剩余天数
const BASE='http://127.0.0.1:8387/api/v1';
async function req(method,path,{body,cookie,csrf}={}){
  const h={'Content-Type':'application/json'};
  if(csrf)h['X-CSRF-Token']=csrf;
  if(cookie)h['Cookie']=cookie;
  const res=await fetch(BASE+path,{method,headers:h,body:body!==undefined?JSON.stringify(body):undefined});
  const text=await res.text();let json=null;try{json=text?JSON.parse(text):null}catch{json={_raw:text.slice(0,100)}}
  return {status:res.status,json};
}
const reg=await fetch(BASE+'/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'r7b2'+Math.random().toString(36).slice(2,9),password:'{{SECRET_s2wbnk4v}}'})});
const cookie=reg.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
const me=await (await fetch(BASE+'/auth/me',{headers:{Cookie:cookie}})).json();
const cs=me.csrf_token;
const acc=await req('POST','/accounts',{body:{name:'T3回收号',platform:'wechat_mp',content_format:'long_article'},cookie,csrf:cs}); const A=acc.json?.id;
const wr=await req('POST',`/accounts/${A}/works`,{body:{title:'T3回收作品（六字以上）',content_format:'long_article'},cookie,csrf:cs}); const W=wr.json?.id;
await req('DELETE',`/works/${W}`,{cookie,csrf:cs});
const tr=await req('GET','/trash?type=work',{cookie,csrf:cs});
const items=tr.json?.items??tr.json??[];
const first=Array.isArray(items)?items[0]:null;
console.log('trash-list:',tr.status,'n=',Array.isArray(items)?items.length:'?');
if(first){
  console.log('first item keys:',Object.keys(first).slice(0,10));
  // 剩余天数：deleted_at + 30 天
  if(first.deleted_at){const d=(Date.parse(first.deleted_at)+30*86400000-Date.now())/86400000;console.log(`剩余 ${d.toFixed(2)} 天（预期≈30）`);}
}
process.exit(0);
