const BASE='http://127.0.0.1:8387/api/v1';
function cookieOf(r){const c=(r.sc??[])[0];return c?c.split(";")[0]:null;}
async function req(method,path,{rawCookie}={}){
  const res=await fetch(BASE+path,{headers:{Cookie:rawCookie,Accept:'text/event-stream'}});
  return {status:res.status};
}
let r=await req('POST','/auth/register',{}).catch(()=>null);
const reg=await fetch(BASE+'/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'r4b2'+Math.random().toString(36).slice(2,9),password:'{{SECRET_s2wbnk4v}}'})});
const oc=(reg.headers.getSetCookie?.()??[]).find(x=>/session/i.test(x))??(reg.headers.getSetCookie?.()??[])[0]; const o={cookie:oc.split(';')[0]};
const meR=await fetch(BASE+'/auth/me',{headers:{Cookie:o.cookie}}); const meJ=await meR.json(); const CSRF=meJ.csrf_token;
// 建会话
const cr=await fetch(BASE+'/agent/conversations',{method:'POST',headers:{'Content-Type':'application/json','Cookie':o.cookie,'X-CSRF-Token':CSRF},body:JSON.stringify({title:'游标测试'})});
const cj=await cr.json(); const C=cj.id; console.log('conv-create:',cr.status,C?String(C).slice(0,8):JSON.stringify(cj).slice(0,80));
// 非法游标（参数名正确）
console.log('after_event_seq=-5:',(await req('GET',`/agent/conversations/${C}/events?after_event_seq=-5`,o.cookie)).status);
console.log('after_event_seq=999999999:',(await req('GET',`/agent/conversations/${C}/events?after_event_seq=999999999`,o.cookie)).status);
console.log('after_event_seq=0 fresh conv:',(await req('GET',`/agent/conversations/${C}/events?after_event_seq=0`,o.cookie)).status);
// 他人会话
const reg2=await fetch(BASE+'/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'r4b2x'+Math.random().toString(36).slice(2,9),password:'{{SECRET_s2wbnk4v}}'})});
const oc2=(reg2.headers.getSetCookie?.()??[]).find(x=>/session/i.test(x))??(reg2.headers.getSetCookie?.()??[])[0]; const o2={cookie:oc2.split(';')[0]};
const meR2=await fetch(BASE+'/auth/me',{headers:{Cookie:o2.cookie}}); await meR2.json();
console.log('other-user events:',(await req('GET',`/agent/conversations/${C}/events`,o2.cookie)).status);
process.exit(0);
