// R7-B：时间窗口合理性（协议层可观测的时长语义）
const BASE='http://127.0.0.1:8387/api/v1';
async function req(method,path,{body,cookie,csrf}={}){
  const h={'Content-Type':'application/json'};
  if(csrf)h['X-CSRF-Token']=csrf;
  if(cookie)h['Cookie']=cookie;
  const res=await fetch(BASE+path,{method,headers:h,body:body!==undefined?JSON.stringify(body):undefined});
  const text=await res.text();let json=null;try{json=text?JSON.parse(text):null}catch{json={_raw:text.slice(0,80)}}
  return {status:res.status,json};
}
const reg=await fetch(BASE+'/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'r7b'+Math.random().toString(36).slice(2,9),password:'{{SECRET_s2wbnk4v}}'})});
const cookie=reg.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
const me=await (await fetch(BASE+'/auth/me',{headers:{Cookie:cookie}})).json();
const cs=me.csrf_token;
// T1 session 过期时间=注册+7天
const exp=Date.parse(me.session_expires_at);
const now=Date.now();
const days=(exp-now)/86400000;
console.log(`T1 session_expires_in: ${days.toFixed(2)} 天（预期≈7）=> ${days>6.9&&days<7.1?'OK':'CHECK'}`);
// T2 preview-link 有效期（24h 预期）
const acc=await req('POST','/accounts',{body:{name:'T2号',platform:'wechat_mp',content_format:'long_article'},cookie,csrf:cs}); const A=acc.json?.id;
const wr=await req('POST',`/accounts/${A}/works`,{body:{title:'T2预览作品（六字以上）',content_format:'long_article'},cookie,csrf:cs}); const W=wr.json?.id;
await req('PATCH',`/works/${W}`,{body:{content_md:'# T2\n\n第一节预览。\n\n## 第二节\n\n第二节。'},cookie,csrf:cs});
await req('PUT',`/works/${W}/outline`,{body:{items:[{heading:'一',summary:'s1'}],confirm:true},cookie,csrf:cs});
const pl=await req('POST',`/works/${W}/preview-link`,{body:{},cookie,csrf:cs});
const pv=pl.json?.token_url??pl.json?.url??pl.json;
const expAt=pl.json?.expires_at??pl.json?.expired_at;
console.log(`T2 preview-link: status=${pl.status} expires_at=${expAt??'(需查字段)'}`);
if(expAt){const h=(Date.parse(expAt)-now)/3600000;console.log(`   有效 ${h.toFixed(2)} 小时（预期≈24）=> ${h>23.9&&h<24.1?'OK':'CHECK'}`);}
// T3 回收站剩余天数语义（删除后列表返回）
await req('DELETE',`/works/${W}`,{cookie,csrf:cs});
const tr=await req('GET','/trash/work',{cookie,csrf:cs}).catch(()=>req('GET','/trash',{cookie,csrf:cs}));
console.log(`T3 trash-list: ${tr.status}`);
// T4 推送记录窗口（today 边界）——push_record 今日计数（R6 已验证 3 次后触发）
console.log('T4 push window: 由 R6A2 已验（第 3 次后 409，跨日重置逻辑属调度器内部）');
process.exit(0);
