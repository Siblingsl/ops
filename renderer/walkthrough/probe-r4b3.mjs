const BASE='http://127.0.0.1:8387/api/v1';
const reg=await fetch(BASE+'/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'r4b3'+Math.random().toString(36).slice(2,9),password:'{{SECRET_s2wbnk4v}}'})});
const setCookies=reg.headers.getSetCookie();
const cookie=setCookies.map(s=>s.split(';')[0]).join('; ');
const me=await (await fetch(BASE+'/auth/me',{headers:{Cookie:cookie}})).json();
const csrf=me.csrf_token;
const cr=await fetch(BASE+'/agent/conversations',{method:'POST',headers:{'Content-Type':'application/json','Cookie':cookie,'X-CSRF-Token':csrf},body:JSON.stringify({title:'b3'})});
const C=(await cr.json()).id;
for(const [name,url] of [['neg','?after_event_seq=-5'],['huge','?after_event_seq=999999999'],['zero','?after_event_seq=0'],['plain','']]){
  const r=await fetch(BASE+`/agent/conversations/${C}/events`+url,{headers:{Cookie:cookie}});
  console.log(`${name}: ${r.status}`);
}
process.exit(0);
